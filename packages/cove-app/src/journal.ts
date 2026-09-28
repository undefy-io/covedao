import { eq, and, lte, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { SIGNING_JOURNAL_TTL_MS, type SigningJournalStore, type SigningReservation } from "@crclaunch/cove-guardian/v3";

/** Atomic candidate reservations and immutable, restart-safe signing results. */
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

  private rowKey(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }) {
    return and(
      eq(schema.coveV3SigningJournal.network, params.network),
      eq(schema.coveV3SigningJournal.backingTxid, params.backingTxid),
      eq(schema.coveV3SigningJournal.backingVout, params.backingVout),
      eq(schema.coveV3SigningJournal.unsignedTxDigest, params.unsignedTxDigest),
    );
  }

  async reserve(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<SigningReservation> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SIGNING_JOURNAL_TTL_MS);
    const claimed = await this.db
      .insert(schema.coveV3SigningJournal)
      .values({ network: params.network, backingTxid: params.backingTxid, backingVout: params.backingVout, unsignedTxDigest: params.unsignedTxDigest, expiresAt })
      .onConflictDoUpdate({
        target: [schema.coveV3SigningJournal.network, schema.coveV3SigningJournal.backingTxid, schema.coveV3SigningJournal.backingVout, schema.coveV3SigningJournal.unsignedTxDigest],
        set: { unsignedTxDigest: params.unsignedTxDigest, expiresAt },
        setWhere: and(lte(schema.coveV3SigningJournal.expiresAt, now), isNull(schema.coveV3SigningJournal.signedAt)),
      })
      .returning({ digest: schema.coveV3SigningJournal.unsignedTxDigest });
    if (claimed.length > 0) return "RESERVED";
    const [row] = await this.db.select().from(schema.coveV3SigningJournal).where(this.rowKey(params));
    if (!row) throw new Error("signing reservation disappeared; retry validation");
    return "IDEMPOTENT";
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

  async committedDigest(network: string, backingTxid: string, backingVout: number, unsignedTxDigest: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(schema.coveV3SigningJournal)
      .where(this.rowKey({ network, backingTxid, backingVout, unsignedTxDigest }));
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
