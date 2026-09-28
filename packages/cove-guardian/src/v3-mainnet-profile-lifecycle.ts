import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory, type ECPairInterface } from "ecpair";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { CoveChainView, TOKEN_CARRIER_SATS, type OutPoint } from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_REGTEST, COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import {
  GuardianV3Signer,
  LocalGuardianTransitionSigner,
  localSigningBackend,
  InMemorySigningJournal,
  computeGuardianAuditHash,
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  broadcastValidatedCoveTransaction,
  RESERVE_ANCHOR_SATS,
  type DurableAuditSink,
  type AuditRecord,
  type GuardianAuditDigestFields,
  type GuardianRiskPolicy,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "./v3/index.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

/**
 * Phase 8 production-profile lifecycle (§137/§145) — the SAME full
 * DEPLOY→MINT→REDEEM→RE-BUY journey as the DEV1 `v3-lifecycle`, but under the
 * MAINNET1 2-of-3 threshold recovery profile AND through the durable Guardian
 * service boundary (`LocalGuardianTransitionSigner`): durable-before-sign audit
 * hash chain + per-backing signing journal + signer-side risk caps. Real
 * Bitcoin Core regtest + the REAL Rust Simplicity binary (no skip, no
 * TS-only fallback).
 */

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";

const MINER_FEE = 1_000n;
const NONCE = Buffer.alloc(32, 0xab);
const MINT_AMOUNT = 1_000_000n * 100_000_000n;

function xonly(byte: number): Buffer {
  return Buffer.from(ECPair.fromPrivateKey(Buffer.alloc(32, byte)).publicKey.subarray(1));
}

/** MAINNET1 2-of-3 threshold recovery profile (deterministic REGTEST keys). */
const MAINNET1_PROFILE: VaultRecoveryProfile = {
  profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
  recoveryCsvBlocks: 2016,
  recoveryThreshold: 2,
  recoveryPubkeys: [xonly(0x51), xonly(0x52), xonly(0x53)],
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

class RegtestRpc {
  private id = 0;
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers.authorization = `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64")}`;
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers,
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
    catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; await this.call("loadwallet", [name]).catch((le: Error) => { if (!/already loaded/i.test(le.message)) throw le; }); }
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

/** Map an AuditRecord to the canonical digest fields for the hash chain. */
function digestFields(r: AuditRecord): GuardianAuditDigestFields {
  return {
    requestId: r.requestId,
    operation: r.operation,
    tokenId: r.tokenId,
    backingTxid: r.backingOutpoint.txid,
    backingVout: r.backingOutpoint.vout,
    prevStateHash: r.prevStateHash,
    nextStateHash: r.nextStateHash,
    amountAtoms: r.amountAtoms,
    grossSats: r.grossSats,
    protocolFeeSats: r.protocolFeeSats,
    minerFeeSats: r.minerFeeSats,
    expectedCmr: r.expectedCmr,
    actualCmr: r.actualCmr,
    unsignedTxDigest: r.unsignedTxDigest,
    decision: r.decision,
    rejectionReason: r.rejectionReason,
  };
}

/** In-memory durable audit sink that records the tamper-evident hash chain. */
class ChainAuditSink implements DurableAuditSink {
  links: { previousAuditHash: string; auditHash: string; fields: GuardianAuditDigestFields }[] = [];
  private head = "0".repeat(64);
  async writeBeforeSign(record: AuditRecord): Promise<{ auditHash: string }> {
    const fields = digestFields(record);
    const auditHash = computeGuardianAuditHash(this.head, fields);
    this.links.push({ previousAuditHash: this.head, auditHash, fields });
    this.head = auditHash;
    return { auditHash };
  }
  async writeAfterSign(_record: AuditRecord, _auditHash: string): Promise<void> {}
}

function orThrow(r: ValidatedCoveTransaction | { ok: false; reason: string }, label: string): ValidatedCoveTransaction {
  if ("ok" in r) throw new Error(`finalized ${label} revalidation failed: ${r.reason}`);
  return r;
}

async function main(): Promise<void> {
  const rpc = new RegtestRpc();
  const info = await rpc.getBlockchainInfo();
  assert(info.chain === "regtest", `expected regtest, got ${info.chain}`);
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });

  await rpc.createWallet("cove43"); // reuse the same wallet as v3-lifecycle (idempotent; single loaded wallet)
  const mineAddr = await rpc.getNewAddress();
  await rpc.generateToAddress(101, mineAddr);

  // Deterministic roles (NEVER mainnet keys).
  const deployer = ECPair.fromPrivateKey(Buffer.alloc(32, 0x45), { network: bitcoin.networks.regtest });
  const alice = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46), { network: bitcoin.networks.regtest });
  const feeKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x44), { network: bitcoin.networks.regtest });
  const feeScript = p2wpkhScript(feeKey);

  const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
  const guardianXOnly = signer.xOnlyPubkey();
  const recoveryKeyXOnly = xonly(0x43); // DEV1 owner key; MAINNET1 recovery leaf uses its own 2-of-3 pubkeys

  const journal = new InMemorySigningJournal();
  const audit = new ChainAuditSink();
  const riskPolicy: GuardianRiskPolicy = {
    maxGrossSats: 1_000_000n,
    maxMintAtoms: 1_000_000_000n * 100_000_000n,
    minMintGrossSats: 0n,
    maxRedeemPayoutSats: 1_000_000n,
    maxBackingSats: 100_000_000_000_000n,
    maxMinerFeeSats: 20_000n,
    allowedTokenIds: [],
    enforceTokenAllowlist: false,
  };
  const transitionSigner = new LocalGuardianTransitionSigner(localSigningBackend(signer), journal, audit, riskPolicy);

  const view = new CoveChainView();
  // Funding inputs must be confirmed and hold no Cove tokens, checked against the real node.
  const fundingChecker = chainFundingChecker({ chain: provider, isCoveCarrier: async (o) => view.getTokenUtxo(o) !== null });

  const broadcastValidated = async (validated: ValidatedCoveTransaction): Promise<string> =>
    (await broadcastValidatedCoveTransaction({ validated, network: "regtest", provider })).txid;

  // ── DEPLOY (MAINNET1 vault) ──
  console.log("STEP 1/4 — DEPLOY (MAINNET1 2-of-3 vault)");
  const deployerUtxo = await fundKey(rpc, provider, deployer, 1.0, mineAddr);
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE },
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE,
    deployerInputs: [deployerUtxo],
    deployerChangeScript: deployerUtxo.script,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  // Prove the recovery leaf is the MAINNET1 2-of-3 threshold script (CSV 2016 → 0x02 …), not DEV1 144-CSV.
  assert(deploy.vault.recoveryLeaf.script[0] === 0x02, "MAINNET1 recovery leaf must start with 2-byte CSV operand (2016)");
  deploy.psbt.signInput(0, deployer);
  deploy.psbt.finalizeAllInputs();
  const deployHex = deploy.psbt.extractTransaction().toHex();
  const deployVal = orThrow(validateFinalizedDeployTransaction({ feeScript,
    rawTxHex: deployHex, network: "regtest", chainIdentity: CHAIN_BITCOIN_REGTEST,
    guardianXOnly, recoveryKeyXOnly, recoveryProfile: MAINNET1_PROFILE,
  }), "DEPLOY");
  const deployTxid = await broadcastValidated(deployVal);
  await rpc.generateToAddress(1, mineAddr);
  const deployRaw = await provider.getRawTransaction(deployTxid);
  const deployTx = bitcoin.Transaction.fromHex(deployRaw);
  const vaultVout = findOutputIndex(deployTx, deploy.vault.scriptPubKey);
  assert(vaultVout >= 0, "vault output not found in deploy");
  const vaultValue = BigInt(deployTx.outs[vaultVout]!.value);
  assert(vaultValue === RESERVE_ANCHOR_SATS, `S0 vault value ${vaultValue}`);
  const tokenId = deploy.tokenId;
  view.deploy({ tokenId, ticker: "FROG", policyVersion: COVE_POLICY_V3, deployTxid, tokenNonce: NONCE , creatorScript: CREATOR_SCRIPT}, { txid: deployTxid, vout: vaultVout }, deploy.s0);
  console.log(`✓ DEPLOY ${deployTxid} (MAINNET1 vault ${deploy.vault.address})`);

  // ── MINT via durable transition signer ──
  console.log("STEP 2/4 — MINT (durable signer, 10k tokens)");
  const aliceUtxo = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mint1 = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: deploy.s0,
    prevBacking: { txid: deployTxid, vout: vaultVout, script: deploy.vault.scriptPubKey, valueSats: vaultValue },
    mintAmountAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE,
    buyerInputs: [aliceUtxo],
    buyerCarrierScript: p2wpkhScript(alice),
    buyerChangeScript: p2wpkhScript(alice),
    feeScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const mintSign = await transitionSigner.signMint({ fundingChecker,
    psbt: mint1.psbt, view, network: "regtest", recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript, maxMinerFeeSats: MINER_FEE,
  });
  if (!mintSign.ok) throw new Error(`durable signer refused MINT: ${mintSign.reason}: ${(mintSign as { detail?: string }).detail}`);
  assert(mintSign.simplicityResult === "PASS", "MINT Simplicity must PASS");
  assert(mintSign.expectedCmr === mintSign.actualCmr, "MINT CMR drift");
  mint1.psbt.signInput(1, alice);
  mint1.psbt.finalizeInput(1);
  const mint1Hex = mint1.psbt.extractTransaction().toHex();
  const mint1Val = orThrow(await validateFinalizedMintTransaction({
    rawTxHex: mint1Hex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript,
  }), "MINT");
  const mint1Txid = await broadcastValidated(mint1Val);
  await rpc.generateToAddress(1, mineAddr);
  assert(mint1.grossSats === 148_500n, `mint gross ${mint1.grossSats}`);
  const aliceCarrier: OutPoint = { txid: mint1Txid, vout: 2 };
  view.mint({
    tokenId, nextState: mint1.nextState,
    prevBackingOutpoint: { txid: deployTxid, vout: vaultVout },
    nextBackingOutpoint: { txid: mint1Txid, vout: 1 },
    recipientOutpoint: aliceCarrier, recipientScript: p2wpkhScript(alice), amountAtoms: MINT_AMOUNT,
  });
  console.log(`✓ MINT ${mint1Txid} (durable audit #${audit.links.length})`);

  // Distinct candidates have independent records; Bitcoin determines the winner.
  const conflict = await journal.reserve({
    network: "regtest",
    backingTxid: deployTxid,
    backingVout: vaultVout,
    unsignedTxDigest: "f".repeat(64),
  });
  assert(conflict === "RESERVED", `expected independent candidate reservation, got ${conflict}`);

  // ── REDEEM via durable transition signer ──
  console.log("STEP 3/4 — REDEEM (durable signer, full 10k)");
  const redeem = buildRedeemPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: mint1.nextState,
    prevBacking: { txid: mint1Txid, vout: 1, script: mint1.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + mint1.nextState.backingSats },
    redeemAmountAtoms: MINT_AMOUNT,
    tokenInputs: [{ txid: aliceCarrier.txid, vout: aliceCarrier.vout, script: p2wpkhScript(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE,
    sellerPayoutScript: p2wpkhScript(alice),
    sellerChangeScript: p2wpkhScript(alice),
    feeScript,
    minerFeeSats: MINER_FEE,
  });
  const redeemSign = await transitionSigner.signRedeem({ fundingChecker,
    psbt: redeem.psbt, view, network: "regtest", recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript, maxMinerFeeSats: MINER_FEE,
  });
  if (!redeemSign.ok) throw new Error(`durable signer refused REDEEM: ${redeemSign.reason}: ${(redeemSign as { detail?: string }).detail}`);
  assert(redeemSign.simplicityResult === "PASS", "REDEEM Simplicity must PASS");
  redeem.psbt.signInput(1, alice);
  redeem.psbt.finalizeInput(1);
  const redeemHex = redeem.psbt.extractTransaction().toHex();
  const redeemVal = orThrow(await validateFinalizedRedeemTransaction({
    rawTxHex: redeemHex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript,
  }), "REDEEM");
  const redeemTxid = await broadcastValidated(redeemVal);
  await rpc.generateToAddress(1, mineAddr);
  assert(redeem.grossSats === 148_500n, `redeem gross ${redeem.grossSats}`);
  assert(redeem.netSats === 137_362n, `redeem net ${redeem.netSats}`);
  assert(redeem.changeAtoms === 0n, "full redeem must have zero token change");
  view.redeem({
    tokenId, nextState: redeem.nextState,
    prevBackingOutpoint: { txid: mint1Txid, vout: 1 },
    nextBackingOutpoint: { txid: redeemTxid, vout: 1 },
    spentTokenOutpoints: [aliceCarrier], change: [],
  });
  assert(redeem.nextState.issuedPublicSupplyAtoms === 0n, "redeem must return supply to 0");
  assert(redeem.nextState.backingSats === 0n, "redeem must return backing to 0");
  console.log(`✓ REDEEM ${redeemTxid} (durable audit #${audit.links.length})`);

  // ── RE-BUY via durable transition signer ──
  console.log("STEP 4/4 — RE-BUY released capacity (durable signer, 10k)");
  const aliceRebuy = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mint2 = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: redeem.nextState,
    prevBacking: { txid: redeemTxid, vout: 1, script: redeem.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + redeem.nextState.backingSats },
    mintAmountAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE,
    buyerInputs: [aliceRebuy],
    buyerCarrierScript: p2wpkhScript(alice),
    buyerChangeScript: p2wpkhScript(alice),
    feeScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const rebuySign = await transitionSigner.signMint({ fundingChecker,
    psbt: mint2.psbt, view, network: "regtest", recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript, maxMinerFeeSats: MINER_FEE,
  });
  if (!rebuySign.ok) throw new Error(`durable signer refused RE-BUY: ${rebuySign.reason}`);
  assert(rebuySign.simplicityResult === "PASS", "RE-BUY Simplicity must PASS");
  mint2.psbt.signInput(1, alice);
  mint2.psbt.finalizeInput(1);
  const mint2Hex = mint2.psbt.extractTransaction().toHex();
  const mint2Val = orThrow(await validateFinalizedMintTransaction({
    rawTxHex: mint2Hex, view, network: "regtest", guardianXOnly, recoveryKeyXOnly,
    recoveryProfile: MAINNET1_PROFILE, feeScript,
  }), "RE-BUY");
  const mint2Txid = await broadcastValidated(mint2Val);
  await rpc.generateToAddress(1, mineAddr);
  assert(mint2.nextState.issuedPublicSupplyAtoms === mint1.nextState.issuedPublicSupplyAtoms, "re-buy must restore supply");
  console.log(`✓ RE-BUY ${mint2Txid} (durable audit #${audit.links.length})`);

  // ── durable-before-sign audit hash chain integrity ──
  assert(audit.links.length === 3, `expected 3 audit links (MINT/REDEEM/RE-BUY), got ${audit.links.length}`);
  assert(audit.links[0]!.previousAuditHash === "0".repeat(64), "chain must start from the zero hash");
  for (let i = 0; i < audit.links.length; i++) {
    const link = audit.links[i]!;
    const recomputed = computeGuardianAuditHash(link.previousAuditHash, link.fields);
    assert(recomputed === link.auditHash, `audit link ${i} hash mismatch`);
    if (i > 0) assert(link.previousAuditHash === audit.links[i - 1]!.auditHash, `audit link ${i} breaks the chain`);
  }
  const decisions = audit.links.map((l) => l.fields.decision);
  assert(decisions.every((d) => d === "VALID_TO_SIGN"), "all durable audits must be VALID_TO_SIGN");

  console.log(`✓ MAINNET1 PRODUCTION-PROFILE LIFECYCLE PASSED — ${audit.links.length} signed transitions, tamper-evident audit chain verified`);
}

main().catch((e) => {
  console.error("v3-mainnet-profile-lifecycle failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
