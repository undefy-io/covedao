import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { TOKEN_CARRIER_SATS, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import {
  validateFinalizedTransferTransaction,
  broadcastValidatedCoveTransaction,
  type ValidatedCoveTransaction,
  type ResolvedPrevout,
} from "@crclaunch/cove-guardian/v3";
import { parseCoveTx } from "@crclaunch/cove-indexer/v3";
import { OP_TRANSFER, decodeDiscovery } from "@crclaunch/cove-wire";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { dustThreshold } from "@crclaunch/cove-economics";
import { MarketError } from "./errors.js";
import { FILL_SELLER_INPUT, FILL_PAYOUT_VOUT, FILL_BUYER_CARRIER_VOUT, FILL_FEE_VOUT, FILL_BUYER_CHANGE_VOUT } from "./presign.js";

/**
 * Market final validation (§14): a P2P fill is a plain Cove TRANSFER plus the
 * market's own semantics (the presigned layout — seller carrier at input 1,
 * their payout at output 1 —, exact seller payout, exact p2p fee, exact miner
 * fee, the whole carrier to the buyer, no backing/Guardian involvement,
 * dust-safe payouts). On success it returns an opaque `ValidatedP2PFill` that ONLY this
 * module can construct; `broadcastValidatedP2PFill` accepts nothing else.
 */

const ValidatedP2PFillBrand: unique symbol = Symbol("ValidatedP2PFill");

export interface ValidatedP2PFill {
  readonly [ValidatedP2PFillBrand]: true;
  readonly validatedTransfer: ValidatedCoveTransaction;
  readonly txid: string;
  readonly listingId: string;
  readonly fillId: string;
  readonly tokenId: string;
  readonly validationDigest: string;
}

export interface P2PFillTerms {
  listingId: string;
  fillId: string;
  tokenId: string; // 64-hex
  sourceTxid: string;
  sourceVout: number;
  sourceAmountAtoms: bigint;
  sellerTokenScript: Buffer;
  sellerTokenChangeScript: Buffer;
  sellerPayoutScript: Buffer;
  amountAtoms: bigint;
  totalPriceSats: bigint;
  marketFeeSats: bigint;
  minerFeeSats: bigint;
  buyerTokenScript: Buffer;
  buyerChangeScript: Buffer;
  feeScript: Buffer;
  discoveryTicker?: string;
  buyerFundInputs: { txid: string; vout: number; script: Buffer; valueSats: bigint }[];
}

export interface P2PFillValidationParams {
  rawTxHex: string;
  terms: P2PFillTerms;
  view: CoveCanonicalView;
  network: "regtest" | "signet" | "testnet" | "mainnet";
}

/**
 * Re-check the canary P2P settlement cap against a concrete amount (§P0-6).
 * Enforced both when a listing is created AND again when the fill is finalized,
 * so a cap that changed (or a listing that slipped through) cannot settle for
 * more than the canary allows.
 */
export function assertSettlementCap(totalPriceSats: bigint, cap: bigint | null | undefined): void {
  if (cap != null && totalPriceSats > cap) {
    throw new MarketError("P2P_SETTLEMENT_CAP_EXCEEDED", `settlement ${totalPriceSats} > canary cap ${cap}`);
  }
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function inputTxid(ins: bitcoin.TxInput): string {
  return Buffer.from(ins.hash).reverse().toString("hex");
}

function reject(code: string, detail: string): never {
  throw new MarketError("MARKET_VALIDATION_FAILED", `${code}: ${detail}`);
}

/**
 * Pure market semantics on top of `validateFinalizedTransferTransaction`.
 * Throws a `MarketError` on any market-rule violation; returns the opaque
 * `ValidatedP2PFill` otherwise.
 */
export function validateFinalizedP2PFill(params: P2PFillValidationParams): ValidatedP2PFill {
  const { terms } = params;

  const tx = bitcoin.Transaction.fromHex(params.rawTxHex);

  // (a) input 1 is the listing's exact source outpoint: the seller's
  // SIGHASH_SINGLE pairs it with output 1, their payout.
  const sellerIn = tx.ins[FILL_SELLER_INPUT];
  if (!sellerIn || inputTxid(sellerIn) !== terms.sourceTxid || sellerIn.index !== terms.sourceVout) {
    reject("SOURCE_INPUT", `input ${FILL_SELLER_INPUT} is not the listing source outpoint`);
  }
  // Every other input is one of the buyer's reserved coins, and there are no others.
  if (tx.ins.length !== terms.buyerFundInputs.length + 1) {
    reject("INPUT_COUNT", `${tx.ins.length} inputs != 1 carrier + ${terms.buyerFundInputs.length} buyer coins`);
  }
  const reserved = new Set(terms.buyerFundInputs.map((f) => outpointKey(f.txid, f.vout)));
  tx.ins.forEach((ins, i) => {
    if (i !== FILL_SELLER_INPUT && !reserved.has(outpointKey(inputTxid(ins), ins.index))) {
      reject("BUYER_INPUT", `input ${i} is not one of the buyer's reserved coins`);
    }
  });
  // The carrier is sold whole: there is never token change in a presigned fill.
  if (terms.amountAtoms !== terms.sourceAmountAtoms) {
    reject("PARTIAL_CARRIER", "a presigned listing sells its whole carrier");
  }

  // Build resolved prevouts for every input so the transfer validator enforces
  // the exact miner fee (it skips that check when prevouts are absent).
  const prevouts = new Map<string, ResolvedPrevout>();
  prevouts.set(outpointKey(terms.sourceTxid, terms.sourceVout), {
    script: terms.sellerTokenScript,
    valueSats: TOKEN_CARRIER_SATS,
  });
  for (const f of terms.buyerFundInputs) {
    prevouts.set(outpointKey(f.txid, f.vout), { script: f.script, valueSats: f.valueSats });
  }

  const base = validateFinalizedTransferTransaction({
    rawTxHex: params.rawTxHex,
    view: params.view,
    prevouts,
    maxMinerFeeSats: terms.minerFeeSats,
    discoveryTicker: terms.discoveryTicker,
  });
  if (!("rawTxHex" in base)) reject("TRANSFER_VALIDATION", base.reason);

  const wire = parseCoveTx(params.rawTxHex);
  if (wire.kind !== "TRANSFER") reject("NOT_TRANSFER", `kind=${wire.kind}`);
  const envelope = wire.envelope;
  if (envelope.op !== OP_TRANSFER) reject("NOT_TRANSFER", `op=${envelope.op}`);
  const allocations = envelope.allocations;

  // (b) NO backing/Guardian/supply involvement: no input may spend the backing.
  const tokenIdBuf = Buffer.from(terms.tokenId, "hex");
  const backingOutpoint = params.view.getBackingOutpoint(tokenIdBuf);
  for (const ins of tx.ins) {
    if (backingOutpoint && inputTxid(ins) === backingOutpoint.txid && ins.index === backingOutpoint.vout) {
      reject("BACKING_TOUCHED", "P2P fill must never spend the backing UTXO");
    }
  }

  // (c) token allocation: every token to the buyer's carrier at vout 2.
  if (allocations.length !== 1) reject("ALLOCATION_COUNT", `${allocations.length} != 1`);
  const buyerAlloc = allocations[0]!;
  if (buyerAlloc.vout !== FILL_BUYER_CARRIER_VOUT || buyerAlloc.amount !== terms.amountAtoms) {
    reject("BUYER_ALLOCATION", `vout=${buyerAlloc.vout} amount=${buyerAlloc.amount}`);
  }

  // (d) the buyer's token carrier.
  const buyerCarrier = tx.outs[FILL_BUYER_CARRIER_VOUT];
  if (!buyerCarrier || !buyerCarrier.script.equals(terms.buyerTokenScript)) {
    reject("BUYER_CARRIER_SCRIPT", `vout ${FILL_BUYER_CARRIER_VOUT} is not the buyer token carrier`);
  }

  // (e) BTC outputs: seller payout at vout 1 (paired with the seller's input),
  // the market fee at vout 3, then optional buyer change at vout 4.
  const payout = tx.outs[FILL_PAYOUT_VOUT];
  if (!payout || !payout.script.equals(terms.sellerPayoutScript) || BigInt(payout.value) !== terms.totalPriceSats) {
    reject("SELLER_PAYOUT", `vout ${FILL_PAYOUT_VOUT} is not the seller payout`);
  }
  const feeOut = tx.outs[FILL_FEE_VOUT];
  if (!feeOut || !feeOut.script.equals(terms.feeScript) || BigInt(feeOut.value) !== terms.marketFeeSats) {
    reject("P2P_FEE", "p2p fee output mismatch");
  }
  const last = tx.outs[tx.outs.length - 1];
  const hasDiscovery = !!last && last.script[0] === 0x6a &&
    decodeDiscovery(last.script.subarray(last.script[1] === 0x4c ? 3 : 2)) !== null;
  if (tx.outs.length > FILL_BUYER_CHANGE_VOUT && !(hasDiscovery && tx.outs.length === FILL_BUYER_CHANGE_VOUT + 1)) {
    const buyerChange = tx.outs[FILL_BUYER_CHANGE_VOUT];
    if (!buyerChange || !buyerChange.script.equals(terms.buyerChangeScript)) {
      reject("BUYER_CHANGE", "unexpected buyer change output");
    }
  }
  if (tx.outs.length > FILL_BUYER_CHANGE_VOUT + 1 + Number(hasDiscovery)) reject("UNEXPECTED_OUTPUT", "too many outputs");

  // (f) dust safety: seller payout and p2p fee must clear relay dust.
  if (terms.totalPriceSats < dustThreshold(terms.sellerPayoutScript)) {
    reject("SELLER_PAYOUT_DUST", `payout ${terms.totalPriceSats} < dust`);
  }
  if (terms.marketFeeSats < dustThreshold(terms.feeScript)) {
    reject("MARKET_FEE_DUST", `fee ${terms.marketFeeSats} < dust`);
  }

  // (g) exact miner fee.
  const totalIn = [...prevouts.values()].reduce((s, p) => s + p.valueSats, 0n);
  const totalOut = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n);
  const minerFee = totalIn - totalOut;
  if (minerFee !== terms.minerFeeSats) reject("MINER_FEE", `${minerFee} != ${terms.minerFeeSats}`);

  const digest = createHash("sha256").update(params.rawTxHex, "hex").digest("hex");
  return {
    [ValidatedP2PFillBrand]: true,
    validatedTransfer: base,
    txid: base.txid,
    listingId: terms.listingId,
    fillId: terms.fillId,
    tokenId: terms.tokenId,
    validationDigest: digest,
  };
}

/** Hardened broadcast boundary: accepts ONLY an opaque ValidatedP2PFill. */
export async function broadcastValidatedP2PFill(params: {
  validated: ValidatedP2PFill;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  provider: CoreRpcProvider;
}): Promise<{ txid: string }> {
  const res = await broadcastValidatedCoveTransaction({
    validated: params.validated.validatedTransfer,
    network: params.network,
    provider: params.provider,
  });
  return { txid: res.txid };
}

export function isP2PFillValidated(x: unknown): x is ValidatedP2PFill {
  return typeof x === "object" && x !== null && ValidatedP2PFillBrand in x;
}
