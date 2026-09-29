export class ReadCacheBusy extends Error {
  constructor() {
    super("Public read capacity reached");
    this.name = "CapacityUnavailable";
  }
}
interface Cached {
  body: string;
  status: number;
  headers: [string, string][];
  expires: number;
  bytes: number;
}
export class PublicReadCache {
  private readonly entries = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<Cached>>();
  private bytes = 0;
  constructor(
    readonly maxEntries = 500,
    readonly maxBytes = 16 * 1024 * 1024,
    readonly maxPending = 32,
    readonly now = Date.now,
  ) {}
  private remove(key: string) {
    const row = this.entries.get(key);
    if (row) {
      this.bytes -= row.bytes;
      this.entries.delete(key);
    }
  }
  async read(
    args: string,
    generation: () => Promise<string>,
    ttlMs: number,
    load: () => Promise<Response>,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await generation(),
        key = `${args}:${before}`;
      const cached = this.entries.get(key);
      if (cached && cached.expires > this.now()) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }
      if (cached) this.remove(key);
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= this.maxPending) throw new ReadCacheBusy();
        work = (async () => {
          const response = await load(),
            body = await response.text();
          const headers = [...response.headers.entries()];
          const value: Cached = {
            body,
            status: response.status,
            headers,
            expires: this.now() + Math.min(ttlMs, 5000),
            bytes: new TextEncoder().encode(body).length,
          };
          const after = await generation();
          if (before !== after) throw new GenerationChanged();
          if (
            response.ok &&
            !response.headers.has("set-cookie") &&
            !/private/i.test(response.headers.get("cache-control") ?? "") &&
            value.bytes <= this.maxBytes
          ) {
            while (this.entries.size >= this.maxEntries || this.bytes + value.bytes > this.maxBytes)
              this.remove(this.entries.keys().next().value!);
            this.entries.set(key, value);
            this.bytes += value.bytes;
          }
          return value;
        })().finally(() => this.pending.delete(key));
        this.pending.set(key, work);
      }
      try {
        const value = await work;
        return new Response(value.body, { status: value.status, headers: value.headers });
      } catch (error) {
        if (!(error instanceof GenerationChanged)) throw error;
      }
    }
    throw new ReadCacheBusy();
  }
  stats() {
    return { entries: this.entries.size, bytes: this.bytes, pending: this.pending.size };
  }
}
class GenerationChanged extends Error {}
