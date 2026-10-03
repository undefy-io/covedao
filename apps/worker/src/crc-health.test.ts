import { expect, test } from "vitest";
import { crcWorkerHealthy } from "./crc-health-policy.js";

test("worker probe rejects stale, stopped, failed and wrong-network observations", () => {
  const sample = { network: "regtest", pid: 12, observedAt: 10_000, pollMs: 1000, healthy: true };
  expect(crcWorkerHealthy(sample, "regtest", 11_000, () => true)).toBe(true);
  expect(crcWorkerHealthy(sample, "regtest", 14_001, () => true)).toBe(false);
  expect(crcWorkerHealthy(sample, "signet", 11_000, () => true)).toBe(false);
  expect(crcWorkerHealthy(sample, "regtest", 11_000, () => false)).toBe(false);
  expect(crcWorkerHealthy({ ...sample, healthy: false }, "regtest", 11_000, () => true)).toBe(false);
  expect(crcWorkerHealthy({}, "regtest", 11_000, () => true)).toBe(false);
});

test("probe files isolate databases on the same network without exposing connection strings", async () => {
  const { crcHealthPath } = await import("./crc-health-policy.js");
  const first = crcHealthPath("postgres://user:secret@localhost/one", "regtest");
  expect(first).not.toBe(crcHealthPath("postgres://user:secret@localhost/two", "regtest"));
  expect(first).not.toContain("secret");
  expect(first).not.toContain("postgres:");
});
