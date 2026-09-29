export interface ChainStatus {
  network: string;
  appEnabled: boolean;
  core: {
    reachable: boolean;
    height: string;
    tip: string;
    observedAt?: string | null;
    stale?: boolean;
  };
  indexer: {
    health: string;
    indexedHeight: string;
    indexedBlockHash: string;
    stateRoot: string;
    lag: string;
    rebuilding: boolean;
  };
  guardian: { configured: boolean };
  market: { enabled: boolean };
  observations?: {
    tradeRevision?: string;
    marketWindow?: string;
    chainGeneration: string;
    pendingRevision: string;
    marketRevision: string;
    metadataRevision: string;
    pendingObservedAt: string | null;
    feesObservedAt: string | null;
  };
}
export interface StatusSnapshot {
  status: ChainStatus | null;
  available: boolean;
  pendingAvailable: boolean;
  feesAvailable?: boolean;
  localRevision: number;
  resumeRevision: number;
}

export class ChainStatusStore {
  private snapshot: StatusSnapshot = {
    status: null,
    available: false,
    pendingAvailable: false,
    localRevision: 0,
    resumeRevision: 0,
  };
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private receivedAt = 0;
  private generation = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly read: (signal: AbortSignal) => Promise<ChainStatus>,
    readonly visible: () => boolean,
    readonly now: () => number = Date.now,
    readonly pollMs = 5_000,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.pause();
    };
  };
  private emit(update: Partial<StatusSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((l) => l());
  }
  private age() {
    const status = this.snapshot.status;
    const available = Boolean(
      status &&
      this.now() - this.receivedAt <= 15_000 &&
      status.core.reachable &&
      status.indexer.health === "HEALTHY",
    );
    const pendingAt = status?.observations?.pendingObservedAt;
    const pendingAvailable =
      available && Boolean(pendingAt && this.now() - Date.parse(pendingAt) <= 15_000);
    const feesAt = status?.observations?.feesObservedAt;
    const feesAvailable =
      available && Boolean(feesAt && this.now() - Date.parse(feesAt) <= 120_000);
    if (
      available !== this.snapshot.available ||
      pendingAvailable !== this.snapshot.pendingAvailable ||
      feesAvailable !== this.snapshot.feesAvailable
    )
      this.emit({ available, pendingAvailable, feesAvailable });
  }
  private expire() {
    clearTimeout(this.expiryTimer);
    if (!this.listeners.size || !this.visible()) return;
    const dates = [
      this.snapshot.available ? this.receivedAt + 15_001 : Infinity,
      this.snapshot.pendingAvailable
        ? Date.parse(this.snapshot.status!.observations!.pendingObservedAt!) + 15_001
        : Infinity,
      this.snapshot.feesAvailable
        ? Date.parse(this.snapshot.status!.observations!.feesObservedAt!) + 120_001
        : Infinity,
    ];
    const next = Math.min(...dates);
    if (Number.isFinite(next))
      this.expiryTimer = setTimeout(
        () => {
          this.age();
          this.expire();
        },
        Math.max(1, next - this.now()),
      );
  }
  pause() {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.generation++;
    this.age();
  }
  resume() {
    this.pause();
    this.emit({ resumeRevision: this.snapshot.resumeRevision + 1 });
    void this.poll();
  }
  broadcast() {
    this.emit({ localRevision: this.snapshot.localRevision + 1 });
    this.resume();
  }
  async poll() {
    this.age();
    if (!this.listeners.size || !this.visible() || this.controller) return;
    const generation = ++this.generation,
      controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const status = await this.read(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.receivedAt = this.now();
      this.emit({ status });
      this.age();
      this.expire();
    } catch {
      if (generation === this.generation) this.age();
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.controller = undefined;
        if (this.listeners.size && this.visible())
          this.timer = setTimeout(() => {
            void this.poll();
          }, this.pollMs);
      }
    }
  }
}

export function indexedRefreshKey(snapshot: StatusSnapshot): string {
  const s = snapshot.status;
  return s
    ? `${s.network}:${s.observations?.chainGeneration ?? s.indexer.indexedBlockHash}:${s.indexer.indexedBlockHash}`
    : "";
}
export function pendingRefreshKey(snapshot: StatusSnapshot): string {
  return `${indexedRefreshKey(snapshot)}:${snapshot.status?.observations?.pendingRevision ?? "0"}:${snapshot.status?.observations?.marketRevision ?? "0"}:${snapshot.available}:${snapshot.pendingAvailable}:${snapshot.localRevision}:${snapshot.resumeRevision}`;
}
