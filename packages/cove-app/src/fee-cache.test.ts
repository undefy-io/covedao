import { afterEach, expect, it, vi } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";
import type { Database } from "@crclaunch/db";

afterEach(() => vi.useRealTimers());

it("all app fee sizing reads worker observations without refreshing them through RPC", async () => {
  vi.useFakeTimers();
  const snapshot = {
    feesObservedAt: new Date(),
    feeRates: {
      floorSatPerVb: "2", ceilingSatPerVb: "500", estimated: false,
      tiers: [{ key: "standard", label: "Standard", blocks: 3, satPerVb: "7" }],
    },
  };
  const db = { select: () => ({ from: () => ({ where: async () => [snapshot] }) }) } as unknown as Database;
  const provider = {
    getMempoolMinFeeSatPerVb: vi.fn(),
    estimateFeeRateAt: vi.fn(),
  } as unknown as CoreRpcProvider;
  const app = new V3AppService(db, provider, loadV3AppConfig({ COVE_NETWORK: "regtest" }), {} as GuardianTransitionSigner);
  expect((await app.feeRates()).tiers[0]?.satPerVb).toBe(7n);
  await vi.advanceTimersByTimeAsync(120_001);
  await expect(app.feeRates()).rejects.toThrow("CORE_UNAVAILABLE");
  expect(provider.getMempoolMinFeeSatPerVb).not.toHaveBeenCalled();
  expect(provider.estimateFeeRateAt).not.toHaveBeenCalled();
});
