import { eq, and, or, isNull, desc, asc, sum, count, countDistinct } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { balanceByScript, currentBacking, tokenHolders, tokenUtxosByScript, type TokenDetail } from "./read-models.js";

/**
 * Production DB read-model adapters (§12). Every balance query uses ONLY
 * canonical=true AND spentByTxid IS NULL — never a legacy balance table.
 */

export async function getTokenUtxosByScriptDb(db: Database, network: string, scriptPubKey: string, page?: { limit: number; offset?: number }) {
  const query = db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.scriptPubKey, scriptPubKey),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    )
    .orderBy(asc(schema.coveV3TokenUtxos.txid), asc(schema.coveV3TokenUtxos.vout));
  return page ? query.limit(Math.max(1, Math.min(page.limit, 501))).offset(Math.max(0, page.offset ?? 0)) : query;
}

/**
 * The live token UTXOs among `outpoints`. Used to refuse a token carrier as
 * BTC funding: spending one in a buy or sell would burn the tokens it holds.
 */
export async function getLiveTokenUtxosAtDb(db: Database, network: string, outpoints: { txid: string; vout: number }[]) {
  if (outpoints.length === 0) return [];
  return db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
        or(...outpoints.map((o) => and(eq(schema.coveV3TokenUtxos.txid, o.txid), eq(schema.coveV3TokenUtxos.vout, o.vout)))),
      ),
    );
}

export async function getBalanceByScriptDb(db: Database, network: string, tokenId: string, scriptPubKey: string): Promise<bigint> {
  const rows = await db.select({ amountAtoms: sum(schema.coveV3TokenUtxos.amountAtoms) })
    .from(schema.coveV3TokenUtxos)
    .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.tokenId, tokenId),
      eq(schema.coveV3TokenUtxos.scriptPubKey, scriptPubKey), eq(schema.coveV3TokenUtxos.canonical, true),
      isNull(schema.coveV3TokenUtxos.spentByTxid)));
  return BigInt(rows[0]?.amountAtoms ?? "0");
}

export async function getTokenHoldersDb(db: Database, network: string, tokenId: string, limit = 100, offset = 0) {
  const amount = sum(schema.coveV3TokenUtxos.amountAtoms);
  const rows = await db.select({ scriptPubKey: schema.coveV3TokenUtxos.scriptPubKey, amountAtoms: amount })
    .from(schema.coveV3TokenUtxos)
    .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.tokenId, tokenId),
      eq(schema.coveV3TokenUtxos.canonical, true), isNull(schema.coveV3TokenUtxos.spentByTxid)))
    .groupBy(schema.coveV3TokenUtxos.scriptPubKey)
    .orderBy(desc(amount), asc(schema.coveV3TokenUtxos.scriptPubKey))
    .limit(Math.max(1, Math.min(limit, 200))).offset(Math.max(0, offset));
  return rows.map((row) => ({ scriptPubKey: row.scriptPubKey, amountAtoms: BigInt(row.amountAtoms ?? "0") }));
}

export async function getCurrentBackingDb(db: Database, network: string, tokenId: string) {
  return db
    .select()
    .from(schema.coveV3BackingStates)
    .where(
      and(
        eq(schema.coveV3BackingStates.network, network),
        eq(schema.coveV3BackingStates.tokenId, tokenId),
        eq(schema.coveV3BackingStates.canonical, true),
      ),
    );
}

export async function getTokenDetailDb(db: Database, network: string, tokenId: string, publicCapAtoms: bigint): Promise<TokenDetail | null> {
  const token = await db.select().from(schema.coveV3Tokens).where(and(eq(schema.coveV3Tokens.network, network), eq(schema.coveV3Tokens.tokenId, tokenId), eq(schema.coveV3Tokens.canonical, true)));
  const backing = await db.select().from(schema.coveV3BackingStates).where(and(eq(schema.coveV3BackingStates.network, network), eq(schema.coveV3BackingStates.tokenId, tokenId), eq(schema.coveV3BackingStates.canonical, true)));
  const counts = await db.select({ holders: countDistinct(schema.coveV3TokenUtxos.scriptPubKey), utxos: count() })
    .from(schema.coveV3TokenUtxos)
    .where(and(eq(schema.coveV3TokenUtxos.network, network), eq(schema.coveV3TokenUtxos.tokenId, tokenId), eq(schema.coveV3TokenUtxos.canonical, true), isNull(schema.coveV3TokenUtxos.spentByTxid)));
  if (token.length === 0 || backing.length === 0) return null;
  const t = token[0]!;
  const b = backing[0]!;
  const detail = currentBacking(
    {
      tokenId: t.tokenId,
      ticker: t.ticker,
      policyVersion: t.policyVersion,
      tokenNonce: t.nonce,
      deployTxid: t.deployTxid,
      deployHeight: t.deployHeight,
      deployBlockHash: t.deployBlockHash,
      creatorScript: t.creatorScript,
    },
    {
      tokenId: b.tokenId,
      state: {
        stateVersion: b.stateVersion as 2,
        policyVersion: b.policyVersion,
        tokenId: b.tokenId,
        issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
        backingSats: b.backingSats,
        curveStage: b.curveStage,
      },
      stateHash: b.stateHash,
      outpoint: { txid: b.txid, vout: b.vout },
      scriptPubKey: b.scriptPubKey,
      btcValue: b.btcValue,
      updatedTxid: b.txid,
      updatedHeight: b.blockHeight,
      updatedBlockHash: b.blockHash,
    },
    [],
    publicCapAtoms,
  );
  return { ...detail, holderCount: Number(counts[0]?.holders ?? 0), tokenUtxoCount: Number(counts[0]?.utxos ?? 0) };
}

/**
 * One token's confirmed history, newest first.
 *
 * Ordering and the limit belong in the query, not in the caller: this used to
 * return every event a token had ever produced in whatever order the database
 * felt like, and the caller then sliced the first hundred — which is to say a
 * hundred arbitrary events, not the hundred most recent.
 */
export async function getTokenActivityDb(
  db: Database,
  network: string,
  tokenId: string,
  limit = 100,
) {
  return db
    .select()
    .from(schema.coveV3Events)
    .where(and(eq(schema.coveV3Events.network, network), eq(schema.coveV3Events.tokenId, tokenId), eq(schema.coveV3Events.canonical, true)))
    .orderBy(desc(schema.coveV3Events.blockHeight), desc(schema.coveV3Events.txIndex))
    .limit(limit);
}

// keep pure helpers re-exported for tests
export { balanceByScript, tokenHolders, tokenUtxosByScript };
