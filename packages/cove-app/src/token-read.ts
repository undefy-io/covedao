import { eq, and, isNull, count, countDistinct, min, desc, ilike, or, inArray } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { ATOMS_PER_TOKEN, PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";
import { getTokenHoldersDb, getTokenActivityDb } from "@crclaunch/cove-indexer/v3";
import { listTokenMetadataByTokenIds } from "./metadata.js";

/**
 * V3 read models (§64-§67). Derived ONLY from canonical V3 chain tables +
 * off-chain metadata + confirmed market trades. No legacy `tokens`/balances.
 */

export interface V3TokenSummary {
  tokenId: string;
  ticker: string;
  displayName: string;
  description: string;
  deployTxid: string;
  deployHeight: bigint;
  policyVersion: number;
  issuedSupplyAtoms: bigint;
  publicCapAtoms: bigint;
  remainingCapacityAtoms: bigint;
  /**
   * The public cap is fully minted — the token has graduated.
   *
   * Derived here rather than stored so there is exactly one definition of
   * "graduated" and no row can drift out of agreement with the supply it was
   * derived from. Graduation is a milestone, not a mechanism: the backing vault
   * keeps buying and selling afterwards exactly as before, so nothing a holder
   * relies on changes at the moment it flips.
   */
  graduated: boolean;
  backingSats: bigint;
  backingOutpoint: { txid: string; vout: number };
  stateHash: string;
  curveStage: number;
  holderCount: number;
  bestAskSats: bigint | null;
  activeListingCount: number;
  websiteUrl: string | null;
  xUrl: string | null;
  imageUrl: string | null;
}

async function loadSummaries(db: Database, network: string, tokenIds?: string[]): Promise<V3TokenSummary[]> {
  const tokenCond = tokenIds ? and(eq(schema.coveV3Tokens.network, network), eq(schema.coveV3Tokens.canonical, true), inArray(schema.coveV3Tokens.tokenId, tokenIds)) : and(eq(schema.coveV3Tokens.network, network), eq(schema.coveV3Tokens.canonical, true));
  const tokens = await db.select().from(schema.coveV3Tokens).where(tokenCond);
  const ids = tokens.map((t) => t.tokenId);
  const backing = ids.length === 0 ? [] : await db
    .select()
    .from(schema.coveV3BackingStates)
    .where(and(eq(schema.coveV3BackingStates.network, network), eq(schema.coveV3BackingStates.canonical, true), inArray(schema.coveV3BackingStates.tokenId, ids)));
  const backingByToken = new Map(backing.map((b) => [b.tokenId, b]));
  const metas = ids.length > 0 ? await listTokenMetadataByTokenIds(db, network, ids) : [];
  const metaByToken = new Map(metas.map((m) => [m.tokenId, m]));

  // Aggregated holder counts + best asks + active listing counts.
  const holderRows = ids.length > 0
    ? await db
        .select({ tokenId: schema.coveV3TokenUtxos.tokenId, n: countDistinct(schema.coveV3TokenUtxos.scriptPubKey) })
        .from(schema.coveV3TokenUtxos)
        .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.canonical, true), isNull(schema.coveV3TokenUtxos.spentByTxid), inArray(schema.coveV3TokenUtxos.tokenId, ids)))
        .groupBy(schema.coveV3TokenUtxos.tokenId)
    : [];
  const holdersByToken = new Map(holderRows.map((r) => [r.tokenId, Number(r.n)]));

  const askRows = ids.length > 0
    ? await db
        .select({ tokenId: schema.coveV3MarketListings.tokenId, best: min(schema.coveV3MarketListings.totalPriceSats), cnt: count() })
        .from(schema.coveV3MarketListings)
        .where(and(eq(schema.coveV3MarketListings.network, network), eq(schema.coveV3MarketListings.status, "ACTIVE"), inArray(schema.coveV3MarketListings.tokenId, ids)))
        .groupBy(schema.coveV3MarketListings.tokenId)
    : [];
  const askByToken = new Map(askRows.map((r) => [r.tokenId, { best: r.best, cnt: Number(r.cnt) }]));

  return tokens.map((t) => {
    const b = backingByToken.get(t.tokenId);
    const candidateMeta = metaByToken.get(t.tokenId);
    const meta = candidateMeta?.deployTxid === t.deployTxid ? candidateMeta : null;
    const ask = askByToken.get(t.tokenId);
    return {
      tokenId: t.tokenId,
      ticker: t.ticker,
      displayName: meta?.displayName ?? t.ticker,
      description: meta?.description ?? "",
      deployTxid: t.deployTxid,
      deployHeight: t.deployHeight,
      policyVersion: t.policyVersion,
      issuedSupplyAtoms: b?.issuedSupplyAtoms ?? 0n,
      publicCapAtoms: PUBLIC_SUPPLY_ATOMS,
      remainingCapacityAtoms: (b ? PUBLIC_SUPPLY_ATOMS - b.issuedSupplyAtoms : 0n) < 0n ? 0n : PUBLIC_SUPPLY_ATOMS - (b?.issuedSupplyAtoms ?? 0n),
      graduated: (b?.issuedSupplyAtoms ?? 0n) >= PUBLIC_SUPPLY_ATOMS,
      backingSats: b?.backingSats ?? 0n,
      backingOutpoint: b ? { txid: b.txid, vout: b.vout } : { txid: "", vout: 0 },
      stateHash: b?.stateHash ?? "",
      curveStage: b?.curveStage ?? 0,
      holderCount: holdersByToken.get(t.tokenId) ?? 0,
      bestAskSats: ask?.best ?? null,
      activeListingCount: ask?.cnt ?? 0,
      websiteUrl: meta?.websiteUrl ?? null,
      xUrl: meta?.xUrl ?? null,
      imageUrl: meta?.imageUrl ?? null,
    };
  });
}

export async function listV3Tokens(db: Database, network: string, opts: { ticker?: string; search?: string; limit?: number } = {}): Promise<V3TokenSummary[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  let tokenIds: string[] | undefined;
  if (opts.ticker || opts.search) {
    const q = opts.search ?? opts.ticker;
    const cond = q
      ? or(ilike(schema.coveV3Tokens.ticker, `%${q.toUpperCase()}%`), ilike(schema.coveV3Tokens.tokenId, `${q.toLowerCase()}%`))
      : eq(schema.coveV3Tokens.ticker, opts.ticker!.toUpperCase());
    const rows = await db
      .select({ tokenId: schema.coveV3Tokens.tokenId })
      .from(schema.coveV3Tokens)
      .where(and(eq(schema.coveV3Tokens.network, network), eq(schema.coveV3Tokens.canonical, true), cond))
      .orderBy(desc(schema.coveV3Tokens.deployHeight))
      .limit(limit);
    tokenIds = rows.map((r) => r.tokenId);
  } else {
    const rows = await db
      .select({ tokenId: schema.coveV3Tokens.tokenId })
      .from(schema.coveV3Tokens)
      .where(and(eq(schema.coveV3Tokens.network, network), eq(schema.coveV3Tokens.canonical, true)))
      .orderBy(desc(schema.coveV3Tokens.deployHeight))
      .limit(limit);
    tokenIds = rows.map((r) => r.tokenId);
  }
  const summaries = await loadSummaries(db, network, tokenIds.length > 0 ? tokenIds : ["0".repeat(64)]);
  const byId = new Map(summaries.map((s) => [s.tokenId, s]));
  return tokenIds.map((id) => byId.get(id)!).filter(Boolean);
}

export async function getV3TokenDetail(db: Database, network: string, tokenId: string): Promise<V3TokenSummary | null> {
  const rows = await loadSummaries(db, network, [tokenId]);
  return rows[0] ?? null;
}

export async function getTokenHolders(db: Database, network: string, tokenId: string, limit = 100, offset = 0) {
  return getTokenHoldersDb(db, network, tokenId, limit, offset);
}

export async function getTokenActivity(db: Database, network: string, tokenId: string, limit = 100) {
  return getTokenActivityDb(db, network, tokenId, limit);
}

export { ATOMS_PER_TOKEN };
