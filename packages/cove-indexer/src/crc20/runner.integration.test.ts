import * as bitcoin from "bitcoinjs-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@crclaunch/db";
import { saveAuthorizedCrcLaunchIntent } from "./intents.js";
import { syncCrcTip } from "./runner.js";
import { migrateCrcTestDb } from "./test-migration.js";

const url = process.env.CRC_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const network = "signet";
const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1"), creator = script("2"), protocol = script("3"), buyer = script("4");
const parentHash = "00".repeat(32), hashA = "aa".repeat(32), hashB = "bb".repeat(32);

function fixture(vaultScript = vault, fundingSats = 10_000) {
  const fund = new bitcoin.Transaction(); fund.version = 2; fund.addInput(Buffer.alloc(32), 0xffffffff); fund.addOutput(Buffer.from(buyer, "hex"), fundingSats);
  const deploy = new bitcoin.Transaction(); deploy.version = 2; deploy.addInput(Buffer.from(fund.getId(), "hex").reverse(), 0);
  deploy.ins[0]!.witness = [Buffer.from("55".repeat(64), "hex")];
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }))]);
  deploy.addOutput(marker, 0); deploy.addOutput(Buffer.from(vaultScript, "hex"), 330); deploy.addOutput(Buffer.from(creator, "hex"), 1000); deploy.addOutput(Buffer.from(protocol, "hex"), 7000); deploy.addOutput(Buffer.from(buyer, "hex"), fundingSats - 8330);
  return { fund, deploy };
}

describe.skipIf(!isolated)("CRC worker canonical chain loop", () => {
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

  it("pauses with no intent, then deploys, rolls back same-height reorg and replays once", async () => {
    const { fund, deploy } = fixture();
    let tip = hashA;
    const provider = {
      getBlockchainInfo: async () => ({ chain: "signet", blocks: 100, bestBlockHash: tip }),
      getBlockHash: async (height: number) => height === 99 ? parentHash : tip,
      getBlock: async (hash: string) => ({ hash, height: 100, previousBlockHash: parentHash, txids: hash === hashA ? [fund.getId(), deploy.getId()] : [], rawTxs: hash === hashA ? [fund.toHex(), deploy.toHex()] : [] }),
      getRawTransaction: async () => { throw new Error("unexpected RPC"); },
    };
    const paused = await syncCrcTip({ db: db!, provider, network, activationHeight: 100, protocolScriptHex: protocol });
    expect(paused).toMatchObject({ paused: true, indexed: 0 });
    expect(paused.snapshot.cursor).toBeNull();
    await saveAuthorizedCrcLaunchIntent(db!, network, deploy.toHex(), { launchSaltHex: "ab".repeat(32), vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330 });
    const a = await syncCrcTip({ db: db!, provider, network, activationHeight: 100, protocolScriptHex: protocol, snapshot: paused.snapshot });
    expect(a.snapshot.state.assets[`signet:${deploy.getId()}`]?.status).toBe("live");
    expect(a.snapshot.projection.assets[`signet:${deploy.getId()}`]?.launchSaltHex).toBe("ab".repeat(32));
    tip = hashB;
    const b = await syncCrcTip({ db: db!, provider, network, activationHeight: 100, protocolScriptHex: protocol, snapshot: a.snapshot });
    expect(b).toMatchObject({ rolledBack: 1, indexed: 1 });
    expect(b.snapshot.state.assets).toEqual({});
    tip = hashA;
    const restored = await syncCrcTip({ db: db!, provider, network, activationHeight: 100, protocolScriptHex: protocol, snapshot: b.snapshot });
    expect(Object.keys(restored.snapshot.state.assets)).toEqual([`signet:${deploy.getId()}`]);
    expect(restored.snapshot.state.appliedTxids[`signet:${deploy.getId()}`]).toBe(true);

    const secondVault = script("6");
    const second = fixture(secondVault, 10_001);
    const hashC = "cc".repeat(32);
    const catchupProvider = {
      getBlockchainInfo: async () => ({ chain: "signet", blocks: 101, bestBlockHash: hashC }),
      getBlockHash: async (height: number) => height === 100 ? hashA : hashC,
      getBlock: async () => {
        await saveAuthorizedCrcLaunchIntent(db!, network, second.deploy.toHex(), { launchSaltHex: "bc".repeat(32), vaultScriptHex: secondVault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330 });
        return { hash: hashC, height: 101, previousBlockHash: hashA, txids: [second.fund.getId(), second.deploy.getId()], rawTxs: [second.fund.toHex(), second.deploy.toHex()] };
      },
      getRawTransaction: async () => { throw new Error("unexpected RPC"); },
    };
    const caught = await syncCrcTip({ db: db!, provider: catchupProvider, network, activationHeight: 100, protocolScriptHex: protocol, snapshot: restored.snapshot });
    expect(Object.keys(caught.snapshot.state.assets)).toHaveLength(2);
    expect(caught.snapshot.state.assets[`signet:${second.deploy.getId()}`]?.status).toBe("live");
  });
});
