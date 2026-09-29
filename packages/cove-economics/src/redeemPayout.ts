import type { Sats } from "@crclaunch/curve";
import { isCreatorScript } from "./fee.js";
import { dustThreshold } from "./dust.js";

/** Legacy standalone payout checks; application redemptions combine backing proceeds with wallet BTC change. */
export interface RedeemPayoutCheck {
  grossSats: Sats;
  feeSats: Sats;
  /** gross − fee. Negative when the sale is worth less than the exit fee. */
  netSats: Sats;
  /** Relay dust threshold for the payout script. */
  dustThresholdSats: Sats;
  /** true when the payout is an output Bitcoin will actually carry. */
  isPayable: boolean;
  /** Smallest gross that produces a payable payout: fee + dust. */
  minimumGrossSats: Sats;
}

export function checkRedeemPayout(
  grossSats: Sats,
  feeSats: Sats,
  payoutScript: Uint8Array,
): RedeemPayoutCheck {
  if (grossSats < 0n) throw new Error("grossSats must be non-negative");
  if (feeSats < 0n) throw new Error("feeSats must be non-negative");
  const dust = dustThreshold(payoutScript);
  const netSats = grossSats - feeSats;
  return {
    grossSats,
    feeSats,
    netSats,
    dustThresholdSats: dust,
    isPayable: netSats >= dust,
    minimumGrossSats: feeSats + dust,
  };
}

export function isValidRedeemPayout(
  grossSats: Sats,
  feeSats: Sats,
  payoutSats: Sats,
  payoutScript: Uint8Array,
): boolean {
  if (payoutSats < 0n) return false;
  if (payoutSats === grossSats - feeSats) return true;
  return (
    isCreatorScript(payoutScript) &&
    payoutSats >= grossSats &&
    payoutSats >= dustThreshold(payoutScript)
  );
}

export function redeemWalletFundingTarget(
  grossSats: Sats,
  feeSats: Sats,
  payoutScript: Uint8Array,
  carrierSatsIn: Sats,
  changeCarrierSats: Sats,
): Sats {
  const dust = dustThreshold(payoutScript);
  const topUp = grossSats < dust ? dust - grossSats : 0n;
  return feeSats + changeCarrierSats - carrierSatsIn + topUp;
}
