import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PostgresRpcBudget } from "./quotas.js";
import * as schema from "./schema.js";

const name = `crc-budget-${randomUUID()}`;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeAll(async () => {
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=fixture", "postgres:16-alpine"], { stdio: "pipe" });
  const ports = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name], { encoding: "utf8" }));
  pool = new Pool({ host: "127.0.0.1", port: Number(ports["5432/tcp"][0].HostPort), user: "fixture", password: "fixture", database: "fixture", max: 12 });
  for (let attempt = 0; ; attempt++) {
    try { await pool.query("create table cove_rpc_budgets(account text primary key, state jsonb not null)"); break; }
    catch (error) { if (attempt === 100) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  db = drizzle(pool, { schema });
}, 30_000);
afterAll(async () => {
  await pool?.end();
  try { execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" }); } catch { /* Startup may have failed. */ }
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assertRate(starts: number[], rate: number) {
  for (const start of starts)
    expect(starts.filter(time => time >= start && time < start + 1000).length).toBeLessThanOrEqual(rate);
}
test("an idle lane lends quota to consecutive public requests while preserving the upstream cap", async () => {
  const budget = new PostgresRpcBudget(db, randomUUID(), "public");
  const starts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const release = await budget.acquire(AbortSignal.timeout(6000));
    starts.push(Date.now()); await release();
  }
  assertRate(starts, 3);
  expect(starts[3]! - starts[0]!).toBeLessThan(1800);
}, 10_000);
test("continuous public replicas do not starve worker or Guardian waiting for shared quota", async () => {
  const account = randomUUID(), starts: number[] = [], critical: number[] = [];
  const publicBudgets = [new PostgresRpcBudget(db, account, "public"), new PostgresRpcBudget(db, account, "public")];
  const flood = publicBudgets.map(async budget => {
    for (let i = 0; i < 4; i++) { const release = await budget.acquire(AbortSignal.timeout(8000)); starts.push(Date.now()); await release(); }
  });
  await delay(100);
  const queuedAt = Date.now();
  await Promise.all(["worker", "guardian"].map(async lane => {
    const release = await new PostgresRpcBudget(db, account, lane as "worker" | "guardian").acquire(AbortSignal.timeout(4000));
    starts.push(Date.now()); critical.push(Date.now() - queuedAt); await release();
  }));
  expect(Math.max(...critical)).toBeLessThan(1800);
  await Promise.all(flood); assertRate(starts, 3);
}, 15_000);
test("stalled public calls retain reserved concurrency and aborted waiters leave no reservation", async () => {
  const account = randomUUID(), budget = new PostgresRpcBudget(db, account, "public", 300);
  const release = [await budget.acquire(AbortSignal.timeout(1000)), await budget.acquire(AbortSignal.timeout(1000))];
  await expect(budget.acquire(AbortSignal.timeout(250))).rejects.toBeDefined();
  for (const lane of ["worker", "guardian"] as const)
    release.push(await new PostgresRpcBudget(db, account, lane, 300).acquire(AbortSignal.timeout(1000)));
  await Promise.all(release.map(done => done()));
  const row = (await pool.query("select state from cove_rpc_budgets where account=$1", [account])).rows[0].state;
  expect(row.waiters ?? []).toEqual([]); expect(row.leases).toEqual([]);
  await expect(new PostgresRpcBudget(db, account, "public", 9).acquire(AbortSignal.timeout(1000))).rejects.toThrow("configuration differs");
}, 5000);
