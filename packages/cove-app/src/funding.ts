import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { walletFundingSnapshot, type Database } from "@crclaunch/db";
import type { FundingInputChecker } from "@crclaunch/cove-guardian/v3";
import { AppError } from "./errors.js";

/**
 * Funding resolution (§18/§73). Browser submits only (txid, vout); the server
 * resolves actual script + value via Core (authoritative unspent check) and
 * matches the script to the connected wallet's payment script. Browser-supplied
 * value/script are never trusted.
 */

export interface FundingCandidate {
  txid: string;
  vout: number;
}

export const MAX_FUNDING_INPUTS = 64;
const FUNDING_LOOKUP_CONCURRENCY = 4;
const GLOBAL_FUNDING_LOOKUP_CONCURRENCY = 16;
const MAX_PENDING_FUNDING_LOOKUPS = 128;
let activeFundingLookups = 0;
const fundingLookupWaiters: Array<() => void> = [];

async function withFundingLookupSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeFundingLookups < GLOBAL_FUNDING_LOOKUP_CONCURRENCY) {
    activeFundingLookups++;
  } else {
    if (fundingLookupWaiters.length >= MAX_PENDING_FUNDING_LOOKUPS) {
      throw new AppError("CORE_UNAVAILABLE", "funding lookup capacity is full; retry shortly");
    }
    // The releasing lookup transfers its slot to the oldest waiter.
    await new Promise<void>((resolve) => fundingLookupWaiters.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = fundingLookupWaiters.shift();
    if (next) next();
    else activeFundingLookups--;
  }
}

export function validateFundingCandidates(candidates: FundingCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length > MAX_FUNDING_INPUTS) {
    throw new AppError(
      "FUNDING_INPUT_INVALID",
      `at most ${MAX_FUNDING_INPUTS} funding inputs are allowed`,
    );
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.txid !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(candidate.txid) ||
      !Number.isInteger(candidate.vout) ||
      candidate.vout < 0 ||
      candidate.vout > 0xffff_ffff
    ) {
      throw new AppError(
        "FUNDING_INPUT_INVALID",
        "funding outpoint must be a 64-hex txid and a valid vout",
      );
    }
    const key = `${candidate.txid.toLowerCase()}:${candidate.vout}`;
    if (seen.has(key)) throw new AppError("FUNDING_INPUT_INVALID", "duplicate funding outpoint");
    seen.add(key);
  }
}

export interface ResolvedFunding {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  /** 0 while in the mempool. */
  confirmations: number;
}

export async function resolveFundingUtxo(
  provider: CoreRpcProvider,
  c: FundingCandidate,
): Promise<ResolvedFunding> {
  const txout = await provider.getTxout(c.txid, c.vout);
  if (!txout)
    throw new AppError("FUNDING_INPUT_SPENT", `input ${c.txid}:${c.vout} is spent or unknown`);
  return {
    txid: c.txid,
    vout: c.vout,
    script: Buffer.from(txout.scriptPubKeyHex, "hex"),
    valueSats: txout.valueSats,
    confirmations: txout.confirmations,
  };
}

export async function resolveFundingUtxos(
  provider: CoreRpcProvider,
  candidates: FundingCandidate[],
): Promise<ResolvedFunding[]> {
  validateFundingCandidates(candidates);
  const resolved = new Array<ResolvedFunding>(candidates.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(FUNDING_LOOKUP_CONCURRENCY, candidates.length) },
    async () => {
      while (next < candidates.length) {
        const index = next++;
        resolved[index] = await withFundingLookupSlot(() =>
          resolveFundingUtxo(provider, candidates[index]!),
        );
      }
    },
  );
  await Promise.all(workers);
  return resolved;
}

/** Deterministic funding selection: fewest-inputs-first (largest first), ties by txid/vout. */
export function selectFunding(utxos: ResolvedFunding[], requiredSats: bigint): ResolvedFunding[] {
  const sorted = [...utxos].sort((a, b) => {
    if (a.valueSats !== b.valueSats) return a.valueSats > b.valueSats ? -1 : 1;
    if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
    return a.vout - b.vout;
  });
  const selected: ResolvedFunding[] = [];
  let sum = 0n;
  for (const u of sorted) {
    selected.push(u);
    sum += u.valueSats;
    if (sum >= requiredSats) return selected;
  }
  throw new AppError("INSUFFICIENT_BTC", `wallet has ${sum} sats but ${requiredSats} required`);
}

export async function resolveCachedFundingUtxos(
  db: Database,
  network: string,
  walletScript: string,
  candidates: FundingCandidate[],
): Promise<ResolvedFunding[]> {
  validateFundingCandidates(candidates);
  if (!candidates.length) return [];
  const coins = await walletFundingSnapshot(db, network, walletScript);
  const byOutpoint = new Map(
    coins?.map((coin) => [`${coin.txid.toLowerCase()}:${coin.vout}`, coin]),
  );
  return candidates.map((candidate) => {
    const coin = byOutpoint.get(`${candidate.txid.toLowerCase()}:${candidate.vout}`);
    if (!coin)
      throw new AppError(
        "FUNDING_INPUT_INVALID",
        "wallet funding data is missing; refresh your wallet and retry",
      );
    return {
      txid: coin.txid,
      vout: coin.vout,
      script: Buffer.from(walletScript, "hex"),
      valueSats: BigInt(coin.valueSats),
      confirmations: coin.confirmations,
    };
  });
}

export function cachedBuildFundingChecker(inputs: ResolvedFunding[]): FundingInputChecker {
  const coins = new Map(inputs.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
  return {
    async check(point, _height, expected) {
      const coin = coins.get(`${point.txid}:${point.vout}`);
      if (!coin || coin.confirmations < 1)
        return {
          ok: false,
          code: "FUNDING_UNCONFIRMED",
          detail: "funding is not confirmed in the wallet cache",
        };
      if (
        !expected ||
        !coin.script.equals(expected.script) ||
        coin.valueSats !== expected.valueSats
      )
        return {
          ok: false,
          code: "FUNDING_PREVOUT_MISMATCH",
          detail: "funding does not match the wallet cache",
        };
      return { ok: true };
    },
  };
}
