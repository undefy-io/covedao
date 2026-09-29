import { sql } from "drizzle-orm";
import { getV3Services } from "./v3-server";
import { PublicReadCache } from "./read-cache";

const cache = new PublicReadCache();
export type PublicReadScope = "confirmed" | "market" | "trades" | "status" | "fees";
function normalizedRequest(req: Request) {
  const url = new URL(req.url),
    query: Record<string, string> = {};
  for (const name of ["search", "limit", "offset", "interval", "tokenIds", "tokenId"]) {
    let value = url.searchParams.get(name);
    if (name === "search") value ??= url.searchParams.get("ticker");
    if (value == null) continue;
    if (name === "tokenIds")
      value = [
        ...new Set(
          value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
        .sort()
        .join(",");
    if ((name === "offset" || name === "limit") && /^\d+$/.test(value))
      value = String(Number(value));
    query[name] = value;
  }
  return JSON.stringify([url.pathname, query]);
}
export async function cachePublic(
  req: Request,
  scope: PublicReadScope,
  ttlMs: number,
  load: () => Promise<Response>,
): Promise<Response> {
  const { db, config } = getV3Services();
  const generation = async () => {
    const result =
      await db.execute(sql`select e.chain_generation::text, e.trade_revision::text, e.metadata_revision::text, e.market_revision::text, e.pending_revision::text,
      c.block_hash, c.rebuilding, r.chain_observed_at, r.pending_observed_at, r.fees_observed_at, r.core_reachable
      from (select ${config.network}::text as network) n left join cove_observation_epochs e on e.network = n.network
      left join cove_v3_cursor c on c.network = n.network left join cove_v3_runtime r on r.network = n.network`);
    const r = result.rows[0] ?? {};
    const values = [r.chain_generation, r.block_hash, r.rebuilding, r.metadata_revision];
    if (scope === "market" || scope === "status") values.push(r.market_revision);
    if (scope === "trades" || scope === "market" || scope === "status")
      values.push(r.trade_revision);
    if (scope === "status")
      values.push(r.pending_revision, r.chain_observed_at, r.pending_observed_at);
    if (scope === "fees" || scope === "status") values.push(r.fees_observed_at, r.core_reachable);
    return JSON.stringify(values);
  };
  const response = await cache.read(
    `${config.network}:${scope}:${normalizedRequest(req)}`,
    generation,
    ttlMs,
    load,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}
