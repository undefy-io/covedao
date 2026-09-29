import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export class CapacityUnavailable extends Error {
  constructor() { super("Shared capacity unavailable; retry shortly"); this.name = "CapacityUnavailable"; }
}

export function providerAccount(config: { url: string; apiKey?: string; user?: string; password?: string }): string {
  return createHash("sha256").update(JSON.stringify(config.apiKey ? ["api-key", config.apiKey] :
    ["rpc", new URL(config.url).origin, config.user ?? "", config.password ?? ""])).digest("hex");
}

export async function sharedQuota(db: Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const hash = createHash("sha256").update(key).digest("hex");
  const result = await db.execute(sql`
    insert into cove_api_quotas (key, window_start, count)
    values (${hash}, floor(extract(epoch from clock_timestamp()) * 1000 / ${windowMs})::bigint, 1)
    on conflict (key) do update set
      count = case when cove_api_quotas.window_start = excluded.window_start then cove_api_quotas.count + 1 else 1 end,
      window_start = excluded.window_start
    where cove_api_quotas.window_start < excluded.window_start or (cove_api_quotas.window_start = excluded.window_start and cove_api_quotas.count < ${limit})
    returning count`);
  return result.rows.length === 1;
}

type Lane = "worker" | "guardian" | "public";
type Lease = { id: string; lane: Lane; until: number };
type State = { rate: number; concurrency: number; next: number; lanes: Partial<Record<Lane, number>>; leases: Lease[] };

type BudgetRequest = { signal: AbortSignal; resolve: (release: () => Promise<void>) => void;
  reject: (error: unknown) => void; abort: () => void };

export class PostgresRpcBudget {
  private queue: BudgetRequest[] = [];
  private running = false;
  constructor(private readonly db: Database, private readonly account: string, private readonly lane: Lane,
    private readonly requestsPerSecond = 3, private readonly maxConcurrent = 6) {
    if (!Number.isSafeInteger(requestsPerSecond) || requestsPerSecond < 3 || requestsPerSecond > 300 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 3 || maxConcurrent > 60) throw new Error("invalid provider budget");
  }

  async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted();
    if (this.queue.length >= 32) throw new CapacityUnavailable();
    return new Promise((resolve, reject) => {
      const request: BudgetRequest = { signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(request);
        if (index >= 0) this.queue.splice(index, 1);
        signal.removeEventListener("abort", request.abort);
        reject(signal.reason);
      } };
      signal.addEventListener("abort", request.abort, { once: true });
      this.queue.push(request);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const request = this.queue.shift();
        if (!request) break;
        try {
          const release = await this.acquireShared(request.signal);
          if (request.signal.aborted) { await release().catch(() => {}); request.reject(request.signal.reason); }
          else request.resolve(release);
        } catch (error) { request.reject(error); }
        finally { request.signal.removeEventListener("abort", request.abort); }
      }
    } finally { this.running = false; }
  }

  private async acquireShared(signal: AbortSignal): Promise<() => Promise<void>> {
    const deadline = Date.now() + 8_000;
    {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const id = randomUUID();
        const accepted = await this.db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '500ms'`);
          await tx.execute(sql`set local statement_timeout = '1000ms'`);
          await tx.execute(sql`insert into cove_rpc_budgets (account, state) values (${this.account}, ${JSON.stringify({ rate: this.requestsPerSecond, concurrency: this.maxConcurrent, next: 0, lanes: {}, leases: [] })}::jsonb) on conflict do nothing`);
          const result = await tx.execute(sql`select state, extract(epoch from clock_timestamp()) * 1000 as now
            from cove_rpc_budgets where account = ${this.account} for update`);
          const row = result.rows[0]!;
          const now = Number(row.now);
          const state = row.state as State;
          if (state.rate !== this.requestsPerSecond || state.concurrency !== this.maxConcurrent) throw new Error("provider budget configuration differs across services");
          state.leases = state.leases.filter((lease) => lease.until > now);
          if (state.next > now || (state.lanes[this.lane] ?? 0) > now ||
            state.leases.length >= this.maxConcurrent || state.leases.filter((lease) => lease.lane === this.lane).length >= Math.floor(this.maxConcurrent / 3)) return false;
          state.next = now + Math.ceil(1_050 / this.requestsPerSecond);
          state.lanes[this.lane] = now + Math.ceil(3_000 / this.requestsPerSecond);
          state.leases.push({ id, lane: this.lane, until: now + 30_000 });
          await tx.execute(sql`update cove_rpc_budgets set state = ${JSON.stringify(state)}::jsonb where account = ${this.account}`);
          return true;
        });
        if (accepted) return async () => {
          await this.db.execute(sql`update cove_rpc_budgets set state = jsonb_set(state, '{leases}',
            coalesce((select jsonb_agg(lease) from jsonb_array_elements(state->'leases') lease where lease->>'id' <> ${id}), '[]'::jsonb))
            where account = ${this.account}`);
        };
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 75 + Math.floor(Math.random() * 75));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      throw new CapacityUnavailable();
    }
  }
}

export async function pruneQuotaWindows(db: Database): Promise<void> {
  await db.execute(sql`delete from cove_api_quotas where key in
    (select key from cove_api_quotas where window_start < floor(extract(epoch from clock_timestamp()) * 1000 / 60000)::bigint - 2 limit 1000)`);
}
