import { eq, and, isNull, asc, sum } from "drizzle-orm";
import { schema, effectiveBackingObservation, type Database } from "@crclaunch/db";
import { ATOMS_PER_TOKEN, LOT_TOKENS, PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";
import { MarketError } from "./errors.js";
import { COVE_FEE_CONFIG, creatorFeeSats, deterministicFee, mintFeeSats, grossBuy, quoteRedeem } from "@crclaunch/cove-economics";

/**
 * Best execution (§30): READ-ONLY comparison of the P2P fixed-price protocol
 * cost vs the backing (primary issuance / instant redeem) cost. Quotes never
 * reserve, never sign, never broadcast. All arithmetic is bigint-only.
 */

export interface BackingBuyBreakdown {
  grossSats: bigint;
  buyFeeSats: bigint;
  feeBps: bigint;
}

export interface P2PBuyBreakdown {
  listingId: string;
  sellerPriceSats: bigint;
  marketFeeSats: bigint;
  feeBps: bigint;
}

export type BuyRoute =
  | { kind: "backing"; amountAtoms: bigint; totalCostSats: bigint; breakdown: BackingBuyBreakdown }
  | { kind: "p2p"; amountAtoms: bigint; totalCostSats: bigint; breakdown: P2PBuyBreakdown };

/** Protocol fee schedule a buy-route quote must use (matches what the fill charges). */
export interface BuyRouteFees {
  buyFeeBps: bigint;
  p2pFeeBps: bigint;
  /** Flat buy fee at the top stage, scaled down by stage; defaults to the live schedule. */
  buyFeeFlatSats?: bigint;
  /** Market fee floor; defaults to the live schedule. */
  p2pFeeMinSats?: bigint;
}

export interface SellOption {
  kind: "backing" | "listable-utxo";
  amountAtoms: bigint;
  netSats: bigint;
  grossSats: bigint;
  feeSats: bigint;
  /** For backing: the redeem quote; for utxo: 0n (no protocol redeem fee on a list). */
  listingId?: string;
  txid?: string;
  vout?: number;
}

/**
 * Compare all ways a buyer can obtain `amountAtoms` of `tokenId`, cheapest
 * first. Backing requires a whole-lot amount; P2P (V1) is all-or-none so only
 * listings whose amount exactly equals the request are candidates.
 */
export async function getBuyRoutes(
  db: Database,
  network: string,
  tokenId: string,
  amountAtoms: bigint,
  fees: BuyRouteFees = { buyFeeBps: COVE_FEE_CONFIG.buyFeeBps, p2pFeeBps: COVE_FEE_CONFIG.p2pFeeBps },
): Promise<BuyRoute[]> {
  const routes: BuyRoute[] = [];

  // Backing route (primary issuance) — whole mint lots only.
  if (amountAtoms > 0n && amountAtoms % (LOT_TOKENS * ATOMS_PER_TOKEN) === 0n) {
    const backing = await effectiveBackingObservation(db, network, tokenId);
    if (!backing) throw new MarketError("TOKEN_NOT_FOUND", "token not found");
    if (!backing.fresh || !backing.payload)
      throw new MarketError("CORE_UNAVAILABLE", "a fresh validated backing observation is not available; retry shortly");
    const supplyAtoms = BigInt(backing.payload.issuedSupplyAtoms);
    if (supplyAtoms + amountAtoms <= PUBLIC_SUPPLY_ATOMS) {
      const grossSats = grossBuy(supplyAtoms / ATOMS_PER_TOKEN, amountAtoms / ATOMS_PER_TOKEN);
      // The same fee the buy transaction will charge — flat, per lot and
      // percentage. Quoting the percentage alone ranked the vault as cheaper
      // than it is.
      const buyFeeSats = mintFeeSats(grossSats, amountAtoms, fees.buyFeeBps, fees.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats);
      // The creator's share is part of what a mint costs.
      const creatorSats = creatorFeeSats(grossSats);
      routes.push({
        kind: "backing",
        amountAtoms,
        totalCostSats: grossSats + buyFeeSats + creatorSats,
        breakdown: { grossSats, buyFeeSats, feeBps: fees.buyFeeBps },
      });
    }
  }

  // P2P route — V1 all-or-none: only listings with amountAtoms === request.
  const listings = await db
    .select()
    .from(schema.coveV3MarketListings)
    .where(
      and(
        eq(schema.coveV3MarketListings.network, network),
        eq(schema.coveV3MarketListings.tokenId, tokenId),
        eq(schema.coveV3MarketListings.status, "ACTIVE"),
        eq(schema.coveV3MarketListings.amountAtoms, amountAtoms),
      ),
    )
    .orderBy(asc(schema.coveV3MarketListings.totalPriceSats), asc(schema.coveV3MarketListings.listingId))
    .limit(100);
  for (const l of listings) {
    const marketFeeSats = deterministicFee(l.totalPriceSats, fees.p2pFeeBps, 0n, fees.p2pFeeMinSats ?? COVE_FEE_CONFIG.p2pFeeMinSats);
    routes.push({
      kind: "p2p",
      amountAtoms,
      totalCostSats: l.totalPriceSats + marketFeeSats,
      breakdown: {
        listingId: l.listingId,
        sellerPriceSats: l.totalPriceSats,
        marketFeeSats,
        feeBps: fees.p2pFeeBps,
      },
    });
  }

  routes.sort((a, b) => (a.totalCostSats < b.totalCostSats ? -1 : a.totalCostSats > b.totalCostSats ? 1 : 0));
  return routes;
}

/**
 * Compare how an owner can exit: the backing instant-redeem quote (whole-token
 * balance) vs listing their actual token UTXOs P2P.
 */
export async function getSellOptions(
  db: Database,
  network: string,
  tokenId: string,
  ownerScript: string,
  redeemFeeBps: bigint = COVE_FEE_CONFIG.redeemFeeBps,
): Promise<{ redeemQuote: SellOption | null; listableUtxos: SellOption[]; listableUtxosHasMore: boolean }> {
  const balanceRows = await db.select({ balanceAtoms: sum(schema.coveV3TokenUtxos.amountAtoms) })
    .from(schema.coveV3TokenUtxos)
    .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.tokenId, tokenId),
      eq(schema.coveV3TokenUtxos.scriptPubKey, ownerScript), eq(schema.coveV3TokenUtxos.canonical, true), isNull(schema.coveV3TokenUtxos.spentByTxid)));
  const utxos = await db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.tokenId, tokenId),
        eq(schema.coveV3TokenUtxos.scriptPubKey, ownerScript),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    )
    .orderBy(asc(schema.coveV3TokenUtxos.txid), asc(schema.coveV3TokenUtxos.vout))
    .limit(201);

  const listableUtxos: SellOption[] = utxos.slice(0, 200).map((u) => ({
    kind: "listable-utxo",
    amountAtoms: u.amountAtoms,
    netSats: 0n,
    grossSats: 0n,
    feeSats: 0n,
    txid: u.txid,
    vout: u.vout,
  }));

  const balanceAtoms = BigInt(balanceRows[0]?.balanceAtoms ?? "0");
  let redeemQuote: SellOption | null = null;
  if (balanceAtoms > 0n && balanceAtoms % ATOMS_PER_TOKEN === 0n) {
    const backing = await db
      .select({ supplyAtoms: schema.coveV3BackingStates.issuedSupplyAtoms })
      .from(schema.coveV3BackingStates)
      .where(
        and(
          eq(schema.coveV3BackingStates.network, network),
          eq(schema.coveV3BackingStates.tokenId, tokenId),
          eq(schema.coveV3BackingStates.canonical, true),
        ),
      );
    const supplyAtoms = backing[0]?.supplyAtoms ?? 0n;
    if (balanceAtoms <= supplyAtoms) {
      const q = quoteRedeem(supplyAtoms / ATOMS_PER_TOKEN, balanceAtoms / ATOMS_PER_TOKEN, { ...COVE_FEE_CONFIG, redeemFeeBps });
      redeemQuote = {
        kind: "backing",
        amountAtoms: balanceAtoms,
        netSats: q.net,
        grossSats: q.gross,
        feeSats: q.fee,
      };
    }
  }

  return { redeemQuote, listableUtxos, listableUtxosHasMore: utxos.length > 200 };
}
