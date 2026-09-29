import { withRpcDeadline, type RpcReadOptions } from "@crclaunch/bitcoin";

export type ScanRpcCaller = {
  call<T>(method: string, params: unknown[], options?: RpcReadOptions): Promise<T>;
};

class ScanCapacityUnavailable extends Error {
  constructor() {
    super("The regtest scanner is busy. Please retry shortly.");
    this.name = "CapacityUnavailable";
  }
}

type QueuedScan = { signal: AbortSignal; run: () => Promise<void> };

export class RegtestScanScheduler {
  private queue: QueuedScan[] = [];
  private running = false;

  constructor(
    private readonly capacity = 4,
    private readonly lifetimeMs = 30_000,
    private readonly retryMs = 250,
  ) {}

  scan<T>(rpc: ScanRpcCaller, addresses: string[], clientSignal?: AbortSignal): Promise<T[]> {
    if (this.queue.length + Number(this.running) >= this.capacity)
      return Promise.reject(new ScanCapacityUnavailable());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.lifetimeMs);
    const signal = clientSignal
      ? AbortSignal.any([clientSignal, controller.signal])
      : controller.signal;

    return new Promise<T[]>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        const position = this.queue.indexOf(item);
        if (position >= 0) this.queue.splice(position, 1);
        cleanup();
        reject(new ScanCapacityUnavailable());
      };
      const item: QueuedScan = {
        signal,
        run: async () => {
          try {
            const result = await withRpcDeadline(signal, async () => {
              for (let attempt = 0; ; attempt++) {
                signal.throwIfAborted();
                try {
                  const response = await rpc.call<{ unspents?: T[] }>(
                    "scantxoutset",
                    ["start", addresses.map((address) => ({ desc: `addr(${address})` }))],
                    { signal },
                  );
                  signal.throwIfAborted();
                  return response.unspents ?? [];
                } catch (error) {
                  signal.throwIfAborted();
                  if (!/scan already in progress/i.test((error as Error).message)) throw error;
                  if (attempt >= 40) throw new ScanCapacityUnavailable();
                  await this.wait(signal);
                }
              }
            });
            resolve(result);
          } catch (error) {
            reject(signal.aborted ? new ScanCapacityUnavailable() : error);
          } finally {
            cleanup();
            this.running = false;
            this.drain();
          }
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.queue.push(item);
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.signal.aborted) {
      this.drain();
      return;
    }
    this.running = true;
    void next.run();
  }

  private wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, this.retryMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

const scanGlobal = globalThis as typeof globalThis & { coveRegtestScans?: RegtestScanScheduler };
export const regtestScans = scanGlobal.coveRegtestScans ??= new RegtestScanScheduler();
