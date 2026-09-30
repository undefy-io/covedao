import { ATOMS_PER_TOKEN, LOT_TOKENS } from "@crclaunch/curve";
import {
  PUBLIC_SUPPLY,
  creatorFeeSats,
  quoteBuy as baseQuoteBuy,
  quoteRedeem,
  requiredBackingSats,
} from "@crclaunch/cove-economics";

const LOT_ATOMS = LOT_TOKENS * ATOMS_PER_TOKEN;
const CAP_ATOMS = PUBLIC_SUPPLY * ATOMS_PER_TOKEN;

export function isCoveCurveDeploy(payload: Record<string, unknown>): boolean {
  return payload.p === "crc-20" && payload.op === "deploy" && payload.cv === "cove-curve-v1";
}

export type CurveState = Readonly<{
  version: "cove-curve-v1";
  mintedAtoms: bigint;
  vaultAtoms: bigint;
  circulatingAtoms: bigint;
  vaultAnchorSats: bigint;
  vaultSats: bigint;
  vaultOutpoint: string;
}>;

export type BuyQuote = Readonly<{
  operation: "mint" | "transfer";
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  creatorFeeSats: bigint;
  buyerTotalSats: bigint;
}>;

export type SellQuote = Readonly<{
  operation: "transfer";
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  sellerPayoutSats: bigint;
  walletTopUpSats: bigint;
  sellerNetSats: bigint;
}>;

export type BuyTransition = Readonly<{
  amountAtoms: bigint;
  previousVaultOutpoint: string;
  nextVaultOutpoint: string;
  nextVaultSats: bigint;
  protocolFeeSats: bigint;
  creatorFeeSats: bigint;
}>;

export type SellTransition = Readonly<{
  amountAtoms: bigint;
  previousVaultOutpoint: string;
  nextVaultOutpoint: string;
  nextVaultSats: bigint;
  protocolFeeSats: bigint;
  sellerPayoutSats: bigint;
  walletTopUpSats: bigint;
  payoutDustSats: bigint;
}>;

export class CurveTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CurveTransitionError";
  }
}

function fail(code: string, message: string): never {
  throw new CurveTransitionError(code, message);
}

function assertWholeLots(amountAtoms: bigint): bigint {
  if (amountAtoms <= 0n || amountAtoms % LOT_ATOMS !== 0n) {
    fail("INVALID_LOT", "amount must be a positive whole 1000-token lot");
  }
  return amountAtoms / ATOMS_PER_TOKEN;
}

function assertState(state: CurveState): void {
  if (state.version !== "cove-curve-v1") fail("UNKNOWN_CURVE", "unknown curve version");
  if (
    state.mintedAtoms < 0n ||
    state.mintedAtoms > CAP_ATOMS ||
    state.vaultAtoms < 0n ||
    state.circulatingAtoms < 0n ||
    state.mintedAtoms !== state.vaultAtoms + state.circulatingAtoms ||
    state.circulatingAtoms % LOT_ATOMS !== 0n ||
    state.vaultAtoms % LOT_ATOMS !== 0n ||
    state.vaultAnchorSats < 0n ||
    state.vaultSats !==
      state.vaultAnchorSats + requiredBackingSats(state.circulatingAtoms / ATOMS_PER_TOKEN) ||
    !state.vaultOutpoint
  ) {
    fail("INVALID_STATE", "curve supply or backing invariant failed");
  }
}

export function createCurveState(vaultOutpoint: string, vaultAnchorSats: bigint): CurveState {
  const state: CurveState = {
    version: "cove-curve-v1",
    mintedAtoms: 0n,
    vaultAtoms: 0n,
    circulatingAtoms: 0n,
    vaultAnchorSats,
    vaultSats: vaultAnchorSats,
    vaultOutpoint,
  };
  assertState(state);
  return state;
}

export function quoteBuy(state: CurveState, amountTokens: bigint): BuyQuote {
  assertState(state);
  const amountAtoms = amountTokens * ATOMS_PER_TOKEN;
  assertWholeLots(amountAtoms);
  let operation: BuyQuote["operation"];
  if (state.vaultAtoms > 0n) {
    if (amountAtoms > state.vaultAtoms) {
      fail("SPLIT_REQUIRED", "buy crosses vault inventory boundary; split into two transactions");
    }
    operation = "transfer";
  } else {
    if (state.mintedAtoms + amountAtoms > CAP_ATOMS) fail("CAP_EXCEEDED", "mint exceeds cap");
    operation = "mint";
  }
  const quote = baseQuoteBuy(state.circulatingAtoms / ATOMS_PER_TOKEN, amountTokens);
  const creatorFee = creatorFeeSats(quote.gross);
  return {
    operation,
    amountAtoms,
    grossSats: quote.gross,
    protocolFeeSats: quote.fee,
    creatorFeeSats: creatorFee,
    buyerTotalSats: quote.net + creatorFee,
  };
}

export function quoteSell(
  state: CurveState,
  amountTokens: bigint,
  payoutDustSats = 330n,
): SellQuote {
  assertState(state);
  const amountAtoms = amountTokens * ATOMS_PER_TOKEN;
  assertWholeLots(amountAtoms);
  if (amountAtoms > state.circulatingAtoms) {
    fail(
      "INSUFFICIENT_BALANCE",
      "sell exceeds circulating supply; sender balance must also be verified",
    );
  }
  if (payoutDustSats < 0n) fail("INVALID_DUST", "payout dust must be non-negative");
  const quote = quoteRedeem(state.circulatingAtoms / ATOMS_PER_TOKEN, amountTokens);
  const sellerPayoutSats = quote.net > payoutDustSats ? quote.net : payoutDustSats;
  const walletTopUpSats = sellerPayoutSats + quote.fee - quote.gross;
  return {
    operation: "transfer",
    amountAtoms,
    grossSats: quote.gross,
    protocolFeeSats: quote.fee,
    sellerPayoutSats,
    walletTopUpSats,
    sellerNetSats: quote.net,
  };
}

function assertVaultSpend(
  state: CurveState,
  transition: { previousVaultOutpoint: string; nextVaultOutpoint: string },
): void {
  if (transition.previousVaultOutpoint !== state.vaultOutpoint) {
    fail("STALE_VAULT", "stale curve state: vault outpoint has already changed");
  }
  if (!transition.nextVaultOutpoint || transition.nextVaultOutpoint === state.vaultOutpoint) {
    fail("INVALID_VAULT", "next vault outpoint must be new");
  }
}

export function applyBuy(state: CurveState, transition: BuyTransition): CurveState {
  assertState(state);
  assertVaultSpend(state, transition);
  const amountTokens = assertWholeLots(transition.amountAtoms);
  const quote = quoteBuy(state, amountTokens);
  if (transition.nextVaultSats !== state.vaultSats + quote.grossSats) {
    fail("BACKING_MISMATCH", "backing output must increase by exact curve gross");
  }
  if (transition.protocolFeeSats !== quote.protocolFeeSats) {
    fail("PROTOCOL_FEE_MISMATCH", "protocol fee output does not match curve policy");
  }
  if (transition.creatorFeeSats !== quote.creatorFeeSats) {
    fail("CREATOR_FEE_MISMATCH", "creator fee output does not match curve policy");
  }
  const next: CurveState = {
    ...state,
    mintedAtoms: state.mintedAtoms + (quote.operation === "mint" ? transition.amountAtoms : 0n),
    vaultAtoms: state.vaultAtoms - (quote.operation === "transfer" ? transition.amountAtoms : 0n),
    circulatingAtoms: state.circulatingAtoms + transition.amountAtoms,
    vaultSats: transition.nextVaultSats,
    vaultOutpoint: transition.nextVaultOutpoint,
  };
  assertState(next);
  return next;
}

export function applySell(state: CurveState, transition: SellTransition): CurveState {
  assertState(state);
  assertVaultSpend(state, transition);
  const amountTokens = assertWholeLots(transition.amountAtoms);
  const quote = quoteSell(state, amountTokens, transition.payoutDustSats);
  if (transition.nextVaultSats !== state.vaultSats - quote.grossSats) {
    fail("BACKING_MISMATCH", "backing output must decrease by exact curve gross");
  }
  if (transition.protocolFeeSats !== quote.protocolFeeSats) {
    fail("PROTOCOL_FEE_MISMATCH", "protocol fee output does not match curve policy");
  }
  if (transition.sellerPayoutSats !== quote.sellerPayoutSats) {
    fail("PAYOUT_MISMATCH", "seller payout output does not match curve policy");
  }
  if (transition.walletTopUpSats !== quote.walletTopUpSats) {
    fail("FUNDING_MISMATCH", "seller wallet must fund dust and fee shortfall");
  }
  const next: CurveState = {
    ...state,
    vaultAtoms: state.vaultAtoms + transition.amountAtoms,
    circulatingAtoms: state.circulatingAtoms - transition.amountAtoms,
    vaultSats: transition.nextVaultSats,
    vaultOutpoint: transition.nextVaultOutpoint,
  };
  assertState(next);
  return next;
}
