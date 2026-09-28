import { sql } from "drizzle-orm";
import type { Database } from "@crclaunch/db";
import { unitPriceSats } from "./ohlc";

/** Bounded predecessor seeks preserve filled hourly gaps without loading history. */
export function sparklineQuery(network: string, ids: string[]) {
  return sql`
    with requested as (select distinct unnest(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]) token_id)
    select r.token_id, b.bucket, close.amount_atoms, close.price_sats,
      newest.amount_atoms newest_amount, newest.price_sats newest_price
    from requested r
    left join lateral (
      select * from (
        (select created_at, amount_atoms, total_price_sats price_sats, 0 source, block_height, txid
          from cove_v3_market_trades where network = ${network} and token_id = r.token_id and canonical
          order by created_at desc nulls last, block_height desc nulls last, txid desc nulls last limit 1)
        union all
        (select created_at, amount_atoms, gross_sats price_sats, 1 source, block_height, txid
          from cove_v3_events where network = ${network} and token_id = r.token_id and canonical and valid
            and operation in ('MINT','REDEEM') and gross_sats is not null
          order by created_at desc nulls last, block_height desc nulls last, txid desc nulls last limit 1)
      ) t order by created_at desc nulls last, source desc, block_height desc nulls last, txid desc nulls last limit 1
    ) newest on true
    left join lateral (
      select max(created_at) latest from (
        (select created_at from cove_v3_market_trades where network = ${network} and token_id = r.token_id
          and canonical and amount_atoms > 0 and total_price_sats::numeric * 10000000000000 >= amount_atoms
          order by created_at desc nulls last limit 1)
        union all
        (select created_at from cove_v3_events where network = ${network} and token_id = r.token_id
          and canonical and valid and operation in ('MINT','REDEEM')
          and amount_atoms > 0 and gross_sats::numeric * 10000000000000 >= amount_atoms
          order by created_at desc nulls last limit 1)
      ) t
    ) bounds on true
    left join lateral (
      select floor(extract(epoch from bounds.latest) / 3600)::bigint - 31 + i bucket
      from generate_series(0, 31) i where bounds.latest is not null
    ) b on true
    left join lateral (
      select * from (
        (select amount_atoms, total_price_sats price_sats, created_at, 0 source, block_height, txid
          from cove_v3_market_trades where network = ${network} and token_id = r.token_id and canonical
            and amount_atoms > 0 and total_price_sats::numeric * 10000000000000 >= amount_atoms
            and created_at < to_timestamp((b.bucket + 1) * 3600)
          order by created_at desc nulls last, block_height desc nulls last, txid desc nulls last limit 1)
        union all
        (select amount_atoms, gross_sats price_sats, created_at, 1 source, block_height, txid
          from cove_v3_events where network = ${network} and token_id = r.token_id and canonical and valid
            and operation in ('MINT','REDEEM') and amount_atoms > 0 and gross_sats::numeric * 10000000000000 >= amount_atoms
            and created_at < to_timestamp((b.bucket + 1) * 3600)
          order by created_at desc nulls last, block_height desc nulls last, txid desc nulls last limit 1)
      ) t order by created_at desc nulls last, source desc, block_height desc nulls last, txid desc nulls last limit 1
    ) close on true
    order by r.token_id, b.bucket
  `;
}

export async function loadSparklines(db: Database, network: string, ids: string[]) {
  const rows = await db.execute(sparklineQuery(network, ids));
  const series: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, []]));
  const lastPrice: Record<string, number | null> = Object.fromEntries(ids.map((id) => [id, null]));
  for (const row of rows.rows as unknown as { token_id: string; amount_atoms: string | null; price_sats: string | null; newest_amount: string | null; newest_price: string | null }[]) {
    if (row.amount_atoms !== null && row.price_sats !== null) series[row.token_id]!.push(unitPriceSats(row.amount_atoms, row.price_sats));
    if (row.newest_amount !== null && row.newest_price !== null) lastPrice[row.token_id] = unitPriceSats(row.newest_amount, row.newest_price);
  }
  return { series, lastPrice };
}
