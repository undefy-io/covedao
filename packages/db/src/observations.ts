import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database, DbTransaction } from "./client.js";

export function databaseDate(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export class WorkerOwnershipLost extends Error {
  constructor() {
    super("Observation worker ownership changed");
    this.name = "WorkerOwnershipLost";
  }
}

export interface BackingObservationPayload {
  tokenId: string;
  stateVersion: number;
  policyVersion: number;
  issuedSupplyAtoms: string;
  backingSats: string;
  curveStage: number;
  stateHash: string;
  txid: string;
  vout: number;
  script: string;
  valueSats: string;
}
export interface BackingObservationBase {
  network: string;
  tokenId: string;
  generation: string;
  revision: string;
  indexedHeight: string;
  indexedHash: string;
  stateRoot: string;
  rebuilding: boolean;
  backing: BackingObservationPayload;
}

export async function claimObservationWorker(db: Database, network: string): Promise<string> {
  const epoch = randomUUID();
  await db.execute(sql`insert into cove_observation_epochs (network, worker_epoch) values (${network}, ${epoch}::uuid)
    on conflict (network) do update set worker_epoch = excluded.worker_epoch`);
  return epoch;
}

export async function assertObservationWorker(
  tx: DbTransaction,
  network: string,
  epoch: string,
): Promise<void> {
  const result = await tx.execute(
    sql`select worker_epoch from cove_observation_epochs where network = ${network} for update`,
  );
  if (result.rows[0]?.worker_epoch !== epoch) throw new WorkerOwnershipLost();
}

export async function backingObservationBases(
  db: Database,
  network: string,
  tokenIds: string[],
): Promise<BackingObservationBase[]> {
  if (!tokenIds.length) return [];
  const result =
    await db.execute(sql`select b.token_id, c.height::text as height, c.block_hash, c.state_root, c.rebuilding,
    e.chain_generation::text as generation, coalesce(p.requested_revision, 0)::text as revision,
    b.state_version, b.policy_version, b.issued_supply_atoms::text as supply, b.backing_sats::text as backing,
    b.curve_stage, b.state_hash, b.txid, b.vout, b.script_pub_key, b.btc_value::text as value
    from cove_v3_backing_states b join cove_v3_cursor c on c.network = b.network
    join cove_observation_epochs e on e.network = b.network
    left join cove_pending_backing p on p.network = b.network and p.token_id = b.token_id
    where b.network = ${network} and b.token_id in (select jsonb_array_elements_text(${JSON.stringify(tokenIds)}::jsonb)) and b.canonical`);
  return result.rows.map((row) => ({
    network,
    tokenId: String(row.token_id),
    generation: String(row.generation),
    revision: String(row.revision),
    indexedHeight: String(row.height),
    indexedHash: String(row.block_hash),
    stateRoot: String(row.state_root),
    rebuilding: row.rebuilding === true,
    backing: {
      tokenId: String(row.token_id),
      stateVersion: Number(row.state_version),
      policyVersion: Number(row.policy_version),
      issuedSupplyAtoms: String(row.supply),
      backingSats: String(row.backing),
      curveStage: Number(row.curve_stage),
      stateHash: String(row.state_hash),
      txid: String(row.txid),
      vout: Number(row.vout),
      script: String(row.script_pub_key),
      valueSats: String(row.value),
    },
  }));
}

export async function backingObservationBase(
  db: Database,
  network: string,
  tokenId: string,
): Promise<BackingObservationBase | null> {
  return (await backingObservationBases(db, network, [tokenId]))[0] ?? null;
}

export async function publishBackingObservation(
  db: Database,
  base: BackingObservationBase,
  epoch: string,
  payload: BackingObservationPayload | null,
  observedAt: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await assertObservationWorker(tx, base.network, epoch);
    const before = await tx.execute(
      sql`select payload, observed_revision from cove_pending_backing where network = ${base.network} and token_id = ${base.tokenId} for update`,
    );
    const result = await tx.execute(sql`update cove_pending_backing p set
      observed_revision = case when ${payload !== null} then p.requested_revision else null end,
      chain_generation = ${base.generation}::bigint, base_txid = ${base.backing.txid}, base_vout = ${base.backing.vout},
      payload = ${payload ? JSON.stringify(payload) : null}::jsonb, observed_at = ${observedAt}, last_checked_at = clock_timestamp()
      where p.network = ${base.network} and p.token_id = ${base.tokenId} and p.requested_revision = ${base.revision}::bigint
      and exists (select 1 from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network
        where e.network = p.network and e.chain_generation = ${base.generation}::bigint and not c.rebuilding
          and c.height = ${base.indexedHeight}::bigint and c.block_hash = ${base.indexedHash} and c.state_root = ${base.stateRoot})
      and exists (select 1 from cove_v3_backing_states b where b.network = p.network and b.token_id = p.token_id
        and b.canonical and b.txid = ${base.backing.txid} and b.vout = ${base.backing.vout})
      returning p.token_id`);
    if (!result.rows.length) return false;
    const previous = before.rows[0]?.payload as BackingObservationPayload | null;
    if (
      previous?.stateHash !== payload?.stateHash ||
      previous?.txid !== payload?.txid ||
      (before.rows[0]?.observed_revision == null) !== (payload == null)
    ) {
      await tx.execute(
        sql`update cove_observation_epochs set pending_revision = pending_revision + 1 where network = ${base.network}`,
      );
    }
    return true;
  });
}

export async function effectiveBackingObservation(db: Database, network: string, tokenId: string) {
  const result =
    await db.execute(sql`select p.payload, p.observed_at, p.requested_revision::text as revision,
    c.height::text as height, c.block_hash, e.chain_generation::text as generation,
    (not c.rebuilding and r.core_reachable and r.core_height = c.height and r.core_tip = c.block_hash
      and r.chain_observed_at >= clock_timestamp() - interval '30 seconds'
      and p.chain_generation = e.chain_generation and p.observed_revision = p.requested_revision
      and p.base_txid = b.txid and p.base_vout = b.vout
      and p.observed_at >= clock_timestamp() - interval '15 seconds' and p.payload is not null) as fresh
    from cove_v3_backing_states b join cove_v3_cursor c on c.network = b.network
    join cove_observation_epochs e on e.network = b.network
    left join cove_v3_runtime r on r.network = b.network
    left join cove_pending_backing p on p.network = b.network and p.token_id = b.token_id
    where b.network = ${network} and b.token_id = ${tokenId} and b.canonical`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    payload: row.payload as BackingObservationPayload | null,
    fresh: row.fresh === true,
    observedAt: databaseDate(row.observed_at),
    revision: String(row.revision ?? "0"),
    indexedHeight: BigInt(String(row.height)),
    indexedHash: String(row.block_hash),
    generation: String(row.generation),
  };
}

export async function acceptedObservationCandidate(db: Database, network: string, tokenId: string) {
  const base = await backingObservationBase(db, network, tokenId);
  if (!base) return null;
  const rows = await db.execute(sql`select payload, observed_at from cove_pending_backing
    where network = ${network} and token_id = ${tokenId} and chain_generation = ${base.generation}::bigint
      and base_txid = ${base.backing.txid} and base_vout = ${base.backing.vout}
      and requested_revision = ${base.revision}::bigint and payload is not null and observed_at >= clock_timestamp() - interval '15 seconds'`);
  return rows.rows[0] ? { base, payload: rows.rows[0].payload as BackingObservationPayload } : null;
}

export async function publishAcceptedObservation(
  db: Database,
  base: BackingObservationBase,
  submissionId: string,
  parent: { txid: string; vout: number },
  payload: BackingObservationPayload,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select network from cove_observation_epochs where network = ${base.network} for update`,
    );
    const result =
      await tx.execute(sql`update cove_pending_backing p set payload = ${JSON.stringify(payload)}::jsonb,
      observed_revision = p.requested_revision, observed_at = clock_timestamp(), last_checked_at = clock_timestamp()
      where p.network = ${base.network} and p.token_id = ${base.tokenId}
        and p.requested_revision = ${base.revision}::bigint + 1 and p.chain_generation = ${base.generation}::bigint
        and p.base_txid = ${base.backing.txid} and p.base_vout = ${base.backing.vout}
        and p.payload->>'txid' = ${parent.txid} and (p.payload->>'vout')::integer = ${parent.vout}
        and exists (select 1 from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network
          where e.network = p.network and e.chain_generation = ${base.generation}::bigint and not c.rebuilding)
        and exists (select 1 from cove_v3_submissions s where s.id = ${submissionId}::uuid and s.network = p.network
          and s.token_id = p.token_id and s.backing_txid = ${parent.txid} and s.backing_vout = ${parent.vout}
          and s.phase = 'BROADCAST' and s.accepted_at is not null and s.txid = ${payload.txid}) returning token_id`);
    return result.rows.length > 0;
  });
}
