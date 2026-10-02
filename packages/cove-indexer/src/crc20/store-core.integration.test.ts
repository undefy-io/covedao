import { beforeAll, afterAll, test, expect } from "vitest";
import { sql } from "drizzle-orm";
import * as core from "@crclaunch/crc20-protocol";
import * as store from "./store.js";
import { isolatedDatabase } from "./test-support/database.js";
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: `0014${"11".repeat(20)}`,
  creatorScriptHex: `0014${"22".repeat(20)}`,
  protocolScriptHex: `0014${"33".repeat(20)}`,
};
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
beforeAll(async () => {
  fixture = await isolatedDatabase();
}, 60000);
afterAll(async () => {
  if (fixture) await fixture.close();
}, 30000);
const hash = (n: number) => n.toString(16).padStart(64, "0");
test("database empty-block commit, idempotence and restart equal exact core state", async () => {
  await store.initializeCrcLedger(fixture.db, config, { activationHeight: 1 });
  const before = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  expect(before).toEqual(core.emptyLedger(config));
  const block = { height: 1, hash: hash(1), parentHash: hash(0), transactions: [] };
  const result = await store.persistCrcCoreBlock(fixture.db, "regtest", block, {});
  expect(result.changed).toBe(true);
  expect(result.state).toEqual(core.applyConfirmedBlock(before, block));
  expect((await store.persistCrcCoreBlock(fixture.db, "regtest", block, {})).changed).toBe(false);
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(result.state);
  expect(await store.rollbackCrcCoreTip(fixture.db, "regtest")).toBe(true);
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(before);
});
test("rejected database write leaves cursor, state and undo unchanged", async () => {
  const before = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  await fixture.db.execute(
    sql.raw(
      "CREATE FUNCTION crc_fail_cursor_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cursor failure'; END; $$",
    ),
  );
  await fixture.db.execute(
    sql.raw(
      "CREATE TRIGGER crc_fail_cursor BEFORE INSERT OR UPDATE ON crc_cursors FOR EACH ROW EXECUTE FUNCTION crc_fail_cursor_write()",
    ),
  );
  try {
    await expect(
      store.persistCrcCoreBlock(
        fixture.db,
        "regtest",
        { height: 1, hash: hash(2), parentHash: hash(0), transactions: [] },
        {},
      ),
    ).rejects.toThrow();
  } finally {
    await fixture.db.execute(sql.raw("DROP TRIGGER crc_fail_cursor ON crc_cursors"));
    await fixture.db.execute(sql.raw("DROP FUNCTION crc_fail_cursor_write()"));
  }
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(before);
});
test("bounded undo and checkpoint restore persist across database restart", async () => {
  let state = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  for (let height = 1; height <= 6; height++) {
    const block = {
      height,
      hash: hash(height + 10),
      parentHash: state.tip?.hash ?? hash(0),
      transactions: [],
    };
    state = (
      await store.persistCrcCoreBlock(
        fixture.db,
        "regtest",
        block,
        {},
        { undoLimit: 2, checkpointInterval: 2, checkpointLimit: 2 },
      )
    ).state;
  }
  expect(Object.keys((await store.loadCrcCoreLedger(fixture.db, "regtest"))!.history)).toHaveLength(
    2,
  );
  const result = await fixture.pool.query(
    "select count(*)::int count from crc_undo where network='regtest'",
  );
  expect(result.rows[0].count).toBe(2);
  expect(await store.restoreCrcCheckpoint(fixture.db, "regtest", 4)).toBe(true);
  expect((await store.loadCrcCoreLedger(fixture.db, "regtest"))!.tip!.height).toBe(4);
});
test("invalid deployment registration is rejected without persisting", async () => {
  await expect(
    store.saveCrcRegistration(fixture.db, config, { rawHex: "00", prevouts: [] }),
  ).rejects.toThrow();
  expect(await store.loadCrcRegistrations(fixture.db, "regtest")).toEqual({});
});
