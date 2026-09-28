import * as bitcoin from "bitcoinjs-lib";
import type { BitcoinBlock, ChainUtxo } from "./provider.js";
import { decodeRawTransaction, type BitcoinProtocolTx } from "./decoder.js";
import { btcNetwork, type NetworkName } from "./decoder.js";

interface EsploraUtxoJson {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean; block_height?: number };
}

/**
 * Address-indexed UTXO source via a public Esplora HTTP API (blockstream.info
 * or mempool.space). Used to resolve REAL funding UTXOs for the signer — the
 * Core RPC `listunspent` path requires a wallet and must not remain a stub for
 * the test execution path.
 */
export class EsploraUtxoProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly network: NetworkName = "signet",
  ) {}

  async getUtxos(address: string, bestHeight?: number): Promise<ChainUtxo[]> {
    const net = btcNetwork(this.network);
    const script = bitcoin.address.toOutputScript(address, net);
    const scriptHex = script.toString("hex");

    const res = await fetch(`${this.baseUrl}/address/${address}/utxo`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Esplora utxo HTTP ${res.status}`);
    const utxos = (await res.json()) as EsploraUtxoJson[];

    if (bestHeight === undefined && utxos.some((u) => u.status?.confirmed)) {
      const tip = await fetch(`${this.baseUrl}/blocks/tip/height`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!tip.ok) throw new Error(`Esplora tip HTTP ${tip.status}`);
      const rawHeight = (await tip.text()).trim();
      bestHeight = /^\d+$/.test(rawHeight) ? Number(rawHeight) : NaN;
      if (!Number.isSafeInteger(bestHeight)) throw new Error("Esplora returned an invalid tip height");
    }

    return utxos.map((u) => {
      const blockHeight = u.status?.block_height;
      const confirmations = u.status?.confirmed && blockHeight !== undefined && bestHeight !== undefined ? bestHeight - blockHeight + 1 : 0;
      return {
        txid: u.txid,
        vout: u.vout,
        scriptPubKeyHex: scriptHex,
        valueSats: BigInt(Math.round(u.value)),
        confirmations: Math.max(0, confirmations),
      };
    });
  }
}

interface EsploraTxJson {
  txid: string;
  vout: { value: number; scriptpubkey: string }[];
  status?: { confirmed: boolean; block_height?: number; block_hash?: string };
}

/**
 * Minimal Esplora-backed CHAIN provider (tip, block hash, block txs, raw tx,
 * prevout, UTXOs, tx status, broadcast) for a custom signet such as Mutinynet.
 * It never touches Core RPC or the default-signet endpoints.
 */
export class EsploraChainProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly network: NetworkName = "signet",
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Esplora ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async getText(path: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Esplora ${path} HTTP ${res.status}`);
    return (await res.text()).trim();
  }

  async getBestHeight(): Promise<number> {
    const raw = await this.getText("/blocks/tip/height");
    const height = Number.parseInt(raw, 10);
    if (!Number.isFinite(height) || height < 0) {
      throw new Error(`Esplora /blocks/tip/height returned non-numeric value "${raw}"`);
    }
    return height;
  }

  async getBlockHash(height: number): Promise<string> {
    const hash = await this.getText(`/block-height/${height}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Esplora /block-height/${height} returned invalid block hash "${hash}"`);
    }
    return hash;
  }

  async getBlock(hash: string): Promise<BitcoinBlock> {
    const txids = await this.get<string[]>(`/block/${hash}/txids`);
    const meta = await this.get<{ id: string; height: number; previousblockhash?: string; merkle_root?: string }>(`/block/${hash}`);
    // Verify the host actually returned the requested block (B-3: mirror Core's
    // provider.getBlock hash + merkle verification).
    if (meta.id !== hash) {
      throw new Error(`Esplora block id ${meta.id} != requested ${hash}`);
    }
    const rawTxs: string[] = [];
    const txs: bitcoin.Transaction[] = [];
    for (const txid of txids) {
      const raw = await this.getText(`/tx/${txid}/hex`);
      const tx = bitcoin.Transaction.fromHex(raw);
      if (tx.getId() !== txid) {
        throw new Error(`Esplora tx ${txid} decoded to a different txid ${tx.getId()}`);
      }
      rawTxs.push(raw);
      txs.push(tx);
    }
    if (meta.merkle_root && txs.length > 0) {
      const mutated = { value: false };
      const root = bitcoin.Block.calculateMerkleRoot(txs, false, mutated);
      // calculateMerkleRoot returns the internal (little-endian) order; Esplora
      // presents the merkle root in display order.
      const display = Buffer.from(root).reverse().toString("hex");
      if (mutated.value || display !== meta.merkle_root) {
        throw new Error("Esplora block merkle root mismatch");
      }
    }
    return { hash, height: meta.height, previousBlockHash: meta.previousblockhash ?? "", txids, rawTxs };
  }

  async getRawTransaction(txid: string): Promise<string> {
    return this.getText(`/tx/${txid}/hex`);
  }

  async getTransaction(txid: string): Promise<BitcoinProtocolTx> {
    const raw = await this.getRawTransaction(txid);
    const tx = decodeRawTransaction(raw, this.network);
    for (const input of tx.inputs) {
      if (input.prevTxid === "0".repeat(64)) continue;
      const prev = await this.getPrevout(input.prevTxid, input.vout);
      if (prev) {
        input.prevScriptPubKeyHex = prev.scriptPubKeyHex;
        input.prevValueSats = prev.valueSats;
      }
    }
    return tx;
  }

  async getPrevout(txid: string, vout: number): Promise<ChainUtxo | undefined> {
    const tx = await this.get<EsploraTxJson>(`/tx/${txid}`);
    const out = tx.vout[vout];
    if (!out) return undefined;
    return {
      txid,
      vout,
      scriptPubKeyHex: out.scriptpubkey,
      valueSats: BigInt(Math.round(out.value)),
      confirmations: tx.status?.block_height !== undefined ? Math.max(0, (await this.getBestHeight()) - tx.status.block_height + 1) : 0,
    };
  }

  async getTxStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; blockHash?: string } | null> {
    try {
      const s = await this.get<{ confirmed: boolean; block_height?: number; block_hash?: string }>(`/tx/${txid}/status`);
      return { confirmed: s.confirmed, blockHeight: s.block_height, blockHash: s.block_hash };
    } catch {
      return null;
    }
  }

  async broadcastTransaction(hex: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/tx`, {
      method: "POST",
      body: hex,
      headers: { "content-type": "text/plain" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Esplora broadcast HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.text()).trim();
  }
}
