import * as bitcoin from "bitcoinjs-lib";
import { decodeRawTransaction, type BitcoinProtocolTx } from "./decoder.js";

export interface BitcoinBlock {
  hash: string;
  height: number;
  previousBlockHash: string;
  txids: string[];
  /** Raw transaction hexes, in canonical Bitcoin block order. */
  rawTxs: string[];
}

export interface ChainUtxo {
  txid: string;
  vout: number;
  scriptPubKeyHex: string;
  valueSats: bigint;
  confirmations: number;
  /**
   * For P2TR inputs: the 32-byte UNTWEAKED internal key P (x-only, hex). It is
   * NOT recoverable from the scriptPubKey (which carries the tweaked output key
   * Q = P + H_TapTweak(P)·G), so the caller must supply it. Required to build a
   * P2TR input; the builder throws rather than setting a wrong value.
   */
  tapInternalKeyHex?: string;
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  bestBlockHash: string;
}

export interface BitcoinChainProvider {
  getBestHeight(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string): Promise<BitcoinBlock>;
  getRawTransaction(txid: string): Promise<string>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  /** Fetch + resolve DIRECT prevout script/value for each input (no recursion). */
  getTransaction(txid: string): Promise<BitcoinProtocolTx>;
  /** Resolve a single prevout (previous tx output) by txid:vout. */
  getPrevout(txid: string, vout: number): Promise<ChainUtxo | undefined>;
  getUtxos(scriptOrAddress: string): Promise<ChainUtxo[]>;
  broadcastTransaction(hex: string): Promise<string>;
  testMempoolAccept(hex: string, maxFeeRateSatVb?: bigint): Promise<{ allowed: boolean; rejectReason?: string }>;
  estimateFeeRate(): Promise<bigint>;
  /** Fee rate for an explicit confirmation target, or null when unknown. */
  estimateFeeRateAt(blocks: number): Promise<bigint | null>;
  /** The node's current minimum relay fee, in sat/vB. */
  getMempoolMinFeeSatPerVb(): Promise<bigint>;
}

interface RpcConfig {
  url: string;
  user?: string;
  password?: string;
  apiKey?: string;
  /** Optional fee-rate ceiling (sat/vB) applied to estimation and broadcast. */
  maxFeeRateSatVb?: bigint;
}

export interface RpcReadOptions {
  signal?: AbortSignal;
  retry?: boolean;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly kind: "transport" | "http" | "rpc" | "response",
    message: string,
    readonly httpStatus?: number,
    readonly rpcCode?: number,
  ) {
    super(`RPC ${method}: ${message}`);
    this.name = "RpcError";
  }
}

export function isRpcNotFound(error: unknown, method: string): boolean {
  return error instanceof RpcError && error.kind === "rpc" && error.method === method &&
    error.rpcCode === -5 && (error.httpStatus === 200 || error.httpStatus === 500);
}

export interface TransactionObservation {
  state: "mempool" | "mined" | "unknown";
  blockHash: string | null;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Convert Bitcoin Core's `estimatesmartfee.feerate` (BTC/kvB) to sat/vB.
 * sat/vB = BTC/kvB × 100,000 (1 BTC = 1e8 sats; 1 kvB = 1000 vB).
 * Pure helper so the conversion is unit-testable without an RPC.
 */
export function btcPerKvbToSatPerVb(btcPerKvb: number): bigint {
  if (!Number.isFinite(btcPerKvb) || btcPerKvb <= 0) return 2n;
  return BigInt(Math.max(1, Math.round(btcPerKvb * 100_000)));
}

/**
 * Build the `testmempoolaccept` RPC params. Core expects `[[<hex>], maxfeerate]`
 * (the tx array is separate from the optional BTC/kvB maxfeerate), NOT
 * `[[<hex>, maxfeerate]]`.
 */
export function testMempoolAcceptParams(hex: string, maxfeerateBtcPerKvb?: number): unknown[] {
  return maxfeerateBtcPerKvb === undefined ? [[hex]] : [[hex], maxfeerateBtcPerKvb];
}

/** Bitcoin Core JSON-RPC provider (deterministic full-node-backed indexing). */
export class CoreRpcProvider implements BitcoinChainProvider {
  private id = 0;
  private decodedCache = new Map<string, BitcoinProtocolTx>();
  private rawTransactionPending = new Map<string, Promise<string>>();
  constructor(private readonly cfg: RpcConfig) {
    if (cfg.apiKey && (cfg.user || cfg.password)) {
      throw new Error("RPC API key and Basic credentials cannot be combined");
    }
  }

  private async call<T>(method: string, params: unknown[] = [], options: RpcReadOptions = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) {
      headers["x-api-key"] = this.cfg.apiKey;
    } else if (this.cfg.user !== undefined) {
      const token = Buffer.from(`${this.cfg.user}:${this.cfg.password ?? ""}`).toString("base64");
      headers.authorization = `Basic ${token}`;
    }
    const body = JSON.stringify({ jsonrpc: "1.0", id: `${++this.id}`, method, params });
    const safeMessage = (value: string) => {
      for (const secret of [this.cfg.apiKey, this.cfg.password, this.cfg.user]) {
        if (secret) value = value.split(secret).join("[redacted]");
      }
      return value;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.cfg.url, {
          method: "POST", headers, body,
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new RpcError(method, "transport", safeMessage(error instanceof Error ? error.message : "request failed"));
      }
      if (res.status === 429 && attempt < 3 && options.retry !== false) {
        const retryAfterSeconds = Number(res.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
        await res.body?.cancel();
        await waitForRetry(Math.max(2_000 * (attempt + 1), retryAfterMs), options.signal);
        continue;
      }
      if (!res.ok && res.status !== 500) throw new RpcError(method, "http", `HTTP ${res.status}`, res.status);
      let json: { result?: T; error?: { message?: string; code?: number } | null };
      try {
        json = await res.json() as typeof json;
      } catch {
        throw new RpcError(method, res.ok ? "response" : "http", res.ok ? "invalid JSON response" : `HTTP ${res.status}`, res.status);
      }
      if (!json || typeof json !== "object") throw new RpcError(method, "response", "invalid RPC response", res.status);
      if (json.error) throw new RpcError(method, "rpc", safeMessage(typeof json.error.message === "string" ? json.error.message : "node rejected request"), res.status, json.error.code);
      if (!res.ok) throw new RpcError(method, "http", `HTTP ${res.status}`, res.status);
      if (!("result" in json)) throw new RpcError(method, "response", "missing RPC result", res.status);
      return json.result as T;
    }
    throw new Error(`RPC ${method} rate limit retries exhausted`);
  }

  async getBestHeight(): Promise<number> {
    return this.call<number>("getblockcount");
  }

  async getBlockHash(height: number, options?: RpcReadOptions): Promise<string> {
    return this.call<string>("getblockhash", [height], options);
  }

  async getBlockchainInfo(options?: RpcReadOptions): Promise<BlockchainInfo> {
    const info = await this.call<{ chain: string; blocks: number; bestblockhash: string }>(
      "getblockchaininfo",
      [], options,
    );
    return { chain: info.chain, blocks: info.blocks, bestBlockHash: info.bestblockhash };
  }

  async getBlock(hash: string): Promise<BitcoinBlock> {
    // Fetch the serialized block once (verbosity 0) and parse it locally with
    // bitcoinjs-lib — one RPC call yields every raw transaction, avoiding N+1
    // per-transaction lookups.
    const raw = await this.call<string>("getblock", [hash, 0]);
    const header = await this.call<{ height: number; previousblockhash?: string }>(
      "getblockheader",
      [hash],
    );
    const block = bitcoin.Block.fromHex(raw);
    // Verify the parsed block is the one requested and its merkle root matches.
    if (block.getId() !== hash) throw new Error(`Block hash mismatch: requested ${hash}, got ${block.getId()}`);
    const transactions = block.transactions ?? [];
    const mutated = { value: false };
    const actualMerkleRoot = bitcoin.Block.calculateMerkleRoot(transactions, false, mutated);
    if (mutated.value || !block.merkleRoot!.equals(actualMerkleRoot)) {
      throw new Error("Block merkle root mismatch.");
    }
    const txids = transactions.map((tx) => tx.getId());
    const rawTxs = transactions.map((tx) => tx.toHex());
    return {
      hash,
      height: header.height,
      previousBlockHash: header.previousblockhash ?? "",
      txids,
      rawTxs,
    };
  }

  async getRawTransaction(txid: string): Promise<string> {
    const pending = this.rawTransactionPending.get(txid);
    if (pending) return pending;
    const read = this.call<string>("getrawtransaction", [txid, false]).finally(() => {
      this.rawTransactionPending.delete(txid);
    });
    this.rawTransactionPending.set(txid, read);
    return read;
  }

  async observeTransaction(txid: string, options: RpcReadOptions = {}): Promise<TransactionObservation> {
    try {
      const entry = await this.call<{ vsize?: number }>("getmempoolentry", [txid], options);
      if (!entry || !Number.isSafeInteger(entry.vsize) || entry.vsize! <= 0) throw new RpcError("getmempoolentry", "response", "invalid mempool entry");
      return { state: "mempool", blockHash: null };
    } catch (error) {
      if (!isRpcNotFound(error, "getmempoolentry")) throw error;
    }
    try {
      const tx = await this.call<{ txid: string; blockhash?: string; confirmations?: number }>("getrawtransaction", [txid, true], options);
      if (!tx || tx.txid !== txid) throw new RpcError("getrawtransaction", "response", "transaction identity mismatch");
      if (typeof tx.blockhash === "string" && /^[a-f0-9]{64}$/i.test(tx.blockhash) && Number.isSafeInteger(tx.confirmations) && tx.confirmations! > 0) {
        return { state: "mined", blockHash: tx.blockhash };
      }
      return { state: "unknown", blockHash: null };
    } catch (error) {
      if (!isRpcNotFound(error, "getrawtransaction")) throw error;
      return { state: "unknown", blockHash: null };
    }
  }

  /** Decode a raw transaction (cached; correctness never depends on the cache). */
  private async getDecodedTransaction(txid: string): Promise<BitcoinProtocolTx> {
    const cached = this.decodedCache.get(txid);
    if (cached) return cached;
    const raw = await this.getRawTransaction(txid);
    const tx = decodeRawTransaction(raw);
    if (this.decodedCache.size >= 10_000) this.decodedCache.clear(); // bound memory
    this.decodedCache.set(txid, tx);
    return tx;
  }

  /** Resolve a single prevout without recursing into its ancestors. */
  async getPrevout(txid: string, vout: number): Promise<ChainUtxo | undefined> {
    const prev = await this.getDecodedTransaction(txid);
    const out = prev.outputs[vout];
    if (!out) return undefined;
    return {
      txid,
      vout,
      scriptPubKeyHex: out.scriptPubKeyHex,
      valueSats: out.valueSats,
      confirmations: 0, // unknown; caller derives from height if needed
    };
  }

  /**
   * Get the current UTXO for txid:vout (Core `gettxout`). Returns null when the
   * output is already spent — the authoritative "unspent" check.
   */
  async getTxout(txid: string, vout: number): Promise<{ scriptPubKeyHex: string; valueSats: bigint; confirmations: number; bestBlockHash?: string } | null> {
    const res = await this.call<{ scriptPubKey?: { hex: string }; value?: number; confirmations?: number; bestblock?: string } | null>(
      "gettxout",
      [txid, vout],
    );
    if (res === null) return null;
    if (!res || typeof res.scriptPubKey?.hex !== "string" || !/^(?:[a-f0-9]{2})*$/i.test(res.scriptPubKey.hex) ||
      typeof res.value !== "number" || !Number.isFinite(res.value) || res.value < 0 || res.value > 21_000_000 ||
      !Number.isSafeInteger(res.confirmations) || res.confirmations! < 0) {
      throw new RpcError("gettxout", "response", "invalid unspent output");
    }
    return {
      scriptPubKeyHex: res.scriptPubKey.hex,
      valueSats: BigInt(Math.round(res.value * 1e8)),
      confirmations: res.confirmations!,
      bestBlockHash: res.bestblock,
    };
  }

  async getTransaction(txid: string): Promise<BitcoinProtocolTx> {
    const tx = await this.getDecodedTransaction(txid);
    // Resolve DIRECT prevouts only — never recursively walk ancestry.
    for (const input of tx.inputs) {
      if (input.prevTxid === "0".repeat(64)) continue; // coinbase
      const prevOut = await this.getPrevout(input.prevTxid, input.vout);
      if (prevOut) {
        input.prevScriptPubKeyHex = prevOut.scriptPubKeyHex;
        input.prevValueSats = prevOut.valueSats;
      }
    }
    return tx;
  }

  async getUtxos(): Promise<ChainUtxo[]> {
    // Core RPC requires a wallet for listunspent; not used for indexing.
    return [];
  }

  async broadcastTransaction(hex: string): Promise<string> {
    // Pass an explicit maxfeerate (BTC/kvB) so a buggy node cannot relay a
    // wildly over-paying tx on our behalf.
    const maxfeerate = this.cfg.maxFeeRateSatVb ? Number(this.cfg.maxFeeRateSatVb) / 100_000 : undefined;
    return this.call<string>("sendrawtransaction", maxfeerate === undefined ? [hex] : [hex, maxfeerate]);
  }

  /**
   * Preflight a raw transaction against the mempool policy before broadcasting.
   * Returns a structured result rather than throwing, so callers can surface
   * the node's rejection reason.
   */
  async testMempoolAccept(hex: string, maxFeeRateSatVb?: bigint): Promise<{ allowed: boolean; rejectReason?: string }> {
    const maxfeerate = maxFeeRateSatVb !== undefined
      ? Number(maxFeeRateSatVb) / 100_000
      : this.cfg.maxFeeRateSatVb
        ? Number(this.cfg.maxFeeRateSatVb) / 100_000
        : undefined;
    const res = await this.call<{ allowed: boolean; "reject-reason"?: string }[]>(
      "testmempoolaccept",
      testMempoolAcceptParams(hex, maxfeerate),
    );
    const r = res?.[0];
    if (!r) return { allowed: false, rejectReason: "no result" };
    return { allowed: r.allowed, rejectReason: r["reject-reason"] };
  }

  async estimateFeeRate(): Promise<bigint> {
    // estimatesmartfee returns an OBJECT { feerate (BTC/kvB), blocks, errors? }.
    const res = await this.call<{ feerate?: number; errors?: string[] }>("estimatesmartfee", [2]);
    const btcPerKvb = res?.feerate;
    let rate: bigint;
    if (typeof btcPerKvb !== "number" || !Number.isFinite(btcPerKvb) || btcPerKvb <= 0) {
      rate = 2n; // fallback: 2 sat/vB
    } else {
      rate = btcPerKvbToSatPerVb(btcPerKvb); // sat/vB = BTC/kvB × 100,000
    }
    // Clamp to the caller-supplied ceiling (do not trust the node).
    if (this.cfg.maxFeeRateSatVb && rate > this.cfg.maxFeeRateSatVb) {
      return this.cfg.maxFeeRateSatVb;
    }
    return rate;
  }

  /**
   * `estimatesmartfee` for an explicit confirmation target, in sat/vB.
   *
   * Returns null when the node has no estimate — a fresh regtest chain, or a
   * node that has not seen enough blocks. A null must NOT be silently turned
   * into a low number here: the caller decides the fallback, because only the
   * caller knows whether guessing is acceptable.
   */
  async estimateFeeRateAt(blocks: number, options?: RpcReadOptions): Promise<bigint | null> {
    const res = await this.call<{ feerate?: number; errors?: string[] }>("estimatesmartfee", [
      blocks,
    ], options);
    const btcPerKvb = res?.feerate;
    if (btcPerKvb === undefined && Array.isArray(res?.errors) && res.errors.length > 0 && res.errors.every((e) => typeof e === "string")) return null;
    if (typeof btcPerKvb !== "number" || !Number.isFinite(btcPerKvb) || btcPerKvb <= 0) throw new RpcError("estimatesmartfee", "response", "invalid fee estimate");
    const rate = btcPerKvbToSatPerVb(btcPerKvb);
    if (this.cfg.maxFeeRateSatVb && rate > this.cfg.maxFeeRateSatVb) {
      return this.cfg.maxFeeRateSatVb;
    }
    return rate;
  }

  /**
   * The node's current minimum relay fee in sat/vB (`getmempoolinfo.mempoolminfee`).
   *
   * This rises above the 1 sat/vB default once the mempool fills and starts
   * evicting. A transaction below it is not "slow" — it is refused outright,
   * so it is the hard floor every build must clear.
   */
  async getMempoolMinFeeSatPerVb(options?: RpcReadOptions): Promise<bigint> {
    const info = await this.call<{ mempoolminfee?: number; minrelaytxfee?: number }>(
      "getmempoolinfo",
      [], options,
    );
    if (typeof info?.mempoolminfee !== "number" || typeof info.minrelaytxfee !== "number" ||
      !Number.isFinite(info.mempoolminfee) || !Number.isFinite(info.minrelaytxfee) ||
      info.mempoolminfee < 0 || info.minrelaytxfee < 0) throw new RpcError("getmempoolinfo", "response", "invalid relay fee observation");
    const btcPerKvb = Math.max(info.mempoolminfee, info.minrelaytxfee);
    // Round UP: a truncated floor would let a transaction through that the node
    // then refuses.
    return BigInt(Math.max(1, Math.ceil(btcPerKvb * 100_000)));
  }
}
