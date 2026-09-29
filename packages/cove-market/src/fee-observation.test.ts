import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@crclaunch/db";
import type * as Presign from "./presign.js";
import type * as Health from "./health.js";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { MarketService } from "./service.js";
import { defaultMarketConfig } from "./config.js";

const build = vi.hoisted(() => vi.fn(() => { throw new Error("BUILD_REACHED"); }));
vi.mock("./health.js", async (importOriginal) => ({
  ...await importOriginal<typeof Health>(),
  assertMarketReady: vi.fn(),
}));
vi.mock("./presign.js", async (importOriginal) => ({
  ...await importOriginal<typeof Presign>(),
  buildPresignedFillPsbt: build,
}));
afterEach(() => vi.clearAllMocks());

it.each([false, true])("P2P fill sizing uses the DB fee snapshot and refuses stale fees: stale=%s", async (stale) => {
  const db = { select: () => ({ from: () => ({ where: async () => [{
    feesObservedAt: new Date(Date.now() - (stale ? 120_001 : 0)),
    feeRates: {
      floorSatPerVb: "2", ceilingSatPerVb: "500", estimated: false,
      tiers: [{ key: "standard", label: "Standard", blocks: 3, satPerVb: "7" }],
    },
  }] }) }) } as unknown as Database;
  const provider = { getMempoolMinFeeSatPerVb: vi.fn(), estimateFeeRateAt: vi.fn() } as unknown as CoreRpcProvider;
  const service = new MarketService(db, provider, defaultMarketConfig("regtest", Buffer.alloc(22)));
  Object.assign(service, {
    loadFill: vi.fn(async () => ({
      status: "RESERVED", listingId: "listing", buyerFundInputs: [],
      buyerTokenScript: "00".repeat(22), buyerChangeScript: "00".repeat(22),
    })),
    loadListing: vi.fn(async () => ({
      tokenId: "00".repeat(32), sellerPayoutScript: "00".repeat(22), totalPriceSats: 10_000n,
    })),
    resolveSource: vi.fn(async () => ({ scriptPubKey: Buffer.alloc(22), valueSats: 1_000n })),
  });
  await expect(service.buildFillPsbt("fill", {})).rejects.toThrow(stale ? "CORE_UNAVAILABLE" : "BUILD_REACHED");
  expect(build).toHaveBeenCalledTimes(stale ? 0 : 1);
  expect(provider.getMempoolMinFeeSatPerVb).not.toHaveBeenCalled();
  expect(provider.estimateFeeRateAt).not.toHaveBeenCalled();
});
