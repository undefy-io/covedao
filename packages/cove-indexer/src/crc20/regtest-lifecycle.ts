import * as bitcoin from "bitcoinjs-lib";
import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { buildCurveBuy, buildCurveDeploy, buildCurveSell, type TxTemplate } from "@crclaunch/crc20-transactions";
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

  async address(): Promise<{ address: string; scriptHex: string }> {
    const address = await this.call<string>("getnewaddress", ["", "bech32m"], true);
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
  const result = await rpc.call<{ hex: string; complete: boolean; errors?: unknown[] }>("signrawtransactionwithwallet", [unsigned.toHex()], true);
  if (!result.complete) throw new Error(`Core did not sign all inputs: ${JSON.stringify(result.errors ?? [])}`);
  const signed = bitcoin.Transaction.fromHex(result.hex);
  const vout = signed.outs.findIndex((output, index) => index === signed.outs.length - 1 && output.script.toString("hex") === changeScriptHex);
  if (vout < 0) throw new Error("signed transaction lacks expected change output");
  return { txid: signed.getId(), rawHex: result.hex, change: { txid: signed.getId(), vout, sats: signed.outs[vout]!.value, scriptHex: changeScriptHex } };
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
    const deploy = await sign(rpc, buildCurveDeploy({ ticker, maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330, changeSats: funding.sats - 8_330 - 1_000, changeScriptHex: buyer.scriptHex }), [funding], buyer.scriptHex);
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
      const fixedOutputs = buyQuote
        ? 330n + curve.vaultSats + buyQuote.grossSats + buyQuote.protocolFeeSats + buyQuote.creatorFeeSats
        : curve.vaultSats - sellQuote!.grossSats + sellQuote!.sellerPayoutSats + sellQuote!.protocolFeeSats;
      const change = Number(curve.vaultSats + BigInt(funding.sats) - fixedOutputs - 1_000n);
      if (change < 330) throw new Error("regtest funding change below dust");
      const template = operation.side === "buy"
        ? buildCurveBuy({ ticker, deploymentTxid: deploy.txid, state: curve, amountTokens: operation.tokens, scripts, recipientSats: 330, changeSats: change, changeScriptHex: buyer.scriptHex })
        : buildCurveSell({ ticker, deploymentTxid: deploy.txid, state: curve, amountTokens: operation.tokens, scripts, changeSats: change, changeScriptHex: buyer.scriptHex });
      const [vaultTxid, vaultVoutText] = curve.vaultOutpoint.split(":");
      const trade = await sign(rpc, template, [
        { txid: vaultTxid!, vout: Number(vaultVoutText), sats: Number(curve.vaultSats), scriptHex: vault.scriptHex }, funding,
      ], buyer.scriptHex);
      requireEqual(await rpc.call<string>("sendrawtransaction", [trade.rawHex]), trade.txid, `trade ${index} broadcast txid`);
      lastBlockHash = await mine(rpc, miner.address);
      synced = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
      requireEqual(synced.snapshot.cursor?.hash, lastBlockHash, `trade ${index} cursor`);
      requireEqual(synced.snapshot.state.assets[assetId]?.status, "live", `trade ${index} status`);
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
    requireEqual((await db.select().from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, "regtest"))).length, 7, "confirmed CRC event count");
    await rpc.call("invalidateblock", [lastBlockHash]);
    const alternative = await rpc.call<{ hash: string }>("generateblock", [miner.address, []]);
    const recovered = await syncCrcTip({ db, provider, network: "regtest", activationHeight, protocolScriptHex: protocol.scriptHex, snapshot: synced.snapshot });
    requireEqual(recovered.rolledBack, 1, "reorg rollback count");
    requireEqual(recovered.snapshot.cursor?.hash, alternative.hash, "reorg replacement cursor");
    requireEqual(recovered.snapshot.state.assets[assetId]?.curve.vaultOutpoint, previousSnapshot!.state.assets[assetId]?.curve.vaultOutpoint, "reorg restored vault");
    requireEqual((await hydrateCrcLedger(db, "regtest")).state.assets[assetId]?.curve.vaultOutpoint, previousSnapshot!.state.assets[assetId]?.curve.vaultOutpoint, "persisted reorg restored vault");
    if (!isDeepStrictEqual(recovered.snapshot.projection, previousSnapshot!.projection)) throw new Error("reorg did not restore the prior CRC projection");
    requireEqual((await db.select().from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, "regtest"))).length, 6, "reorg CRC event count");
    console.log(JSON.stringify({ ok: true, ticker, deployTxid: deploy.txid, trades: operations.length, reorgRollback: recovered.rolledBack, cursor: recovered.snapshot.cursor?.height }));
    await clean(db);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
