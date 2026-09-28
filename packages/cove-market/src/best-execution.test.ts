import { describe, expect, it } from "vitest";
import { schema, type Database } from "@crclaunch/db";
import { deterministicFee } from "@crclaunch/cove-economics";
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
