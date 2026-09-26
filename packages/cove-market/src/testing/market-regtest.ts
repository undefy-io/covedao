import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "node:crypto";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb, schema } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import {
  GuardianV3Signer,
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildTransferPsbtV2,
  broadcastValidatedCoveTransaction,
  validateAndSignMintTransition,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedTransferTransaction,
  RESERVE_ANCHOR_SATS,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "@crclaunch/cove-guardian/v3";
import { V3Store } from "@crclaunch/cove-indexer/v3";
import { hydrateState } from "@crclaunch/cove-indexer/v3";
import { persistentWorker, reorgPersistentToTip } from "@crclaunch/cove-indexer/v3";
import { reindexDb } from "@crclaunch/cove-indexer/v3";
import { getTokenUtxosByScriptDb } from "@crclaunch/cove-indexer/v3";
import {
  REGTEST_KEYS,
  REGTEST_GUARDIAN_PRIV,
  REGTEST_FEE_SCRIPT,
  REGTEST_NONCE,
  REGTEST_MINER_FEE,
  REGTEST_CHAIN_IDENTITY,
  regtestConfig,
} from "@crclaunch/cove-indexer/testing";
import {
  MarketService,
  defaultMarketConfig,
  signBip322P2wpkh,
  reservationMessageToSign,
  getBuyRoutes,
  getSellOptions,
  type ListingV1,
} from "../index.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

/**
 * REAL market-regtest proof (Phase 6). Requires Postgres + Bitcoin Core + a
 * built Simplicity binary; NO skip. Exercises the full fixed-price flow plus
 * best-execution quotes, external source-spend invalidation, reindex survival,
 * and a confirmed-fill reorg.
 */
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
const DB_URL = process.env.COVE_DATABASE_URL ?? process.env.DATABASE_URL;

const MINT_AMOUNT = 1_000_000n * 100_000_000n;
const HALF = MINT_AMOUNT / 2n;
const PRICE = 100_000n;

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
  createWallet = async (n: string) => { try { await this.call("createwallet", [n, false, false, "", false, false, false]); } catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; await this.call("loadwallet", [n]).catch((le: Error) => { if (!/already loaded/i.test(le.message)) throw le; }); } };
  sendToAddress = (a: string, btc: number) => this.call<string>("sendtoaddress", [a, btc]);
  generate = (n: number, a: string) => this.call<string[]>("generatetoaddress", [n, a]);
  getBestBlockHash = () => this.call<string>("getbestblockhash");
  invalidateBlock = (h: string) => this.call<void>("invalidateblock", [h]);
}

function orThrow(r: ValidatedCoveTransaction | { ok: false; reason: string }): ValidatedCoveTransaction {
  if ("ok" in r) throw new Error(`final validation failed: ${r.reason}`);
  return r;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  if (!DB_URL) throw new Error("COVE_DATABASE_URL is required (no skip)");
  const rpc = new Rpc();
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });
  const db = createDb(DB_URL);
  const cfg = regtestConfig();
  const store = new V3Store("regtest");
  await rpc.createWallet("cove-market");
  const mineAddr = await rpc.getNewAddress();
  await rpc.generate(101, mineAddr);

  let state = await hydrateState(db, "regtest", cfg);
  // Funding inputs must be confirmed and hold no Cove tokens, checked against the real node.
  const fundingChecker = chainFundingChecker({ chain: provider, isCoveCarrier: async (o) => state.getTokenUtxo(o) !== null });
  const sync = async () => { await persistentWorker({ db, store, state, provider, config: cfg }); };
  const mine = async () => { await rpc.generate(1, mineAddr); await sync(); };
  const broadcast = async (v: ValidatedCoveTransaction) => (await broadcastValidatedCoveTransaction({ validated: v, network: "regtest", provider })).txid;
  const fund = async (key: { publicKey: Uint8Array }, btc: number) => {
    const txid = await rpc.sendToAddress(p2wpkhAddr(key), btc);
    await mine();
    const t = bitcoin.Transaction.fromHex(await provider.getRawTransaction(txid));
    const script = p2wpkh(key);
    const vout = t.outs.findIndex((o) => o.script.equals(script));
    return { txid, vout, script, valueSats: BigInt(t.outs[vout]!.value) };
  };

  const deployer = REGTEST_KEYS.deployer;
  const alice = REGTEST_KEYS.alice;
  const carol = REGTEST_KEYS.carol;
  const buyer = REGTEST_KEYS.p2pBuyer;
  const signer = GuardianV3Signer.fromPrivateKey(REGTEST_GUARDIAN_PRIV);
  const guardianXOnly = signer.xOnlyPubkey();
  const recoveryXOnly = cfg.recoveryKeyXOnly;
  const feeScript = REGTEST_FEE_SCRIPT;

  // ── DEPLOY ──
  const deployerUtxo = await fund(deployer, 1.0);
  const deploy = buildDeployPsbtV3({
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: cfg.chainIdentity, policyVersion: 3, ticker: "FROG", tokenNonce: REGTEST_NONCE },
    guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [deployerUtxo], deployerChangeScript: deployerUtxo.script, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  deploy.psbt.signInput(0, deployer);
  deploy.psbt.finalizeAllInputs();
  const deployTxid = await broadcast(orThrow(validateFinalizedDeployTransaction({
    rawTxHex: deploy.psbt.extractTransaction().toHex(), network: "regtest", chainIdentity: cfg.chainIdentity, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
  })));
  await mine();
  const tokenId = deploy.tokenId;
  const tokenIdHex = tokenId.toString("hex");
  console.log(`✓ DEPLOY ${deployTxid.slice(0, 16)}…`);

  // ── MINT → Alice owns 1M ──
  const aliceUtxo = await fund(alice, 1.0);
  const mint = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: deploy.s0,
    prevBacking: { txid: deployTxid, vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: MINT_AMOUNT, guardianXOnly, recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [aliceUtxo], buyerCarrierScript: p2wpkh(alice), buyerChangeScript: p2wpkh(alice), feeScript, minerFeeSats: REGTEST_MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  const mintSign = await validateAndSignMintTransition({ fundingChecker, signer, psbt: mint.psbt, view: state, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
  if (!mintSign.ok) throw new Error(`guardian refused MINT: ${mintSign.reason}`);
  mint.psbt.signInput(1, alice);
  mint.psbt.finalizeInput(1);
  const mintTxid = await broadcast(orThrow(await validateFinalizedMintTransaction({
    rawTxHex: mint.psbt.extractTransaction().toHex(), view: state, network: "regtest", guardianXOnly, recoveryKeyXOnly: recoveryXOnly, feeScript,
  })));
  await mine();
  console.log(`✓ MINT (Alice 1M) ${mintTxid.slice(0, 16)}…`);

  const market = new MarketService(db, provider, defaultMarketConfig("regtest", feeScript));
  const aliceScript = p2wpkh(alice).toString("hex");
  const carolScript = p2wpkh(carol).toString("hex");
  const buyerScript = p2wpkh(buyer).toString("hex");

  /** Confirmed + mempool BTC at a script, via Core's UTXO set scan. */
  async function rpcBalanceAt(scriptHex: string): Promise<bigint> {
    const r = await rpc.call<{ unspents: { amount: number }[] }>("scantxoutset", ["start", [{ desc: `raw(${scriptHex})` }]]);
    return r.unspents.reduce((a, u) => a + BigInt(Math.round(u.amount * 1e8)), 0n);
  }

  async function tipHeight(): Promise<bigint> {
    return BigInt(await provider.getBestHeight());
  }

  const SINGLE_ACP = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;
  type Key = typeof alice;
  /** A Taproot (key-path) token address for `key`, and the tweaked signer for it. */
  const taproot = (key: Key) => {
    const x = Buffer.from(key.publicKey.subarray(1, 33));
    const pay = bitcoin.payments.p2tr({ internalPubkey: x, network: bitcoin.networks.regtest });
    const tweaked = key.tweak(bitcoin.crypto.taggedHash("TapTweak", x));
    return { script: pay.output!, tweaked };
  };

  /**
   * List a WHOLE carrier the Ordinals way: the server builds the listing PSBT,
   * the seller signs its one input SIGHASH_SINGLE|ANYONECANPAY, and that
   * presignature is all the seller ever signs for this sale.
   */
  async function listToken(
    owner: Key,
    source: { txid: string; vout: number; amountAtoms: bigint },
    price: bigint,
    nonceHex: string,
    opts: { taproot?: boolean } = {},
  ): Promise<string> {
    const tokenScript = opts.taproot ? taproot(owner).script : p2wpkh(owner);
    const payoutHex = p2wpkh(owner).toString("hex");
    const listing: ListingV1 = {
      orderVersion: 1,
      chainIdentity: REGTEST_CHAIN_IDENTITY,
      tokenId: tokenIdHex,
      sellerTokenScript: tokenScript.toString("hex"),
      sellerPayoutScript: payoutHex,
      sellerTokenChangeScript: tokenScript.toString("hex"),
      sourceTxid: source.txid,
      sourceVout: source.vout,
      sourceAmountAtoms: source.amountAtoms,
      amountAtoms: source.amountAtoms,
      totalPriceSats: price,
      creationHeight: await tipHeight(),
      expiryHeight: (await tipHeight()) + 500n,
      nonce: nonceHex,
    };
    const pubHex = Buffer.from(owner.publicKey).toString("hex");
    const unsigned = await market.buildListingPsbtFor(listing, opts.taproot ? pubHex : undefined);
    const psbt = bitcoin.Psbt.fromBase64(unsigned, { network: bitcoin.networks.regtest });
    assert(psbt.data.inputs.length === 1 && psbt.txOutputs.length === 1, "listing PSBT is one input, one output");
    psbt.signInput(0, opts.taproot ? taproot(owner).tweaked : owner, [SINGLE_ACP]);
    return market.createListing({ ...listing, presignedPsbtBase64: psbt.toBase64(), sellerTokenPublicKey: opts.taproot ? pubHex : undefined });
  }

  /** Buy a listing: reserve, build, the BUYER signs, the server completes it. The seller does nothing. */
  async function buy(listingId: string, fundBtc: number): Promise<{ fillId: string; txid: string }> {
    const buyerFund = await fund(buyer, fundBtc);
    const reserveNonce = randomBytes(32).toString("hex");
    const reserveSig = signBip322P2wpkh(
      buyer.privateKey!,
      Buffer.from(buyerScript, "hex"),
      reservationMessageToSign({ version: 1, listingId, reserveNonce, buyerTokenScript: buyerScript }),
    );
    const fillId = await market.reserveListing({
      listingId,
      buyerTokenScript: buyerScript,
      buyerChangeScript: buyerScript,
      buyerFundInputs: [{ txid: buyerFund.txid, vout: buyerFund.vout, script: buyerFund.script.toString("hex"), valueSats: buyerFund.valueSats }],
      reserveNonce,
      signatureB64: reserveSig,
    });
    const psbtB64 = await market.buildFillPsbt(fillId, REGTEST_MINER_FEE);
    const buyerPsbt = bitcoin.Psbt.fromBase64(psbtB64, { network: bitcoin.networks.regtest });
    assert(buyerPsbt.data.inputs[1]!.tapKeySig === undefined && !buyerPsbt.data.inputs[1]!.partialSig?.length, "the fill handed to the buyer carries no seller signature");
    buyerPsbt.signInput(0, buyer);
    await market.submitBuyerSignedPsbt(fillId, buyerPsbt.toBase64());
    const { txid } = await market.completeFill(fillId);
    return { fillId, txid };
  }

  // ══ Phase 2: external source-spend invalidation ══
  const aliceInv = await getTokenUtxosByScriptDb(db, "regtest", aliceScript);
  assert(aliceInv.length === 1, "Alice should own 1 token UTXO after MINT");
  const listingInvalid = await listToken(alice, { txid: aliceInv[0]!.txid, vout: aliceInv[0]!.vout, amountAtoms: aliceInv[0]!.amountAtoms }, PRICE, "01".repeat(32));
  console.log(`✓ listing INVALIDATION setup ${listingInvalid.slice(0, 16)}…`);

  // Alice spends her whole source UTXO externally (plain transfer to Carol).
  const extTransfer = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: aliceInv[0]!.txid, vout: aliceInv[0]!.vout, script: p2wpkh(alice), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkh(carol), amountAtoms: MINT_AMOUNT }],
    funderInputs: [await fund(alice, 0.01)], funderChangeScript: p2wpkh(alice), btcOutputs: [], minerFeeSats: REGTEST_MINER_FEE,
  });
  extTransfer.psbt.signInput(0, alice);
  extTransfer.psbt.signInput(1, alice);
  extTransfer.psbt.finalizeAllInputs();
  const extTxid = await broadcast(orThrow(validateFinalizedTransferTransaction({ rawTxHex: extTransfer.psbt.extractTransaction().toHex(), view: state })));
  await mine();
  const invRecon = await market.reconcileMarket();
  assert(invRecon.invalidated === 1, `expected 1 invalidated, got ${invRecon.invalidated}`);
  const invRow = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingInvalid));
  assert(invRow[0]!.status === "INVALIDATED", "externally-spent listing must be INVALIDATED");
  assert(invRow[0]!.sellerPresignedPsbt === null, "an invalidated listing forgets its presignature");
  console.log(`✓ external source-spend → INVALIDATED (${extTxid.slice(0, 16)}…)`);

  // ══ Phase 3: split, list while the split is in the mempool (PENDING),
  //   go live on confirmation, sell with NO seller signature at sale time ══
  const carolInv = await getTokenUtxosByScriptDb(db, "regtest", carolScript);
  assert(carolInv.length === 1, "Carol should own 1 token UTXO after external transfer");
  const split = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: carolInv[0]!.txid, vout: carolInv[0]!.vout, script: p2wpkh(carol), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    tokenOutputs: [{ script: p2wpkh(carol), amountAtoms: HALF }, { script: p2wpkh(carol), amountAtoms: HALF }],
    funderInputs: [await fund(carol, 0.01)], funderChangeScript: p2wpkh(carol), btcOutputs: [], minerFeeSats: REGTEST_MINER_FEE,
  });
  split.psbt.signInput(0, carol);
  split.psbt.signInput(1, carol);
  split.psbt.finalizeAllInputs();
  const splitTxid = await broadcast(orThrow(validateFinalizedTransferTransaction({ rawTxHex: split.psbt.extractTransaction().toHex(), view: state })));
  // Not mined yet: the carrier at vout 1 exists only in the mempool.
  const listingId = await listToken(carol, { txid: splitTxid, vout: 1, amountAtoms: HALF }, PRICE, "02".repeat(32));
  const pendingRow = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  assert(pendingRow[0]!.status === "PENDING", `a listing on an unconfirmed split is PENDING, got ${pendingRow[0]!.status}`);
  const visibleWhilePending = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.status, "ACTIVE"));
  assert(!visibleWhilePending.some((l) => l.listingId === listingId), "a PENDING listing is not buyable");
  await mine();
  await market.reconcileMarket();
  const liveRow = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  assert(liveRow[0]!.status === "ACTIVE", `the listing goes live once its carrier confirms, got ${liveRow[0]!.status}`);
  console.log(`✓ split ${splitTxid.slice(0, 16)}… → listing PENDING → ACTIVE ${listingId.slice(0, 16)}…`);

  // best execution (quote only)
  const routes = await getBuyRoutes(db, "regtest", tokenIdHex, HALF);
  assert(routes.length === 2, `expected 2 buy routes, got ${routes.length}`);
  const backingRoute = routes.find((r) => r.kind === "backing");
  const p2pRoute = routes.find((r) => r.kind === "p2p");
  assert(backingRoute && p2pRoute, "both backing and p2p routes must exist");
  assert(p2pRoute.totalCostSats === PRICE + market.marketFeeFor(PRICE), "p2p route cost = price + p2p fee");
  assert(routes[0]!.totalCostSats <= routes[1]!.totalCostSats, "routes must be sorted ascending");
  const sellOpts = await getSellOptions(db, "regtest", tokenIdHex, carolScript);
  assert(sellOpts.listableUtxos.length === 2, "Carol has 2 listable UTXOs after the split");
  assert(sellOpts.redeemQuote !== null, "Carol can redeem whole-token balance via backing");
  console.log(`✓ best execution: backing=${backingRoute.totalCostSats} p2p=${p2pRoute.totalCostSats} (best=${routes[0]!.kind})`);

  const carolPaidBefore = await rpcBalanceAt(carolScript);
  const { fillId, txid: fillTxid } = await buy(listingId, 0.2);
  await mine();
  const fillRecon = await market.reconcileMarket();
  assert(fillRecon.confirmed === 1, `expected 1 confirmed, got ${fillRecon.confirmed}`);
  const validated = { txid: fillTxid };

  const fillRow = await db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fillId));
  assert(fillRow[0]!.status === "CONFIRMED", "fill must be CONFIRMED");
  const listingRow = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  assert(listingRow[0]!.status === "FILLED", "listing must be FILLED");
  const trades = await db.select().from(schema.coveV3MarketTrades).where(eq(schema.coveV3MarketTrades.txid, validated.txid));
  assert(trades.length === 1 && trades[0]!.canonical, "exactly one canonical trade row");
  const backingAfter = await db.select().from(schema.coveV3BackingStates).where(eq(schema.coveV3BackingStates.tokenId, tokenIdHex));
  assert(backingAfter[0]!.backingSats === mint.nextState.backingSats, "P2P fill must NOT touch backing");
  const buyerInv = await getTokenUtxosByScriptDb(db, "regtest", buyerScript);
  assert(buyerInv.length === 1 && buyerInv[0]!.amountAtoms === HALF, "buyer receives exactly the listed carrier");
  // Presigned layout: 0 OP_RETURN, 1 seller payout, 2 buyer carrier, 3 fee.
  const payoutOut = await provider.getTxout(validated.txid, 1);
  assert(payoutOut && payoutOut.scriptPubKeyHex === carolScript && payoutOut.valueSats === PRICE, "seller receives exactly totalPriceSats at vout 1");
  const feeOut = await provider.getTxout(validated.txid, 3);
  assert(feeOut && feeOut.scriptPubKeyHex === feeScript.toString("hex") && feeOut.valueSats === market.marketFeeFor(PRICE), "market fee paid at vout 3");
  // Carol keeps tokens and BTC on one address here, so her sold 1,000-sat carrier leaves with the sale.
  assert((await rpcBalanceAt(carolScript)) === carolPaidBefore + PRICE - TOKEN_CARRIER_SATS, "Carol gained exactly the price (less the carrier she sold)");
  console.log(`✓ P2P fill CONFIRMED, seller signed only at listing (${HALF} atoms → buyer, ${PRICE} sats → seller, backing untouched)`);

  // ══ Phase 4: market rows survive a full indexer reindex ══
  await reindexDb({ db, store, provider, config: cfg, network: "regtest" });
  state = await hydrateState(db, "regtest", cfg);
  const afterReindexListing = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  const afterReindexFill = await db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fillId));
  const afterReindexTrade = await db.select().from(schema.coveV3MarketTrades).where(eq(schema.coveV3MarketTrades.txid, validated.txid));
  assert(afterReindexListing[0]!.status === "FILLED", "listing survives reindex");
  assert(afterReindexFill[0]!.status === "CONFIRMED", "fill survives reindex");
  assert(afterReindexTrade.length === 1, "trade survives reindex");
  console.log(`✓ market rows survive reindex (root ${state.stateRoot()})`);

  // ══ Phase 5: reorg of the confirmed fill ══
  const fillBlockHash = fillRow[0]!.blockHash ?? (await rpc.getBestBlockHash());
  await rpc.invalidateBlock(fillBlockHash);
  await reorgPersistentToTip({ db, store, state, provider, config: cfg });
  const reorgRecon = await market.reconcileMarket();
  assert(reorgRecon.reorged === 1, `expected 1 reorged, got ${reorgRecon.reorged}`);
  const reorgTrade = await db.select().from(schema.coveV3MarketTrades).where(eq(schema.coveV3MarketTrades.txid, validated.txid));
  assert(reorgTrade[0]!.canonical === false, "trade must be non-canonical after reorg");
  const reorgFill = await db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fillId));
  assert(reorgFill[0]!.status === "BROADCAST", "reorged fill must re-pend (tx still in mempool)");
  const reorgListing = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  assert(reorgListing[0]!.status === "BROADCAST", "reorged listing must re-pend with its fill");
  console.log(`✓ reorg: trade non-canonical, fill/listing re-pended to BROADCAST`);

  // Re-mine with a FRESH coinbase address (same address would re-produce the
  // orphaned block hash and be rejected as a duplicate).
  await rpc.generate(1, await rpc.getNewAddress());
  await sync();
  const reconRecon = await market.reconcileMarket();
  assert(reconRecon.confirmed === 1, "re-pended fill must re-confirm");
  const reconTrade = await db.select().from(schema.coveV3MarketTrades).where(eq(schema.coveV3MarketTrades.txid, validated.txid));
  assert(reconTrade[0]!.canonical === true, "trade must be canonical again after re-confirm");
  const reconListing = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
  assert(reconListing[0]!.status === "FILLED", "listing must be FILLED again after re-confirm");
  console.log(`✓ re-confirm after reorg: trade canonical, listing FILLED`);

  // ══ Phase 6: a Taproot (key-path) seller carrier, as every ordinals wallet has ══
  const carolLeft = (await getTokenUtxosByScriptDb(db, "regtest", carolScript)).filter((u) => u.tokenId === tokenIdHex);
  assert(carolLeft.length === 1 && carolLeft[0]!.amountAtoms === HALF, "Carol keeps the other half");
  const toTaproot = buildTransferPsbtV2({
    network: bitcoin.networks.regtest, tokenId,
    tokenInputs: [{ txid: carolLeft[0]!.txid, vout: carolLeft[0]!.vout, script: p2wpkh(carol), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: HALF,
    tokenOutputs: [{ script: taproot(carol).script, amountAtoms: HALF }],
    funderInputs: [await fund(carol, 0.01)], funderChangeScript: p2wpkh(carol), btcOutputs: [], minerFeeSats: REGTEST_MINER_FEE,
  });
  toTaproot.psbt.signInput(0, carol);
  toTaproot.psbt.signInput(1, carol);
  toTaproot.psbt.finalizeAllInputs();
  const trTxid = await broadcast(orThrow(validateFinalizedTransferTransaction({ rawTxHex: toTaproot.psbt.extractTransaction().toHex(), view: state })));
  await mine();
  const trListing = await listToken(carol, { txid: trTxid, vout: 1, amountAtoms: HALF }, PRICE * 2n, "03".repeat(32), { taproot: true });
  const trRow = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, trListing));
  assert(trRow[0]!.status === "ACTIVE", "a listing on an indexed Taproot carrier is live at once");
  const trFill = await buy(trListing, 0.2);
  await mine();
  const trRecon = await market.reconcileMarket();
  assert(trRecon.confirmed === 1, `expected the Taproot sale to confirm, got ${trRecon.confirmed}`);
  const trPayout = await provider.getTxout(trFill.txid, 1);
  assert(trPayout && trPayout.scriptPubKeyHex === carolScript && trPayout.valueSats === PRICE * 2n, "Taproot seller paid exactly");
  const buyerAll = (await getTokenUtxosByScriptDb(db, "regtest", buyerScript)).reduce((a, u) => a + u.amountAtoms, 0n);
  assert(buyerAll === MINT_AMOUNT, "buyer now holds both halves");
  console.log(`✓ Taproot seller carrier: presigned SINGLE|ACP key-path sale CONFIRMED ${trFill.txid.slice(0, 16)}…`);

  console.log("MARKET REGTEST PASSED");
}

main().catch((e) => {
  console.error("market-regtest failed:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
