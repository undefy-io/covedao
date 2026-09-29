import { describe, expect, it } from "vitest";
import {
  checkRedeemPayout,
  isValidRedeemPayout,
  redeemWalletFundingTarget,
} from "./redeemPayout.js";
import { grossRedeem } from "./backing.js";
import { deterministicFee, COVE_FEE_CONFIG, redeemFeeSats } from "./fee.js";

const P2WPKH = Buffer.from("0014" + "cc".repeat(20), "hex");
const P2TR = Buffer.from("5120" + "cc".repeat(32), "hex");

describe("legacy standalone redeem payout", () => {
  it("refuses a sale worth less than the flat exit fee", () => {
    const c = checkRedeemPayout(500n, 2_500n, P2WPKH);
    expect(c.netSats).toBe(-2_000n);
    expect(c.isPayable).toBe(false);
    expect(c.minimumGrossSats).toBe(2_794n);
  });

  it("refuses a payout that is positive but below relay dust", () => {
    const c = checkRedeemPayout(2_600n, 2_500n, P2WPKH);
    expect(c.netSats).toBe(100n);
    expect(c.isPayable).toBe(false);
  });

  it("accepts a payout exactly at the dust threshold", () => {
    const c = checkRedeemPayout(2_794n, 2_500n, P2WPKH);
    expect(c.netSats).toBe(294n);
    expect(c.isPayable).toBe(true);
  });

  it("uses the payout script's own dust threshold, not a fixed number", () => {
    expect(checkRedeemPayout(2_800n, 2_500n, P2TR).isPayable).toBe(false); // P2TR dust is 330
    expect(checkRedeemPayout(2_830n, 2_500n, P2TR).isPayable).toBe(true);
  });

  it("a single lot at stair 1 cannot fund a standalone net payout", () => {
    // One lot (1,000 tokens) at the opening stair is worth 27 sats, under the
    // 1,000-sat floor on the exit fee.
    const gross = grossRedeem(100_000n, 1_000n);
    const c = checkRedeemPayout(gross, redeemFeeSats(gross), P2WPKH);
    expect(gross).toBe(27n);
    expect(c.isPayable).toBe(false);
  });

  it("a whole stair clears the exit fee", () => {
    // 100 lots at 27 sats = 2,700; the 1,000-sat fee floor leaves 1,700.
    const gross = grossRedeem(100_000n, 100_000n);
    const c = checkRedeemPayout(gross, redeemFeeSats(gross), P2WPKH);
    expect(c.netSats).toBe(1_700n);
    expect(c.isPayable).toBe(true);
  });

  it("accepts a sale large enough to clear the fee", () => {
    const gross = grossRedeem(100_000n, 50_000n);
    const fee = deterministicFee(
      gross,
      COVE_FEE_CONFIG.redeemFeeBps,
      COVE_FEE_CONFIG.redeemFeeFlatSats,
    );
    const c = checkRedeemPayout(gross, fee, P2WPKH);
    expect(c.isPayable).toBe(true);
    expect(c.netSats).toBe(gross - fee);
  });
});

describe("wallet-funded small-lot redemptions", () => {
  it("accepts standard combined payouts while rejecting underpayment and dust", () => {
    expect(isValidRedeemPayout(27n, 1000n, 294n, P2WPKH)).toBe(true);
    expect(isValidRedeemPayout(27n, 1000n, 293n, P2WPKH)).toBe(false);
    expect(isValidRedeemPayout(27n, 1000n, 26n, P2WPKH)).toBe(false);
    expect(isValidRedeemPayout(27n, 1000n, -973n, P2WPKH)).toBe(false);
    expect(isValidRedeemPayout(27n, 1000n, 330n, P2TR)).toBe(true);
    expect(isValidRedeemPayout(27n, 1000n, 329n, P2TR)).toBe(false);
    expect(isValidRedeemPayout(27n, 1000n, 1000n, Buffer.from("6a", "hex"))).toBe(false);
    expect(isValidRedeemPayout(2700n, 1000n, 1700n, P2WPKH)).toBe(true);
  });
  it("funds protocol fees and dust top-up without using additional backing", () => {
    expect(redeemWalletFundingTarget(27n, 1000n, P2WPKH, 1000n, 0n)).toBe(267n);
    expect(redeemWalletFundingTarget(27n, 1000n, P2WPKH, 1000n, 1000n)).toBe(1267n);
    expect(redeemWalletFundingTarget(27n, 1000n, P2TR, 1000n, 1000n)).toBe(1303n);
    expect(redeemWalletFundingTarget(2700n, 1000n, P2WPKH, 1000n, 0n)).toBe(0n);
  });
});
