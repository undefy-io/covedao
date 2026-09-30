import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@crclaunch/db";
import { createCoveLedger } from "@crclaunch/crc20-ledger/cove-replay";
import { hydrateCrcLedger, persistConfirmedCrcBlock } from "./worker.js";
import { migrateCrcTestDb } from "./test-migration.js";
import { saveAuthorizedCrcLaunchIntent } from "./intents.js";

const url = process.env.CRC_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const network = "testnet";
const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1"), creator = script("2"), protocol = script("3"), buyer = script("4");
const blank = { assets: {}, vaults: {}, balances: {} };

function tx(input: { txid: string; vout: number } | null, outputs: { scriptHex: string; valueSats: number }[]) {
  const transaction = new bitcoin.Transaction();
  transaction.version = 2;
  transaction.addInput(input ? Buffer.from(input.txid, "hex").reverse() : Buffer.alloc(32), input?.vout ?? 0xffffffff);
  for (const output of outputs) transaction.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { rawHex: transaction.toHex(), txid: transaction.getId() };
}

describe.skipIf(!isolated)("confirmed CRC replay with persistent PostgreSQL projection", () => {
  beforeAll(async () => migrateCrcTestDb(pool!, db!));
  afterAll(async () => {
    if (db) {
      await db.delete(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, network));
      await db.delete(schema.coveCrcUndo).where(eq(schema.coveCrcUndo.network, network));
      await db.delete(schema.coveCrcBlocks).where(eq(schema.coveCrcBlocks.network, network));
      await db.delete(schema.coveCrcBalances).where(eq(schema.coveCrcBalances.network, network));
      await db.delete(schema.coveCrcVaults).where(eq(schema.coveCrcVaults.network, network));
      await db.delete(schema.coveCrcAssets).where(eq(schema.coveCrcAssets.network, network));
      await db.delete(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network));
      await db.delete(schema.coveCrcLaunchIntents).where(eq(schema.coveCrcLaunchIntents.network, network));
    }
    await pool?.end();
  });

  it("keeps an active asset through an ordinary block and mint with no new registrations, then rejects unavailable parents", async () => {
    const funding = tx(null, [{ scriptHex: buyer, valueSats: 10_000 }]);
    const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }))]).toString("hex");
    const deploy = tx({ txid: funding.txid, vout: 0 }, [
      { scriptHex: marker, valueSats: 0 }, { scriptHex: vault, valueSats: 330 },
      { scriptHex: creator, valueSats: 1000 }, { scriptHex: protocol, valueSats: 7000 }, { scriptHex: buyer, valueSats: 1670 },
    ]);
    const signed = bitcoin.Transaction.fromHex(deploy.rawHex);
    signed.ins[0]!.witness = [Buffer.from("55".repeat(64), "hex")];
    const registration = { network: "testnet" as const, txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: createHash("sha256").update(Buffer.from(signed.toHex(), "hex")).digest("hex") };
    await saveAuthorizedCrcLaunchIntent(db!, "testnet", signed.toHex(), registration);
    const block = { network: "testnet" as const, height: 100, hash: "aa".repeat(32), parentHash: "00".repeat(32), rawTxs: [funding.rawHex, signed.toHex()] };
    const state = await persistConfirmedCrcBlock(db!, createCoveLedger(), blank, block, [registration], { getRawTransaction: async () => { throw new Error("unexpected RPC"); } });
    const restored = await hydrateCrcLedger(db!, "testnet");
    expect(restored.state.assets[`testnet:${deploy.txid}`]?.curve).toEqual(state.assets[`testnet:${deploy.txid}`]?.curve);
    expect(restored.state.appliedTxids[`testnet:${deploy.txid}`]).toBe(true);
    expect(restored.state.lastPosition.testnet).toEqual({ height: 100, index: 1 });
    expect(restored.cursor).toMatchObject({ height: 100, hash: block.hash });
    const ordinary = await persistConfirmedCrcBlock(db!, restored.state, restored.projection, {
      network: "testnet", height: 101, hash: "bb".repeat(32), parentHash: block.hash, rawTxs: [],
    }, [], { getRawTransaction: async () => { throw new Error("unexpected RPC"); } });
    expect(ordinary.assets[`testnet:${deploy.txid}`]?.status).toBe("live");
    const afterOrdinary = await hydrateCrcLedger(db!, "testnet");
    expect(afterOrdinary.cursor?.height).toBe(101);
    const buyFunding = tx(null, [{ scriptHex: buyer, valueSats: 10_000 }]);
    const buy = new bitcoin.Transaction();
    buy.version = 2;
    buy.addInput(Buffer.from(deploy.txid, "hex").reverse(), 1);
    buy.addInput(Buffer.from(buyFunding.txid, "hex").reverse(), 0);
    buy.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000", id: deploy.txid }))]), 0);
    for (const output of [
      { scriptHex: buyer, valueSats: 330 }, { scriptHex: vault, valueSats: 357 },
      { scriptHex: protocol, valueSats: 5013 }, { scriptHex: creator, valueSats: 546 },
      { scriptHex: buyer, valueSats: 3084 },
    ]) buy.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
    const afterBuy = await persistConfirmedCrcBlock(db!, afterOrdinary.state, afterOrdinary.projection, {
      network: "testnet", height: 102, hash: "dd".repeat(32), parentHash: "bb".repeat(32), rawTxs: [buyFunding.rawHex, buy.toHex()],
    }, [], { getRawTransaction: async (txid) => {
      if (txid === deploy.txid) return signed.toHex();
      throw new Error(`unexpected RPC for ${txid}`);
    } });
    expect(afterBuy.assets[`testnet:${deploy.txid}`]?.curve.circulatingAtoms).toBe(100_000_000_000n);
    expect((await hydrateCrcLedger(db!, "testnet")).cursor?.height).toBe(102);
    const bad = tx({ txid: buy.getId(), vout: 2 }, [{ scriptHex: buyer, valueSats: 357 }]);
    await expect(persistConfirmedCrcBlock(db!, afterBuy, (await hydrateCrcLedger(db!, "testnet")).projection, { network: "testnet", height: 103, hash: "cc".repeat(32), parentHash: "dd".repeat(32), rawTxs: [bad.rawHex] }, [], { getRawTransaction: async () => { throw new Error("Core unavailable"); } })).rejects.toThrow("Core unavailable");
    expect((await hydrateCrcLedger(db!, "testnet")).cursor?.height).toBe(102);
  });
});
