import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@crclaunch/db";
import { getV3Status } from "./health.js";
import { readFeeObservation } from "./runtime-snapshot.js";
import { loadV3AppConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());

function dbWithResults(results: unknown[][]): Database {
  const where = vi.fn();
  for (const rows of results) where.mockResolvedValueOnce(rows);
  return { select: () => ({ from: () => ({ where }) }) } as unknown as Database;
}

it.each([
  { age: 0, reachable: true, indexed: 100n, rebuilding: false, expected: "HEALTHY" },
  { age: 31_000, reachable: true, indexed: 100n, rebuilding: false, expected: "STALE" },
  { age: 0, reachable: false, indexed: 100n, rebuilding: false, expected: "CORE_UNREACHABLE" },
  { age: 0, reachable: true, indexed: 101n, rebuilding: false, expected: "DIVERGED" },
  { age: 0, reachable: true, indexed: 96n, rebuilding: false, expected: "BEHIND" },
  { age: 0, reachable: true, indexed: 100n, rebuilding: true, expected: "REBUILDING" },
])("reads status from DB and reports $expected without RPC", async ({ age, reachable, indexed, rebuilding, expected }) => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("RPC must not be used"));
  vi.stubGlobal("fetch", fetchMock);
  const db = dbWithResults([
    [{ coreHeight: 100n, coreTip: "tip", coreReachable: reachable, chainObservedAt: new Date(Date.now() - age) }],
    [{ height: indexed, blockHash: "tip", stateRoot: "root", rebuilding }],
    [{ enabled: true }],
  ]);
  const status = await getV3Status({ db, config: loadV3AppConfig({ COVE_NETWORK: "regtest" }) });
  expect(status.indexer.health).toBe(expected);
  expect(status.core.stale).toBe(age > 30_000);
  expect(status.core.reachable).toBe(age <= 30_000 && reachable);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not report a missing worker snapshot healthy", async () => {
  const status = await getV3Status({ db: dbWithResults([[], [], []]), config: loadV3AppConfig({ COVE_NETWORK: "regtest" }) });
  expect(status.indexer.health).toBe("STALE");
  expect(status.core.reachable).toBe(false);
});

const fees = {
  floorSatPerVb: "2", ceilingSatPerVb: "500", estimated: false,
  tiers: [{ key: "standard", label: "Standard", blocks: 3, satPerVb: "7" }],
};

it("reads fee previews from DB without RPC and restores bigint amounts", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const rates = await readFeeObservation(dbWithResults([[{ feeRates: fees, feesObservedAt: new Date() }]]), "signet");
  expect(rates.floorSatPerVb).toBe(2n);
  expect(rates.tiers[0]?.satPerVb).toBe(7n);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([{ rows: [] }, { rows: [{ feeRates: fees, feesObservedAt: new Date(Date.now() - 121_000) }] }])("rejects missing or stale fee previews: %j", async ({ rows }) => {
  await expect(readFeeObservation(dbWithResults([rows]), "signet")).rejects.toThrow("CORE_UNAVAILABLE");
});
