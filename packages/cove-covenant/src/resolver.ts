import type { CoveStateV2 } from "./stateV2.js";

/**
 * Minimal deterministic in-memory Cove chain view (§4). Resolves Cove token
 * inputs from ACTUAL transaction input outpoints (never from caller-supplied
 * claims) and maintains the unspent token-UTXO set + backing state. This is
 * test infrastructure for the real lifecycle and can later feed the DB indexer.
 */

export interface OutPoint {
  txid: string;
  vout: number;
}

export interface TokenUtxo {
  outpoint: OutPoint;
  tokenId: Buffer;
  amountAtoms: bigint;
  scriptPubKey: Buffer;
}

export interface TokenMeta {
  tokenId: Buffer;
  ticker: string;
  policyVersion: number;
  deployTxid: string;
  tokenNonce: Buffer;
  /** Creator payout script, from DEPLOY output 2. */
  creatorScript?: Buffer;
}

export interface BackingView {
  state: CoveStateV2;
  outpoint: OutPoint;
}

/**
 * Minimal canonical view interface the Guardian and the production indexer
 * share (§7/§23). The Guardian resolves actual tx input outpoints against a
 * pure synchronous view; the caller never labels arbitrary BTC inputs as Cove
 * inputs. `CoveChainView` and the indexer's DB snapshot loader both implement it.
 */
export interface CoveCanonicalView {
  /** Indexed chain height, when the view comes from the persistent indexer. */
  readonly cursorHeight?: bigint;
  getBackingStateByOutpoint(outpoint: OutPoint): CoveStateV2 | null;
  getCurrentBackingState(tokenId: Buffer): CoveStateV2 | null;
  getBackingOutpoint(tokenId: Buffer): OutPoint | null;
  getTokenUtxo(outpoint: OutPoint): TokenUtxo | null;
  /** The token's creator payout script, recorded at DEPLOY. Required to validate a MINT. */
  getTokenCreatorScript?(tokenId: Buffer): Buffer | null;
}

function opKey(o: OutPoint): string {
  return `${o.txid}:${o.vout}`;
}

export class CoveChainView {
  readonly tokens = new Map<string, TokenMeta>();
  readonly tokenUtxos = new Map<string, TokenUtxo>();
  readonly backing = new Map<string, BackingView>();

  deploy(meta: TokenMeta, backingOutpoint: OutPoint, s0: CoveStateV2): void {
    const key = meta.tokenId.toString("hex");
    if (this.tokens.has(key)) throw new Error("duplicate tokenId deploy");
    this.tokens.set(key, meta);
    this.backing.set(key, { state: s0, outpoint: backingOutpoint });
  }

  /** Mint: record successor backing + buyer token carrier output. */
  mint(params: {
    tokenId: Buffer;
    nextState: CoveStateV2;
    prevBackingOutpoint: OutPoint;
    nextBackingOutpoint: OutPoint;
    recipientOutpoint: OutPoint;
    recipientScript: Buffer;
    amountAtoms: bigint;
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    const b = this.backing.get(key)!;
    if (opKey(b.outpoint) !== opKey(params.prevBackingOutpoint))
      throw new Error("stale backing outpoint");
    this.backing.set(key, { state: params.nextState, outpoint: params.nextBackingOutpoint });
    this.tokenUtxos.set(opKey(params.recipientOutpoint), {
      outpoint: params.recipientOutpoint,
      tokenId: params.tokenId,
      amountAtoms: params.amountAtoms,
      scriptPubKey: params.recipientScript,
    });
  }

  /** Transfer: spend token inputs, create allocated outputs (recipient + change). */
  transfer(params: {
    tokenId: Buffer;
    spentOutpoints: OutPoint[];
    created: { outpoint: OutPoint; script: Buffer; amountAtoms: bigint }[];
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    for (const o of params.spentOutpoints) {
      const u = this.tokenUtxos.get(opKey(o));
      if (!u) throw new Error(`token input ${opKey(o)} not in canonical set`);
      if (!u.tokenId.equals(params.tokenId)) throw new Error("mixed token input");
      this.tokenUtxos.delete(opKey(o));
    }
    for (const c of params.created) {
      this.tokenUtxos.set(opKey(c.outpoint), {
        outpoint: c.outpoint,
        tokenId: params.tokenId,
        amountAtoms: c.amountAtoms,
        scriptPubKey: c.script,
      });
    }
  }

  /** Redeem: spend token input(s) + backing; record successor backing + change. */
  redeem(params: {
    tokenId: Buffer;
    nextState: CoveStateV2;
    prevBackingOutpoint: OutPoint;
    nextBackingOutpoint: OutPoint;
    spentTokenOutpoints: OutPoint[];
    change: { outpoint: OutPoint; script: Buffer; amountAtoms: bigint }[];
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    const b = this.backing.get(key)!;
    if (opKey(b.outpoint) !== opKey(params.prevBackingOutpoint))
      throw new Error("stale backing outpoint");
    this.backing.set(key, { state: params.nextState, outpoint: params.nextBackingOutpoint });
    for (const o of params.spentTokenOutpoints) {
      const u = this.tokenUtxos.get(opKey(o));
      if (!u) throw new Error(`token input ${opKey(o)} not in canonical set`);
      if (!u.tokenId.equals(params.tokenId)) throw new Error("mixed token input");
      this.tokenUtxos.delete(opKey(o));
    }
    for (const c of params.change) {
      this.tokenUtxos.set(opKey(c.outpoint), {
        outpoint: c.outpoint,
        tokenId: params.tokenId,
        amountAtoms: c.amountAtoms,
        scriptPubKey: c.script,
      });
    }
  }

  /** Current backing state for a tokenId (the canonical backing UTXO's state). */
  getCurrentBackingState(tokenId: Buffer): CoveStateV2 | null {
    return this.backing.get(tokenId.toString("hex"))?.state ?? null;
  }

  /** Current backing outpoint for a tokenId (the canonical backing UTXO). */
  getBackingOutpoint(tokenId: Buffer): OutPoint | null {
    return this.backing.get(tokenId.toString("hex"))?.outpoint ?? null;
  }

  /** Resolve the backing state spent at a specific outpoint, if it is canonical. */
  getBackingStateByOutpoint(o: OutPoint): CoveStateV2 | null {
    for (const b of this.backing.values()) {
      if (opKey(b.outpoint) === opKey(o)) return b.state;
    }
    return null;
  }

  /** The creator payout script recorded at DEPLOY. */
  getTokenCreatorScript(tokenId: Buffer): Buffer | null {
    return this.tokens.get(tokenId.toString("hex"))?.creatorScript ?? null;
  }

  /** Resolve a single token UTXO by outpoint. */
  getTokenUtxo(o: OutPoint): TokenUtxo | null {
    return this.tokenUtxos.get(opKey(o)) ?? null;
  }

  /** Resolve the Cove token inputs actually referenced by a transaction's inputs. */
  resolveTokenInputs(ins: { txid: string; vout: number }[]): TokenUtxo[] {
    const out: TokenUtxo[] = [];
    for (const i of ins) {
      const u = this.tokenUtxos.get(opKey(i));
      if (u) out.push(u);
    }
    return out;
  }

  /** Aggregate spendable balance (derived; not authoritative). */
  balanceOf(tokenId: Buffer): bigint {
    let total = 0n;
    for (const u of this.tokenUtxos.values()) {
      if (u.tokenId.equals(tokenId)) total += u.amountAtoms;
    }
    return total;
  }
}
