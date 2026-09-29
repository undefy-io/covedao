import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@crclaunch/db";

/** Canonical DB evidence only; pending absence never means a permanent conflict. */
export async function indexedBackingConflict(
  db: Database,
  network: string,
  txid: string,
): Promise<boolean> {
  const result = await db.execute(indexedBackingConflictQuery(network, txid));
  return result.rows[0]?.conflict === true;
}

export function indexedBackingConflictQuery(network: string, txid: string | SQL) {
  return sql`
    with recursive ancestors as (
      select distinct s.txid, s.backing_txid, s.backing_vout, s.token_id, 0 as depth
      from cove_v3_app_transactions s
      where s.network = ${network} and s.txid = ${txid} and s.backing_vout = 1
      union
      select p.txid, p.backing_txid, p.backing_vout, p.token_id, a.depth + 1
      from ancestors a
      join lateral (
        select distinct s.txid, s.backing_txid, s.backing_vout, s.token_id
        from cove_v3_app_transactions s
        where s.network = ${network} and s.txid = a.backing_txid and s.token_id = a.token_id and s.backing_vout = 1
      ) p on true
      where a.depth < 24
    )
    select exists (
      select 1 from ancestors a
      join cove_v3_cursor c on c.network = ${network} and not c.rebuilding
      join cove_v3_backing_states b on b.network = ${network} and b.token_id = a.token_id and b.canonical
      where b.txid <> a.backing_txid
        and not exists (
          select 1 from cove_v3_events e where e.network = ${network} and e.txid = a.txid and e.canonical and e.valid
        )
        and (
          exists (select 1 from cove_v3_tokens t where t.network = ${network} and t.token_id = a.token_id and t.deploy_txid = a.backing_txid and t.canonical)
          or exists (select 1 from cove_v3_events e where e.network = ${network} and e.txid = a.backing_txid and e.token_id = a.token_id and e.canonical and e.valid and e.operation in ('MINT', 'REDEEM'))
        )
    ) or exists (
      select 1 from cove_v3_submissions s join cove_watched_inputs w on w.network = s.network and w.source_id = s.id::text
      join cove_indexed_spends p on p.network = w.network and p.txid = w.txid and p.vout = w.vout and p.spender_txid <> s.txid
      join cove_v3_blocks b on b.network = p.network and b.hash = p.block_hash and b.canonical
      join cove_v3_cursor c on c.network = s.network and not c.rebuilding
      where s.network = ${network} and (s.txid = ${txid} or s.txid in (select txid from ancestors))
    ) as conflict
  `;
}
