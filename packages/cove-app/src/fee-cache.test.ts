import { afterEach, expect, it, vi } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";

afterEach(() => vi.useRealTimers());

it("shares concurrent fee refreshes and starts the TTL when rates arrive", async () => {
  vi.useFakeTimers();
  let release!: (rate: bigint) => void;
  const floor = new Promise<bigint>((resolve) => { release = resolve; });
  const provider = {
    getMempoolMinFeeSatPerVb: vi.fn(() => floor),
    estimateFeeRateAt: vi.fn(async () => 5n),
  } as unknown as CoreRpcProvider;
  const app = new V3AppService({} as never, provider, loadV3AppConfig({ COVE_NETWORK: "regtest" }), {} as GuardianTransitionSigner);
  const first = app.feeRates();
  const second = app.feeRates();
  expect(provider.getMempoolMinFeeSatPerVb).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(4_000);
  release(1n);
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  vi.advanceTimersByTime(14_000);
  expect(await app.feeRates()).toBe(a);
  expect(provider.getMempoolMinFeeSatPerVb).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  await app.feeRates();
  expect(provider.getMempoolMinFeeSatPerVb).toHaveBeenCalledTimes(2);
});
