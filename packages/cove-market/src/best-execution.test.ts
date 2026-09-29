import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@crclaunch/db";
import { deterministicFee, grossBuy, mintFeeSats, creatorFeeSats, COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import { getBuyRoutes } from "./best-execution.js";

/** Minimal drizzle-shaped mock: `select().from(table).where()` resolves to rows by table. */
function mockDb(rows: { listings?: unknown[]; backing?: unknown[] }): Database {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.coveV3MarketListings) return { orderBy: () => ({ limit: (limit: number) => (rows.listings ?? []).slice(0, limit) }) };
          if (table === schema.coveV3BackingStates) return rows.backing ?? [];
          return [];
        },
      }),
    }),
  } as unknown as Database;
}

describe("best-execution fee threading (§M6)", () => {
  it("quotes the P2P fee with the configured p2pFeeBps, not the dev default", async () => {
    const db = mockDb({ listings: [{ listingId: "ab".repeat(32), tokenId: "cd".repeat(32), totalPriceSats: 100_000n, amountAtoms: 42_000_000n * 100_000_000n, status: "ACTIVE" }] });
    const routes = await getBuyRoutes(db, "regtest", "cd".repeat(32), 0n, { buyFeeBps: 100n, p2pFeeBps: 200n });
    const p2p = routes.find((r) => r.kind === "p2p");
    expect(p2p).toBeDefined();
    if (p2p && p2p.kind === "p2p") {
      expect(p2p.breakdown.feeBps).toBe(200n);
      expect(p2p.breakdown.marketFeeSats).toBe(deterministicFee(100_000n, 200n));
    }
  });
});

describe("best execution uses the validated pending price", () => {
  const amount = 1000n * 100_000_000n;
  const tokenId = "cd".repeat(32);
  function observed(supply: bigint, fresh = true) {
    const db = mockDb({ backing: [{ supplyAtoms: 0n }], listings: [] });
    const execute = vi.fn().mockResolvedValue({ rows: [{
      payload: { issuedSupplyAtoms: supply.toString() }, fresh,
      height: "100", block_hash: "ab".repeat(32), revision: "1", generation: "2", observed_at: new Date(),
    }] });
    Object.assign(db, { execute });
    return { db, execute };
  }
  it.each([10_000n, 9_000n, 12_000n])("prices accepted mint/redeem supply %s rather than confirmed zero", async (supply) => {
    const { db, execute } = observed(supply * 100_000_000n);
    const routes = await getBuyRoutes(db, "regtest", tokenId, amount);
    const gross = grossBuy(supply, 1000n);
    expect(routes[0]).toMatchObject({ kind: "backing", totalCostSats:
      gross + mintFeeSats(gross, amount, COVE_FEE_CONFIG.buyFeeBps, COVE_FEE_CONFIG.buyFeeFlatSats) + creatorFeeSats(gross) });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("serves the cached price despite expired freshness metadata", async () => {
    const { db } = observed(10_000n * 100_000_000n, false);
    const routes = await getBuyRoutes(db, "regtest", tokenId, amount);
    expect(routes[0]?.kind).toBe("backing");
  });
  it("does not invent a route for a missing token", async () => {
    const { db, execute } = observed(0n);
    execute.mockResolvedValue({ rows: [] });
    await expect(getBuyRoutes(db, "regtest", tokenId, amount)).rejects.toThrow("TOKEN_NOT_FOUND");
  });
  it("retains cap and lot eligibility without using confirmed supply", async () => {
    const { db } = observed(21_000_000n * 100_000_000n);
    expect(await getBuyRoutes(db, "regtest", tokenId, amount)).toEqual([]);
    expect(await getBuyRoutes(db, "regtest", tokenId, 100_000_000n)).toEqual([]);
  });
});
