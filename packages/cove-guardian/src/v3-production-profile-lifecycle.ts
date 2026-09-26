import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { resolve } from "node:path";
import { ECPairFactory, type ECPairInterface } from "ecpair";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { CoveChainView, TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_REGTEST, COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import { loadMainnetProfile, hashMainnetProfile } from "@crclaunch/cove-mainnet";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import {
  LocalGuardianTransitionSigner,
  RemoteGuardianTransitionSigner,
  custodySigningBackend,
  TestGuardianCustodyBackend,
  InMemorySigningJournal,
  InProcessGuardianTransport,
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  broadcastValidatedCoveTransaction,
  RESERVE_ANCHOR_SATS,
  type DurableAuditSink,
  type AuditRecord,
  type GuardianRiskPolicy,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "./v3/index.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

/**
 * Production-profile-regtest lifecycle (Phase 8.1 §37-§39). Runs the FULL
 * DEPLOY→MINT→TRANSFER→REDEEM→RE-BUY→P2P journey on REAL Bitcoin Core regtest
 * under MAINNET1 semantics, with backing transitions (MINT/REDEEM/RE-BUY)
 * travelling app → RemoteGuardianTransitionSigner → in-process Guardian
 * transport → durable audit → signing journal → custody backend → signature →
 * independent client verification → app. P2P/TRANSFER are Guardian-independent.
 * No local in-process Guardian signer from the app; the app only sees the remote
 * client. No mainnet broadcast (Bitcoin network is regtest).
 */

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
// TEST-ONLY profile (its keys are the repo's public test keys).
const PROFILE_PATH = resolve(process.env.INIT_CWD ?? process.cwd(), process.env.COVE_TEST_ONLY_PROFILE_PATH ?? "test/fixtures/mainnet-profile.json");

const MINER_FEE = 1_000n;
const NONCE = Buffer.alloc(32, 0xab);
const MINT_AMOUNT = 1_000_000n * 100_000_000n;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

class RegtestRpc {
  private id = 0;
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers.authorization = `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64")}`;
    const res = await fetch(RPC_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: `${++this.id}`, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: { result?: T; error?: { message?: string } | null } = {};
    try { json = JSON.parse(text) as typeof json; } catch { /* ignore */ }
    if (!res.ok || json.error) throw new Error(`RPC ${method}: ${json.error?.message ?? text.slice(0, 200)}`);
    return json.result as T;
  }
  async createWallet(name: string): Promise<void> {
    try { await this.call("createwallet", [name, false, false, "", false, true, false]); }
    catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
    try { await this.call("loadwallet", [name]); }
    catch (e) { if (!/already loaded/i.test((e as Error).message)) throw e; }
  }
  getNewAddress(): Promise<string> { return this.call("getnewaddress"); }
  sendToAddress(addr: string, btc: number): Promise<string> { return this.call("sendtoaddress", [addr, btc]); }
  generateToAddress(n: number, addr: string): Promise<string[]> { return this.call("generatetoaddress", [n, addr]); }
  getBlockchainInfo(): Promise<{ chain: string; blocks: number }> { return this.call("getblockchaininfo"); }
}

function p2wpkhScript(key: ECPairInterface): Buffer {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!;
}
function p2wpkhAddress(key: ECPairInterface): string {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).address!;
}

interface Funded { txid: string; vout: number; script: Buffer; valueSats: bigint; }
function findOutputIndex(tx: bitcoin.Transaction, script: Buffer): number {
  return tx.outs.findIndex((o) => o.script.equals(script));
}
async function fundKey(rpc: RegtestRpc, provider: CoreRpcProvider, key: ECPairInterface, btc: number, mineAddr: string): Promise<Funded> {
  const addr = p2wpkhAddress(key);
  const txid = await rpc.sendToAddress(addr, btc);
  await rpc.generateToAddress(1, mineAddr);
  const raw = await provider.getRawTransaction(txid);
  const tx = bitcoin.Transaction.fromHex(raw);
  const script = p2wpkhScript(key);
  const vout = findOutputIndex(tx, script);
  assert(vout >= 0, "funding output not found");
  return { txid, vout, script, valueSats: BigInt(tx.outs[vout]!.value) };
}

function orThrow(r: ValidatedCoveTransaction | { ok: false; reason: string }, label: string): ValidatedCoveTransaction {
  if ("ok" in r) throw new Error(`finalized ${label} revalidation failed: ${r.reason}`);
  return r;
}

const memoryAudit: DurableAuditSink = {
  async writeBeforeSign(_r: AuditRecord) { return { auditHash: "0".repeat(64) }; },
  async writeAfterSign() {},
};

async function main(): Promise<void> {
  const rpc = new RegtestRpc();
  const info = await rpc.getBlockchainInfo();
  assert(info.chain === "regtest", `expected regtest, got ${info.chain}`);
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });

  await rpc.createWallet("cove-recovery"); // reuse the recovery-matrix wallet (single loaded wallet)
  const mineAddr = await rpc.getNewAddress();
  await rpc.generateToAddress(101, mineAddr);

  // Load the fixture profile (PUBLIC values only).
  const { profile, validation } = loadMainnetProfile(PROFILE_PATH, { allowTestKeys: true });
  assert(validation.ok, `fixture profile invalid: ${validation.errors.join("; ")}`);
  const profileHash = hashMainnetProfile(profile);
  assert(profile.guardianXOnly != null && profile.feeScript != null, "profile incomplete");
  const guardianXOnly = Buffer.from(profile.guardianXOnly, "hex");
  const feeScript = Buffer.from(profile.feeScript, "hex");
  const recoveryProfile: VaultRecoveryProfile = {
    profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
    recoveryCsvBlocks: profile.recovery.csvBlocks!,
    recoveryThreshold: profile.recovery.threshold,
    recoveryPubkeys: profile.recovery.pubkeys.map((k) => Buffer.from(k, "hex")),
  };
  const recoveryKeyXOnly = recoveryProfile.recoveryPubkeys[0]!;

  // The "service" side: custody backend + durable audit/journal + risk policy.
  const custody = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42));
  const riskPolicy: GuardianRiskPolicy = {
    maxGrossSats: 1_000_000n,
    maxMintAtoms: 1_000_000_000n * 100_000_000n,
    minMintGrossSats: 0n,
    maxRedeemPayoutSats: 1_000_000n,
    maxBackingSats: 100_000_000_000_000n,
    maxMinerFeeSats: 20_000n,
    allowedTokenIds: profile.canary.allowedTokenIds,
    enforceTokenAllowlist: true,
  };
  const service = new LocalGuardianTransitionSigner(
    custodySigningBackend(custody),
    new InMemorySigningJournal(),
    memoryAudit,
    riskPolicy,
  );
  const view = new CoveChainView();
  // Funding inputs must be confirmed and hold no Cove tokens, checked against the real node.
  const fundingChecker = chainFundingChecker({ chain: provider, isCoveCarrier: async (o) => view.getTokenUtxo(o) !== null });
  const transport = new InProcessGuardianTransport({ fundingChecker,
    signer: service,
    profileHash,
    guardianXOnly: profile.guardianXOnly,
    network: "regtest",
    decode: (psbtBase64) => ({ psbt: bitcoin.Psbt.fromBase64(psbtBase64) }),
    loadView: async () => view,
    recoveryKeyXOnly,
    recoveryProfile,
    feeScript,
    maxMinerFeeSats: MINER_FEE,
  });
  // The APP side only ever sees the REMOTE client (no in-process Guardian key).
  const remoteSigner = new RemoteGuardianTransitionSigner(transport, profileHash, profile.guardianXOnly);

  const deployer = ECPair.fromPrivateKey(Buffer.alloc(32, 0x45), { network: bitcoin.networks.regtest });
  const alice = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46), { network: bitcoin.networks.regtest });
  const bob = ECPair.fromPrivateKey(Buffer.alloc(32, 0x47), { network: bitcoin.networks.regtest });
  const carol = ECPair.fromPrivateKey(Buffer.alloc(32, 0x48), { network: bitcoin.networks.regtest });
  const p2pBuyer = ECPair.fromPrivateKey(Buffer.alloc(32, 0x49), { network: bitcoin.networks.regtest });

  const broadcast = async (v: ValidatedCoveTransaction): Promise<string> =>
    (await broadcastValidatedCoveTransaction({ validated: v, network: "regtest", provider })).txid;

  // ── DEPLOY ──
  console.log("STEP 1/6 — DEPLOY (MAINNET1 vault)");
  const deployerUtxo = await fundKey(rpc, provider, deployer, 1.0, mineAddr);
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE },
    guardianXOnly, recoveryKeyXOnly, recoveryProfile,
    deployerInputs: [deployerUtxo], deployerChangeScript: deployerUtxo.script, minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  deploy.psbt.signInput(0, deployer);
  deploy.psbt.finalizeAllInputs();
  const deployHex = deploy.psbt.extractTransaction().toHex();
  const deployVal = orThrow(validateFinalizedDeployTransaction({ feeScript, rawTxHex: deployHex, network: "regtest", chainIdentity: CHAIN_BITCOIN_REGTEST, guardianXOnly, recoveryKeyXOnly, recoveryProfile }), "DEPLOY");
  const deployTxid = await broadcast(deployVal);
  await rpc.generateToAddress(1, mineAddr);
  const tokenId = deploy.tokenId;
  const tokenIdHex = tokenId.toString("hex");
  view.deploy({ tokenId, ticker: "FROG", policyVersion: COVE_POLICY_V3, deployTxid, tokenNonce: NONCE , creatorScript: CREATOR_SCRIPT}, { txid: deployTxid, vout: 1 }, deploy.s0);
  console.log(`✓ DEPLOY ${deployTxid} (token ${tokenIdHex})`);

  // ── MINT via remote Guardian ──
  console.log("STEP 2/6 — MINT (remote Guardian, 10k)");
  const aliceUtxo = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mint1 = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: deploy.s0,
    prevBacking: { txid: deployTxid, vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly, recoveryProfile,
    buyerInputs: [aliceUtxo], buyerCarrierScript: p2wpkhScript(alice), buyerChangeScript: p2wpkhScript(alice), feeScript, minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const mintSign = await remoteSigner.signMint({ fundingChecker, psbt: mint1.psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile, feeScript, maxMinerFeeSats: MINER_FEE });
  if (!mintSign.ok) throw new Error(`remote Guardian refused MINT: ${mintSign.reason}: ${(mintSign as { detail?: string }).detail}`);
  mint1.psbt.signInput(1, alice);
  mint1.psbt.finalizeInput(1);
  const mint1Hex = mint1.psbt.extractTransaction().toHex();
  const mint1Val = orThrow(await validateFinalizedMintTransaction({ rawTxHex: mint1Hex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly, recoveryProfile, feeScript }), "MINT");
  const mint1Txid = await broadcast(mint1Val);
  await rpc.generateToAddress(1, mineAddr);
  assert(mint1.grossSats === 148_500n, `mint gross ${mint1.grossSats}`);
  view.mint({ tokenId, nextState: mint1.nextState, prevBackingOutpoint: { txid: deployTxid, vout: 1 }, nextBackingOutpoint: { txid: mint1Txid, vout: 1 }, recipientOutpoint: { txid: mint1Txid, vout: 2 }, recipientScript: p2wpkhScript(alice), amountAtoms: MINT_AMOUNT });
  console.log(`✓ MINT ${mint1Txid} (remote Guardian signed)`);

  // ── TRANSFER Alice→Bob ──
  console.log("STEP 3/6 — TRANSFER (Alice → Bob, 10k)");
  const aliceFund = await fundKey(rpc, provider, alice, 0.01, mineAddr);
  const transfer = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: mint1Txid, vout: 2, script: p2wpkhScript(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkhScript(bob), amountAtoms: MINT_AMOUNT }],
    funderInputs: [aliceFund], funderChangeScript: p2wpkhScript(alice), btcOutputs: [], minerFeeSats: MINER_FEE,
  });
  transfer.psbt.signInput(0, alice);
  transfer.psbt.signInput(1, alice);
  transfer.psbt.finalizeAllInputs();
  const transferHex = transfer.psbt.extractTransaction().toHex();
  const transferVal = orThrow(validateFinalizedTransferTransaction({ rawTxHex: transferHex, view }), "TRANSFER");
  const transferTxid = await broadcast(transferVal);
  await rpc.generateToAddress(1, mineAddr);
  view.transfer({ tokenId, spentOutpoints: [{ txid: mint1Txid, vout: 2 }], created: [{ outpoint: { txid: transferTxid, vout: 1 }, script: p2wpkhScript(bob), amountAtoms: MINT_AMOUNT }] });
  console.log(`✓ TRANSFER ${transferTxid}`);

  // ── REDEEM via remote Guardian ──
  console.log("STEP 4/6 — REDEEM (remote Guardian, full 10k)");
  const redeem = buildRedeemPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: mint1.nextState,
    prevBacking: { txid: mint1Txid, vout: 1, script: mint1.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + mint1.nextState.backingSats },
    redeemAmountAtoms: MINT_AMOUNT,
    tokenInputs: [{ txid: transferTxid, vout: 1, script: p2wpkhScript(bob), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly, recoveryProfile,
    sellerPayoutScript: p2wpkhScript(bob), sellerChangeScript: p2wpkhScript(bob), feeScript, minerFeeSats: MINER_FEE,
  });
  const redeemSign = await remoteSigner.signRedeem({ fundingChecker, psbt: redeem.psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile, feeScript, maxMinerFeeSats: MINER_FEE });
  if (!redeemSign.ok) throw new Error(`remote Guardian refused REDEEM: ${redeemSign.reason}`);
  redeem.psbt.signInput(1, bob);
  redeem.psbt.finalizeInput(1);
  const redeemHex = redeem.psbt.extractTransaction().toHex();
  const redeemVal = orThrow(await validateFinalizedRedeemTransaction({ rawTxHex: redeemHex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly, recoveryProfile, feeScript }), "REDEEM");
  const redeemTxid = await broadcast(redeemVal);
  await rpc.generateToAddress(1, mineAddr);
  assert(redeem.grossSats === 148_500n, `redeem gross ${redeem.grossSats}`);
  view.redeem({ tokenId, nextState: redeem.nextState, prevBackingOutpoint: { txid: mint1Txid, vout: 1 }, nextBackingOutpoint: { txid: redeemTxid, vout: 1 }, spentTokenOutpoints: [{ txid: transferTxid, vout: 1 }], change: [] });
  console.log(`✓ REDEEM ${redeemTxid} (remote Guardian signed)`);

  // ── RE-BUY via remote Guardian ──
  console.log("STEP 5/6 — RE-BUY (remote Guardian, 10k)");
  const aliceRebuy = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mint2 = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: redeem.nextState,
    prevBacking: { txid: redeemTxid, vout: 1, script: redeem.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + redeem.nextState.backingSats },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly, recoveryProfile,
    buyerInputs: [aliceRebuy], buyerCarrierScript: p2wpkhScript(alice), buyerChangeScript: p2wpkhScript(alice), feeScript, minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const rebuySign = await remoteSigner.signMint({ fundingChecker, psbt: mint2.psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile, feeScript, maxMinerFeeSats: MINER_FEE });
  if (!rebuySign.ok) throw new Error(`remote Guardian refused RE-BUY: ${rebuySign.reason}`);
  mint2.psbt.signInput(1, alice);
  mint2.psbt.finalizeInput(1);
  const mint2Hex = mint2.psbt.extractTransaction().toHex();
  const mint2Val = orThrow(await validateFinalizedMintTransaction({ rawTxHex: mint2Hex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly, recoveryProfile, feeScript }), "RE-BUY");
  const mint2Txid = await broadcast(mint2Val);
  await rpc.generateToAddress(1, mineAddr);
  view.mint({ tokenId, nextState: mint2.nextState, prevBackingOutpoint: { txid: redeemTxid, vout: 1 }, nextBackingOutpoint: { txid: mint2Txid, vout: 1 }, recipientOutpoint: { txid: mint2Txid, vout: 2 }, recipientScript: p2wpkhScript(alice), amountAtoms: MINT_AMOUNT });
  console.log(`✓ RE-BUY ${mint2Txid} (remote Guardian signed)`);

  // ── P2P atomic fill (Guardian-independent) ──
  console.log("STEP 6/6 — P2P (Alice sells 5k to Carol)");
  const half = MINT_AMOUNT / 2n;
  const p2pPrice = 100_000n;
  const p2p = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: mint2Txid, vout: 2, script: p2wpkhScript(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkhScript(carol), amountAtoms: half }, { script: p2wpkhScript(alice), amountAtoms: half }],
    funderInputs: [await fundKey(rpc, provider, p2pBuyer, 0.2, mineAddr)],
    funderChangeScript: p2wpkhScript(p2pBuyer),
    btcOutputs: [{ script: p2wpkhScript(alice), valueSats: p2pPrice }],
    minerFeeSats: MINER_FEE,
  });
  p2p.psbt.signInput(0, alice);
  p2p.psbt.signInput(1, p2pBuyer);
  p2p.psbt.finalizeAllInputs();
  const p2pHex = p2p.psbt.extractTransaction().toHex();
  const p2pVal = orThrow(validateFinalizedTransferTransaction({ rawTxHex: p2pHex, view }), "P2P");
  const p2pTxid = await broadcast(p2pVal);
  await rpc.generateToAddress(1, mineAddr);
  console.log(`✓ P2P ${p2pTxid}`);

  console.log("✓ PRODUCTION-PROFILE-REGTEST LIFECYCLE PASSED — all backing transitions travelled through the remote Guardian client");
}

main().catch((e) => {
  console.error("v3-production-profile-lifecycle failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
