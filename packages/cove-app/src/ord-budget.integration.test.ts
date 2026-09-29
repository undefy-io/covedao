import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, PostgresRpcBudget, providerAccount } from "@crclaunch/db";
import { ordAssetLookup } from "@crclaunch/cove-guardian/v3";
import { withRpcDeadline } from "@crclaunch/bitcoin";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";
const db = isolated ? createDb(url!) : undefined;
const account = `ord:${providerAccount({ url: `https://${randomUUID()}.test` })}`;
afterAll(async () => {
  if (!db) return;
  await db.execute(sql`delete from cove_rpc_budgets where account = ${account}`);
  await db.$client.end();
});

describe.skipIf(!isolated)("ord budgets across app and Guardian replicas", () => {
  it("caps shared concurrency, cancels queued and streaming work, and releases all leases", async () => {
    const controllers: AbortController[] = [];
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(Date.now());
      return new Response(new ReadableStream());
    });
    const lookups = Array.from({ length: 3 }, () => ordAssetLookup("https://ord.test", {
      budget: new PostgresRpcBudget(db!, account, "public", 300), fetchImpl,
    }));
    const guardian = ordAssetLookup("https://ord.test", {
      budget: new PostgresRpcBudget(db!, account, "guardian", 300), fetchImpl,
    });
    const pending = [...lookups, guardian].map((lookup) => {
      const controller = new AbortController();
      controllers.push(controller);
      return withRpcDeadline(controller.signal, () => lookup.describeAssets({ txid: "ab".repeat(32), vout: 0 })).catch((error: unknown) => error);
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const state = await db!.execute(sql`select state from cove_rpc_budgets where account = ${account}`);
    expect((state.rows[0]!.state as { leases: unknown[] }).leases).toHaveLength(3);
    controllers.forEach((controller) => controller.abort(new Error("client disconnected")));
    const outcomes = await Promise.all(pending);
    expect(outcomes.every((error) => error instanceof Error && error.message === "client disconnected")).toBe(true);
    const after = await db!.execute(sql`select state from cove_rpc_budgets where account = ${account}`);
    expect((after.rows[0]!.state as { leases: unknown[] }).leases).toHaveLength(0);
    const recovered = ordAssetLookup("https://ord.test", {
      budget: new PostgresRpcBudget(db!, account, "public", 300),
      fetchImpl: async () => new Response(JSON.stringify({ indexed: true, inscriptions: [], runes: {} })),
    });
    expect(await recovered.describeAssets({ txid: "ab".repeat(32), vout: 0 })).toBeNull();
    expect(starts.length).toBe(3);
  });
});
