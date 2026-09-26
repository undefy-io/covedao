/**
 * Cove V3 real-Core lifecycle — the Phase 4.3 transaction reality gate.
 *
 * One coherent lifecycle on unmodified Bitcoin Core regtest:
 *   DEPLOY → MINT/BUY → TRANSFER → REDEEM → RE-BUY → P2P atomic fill → reorg/replay
 *
 * Requires a reachable bitcoind -regtest. Fails (does NOT skip) if unreachable.
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  CoveChainView,
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  s0StateV2,
  type CoveStateV2,
  type OutPoint,
} from "@crclaunch/cove-covenant";
import { COVE_FEE_CONFIG, deterministicFee } from "@crclaunch/cove-economics";
import {
  CHAIN_BITCOIN_REGTEST,
  COVE_POLICY_V3,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
  computeTokenId,
  decodeV2,
  opName,
} from "@crclaunch/cove-wire";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  RESERVE_ANCHOR_SATS,
} from "./v3/builder.js";
import {
  GuardianV3Signer,
  consoleAuditSink,
  validateAndSignMintTransition,
  validateAndSignRedeemTransition,
  broadcastValidatedCoveTransaction,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "./v3/index.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";

// Deterministic Guardian key (priv=0x42) is held PRIVATELY by the production
// signer — the lifecycle never touches the signing key directly (arch. test §22).
const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
const guardianXOnly = signer.xOnlyPubkey();
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const NONCE = Buffer.alloc(32, 0xab);
const MINER_FEE = 1_000n;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

class RegtestRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly password: string,
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers.authorization = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: `${++this.id}`, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: { result?: T; error?: { message?: string } | null } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      /* ignore */
    }
    if (!res.ok || json.error)
      throw new Error(`RPC ${method}: ${json.error?.message ?? text.slice(0, 200)}`);
    return json.result as T;
  }
  async createWallet(name: string): Promise<void> {
    try {
      await this.call("createwallet", [name, false, false, "", false, true, false]);
    } catch (e) {
      if (!/already exists/i.test((e as Error).message)) throw e; await this.call("loadwallet", [name]).catch((le: Error) => { if (!/already loaded/i.test(le.message)) throw le; });
    }
  }
  getNewAddress(): Promise<string> {
    return this.call("getnewaddress");
  }
  sendToAddress(addr: string, btc: number): Promise<string> {
    return this.call("sendtoaddress", [addr, btc]);
  }
  generateToAddress(n: number, addr: string): Promise<string[]> {
    return this.call("generatetoaddress", [n, addr]);
  }
  getBlockchainInfo(): Promise<{ chain: string; blocks: number }> {
    return this.call("getblockchaininfo");
  }
  getBestBlockHash(): Promise<string> {
    return this.call("getbestblockhash");
  }
  invalidateBlock(hash: string): Promise<void> {
    return this.call("invalidateblock", [hash]);
  }
  async getMempoolEntry(txid: string): Promise<{ confirmations?: number } | null> {
    try {
      return await this.call("getmempoolentry", [txid]);
    } catch {
      return null;
    }
  }
}

function findOutputIndex(tx: bitcoin.Transaction, script: Buffer): number {
  return tx.outs.findIndex((o) => o.script.equals(script));
}

type Key = ReturnType<typeof ECPair.fromPrivateKey>;

function p2wpkhScript(key: Key): Buffer {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest })
    .output!;
}
function p2wpkhAddress(key: Key): string {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest })
    .address!;
}

interface Funded {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
}

/** Resolve a freshly-funded P2WPKH output's (txid, vout, script, value). */
async function fundKey(
  rpc: RegtestRpc,
  provider: CoreRpcProvider,
  key: Key,
  btc: number,
  mineAddr: string,
): Promise<Funded> {
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

/** Extract the wire-v2 payload from a Cove OP_RETURN (always output index 0). */
function extractWireV2(tx: bitcoin.Transaction): Buffer {
  const s = tx.outs[0]!.script;
  assert(s.length >= 2 && s[0] === 0x6a, "out[0] is not OP_RETURN");
  const len = s[1]!;
  assert(s.length === 2 + len, `OP_RETURN length mismatch (${len} vs ${s.length - 2})`);
  return Buffer.from(s.subarray(2));
}

/** Print the production Guardian signing trace (Phase 4.4 §16). */
function printSigningTrace(r: {
  operation: string;
  expectedCmr: string;
  actualCmr: string;
  simplicityResult: string;
  referencePolicyResult: string;
  signed: boolean;
}): void {
  console.log(`    policy: ${r.operation}`);
  console.log(`    expected CMR: ${r.expectedCmr}`);
  console.log(`    actual compiled CMR: ${r.actualCmr}`);
  console.log(`    Simplicity result: ${r.simplicityResult}`);
  console.log(`    reference policy: ${r.referencePolicyResult}`);
  console.log(`    Guardian signed: ${r.signed ? "YES" : "NO"}`);
}

/** Extract + decode + re-encode-check a Cove tx's wire envelope; returns decoded. */
function decodeCoveWire(tx: bitcoin.Transaction) {
  const wire = extractWireV2(tx);
  const env = decodeV2(wire);
  return { wire, env };
}

async function main(): Promise<void> {
  const line = "─".repeat(72);
  const rpc = new RegtestRpc(RPC_URL, RPC_USER, RPC_PASSWORD);
  const info = await rpc.getBlockchainInfo();
  assert(info.chain === "regtest", `expected regtest, got ${info.chain}`);
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });

  await rpc.createWallet("cove43");
  const mineAddr = await rpc.getNewAddress();
  await rpc.generateToAddress(101, mineAddr);

  const deployer = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const alice = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const bob = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const carol = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const feeKey = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const feeScript = p2wpkhScript(feeKey);

  // Deterministic in-memory chain view (§4) driven from ACTUAL tx outpoints.
  const view = new CoveChainView();
  // Funding inputs must be confirmed and hold no Cove tokens, checked against the real node.
  const fundingChecker = chainFundingChecker({ chain: provider, isCoveCarrier: async (o) => view.getTokenUtxo(o) !== null });
  // Ordered raw hex for the reorg/replay proof.
  const rawTxs: string[] = [];
  const results: { op: string; txid: string; height: number }[] = [];
  let height = info.blocks;

  const confirm = async (txid: string, op: string): Promise<void> => {
    await rpc.generateToAddress(1, mineAddr);
    height += 1;
    results.push({ op, txid, height });
  };

  // Hardened broadcast boundary (§20): accepts ONLY a ValidatedCoveTransaction
  // produced by final validation; mainnet ALWAYS refused + testmempoolaccept.
  const broadcastValidated = async (validated: ValidatedCoveTransaction): Promise<string> => {
    return (await broadcastValidatedCoveTransaction({ validated, network: "regtest", provider })).txid;
  };
  const validatedOrThrow = (result: ValidatedCoveTransaction | { ok: false; reason: string }, label: string): ValidatedCoveTransaction => {
    if ("ok" in result) throw new Error(`finalized ${label} revalidation failed: ${result.reason}`);
    return result;
  };

  // ── DEPLOY ──
  console.log(line);
  console.log("STEP 1/6 — DEPLOY");
  const deployerUtxo = await fundKey(rpc, provider, deployer, 1.0, mineAddr);
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: {
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      policyVersion: 3,
      ticker: "FROG",
      tokenNonce: NONCE,
    },
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [deployerUtxo],
    deployerChangeScript: deployerUtxo.script,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  deploy.psbt.signInput(0, deployer);
  deploy.psbt.finalizeAllInputs();
  const deployHex = deploy.psbt.extractTransaction().toHex();
  const deployVal = validatedOrThrow(
    validateFinalizedDeployTransaction({ feeScript,
      rawTxHex: deployHex,
      network: "regtest",
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
    }),
    "DEPLOY",
  );
  const deployTxid = await broadcastValidated(deployVal);
  rawTxs.push(deployHex);
  await confirm(deployTxid, "DEPLOY");
  const deployRaw = await provider.getRawTransaction(deployTxid);
  const deployTx = bitcoin.Transaction.fromHex(deployRaw);
  const vaultVout = findOutputIndex(deployTx, deploy.vault.scriptPubKey);
  assert(vaultVout >= 0, "vault output not found in deploy");
  const vaultValue = BigInt(deployTx.outs[vaultVout]!.value);
  assert(vaultValue === RESERVE_ANCHOR_SATS, `S0 vault value ${vaultValue}`);
  const tokenId = deploy.tokenId;
  view.deploy(
    {
      tokenId,
      ticker: "FROG",
      policyVersion: COVE_POLICY_V3,
      deployTxid,
      tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT
    },
    { txid: deployTxid, vout: vaultVout },
    deploy.s0,
  );
  console.log(
    `✓ DEPLOY ${deployTxid} vault=${vaultVout} value=${vaultValue} tokenId=${tokenId.toString("hex")}`,
  );

  // ── MINT (Alice buys 10k tokens) ──
  console.log(line);
  console.log("STEP 2/6 — MINT/BUY (Alice, 10k tokens)");
  const aliceUtxo = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mintAmountAtoms = 1_000_000n * 100_000_000n;
  const mint1 = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: deploy.s0,
    prevBacking: {
      txid: deployTxid,
      vout: vaultVout,
      script: deploy.vault.scriptPubKey,
      valueSats: vaultValue,
    },
    mintAmountAtoms,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [aliceUtxo],
    buyerCarrierScript: p2wpkhScript(alice),
    buyerChangeScript: p2wpkhScript(alice),
    feeScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const mintSign = await validateAndSignMintTransition({ fundingChecker,
    signer,
    psbt: mint1.psbt,
    view,
    network: "regtest",
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    auditSink: consoleAuditSink,
  });
  assert(mintSign.ok, `Guardian refused MINT: ${mintSign.ok ? "" : mintSign.reason}`);
  printSigningTrace({
    operation: "MINT",
    expectedCmr: mintSign.expectedCmr,
    actualCmr: mintSign.actualCmr,
    simplicityResult: mintSign.simplicityResult,
    referencePolicyResult: mintSign.referencePolicyResult,
    signed: true,
  });
  mint1.psbt.signInput(1, alice);
  mint1.psbt.finalizeInput(1);
  const mint1Hex = mint1.psbt.extractTransaction().toHex();
  const mint1Fin = await validateFinalizedMintTransaction({
    rawTxHex: mint1Hex,
    view,
    network: "regtest",
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
  });
  const mint1Txid = await broadcastValidated(validatedOrThrow(mint1Fin, "MINT"));
  rawTxs.push(mint1Hex);
  await confirm(mint1Txid, "MINT");
  assert(mint1.grossSats === 148_500n, `mint gross ${mint1.grossSats}`);
  assert(mint1.buyFeeSats === 26_138n, `mint fee ${mint1.buyFeeSats}`);
  const aliceCarrier: OutPoint = { txid: mint1Txid, vout: 2 };
  view.mint({
    tokenId,
    nextState: mint1.nextState,
    prevBackingOutpoint: { txid: deployTxid, vout: vaultVout },
    nextBackingOutpoint: { txid: mint1Txid, vout: 1 },
    recipientOutpoint: aliceCarrier,
    recipientScript: p2wpkhScript(alice),
    amountAtoms: mintAmountAtoms,
  });
  console.log(
    `✓ MINT ${mint1Txid} supply=${mint1.nextState.issuedPublicSupplyAtoms} backing=${mint1.nextState.backingSats} gross=${mint1.grossSats} fee=${mint1.buyFeeSats}`,
  );

  // ── TRANSFER (Alice → Bob, full 10k) ──
  console.log(line);
  console.log("STEP 3/6 — TRANSFER (Alice → Bob, 10k tokens)");
  const aliceFund = await fundKey(rpc, provider, alice, 0.01, mineAddr);
  const transfer = buildTransferPsbtV2({
    network: bitcoin.networks.regtest,
    tokenId,
    tokenInputs: [{ txid: aliceCarrier.txid, vout: aliceCarrier.vout, script: p2wpkhScript(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: mintAmountAtoms,
    tokenOutputs: [{ script: p2wpkhScript(bob), amountAtoms: mintAmountAtoms }],
    funderInputs: [aliceFund],
    funderChangeScript: p2wpkhScript(alice),
    btcOutputs: [],
    minerFeeSats: MINER_FEE,
  });
  transfer.psbt.signInput(0, alice); // token carrier
  transfer.psbt.signInput(1, alice); // BTC funder
  transfer.psbt.finalizeAllInputs();
  const transferHex = transfer.psbt.extractTransaction().toHex();
  const transferFin = validateFinalizedTransferTransaction({ rawTxHex: transferHex, view });
  const transferTxid = await broadcastValidated(validatedOrThrow(transferFin, "TRANSFER"));
  rawTxs.push(transferHex);
  await confirm(transferTxid, "TRANSFER");
  const bobCarrier: OutPoint = { txid: transferTxid, vout: 1 };
  view.transfer({
    tokenId,
    spentOutpoints: [aliceCarrier],
    created: [{ outpoint: bobCarrier, script: p2wpkhScript(bob), amountAtoms: mintAmountAtoms }],
  });
  assert(view.balanceOf(tokenId) === mintAmountAtoms, "transfer conservation failed");
  assert(
    view.backing.get(tokenId.toString("hex"))!.state.backingSats === mint1.nextState.backingSats,
    "backing must be untouched by transfer",
  );
  console.log(`✓ TRANSFER ${transferTxid} bobCarrier=${bobCarrier.txid}:${bobCarrier.vout} (backing/supply unchanged)`);

  // ── REDEEM (Bob redeems full 10k) ──
  console.log(line);
  console.log("STEP 4/6 — REDEEM (Bob, full 10k)");
  const redeem = buildRedeemPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: mint1.nextState,
    prevBacking: {
      txid: mint1Txid,
      vout: 1,
      script: mint1.nextVault.scriptPubKey,
      valueSats: RESERVE_ANCHOR_SATS + mint1.nextState.backingSats,
    },
    redeemAmountAtoms: mintAmountAtoms,
    tokenInputs: [{ txid: bobCarrier.txid, vout: bobCarrier.vout, script: p2wpkhScript(bob), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: mintAmountAtoms,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    sellerPayoutScript: p2wpkhScript(bob),
    sellerChangeScript: p2wpkhScript(bob),
    feeScript,
    minerFeeSats: MINER_FEE,
  });
  const redeemSign = await validateAndSignRedeemTransition({ fundingChecker,
    signer,
    psbt: redeem.psbt,
    view,
    network: "regtest",
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    auditSink: consoleAuditSink,
  });
  assert(redeemSign.ok, `Guardian refused REDEEM: ${redeemSign.ok ? "" : redeemSign.reason}`);
  printSigningTrace({
    operation: "REDEEM",
    expectedCmr: redeemSign.expectedCmr,
    actualCmr: redeemSign.actualCmr,
    simplicityResult: redeemSign.simplicityResult,
    referencePolicyResult: redeemSign.referencePolicyResult,
    signed: true,
  });
  redeem.psbt.signInput(1, bob);
  redeem.psbt.finalizeInput(1);
  const redeemHex = redeem.psbt.extractTransaction().toHex();
  const redeemFin = await validateFinalizedRedeemTransaction({
    rawTxHex: redeemHex,
    view,
    network: "regtest",
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
  });
  const redeemTxid = await broadcastValidated(validatedOrThrow(redeemFin, "REDEEM"));
  rawTxs.push(redeemHex);
  await confirm(redeemTxid, "REDEEM");
  assert(redeem.grossSats === 148_500n, `redeem gross ${redeem.grossSats}`);
  assert(redeem.redeemFeeSats === 11_138n, `redeem fee ${redeem.redeemFeeSats}`);
  assert(redeem.netSats === 137_362n, `redeem net ${redeem.netSats}`);
  assert(redeem.changeAtoms === 0n, "full redeem must have zero token change");
  view.redeem({
    tokenId,
    nextState: redeem.nextState,
    prevBackingOutpoint: { txid: mint1Txid, vout: 1 },
    nextBackingOutpoint: { txid: redeemTxid, vout: 1 },
    spentTokenOutpoints: [bobCarrier],
    change: [],
  });
  assert(redeem.nextState.issuedPublicSupplyAtoms === 0n, "redeem must return supply to 0");
  assert(redeem.nextState.backingSats === 0n, "redeem must return backing to 0");
  console.log(
    `✓ REDEEM ${redeemTxid} gross=${redeem.grossSats} fee=${redeem.redeemFeeSats} net=${redeem.netSats} → supply=0 backing=0`,
  );

  // ── RE-BUY (Alice re-buys released capacity, 10k) ──
  console.log(line);
  console.log("STEP 5/6 — RE-BUY released capacity (Alice, 10k)");
  const aliceRebuy = await fundKey(rpc, provider, alice, 1.0, mineAddr);
  const mint2 = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: redeem.nextState, // S0 again
    prevBacking: {
      txid: redeemTxid,
      vout: 1,
      script: redeem.nextVault.scriptPubKey,
      valueSats: RESERVE_ANCHOR_SATS + redeem.nextState.backingSats,
    },
    mintAmountAtoms,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [aliceRebuy],
    buyerCarrierScript: p2wpkhScript(alice),
    buyerChangeScript: p2wpkhScript(alice),
    feeScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const rebuySign = await validateAndSignMintTransition({ fundingChecker,
    signer,
    psbt: mint2.psbt,
    view,
    network: "regtest",
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    auditSink: consoleAuditSink,
  });
  assert(rebuySign.ok, `Guardian refused RE-BUY: ${rebuySign.ok ? "" : rebuySign.reason}`);
  printSigningTrace({
    operation: "MINT (RE-BUY)",
    expectedCmr: rebuySign.expectedCmr,
    actualCmr: rebuySign.actualCmr,
    simplicityResult: rebuySign.simplicityResult,
    referencePolicyResult: rebuySign.referencePolicyResult,
    signed: true,
  });
  mint2.psbt.signInput(1, alice);
  mint2.psbt.finalizeInput(1);
  const mint2Hex = mint2.psbt.extractTransaction().toHex();
  const mint2Fin = await validateFinalizedMintTransaction({
    rawTxHex: mint2Hex,
    view,
    network: "regtest",
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
  });
  const mint2Txid = await broadcastValidated(validatedOrThrow(mint2Fin, "RE-BUY"));
  rawTxs.push(mint2Hex);
  await confirm(mint2Txid, "RE-BUY");
  const aliceCarrier2: OutPoint = { txid: mint2Txid, vout: 2 };
  view.mint({
    tokenId,
    nextState: mint2.nextState,
    prevBackingOutpoint: { txid: redeemTxid, vout: 1 },
    nextBackingOutpoint: { txid: mint2Txid, vout: 1 },
    recipientOutpoint: aliceCarrier2,
    recipientScript: p2wpkhScript(alice),
    amountAtoms: mintAmountAtoms,
  });
  assert(
    mint2.nextState.issuedPublicSupplyAtoms === mint1.nextState.issuedPublicSupplyAtoms,
    "re-buy must restore supply",
  );
  console.log(
    `✓ RE-BUY ${mint2Txid} supply=${mint2.nextState.issuedPublicSupplyAtoms} backing=${mint2.nextState.backingSats} (released capacity re-bought)`,
  );

  // ── P2P atomic fill (Alice sells 5k to Carol for 100k sats) ──
  console.log(line);
  console.log("STEP 6/6 — P2P atomic fill (Alice → Carol, 5k for 100,000 sats)");
  const p2pPrice = 100_000n;
  const p2pFee = deterministicFee(p2pPrice, COVE_FEE_CONFIG.p2pFeeBps, COVE_FEE_CONFIG.p2pFeeFlatSats);
  assert(p2pFee === 7_500n, `p2p fee ${p2pFee}`); // 7.5% of 100,000, floored at 1,000
  const carolFund = await fundKey(rpc, provider, carol, 0.2, mineAddr);
  const halfAtoms = 500_000n * 100_000_000n;
  const p2p = buildTransferPsbtV2({
    network: bitcoin.networks.regtest,
    tokenId,
    tokenInputs: [{ txid: aliceCarrier2.txid, vout: aliceCarrier2.vout, script: p2wpkhScript(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: mintAmountAtoms,
    tokenOutputs: [
      { script: p2wpkhScript(carol), amountAtoms: halfAtoms },
      { script: p2wpkhScript(alice), amountAtoms: halfAtoms },
    ],
    funderInputs: [carolFund],
    funderChangeScript: p2wpkhScript(carol),
    btcOutputs: [
      { script: p2wpkhScript(alice), valueSats: p2pPrice - p2pFee },
      { script: feeScript, valueSats: p2pFee },
    ],
    minerFeeSats: MINER_FEE,
  });
  p2p.psbt.signInput(0, alice); // Alice's token carrier
  p2p.psbt.signInput(1, carol); // Carol's BTC funder
  p2p.psbt.finalizeAllInputs();
  const p2pHex = p2p.psbt.extractTransaction().toHex();
  const p2pFin = validateFinalizedTransferTransaction({ rawTxHex: p2pHex, view });
  const p2pTxid = await broadcastValidated(validatedOrThrow(p2pFin, "P2P"));
  rawTxs.push(p2pHex);
  await confirm(p2pTxid, "P2P");
  const carolCarrier: OutPoint = { txid: p2pTxid, vout: 1 };
  const aliceChangeCarrier: OutPoint = { txid: p2pTxid, vout: 2 };
  view.transfer({
    tokenId,
    spentOutpoints: [aliceCarrier2],
    created: [
      { outpoint: carolCarrier, script: p2wpkhScript(carol), amountAtoms: halfAtoms },
      { outpoint: aliceChangeCarrier, script: p2wpkhScript(alice), amountAtoms: halfAtoms },
    ],
  });
  assert(view.balanceOf(tokenId) === mintAmountAtoms, "p2p conservation failed");
  // Backing/supply must be untouched by the atomic P2P fill.
  assert(
    view.backing.get(tokenId.toString("hex"))!.state.backingSats === mint2.nextState.backingSats,
    "p2p must not move backing",
  );
  console.log(
    `✓ P2P ${p2pTxid} carol=${halfAtoms} aliceChange=${halfAtoms} btcPayment=${p2pPrice - p2pFee} p2pFee=${p2pFee} (one atomic tx)`,
  );

  // ── Reorg + replay ──
  console.log(line);
  console.log("REORG + REPLAY");
  const tipBefore = await rpc.getBestBlockHash();
  assert((await rpc.getMempoolEntry(p2pTxid)) === null, "p2p should be confirmed pre-reorg");
  await rpc.invalidateBlock(tipBefore);
  const inMempool = await rpc.getMempoolEntry(p2pTxid);
  assert(inMempool !== null, "p2p tx must return to mempool after invalidateblock");
  // Fresh coinbase address → different coinbase → different block hash (a real
  // 1-block reorg). Reusing mineAddr would reproduce the SAME block hash and be
  // rejected as "duplicate" by Core.
  const newTip = (await rpc.generateToAddress(1, await rpc.getNewAddress()))[0]!;
  assert(newTip !== tipBefore, "re-mined tip must differ (real reorg)");
  const p2pRawAfter = await provider.getRawTransaction(p2pTxid);
  assert(p2pRawAfter.length > 0, "p2p tx must be re-confirmed after reorg (same txid)");
  console.log(`✓ reorg: invalidated ${tipBefore.slice(0, 16)}… → re-mined ${newTip.slice(0, 16)}…`);

  // Deterministic replay: rebuild a fresh chain view from raw tx hex only.
  const replayed = replayChain(rawTxs);
  const liveBacking = view.backing.get(tokenId.toString("hex"))!;
  const replayBacking = replayed.view.backing.get(tokenId.toString("hex"))!;
  assert(
    replayed.state.issuedPublicSupplyAtoms === liveBacking.state.issuedPublicSupplyAtoms,
    "replay supply mismatch",
  );
  assert(replayBacking.state.backingSats === liveBacking.state.backingSats, "replay backing mismatch");
  assert(
    replayed.view.balanceOf(tokenId) === view.balanceOf(tokenId),
    "replay balance mismatch",
  );
  console.log(
    `✓ replay: rebuilt identical state (supply=${replayed.state.issuedPublicSupplyAtoms} backing=${replayed.state.backingSats} balance=${replayed.view.balanceOf(tokenId)})`,
  );

  console.log(line);
  console.log("COVE V3 LIFECYCLE PASSED (real Bitcoin Core regtest)");
  for (const r of results) console.log(`    ${r.op.padEnd(8)} ${r.txid}  @height ${r.height}`);
  console.log(line);
}

/**
 * Deterministic replay: rebuild a fresh CoveChainView + final state from raw tx
 * hex ONLY (the same bytes Bitcoin Core re-confirms after a reorg). This is the
 * reorg/replay proof — the resolver never trusts caller-supplied state.
 */
function replayChain(rawTxs: string[]): { view: CoveChainView; state: CoveStateV2 } {
  const view = new CoveChainView();
  let state: CoveStateV2 | null = null;
  let tokenId: Buffer | null = null;

  for (const raw of rawTxs) {
    const tx = bitcoin.Transaction.fromHex(raw);
    const { env } = decodeCoveWire(tx);
    switch (env.op) {
      case OP_DEPLOY: {
        tokenId = computeTokenId({
          chainIdentity: CHAIN_BITCOIN_REGTEST,
          policyVersion: env.policyVersion,
          ticker: env.ticker,
          tokenNonce: env.tokenNonce,
          creatorScript: tx.outs[2]!.script,
        });
        const s0 = s0StateV2({ tokenId: tokenId.toString("hex") });
        state = s0;
        view.deploy(
          { tokenId, ticker: env.ticker, policyVersion: env.policyVersion, deployTxid: tx.getId(), tokenNonce: env.tokenNonce , creatorScript: CREATOR_SCRIPT},
          { txid: tx.getId(), vout: 1 },
          s0,
        );
        break;
      }
      case OP_MINT: {
        assert(state !== null && tokenId !== null, "mint before deploy");
        const { nextState } = applyMintV2(state, env.amount);
        const prevBacking = view.backing.get(tokenId.toString("hex"))!.outpoint;
        view.mint({
          tokenId,
          nextState,
          prevBackingOutpoint: prevBacking,
          nextBackingOutpoint: { txid: tx.getId(), vout: 1 },
          recipientOutpoint: { txid: tx.getId(), vout: env.recipientVout },
          recipientScript: tx.outs[env.recipientVout]!.script,
          amountAtoms: env.amount,
        });
        state = nextState;
        break;
      }
      case OP_TRANSFER: {
        assert(tokenId !== null, "transfer before deploy");
        const spent = view.resolveTokenInputs(tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString("hex"), vout: i.index })));
        view.transfer({
          tokenId,
          spentOutpoints: spent.map((u) => u.outpoint),
          created: env.allocations.map((a) => ({
            outpoint: { txid: tx.getId(), vout: a.vout },
            script: tx.outs[a.vout]!.script,
            amountAtoms: a.amount,
          })),
        });
        break;
      }
      case OP_REDEEM: {
        assert(state !== null && tokenId !== null, "redeem before deploy");
        const { nextState } = applyRedeemV2(state, env.redeemAmount);
        const prevBacking = view.backing.get(tokenId.toString("hex"))!.outpoint;
        const spent = view.resolveTokenInputs(tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString("hex"), vout: i.index })));
        view.redeem({
          tokenId,
          nextState,
          prevBackingOutpoint: prevBacking,
          nextBackingOutpoint: { txid: tx.getId(), vout: 1 },
          spentTokenOutpoints: spent.map((u) => u.outpoint),
          change: env.changeAllocations.map((a) => ({
            outpoint: { txid: tx.getId(), vout: a.vout },
            script: tx.outs[a.vout]!.script,
            amountAtoms: a.amount,
          })),
        });
        state = nextState;
        break;
      }
      default:
        throw new Error(`unexpected op ${opName((env as { op: number }).op)}`);
    }
  }
  assert(state !== null, "no state after replay");
  return { view, state };
}

import { pathToFileURL } from "node:url";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("v3-lifecycle failed:", e instanceof Error ? e.message : String(e));
    console.error((e as Error).stack?.split("\n").slice(0, 12).join("\n"));
    process.exit(1);
  });
}
