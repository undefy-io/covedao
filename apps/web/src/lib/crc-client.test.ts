import { describe, expect, it, vi } from "vitest";
import { fetchAllCrcWalletBalances, parseCrcTokenQuantity } from "./crc-client";

function response(balances: unknown[], nextCursor: string | null) {
  return new Response(JSON.stringify({ ok: true, data: { balances, nextCursor } }));
}

describe("CRC wallet client paging", () => {
  it("loads every balance page before displaying wallet totals", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([{ assetId: `signet:${"a".repeat(64)}`, ticker: "A", atoms: "100" }], `100:${"a".repeat(64)}`))
      .mockResolvedValueOnce(response([{ assetId: `signet:${"b".repeat(64)}`, ticker: "B", atoms: "50" }], null));
    const balances = await fetchAllCrcWalletBalances("tb1qexample", fetcher);
    expect(balances).toHaveLength(2);
    expect(fetcher.mock.calls[1]![0]).toContain(`before=100%3A${"a".repeat(64)}`);
  });

  it("stops on a repeated cursor instead of looping forever", async () => {
    const cursor = `100:${"a".repeat(64)}`;
    const fetcher = vi.fn().mockImplementation(async () => response([], cursor));
    await expect(fetchAllCrcWalletBalances("tb1qexample", fetcher)).rejects.toThrow(/repeated cursor/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("CRC token quantity", () => {
  it("converts exact 1000-token lots to atoms before requesting a quote", () => {
    expect(parseCrcTokenQuantity("1000")).toBe("100000000000");
    expect(parseCrcTokenQuantity("25000")).toBe("2500000000000");
    for (const invalid of ["999", "1001", "0", "-1000", "1.5", "01000", "21001000"]) {
      expect(() => parseCrcTokenQuantity(invalid)).toThrow();
    }
  });
});
