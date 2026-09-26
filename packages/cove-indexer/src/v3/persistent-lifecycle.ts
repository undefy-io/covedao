import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb, schema } from "@crclaunch/db";
import { eq, and } from "drizzle-orm";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { requiredBackingSats } from "@crclaunch/cove-economics";
import {
  GuardianV3Signer,
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  broadcastValidatedCoveTransaction,
  validateAndSignMintTransition,
  validateAndSignRedeemTransition,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  RESERVE_ANCHOR_SATS,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "@crclaunch/cove-guardian/v3";
import { V3Store } from "./store.js";
import { hydrateState } from "./hydrate.js";
import { persistentWorker } from "./persistent.js";
import { loadCanonicalViewSnapshotFromDb } from "./snapshot.js";
import { computeHealth } from "./health.js";
import { getTokenUtxosByScriptDb } from "./read-models-db.js";
import { REGTEST_KEYS, REGTEST_GUARDIAN_PRIV, REGTEST_FEE_SCRIPT, REGTEST_NONCE, REGTEST_MINER_FEE, regtestConfig } from "./testing/regtest-fixture.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

/**
 * REAL persistent lifecycle proof (§3-§12). Requires Postgres + Bitcoin Core +
 * a built Simplicity binary; NO skip. Uses persistentWorker to index EVERY
 * canonical block and hydrates from Postgres as the assertion authority.
 */
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
const DB_URL = process.env.COVE_DATABASE_URL ?? process.env.DATABASE_URL;

const MINT_AMOUNT = 1_000_000n * 100_000_000n;
/** Required backing after minting MINT_AMOUNT from S0, from the frozen curve. */
const R_MINT = requiredBackingSats(MINT_AMOUNT / 100_000_000n);

function p2wpkh(key: { publicKey: Uint8Array }): Buffer {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey as Buffer, network: bitcoin.networks.regtest }).output!;
}
function p2wpkhAddr(key: { publicKey: Uint8Array }): string {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey as Buffer, network: bitcoin.networks.regtest }).address!;
}

class Rpc {
  private id = 0;
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers.authorization = `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64")}`;
    const res = await fetch(RPC_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: `${++this.id}`, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (!res.ok || json.error) throw new Error(`RPC ${method}: ${json.error?.message ?? "err"}`);
    return json.result as T;
  }
  getNewAddress = () => this.call<string>("getnewaddress");
  createWallet = async (n: string) => {
    try { await this.call("createwallet", [n, false, false, "", false, false, false]); }
    catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; await this.call("loadwallet", [n]).catch((le: Error) => { if (!/already loaded/i.test(le.message)) throw le; }); }
  };
  sendToAddress = (a: string, btc: number) => this.call<string>("sendtoaddress", [a, btc]);
  generate = (n: number, a: string) => this.call<string[]>("generatetoaddress", [n, a]);
}

function orThrow(r: ValidatedCoveTransaction | { ok: false; reason: string }): ValidatedCoveTransaction {
  if ("ok" in r) throw new Error(`final validation failed: ${r.reason}`);
  return r;
}

async function main() {
  if (!DB_URL) throw new Error("COVE_DATABASE_URL is required (no skip)");
  const rpc = new Rpc();
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });
  const db = createDb(DB_URL);
  const cfg = regtestConfig();
  const store = new V3Store("regtest");

  await rpc.createWallet("cove53");
  const mineAddr = await rpc.getNewAddress();
  await rpc.generate(101, mineAddr);

  // start from a clean persisted state
  const state = await hydrateState(db, "regtest", cfg);
  // Funding inputs must be confirmed and hold no Cove tokens, checked against the real node.
  const fundingChecker = chainFundingChecker({ chain: provider, isCoveCarrier: async (o) => state.getTokenUtxo(o) !== null });

  async function sync(): Promise<void> {
    await persistentWorker({ db, store, state, provider, config: cfg });
    const hydrated = await hydrateState(db, "regtest", cfg);
    if (hydrated.cursor.height !== state.cursor.height) throw new Error("cursor desync after worker");
  }
  async function mine(): Promise<void> {
    await rpc.generate(1, mineAddr);
    await sync();
  }
  async function broadcast(validated: ValidatedCoveTransaction): Promise<string> {
    return (await broadcastValidatedCoveTransaction({ validated, network: "regtest", provider })).txid;
  }
  async function fund(key: { publicKey: Uint8Array }, btc: number) {
    const addr = p2wpkhAddr(key);
    const txid = await rpc.sendToAddress(addr, btc);
    await rpc.generate(1, mineAddr);
    await sync();
    const raw = await provider.getRawTransaction(txid);
    const t = bitcoin.Transaction.fromHex(raw);
    const script = p2wpkh(key);
    const vout = t.outs.findIndex((o) => o.script.equals(script));
    return { txid, vout, script, valueSats: BigInt(t.outs[vout]!.value) };
  }

  const deployer = REGTEST_KEYS.deployer;
  const alice = REGTEST_KEYS.alice;
  const bob = REGTEST_KEYS.bob;
  const carol = REGTEST_KEYS.carol;
  const signer = GuardianV3Signer.fromPrivateKey(REGTEST_GUARDIAN_PRIV);
  const guardianXOnly = signer.xOnlyPubkey();
  const recoveryXOnly = cfg.recoveryKeyXOnly;
  const feeScript = REGTEST_FEE_SCRIPT;

  // ── DEPLOY ──
  const deployerUtxo = await fund(deployer, 1.0);
  const deploy = buildDeployPsbtV3({ feeScript: REGTEST_FEE_SCRIPT,
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: cfg.chainIdentity, policyVersion: 3, ticker: "FROG", tokenNonce: REGTEST_NONCE },
    guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [deployerUtxo], deployerChangeScript: deployerUtxo.script, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  deploy.psbt.signInput(0, deployer);
  deploy.psbt.finalizeAllInputs();
  const deployHex = deploy.psbt.extractTransaction().toHex();
  const deployVal = orThrow(validateFinalizedDeployTransaction({ feeScript: REGTEST_FEE_SCRIPT, rawTxHex: deployHex, network: "regtest", chainIdentity: cfg.chainIdentity, guardianXOnly, recoveryKeyXOnly: recoveryXOnly }));
  const deployTxid = await broadcast(deployVal);
  await mine();
  const tokenId = deploy.tokenId;
  const tokenIdHex = tokenId.toString("hex");
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (!h.tokens.has(tokenIdHex)) throw new Error("DEPLOY not persisted");
    if (h.backing.get(tokenIdHex)!.state.backingSats !== 0n) throw new Error("DEPLOY backing != 0");
  }
  console.log(`✓ DEPLOY persisted ${deployTxid}`);

  // ── MINT ──
  const aliceUtxo = await fund(alice, 1.0);
  const mint1 = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: deploy.s0,
    prevBacking: { txid: deployTxid, vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [aliceUtxo], buyerCarrierScript: p2wpkh(alice), buyerChangeScript: p2wpkh(alice), feeScript, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const mintSign = await validateAndSignMintTransition({ fundingChecker, signer, psbt: mint1.psbt, view: state, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
  if (!mintSign.ok) throw new Error(`guardian refused MINT: ${mintSign.reason}`);
  mint1.psbt.signInput(1, alice);
  mint1.psbt.finalizeInput(1);
  const mintHex = mint1.psbt.extractTransaction().toHex();
  const mintVal = orThrow(await validateFinalizedMintTransaction({ rawTxHex: mintHex, view: state, network: "regtest", guardianXOnly, recoveryKeyXOnly: recoveryXOnly, feeScript }));
  const mintTxid = await broadcast(mintVal);
  await mine();
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (h.backing.get(tokenIdHex)!.state.backingSats !== R_MINT) throw new Error("MINT backing != R(1M)");
    if (h.tokenUtxos.size !== 1) throw new Error("MINT should create 1 token utxo");
  }
  console.log(`✓ MINT persisted ${mintTxid}`);

  // ── TRANSFER Alice→Bob ──
  const aliceFund = await fund(alice, 0.01);
  const transfer = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: mintTxid, vout: 2, script: p2wpkh(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkh(bob), amountAtoms: MINT_AMOUNT }],
    funderInputs: [aliceFund], funderChangeScript: p2wpkh(alice), btcOutputs: [], minerFeeSats: REGTEST_MINER_FEE,
  });
  transfer.psbt.signInput(0, alice);
  transfer.psbt.signInput(1, alice);
  transfer.psbt.finalizeAllInputs();
  const transferHex = transfer.psbt.extractTransaction().toHex();
  const transferVal = orThrow(validateFinalizedTransferTransaction({ rawTxHex: transferHex, view: state }));
  const transferTxid = await broadcast(transferVal);
  await mine();
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (h.backing.get(tokenIdHex)!.state.backingSats !== R_MINT) throw new Error("TRANSFER moved backing");
  }
  console.log(`✓ TRANSFER persisted ${transferTxid}`);

  // ── REDEEM full ──
  const redeem = buildRedeemPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: mint1.nextState,
    prevBacking: { txid: mintTxid, vout: 1, script: mint1.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + mint1.nextState.backingSats },
    redeemAmountAtoms: MINT_AMOUNT,
    tokenInputs: [{ txid: transferTxid, vout: 1, script: p2wpkh(bob), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    sellerPayoutScript: p2wpkh(bob), sellerChangeScript: p2wpkh(bob), feeScript, minerFeeSats: REGTEST_MINER_FEE,
  });
  const redeemSign = await validateAndSignRedeemTransition({ fundingChecker, signer, psbt: redeem.psbt, view: state, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
  if (!redeemSign.ok) throw new Error(`guardian refused REDEEM: ${redeemSign.reason}`);
  redeem.psbt.signInput(1, bob);
  redeem.psbt.finalizeInput(1);
  const redeemHex = redeem.psbt.extractTransaction().toHex();
  const redeemVal = orThrow(await validateFinalizedRedeemTransaction({ rawTxHex: redeemHex, view: state, network: "regtest", guardianXOnly, recoveryKeyXOnly: recoveryXOnly, feeScript }));
  const redeemTxid = await broadcast(redeemVal);
  await mine();
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (h.backing.get(tokenIdHex)!.state.backingSats !== 0n) throw new Error("REDEEM backing != 0");
  }
  console.log(`✓ REDEEM persisted ${redeemTxid}`);

  // ── RE-BUY ──
  const aliceRebuy = await fund(alice, 1.0);
  const mint2 = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: redeem.nextState,
    prevBacking: { txid: redeemTxid, vout: 1, script: redeem.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [aliceRebuy], buyerCarrierScript: p2wpkh(alice), buyerChangeScript: p2wpkh(alice), feeScript, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const rebuySign = await validateAndSignMintTransition({ fundingChecker, signer, psbt: mint2.psbt, view: state, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
  if (!rebuySign.ok) throw new Error(`guardian refused RE-BUY: ${rebuySign.reason}`);
  mint2.psbt.signInput(1, alice);
  mint2.psbt.finalizeInput(1);
  const mint2Hex = mint2.psbt.extractTransaction().toHex();
  const mint2Val = orThrow(await validateFinalizedMintTransaction({ rawTxHex: mint2Hex, view: state, network: "regtest", guardianXOnly, recoveryKeyXOnly: recoveryXOnly, feeScript }));
  const mint2Txid = await broadcast(mint2Val);
  await mine();
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (h.backing.get(tokenIdHex)!.state.backingSats !== R_MINT) throw new Error("RE-BUY backing != R(1M)");
  }
  console.log(`✓ RE-BUY persisted ${mint2Txid}`);

  // ── P2P atomic fill (market readiness) ──
  const aliceScript = p2wpkh(alice).toString("hex");
  const before = await getTokenUtxosByScriptDb(db, "regtest", aliceScript);
  if (before.length !== 1) throw new Error(`expected 1 seller utxo, got ${before.length}`);
  const sellerX = before[0]!;
  const half = MINT_AMOUNT / 2n;
  const p2pPrice = 100_000n;
  const p2p = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: sellerX.txid, vout: sellerX.vout, script: p2wpkh(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkh(carol), amountAtoms: half }, { script: p2wpkh(alice), amountAtoms: half }],
    funderInputs: [await fund(REGTEST_KEYS.p2pBuyer, 0.2)],
    funderChangeScript: p2wpkh(REGTEST_KEYS.p2pBuyer),
    btcOutputs: [{ script: p2wpkh(alice), valueSats: p2pPrice }],
    minerFeeSats: REGTEST_MINER_FEE,
  });
  p2p.psbt.signInput(0, alice);
  p2p.psbt.signInput(1, REGTEST_KEYS.p2pBuyer);
  p2p.psbt.finalizeAllInputs();
  const p2pHex = p2p.psbt.extractTransaction().toHex();
  const p2pVal = orThrow(validateFinalizedTransferTransaction({ rawTxHex: p2pHex, view: state }));
  const p2pTxid = await broadcast(p2pVal);
  await mine();
  {
    const h = await hydrateState(db, "regtest", cfg);
    const after = await getTokenUtxosByScriptDb(db, "regtest", aliceScript);
    if (after.some((u) => u.txid === sellerX.txid && u.vout === sellerX.vout)) throw new Error("seller UTXO still unspent after P2P");
    if (h.backing.get(tokenIdHex)!.state.backingSats !== R_MINT) throw new Error("P2P moved backing");
    // spent marker
    const spent = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), eq(schema.coveV3TokenUtxos.txid, sellerX.txid), eq(schema.coveV3TokenUtxos.vout, sellerX.vout)));
    if (spent[0]!.spentByTxid !== p2pTxid) throw new Error("P2P spentByTxid mismatch");
  }
  console.log(`✓ P2P persisted ${p2pTxid} (seller inventory spent, buyer inventory created)`);

  // ── DB-backed snapshot → real Guardian ──
  const health = await computeHealth({ db, network: "regtest", provider });
  if (health.health !== "HEALTHY") throw new Error(`health not HEALTHY: ${health.health}`);
  const snapshot = await loadCanonicalViewSnapshotFromDb({ db, network: "regtest", tokenId: tokenIdHex });
  // cross-token lookup must return null
  if (snapshot.getCurrentBackingState(Buffer.alloc(32, 0x01)) !== null) throw new Error("cross-token snapshot leaked backing");
  // use snapshot directly in a Guardian MINT (no in-memory V3IndexerState)
  const newBuyer = REGTEST_KEYS.carol;
  const newBuyerFund = await fund(newBuyer, 1.0);
  const mint3 = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: mint2.nextState,
    prevBacking: { txid: mint2Txid, vout: 1, script: mint2.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + mint2.nextState.backingSats },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [newBuyerFund], buyerCarrierScript: p2wpkh(newBuyer), buyerChangeScript: p2wpkh(newBuyer), feeScript, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const snapSign = await validateAndSignMintTransition({ fundingChecker, signer, psbt: mint3.psbt, view: snapshot, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
  if (!snapSign.ok) throw new Error(`snapshot-driven Guardian refused: ${snapSign.reason}`);
  console.log(`✓ DB snapshot → Guardian signed (Simplicity PASS, CMR ${snapSign.actualCmr.slice(0, 8)}…)`);

  const finalRoot = (await hydrateState(db, "regtest", cfg)).stateRoot();
  console.log(`✓ PERSISTENT LIFECYCLE PASSED — final root ${finalRoot}`);
}

main().catch((e) => {
  console.error("persistent-lifecycle failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
