import type { CoreRpcProvider, RpcReadOptions } from "./provider.js";

/**
 * A miner fee that would not relay, or that is plainly a mistake. Carried as a
 * typed code so each layer can map it onto its own error vocabulary.
 */
export class FeeError extends Error {
  readonly code: "MINER_FEE_TOO_LOW" | "MINER_FEE_TOO_HIGH";
  constructor(code: "MINER_FEE_TOO_LOW" | "MINER_FEE_TOO_HIGH", message: string) {
    super(`[${code}] ${message}`);
    this.name = "FeeError";
    this.code = code;
  }
}

/**
 * Transaction sizing and miner-fee policy (§18).
 *
 * Every build path used to send a flat 1,000 sats. A backing buy is 370–440
 * vbytes, so that is ~2.3 sat/vB: below Bitcoin's relay floor whenever the
 * mempool is busy, and low enough that the entire 25-deep unconfirmed vault
 * chain can be evicted in one go. The user's BTC is not taken (the transaction
 * never confirms) but their trade silently evaporates, which is worse than a
 * clean rejection.
 *
 * The vbyte constants below are not estimates. They were measured byte-for-byte
 * against real Cove transactions on a live chain and reproduce their vsize
 * exactly:
 *
 *   DEPLOY  1×P2WPKH in, 3 out                   → 206 vB (measured 206)
 *   MINT    1×vault + 1×P2WPKH in, 5 out         → 370 vB (measured 370)
 *   MINT    1×vault + 2×P2WPKH in, 5 out         → 439 vB (measured 438)
 *
 * `pnpm cove:fee-sizing-proof` re-derives them from a live chain.
 */

/** 4 version + 4 locktime + 2 count varints, plus 2 witness marker/flag weight units. */
export const VB_TX_OVERHEAD = 11;

/** 41 base (36 outpoint + 1 empty scriptSig + 4 sequence) + 108 witness bytes / 4. */
export const VB_INPUT_P2WPKH = 68;

/** 41 base + 66 witness bytes / 4 — Taproot key-path spend. */
export const VB_INPUT_P2TR_KEYPATH = 58;

/**
 * 41 base + a 23-byte scriptSig carrying the redeemScript + 108 witness bytes
 * / 4. The scriptSig is NOT witness-discounted, which is why a nested-segwit
 * input costs more than half again what a native one does.
 */
export const VB_INPUT_P2SH_P2WPKH = 91;

/**
 * Backing-vault script-path spend: 41 base + 234 witness bytes / 4, rounded up.
 * The witness is [signature 64, state 32, leaf script 68, control block 65]
 * plus five compact-size length prefixes.
 */
export const VB_INPUT_VAULT = 100;

/** Serialized output: 8 value + 1 script-length varint (len < 253) + script. */
export function outputVbytes(scriptBytes: number): number {
  return 9 + scriptBytes;
}

/** P2TR scriptPubKey: OP_1 <32-byte program>. */
export const SCRIPT_BYTES_P2TR = 34;

export interface CoveTxShape {
  /** Backing-vault script-path inputs (0 or 1). */
  vaultInputs: number;
  /** Native-segwit inputs: funding UTXOs and token carriers alike. */
  p2wpkhInputs: number;
  /** Taproot key-path inputs — every ordinals address is one of these. */
  p2trInputs?: number;
  /**
   * Nested-segwit inputs. Xverse and Magic Eden hand these out as payment
   * addresses, and they are the most expensive kind: the redeemScript rides in
   * the scriptSig, which is not witness-discounted.
   */
  p2shP2wpkhInputs?: number;
  /** Every output's scriptPubKey length, OP_RETURNs included. */
  outputScriptBytes: readonly number[];
}

/** Virtual size in vbytes, rounded up, exactly as Bitcoin Core computes it. */
export function estimateVsize(shape: CoveTxShape): number {
  const inputs =
    shape.vaultInputs * VB_INPUT_VAULT +
    shape.p2wpkhInputs * VB_INPUT_P2WPKH +
    (shape.p2trInputs ?? 0) * VB_INPUT_P2TR_KEYPATH +
    (shape.p2shP2wpkhInputs ?? 0) * VB_INPUT_P2SH_P2WPKH;
  const outputs = shape.outputScriptBytes.reduce((sum, len) => sum + outputVbytes(len), 0);
  return VB_TX_OVERHEAD + inputs + outputs;
}

// ── fee rates ───────────────────────────────────────────────────────────────

export type FeeTierKey = "eco" | "standard" | "priority";

export interface FeeTier {
  key: FeeTierKey;
  label: string;
  /** Confirmation target in blocks that produced this rate. */
  blocks: number;
  satPerVb: bigint;
}

export interface FeeRates {
  /**
   * The lowest rate the node will relay right now, from `getmempoolinfo`.
   * A transaction below this is rejected outright rather than left pending.
   */
  floorSatPerVb: bigint;
  /** Refuse anything above this; it protects against a fat-fingered overpay. */
  ceilingSatPerVb: bigint;
  tiers: FeeTier[];
  /** True when the node had no estimate and the fallback ladder was used. */
  estimated: boolean;
}

/** Absolute floor. Bitcoin's default minimum relay fee is 1 sat/vB. */
export const ABSOLUTE_FLOOR_SAT_PER_VB = 1n;

/**
 * Absolute ceiling. Mainnet has never sustained 500 sat/vB, so anything above
 * it is a bug or a typo rather than a user's intent.
 */
export const ABSOLUTE_CEILING_SAT_PER_VB = 500n;

const TIER_TARGETS: { key: FeeTierKey; label: string; blocks: number }[] = [
  { key: "eco", label: "Eco", blocks: 12 },
  { key: "standard", label: "Standard", blocks: 3 },
  { key: "priority", label: "Priority", blocks: 1 },
];

/** Fallback ladder for a chain with no fee history (regtest, a fresh signet). */
const FALLBACK_SAT_PER_VB: Record<FeeTierKey, bigint> = {
  eco: 2n,
  standard: 5n,
  priority: 10n,
};

/**
 * Ask the node for a real fee rate per tier and for the current relay floor.
 *
 * Transport failures reject the observation. A successful no-estimate response
 * or the signet relay-floor mode uses the fallback ladder.
 *
 * The node is not trusted blindly: every rate is clamped into
 * [floor, ceiling], and the tiers are forced to be non-decreasing so that
 * paying for Priority can never buy a lower rate than Eco.
 */
export async function loadFeeRates(
  provider: CoreRpcProvider,
  options?: RpcReadOptions,
  mode: "node" | "relay-floor-fallback" = "node",
): Promise<FeeRates> {
  const [floor, estimates] = await Promise.all([
    provider.getMempoolMinFeeSatPerVb(options),
    mode === "relay-floor-fallback"
      ? Promise.resolve(TIER_TARGETS.map(() => null))
      : Promise.all(
          TIER_TARGETS.map((target) => provider.estimateFeeRateAt(target.blocks, options)),
        ),
  ]);
  const floorRaw = floor;
  const floorSatPerVb = floorRaw > ABSOLUTE_FLOOR_SAT_PER_VB ? floorRaw : ABSOLUTE_FLOOR_SAT_PER_VB;

  let estimated = false;
  const tiers: FeeTier[] = [];
  let previous = 0n;

  for (const [index, target] of TIER_TARGETS.entries()) {
    let rate = estimates[index] ?? null;
    if (rate === null) {
      estimated = true;
      rate = FALLBACK_SAT_PER_VB[target.key];
    }
    if (rate < floorSatPerVb) rate = floorSatPerVb;
    if (rate > ABSOLUTE_CEILING_SAT_PER_VB) rate = ABSOLUTE_CEILING_SAT_PER_VB;
    if (rate < previous) rate = previous;
    previous = rate;
    tiers.push({ key: target.key, label: target.label, blocks: target.blocks, satPerVb: rate });
  }

  return { floorSatPerVb, ceilingSatPerVb: ABSOLUTE_CEILING_SAT_PER_VB, tiers, estimated };
}

// ── fee resolution ──────────────────────────────────────────────────────────

export interface ResolveMinerFeeInput {
  /** Preferred: the rate the user picked. The server sizes the fee from it. */
  rateSatPerVb?: bigint;
  /** Explicit sats, for callers that size the transaction themselves. */
  explicitSats?: bigint;
  /** The transaction's estimated virtual size. */
  vsize: number;
  floorSatPerVb: bigint;
  ceilingSatPerVb: bigint;
  /** Hard cap in absolute sats, independent of the rate. */
  maxMinerFeeSats: bigint;
}

export interface ResolvedMinerFee {
  minerFeeSats: bigint;
  vsize: number;
  effectiveSatPerVb: bigint;
}

/**
 * Turn a rate (or explicit sats) into the miner fee for this transaction, and
 * refuse both directions of mistake: a fee too low to relay, and a fee so high
 * the user is plainly overpaying by accident.
 */
export function resolveMinerFee(input: ResolveMinerFeeInput): ResolvedMinerFee {
  const vsize = BigInt(Math.max(1, Math.ceil(input.vsize)));

  let minerFeeSats: bigint;
  if (input.rateSatPerVb !== undefined) {
    if (input.rateSatPerVb <= 0n) {
      throw new FeeError("MINER_FEE_TOO_LOW", "fee rate must be positive");
    }
    minerFeeSats = input.rateSatPerVb * vsize;
  } else if (input.explicitSats !== undefined) {
    minerFeeSats = input.explicitSats;
  } else {
    throw new FeeError("MINER_FEE_TOO_LOW", "no fee rate or fee amount supplied");
  }

  // Integer-truncating rate, the same way Bitcoin Core judges relay.
  const effectiveSatPerVb = minerFeeSats / vsize;

  if (effectiveSatPerVb < input.floorSatPerVb) {
    throw new FeeError(
      "MINER_FEE_TOO_LOW",
      `${minerFeeSats} sats over ${vsize} vbytes is ${effectiveSatPerVb} sat/vB, below the ` +
        `network's current relay floor of ${input.floorSatPerVb} sat/vB. This transaction ` +
        `would not confirm. Raise the fee to at least ${input.floorSatPerVb * vsize} sats.`,
    );
  }
  if (effectiveSatPerVb > input.ceilingSatPerVb) {
    throw new FeeError(
      "MINER_FEE_TOO_HIGH",
      `${minerFeeSats} sats over ${vsize} vbytes is ${effectiveSatPerVb} sat/vB, above the ` +
        `${input.ceilingSatPerVb} sat/vB ceiling. Nothing on Bitcoin needs that rate.`,
    );
  }
  if (minerFeeSats > input.maxMinerFeeSats) {
    throw new FeeError(
      "MINER_FEE_TOO_HIGH",
      `miner fee ${minerFeeSats} sats exceeds the ${input.maxMinerFeeSats}-sat cap`,
    );
  }

  return { minerFeeSats, vsize: Number(vsize), effectiveSatPerVb };
}
