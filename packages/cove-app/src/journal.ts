import { eq, and, lte, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { SIGNING_JOURNAL_TTL_MS, type SigningJournalStore, type SigningReservation } from "@crclaunch/cove-guardian/v3";

/**
 * Postgres-backed durable signing journal (Phase 8 §21). The unique outpoint
 * index (network, backingTxid, backingVout) makes reservation atomic across
 * processes and survives restart — the Guardian can never sign two different
 * successors for the same backing outpoint.
 *
 * Unsigned reservations carry a TTL. Once the Guardian produces a signature,
 * markSigned makes the conflict barrier permanent; expiration and release
 * cannot allow a different successor to be signed.
 */
export class PostgresSigningJournal implements SigningJournalStore {
  constructor(readonly db: Database) {}

  /** Health probe: the journal table answers a read. Throws when it cannot. */
  async probe(network: string): Promise<void> {
    await this.db
      .select({ network: schema.coveV3SigningJournal.network })
      .from(schema.coveV3SigningJournal)
      .where(eq(schema.coveV3SigningJournal.network, network))
      .limit(1);
  }

  private rowKey(params: { network: string; backingTxid: string; backingVout: number }) {
    return and(
      eq(schema.coveV3SigningJournal.network, params.network),
      eq(schema.coveV3SigningJournal.backingTxid, params.backingTxid),
      eq(schema.coveV3SigningJournal.backingVout, params.backingVout),
    );
  }

  /**
   * Reserve the backing outpoint. This MUST be a single atomic statement: a
   * read-then-delete-then-insert sequence lets concurrent callers each observe
   * "absent", each delete the row a peer just committed, and each insert — a
   * 20-way race produced 6 simultaneous RESERVED reservations for one outpoint,
   * defeating the double-sign guard exactly when it matters.
   *
   * `ON CONFLICT DO UPDATE ... WHERE expires_at <= now()` collapses all three
   * steps into one: the row is claimed if absent, taken over if the previous
   * reservation has expired (the §C1 un-brick), and left untouched while a live
   * reservation holds it. An empty RETURNING means someone else holds it, so we
   * re-read to distinguish a retry of our own digest from a genuine conflict.
   */
  async reserve(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<SigningReservation> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SIGNING_JOURNAL_TTL_MS);
    const claimed = await this.db
      .insert(schema.coveV3SigningJournal)
      .values({ network: params.network, backingTxid: params.backingTxid, backingVout: params.backingVout, unsignedTxDigest: params.unsignedTxDigest, expiresAt })
      .onConflictDoUpdate({
        target: [schema.coveV3SigningJournal.network, schema.coveV3SigningJournal.backingTxid, schema.coveV3SigningJournal.backingVout],
        set: { unsignedTxDigest: params.unsignedTxDigest, expiresAt },
        setWhere: and(lte(schema.coveV3SigningJournal.expiresAt, now), isNull(schema.coveV3SigningJournal.signedAt)),
      })
      .returning({ digest: schema.coveV3SigningJournal.unsignedTxDigest });
    if (claimed.length > 0) return "RESERVED";
    // A live reservation holds the outpoint: same digest is an idempotent retry.
    const held = await this.db.select().from(schema.coveV3SigningJournal).where(this.rowKey(params));
    const row = held[0];
    if (!row) return "CONFLICT";
    return row.unsignedTxDigest === params.unsignedTxDigest ? "IDEMPOTENT" : "CONFLICT";
  }

  async markSigned(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string;
    signingResult?: { psbtBase64: string; resultJson: string; auditHash: string } }): Promise<void> {
    const rows = await this.db
      .update(schema.coveV3SigningJournal)
      .set({ signedAt: sql`COALESCE(${schema.coveV3SigningJournal.signedAt}, clock_timestamp())`,
        ...(params.signingResult ? { signingResult: sql`COALESCE(${schema.coveV3SigningJournal.signingResult}, ${JSON.stringify(params.signingResult)}::jsonb)` } : {}) })
      .where(and(this.rowKey(params), eq(schema.coveV3SigningJournal.unsignedTxDigest, params.unsignedTxDigest)))
      .returning({ id: schema.coveV3SigningJournal.id });
    if (rows.length !== 1) throw new Error("signing reservation lost before signature was committed");
  }

  async readSigned(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }) {
    const [row] = await this.db.select({ result: schema.coveV3SigningJournal.signingResult }).from(schema.coveV3SigningJournal)
      .where(and(this.rowKey(params), eq(schema.coveV3SigningJournal.unsignedTxDigest, params.unsignedTxDigest),
        sql`${schema.coveV3SigningJournal.signedAt} is not null`));
    return row?.result ?? null;
  }

  async committedDigest(network: string, backingTxid: string, backingVout: number): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(schema.coveV3SigningJournal)
      .where(this.rowKey({ network, backingTxid, backingVout }));
    const row = rows[0];
    if (!row) return null;
    if (!row.signedAt && row.expiresAt.getTime() <= Date.now()) return null; // unsigned lease expired
    return row.unsignedTxDigest;
  }

  async release(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<void> {
    await this.db
      .delete(schema.coveV3SigningJournal)
      .where(and(this.rowKey(params), eq(schema.coveV3SigningJournal.unsignedTxDigest, params.unsignedTxDigest), isNull(schema.coveV3SigningJournal.signedAt)));
  }
}
