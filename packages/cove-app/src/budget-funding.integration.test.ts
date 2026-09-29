import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb, PostgresRpcBudget } from "@crclaunch/db";
import { resolveFundingUtxos } from "./funding.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!isolated)("funding at the production gateway allowance", () => {
  it("resolves all 64 supported inputs while worker and Guardian also consume their reserved lanes", async () => {
    const db = createDb(url!), account = randomUUID();
    const starts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      starts.push(Date.now());
      return Response.json({ result: { scriptPubKey: { hex: "0014" + "11".repeat(20) }, value: 0.001, confirmations: 5 }, error: null });
    }));
    const provider = new CoreRpcProvider({ url: "https://fixture.example", budget: new PostgresRpcBudget(db, account, "public") });
    let done = false;
    const background = async (lane: "worker" | "guardian") => {
      const budget = new PostgresRpcBudget(db, account, lane);
      let count = 0;
      while (!done) {
        const release = await budget.acquire(AbortSignal.timeout(10_000));
        starts.push(Date.now()); count++;
        await release();
      }
      return count;
    };
    const workers = [background("worker"), background("guardian")];
    const inputs = Array.from({ length: 64 }, (_, index) => ({ txid: index.toString(16).padStart(64, "0"), vout: 0 }));
    try {
      expect(await resolveFundingUtxos(provider, inputs)).toHaveLength(64);
    } finally { done = true; }
    expect((await Promise.all(workers)).every((count) => count > 20)).toBe(true);
    starts.sort((a, b) => a - b);
    for (const start of starts) expect(starts.filter((time) => time >= start && time < start + 1_000).length).toBeLessThanOrEqual(3);
  }, 150_000);
});
