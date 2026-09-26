import { describe, expect, it } from "vitest";
import { MarketService } from "./service.js";
import { defaultMarketConfig } from "./config.js";
import type { ListingV1 } from "./types.js";

function listing(overrides: Partial<ListingV1> = {}): ListingV1 {
  return {
    orderVersion: 1,
    chainIdentity: "bitcoin-regtest",
    tokenId: "ab".repeat(32),
    sellerTokenScript: "0014" + "11".repeat(20),
    sellerPayoutScript: "0014" + "11".repeat(20),
    sellerTokenChangeScript: "0014" + "11".repeat(20),
    sourceTxid: "cd".repeat(32),
    sourceVout: 1,
    sourceAmountAtoms: 84_000_000n * 100_000_000n,
    amountAtoms: 42_000_000n * 100_000_000n,
    totalPriceSats: 100_000n,
    creationHeight: 1n,
    expiryHeight: 500n,
    nonce: "ee".repeat(32),
    ...overrides,
  };
}

describe("createListing chainIdentity gate (§M5)", () => {
  const market = new MarketService(
    {} as never,
    {} as never,
    defaultMarketConfig("regtest", Buffer.from("0014" + "22".repeat(20), "hex")),
  );

  it("rejects a listing whose chainIdentity differs from the server's", async () => {
    await expect(
      market.createListing({ ...listing({ chainIdentity: "bitcoin-mainnet" }), presignedPsbtBase64: "x" }),
    ).rejects.toThrow(/chainIdentity/);
  });
});
