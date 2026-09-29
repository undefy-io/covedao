import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import type { CoveCanonicalView, CoveStateV2, OutPoint, TokenUtxo } from "@crclaunch/cove-covenant";

/**
 * Real DB-backed canonical view snapshot (§4/§23). Reads a single Postgres
 * transaction (cursor + backing + requested token UTXOs) and returns an
 * immutable object implementing CoveCanonicalView. The Guardian remains
 * SQL-independent and operates only on the returned snapshot.
 */

export interface DbCanonicalViewSnapshot extends CoveCanonicalView {
  readonly cursorHeight: bigint;
  readonly cursorBlockHash: string;
  readonly stateRoot: string;
  readonly rebuilding: boolean;
}

function opKey(o: OutPoint): string {
  return `${o.txid}:${o.vout}`;
}

export async function loadCanonicalViewSnapshotFromDb(params: {
  db: Database;
  network: string;
  tokenId: string;
  relevantOutpoints?: OutPoint[];
}): Promise<DbCanonicalViewSnapshot> {
  const { db, network, tokenId: snapshotTokenId, relevantOutpoints = [] } = params;

  const rows = await db.transaction(
    async (tx) => {
      const cursor = await tx
        .select()
        .from(schema.coveV3Cursor)
        .where(eq(schema.coveV3Cursor.network, network));
      const backing = await tx
        .select()
        .from(schema.coveV3BackingStates)
        .where(
          and(
            eq(schema.coveV3BackingStates.network, network),
            eq(schema.coveV3BackingStates.tokenId, snapshotTokenId),
            eq(schema.coveV3BackingStates.canonical, true),
          ),
        );
      const utxos = await tx
        .select()
        .from(schema.coveV3TokenUtxos)
        .where(
          and(
            eq(schema.coveV3TokenUtxos.network, network),
            eq(schema.coveV3TokenUtxos.tokenId, snapshotTokenId),
            eq(schema.coveV3TokenUtxos.canonical, true),
            isNull(schema.coveV3TokenUtxos.spentByTxid),
            params.relevantOutpoints === undefined
              ? undefined
              : relevantOutpoints.length
                ? inArray(schema.coveV3TokenUtxos.txid, [
                    ...new Set(relevantOutpoints.map((o) => o.txid)),
                  ])
                : sql`false`,
          ),
        );
      const token = await tx
        .select({ creatorScript: schema.coveV3Tokens.creatorScript })
        .from(schema.coveV3Tokens)
        .where(
          and(
            eq(schema.coveV3Tokens.network, network),
            eq(schema.coveV3Tokens.tokenId, snapshotTokenId),
            eq(schema.coveV3Tokens.canonical, true),
          ),
        );
      return { cursor, backing, utxos, token };
    },
    { isolationLevel: "repeatable read" },
  );

  const cur = rows.cursor[0];
  const cursorHeight = cur?.height ?? 0n;
  const cursorBlockHash = cur?.blockHash ?? "";
  const stateRoot = cur?.stateRoot ?? "";
  const rebuilding = cur?.rebuilding ?? false;

  const backingByOutpoint = new Map<string, CoveStateV2>();
  let currentBacking: CoveStateV2 | null = null;
  let currentOutpoint: OutPoint | null = null;
  for (const b of rows.backing) {
    const st: CoveStateV2 = {
      stateVersion: b.stateVersion as 2,
      policyVersion: b.policyVersion,
      tokenId: b.tokenId,
      issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
      backingSats: b.backingSats,
      curveStage: b.curveStage,
    };
    backingByOutpoint.set(opKey({ txid: b.txid, vout: b.vout }), st);
    currentBacking = st;
    currentOutpoint = { txid: b.txid, vout: b.vout };
  }

  const utxoByOutpoint = new Map<string, TokenUtxo>();
  const wanted = new Set(relevantOutpoints.map(opKey));
  for (const u of rows.utxos) {
    const outpoint = { txid: u.txid, vout: u.vout };
    if (wanted.size > 0 && !wanted.has(opKey(outpoint))) continue;
    utxoByOutpoint.set(opKey(outpoint), {
      outpoint,
      tokenId: Buffer.from(u.tokenId, "hex"),
      amountAtoms: u.amountAtoms,
      scriptPubKey: Buffer.from(u.scriptPubKey, "hex"),
    });
  }

  return Object.freeze({
    cursorHeight,
    cursorBlockHash,
    stateRoot,
    rebuilding,
    getBackingStateByOutpoint(o: OutPoint) {
      // Only the snapshot's own token's backing is visible by outpoint.
      const st = backingByOutpoint.get(opKey(o));
      if (!st || !currentBacking || st.tokenId !== snapshotTokenId) return null;
      return st;
    },
    getCurrentBackingState(tokenId: Buffer) {
      if (tokenId.toString("hex") !== snapshotTokenId) return null;
      return currentBacking;
    },
    getBackingOutpoint(tokenId: Buffer) {
      if (tokenId.toString("hex") !== snapshotTokenId) return null;
      return currentOutpoint;
    },
    getTokenUtxo(o: OutPoint) {
      return utxoByOutpoint.get(opKey(o)) ?? null;
    },
    getTokenCreatorScript(tokenId: Buffer) {
      const c = rows.token[0]?.creatorScript;
      if (tokenId.toString("hex") !== snapshotTokenId || !c) return null;
      return Buffer.from(c, "hex");
    },
  });
}
