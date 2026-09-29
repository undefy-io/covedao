import * as bitcoin from "bitcoinjs-lib";
import {
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  s0StateV2,
  stateHashV2,
  type CoveStateV2,
  type OutPoint,
  type TokenUtxo,
} from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import {
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
  computeTokenId,
  type ParsedEnvelopeV2,
} from "@crclaunch/cove-wire";
import { isValidRedeemPayout, COVE_FEE_CONFIG, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, creatorFeeSats, isCreatorScript, mintFeeSats, redeemFeeSats, isP2TR, isP2WPKH } from "@crclaunch/cove-economics";
import { RESERVE_ANCHOR_SATS } from "./constants.js";
import { parseCoveTx, txidOf } from "./parser.js";
import { computeStateRoot } from "./root.js";
import type {
  BlockUndo,
  UndoOp,
  V3Backing,
  V3BlockInput,
  V3Cursor,
  V3Event,
  V3CurveTrade,
  V3IndexerConfig,
  V3TokenMeta,
  V3TokenUtxo,
} from "./types.js";

/**
 * Canonical V3 indexer state machine (§6/§9-§13). Applies valid Cove
 * transitions atomically per block and records an undo journal for reorgs.
 * Invalid Cove transactions are recorded as events and never apply their
 * operation — but any token carrier a transaction spends without validly
 * moving it is burned, whatever kind of transaction spent it.
 * Balances are always derived from the token-UTXO set (never stored).
 */

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function isStandardCarrier(script: Buffer): boolean {
  return isP2TR(script) || isP2WPKH(script);
}

type ApplyResult = {
  op: V3Event["operation"];
  valid: boolean;
  reason: string | null;
  tokenId: string | null;
  undo: UndoOp | null;
  /** Economics of a valid curve trade; null for DEPLOY and TRANSFER. */
  curve?: V3CurveTrade | null;
};

export class V3IndexerState {
  readonly tokens = new Map<string, V3TokenMeta>();
  readonly backing = new Map<string, V3Backing>();
  readonly tokenUtxos = new Map<string, V3TokenUtxo>();
  readonly events: V3Event[] = [];
  readonly undoByHeight = new Map<bigint, BlockUndo>();
  cursor: V3Cursor;

  constructor(readonly config: V3IndexerConfig) {
    this.cursor = { network: config.network, height: 0n, blockHash: "", stateRoot: this.stateRoot() };
  }

  stateRoot(): string {
    return computeStateRoot({ tokens: this.tokens, backing: this.backing, tokenUtxos: this.tokenUtxos });
  }

  /** Deep-clone the derived state (for staged persistence + atomic swap). */
  clone(): V3IndexerState {
    const c = new V3IndexerState(this.config);
    for (const [k, v] of this.tokens) c.tokens.set(k, { ...v });
    for (const [k, v] of this.backing) c.backing.set(k, { ...v, state: { ...v.state }, outpoint: { ...v.outpoint } });
    for (const [k, v] of this.tokenUtxos) c.tokenUtxos.set(k, { ...v });
    c.events.push(...this.events.map((e) => ({ ...e })));
    for (const [k, v] of this.undoByHeight) c.undoByHeight.set(k, v);
    c.cursor = { ...this.cursor };
    return c;
  }

  /** Replace this state's contents with a staged clone (only after DB commit). */
  adopt(other: V3IndexerState): void {
    this.tokens.clear();
    this.backing.clear();
    this.tokenUtxos.clear();
    this.events.length = 0;
    this.undoByHeight.clear();
    for (const [k, v] of other.tokens) this.tokens.set(k, { ...v });
    for (const [k, v] of other.backing) this.backing.set(k, { ...v, state: { ...v.state }, outpoint: { ...v.outpoint } });
    for (const [k, v] of other.tokenUtxos) this.tokenUtxos.set(k, { ...v });
    this.events.push(...other.events.map((e) => ({ ...e })));
    for (const [k, v] of other.undoByHeight) this.undoByHeight.set(k, v);
    this.cursor = { ...other.cursor };
  }

  // ── CoveCanonicalView (§23): the Guardian validates against this pure view ──
  getBackingStateByOutpoint(o: OutPoint): CoveStateV2 | null {
    for (const b of this.backing.values()) {
      if (b.outpoint.txid === o.txid && b.outpoint.vout === o.vout) return b.state;
    }
    return null;
  }
  getCurrentBackingState(tokenId: Buffer): CoveStateV2 | null {
    return this.backing.get(tokenId.toString("hex"))?.state ?? null;
  }
  getBackingOutpoint(tokenId: Buffer): OutPoint | null {
    return this.backing.get(tokenId.toString("hex"))?.outpoint ?? null;
  }
  getTokenCreatorScript(tokenId: Buffer): Buffer | null {
    const c = this.tokens.get(tokenId.toString("hex"))?.creatorScript;
    return c ? Buffer.from(c, "hex") : null;
  }
  getTokenUtxo(o: OutPoint): TokenUtxo | null {
    const u = this.tokenUtxos.get(outpointKey(o.txid, o.vout));
    if (!u) return null;
    return {
      outpoint: { txid: u.txid, vout: u.vout },
      tokenId: Buffer.from(u.tokenId, "hex"),
      amountAtoms: u.amountAtoms,
      scriptPubKey: Buffer.from(u.scriptPubKey, "hex"),
    };
  }

  private record(e: V3Event): void {
    this.events.push(e);
  }

  private bitcoinNetwork(): bitcoin.networks.Network {
    switch (this.config.network) {
      case "regtest":
        return bitcoin.networks.regtest;
      case "mainnet":
        return bitcoin.networks.bitcoin;
      default:
        return bitcoin.networks.testnet;
    }
  }

  /** Apply one canonical block; returns the events produced and stores undo. */
  applyBlock(block: V3BlockInput): V3Event[] {
    // Activation height (§13/§48): Cove ops BELOW the activation height are ignored.
    if (block.height < this.config.genesisHeight) return [];
    const ops: UndoOp[] = [];
    const events: V3Event[] = [];
    for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
      const rawHex = block.txs[txIndex]!;
      const txid = txidOf(rawHex);
      const parsed = parseCoveTx(rawHex);
      if (parsed.kind === "NON_COVE") {
        const burn = this.burnUnaccountedInputs(txid, rawHex);
        if (burn) ops.push(burn);
        continue;
      }

      let op: V3Event["operation"] = null;
      let valid = false;
      let reason: string | null = null;
      let tokenId: string | null = null;
      let undo: UndoOp | null = null;
      let curve: V3CurveTrade | null = null;

      if (parsed.kind === "INVALID") {
        op = null;
        valid = false;
        reason = parsed.reason;
      } else {
        const r = this.applyCove(txid, rawHex, parsed.envelope, block);
        op = r.op;
        valid = r.valid;
        reason = r.reason;
        tokenId = r.tokenId;
        undo = r.undo;
        curve = r.curve ?? null;
        if (r.valid && undo) ops.push(undo);
      }
      // Whatever the transaction did validly has already consumed its token
      // inputs; any carrier it still spends was not accounted for and is burned.
      const burn = this.burnUnaccountedInputs(txid, rawHex);
      if (burn) ops.push(burn);

      const event: V3Event = {
        txid,
        blockHeight: block.height,
        blockHash: block.hash,
        txIndex,
        operation: op,
        valid,
        reason,
        tokenId,
        curve,
      };
      events.push(event);
      this.record(event);
    }

    this.undoByHeight.set(block.height, { height: block.height, blockHash: block.hash, ops });
    this.cursor = {
      network: this.config.network,
      height: block.height,
      blockHash: block.hash,
      stateRoot: this.stateRoot(),
    };
    return events;
  }

  /**
   * Remove every live token UTXO this transaction spends. Called after the
   * transaction's own Cove operation (if any) has consumed the inputs it
   * validly moved, so only carriers spent outside the protocol remain.
   *
   * Without this, a carrier swept by an ordinary wallet stayed "unspent" here
   * forever: the holder's balance showed tokens that no longer existed and
   * that nobody could ever move or redeem.
   */
  private burnUnaccountedInputs(txid: string, rawHex: string): UndoOp | null {
    const spentUtxos: V3TokenUtxo[] = [];
    for (const input of bitcoin.Transaction.fromHex(rawHex).ins) {
      const key = outpointKey(Buffer.from(input.hash).reverse().toString("hex"), input.index);
      const live = this.tokenUtxos.get(key);
      if (!live) continue;
      this.tokenUtxos.delete(key);
      spentUtxos.push(live);
    }
    return spentUtxos.length > 0 ? { kind: "BURN", spendingTxid: txid, spentUtxos } : null;
  }

  /** Reverse the block at `height` (reorg support). */
  undoBlock(height: bigint): void {
    const undo = this.undoByHeight.get(height);
    if (!undo) throw new Error(`no undo journal for height ${height}`);
    for (const op of [...undo.ops].reverse()) {
      switch (op.kind) {
        case "DEPLOY": {
          this.tokens.delete(op.tokenId);
          this.backing.delete(op.tokenId);
          break;
        }
        case "MINT": {
          this.backing.set(op.tokenId, op.priorBacking);
          this.tokenUtxos.delete(outpointKey(op.createdUtxo.txid, op.createdUtxo.vout));
          break;
        }
        case "REDEEM": {
          this.backing.set(op.tokenId, op.priorBacking);
          for (const u of op.createdUtxos) this.tokenUtxos.delete(outpointKey(u.txid, u.vout));
          for (const u of op.spentUtxos) this.tokenUtxos.set(outpointKey(u.txid, u.vout), u);
          break;
        }
        case "TRANSFER": {
          for (const u of op.createdUtxos) this.tokenUtxos.delete(outpointKey(u.txid, u.vout));
          for (const u of op.spentUtxos) this.tokenUtxos.set(outpointKey(u.txid, u.vout), u);
          break;
        }
        case "BURN": {
          for (const u of op.spentUtxos) this.tokenUtxos.set(outpointKey(u.txid, u.vout), u);
          break;
        }
      }
    }
    // remove events from this block
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.blockHeight === height) this.events.splice(i, 1);
    }
    this.undoByHeight.delete(height);
    const prior = this.undoByHeight.get(height - 1n);
    this.cursor = prior
      ? { network: this.config.network, height: height - 1n, blockHash: prior.blockHash, stateRoot: this.stateRoot() }
      : { network: this.config.network, height: 0n, blockHash: "", stateRoot: this.stateRoot() };
  }

  private applyCove(
    txid: string,
    rawHex: string,
    envelope: ParsedEnvelopeV2,
    block: V3BlockInput,
  ): ApplyResult {
    switch (envelope.op) {
      case OP_DEPLOY:
        return this.applyDeploy(txid, rawHex, envelope, block);
      case OP_MINT:
        return this.applyMint(txid, rawHex, envelope, block);
      case OP_TRANSFER:
        return this.applyTransfer(txid, rawHex, envelope, block);
      case OP_REDEEM:
        return this.applyRedeem(txid, rawHex, envelope, block);
      default:
        return { op: null, valid: false, reason: "BAD_OPCODE", tokenId: null, undo: null };
    }
  }

  private applyDeploy(
    txid: string,
    rawHex: string,
    envelope: ParsedEnvelopeV2,
    block: V3BlockInput,
  ): ApplyResult {
    if (envelope.op !== OP_DEPLOY) return { op: null, valid: false, reason: "WRONG_OPCODE", tokenId: null, undo: null };
    const tx = bitcoin.Transaction.fromHex(rawHex);
    // Output 2 names the creator: exactly CREATOR_RECORD_SATS to the address
    // every mint will pay the creator's share to. The tokenId commits to it,
    // so it is read first.
    const creatorOut = tx.outs[2];
    if (!creatorOut || BigInt(creatorOut.value) !== CREATOR_RECORD_SATS || !isCreatorScript(creatorOut.script)) {
      return { op: "DEPLOY", valid: false, reason: "CREATOR_OUTPUT_MISSING", tokenId: null, undo: null };
    }
    // Output 3 pays the launch fee: exactly LAUNCH_FEE_SATS to the protocol
    // fee address. A launch that skips or shorts it is not a token.
    const launchFeeOut = tx.outs[3];
    if (!launchFeeOut || BigInt(launchFeeOut.value) !== LAUNCH_FEE_SATS || !launchFeeOut.script.equals(this.config.feeScript)) {
      return { op: "DEPLOY", valid: false, reason: "LAUNCH_FEE_MISSING", tokenId: null, undo: null };
    }
    const tokenId = computeTokenId({
      chainIdentity: this.config.chainIdentity,
      policyVersion: envelope.policyVersion,
      ticker: envelope.ticker,
      tokenNonce: envelope.tokenNonce,
      creatorScript: creatorOut.script,
    });
    const tokenIdHex = tokenId.toString("hex");
    if (this.tokens.has(tokenIdHex)) {
      return { op: "DEPLOY", valid: false, reason: "DUPLICATE_TOKEN_ID", tokenId: tokenIdHex, undo: null };
    }
    const s0 = s0StateV2({ tokenId: tokenIdHex });
    const vault = buildBackingVaultV3({
      state: s0,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      network: this.bitcoinNetwork(),
    });
    const s0Out = tx.outs[1];
    if (!s0Out || !s0Out.script.equals(vault.scriptPubKey)) {
      return { op: "DEPLOY", valid: false, reason: "S0_VAULT_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    if (BigInt(s0Out.value) !== RESERVE_ANCHOR_SATS) {
      return { op: "DEPLOY", valid: false, reason: "S0_ANCHOR_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const meta: V3TokenMeta = {
      tokenId: tokenIdHex,
      ticker: envelope.ticker,
      policyVersion: envelope.policyVersion,
      tokenNonce: envelope.tokenNonce.toString("hex"),
      deployTxid: txid,
      deployHeight: block.height,
      deployBlockHash: block.hash,
      creatorScript: creatorOut.script.toString("hex"),
    };
    const backing: V3Backing = {
      tokenId: tokenIdHex,
      state: s0,
      stateHash: stateHashV2(s0),
      outpoint: { txid, vout: 1 },
      scriptPubKey: vault.scriptPubKey.toString("hex"),
      btcValue: RESERVE_ANCHOR_SATS,
      updatedTxid: txid,
      updatedHeight: block.height,
      updatedBlockHash: block.hash,
    };
    this.tokens.set(tokenIdHex, meta);
    this.backing.set(tokenIdHex, backing);
    return { op: "DEPLOY", valid: true, reason: null, tokenId: tokenIdHex, undo: { kind: "DEPLOY", tokenId: tokenIdHex } };
  }

  private applyMint(
    txid: string,
    rawHex: string,
    envelope: ParsedEnvelopeV2,
    block: V3BlockInput,
  ): ApplyResult {
    if (envelope.op !== OP_MINT) return { op: null, valid: false, reason: "WRONG_OPCODE", tokenId: null, undo: null };
    const tokenIdHex = envelope.tokenId.toString("hex");
    const meta = this.tokens.get(tokenIdHex);
    const backing = this.backing.get(tokenIdHex);
    if (!meta || !backing) {
      return { op: "MINT", valid: false, reason: "UNKNOWN_TOKEN", tokenId: tokenIdHex, undo: null };
    }
    const tx = bitcoin.Transaction.fromHex(rawHex);
    const ins0 = tx.ins[0];
    if (!ins0) return { op: "MINT", valid: false, reason: "BAD_TX", tokenId: tokenIdHex, undo: null };
    const ins0Txid = Buffer.from(ins0.hash).reverse().toString("hex");
    if (ins0Txid !== backing.outpoint.txid || ins0.index !== backing.outpoint.vout) {
      return { op: "MINT", valid: false, reason: "STALE_BACKING", tokenId: tokenIdHex, undo: null };
    }
    let nextState: CoveStateV2;
    let grossSats: bigint;
    try {
      const canonical = applyMintV2(backing.state, envelope.amount);
      nextState = canonical.nextState;
      grossSats = canonical.grossSats;
    } catch (e) {
      return { op: "MINT", valid: false, reason: `REFERENCE_REJECTED: ${(e as Error).message}`, tokenId: tokenIdHex, undo: null };
    }
    const feeSats = mintFeeSats(grossSats, envelope.amount, this.config.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps, this.config.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats);
    const nextVault = buildBackingVaultV3({
      state: nextState,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      network: this.bitcoinNetwork(),
    });
    const successor = tx.outs[1];
    if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
      return { op: "MINT", valid: false, reason: "SUCCESSOR_VAULT_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    if (BigInt(successor.value) !== RESERVE_ANCHOR_SATS + nextState.backingSats) {
      return { op: "MINT", valid: false, reason: "SUCCESSOR_VALUE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    if (envelope.recipientVout !== 2) {
      return { op: "MINT", valid: false, reason: "CARRIER_VOUT_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const carrier = tx.outs[2];
    if (!carrier || BigInt(carrier.value) !== TOKEN_CARRIER_SATS || !isStandardCarrier(carrier.script)) {
      return { op: "MINT", valid: false, reason: "CARRIER_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const feeOut = tx.outs[3];
    if (!feeOut || BigInt(feeOut.value) !== feeSats || !feeOut.script.equals(this.config.feeScript)) {
      return { op: "MINT", valid: false, reason: "FEE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const creatorOut = tx.outs[4];
    const creator = this.tokens.get(tokenIdHex)?.creatorScript ?? "";
    if (
      !creatorOut ||
      BigInt(creatorOut.value) !== creatorFeeSats(grossSats, this.config.creatorFeeBps ?? COVE_FEE_CONFIG.creatorFeeBps) ||
      creatorOut.script.toString("hex") !== creator
    ) {
      return { op: "MINT", valid: false, reason: "CREATOR_FEE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }

    const priorBacking = backing;
    const nextBacking: V3Backing = {
      tokenId: tokenIdHex,
      state: nextState,
      stateHash: stateHashV2(nextState),
      outpoint: { txid, vout: 1 },
      scriptPubKey: nextVault.scriptPubKey.toString("hex"),
      btcValue: RESERVE_ANCHOR_SATS + nextState.backingSats,
      updatedTxid: txid,
      updatedHeight: block.height,
      updatedBlockHash: block.hash,
    };
    const createdUtxo: V3TokenUtxo = {
      txid,
      vout: 2,
      tokenId: tokenIdHex,
      amountAtoms: envelope.amount,
      scriptPubKey: carrier.script.toString("hex"),
      createdHeight: block.height,
      createdBlockHash: block.hash,
    };
    this.backing.set(tokenIdHex, nextBacking);
    this.tokenUtxos.set(outpointKey(txid, 2), createdUtxo);
    return {
      op: "MINT",
      valid: true,
      reason: null,
      tokenId: tokenIdHex,
      undo: { kind: "MINT", tokenId: tokenIdHex, priorBacking, createdUtxo },
      curve: {
        amountAtoms: envelope.amount,
        grossSats,
        protocolFeeSats: feeSats,
        supplyAfterAtoms: nextState.issuedPublicSupplyAtoms,
        backingAfterSats: nextState.backingSats,
      },
    };
  }

  private resolveTokenInputs(tx: bitcoin.Transaction, tokenIdHex: string): { utxos: V3TokenUtxo[]; ok: boolean; reason: string } {
    const spent: V3TokenUtxo[] = [];
    let saw = false;
    for (const ins of tx.ins) {
      const insTxid = Buffer.from(ins.hash).reverse().toString("hex");
      const u = this.tokenUtxos.get(outpointKey(insTxid, ins.index));
      if (u) {
        saw = true;
        if (u.tokenId !== tokenIdHex) return { utxos: [], ok: false, reason: "MIXED_TOKEN_INPUT" };
        spent.push(u);
      }
    }
    if (!saw) return { utxos: [], ok: false, reason: "FORGED_TOKEN_INPUT" };
    return { utxos: spent, ok: true, reason: "" };
  }

  private applyTransfer(
    txid: string,
    rawHex: string,
    envelope: ParsedEnvelopeV2,
    block: V3BlockInput,
  ): ApplyResult {
    if (envelope.op !== OP_TRANSFER) return { op: null, valid: false, reason: "WRONG_OPCODE", tokenId: null, undo: null };
    const tokenIdHex = envelope.tokenId.toString("hex");
    if (!this.tokens.has(tokenIdHex)) {
      return { op: "TRANSFER", valid: false, reason: "UNKNOWN_TOKEN", tokenId: tokenIdHex, undo: null };
    }
    const tx = bitcoin.Transaction.fromHex(rawHex);
    const resolved = this.resolveTokenInputs(tx, tokenIdHex);
    if (!resolved.ok) return { op: "TRANSFER", valid: false, reason: resolved.reason, tokenId: tokenIdHex, undo: null };
    const spentUtxos = resolved.utxos;
    const inSum = spentUtxos.reduce((s, u) => s + u.amountAtoms, 0n);
    const outSum = envelope.allocations.reduce((s, a) => s + a.amount, 0n);
    if (inSum !== outSum) {
      return { op: "TRANSFER", valid: false, reason: `TOKEN_CONSERVATION: in=${inSum} out=${outSum}`, tokenId: tokenIdHex, undo: null };
    }
    const createdUtxos: V3TokenUtxo[] = [];
    for (const a of envelope.allocations) {
      const out = tx.outs[a.vout];
      if (!out) return { op: "TRANSFER", valid: false, reason: "ALLOCATION_VOUT_MISSING", tokenId: tokenIdHex, undo: null };
      if (BigInt(out.value) !== TOKEN_CARRIER_SATS || !isStandardCarrier(out.script)) {
        return { op: "TRANSFER", valid: false, reason: "CARRIER_MISMATCH", tokenId: tokenIdHex, undo: null };
      }
      createdUtxos.push({
        txid,
        vout: a.vout,
        tokenId: tokenIdHex,
        amountAtoms: a.amount,
        scriptPubKey: out.script.toString("hex"),
        createdHeight: block.height,
        createdBlockHash: block.hash,
      });
    }
    for (const u of spentUtxos) this.tokenUtxos.delete(outpointKey(u.txid, u.vout));
    for (const u of createdUtxos) this.tokenUtxos.set(outpointKey(u.txid, u.vout), u);
    return {
      op: "TRANSFER",
      valid: true,
      reason: null,
      tokenId: tokenIdHex,
      undo: { kind: "TRANSFER", spendingTxid: txid, spentUtxos, createdUtxos },
    };
  }

  private applyRedeem(
    txid: string,
    rawHex: string,
    envelope: ParsedEnvelopeV2,
    block: V3BlockInput,
  ): ApplyResult {
    if (envelope.op !== OP_REDEEM) return { op: null, valid: false, reason: "WRONG_OPCODE", tokenId: null, undo: null };
    const tokenIdHex = envelope.tokenId.toString("hex");
    const meta = this.tokens.get(tokenIdHex);
    const backing = this.backing.get(tokenIdHex);
    if (!meta || !backing) {
      return { op: "REDEEM", valid: false, reason: "UNKNOWN_TOKEN", tokenId: tokenIdHex, undo: null };
    }
    const tx = bitcoin.Transaction.fromHex(rawHex);
    const ins0 = tx.ins[0];
    if (!ins0) return { op: "REDEEM", valid: false, reason: "BAD_TX", tokenId: tokenIdHex, undo: null };
    const ins0Txid = Buffer.from(ins0.hash).reverse().toString("hex");
    if (ins0Txid !== backing.outpoint.txid || ins0.index !== backing.outpoint.vout) {
      return { op: "REDEEM", valid: false, reason: "STALE_BACKING", tokenId: tokenIdHex, undo: null };
    }
    const resolved = this.resolveTokenInputs(tx, tokenIdHex);
    if (!resolved.ok) return { op: "REDEEM", valid: false, reason: resolved.reason, tokenId: tokenIdHex, undo: null };
    const spentUtxos = resolved.utxos;
    const inputTotal = spentUtxos.reduce((s, u) => s + u.amountAtoms, 0n);
    const changeAtoms = inputTotal - envelope.redeemAmount;
    if (changeAtoms < 0n) {
      return { op: "REDEEM", valid: false, reason: "INSUFFICIENT_OWNERSHIP", tokenId: tokenIdHex, undo: null };
    }
    const wireChangeSum = envelope.changeAllocations.reduce((s, a) => s + a.amount, 0n);
    if (wireChangeSum !== changeAtoms) {
      return { op: "REDEEM", valid: false, reason: "TOKEN_CHANGE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    let nextState: CoveStateV2;
    let grossSats: bigint;
    try {
      const canonical = applyRedeemV2(backing.state, envelope.redeemAmount);
      nextState = canonical.nextState;
      grossSats = canonical.grossSats;
    } catch (e) {
      return { op: "REDEEM", valid: false, reason: `REFERENCE_REJECTED: ${(e as Error).message}`, tokenId: tokenIdHex, undo: null };
    }
    const feeSats = redeemFeeSats(grossSats, this.config.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps, this.config.redeemFeeFlatSats ?? COVE_FEE_CONFIG.redeemFeeFlatSats);
    const nextVault = buildBackingVaultV3({
      state: nextState,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      network: this.bitcoinNetwork(),
    });
    const successor = tx.outs[1];
    if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
      return { op: "REDEEM", valid: false, reason: "SUCCESSOR_VAULT_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    if (BigInt(successor.value) !== RESERVE_ANCHOR_SATS + nextState.backingSats) {
      return { op: "REDEEM", valid: false, reason: "SUCCESSOR_VALUE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const payout = tx.outs[2];
    if (!payout || !isValidRedeemPayout(grossSats, feeSats, BigInt(payout.value), payout.script)) {
      return { op: "REDEEM", valid: false, reason: "PAYOUT_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const feeOut = tx.outs[3];
    if (!feeOut || BigInt(feeOut.value) !== feeSats || !feeOut.script.equals(this.config.feeScript)) {
      return { op: "REDEEM", valid: false, reason: "FEE_MISMATCH", tokenId: tokenIdHex, undo: null };
    }
    const createdUtxos: V3TokenUtxo[] = [];
    if (changeAtoms > 0n) {
      const changeOut = tx.outs[4];
      if (!changeOut || BigInt(changeOut.value) !== TOKEN_CARRIER_SATS || !isStandardCarrier(changeOut.script)) {
        return { op: "REDEEM", valid: false, reason: "CHANGE_CARRIER_MISMATCH", tokenId: tokenIdHex, undo: null };
      }
      if (envelope.changeAllocations.length !== 1 || envelope.changeAllocations[0]!.vout !== 4 || envelope.changeAllocations[0]!.amount !== changeAtoms) {
        return { op: "REDEEM", valid: false, reason: "TOKEN_CHANGE_MISMATCH", tokenId: tokenIdHex, undo: null };
      }
      createdUtxos.push({
        txid,
        vout: 4,
        tokenId: tokenIdHex,
        amountAtoms: changeAtoms,
        scriptPubKey: changeOut.script.toString("hex"),
        createdHeight: block.height,
        createdBlockHash: block.hash,
      });
    } else if (envelope.changeAllocations.length !== 0) {
      return { op: "REDEEM", valid: false, reason: "TOKEN_INFLATION", tokenId: tokenIdHex, undo: null };
    }

    const priorBacking = backing;
    const nextBacking: V3Backing = {
      tokenId: tokenIdHex,
      state: nextState,
      stateHash: stateHashV2(nextState),
      outpoint: { txid, vout: 1 },
      scriptPubKey: nextVault.scriptPubKey.toString("hex"),
      btcValue: RESERVE_ANCHOR_SATS + nextState.backingSats,
      updatedTxid: txid,
      updatedHeight: block.height,
      updatedBlockHash: block.hash,
    };
    for (const u of spentUtxos) this.tokenUtxos.delete(outpointKey(u.txid, u.vout));
    for (const u of createdUtxos) this.tokenUtxos.set(outpointKey(u.txid, u.vout), u);
    this.backing.set(tokenIdHex, nextBacking);
    return {
      op: "REDEEM",
      valid: true,
      reason: null,
      tokenId: tokenIdHex,
      undo: { kind: "REDEEM", tokenId: tokenIdHex, spendingTxid: txid, priorBacking, spentUtxos, createdUtxos },
      curve: {
        amountAtoms: envelope.redeemAmount,
        grossSats,
        protocolFeeSats: feeSats,
        supplyAfterAtoms: nextState.issuedPublicSupplyAtoms,
        backingAfterSats: nextState.backingSats,
      },
    };
  }
}
