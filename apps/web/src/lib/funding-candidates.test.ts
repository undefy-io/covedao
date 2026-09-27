import { describe, expect, it } from "vitest";
import { selectFundingCandidates } from "./funding-candidates";

describe("wallet funding candidates", () => {
  it("sends at most 64 largest coins to the server", () => {
    const coins = Array.from({ length: 100 }, (_, n) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueSats: String(n + 1),
    }));
    const selected = selectFundingCandidates(coins);
    expect(selected).toHaveLength(64);
    expect(selected[0]?.txid).toBe(coins[99]?.txid);
    expect(selected.at(-1)?.txid).toBe(coins[36]?.txid);
  });

  it("uses confirmed coins for backing trades without restricting other trades", () => {
    const coins = Array.from({ length: 100 }, (_, n) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueSats: String(n + 1),
      confirmations: n < 65 ? 1 : 0,
    }));
    const selected = selectFundingCandidates(coins, true);
    expect(selected).toHaveLength(64);
    expect(selected.every((coin) => Number.parseInt(coin.txid, 16) < 65)).toBe(true);
    expect(selectFundingCandidates(coins)[0]?.txid).toBe(coins[99]?.txid);
  });
});
