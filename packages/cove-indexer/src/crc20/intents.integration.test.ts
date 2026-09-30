import * as bitcoin from "bitcoinjs-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@crclaunch/db";
import { createCoveLedger } from "@crclaunch/crc20-ledger/cove-replay";
import { loadAuthorizedCrcRegistrations, saveAuthorizedCrcLaunchIntent } from "./intents.js";
import { replayCrcBlock } from "./worker.js";
import { migrateCrcTestDb } from "./test-migration.js";

const url = process.env.CRC_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const network = "mainnet";
const script = (byte: string) => `5120${byte.repeat(64)}`;
const trusted = { launchSaltHex: "aa".repeat(32), vaultScriptHex: script("1"), creatorScriptHex: script("2"), protocolScriptHex: script("3"), vaultAnchorSats: 330 };

function rawDeploy(change: number, parentTxid = "44".repeat(32)) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(parentTxid, "hex").reverse(), 0);
  tx.ins[0]!.witness = [Buffer.from("55".repeat(64), "hex")];
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }))]);
  tx.addOutput(marker, 0);
  tx.addOutput(Buffer.from(trusted.vaultScriptHex, "hex"), 330);
  tx.addOutput(Buffer.from(trusted.creatorScriptHex, "hex"), 1000);
  tx.addOutput(Buffer.from(trusted.protocolScriptHex, "hex"), 7000);
  tx.addOutput(Buffer.from(script("4"), "hex"), change);
  return tx;
}

describe.skipIf(!isolated)("durable CRC launch intent", () => {
  beforeAll(async () => migrateCrcTestDb(pool!, db!));
  afterAll(async () => {
    if (db) await db.delete(schema.coveCrcLaunchIntents).where(eq(schema.coveCrcLaunchIntents.network, network));
    await pool?.end();
  });

  it("survives pre-broadcast retry, rejects salt reuse, and only activates matching confirmed raw deploy", async () => {
    const parent = new bitcoin.Transaction(); parent.version = 2; parent.addInput(Buffer.alloc(32), 0xffffffff); parent.addOutput(Buffer.from(script("4"), "hex"), 10_000);
    const tx = rawDeploy(1670, parent.getId());
    const intent = await saveAuthorizedCrcLaunchIntent(db!, network, tx.toHex(), trusted);
    expect((await saveAuthorizedCrcLaunchIntent(db!, network, tx.toHex(), trusted)).txid).toBe(intent.txid);
    await expect(saveAuthorizedCrcLaunchIntent(db!, network, rawDeploy(1671).toHex(), trusted)).rejects.toThrow();
    await expect(loadAuthorizedCrcRegistrations(db!, network, script("5"))).rejects.toThrow();
    const registrations = await loadAuthorizedCrcRegistrations(db!, network, trusted.protocolScriptHex);
    expect(registrations).toHaveLength(1);
    const matching = await replayCrcBlock(createCoveLedger(), { network, height: 100, hash: "ab".repeat(32), parentHash: "00".repeat(32), rawTxs: [parent.toHex(), tx.toHex()] }, registrations, { getRawTransaction: async () => parent.toHex() });
    expect(matching.state.assets[`mainnet:${intent.txid}`]?.status).toBe("live");
    const changedWitness = bitcoin.Transaction.fromHex(tx.toHex());
    changedWitness.ins[0]!.witness = [Buffer.from("66".repeat(64), "hex")];
    expect(changedWitness.getId()).toBe(tx.getId());
    const mismatched = await replayCrcBlock(createCoveLedger(), { network, height: 100, hash: "ab".repeat(32), parentHash: "00".repeat(32), rawTxs: [parent.toHex(), changedWitness.toHex()] }, registrations, { getRawTransaction: async () => parent.toHex() });
    expect(mismatched.state.assets[`mainnet:${intent.txid}`]).toBeUndefined();
    const unrelated = rawDeploy(1672);
    const ignored = await replayCrcBlock(createCoveLedger(), { network, height: 100, hash: "ab".repeat(32), parentHash: "00".repeat(32), rawTxs: [unrelated.toHex()] }, registrations, { getRawTransaction: async () => { throw new Error("should not fetch"); } });
    expect(ignored.state.assets).toEqual({});
  });
});
