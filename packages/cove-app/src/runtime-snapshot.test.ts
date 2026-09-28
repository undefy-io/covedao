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

it("cold start collects RPC fees directly and persists their original observation age", async () => {
  const { collectFeeObservation, saveFeeObservation } = await import("./runtime-snapshot.js");
  const provider = {
    getMempoolMinFeeSatPerVb: vi.fn(async () => 3n),
    estimateFeeRateAt: vi.fn(async () => null),
  } as unknown as Parameters<typeof collectFeeObservation>[0];
  const fields: Record<string, unknown> = {};
  const db = {
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoUpdate: async () => { Object.assign(fields, values); } }) }),
    select: () => ({ from: () => ({ where: async () => fields.feeRates ? [fields] : [] }) }),
  } as unknown as Database;
  await expect(readFeeObservation(db, "signet")).rejects.toThrow("CORE_UNAVAILABLE");
  const observation = await collectFeeObservation(provider);
  const originalTime = observation.observedAt.getTime();
  await saveFeeObservation(db, "signet", observation.rates, observation.observedAt);
  expect((fields.feesObservedAt as Date).getTime()).toBe(originalTime);
  expect((await readFeeObservation(db, "signet")).estimated).toBe(true);
  expect(provider.estimateFeeRateAt).toHaveBeenCalledTimes(3);
  expect(provider.getMempoolMinFeeSatPerVb).toHaveBeenCalledWith(expect.objectContaining({ retry: true, signal: expect.any(AbortSignal) }));
});

it.each(["HTTP 429", "timeout", "node down"])("failed fee refresh preserves previous values and successful age: %s", async (message) => {
  const { collectFeeObservation, saveFeeObservation } = await import("./runtime-snapshot.js");
  const previous = { feeRates: fees, feesObservedAt: new Date(Date.now() - 121_000) };
  const write = vi.fn();
  const db = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: write }) }),
    select: () => ({ from: () => ({ where: async () => [previous] }) }),
  } as unknown as Database;
  const provider = {
    getMempoolMinFeeSatPerVb: vi.fn(async () => { throw new Error(message); }),
    estimateFeeRateAt: vi.fn(async () => 5n),
  } as unknown as Parameters<typeof collectFeeObservation>[0];
  const refresh = async () => {
    const observation = await collectFeeObservation(provider);
    await saveFeeObservation(db, "signet", observation.rates, observation.observedAt);
  };
  await expect(refresh()).rejects.toThrow(message);
  expect(write).not.toHaveBeenCalled();
  expect(previous.feeRates).toBe(fees);
  await expect(readFeeObservation(db, "signet")).rejects.toThrow("CORE_UNAVAILABLE");
});
