import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import { initializeCrcLedger, loadCrcCoreLedger } from "@crclaunch/crc20-state";
import { isolatedDatabase } from "./test-support/database.js";
let owned: Awaited<ReturnType<typeof isolatedDatabase>>;
beforeAll(async () => { owned = await isolatedDatabase(); }, 60_000);
afterAll(async () => { if (owned) await owned.close(); }, 30_000);
test("fresh bootstrap removes superseded CRC tables and explicit reset preserves shared state", async () => {
  const legacy = await owned.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'cove_crc_%'");
  expect(legacy.rows).toEqual([]);
  const config = { network: "regtest", ticker: "TEST", vaultScriptHex: `0014${"11".repeat(20)}`, creatorScriptHex: `0014${"22".repeat(20)}`, protocolScriptHex: `0014${"33".repeat(20)}` };
  await initializeCrcLedger(owned.db, config, { activationHeight: 1 });
  const shared = (await owned.pool.query("insert into cove_v3_runtime(network) values ('regtest') returning *")).rows;
  await owned.pool.query("insert into crc_records(network,kind,key,value_json) values('regtest','seen','old-receipt','true')");
  const reset = readFileSync(new URL("../../../db/drizzle/0041_crc_fresh_reset.sql", import.meta.url), "utf8");
  await owned.pool.query("begin");
  try {
    for (const statement of reset.split("--> statement-breakpoint")) if (statement.trim()) await owned.pool.query(statement);
    await owned.pool.query("commit");
  } catch (error) { await owned.pool.query("rollback"); throw error; }
  const tables = (await owned.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'crc_%'")).rows;
  expect(tables.length).toBeGreaterThanOrEqual(12);
  for (const { tablename } of tables) expect((await owned.pool.query(`select count(*)::int count from ${tablename}`)).rows[0].count, tablename).toBe(0);
  expect((await owned.pool.query("select * from cove_v3_runtime where network='regtest'")).rows).toEqual(shared);
  expect(await loadCrcCoreLedger(owned.db, "regtest")).toBeNull();
  await initializeCrcLedger(owned.db, config, { activationHeight: 1 });
  expect(await loadCrcCoreLedger(owned.db, "regtest")).toEqual(core.emptyLedger(config));
});
