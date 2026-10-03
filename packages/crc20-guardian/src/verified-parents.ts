import { parseRawTransaction } from "@crclaunch/crc20-protocol";

/** Immutable RPC observations only; deployment acceptance is revalidated by the caller. */
export class VerifiedParentCache {
  private readonly values = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private characters = 0;
  constructor(
    private readonly fetch: (txid: string) => Promise<string>,
    private readonly maxEntries = 128,
    private readonly maxCharacters = 2_000_000,
  ) {}
  async get(txid: string): Promise<string> {
    const saved = this.values.get(txid);
    if (saved !== undefined) {
      this.values.delete(txid); this.values.set(txid, saved);
      return saved;
    }
    const running = this.pending.get(txid);
    if (running) return running;
    if (this.pending.size >= 32) throw new Error("Guardian parent observation capacity exhausted");
    const task = this.fetch(txid).then(raw => {
      if (parseRawTransaction(raw).txid !== txid) throw new Error("Guardian deployment parent mismatch");
      if (this.maxEntries > 0 && raw.length <= this.maxCharacters) {
        while (this.values.size >= this.maxEntries || this.characters + raw.length > this.maxCharacters) {
          const oldest = this.values.keys().next().value;
          if (oldest === undefined) break;
          this.characters -= this.values.get(oldest)!.length;
          this.values.delete(oldest);
        }
        this.values.set(txid, raw); this.characters += raw.length;
      }
      return raw;
    }).finally(() => this.pending.delete(txid));
    this.pending.set(txid, task);
    return task;
  }
}
