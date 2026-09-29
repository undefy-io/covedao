import * as bitcoin from "bitcoinjs-lib";
import { sql } from "drizzle-orm";
import {
  backingObservationBases,
  publishBackingObservation,
  assertObservationWorker,
  type Database,
  type BackingObservationBase,
  type BackingObservationPayload,
} from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { stateHashV2, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import {
  replayPendingBackingAncestry,
  MAX_PENDING_ANCESTORS,
  type SigningJournalStore,
} from "@crclaunch/cove-guardian/v3";
import { loadCanonicalViewSnapshotFromDb } from "@crclaunch/cove-indexer/v3";
import { PostgresSigningJournal } from "./journal.js";
import type { V3AppConfig } from "./config.js";

const outpointKey = (point: { txid: string; vout: number }) => `${point.txid}:${point.vout}`;
export function observationPayload(
  view: CoveCanonicalView,
  tokenId: string,
  tx?: bitcoin.Transaction,
): BackingObservationPayload {
  const id = Buffer.from(tokenId, "hex"),
    state = view.getCurrentBackingState(id)!,
    point = view.getBackingOutpoint(id)!;
  if (!tx || tx.getId() !== point.txid || !tx.outs[point.vout])
    throw new Error("Missing verified backing output");
  return {
    tokenId,
    stateVersion: state.stateVersion,
    policyVersion: state.policyVersion,
    issuedSupplyAtoms: state.issuedPublicSupplyAtoms.toString(),
    backingSats: state.backingSats.toString(),
    curveStage: state.curveStage,
    stateHash: stateHashV2(state),
    ...point,
    script: tx.outs[point.vout]!.script.toString("hex"),
    valueSats: String(tx.outs[point.vout]!.value),
  };
}

export function observationJournal(db: Database): SigningJournalStore {
  const journal = new PostgresSigningJournal(db);
  return {
    reserve: (p) => journal.reserve(p),
    markSigned: (p) => journal.markSigned(p),
    release: (p) => journal.release(p),
    committedDigest: (...p) => journal.committedDigest(...p),
    readSigned: async (p) => {
      const signed = await journal.readSigned(p);
      if (signed) return signed;
      const result =
        await db.execute(sql`select wallet_psbt_base64 from cove_v3_submissions where network = ${p.network}
        and backing_txid = ${p.backingTxid} and backing_vout = ${p.backingVout} and unsigned_tx_digest = ${p.unsignedTxDigest}
        and raw_tx_hex is not null limit 1`);
      return result.rows[0]
        ? { psbtBase64: String(result.rows[0].wallet_psbt_base64), resultJson: "{}", auditHash: "" }
        : null;
    },
  };
}

export async function replayObservation(
  db: Database,
  config: V3AppConfig,
  base: BackingObservationBase,
  transactions: bitcoin.Transaction[],
) {
  const relevantOutpoints = transactions.flatMap((tx) =>
    tx.ins.map((input) => ({
      txid: Buffer.from(input.hash).reverse().toString("hex"),
      vout: input.index,
    })),
  );
  const view = await loadCanonicalViewSnapshotFromDb({
    db,
    network: base.network,
    tokenId: base.tokenId,
    relevantOutpoints,
  });
  if (
    view.rebuilding ||
    view.cursorBlockHash !== base.indexedHash ||
    view.cursorHeight.toString() !== base.indexedHeight ||
    view.stateRoot !== base.stateRoot ||
    outpointKey(
      view.getBackingOutpoint(Buffer.from(base.tokenId, "hex")) ?? { txid: "", vout: -1 },
    ) !== outpointKey(base.backing)
  )
    throw new Error("Indexed backing changed");
  return replayPendingBackingAncestry(
    {
      view,
      network: config.network,
      tokenId: Buffer.from(base.tokenId, "hex"),
      journal: observationJournal(db),
      guardianXOnly: config.guardianXOnly,
      recoveryKeyXOnly: config.recoveryKeyXOnly,
      recoveryProfile: config.recoveryProfile,
      feeScript: config.feeScript,
      maxMinerFeeSats: config.maxMinerFeeSats,
      buyFeeBps: config.buyFeeBps,
      buyFeeFlatSats: config.buyFeeFlatSats,
      redeemFeeBps: config.redeemFeeBps,
      redeemFeeFlatSats: config.redeemFeeFlatSats,
    },
    transactions,
  );
}

export class PendingObservationWorker {
  private spenderSupported = true;
  private readonly verified = new Map<string, BackingObservationPayload>();
  private readonly raw = new Map<string, bitcoin.Transaction>();
  constructor(
    readonly db: Database,
    readonly provider: CoreRpcProvider,
    readonly config: V3AppConfig,
    readonly epoch: string,
  ) {}
  async refresh(): Promise<{ checked: number; published: number }> {
    try {
      return await this.refreshSnapshot();
    } catch (error) {
      await this.db.transaction(async (tx) => {
        await assertObservationWorker(tx, this.config.network, this.epoch);
        const changed =
          await tx.execute(sql`update cove_pending_backing set observed_revision = null
          where network = ${this.config.network} and observed_revision is not null returning token_id`);
        await tx.execute(
          sql`update cove_v3_runtime set pending_observed_at = null where network = ${this.config.network}`,
        );
        if (changed.rows.length)
          await tx.execute(
            sql`update cove_observation_epochs set pending_revision = pending_revision + 1 where network = ${this.config.network}`,
          );
      });
      throw error;
    }
  }
  private async refreshSnapshot(): Promise<{ checked: number; published: number }> {
    const network = this.config.network;
    const selected = await this.db
      .execute(sql`select p.token_id, p.payload->>'txid' as head_txid from cove_pending_backing p
      join cove_v3_backing_states b on b.network = p.network and b.token_id = p.token_id and b.canonical
      where p.network = ${network} order by p.last_checked_at, p.token_id limit 500`);
    const previousHeads = new Map(
      selected.rows.map((r) => [
        String(r.token_id),
        r.head_txid == null ? null : String(r.head_txid),
      ]),
    );
    const bases = await backingObservationBases(
      this.db,
      network,
      selected.rows.map((r) => String(r.token_id)),
    );
    const tracked = await this.db.execute(sql`select t.txid from (
      select s.txid, s.updated_at from cove_v3_app_transactions s where s.network = ${network} and s.txid is not null
        and s.status in ('WALLET_SIGNED','BROADCAST','REORGED','CONFIRMED') and not exists
        (select 1 from cove_v3_events e where e.network = s.network and e.txid = s.txid and e.canonical and e.valid)
      union all select f.txid, f.updated_at from cove_v3_market_fills f where f.network = ${network} and f.txid is not null
        and f.status in ('SUBMITTING','BROADCAST','REORGED')
      ) t left join cove_transaction_observations o on o.network = ${network} and o.txid = t.txid
      group by t.txid, o.observed_at order by o.observed_at asc nulls first, t.txid limit 1000`);
    const captured = await this.db
      .execute(sql`select e.chain_generation::text as generation, e.pending_revision::text as revision, c.height::text as height, c.block_hash
      from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network where e.network = ${network} and not c.rebuilding`);
    if (!captured.rows[0] || bases.some((b) => b.generation !== captured.rows[0]!.generation))
      return { checked: 0, published: 0 };
    const observationStarted = new Date();
    const tip = {
      bestBlockHash: String(captured.rows[0].block_hash),
      blocks: Number(captured.rows[0].height),
    };
    if (
      bases.some(
        (b) =>
          b.rebuilding ||
          b.indexedHash !== tip.bestBlockHash ||
          b.indexedHeight !== String(tip.blocks),
      )
    )
      return { checked: 0, published: 0 };
    const membership = await this.provider.getMempoolSnapshot({ retry: false });
    for (const txid of this.raw.keys()) if (!membership.has(txid)) this.raw.delete(txid);
    const points = new Map<string, { txid: string; vout: number }>();
    for (const b of bases) points.set(outpointKey(b.backing), b.backing);
    for (const row of tracked.rows) {
      const p = { txid: String(row.txid), vout: 1 };
      points.set(outpointKey(p), p);
    }
    for (const txid of this.raw.keys()) {
      const p = { txid, vout: 1 };
      points.set(outpointKey(p), p);
    }
    const spenders = this.spenderSupported
      ? await this.provider.getMempoolSpenders([...points.values()].slice(0, 2000), {
          retry: false,
        })
      : undefined;
    if (!spenders) this.spenderSupported = false;
    const acceptedSpenders = spenders ?? new Map<string, string | null>();
    if (!spenders) {
      for (const point of points.values()) acceptedSpenders.set(outpointKey(point), null);
      const candidates = await this.db
        .execute(sql`select raw_tx_hex, null::jsonb as signing_result from cove_v3_submissions s
        where network = ${network} and raw_tx_hex is not null and not exists
          (select 1 from cove_v3_events e where e.network = s.network and e.txid = s.txid and e.canonical and e.valid)
        union all select null::text, signing_result from cove_v3_signing_journal j where j.network = ${network}
          and j.signed_at is not null and j.signing_result is not null and not exists
          (select 1 from cove_v3_events e where e.network = j.network and e.txid = j.unsigned_tx_digest and e.canonical and e.valid)
        limit 1001`);
      if (candidates.rows.length > 1000) throw new Error("Pending candidate capacity reached");
      for (const candidate of candidates.rows) {
        let tx: bitcoin.Transaction;
        try {
          if (candidate.raw_tx_hex) tx = bitcoin.Transaction.fromHex(String(candidate.raw_tx_hex));
          else {
            const saved = candidate.signing_result as { psbtBase64: string };
            const psbt = bitcoin.Psbt.fromBase64(saved.psbtBase64);
            for (let i = 1; i < psbt.data.inputs.length; i++)
              if (!psbt.data.inputs[i]!.finalScriptWitness && !psbt.data.inputs[i]!.finalScriptSig)
                psbt.finalizeInput(i);
            tx = psbt.extractTransaction();
          }
        } catch {
          continue;
        }
        const txid = tx.getId();
        if (!membership.has(txid)) continue;
        if (this.raw.size >= 1000 && !this.raw.has(txid))
          throw new Error("Pending observation capacity reached");
        this.raw.set(txid, tx);
        for (const input of tx.ins) {
          const key = outpointKey({
            txid: Buffer.from(input.hash).reverse().toString("hex"),
            vout: input.index,
          });
          const other = acceptedSpenders.get(key);
          if (other && other !== txid) throw new Error("Mempool branch changed during observation");
          acceptedSpenders.set(key, txid);
        }
        if (!acceptedSpenders.has(`${txid}:1`)) acceptedSpenders.set(`${txid}:1`, null);
      }
    }
    const proofs = await this.db
      .execute(sql`select p.token_id, p.txid, p.vout from cove_backing_proofs p
      join cove_v3_blocks b on b.network = p.network and b.hash = p.block_hash and b.canonical
      where p.network = ${network} and p.token_id in
        (select jsonb_array_elements_text(${JSON.stringify(bases.map((b) => b.tokenId))}::jsonb))
        and not exists (select 1 from cove_indexed_spends s where s.network = p.network and s.txid = p.txid and s.vout = p.vout)`);
    const proven = new Set(
      proofs.rows.map((p) => `${String(p.token_id)}:${String(p.txid)}:${Number(p.vout)}`),
    );
    // Keep cold-start proof work within the shared provider quota. Unchecked
    // tokens remain unavailable and rotate into the next refresh fairly.
    let proofReadsRemaining = 2;
    const readProof = async (txid: string, vout: number, includeMempool = true) => {
      if (proofReadsRemaining <= 0) throw new Error("Backing proof deferred to next refresh");
      proofReadsRemaining--;
      return this.provider.getTxout(txid, vout, includeMempool);
    };
    const newProofs: BackingObservationBase[] = [];
    const results: { base: BackingObservationBase; payload: BackingObservationPayload | null }[] =
      [];
    for (const base of bases) {
      try {
        let point = { txid: base.backing.txid, vout: base.backing.vout };
        const chain: bitcoin.Transaction[] = [];
        for (let depth = 0; ; depth++) {
          let spender = acceptedSpenders.get(outpointKey(point));
          if (spender === undefined && spenders) {
            const extra = await this.provider.getMempoolSpenders([point], { retry: false });
            spender = extra?.get(outpointKey(point));
          }
          if (spender === undefined) throw new Error("Incomplete pending spend observation");
          if (!spender) break;
          if (
            depth >= MAX_PENDING_ANCESTORS ||
            !membership.has(spender) ||
            chain.some((t) => t.getId() === spender)
          )
            throw new Error("Pending ancestry unavailable");
          let tx = this.raw.get(spender);
          if (!tx) {
            if (this.raw.size >= 1000) throw new Error("Pending observation capacity reached");
            const saved = await this.db.execute(
              sql`select raw_tx_hex from cove_v3_submissions where network = ${network} and txid = ${spender} and raw_tx_hex is not null limit 1`,
            );
            const hex =
              saved.rows[0]?.raw_tx_hex ?? (await this.provider.getRawTransaction(spender));
            if (typeof hex !== "string" || hex.length > 200_000)
              throw new Error("Pending transaction too large");
            tx = bitcoin.Transaction.fromHex(hex);
            if (tx.getId() !== spender) throw new Error("Pending transaction identity mismatch");
            this.raw.set(spender, tx);
          }
          if (
            !tx.ins[0] ||
            outpointKey({
              txid: Buffer.from(tx.ins[0].hash).reverse().toString("hex"),
              vout: tx.ins[0].index,
            }) !== outpointKey(point)
          )
            throw new Error("Wrong pending parent");
          chain.push(tx);
          point = { txid: spender, vout: 1 };
        }
        if (!proven.has(`${base.tokenId}:${outpointKey(base.backing)}`)) {
          const unspent = await readProof(base.backing.txid, base.backing.vout, false);
          if (
            !unspent ||
            unspent.bestBlockHash !== tip.bestBlockHash ||
            unspent.scriptPubKeyHex !== base.backing.script ||
            unspent.valueSats.toString() !== base.backing.valueSats
          )
            throw new Error("Canonical backing unavailable");
          newProofs.push(base);
        }
        let payload = base.backing;
        if (chain.length) {
          const cacheKey = `${base.generation}:${base.tokenId}:${base.revision}:${chain.map((tx) => tx.getId()).join(":")}`;
          const cached = this.verified.get(cacheKey);
          if (cached) payload = cached;
          else {
            const verified = await replayObservation(this.db, this.config, base, chain);
            payload = observationPayload(verified, base.tokenId, chain[chain.length - 1]);
            const unspent = await readProof(payload.txid, payload.vout);
            if (
              !unspent ||
              unspent.bestBlockHash !== tip.bestBlockHash ||
              unspent.scriptPubKeyHex !== payload.script ||
              unspent.valueSats.toString() !== payload.valueSats
            )
              throw new Error("Pending head unavailable");
            if (this.verified.size >= 1000)
              this.verified.delete(this.verified.keys().next().value!);
            this.verified.set(cacheKey, payload);
          }
        }
        if (!chain.length) {
          const previous = previousHeads.get(base.tokenId);
          if (!previous || previous !== base.backing.txid) {
            const unspent = await readProof(base.backing.txid, base.backing.vout);
            if (
              !unspent ||
              unspent.bestBlockHash !== tip.bestBlockHash ||
              unspent.scriptPubKeyHex !== base.backing.script ||
              unspent.valueSats.toString() !== base.backing.valueSats
            )
              throw new Error("Evicted backing is not positively unspent");
          }
        }
        results.push({ base, payload });
      } catch (error) {
        if (error instanceof Error && error.name === "WorkerOwnershipLost") throw error;
        results.push({ base, payload: null });
      }
    }
    const latest = await this.provider.getBlockchainInfo();
    if (latest.bestBlockHash !== tip.bestBlockHash || latest.blocks !== tip.blocks)
      return { checked: bases.length, published: 0 };
    const observedAt = observationStarted;
    await this.db.transaction(async (tx) => {
      await assertObservationWorker(tx, network, this.epoch);
      const generation =
        await tx.execute(sql`select e.chain_generation::text as generation from cove_observation_epochs e
        join cove_v3_cursor c on c.network = e.network where e.network = ${network} and not c.rebuilding and c.block_hash = ${tip.bestBlockHash} and c.height = ${tip.blocks}
          and e.chain_generation = ${String(captured.rows[0]!.generation)}::bigint and e.pending_revision = ${String(captured.rows[0]!.revision)}::bigint`);
      if (!generation.rows[0]) return;
      const values = tracked.rows.map((r) => ({
        txid: String(r.txid),
        state: membership.has(String(r.txid)) ? "pending" : "unknown",
      }));
      if (!values.length) return;
      const changes =
        await tx.execute(sql`select exists (select 1 from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) j(txid text, state text)
        left join cove_transaction_observations o on o.network = ${network} and o.txid = j.txid
        where o.state is distinct from j.state or o.chain_generation is distinct from ${String(generation.rows[0].generation)}::bigint) as changed`);
      await tx.execute(sql`insert into cove_transaction_observations (network, txid, chain_generation, state, observed_at)
        select ${network}, j.txid, ${String(generation.rows[0].generation)}::bigint, j.state, ${observedAt}
        from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) j(txid text, state text)
        on conflict (network, txid) do update set chain_generation = excluded.chain_generation, state = excluded.state,
          observed_at = excluded.observed_at returning txid`);
      if (changes.rows[0]?.changed === true)
        await tx.execute(
          sql`update cove_observation_epochs set pending_revision = pending_revision + 1 where network = ${network}`,
        );
    });
    await this.db.transaction(async (tx) => {
      await assertObservationWorker(tx, network, this.epoch);
      for (const base of newProofs) {
        const saved =
          await tx.execute(sql`insert into cove_backing_proofs (network, token_id, txid, vout, block_hash, block_height)
          select ${network}, ${base.tokenId}, ${base.backing.txid}, ${base.backing.vout}, ${base.indexedHash}, ${base.indexedHeight}::bigint
          where exists (select 1 from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network
            where e.network = ${network} and e.chain_generation = ${base.generation}::bigint and not c.rebuilding)
          on conflict (network, token_id) do update set txid = excluded.txid, vout = excluded.vout, block_hash = excluded.block_hash, block_height = excluded.block_height returning token_id`);
        if (saved.rows.length)
          await tx.execute(sql`insert into cove_watched_inputs (network, source_id, txid, vout)
          values (${network}, ${"backing:" + base.tokenId}, ${base.backing.txid}, ${base.backing.vout}) on conflict do nothing`);
      }
    });
    let published = 0;
    for (const result of results)
      if (
        await publishBackingObservation(
          this.db,
          result.base,
          this.epoch,
          result.payload,
          observedAt,
        )
      )
        published++;
    await this.db.transaction(async (tx) => {
      await assertObservationWorker(tx, network, this.epoch);
      await tx.execute(sql`update cove_v3_runtime r set pending_observed_at = ${observedAt}
        where r.network = ${network} and exists (select 1 from cove_observation_epochs e join cove_v3_cursor c on c.network = e.network
          where e.network = r.network and e.chain_generation = ${String(captured.rows[0]!.generation)}::bigint and not c.rebuilding)`);
    });
    return { checked: bases.length, published };
  }
}
