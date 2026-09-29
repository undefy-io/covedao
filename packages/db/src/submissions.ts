import * as bitcoin from "bitcoinjs-lib";
import { saveDeploymentMetadata } from "./deployment-metadata.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql, asc } from "drizzle-orm";
import { schema, type Database, type DbTransaction } from "./client.js";

export type Submission = typeof schema.coveV3Submissions.$inferSelect;
export type SubmissionInput = Pick<
  Submission,
  | "network"
  | "sourceKind"
  | "sourceId"
  | "operation"
  | "tokenId"
  | "backingTxid"
  | "backingVout"
  | "unsignedTxDigest"
  | "walletPsbtBase64"
>;
export class SubmissionError extends Error {
  constructor(
    readonly code: "BUSY" | "CONFLICT" | "STATE_CHANGED" | "LEASE_LOST",
    message: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

const table = schema.coveV3Submissions;
const conflictEligible = sql`(not ${table.conflicted} or ${table.conflictGeneration} is distinct from
  (select chain_generation from cove_observation_epochs where network = ${table.network}))`;
const sourceKey = (input: Pick<Submission, "network" | "sourceKind" | "sourceId">) =>
  and(
    eq(table.network, input.network),
    eq(table.sourceKind, input.sourceKind),
    eq(table.sourceId, input.sourceId),
  );

async function lockOwner(
  tx: DbTransaction,
  input: Pick<Submission, "network" | "sourceKind" | "sourceId">,
) {
  if (input.sourceKind === "APP") {
    const [owner] = await tx
      .select()
      .from(schema.coveV3AppTransactions)
      .where(
        and(
          eq(schema.coveV3AppTransactions.id, input.sourceId),
          eq(schema.coveV3AppTransactions.network, input.network),
        ),
      )
      .for("update");
    if (!owner) throw new SubmissionError("STATE_CHANGED", "submission session not found");
    return owner;
  }
  const [fill] = await tx
    .select()
    .from(schema.coveV3MarketFills)
    .where(
      and(
        eq(schema.coveV3MarketFills.id, input.sourceId),
        eq(schema.coveV3MarketFills.network, input.network),
      ),
    );
  if (!fill) throw new SubmissionError("STATE_CHANGED", "submission fill not found");
  const [listing] = await tx
    .select()
    .from(schema.coveV3MarketListings)
    .where(
      and(
        eq(schema.coveV3MarketListings.listingId, fill.listingId),
        eq(schema.coveV3MarketListings.network, input.network),
      ),
    )
    .for("update");
  if (!listing) throw new SubmissionError("STATE_CHANGED", "submission listing not found");
  const [owner] = await tx
    .select()
    .from(schema.coveV3MarketFills)
    .where(
      and(
        eq(schema.coveV3MarketFills.id, input.sourceId),
        eq(schema.coveV3MarketFills.network, input.network),
      ),
    )
    .for("update");
  if (!owner) throw new SubmissionError("STATE_CHANGED", "submission fill not found");
  return owner;
}

export async function prepareSubmission(db: Database, input: SubmissionInput): Promise<Submission> {
  return db.transaction(async (tx) => {
    const owner = await lockOwner(tx, input);
    const [existing] = await tx.select().from(table).where(sourceKey(input));
    if (existing) {
      if (
        existing.unsignedTxDigest !== input.unsignedTxDigest ||
        existing.operation !== input.operation ||
        existing.tokenId !== input.tokenId ||
        existing.backingTxid !== input.backingTxid ||
        existing.backingVout !== input.backingVout
      ) {
        throw new SubmissionError("CONFLICT", "submission commitment changed");
      }
      return existing;
    }
    const allowed = input.sourceKind === "APP" ? ["BUILT", "WALLET_SIGNED"] : ["BUYER_SIGNED"];
    if (input.sourceKind === "APP") {
      const session = owner as typeof schema.coveV3AppTransactions.$inferSelect;
      if (
        session.operation !== input.operation ||
        session.backingTxid !== input.backingTxid ||
        session.backingVout !== input.backingVout
      ) {
        throw new SubmissionError("CONFLICT", "session backing commitment changed");
      }
    }
    if (
      !allowed.includes(owner.status) ||
      owner.unsignedTxDigest !== input.unsignedTxDigest ||
      owner.tokenId !== input.tokenId
    ) {
      throw new SubmissionError("STATE_CHANGED", "submission owner is no longer eligible");
    }
    if (input.sourceKind === "APP") {
      await tx
        .update(schema.coveV3AppTransactions)
        .set({ status: "WALLET_SIGNED", updatedAt: new Date() })
        .where(eq(schema.coveV3AppTransactions.id, input.sourceId));
    } else {
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "SUBMITTING", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketFills.id, input.sourceId));
    }
    const [saved] = await tx.insert(table).values(input).returning();
    const parsed = bitcoin.Psbt.fromBase64(input.walletPsbtBase64);
    const points = parsed.txInputs.map((i) => ({
      txid: Buffer.from(i.hash).reverse().toString("hex"),
      vout: i.index,
    }));
    await tx.execute(sql`insert into cove_watched_inputs (network, source_id, txid, vout)
      select ${input.network}, ${saved!.id}, j.txid, j.vout from jsonb_to_recordset(${JSON.stringify(points)}::jsonb) j(txid text, vout integer)
      on conflict do nothing`);
    return saved!;
  });
}

export async function getSubmission(
  db: Database,
  network: string,
  sourceKind: "APP" | "FILL",
  sourceId: string,
): Promise<Submission | null> {
  const [row] = await db.select().from(table).where(sourceKey({ network, sourceKind, sourceId }));
  return row ?? null;
}

export async function claimSubmission(db: Database, id: string): Promise<Submission> {
  const token = randomUUID();
  const [row] = await db
    .update(table)
    .set({
      leaseToken: token,
      leaseUntil: sql`clock_timestamp() + interval '2 minutes'`,
      attempts: sql`${table.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(table.id, id),
        conflictEligible,
        inArray(table.phase, ["SIGNING", "READY"]),
        or(isNull(table.leaseUntil), lte(table.leaseUntil, sql`clock_timestamp()`)),
        lte(table.nextAttemptAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  if (!row) throw new SubmissionError("BUSY", "submission is already running or awaiting retry");
  return row;
}

export async function saveSignedSubmission(
  db: Database,
  job: Submission,
  signed: { rawTxHex: string; txid: string },
): Promise<Submission> {
  if (!job.leaseToken) throw new SubmissionError("LEASE_LOST", "submission lease is missing");
  return db.transaction(async (tx) => {
    await lockOwner(tx, job);
    const [row] = await tx
      .update(table)
      .set({ ...signed, phase: "READY", updatedAt: new Date() })
      .where(
        and(
          eq(table.id, job.id),
          eq(table.leaseToken, job.leaseToken!),
          eq(table.phase, "SIGNING"),
          isNull(table.rawTxHex),
        ),
      )
      .returning();
    if (!row)
      throw new SubmissionError(
        "LEASE_LOST",
        "submission lease changed before signed bytes were saved",
      );
    if (job.sourceKind === "APP") {
      await tx
        .update(schema.coveV3AppTransactions)
        .set({ txid: signed.txid, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3AppTransactions.id, job.sourceId),
            inArray(schema.coveV3AppTransactions.status, ["BUILT", "WALLET_SIGNED"]),
          ),
        );
    } else {
      await tx
        .update(schema.coveV3MarketFills)
        .set({ txid: signed.txid, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketFills.id, job.sourceId),
            eq(schema.coveV3MarketFills.status, "SUBMITTING"),
          ),
        );
    }
    return row;
  });
}

export async function deferSubmission(db: Database, job: Submission): Promise<void> {
  if (!job.leaseToken) return;
  await db
    .update(table)
    .set({
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: sql`clock_timestamp() + interval '1 minute'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(table.id, job.id),
        eq(table.leaseToken, job.leaseToken!),
        inArray(table.phase, ["SIGNING", "READY"]),
      ),
    );
}

export async function publishSubmission(db: Database, job: Submission): Promise<void> {
  if (!job.leaseToken || !job.txid || !job.rawTxHex)
    throw new SubmissionError("LEASE_LOST", "submission is not ready");
  await db.transaction(async (tx) => {
    const owner = await lockOwner(tx, job);
    const [saved] = await tx
      .update(table)
      .set({
        phase: "BROADCAST",
        acceptedAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(table.id, job.id),
          eq(table.leaseToken, job.leaseToken!),
          eq(table.phase, "READY"),
          eq(table.txid, job.txid!),
        ),
      )
      .returning();
    if (!saved)
      throw new SubmissionError(
        "LEASE_LOST",
        "submission lease changed before acceptance was published",
      );
    if (job.sourceKind === "APP") {
      const session = owner as typeof schema.coveV3AppTransactions.$inferSelect;
      if (session.operation === "DEPLOY" && session.metadataJson && session.tokenId) {
        const fields = {
          ...session.metadataJson,
          submittedByScript: session.walletScript,
          deployTxid: job.txid!,
        };
        await saveDeploymentMetadata(tx, {
          network: job.network,
          tokenId: session.tokenId,
          ...fields,
        });
      }
      await tx
        .update(schema.coveV3AppTransactions)
        .set({ status: "BROADCAST", txid: job.txid, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3AppTransactions.id, job.sourceId),
            inArray(schema.coveV3AppTransactions.status, ["BUILT", "WALLET_SIGNED"]),
          ),
        );
    } else if (["BUYER_SIGNED", "SUBMITTING"].includes(owner.status)) {
      const fill = owner as typeof schema.coveV3MarketFills.$inferSelect;
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "BROADCAST", txid: job.txid, updatedAt: new Date() })
        .where(eq(schema.coveV3MarketFills.id, job.sourceId));
      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "BROADCAST", updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketListings.listingId, fill.listingId),
            inArray(schema.coveV3MarketListings.status, ["ACTIVE", "RESERVED", "BROADCAST"]),
          ),
        );
      await tx
        .insert(schema.coveV3MarketEvents)
        .values({
          network: job.network,
          listingId: fill.listingId,
          fillId: job.sourceId,
          eventType: "FILL_BROADCAST",
          payloadJson: { txid: job.txid },
        });
    }
  });
}

export async function dueSubmissions(
  db: Database,
  network: string,
  limit = 2,
): Promise<Submission[]> {
  return db
    .select()
    .from(table)
    .where(
      and(
        eq(table.network, network),
        conflictEligible,
        inArray(table.phase, ["SIGNING", "READY"]),
        lte(table.nextAttemptAt, sql`clock_timestamp()`),
        or(isNull(table.leaseUntil), lte(table.leaseUntil, sql`clock_timestamp()`)),
      ),
    )
    .orderBy(asc(table.nextAttemptAt), asc(table.id))
    .limit(Math.max(1, Math.min(limit, 10)));
}

export async function haltSubmission(db: Database, job: Submission): Promise<void> {
  if (!job.leaseToken) return;
  await db
    .update(table)
    .set({ phase: "RECOVERY_REQUIRED", leaseToken: null, leaseUntil: null, updatedAt: new Date() })
    .where(
      and(eq(table.id, job.id), eq(table.leaseToken, job.leaseToken), eq(table.phase, "SIGNING")),
    );
}

export async function resumeSubmission(db: Database, id: string): Promise<void> {
  await db
    .update(table)
    .set({ phase: "SIGNING", nextAttemptAt: sql`clock_timestamp()`, updatedAt: new Date() })
    .where(
      and(
        eq(table.id, id),
        eq(table.phase, "RECOVERY_REQUIRED"),
        isNull(table.rawTxHex),
        isNull(table.leaseToken),
      ),
    );
}

export async function observeSubmissionFundingConflict(db: Database, job: Submission): Promise<boolean> {
  const result = await db.execute(sql`update cove_v3_submissions s set conflicted = exists (
    select 1 from cove_watched_inputs w join cove_indexed_spends p on p.network = w.network and p.txid = w.txid and p.vout = w.vout
    join cove_v3_blocks b on b.network = p.network and b.hash = p.block_hash and b.canonical
    where w.network = s.network and w.source_id = s.id::text and p.spender_txid <> s.txid),
    conflict_generation = e.chain_generation
    from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network and not c.rebuilding
    where s.id = ${job.id}::uuid and s.network = e.network and s.phase = 'READY' returning s.conflicted`);
  return result.rows[0]?.conflicted === true;
}
