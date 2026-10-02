import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { CoreRpcProvider, checkListingSignature, checkSpendSignature, SIGHASH_SINGLE_ANYONECANPAY } from "@crclaunch/bitcoin";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { buildCoveV3MarketFill, buildCoveV3Transfer, buildCurveBuyV3, buildCurveDeployV3, buildCurveSellV3, buildUnsignedPsbt, type CoveTokenInput, type TxTemplate } from "@crclaunch/crc20-transactions";
import { schema } from "@crclaunch/db";
import { saveAuthorizedCrcLaunchIntent } from "./intents.js";
import { syncCrcTip, type CrcWorkerSnapshot } from "./runner.js";
import { hydrateCrcLedger } from "./worker.js";
import { migrateCrcTestDb } from "./test-migration.js";

type Funding = { txid: string; vout: number; sats: number; scriptHex: string };
type Signed = { txid: string; rawHex: string; change: Funding };

class Rpc {
  private id = 0;
  constructor(private readonly url: string, private readonly user: string, private readonly password: string) {}

  async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    const response = await fetch(wallet ? `${this.url}/wallet/crc` : this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { result?: T; error?: { message?: string } | null };
    if (!response.ok || body.error || body.result === undefined) throw new Error(`Core ${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }

  async address(type: "bech32m" | "bech32" | "p2sh-segwit" = "bech32m"): Promise<{ address: string; scriptHex: string }> {
    const address = await this.call<string>("getnewaddress", ["", type], true);
    const info = await this.call<{ scriptPubKey: string }>("getaddressinfo", [address], true);
    return { address, scriptHex: info.scriptPubKey };
  }
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function transaction(template: TxTemplate, inputs: readonly Funding[]): bitcoin.Transaction {
  const tx = template.tx.clone();
  for (const input of inputs) tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout);
  return tx;
}

async function sign(rpc: Rpc, template: TxTemplate, inputs: readonly Funding[], changeScriptHex: string): Promise<Signed> {
  const unsigned = transaction(template, inputs);
  return signRaw(rpc, unsigned, changeScriptHex);
}

async function signRaw(rpc: Rpc, unsigned: bitcoin.Transaction, changeScriptHex: string): Promise<Signed> {
  const result = await rpc.call<{ hex: string; complete: boolean; errors?: unknown[] }>("signrawtransactionwithwallet", [unsigned.toHex()], true);
  if (!result.complete) throw new Error(`Core did not sign all inputs: ${JSON.stringify(result.errors ?? [])}`);
  const signed = bitcoin.Transaction.fromHex(result.hex);
  const vout = signed.outs.findIndex((output, index) => index === signed.outs.length - 1 && output.script.toString("hex") === changeScriptHex);
  if (vout < 0) throw new Error("signed transaction lacks expected change output");
  return { txid: signed.getId(), rawHex: result.hex, change: { txid: signed.getId(), vout, sats: signed.outs[vout]!.value, scriptHex: changeScriptHex } };
}

function unsigned(inputs: readonly Funding[], outputs: readonly { sats: number; scriptHex: string }[]): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const input of inputs) tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout);
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.sats);
  return tx;
}

async function mine(rpc: Rpc, address: string): Promise<string> {
  const hashes = await rpc.call<string[]>("generatetoaddress", [1, address]);
  if (hashes.length !== 1) throw new Error("Core did not mine one block");
  return hashes[0]!;
}

async function clean(db: ReturnType<typeof drizzle<typeof schema>>): Promise<void> {
  const network = "regtest";
  await db.delete(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, network));
  await db.delete(schema.coveCrcUndo).where(eq(schema.coveCrcUndo.network, network));
  await db.delete(schema.coveCrcBlocks).where(eq(schema.coveCrcBlocks.network, network));
  await db.delete(schema.coveCrcBalances).where(eq(schema.coveCrcBalances.network, network));
  await db.delete(schema.coveCrcTokenUtxos).where(eq(schema.coveCrcTokenUtxos.network, network));
  await db.delete(schema.coveCrcVaults).where(eq(schema.coveCrcVaults.network, network));
  await db.delete(schema.coveCrcAssets).where(eq(schema.coveCrcAssets.network, network));
  await db.delete(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network));
  await db.delete(schema.coveCrcLaunchIntents).where(eq(schema.coveCrcLaunchIntents.network, network));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.CRC_TEST_DATABASE_URL;
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  if (process.env.CRC_REGTEST_E2E !== "1" || parsed?.hostname !== "127.0.0.1" || parsed.port !== "5435" || parsed.pathname !== "/crc_test") {
    throw new Error("run only with CRC_REGTEST_E2E=1 and the isolated 127.0.0.1:5435/crc_test database");
  }
  const rpcUrl = process.env.CRC_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
  const rpcUser = process.env.CRC_REGTEST_RPC_USER ?? "crc";
  const rpcPassword = process.env.CRC_REGTEST_RPC_PASSWORD ?? "crc-regtest";
  const rpc = new Rpc(rpcUrl, rpcUser, rpcPassword);
  const provider = new CoreRpcProvider({ url: rpcUrl, user: rpcUser, password: rpcPassword });
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    await migrateCrcTestDb(pool, db);
    if ((await hydrateCrcLedger(db, "regtest")).cursor) throw new Error("isolated regtest CRC projection is not empty");
    requireEqual((await provider.getBlockchainInfo()).chain, "regtest", "Core chain");
    const buyer = await rpc.address();
    const vault = await rpc.address();
    const creator = await rpc.address();
    const protocol = await rpc.address();
    const miner = await rpc.address();
    const scripts = { buyer: buyer.scriptHex, seller: buyer.scriptHex, vault: vault.scriptHex, creator: creator.scriptHex, protocol: protocol.scriptHex };
    const fundedTxid = await rpc.call<string>("sendtoaddress", [buyer.address, 0.002], true);
    await mine(rpc, miner.address);
    const fundedRaw = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [fundedTxid]));
    const fundedVout = fundedRaw.outs.findIndex((output) => output.value === 200_000 && output.script.toString("hex") === buyer.scriptHex);
    if (fundedVout < 0) throw new Error("wallet funding output missing");
    let funding: Funding = { txid: fundedTxid, vout: fundedVout, sats: 200_000, scriptHex: buyer.scriptHex };
    const ticker = `RG${randomBytes(3).toString("hex").toUpperCase()}`;
    const deploy = await sign(rpc, buildCurveDeployV3({ ticker, maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330, changeSats: funding.sats - 8_330 - 1_000, changeScriptHex: buyer.scriptHex }), [funding], buyer.scriptHex);
    const launchSaltHex = randomBytes(32).toString("hex");
    await saveAuthorizedCrcLaunchIntent(db, "regtest", deploy.rawHex, { launchSaltHex, vaultScriptHex: vault.scriptHex, creatorScriptHex: creator.scriptHex, protocolScriptHex: protocol.scriptHex, vaultAnchorSats: 330 });
    requireEqual(await rpc.call<string>("sendrawtransaction", [deploy.rawHex]), deploy.txid, "deploy broadcast txid");
    const deployHash = await mine(rpc, miner.address);
    const activationHeight = (await provider.getBlockchainInfo()).blocks;
    let synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex });
    requireEqual(synced.snapshot.cursor?.hash, deployHash, "deploy cursor");
    const assetId = `regtest:${deploy.txid}`;
    requireEqual(synced.snapshot.state.assets[assetId]?.status, "live", "deployed asset");
    funding = deploy.change;
    const operations: readonly { side: "buy" | "sell"; tokens: bigint }[] = [
      { side: "buy", tokens: 1_000n }, { side: "buy", tokens: 1_000n }, { side: "buy", tokens: 1_000n },
      { side: "sell", tokens: 1_000n }, { side: "sell", tokens: 1_000n }, { side: "sell", tokens: 1_000n },
      { side: "buy", tokens: 1_000n }, { side: "buy", tokens: 1_000n },
    ];
    let previousSnapshot: CrcWorkerSnapshot | undefined;
    let lastBlockHash = "";
    for (const [index, operation] of operations.entries()) {
      previousSnapshot = synced.snapshot;
      const asset = synced.snapshot.state.assets[assetId];
      if (!asset || asset.status !== "live") throw new Error("asset unavailable before trade");
      const curve = asset.curve;
      const buyQuote = operation.side === "buy" ? quoteBuy(curve, operation.tokens) : null;
      const sellQuote = operation.side === "sell" ? quoteSell(curve, operation.tokens, 330n) : null;
      const tokenEntry = operation.side === "sell" ? Object.entries(asset.tokenUtxos ?? {})
        .find(([, coin]) => coin.scriptHex === buyer.scriptHex && BigInt(coin.atoms) === operation.tokens * 100_000_000n) : undefined;
      if (operation.side === "sell" && !tokenEntry) throw new Error("indexed seller token coin missing");
      const tokenInput = tokenEntry ? await (async () => {
        const [txid, vout] = tokenEntry[0].split(":");
        const parent = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [txid]));
        const output = parent.outs[Number(vout)];
        if (!output || output.script.toString("hex") !== tokenEntry[1].scriptHex) throw new Error("token carrier parent mismatch");
        return { txid: txid!, vout: Number(vout), sats: output.value, valueSats: output.value,
          scriptHex: tokenEntry[1].scriptHex,
          tokenAtoms: BigInt(tokenEntry[1].atoms), tokenDeploymentTxid: deploy.txid } satisfies CoveTokenInput & Funding;
      })() : undefined;
      const fixedOutputs = buyQuote
        ? 330n + curve.vaultSats + buyQuote.grossSats + buyQuote.protocolFeeSats + buyQuote.creatorFeeSats
        : curve.vaultSats - sellQuote!.grossSats + sellQuote!.sellerPayoutSats + sellQuote!.protocolFeeSats + BigInt(tokenInput?.sats ?? 0);
      const change = Number(curve.vaultSats + BigInt(funding.sats) + BigInt(tokenInput?.sats ?? 0) - fixedOutputs - 1_000n);
      if (change < 330) throw new Error("regtest funding change below dust");
      const [vaultTxid, vaultVoutText] = curve.vaultOutpoint.split(":");
      const vaultInput: CoveTokenInput & Funding = { txid: vaultTxid!, vout: Number(vaultVoutText),
        sats: Number(curve.vaultSats), valueSats: Number(curve.vaultSats), scriptHex: vault.scriptHex,
        tokenAtoms: curve.vaultAtoms, ...(curve.vaultAtoms > 0n ? { tokenDeploymentTxid: deploy.txid } : {}) };
      const template = operation.side === "buy"
        ? buildCurveBuyV3({ ticker, deploymentTxid: deploy.txid, state: curve, amountTokens: operation.tokens,
          scripts, recipientSats: 330, vaultInput, changeSats: change, changeScriptHex: buyer.scriptHex })
        : buildCurveSellV3({ ticker, deploymentTxid: deploy.txid, state: curve, amountTokens: operation.tokens,
          scripts, vaultInput, sellerTokenInputs: [tokenInput!], changeSats: change, changeScriptHex: buyer.scriptHex });
      const expectedWire = operation.side === "buy" && buyQuote?.operation === "mint"
        ? { p: "crc-20", op: "mint", tick: ticker }
        : { p: "crc-20", op: "transfer", tick: ticker,
          amt: (buyQuote?.amountAtoms ?? sellQuote!.amountAtoms).toString() };
      const expectedMarker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(expectedWire))]);
      requireEqual(template.tx.outs[0]?.script.toString("hex"), expectedMarker.toString("hex"), `trade ${index} marker wire`);
      const trade = await sign(rpc, template, [vaultInput, ...(tokenInput ? [tokenInput] : []), funding], buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [trade.rawHex]), trade.txid, `trade ${index} broadcast txid`);
      const minedTrade = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [trade.txid]));
      requireEqual(minedTrade.outs[0]?.script.toString("hex"), expectedMarker.toString("hex"), `trade ${index} mined marker`);
      lastBlockHash = await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.cursor?.hash, lastBlockHash, `trade ${index} cursor`);
      requireEqual(synced.snapshot.state.assets[assetId]?.status, "live", `trade ${index} status`);
      const [tradeEvent] = await db.select({ side: schema.coveCrcEvents.tradeSide,
        atoms: schema.coveCrcEvents.tradeAtoms, grossSats: schema.coveCrcEvents.tradeGrossSats,
        confirmedTime: schema.coveCrcEvents.confirmedTime })
        .from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.txid, trade.txid)).limit(1);
      requireEqual(tradeEvent?.side, operation.side, `trade ${index} recorded side`);
      requireEqual(tradeEvent?.atoms, operation.tokens * 100_000_000n, `trade ${index} recorded amount`);
      requireEqual(tradeEvent?.grossSats, buyQuote?.grossSats ?? sellQuote!.grossSats, `trade ${index} recorded BTC value`);
      if (!tradeEvent?.confirmedTime || tradeEvent.confirmedTime <= 0n) throw new Error(`trade ${index} confirmation time missing`);
      const hydrated = await hydrateCrcLedger(db, "regtest");
      requireEqual(hydrated.state.assets[assetId]?.curve.vaultOutpoint, `${trade.txid}:${operation.side === "buy" ? 2 : 1}`, `trade ${index} vault outpoint`);
      requireEqual(hydrated.state.assets[assetId]?.curve.vaultSats, buyQuote ? curve.vaultSats + buyQuote.grossSats : curve.vaultSats - sellQuote!.grossSats, `trade ${index} reserve`);
      const expectedBalance = BigInt(asset.balances[buyer.scriptHex] ?? "0") + (operation.side === "buy" ? 1n : -1n) * operation.tokens * 100_000_000n;
      requireEqual(BigInt(hydrated.state.assets[assetId]?.balances[buyer.scriptHex] ?? "0"), expectedBalance, `trade ${index} buyer balance`);
      requireEqual(hydrated.state.assets[assetId]?.curve.circulatingAtoms, expectedBalance, `trade ${index} circulating supply`);
      const currentVault = hydrated.state.assets[assetId]!.curve;
      const [currentTxid, currentVout] = currentVault.vaultOutpoint.split(":");
      const chainVault = await rpc.call<{ value: number } | null>("gettxout", [currentTxid, Number(currentVout)]);
      requireEqual(chainVault ? Math.round(chainVault.value * 100_000_000) : null, Number(currentVault.vaultSats), `trade ${index} chain vault`);
      funding = trade.change;
    }
    {
      const transferred = await rpc.address();
      const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
        p: "crc-20", op: "transfer", tick: ticker, amt: "100000000000",
      }))]).toString("hex");
      const unrelated = await signRaw(rpc, unsigned([funding], [
        { sats: 0, scriptHex: marker }, { sats: 330, scriptHex: transferred.scriptHex },
        { sats: funding.sats - 1_330, scriptHex: buyer.scriptHex },
      ]), buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [unrelated.rawHex]), unrelated.txid, "unrelated transfer broadcast");
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.state.assets[assetId]?.balances[transferred.scriptHex] ?? "0", "0", "ordinary same-script BTC input has no token authority");
      funding = unrelated.change;

      const tamperedCoin = Object.entries(synced.snapshot.state.assets[assetId]!.tokenUtxos ?? {})
        .find(([, coin]) => coin.scriptHex === buyer.scriptHex && BigInt(coin.atoms) === 100_000_000_000n);
      if (!tamperedCoin) throw new Error("token coin missing for marker tamper test");
      const [tamperedTxid, tamperedVout] = tamperedCoin[0].split(":");
      const tamperedParent = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [tamperedTxid]));
      const tamperedOutput = tamperedParent.outs[Number(tamperedVout)];
      if (!tamperedOutput) throw new Error("tamper token parent output missing");
      const badMarker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
        p: "crc-20", op: "transfer", tick: ticker, amt: "100000000001",
      }))]).toString("hex");
      const invalidTransfer = await signRaw(rpc, unsigned([
        { txid: tamperedTxid!, vout: Number(tamperedVout), sats: tamperedOutput.value, scriptHex: buyer.scriptHex }, funding,
      ], [
        { sats: 0, scriptHex: badMarker }, { sats: tamperedOutput.value, scriptHex: transferred.scriptHex },
        { sats: funding.sats - 1_000, scriptHex: buyer.scriptHex },
      ]), buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [invalidTransfer.rawHex]), invalidTransfer.txid, "tampered marker broadcast");
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[tamperedCoin[0]], undefined, "tampered token outpoint removed");
      requireEqual(synced.snapshot.state.assets[assetId]?.burnedAtoms, "100000000000", "tampered token amount burned");
      requireEqual(synced.snapshot.state.assets[assetId]?.balances[transferred.scriptHex] ?? "0", "0", "tampered marker cannot mint recipient balance");
      funding = invalidTransfer.change;

      const beforeWithdrawal = Object.entries(synced.snapshot.state.assets[assetId]!.tokenUtxos ?? {})
        .find(([, coin]) => coin.scriptHex === buyer.scriptHex && BigInt(coin.atoms) === 100_000_000_000n);
      if (!beforeWithdrawal) throw new Error("seller token coin missing before withdrawal race");
      const [listedTxidBefore, listedVoutBefore] = beforeWithdrawal[0].split(":");
      const tokenParent = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [listedTxidBefore]));
      const tokenOutput = tokenParent.outs[Number(listedVoutBefore)];
      if (!tokenOutput) throw new Error("withdrawal token parent output missing");
      const oldListedInput: CoveTokenInput & Funding = { txid: listedTxidBefore!, vout: Number(listedVoutBefore),
        sats: tokenOutput.value, valueSats: tokenOutput.value, scriptHex: buyer.scriptHex,
        tokenAtoms: BigInt(beforeWithdrawal[1].atoms), tokenDeploymentTxid: deploy.txid };
      const splitFunding = await signRaw(rpc, unsigned([funding], [
        { sats: 20_000, scriptHex: buyer.scriptHex },
        { sats: funding.sats - 21_000, scriptHex: buyer.scriptHex },
      ]), buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [splitFunding.rawHex]), splitFunding.txid, "split independent sale funding");
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      const saleFunding: Funding = { txid: splitFunding.txid, vout: 0, sats: 20_000, scriptHex: buyer.scriptHex };
      funding = splitFunding.change;
      const withdrawnBuyer = await rpc.address("bech32");
      const staleSaleTemplate = buildCoveV3MarketFill({ ticker, deploymentTxid: deploy.txid,
        listedInput: oldListedInput, buyerScriptHex: withdrawnBuyer.scriptHex, recipientSats: 600,
        sellerNetPriceSats: 2_000, protocolScriptHex: protocol.scriptHex, protocolFeeSats: 1_000,
        buyerChangeSats: saleFunding.sats - 4_330 });
      const staleSale = await sign(rpc, staleSaleTemplate, [oldListedInput, saleFunding], withdrawnBuyer.scriptHex);
      const withdrawalTemplate = buildCoveV3Transfer({ ticker, deploymentTxid: deploy.txid,
        amountAtoms: oldListedInput.tokenAtoms, tokenInputs: [oldListedInput],
        recipientScriptHex: withdrawnBuyer.scriptHex, recipientSats: 600,
        btcChangeSats: funding.sats - 1_000, btcChangeScriptHex: buyer.scriptHex });
      const withdrawal = await sign(rpc, withdrawalTemplate, [oldListedInput, funding], buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [withdrawal.rawHex]), withdrawal.txid, "token withdrawal broadcast");
      let staleSaleRejected = false;
      try { await rpc.call<string>("sendrawtransaction", [staleSale.rawHex]); } catch { staleSaleRejected = true; }
      requireEqual(staleSaleRejected, true, "sale after token withdrawal must conflict at Bitcoin UTXO level");
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${withdrawal.txid}:1`]?.atoms,
        "100000000000", "withdrawn token remains with seller");
      requireEqual(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${withdrawal.txid}:1`]?.scriptHex,
        withdrawnBuyer.scriptHex, "nested SegWit wallet owns withdrawn token");
      requireEqual(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[beforeWithdrawal[0]], undefined,
        "old listed token outpoint is gone");
      funding = withdrawal.change;

      const live = synced.snapshot.state.assets[assetId]!;
      const [vaultTxid, vaultVoutText] = live.curve.vaultOutpoint.split(":");
      const brokenVault = await signRaw(rpc, unsigned([
        { txid: vaultTxid!, vout: Number(vaultVoutText), sats: Number(live.curve.vaultSats), scriptHex: vault.scriptHex }, funding,
      ], [
        { sats: Number(live.curve.vaultSats), scriptHex: buyer.scriptHex },
        { sats: funding.sats - 1_000, scriptHex: buyer.scriptHex },
      ]), buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [brokenVault.rawHex]), brokenVault.txid, "invalid vault spend broadcast");
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.state.assets[assetId]?.status, "broken", "backing unavailable after vault spend");
      funding = brokenVault.change;

      const listed = Object.entries(synced.snapshot.state.assets[assetId]!.tokenUtxos ?? {})
        .find(([, coin]) => coin.scriptHex === withdrawnBuyer.scriptHex && BigInt(coin.atoms) === 100_000_000_000n);
      if (!listed) throw new Error("market listing token outpoint missing after vault failure");
      const [listedTxid, listedVout] = listed[0].split(":");
      const parent = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [listedTxid]));
      const listedOutput = parent.outs[Number(listedVout)];
      if (!listedOutput) throw new Error("market token parent output missing");
      const listedInput: CoveTokenInput & Funding = { txid: listedTxid!, vout: Number(listedVout),
        sats: listedOutput.value, valueSats: listedOutput.value, scriptHex: withdrawnBuyer.scriptHex,
        tokenAtoms: BigInt(listed[1].atoms), tokenDeploymentTxid: deploy.txid };
      const keys = ECPairFactory(ecc);
      const marketBuyerKey = keys.fromPrivateKey(Buffer.alloc(32, 0x63));
      const rivalBuyerKey = keys.fromPrivateKey(Buffer.alloc(32, 0x64));
      const marketBuyerScript = bitcoin.payments.p2wpkh({ pubkey: marketBuyerKey.publicKey,
        network: bitcoin.networks.regtest }).output!.toString("hex");
      const rivalBuyerScript = bitcoin.payments.p2wpkh({ pubkey: rivalBuyerKey.publicKey,
        network: bitcoin.networks.regtest }).output!.toString("hex");
      await rpc.call("lockunspent", [false, [{ txid: listedInput.txid, vout: listedInput.vout }]], true);
      const buyerCoins: { txid: string; vout: number; valueSats: number; scriptHex: string; tokenAtoms: bigint }[] = [];
      for (const scriptHex of [marketBuyerScript, rivalBuyerScript]) {
        const address = bitcoin.address.fromOutputScript(Buffer.from(scriptHex, "hex"), bitcoin.networks.regtest);
        const txid = await rpc.call<string>("sendtoaddress", [address, 0.0002], true);
        const parent = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [txid]));
        const vout = parent.outs.findIndex((output) => output.script.toString("hex") === scriptHex && output.value === 20_000);
        if (vout < 0) throw new Error("independent buyer funding output missing");
        buyerCoins.push({ txid, vout, valueSats: 20_000, scriptHex, tokenAtoms: 0n });
      }
      await rpc.call("lockunspent", [true, [{ txid: listedInput.txid, vout: listedInput.vout }]], true);
      await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      const currentHeight = BigInt((await provider.getBlockchainInfo()).blocks);
      const listing = { id: randomBytes(16).toString("hex"), network: "regtest" as const,
        deployTxid: deploy.txid, ticker, sellerScriptHex: withdrawnBuyer.scriptHex,
        sellerPayoutScriptHex: withdrawnBuyer.scriptHex, sellerAnchorTxid: listedInput.txid,
        sellerAnchorVout: listedInput.vout, sellerAnchorSats: listedInput.valueSats,
        amountAtoms: listedInput.tokenAtoms, priceSats: 2_000, protocolFeeSats: 1_000,
        expiresAtHeight: currentHeight + 12n };
      const sellerListing = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
      sellerListing.setVersion(2);
      sellerListing.addInput({ hash: listedInput.txid, index: listedInput.vout,
        sequence: 0xffffffff, witnessUtxo: { script: Buffer.from(listedInput.scriptHex, "hex"),
          value: listedInput.valueSats }, sighashType: SIGHASH_SINGLE_ANYONECANPAY });
      sellerListing.addOutput({ script: Buffer.from(withdrawnBuyer.scriptHex, "hex"),
        value: listedInput.valueSats + listing.priceSats });
      const presigned = await rpc.call<{ psbt: string }>("walletprocesspsbt",
        [sellerListing.toBase64(), true, "SINGLE|ANYONECANPAY", true, false], true);
      const sellerSigned = bitcoin.Psbt.fromBase64(presigned.psbt, { network: bitcoin.networks.regtest });
      if (!checkListingSignature(sellerSigned, 0).ok || sellerSigned.data.inputs[0]!.partialSig?.length !== 1) {
        throw new Error("seller did not presign the fixed payout");
      }
      const sellerSignature = sellerSigned.data.inputs[0]!.partialSig!;
      const makeSale = (buyerScriptHex: string, buyerCoin: typeof buyerCoins[number], buyerKey: typeof marketBuyerKey) => {
        const template = buildCoveV3MarketFill({ ticker, deploymentTxid: deploy.txid, listedInput,
          buyerScriptHex, recipientSats: 330, sellerNetPriceSats: listing.priceSats,
          protocolScriptHex: protocol.scriptHex, protocolFeeSats: listing.protocolFeeSats,
          buyerChangeSats: 15_670, buyerChangeScriptHex: buyerScriptHex });
        const psbt = buildUnsignedPsbt(template, [listedInput, buyerCoin], 1_000, bitcoin.networks.regtest);
        psbt.data.inputs[0]!.sighashType = SIGHASH_SINGLE_ANYONECANPAY;
        psbt.updateInput(0, { partialSig: sellerSignature });
        psbt.signInput(1, buyerKey);
        if (!checkListingSignature(psbt, 0).ok || !checkSpendSignature(psbt, 1).ok) {
          throw new Error("independent seller or buyer signature is invalid");
        }
        psbt.finalizeAllInputs();
        const tx = psbt.extractTransaction();
        return { txid: tx.getId(), rawHex: tx.toHex() };
      };
      const sale = makeSale(marketBuyerScript, buyerCoins[0]!, marketBuyerKey);
      const rival = makeSale(rivalBuyerScript, buyerCoins[1]!, rivalBuyerKey);
      const saleTemplate = buildCoveV3MarketFill({ ticker, deploymentTxid: deploy.txid, listedInput,
        buyerScriptHex: marketBuyerScript, recipientSats: 330, sellerNetPriceSats: 2_000,
        protocolScriptHex: protocol.scriptHex, protocolFeeSats: 1_000, buyerChangeSats: 15_670 });
      const saleMarker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
        p: "crc-20", op: "transfer", tick: ticker, amt: listedInput.tokenAtoms.toString(),
      }))]);
      requireEqual(saleTemplate.tx.outs[0]?.script.toString("hex"), withdrawnBuyer.scriptHex, "market seller payout vout0");
      requireEqual(saleTemplate.tx.outs[0]?.value, listedInput.valueSats + 2_000, "market seller payout value");
      requireEqual(saleTemplate.tx.outs[1]?.script.toString("hex"), saleMarker.toString("hex"), "market marker vout1");
      requireEqual(saleTemplate.tx.outs[2]?.script.toString("hex"), marketBuyerScript, "market buyer carrier vout2");
      requireEqual(saleTemplate.tx.outs[2]?.value, 330, "market buyer carrier value");
      requireEqual(saleTemplate.tx.outs[3]?.value, 1_000, "market protocol fee value");
      requireEqual(await rpc.call<string>("sendrawtransaction", [sale.rawHex]), sale.txid, "market fill broadcast");
      let conflictingFillRejected = false;
      try { await rpc.call<string>("sendrawtransaction", [rival.rawHex]); } catch { conflictingFillRejected = true; }
      requireEqual(conflictingFillRejected, true, "competing fill must conflict at Bitcoin UTXO level");
      previousSnapshot = synced.snapshot;
      lastBlockHash = await mine(rpc, miner.address);
      const minedSale = bitcoin.Transaction.fromHex(await rpc.call<string>("getrawtransaction", [sale.txid]));
      requireEqual(minedSale.outs[0]?.script.toString("hex"), withdrawnBuyer.scriptHex, "mined market seller payout vout0");
      requireEqual(minedSale.outs[0]?.value, listedInput.valueSats + 2_000, "mined market seller payout value");
      requireEqual(minedSale.outs[1]?.script.toString("hex"), saleMarker.toString("hex"), "mined market marker vout1");
      requireEqual(minedSale.outs[2]?.script.toString("hex"), marketBuyerScript, "mined market buyer carrier vout2");
      requireEqual(minedSale.outs[2]?.value, 330, "mined market buyer carrier value");
      requireEqual(minedSale.outs[3]?.value, 1_000, "mined market protocol fee value");
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.state.assets[assetId]?.balances[marketBuyerScript], "100000000000", "market buyer credited after vault break");
      requireEqual(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${sale.txid}:2`]?.atoms, "100000000000", "market token UTXO indexed");
    }
    const eventCountBeforeReorg = (await db.select().from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, "regtest"))).length;
    await rpc.call("invalidateblock", [lastBlockHash]);
    const alternative = await rpc.call<{ hash: string }>("generateblock", [miner.address, []]);
    const recovered = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
    requireEqual(recovered.rolledBack, 1, "reorg rollback count");
    requireEqual(recovered.snapshot.cursor?.hash, alternative.hash, "reorg replacement cursor");
    requireEqual(recovered.snapshot.state.assets[assetId]?.curve.vaultOutpoint, previousSnapshot!.state.assets[assetId]?.curve.vaultOutpoint, "reorg restored vault");
    requireEqual((await hydrateCrcLedger(db, "regtest")).state.assets[assetId]?.curve.vaultOutpoint, previousSnapshot!.state.assets[assetId]?.curve.vaultOutpoint, "persisted reorg restored vault");
    if (!isDeepStrictEqual(recovered.snapshot.projection, previousSnapshot!.projection)) throw new Error("reorg did not restore the prior CRC projection");
    requireEqual((await db.select().from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, "regtest"))).length, eventCountBeforeReorg - 1, "reorg CRC event count");
    console.log(JSON.stringify({ ok: true, version: 3, ticker, deployTxid: deploy.txid,
      trades: operations.length, adversarial: ["ordinary-utxo", "marker-tamper", "withdrawal-conflict", "presigned-two-account-fill", "broken-vault-fill", "competing-fill"],
      reorgRollback: recovered.rolledBack, cursor: recovered.snapshot.cursor?.height }));
    await clean(db);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
