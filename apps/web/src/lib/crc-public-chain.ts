import * as core from "@crclaunch/crc20-protocol";
import { publicChainUrl } from "../../public-chain-config.mjs";
import { MAX_FUNDING_PARENT_HEX, type CrcFundingEvidence, type FundingOutpoint } from "./crc-funding-evidence";
import type { WalletFundingCoin } from "./funding-candidates";

export class PublicChainUnavailable extends Error {}
export class PublicChainInvalid extends Error {}
class PublicRpcError extends PublicChainInvalid {
  constructor(readonly code: number, message: string) { super(message); }
}
export class PublicProofTooLarge extends PublicChainUnavailable {}
type Requester = (url: string, init?: RequestInit) => Promise<Response>;
type Coin = Required<WalletFundingCoin>;
type Input = { txid: string; vout: number; sats: bigint; scriptHex: string };

// Bitcoin Core v30.0 src/kernel/chainparams.cpp: expected genesis per network.
const GENESIS: Readonly<Record<string, string>> = {
  mainnet: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  testnet: "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  regtest: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
};

async function observations<T>(tasks: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  const invalid = failures.find(item => !(item.reason instanceof PublicChainUnavailable));
  if (invalid) throw invalid.reason;
  if (failures.length) throw failures[0]!.reason;
  return settled.map(item => (item as PromiseFulfilledResult<T>).value);
}

/** Public browser chain access: no custody credentials, PostgreSQL or Node RPC provider. */
export class CrcPublicChain {
  private readonly rpcUrl: string;
  private readonly indexUrl: string;
  private pending = new Map<string, Promise<unknown>>();
  private addresses = new Map<string, { until: number; coins: Coin[] }>();
  private parents = new Map<string, string>();
  private parentCharacters = 0;
  private identity?: { until: number; blocks: number };
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly network: string, rpcUrl: string, indexUrl: string, private readonly request: Requester = fetch, private readonly timeoutMs = 12_000) {
    this.rpcUrl = publicChainUrl(rpcUrl)!; this.indexUrl = publicChainUrl(indexUrl)!;
    if (!this.rpcUrl || !this.indexUrl) throw new PublicChainInvalid("Public chain configuration is incomplete");
  }
  private async join<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let pending = this.pending.get(key) as Promise<T> | undefined;
    if (!pending) {
      if (this.pending.size >= 128) throw new PublicChainUnavailable("Public chain capacity reached");
      pending = work().finally(() => this.pending.delete(key)); this.pending.set(key, pending);
    }
    if (!signal) return pending;
    // A canceled subscriber must not cancel the shared fetch of another caller.
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      pending!.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  private async body(url: string, init?: RequestInit, rpc = false): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (this.active < 4) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener("abort", expired); resolve(); };
      const expired = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new PublicChainUnavailable("Public chain queue timed out"));
      };
      signal.addEventListener("abort", expired, { once: true });
      this.waiting.push(start);
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted || Date.now() >= deadline) throw new PublicChainUnavailable("Public chain request timed out");
        let response: Response;
        try { response = await (0, this.request)(url, { ...init, credentials: "omit", cache: "no-store", signal }); }
        catch { throw new PublicChainUnavailable("Public chain lookup is temporarily unavailable"); }
        if (response.status === 429 && attempt < 2) {
          await response.body?.cancel();
          const header = response.headers.get("retry-after");
          const seconds = header === null ? NaN : Number(header);
          const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
            : header ? Date.parse(header) - Date.now() : 0;
          const delay = Math.max(250, Number.isFinite(requested) ? requested : 0);
          if (delay >= deadline - Date.now()) throw new PublicChainUnavailable("Public chain retry exceeds deadline");
          await new Promise<void>((resolve, reject) => {
            const expired = () => { clearTimeout(timer); reject(new PublicChainUnavailable("Public chain retry timed out")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", expired); resolve(); }, delay);
            signal.addEventListener("abort", expired, { once: true });
            if (signal.aborted) expired();
          });
          continue;
        }
        if (!response.ok && !(rpc && response.status === 500)) { await response.body?.cancel(); throw new PublicChainUnavailable("Public chain lookup failed"); }
        const reader = response.body?.getReader();
        if (!reader) throw new PublicChainInvalid("Public chain returned an empty response");
        const parts: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.length;
            if (size > 1_000_000) { await reader.cancel(); throw new PublicProofTooLarge("Public chain response exceeds capacity"); }
            parts.push(part.value);
          }
        } catch (error) {
          if (error instanceof PublicChainInvalid || error instanceof PublicChainUnavailable) throw error;
          throw new PublicChainUnavailable("Public chain lookup timed out");
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      throw new PublicChainUnavailable("Public chain quota reached");
    } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const text = await this.body(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: method, method, params }) }, true);
    let result;
    try { result = JSON.parse(text); } catch { throw new PublicChainInvalid("Public RPC returned invalid JSON"); }
    if (result?.error && Number.isSafeInteger(result.error.code) && typeof result.error.message === "string")
      throw new PublicRpcError(result.error.code, result.error.message.slice(0, 500));
    if (!result || typeof result !== "object" || result.error || !Object.hasOwn(result, "result"))
      throw new PublicChainInvalid("Public RPC returned invalid data");
    return result.result;
  }
  private async checkIdentity(): Promise<number> {
    if (this.identity && this.identity.until > Date.now()) return this.identity.blocks;
    return this.join("identity", async () => {
      const info = await this.rpc("getblockchaininfo", []) as { chain?: string; blocks?: number };
      const expected = this.network === "mainnet" ? "main" : this.network === "testnet" ? "test" : this.network;
      if (!info || info.chain !== expected || !Number.isSafeInteger(info.blocks) || info.blocks! < 0)
        throw new PublicChainInvalid("Public RPC network differs from the wallet");
      const rpcGenesis = await this.rpc("getblockhash", [0]);
      if (!GENESIS[this.network] || rpcGenesis !== GENESIS[this.network])
        throw new PublicChainInvalid("Public RPC genesis differs from the wallet network");
      this.identity = { until: Date.now() + 5000, blocks: info.blocks! }; return info.blocks!;
    });
  }
  async broadcast(rawHex: string, txid: string, signal?: AbortSignal): Promise<string> {
    if (rawHex.length > 750000 || !/^(?:[a-f0-9]{2})+$/.test(rawHex) || core.parseRawTransaction(rawHex).txid !== txid)
      throw new PublicChainInvalid("Broadcast transaction identity mismatch");
    return this.join(`broadcast:${txid}`, async () => {
      await this.checkIdentity();
      let result: unknown;
      try { result = await this.rpc("sendrawtransaction", [rawHex]); }
      catch (error) {
        if (error instanceof PublicRpcError && error.code === -27) return txid;
        // A lost response or duplicate-mempool rejection may follow acceptance.
        // Query this exact txid directly; a cached funding parent is not evidence.
        try {
          const observed = await this.rpc("getrawtransaction", [txid, false]);
          if (typeof observed === "string" && observed.length <= 750000 && core.parseRawTransaction(observed).txid === txid) return txid;
        } catch { /* Keep the original failure and saved receipt for explicit retry. */ }
        throw error;
      }
      if (result !== txid) throw new PublicChainInvalid("Public RPC broadcast identity mismatch");
      this.addresses.clear();
      return txid;
    }, signal);
  }
  async coins(address: string, signal?: AbortSignal): Promise<Coin[]> {
    return this.join(`address:${address}`, async () => {
      const height = await this.checkIdentity();
      const saved = this.addresses.get(address);
      if (saved && saved.until > Date.now()) return saved.coins;
      let rows;
      try { rows = JSON.parse(await this.body(`${this.indexUrl}/address/${encodeURIComponent(address)}/utxo`)); }
      catch (error) { if (error instanceof PublicChainUnavailable) throw error; throw new PublicChainInvalid("Address index returned invalid data"); }
      if (!Array.isArray(rows) || rows.length > 2000) throw new PublicChainInvalid("Address index returned invalid coins");
      const seen = new Set<string>();
      const coins: Coin[] = rows.map(row => {
        if (!row || !/^[0-9a-f]{64}$/.test(row.txid) || !Number.isSafeInteger(row.vout) || row.vout < 0 || row.vout > 0xffffffff ||
          !Number.isSafeInteger(row.value) || row.value < 0 || BigInt(row.value) > 2100000000000000n ||
          !row.status || typeof row.status.confirmed !== "boolean" || (row.status.confirmed &&
            (!Number.isSafeInteger(row.status.block_height) || row.status.block_height < 0)))
          throw new PublicChainInvalid("Address index returned invalid coin data");
        const key = core.outpoint(row); if (seen.has(key)) throw new PublicChainInvalid("Address index returned duplicate coins"); seen.add(key);
        return { txid: row.txid, vout: row.vout, valueSats: String(row.value),
          confirmations: row.status.confirmed ? Math.max(0, height - row.status.block_height + 1) : 0 };
      });
      if (this.addresses.size >= 100) this.addresses.delete(this.addresses.keys().next().value!);
      this.addresses.set(address, { until: Date.now() + 5000, coins }); return coins;
    }, signal).then(coins => coins.map(coin => ({ ...coin })));
  }
  private async parent(txid: string): Promise<string> {
    const saved = this.parents.get(txid);
    if (saved) { this.parents.delete(txid); this.parents.set(txid, saved); return saved; }
    return this.join(`parent:${txid}`, async () => {
      const raw = await this.rpc("getrawtransaction", [txid, false]);
      if (typeof raw !== "string" || !/^(?:[a-fA-F0-9]{2})+$/.test(raw)) throw new PublicChainInvalid("Invalid raw funding transaction");
      const parsed = core.parseRawTransaction(raw);
      if (parsed.txid !== txid) throw new PublicChainInvalid("Funding parent hash mismatch");
      if (raw.length > MAX_FUNDING_PARENT_HEX) throw new PublicProofTooLarge("Funding evidence exceeds capacity");
      while (this.parents.size && (this.parents.size >= 128 || this.parentCharacters + raw.length > 2_000_000)) {
        const key = this.parents.keys().next().value!; this.parentCharacters -= this.parents.get(key)!.length; this.parents.delete(key);
      }
      this.parents.set(txid, raw); this.parentCharacters += raw.length; return raw;
    });
  }
  async evidence(candidates: readonly FundingOutpoint[], signal?: AbortSignal): Promise<CrcFundingEvidence> {
    if (candidates.length > 40) throw new PublicChainInvalid("Too many funding candidates");
    return this.join(`evidence:${JSON.stringify(candidates.map(({ txid, vout }) => ({ txid, vout })))}`, async () => {
      await this.checkIdentity();
      const parents = await observations([...new Set(candidates.map(coin => coin.txid))].map(async txid => ({ txid, rawHex: await this.parent(txid) })));
      if (parents.reduce((total, parent) => total + parent.rawHex.length, 0) > MAX_FUNDING_PARENT_HEX)
        throw new PublicProofTooLarge("Funding evidence exceeds capacity");
      return { version: 1 as const, network: this.network, parents };
    }, signal).then(value => ({ ...value, parents: value.parents.map(parent => ({ ...parent })) }));
  }
  async observe(inputs: readonly Input[], signal?: AbortSignal): Promise<(Input & { confirmations: number })[]> {
    if (inputs.length > 40) throw new PublicChainInvalid("Too many funding inputs");
    return this.join(`observe:${JSON.stringify(inputs, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`, async () => {
      await this.checkIdentity();
      return observations(inputs.map(async input => {
        const raw = await this.parent(input.txid), parsed = core.parseRawTransaction(raw), output = parsed.outputs[input.vout];
        const observed = await this.rpc("gettxout", [input.txid, input.vout, true]) as {
          confirmations?: number; value?: number; scriptPubKey?: { hex?: string };
        } | null;
        const btc = observed?.value;
        const decimal = typeof btc === "number" && Number.isFinite(btc) && btc >= 0 && btc <= 21000000 ? btc.toFixed(8) : undefined;
        const value = decimal && Number(decimal) === btc ? BigInt(decimal.replace(".", "")) : undefined;
        // RPC decimal BTC is parsed at its canonical eight-decimal precision.
        if (!observed || value === undefined ||
          !Number.isSafeInteger(observed.confirmations) || observed.confirmations! < 1 || !output ||
          output.scriptHex !== input.scriptHex || core.sats(output.sats) !== core.sats(input.sats) ||
          value !== core.sats(output.sats) || observed.scriptPubKey?.hex !== output.scriptHex)
          throw new PublicChainInvalid("Funding input is spent, unconfirmed or differs from the reviewed transaction");
        return { ...input, confirmations: observed.confirmations! };
      }));
    }, signal).then(rows => rows.map(row => ({ ...row })));
  }
}
