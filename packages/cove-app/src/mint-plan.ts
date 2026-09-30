import { grossBuy } from "@crclaunch/cove-economics";
import { ATOMS_PER_TOKEN, LOT_TOKENS, PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";

/**
 * Split a mint that is bigger than one mint may be into several mints.
 *
 * One mint has a limit (curve price, token count). A buyer who asks for more
 * gets several mints instead, each one as large as the limit allows at the
 * price it will actually pay. Each part is a separate transaction that spends
 * the vault the one before it made, so the price climbs from part to part
 * exactly as it would for one big mint.
 */

/** Hard stop on the number of parts, well inside the pending-vault chain limit. */
export const MAX_MINT_PARTS = 10;

const LOT_ATOMS = LOT_TOKENS * ATOMS_PER_TOKEN;

export class MintPlanError extends Error {
  readonly code = "TOKEN_AMOUNT_INVALID";
}

export function splitMint(params: {
  supplyAtoms: bigint;
  amountAtoms: bigint;
  limits: { maxMintAtoms: bigint; maxGrossSats: bigint | null; minGrossSats: bigint };
  maxParts?: number;
}): bigint[] {
  const { amountAtoms, limits } = params;
  const maxParts = params.maxParts ?? MAX_MINT_PARTS;
  if (amountAtoms <= 0n || amountAtoms % LOT_ATOMS !== 0n)
    throw new MintPlanError("backing buy requires whole 1,000-token lots");
  if (params.supplyAtoms + amountAtoms > PUBLIC_SUPPLY_ATOMS) throw new MintPlanError("exceeds public cap");

  const grossOf = (supplyAtoms: bigint, lots: bigint) =>
    grossBuy(supplyAtoms / ATOMS_PER_TOKEN, lots * LOT_TOKENS);
  const fits = (supplyAtoms: bigint, lots: bigint) =>
    lots * LOT_ATOMS <= limits.maxMintAtoms &&
    (limits.maxGrossSats === null || grossOf(supplyAtoms, lots) <= limits.maxGrossSats);

  const parts: bigint[] = [];
  let supply = params.supplyAtoms;
  let remainingLots = amountAtoms / LOT_ATOMS;
  while (remainingLots > 0n) {
    if (parts.length === maxParts)
      throw new MintPlanError(`that is more than ${maxParts} mints; mint less at a time`);
    // The price only rises with the amount, so the largest part that fits is
    // found by bisection.
    let lo = 0n;
    let hi = remainingLots;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (fits(supply, mid)) lo = mid;
      else hi = mid - 1n;
    }
    if (lo === 0n) throw new MintPlanError("one lot already exceeds the per-mint limit");
    if (grossOf(supply, lo) < limits.minGrossSats)
      throw new MintPlanError("below the minimum mint curve price");
    parts.push(lo * LOT_ATOMS);
    supply += lo * LOT_ATOMS;
    remainingLots -= lo;
  }
  return parts;
}
