import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "@crclaunch/db";
import { hydrateCrcProjection, persistCrcBlock, rollbackCrcTip } from "./store.js";
import type { CrcProjection } from "./persistence.js";
import { migrateCrcTestDb } from "./test-migration.js";

const url = process.env.CRC_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const deploy = "11".repeat(32);
const hashA = "aa".repeat(32);
const hashB = "bb".repeat(32);
const hashC = "cc".repeat(32);
const assetId = `regtest:${deploy}`;
const empty: CrcProjection = { assets: {}, vaults: {}, balances: {} };
const deployed: CrcProjection = {
  assets: { [assetId]: { ticker: "COVE", deployTxid: deploy, deployHeight: 100, deployBlockHash: hashA, launchSaltHex: "ab".repeat(32), creatorScriptHex: "0014" + "22".repeat(20), protocolScriptHex: "0014" + "33".repeat(20) } },
  vaults: { [assetId]: { txid: deploy, vout: 1, scriptHex: "5120" + "44".repeat(32), btcSats: "10000", mintedAtoms: "0", inventoryAtoms: "0", availability: "active" } },
  balances: {},
};
const bought: CrcProjection = {
  assets: deployed.assets,
  vaults: { [assetId]: { ...deployed.vaults[assetId]!, txid: "55".repeat(32), btcSats: "11000", mintedAtoms: "100000000000" } },
  balances: { [assetId]: { ["0014" + "66".repeat(20)]: "100000000000" } },
};

describe.skipIf(!isolated)("CRC persistence on isolated PostgreSQL", () => {
  const network = `regtest-${randomUUID()}`;
  beforeAll(async () => migrateCrcTestDb(pool!, db!));
  afterAll(async () => pool?.end());

  it("commits deploy/buy exactly once and hydrates the same projection", async () => {
    const a = structuredClone(deployed);
    const b = structuredClone(bought);
    const old = `regtest:${deploy}`;
    const key = `${network}:${deploy}`;
    a.assets[key] = a.assets[old]!; delete a.assets[old];
    a.vaults[key] = a.vaults[old]!; delete a.vaults[old];
    b.assets[key] = b.assets[old]!; delete b.assets[old];
    b.vaults[key] = b.vaults[old]!; delete b.vaults[old];
    b.balances[key] = b.balances[old]!; delete b.balances[old];
    expect(await persistCrcBlock(db!, network, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, [])).toBe(true);
    expect(await persistCrcBlock(db!, network, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, [])).toBe(false);
    expect(await persistCrcBlock(db!, network, { height: 101, hash: hashB, parentHash: hashA }, a, b, [])).toBe(true);
    expect((await hydrateCrcProjection(db!, network)).state).toEqual(b);
    await expect(persistCrcBlock(db!, network, { height: 101, hash: hashC, parentHash: hashA }, a, b, [])).rejects.toThrow();
    expect((await hydrateCrcProjection(db!, network)).state).toEqual(b);
    await rollbackCrcTip(db!, network);
    expect((await hydrateCrcProjection(db!, network)).state).toEqual(a);
    expect(await persistCrcBlock(db!, network, { height: 101, hash: hashC, parentHash: hashA }, a, a, [])).toBe(true);
    expect((await hydrateCrcProjection(db!, network)).state).toEqual(a);
  });

  it("rolls back all rows when an event insert fails, and removes deployment on reorg", async () => {
    const isolatedNetwork = `regtest-${randomUUID()}`;
    const a = structuredClone(deployed);
    const old = `regtest:${deploy}`;
    const key = `${isolatedNetwork}:${deploy}`;
    a.assets[key] = a.assets[old]!; delete a.assets[old];
    a.vaults[key] = a.vaults[old]!; delete a.vaults[old];
    const block = { height: 100, hash: hashA, parentHash: "00".repeat(32) };
    const event = { txid: deploy, txIndex: 0, operation: "deploy" as const, status: "applied" as const, valid: true, deployTxid: deploy };
    await expect(persistCrcBlock(db!, isolatedNetwork, block, empty, a, [event, event])).rejects.toThrow();
    expect(await hydrateCrcProjection(db!, isolatedNetwork)).toMatchObject({ state: empty, cursor: null });
    expect(await persistCrcBlock(db!, isolatedNetwork, block, empty, a, [event])).toBe(true);
    expect((await hydrateCrcProjection(db!, isolatedNetwork)).state).toEqual(a);
    expect(await rollbackCrcTip(db!, isolatedNetwork)).toBe(true);
    expect(await hydrateCrcProjection(db!, isolatedNetwork)).toMatchObject({ state: empty, cursor: null });
  });

  it("isolates identical deployment IDs across networks", async () => {
    const other = `signet-${randomUUID()}`;
    const a = structuredClone(deployed);
    const old = `regtest:${deploy}`;
    const key = `${other}:${deploy}`;
    a.assets[key] = a.assets[old]!; delete a.assets[old];
    a.vaults[key] = a.vaults[old]!; delete a.vaults[old];
    await persistCrcBlock(db!, other, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, []);
    expect((await hydrateCrcProjection(db!, other)).state).toEqual(a);
    expect((await hydrateCrcProjection(db!, `regtest-${randomUUID()}`)).state).toEqual(empty);
  });

  it("hydrates one consistent generation while another connection commits blocks", async () => {
    const isolatedNetwork = `regtest-${randomUUID()}`;
    const key = `${isolatedNetwork}:${deploy}`;
    const a = structuredClone(deployed);
    a.assets[key] = a.assets[assetId]!; delete a.assets[assetId];
    a.vaults[key] = a.vaults[assetId]!; delete a.vaults[assetId];
    await persistCrcBlock(db!, isolatedNetwork, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, []);
    const writer = async () => {
      let previous = a;
      let priorHash = hashA;
      for (let height = 101; height <= 115; height++) {
        const next = structuredClone(previous);
        next.vaults[key]!.btcSats = String(10_000 + height);
        const hash = height.toString(16).padStart(64, "0");
        await persistCrcBlock(db!, isolatedNetwork, { height, hash, parentHash: priorHash }, previous, next, []);
        previous = next;
        priorHash = hash;
      }
    };
    const reader = async () => {
      for (let index = 0; index < 45; index++) {
        const hydrated = await hydrateCrcProjection(db!, isolatedNetwork);
        expect(hydrated.state.assets[key]?.deployTxid).toBe(deploy);
        expect(hydrated.cursor?.height).toBeGreaterThanOrEqual(100);
      }
    };
    await Promise.all([writer(), reader()]);
    expect((await hydrateCrcProjection(db!, isolatedNetwork)).cursor?.height).toBe(115);
  });

  it("persists v2 token coins and burn atomically through deep and same-height reorgs", async () => {
    const isolatedNetwork = `regtest-${randomUUID()}`;
    const key = `${isolatedNetwork}:${deploy}`;
    const owner = "0014" + "66".repeat(20);
    const nextOwner = "0014" + "77".repeat(20);
    const a: CrcProjection = {
      assets: { [key]: { ...deployed.assets[assetId]!, protocolVersion: 2, burnedAtoms: "0" } },
      vaults: { [key]: { ...deployed.vaults[assetId]! } },
      balances: {}, tokenUtxos: { [key]: {} },
    };
    const b = structuredClone(a);
    b.vaults[key] = { ...a.vaults[key]!, txid: "55".repeat(32), vout: 2, btcSats: "11000", mintedAtoms: "100000000000" };
    b.tokenUtxos![key] = { [`${"55".repeat(32)}:1`]: {
      scriptHex: owner, atoms: "100000000000", createdHeight: 101, createdBlockHash: hashB,
    } };
    b.balances[key] = { [owner]: "100000000000" };
    const c = structuredClone(b);
    c.tokenUtxos![key] = {
      [`${"66".repeat(32)}:1`]: { scriptHex: nextOwner, atoms: "60000000000", createdHeight: 102, createdBlockHash: hashC },
      [`${"66".repeat(32)}:2`]: { scriptHex: owner, atoms: "40000000000", createdHeight: 102, createdBlockHash: hashC },
    };
    c.balances[key] = { [owner]: "40000000000", [nextOwner]: "60000000000" };
    const d = structuredClone(c);
    delete d.tokenUtxos![key]![`${"66".repeat(32)}:2`];
    d.assets[key]!.burnedAtoms = "40000000000";
    d.balances[key] = { [nextOwner]: "60000000000" };
    const hashD = "dd".repeat(32);
    await persistCrcBlock(db!, isolatedNetwork, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, []);
    await persistCrcBlock(db!, isolatedNetwork, { height: 101, hash: hashB, parentHash: hashA }, a, b, []);
    await persistCrcBlock(db!, isolatedNetwork, { height: 102, hash: hashC, parentHash: hashB }, b, c, []);
    await persistCrcBlock(db!, isolatedNetwork, { height: 103, hash: hashD, parentHash: hashC }, c, d, []);
    expect((await hydrateCrcProjection(db!, isolatedNetwork)).state).toEqual(d);
    for (const prior of [c, b, a, empty]) {
      expect(await rollbackCrcTip(db!, isolatedNetwork)).toBe(true);
      expect((await hydrateCrcProjection(db!, isolatedNetwork)).state).toEqual(prior);
    }
    const alternate = structuredClone(b);
    const alternateHash = "ee".repeat(32);
    alternate.tokenUtxos![key] = { [`${"88".repeat(32)}:1`]: {
      scriptHex: nextOwner, atoms: "100000000000", createdHeight: 101, createdBlockHash: alternateHash,
    } };
    alternate.balances[key] = { [nextOwner]: "100000000000" };
    await persistCrcBlock(db!, isolatedNetwork, { height: 100, hash: hashA, parentHash: "00".repeat(32) }, empty, a, []);
    await persistCrcBlock(db!, isolatedNetwork, { height: 101, hash: alternateHash, parentHash: hashA }, a, alternate, []);
    expect((await hydrateCrcProjection(db!, isolatedNetwork)).state).toEqual(alternate);
  });
});
