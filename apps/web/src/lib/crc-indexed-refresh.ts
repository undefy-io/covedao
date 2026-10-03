import { startCrcPolling } from "./crc-poll";

export type CrcStatus = { network: string; indexedTip: { height: string; blockHash: string } | null };
type Reader = { read: (signal: AbortSignal) => Promise<void>; error?: (cause: unknown) => void;
  controller: AbortController; completed?: string; desired?: string; pending: boolean };

/** One status poll per browser; confirmed reads follow the indexed height/hash. */
export class CrcIndexedRefreshStore {
  private readers = new Set<Reader>();
  private stop?: () => void;
  private key?: string;
  constructor(private readonly status: (signal: AbortSignal) => Promise<CrcStatus>) {}

  subscribe(read: Reader["read"], error?: Reader["error"]) {
    const reader: Reader = { read, error, controller: new AbortController(), pending: false };
    this.readers.add(reader);
    if (this.key !== undefined) void this.refresh(reader, this.key);
    if (!this.stop) this.stop = startCrcPolling(async (signal) => {
      try {
        const status = await this.status(signal);
        if (signal.aborted || document.visibilityState === "hidden") return;
        this.key = `${status.network}:${status.indexedTip?.height ?? "none"}:${status.indexedTip?.blockHash ?? "none"}`;
        this.readers.forEach((subscriber) => { void this.refresh(subscriber, this.key!); });
      } catch (cause) {
        if (!signal.aborted) this.readers.forEach((subscriber) => subscriber.error?.(cause));
      }
    });
    return () => {
      reader.controller.abort();
      this.readers.delete(reader);
      if (!this.readers.size) { this.stop?.(); this.stop = undefined; this.key = undefined; }
    };
  }

  private async refresh(reader: Reader, key: string) {
    reader.desired = key;
    if (reader.pending || reader.completed === key || reader.controller.signal.aborted || document.visibilityState === "hidden") return;
    reader.pending = true;
    try {
      await reader.read(reader.controller.signal);
      reader.completed = key;
    } catch {
      // Failed projections retry on the next successful status poll.
    } finally {
      reader.pending = false;
      if (reader.desired !== key) void this.refresh(reader, reader.desired!);
    }
  }
}

export const crcIndexedRefresh = new CrcIndexedRefreshStore(async (signal) => {
  const response = await fetch("/api/crc/v1/status", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "Could not load indexed status");
  return body.data as CrcStatus;
});
