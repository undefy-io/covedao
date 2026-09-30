import { describe, expect, it } from "vitest";
import { quoteCrcBuy, quoteCrcSell } from "./crc-quote";

const txid = "a".repeat(64);
const base = {
  assetId: `signet:${txid}`,
  mintedAtoms: "0",
  inventoryAtoms: "0",
  circulatingAtoms: "0",
  availability: "active" as const,
  vaultAnchorSats: "330",
  vault: { txid, vout: 1, btcSats: "330" },
};

describe("CRC DB-backed quote math", () => {
  it("quotes a 1000-token mint with fees outside the reserve", () => {
    expect(quoteCrcBuy(base, 100_000_000_000n)).toMatchObject({
      operation: "mint",
      amountAtoms: "100000000000",
      grossSats: "27",
      protocolFeeSats: "5013",
      creatorFeeSats: "546",
      buyerTotalSats: "5586",
      vaultOutpoint: `${txid}:1`,
    });
  });

  it("quotes a sell with script-specific dust and wallet top-up", () => {
    const minted = { ...base, mintedAtoms: "100000000000", circulatingAtoms: "100000000000", vault: { ...base.vault, btcSats: "357" } };
    expect(quoteCrcSell(minted, 100_000_000_000n, "0014" + "1".repeat(40))).toMatchObject({
      operation: "transfer",
      grossSats: "27",
      protocolFeeSats: "1000",
      sellerPayoutSats: "294",
      walletTopUpSats: "1267",
      sellerNetSats: "-973",
    });
  });

  it("rejects unavailable, inconsistent, and inventory-crossing states", () => {
    expect(() => quoteCrcBuy({ ...base, availability: "unavailable" }, 100_000_000_000n)).toThrow(/unavailable/i);
    expect(() => quoteCrcBuy({ ...base, vault: { ...base.vault, btcSats: "329" } }, 100_000_000_000n)).toThrow(/backing|anchor|state/i);
    const inventory = { ...base, mintedAtoms: "100000000000", inventoryAtoms: "100000000000" };
    expect(() => quoteCrcBuy(inventory, 200_000_000_000n)).toThrow(/split/i);
  });
});
