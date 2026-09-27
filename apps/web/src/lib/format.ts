/** Client-safe formatting helpers (no server-only deps). All inputs are strings/bigints. */

const ATOMS_PER_TOKEN = 100_000_000n;

/** A token is divisible to 8 decimal places; one atom is the smallest unit. */
export const TOKEN_DECIMALS = 8;

/**
 * Convert a display-token decimal string to an atom-string (no floats).
 *
 * More than 8 decimal places is REJECTED rather than truncated. Silently
 * dropping the excess would take value off the user without telling them —
 * paste an amount copied from somewhere with finer precision and part of it
 * would vanish into the fee with no warning anywhere in the interface.
 * Refusing is annoying; losing someone's money quietly is worse.
 */
export function displayTokensToAtoms(input: string): string {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid token amount");
  const parts = s.split(".");
  const whole = parts[0] || "0";
  const rawFrac = parts[1] ?? "";
  if (rawFrac.length > TOKEN_DECIMALS) {
    throw new Error(
      `a token divides to ${TOKEN_DECIMALS} decimal places; "${s}" has ${rawFrac.length}`,
    );
  }
  const frac = rawFrac.padEnd(TOKEN_DECIMALS, "0") || "0";
  return (BigInt(whole) * ATOMS_PER_TOKEN + BigInt(frac)).toString();
}

/** Exact token amount for editable fields; abbreviated labels can lose atoms. */
export function atomsToDisplayTokens(atoms: string | bigint): string {
  const n = BigInt(atoms);
  const whole = n / ATOMS_PER_TOKEN;
  const fraction = n % ATOMS_PER_TOKEN;
  return fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "")}`;
}

export function fmtInt(v: string | bigint | number): string {
  const n = typeof v === "string" ? BigInt(v) : BigInt(v);
  return n.toLocaleString("en-US");
}

export function fmtSats(v: string | bigint | number): string {
  return `${fmtInt(v)} sats`;
}

export function fmtBtc(sats: string | bigint | number): string {
  const s = BigInt(sats);
  const sign = s < 0n ? "-" : "";
  const abs = s < 0n ? -s : s;
  const whole = abs / 100_000_000n;
  const frac = abs % 100_000_000n;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${fracStr ? "." + fracStr : ""} BTC`;
}

/**
 * Abbreviate an ATOM amount as whole display tokens.
 *
 * The input is atoms (1 token = 1e8 atoms), so it must be scaled down before
 * the magnitude buckets are applied — otherwise the public cap of 840,000,000
 * tokens (8.4e16 atoms) renders as "84000000B" instead of "840M". One decimal
 * is kept, via integer arithmetic only: no floats touch a token amount.
 */
export function fmtTokens(atoms: string | bigint): string {
  const tokens = BigInt(atoms) / ATOMS_PER_TOKEN;
  // ×10 throughout preserves exactly one decimal place without floating point.
  if (tokens >= 1_000_000_000n) return `${trim((tokens * 10n) / 1_000_000_000n)}B`;
  if (tokens >= 1_000_000n) return `${trim((tokens * 10n) / 1_000_000n)}M`;
  if (tokens >= 1_000n) return `${trim((tokens * 10n) / 1_000n)}K`;
  return tokens.toString();
}

export function fmtPricePerMillion(sats: string | bigint | number): string {
  return `${fmtInt(sats)} sats / 1k`;
}

function trim(n: bigint): string {
  // n is already ×10 to preserve one decimal (e.g. 5292 => 529.2).
  const whole = n / 10n;
  const dec = n % 10n;
  return dec === 0n ? whole.toString() : `${whole}.${dec}`;
}

export function fmtProgressBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}
