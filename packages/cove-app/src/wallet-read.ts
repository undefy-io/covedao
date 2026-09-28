import { eq, and, or, inArray, asc, desc, sum, count, isNull } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { getTokenUtxosByScriptDb, getBalanceByScriptDb } from "@crclaunch/cove-indexer/v3";

export interface Holding {
  tokenId: string;
  amountAtoms: bigint;
  utxoCount: number;
}

export async function getWalletPortfolio(db: Database, network: string, walletScript: string, opts: { limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  // Aggregate balances independently: a page of spendable outputs must never
  // silently become a wallet's total balance.
  const holdingRows = await db.select({ tokenId: schema.coveV3TokenUtxos.tokenId,
    amountAtoms: sum(schema.coveV3TokenUtxos.amountAtoms), utxoCount: count() })
    .from(schema.coveV3TokenUtxos)
    .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.scriptPubKey, walletScript),
      eq(schema.coveV3TokenUtxos.canonical, true), isNull(schema.coveV3TokenUtxos.spentByTxid)))
    .groupBy(schema.coveV3TokenUtxos.tokenId).orderBy(asc(schema.coveV3TokenUtxos.tokenId))
    .limit(limit + 1).offset(offset);
  const holdings: Holding[] = holdingRows.slice(0, limit).map((r) => ({ ...r, amountAtoms: BigInt(r.amountAtoms ?? "0"), utxoCount: Number(r.utxoCount) }));
  const utxos = await getTokenUtxosByScriptDb(db, network, walletScript, { limit: limit + 1, offset });
  const sellerListings = db.select({ listingId: schema.coveV3MarketListings.listingId })
    .from(schema.coveV3MarketListings)
    .where(and(eq(schema.coveV3MarketListings.network, network),
      or(eq(schema.coveV3MarketListings.sellerTokenScript, walletScript), eq(schema.coveV3MarketListings.sellerPayoutScript, walletScript))));
  const listingRows = await db.select().from(schema.coveV3MarketListings)
    .where(and(eq(schema.coveV3MarketListings.network, network),
      or(eq(schema.coveV3MarketListings.sellerTokenScript, walletScript), eq(schema.coveV3MarketListings.sellerPayoutScript, walletScript))))
    .orderBy(desc(schema.coveV3MarketListings.createdAt), desc(schema.coveV3MarketListings.listingId)).limit(limit + 1).offset(offset);
  const fills = await db.select().from(schema.coveV3MarketFills)
    .where(and(eq(schema.coveV3MarketFills.network, network),
      or(eq(schema.coveV3MarketFills.buyerTokenScript, walletScript), eq(schema.coveV3MarketFills.buyerChangeScript, walletScript),
        inArray(schema.coveV3MarketFills.listingId, sellerListings))))
    .orderBy(desc(schema.coveV3MarketFills.createdAt), desc(schema.coveV3MarketFills.id)).limit(limit + 1).offset(offset);
  const listings = listingRows.slice(0, limit).map(({ sellerPresignedPsbt: _secret, ...rest }) => { void _secret; return rest; });
  return {
    walletScript, holdings,
    tokenUtxos: utxos.slice(0, limit).map((u) => ({ txid: u.txid, vout: u.vout, tokenId: u.tokenId, amountAtoms: u.amountAtoms, scriptPubKey: u.scriptPubKey })),
    listings, fills: fills.slice(0, limit).map((fill) => ({
      id: fill.id, listingId: fill.listingId, tokenId: fill.tokenId, status: fill.status,
      amountAtoms: fill.amountAtoms, totalPriceSats: fill.totalPriceSats, marketFeeSats: fill.marketFeeSats,
      minerFeeSats: fill.minerFeeSats, txid: fill.txid, blockHeight: fill.blockHeight,
      canonical: fill.canonical, createdAt: fill.createdAt, updatedAt: fill.updatedAt,
    })),
    pagination: { limit, offset, hasMore: { holdings: holdingRows.length > limit, tokenUtxos: utxos.length > limit, listings: listingRows.length > limit, fills: fills.length > limit } },
  };
}

export async function getWalletBalanceAtoms(db: Database, network: string, tokenId: string, walletScript: string): Promise<bigint> {
  return getBalanceByScriptDb(db, network, tokenId, walletScript);
}
