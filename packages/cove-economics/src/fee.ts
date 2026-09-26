import type { Atoms, BasisPoints, Sats } from "@crclaunch/curve";
import { ATOMS_PER_TOKEN, LOT_TOKENS } from "@crclaunch/curve";

/**
 * Cove fee configuration — the ONE canonical place for protocol fees.
 *
 * Backing principal is NEVER a fee; fees are charged in addition (buy) or
 * deducted from the gross payout (redeem), and never reduce the backing below
 * its required state.
 *
 * Each fee has a FLAT component and a PERCENTAGE component, and the flat part
 * is not cosmetic. A pure-percentage fee on a small trade produces a fee output
 * below Bitcoin's relay dust limit, which is non-standard — so the whole
 * transaction is refused. With a 1% fee that put a hard floor of ~29,300 sats
 * on every buy AND on every redemption, locking small holders out of the exit
 * entirely. A flat component above the dust threshold removes that floor.
 *
 * These are DEVELOPMENT defaults. The mainnet fee policy is explicit
 * configuration that must be frozen before any mainnet deployment.
 */
export interface CoveFeeConfig {
  /** Backing buy (primary issuance) fee, in basis points. */
  buyFeeBps: BasisPoints;
  /**
   * Flat sats charged on every mint, at every stage.
   *
   * A per-mint charge, paired with a per-mint spending limit: a large buyer
   * mints several times and pays it each time. It is large next to a tiny
   * early mint by design — the operator chose a flat price per mint over a
   * stage-scaled one.
   */
  buyFeeFlatSats: Sats;
  /** Sats charged per lot (1,000 tokens) minted, on top of the flat fee. */
  buyFeeLotSats: Sats;
  /**
   * The creator's share of every mint, in basis points of the curve price,
   * paid on top of it straight to the address that launched the token.
   */
  creatorFeeBps: BasisPoints;
  /** Backing redemption (instant sell) fee, in basis points. */
  redeemFeeBps: BasisPoints;
  /** Flat sats deducted from every redemption payout. */
  redeemFeeFlatSats: Sats;
  /** The redemption fee never drops below this. */
  redeemFeeMinSats: Sats;
  /** Peer-to-peer marketplace fee, in basis points. */
  p2pFeeBps: BasisPoints;
  /** Flat sats added to every peer-to-peer fill. */
  p2pFeeFlatSats: Sats;
  /**
   * Floor under the peer-to-peer fee.
   *
   * The marketplace fee is a pure percentage, so a small listing would produce
   * a fee output below the relay dust threshold and the fill would be refused
   * outright. A floor keeps every fill standard without charging a flat amount
   * on top of the percentage for ordinary trades.
   */
  p2pFeeMinSats: Sats;
  /**
   * Flat sats paid to the protocol fee address by every launch (DEPLOY
   * output 3). The indexer refuses a DEPLOY that does not pay it exactly.
   */
  launchFeeSats: Sats;
}

export const COVE_FEE_CONFIG: CoveFeeConfig = {
  // Mint: a flat launch-style fee plus a share of the curve price. The flat
  // 5,000 sats comfortably clears the 294-sat P2WPKH dust threshold, so no
  // buy is ever refused for a dust fee.
  buyFeeBps: 750n, // 7.50%
  buyFeeFlatSats: 5_000n, // per mint
  buyFeeLotSats: 10n, // per 1,000-token lot
  // The creator is paid as the token sells, not by taking the backing: the
  // vault still holds the full curve price, so redemption is never short.
  creatorFeeBps: 5_000n, // 50% of the curve price
  // Redemption: 7.5% of what the vault pays out. A redemption small enough
  // that 7.5% would be dust is refused by the quote as too small to make.
  redeemFeeBps: 750n, // 7.50%
  redeemFeeFlatSats: 0n,
  // Floor, so a small sell-back's fee output is never dust.
  redeemFeeMinSats: 1_000n,
  // Marketplace: a clean percentage, floored so a small fill is never refused
  // for a dust fee.
  p2pFeeBps: 750n, // 7.50%
  p2pFeeFlatSats: 0n,
  p2pFeeMinSats: 1_000n,
  // Launch: about $6 at $84k/BTC. Flat, so every launch pays the same.
  launchFeeSats: 7_000n,
};

/** The launch fee every DEPLOY pays at output 3 (see COVE_FEE_CONFIG.launchFeeSats). */
export const LAUNCH_FEE_SATS: Sats = COVE_FEE_CONFIG.launchFeeSats;

const BPS_DENOM = 10_000n;

/**
 * Deterministic integer fee: `flat + ceil(gross × bps / 10000)`.
 *
 * Rounds UP to the nearest sat, so the protocol never under-charges. Integer
 * only; no floating point anywhere.
 *
 * `flatSats` defaults to zero so a caller that has not been taught about the
 * flat component behaves exactly as before rather than silently charging it.
 */
export function deterministicFee(
  grossSats: Sats,
  feeBps: BasisPoints,
  flatSats: Sats = 0n,
  minSats: Sats = 0n,
): Sats {
  if (grossSats < 0n) throw new Error("grossSats must be non-negative");
  if (feeBps < 0n) throw new Error("feeBps must be non-negative");
  if (flatSats < 0n) throw new Error("flatSats must be non-negative");
  if (minSats < 0n) throw new Error("minSats must be non-negative");
  if (grossSats === 0n) return 0n;
  const pct = feeBps === 0n ? 0n : (grossSats * feeBps + BPS_DENOM - 1n) / BPS_DENOM;
  const fee = flatSats + pct;
  return fee < minSats ? minSats : fee;
}

/**
 * The protocol fee on a mint: a flat charge per mint, a charge per lot, and a
 * percentage of the curve price. The one formula every builder, validator,
 * quote and the indexer uses, so they cannot disagree.
 */
export function mintFeeSats(
  grossSats: Sats,
  amountAtoms: Atoms,
  feeBps: BasisPoints,
  flatPerMintSats: Sats,
  perLotSats: Sats = COVE_FEE_CONFIG.buyFeeLotSats,
): Sats {
  const lots = amountAtoms / (LOT_TOKENS * ATOMS_PER_TOKEN);
  return deterministicFee(grossSats, feeBps, flatPerMintSats + perLotSats * lots);
}

/**
 * A launch records its creator in DEPLOY output 2: exactly this many sats to
 * the creator's own address. Every mint then pays the creator's share there.
 */
export const CREATOR_RECORD_SATS: Sats = 1_000n;

/**
 * Smallest creator payment: at or above the dust limit of every address type
 * a creator can have (P2SH is the highest, 540). Early lots cost a few sats,
 * so a bare percentage of one would be an output Bitcoin refuses to relay.
 */
export const CREATOR_MIN_SATS: Sats = 546n;

/** The creator's share of a mint: a percentage of the curve price, rounded up, never below dust. */
export function creatorFeeSats(grossSats: Sats, creatorBps: BasisPoints = COVE_FEE_CONFIG.creatorFeeBps): Sats {
  return deterministicFee(grossSats, creatorBps, 0n, CREATOR_MIN_SATS);
}

/** The fee on a sell-back to the vault: a percentage plus any flat part, floored. */
export function redeemFeeSats(
  grossSats: Sats,
  feeBps: BasisPoints = COVE_FEE_CONFIG.redeemFeeBps,
  flatSats: Sats = COVE_FEE_CONFIG.redeemFeeFlatSats,
  minSats: Sats = COVE_FEE_CONFIG.redeemFeeMinSats,
): Sats {
  return deterministicFee(grossSats, feeBps, flatSats, minSats);
}

/** Scripts a creator can be paid to: native segwit, nested segwit or Taproot. */
export function isCreatorScript(script: Uint8Array): boolean {
  const s = script;
  const p2wpkh = s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
  const p2tr = s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
  const p2sh = s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
  return p2wpkh || p2tr || p2sh;
}
