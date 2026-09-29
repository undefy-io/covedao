import { EsploraUtxoProvider } from "./esplora.js";
import type { ChainUtxo, RpcConfig } from "./provider.js";
import type { NetworkName } from "./decoder.js";

export class AddressLookupBusy extends Error {
  constructor() { super("Address lookup capacity unavailable; retry shortly"); this.name = "AddressLookupBusy"; }
}

export class AddressUtxoCache {
  private entries = new Map<string, { generation: string; epoch: number; expires: number; value: ChainUtxo[] }>();
  private pending = new Map<string, { generation: string; epoch: number; value: Promise<ChainUtxo[]> }>();
  private sources = new Map<string, { provider: EsploraUtxoProvider; generation: string; epoch: number }>();
  private active = 0;
  constructor(private readonly maxEntries = 1_000, private readonly maxConcurrent = 4, private readonly ttlMs = 5_000) {}

  async read(url: string, network: NetworkName, address: string, generation: string,
    currentGeneration: () => Promise<string>, budget?: RpcConfig["budget"]): Promise<ChainUtxo[]> {
    const sourceKey = JSON.stringify([url, network]);
    const key = JSON.stringify([url, network, address]);
    let source = this.sources.get(sourceKey);
    if (!source) {
      if (this.sources.size >= 8) throw new AddressLookupBusy();
      source = { provider: new EsploraUtxoProvider(url, network, budget), generation, epoch: 0 };
      this.sources.set(sourceKey, source);
    }
    if (source.generation !== generation) {
      source.generation = generation;
      source.epoch++;
      source.provider.invalidateHeight();
    }
    const epoch = source.epoch;
    const cached = this.entries.get(key);
    if (cached?.generation === generation && cached.epoch === epoch && cached.expires > Date.now()) return cached.value.map((u) => ({ ...u }));
    const running = this.pending.get(key);
    if (running?.generation === generation && running.epoch === epoch) return (await running.value).map((u) => ({ ...u }));
    if (this.active >= this.maxConcurrent) throw new AddressLookupBusy();
    this.active++;
    const provider = source.provider;
    const read = (async () => {
      const value = await provider.getUtxos(address);
      if (source.epoch !== epoch || source.generation !== generation || await currentGeneration() !== generation) throw new AddressLookupBusy();
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { generation, epoch, expires: Date.now() + this.ttlMs, value });
      return value;
    })();
    this.pending.set(key, { generation, epoch, value: read });
    try { return (await read).map((u) => ({ ...u })); }
    finally { this.active--; if (this.pending.get(key)?.value === read) this.pending.delete(key); }
  }
}
