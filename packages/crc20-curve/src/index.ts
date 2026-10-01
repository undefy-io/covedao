const ATOMS_PER_TOKEN = 100_000_000n;
const LOT_TOKENS = 1_000n;
const STAGE_TOKENS = 100_000n;
const STAGE_COUNT = 210n;
const STAGE_BASE_LOT_SATS = 27n;
const CAP_TOKENS = STAGE_TOKENS * STAGE_COUNT;
const LOT_ATOMS = LOT_TOKENS * ATOMS_PER_TOKEN;
const CAP_ATOMS = CAP_TOKENS * ATOMS_PER_TOKEN;

function ceilBps(sats: bigint, bps: bigint): bigint {
  return (sats * bps + 9_999n) / 10_000n;
}

export function requiredBacking(supplyTokens: bigint): bigint {
  if (supplyTokens < 0n || supplyTokens > CAP_TOKENS || supplyTokens % LOT_TOKENS !== 0n) {
    fail("INVALID_SUPPLY", "Cove supply must be whole lots within the cap");
  }
  const fullStages = supplyTokens / STAGE_TOKENS;
  const partialLots = (supplyTokens % STAGE_TOKENS) / LOT_TOKENS;
  const fullCost = STAGE_BASE_LOT_SATS * (STAGE_TOKENS / LOT_TOKENS) *
    fullStages * (fullStages + 1n) / 2n;
  return fullCost + partialLots * STAGE_BASE_LOT_SATS * (fullStages + 1n);
}

export function isCoveCurveDeploy(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).sort().join(",") === "btc,leaf,lim,max,op,ordi,p,tick,type" &&
    payload.p === "crc-20" && payload.op === "deploy" &&
    typeof payload.tick === "string" && /^[A-Za-z0-9]{1,16}$/.test(payload.tick) &&
    payload.type === "bonding" && payload.max === CAP_ATOMS.toString() &&
    payload.lim === CAP_ATOMS.toString() && payload.leaf === "0" &&
    payload.ordi === "0" && payload.btc === "1";
}

export function coveCurveDeployPayload(ticker: string) {
  if (!/^[A-Za-z0-9]{1,16}$/.test(ticker)) throw new Error("invalid CRC ticker");
  return { p: "crc-20", op: "deploy", tick: ticker, type: "bonding",
    max: CAP_ATOMS.toString(), lim: CAP_ATOMS.toString(),
    leaf: "0", ordi: "0", btc: "1" } as const;
}

export type CurveState = Readonly<{
  version: "cove-curve-v3";
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
  if (state.version !== "cove-curve-v3") fail("UNKNOWN_CURVE", "unknown curve version");
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
      state.vaultAnchorSats + requiredBacking(state.circulatingAtoms / ATOMS_PER_TOKEN) ||
    !state.vaultOutpoint
  ) {
    fail("INVALID_STATE", "curve supply or backing invariant failed");
  }
}

export function createCurveState(vaultOutpoint: string, vaultAnchorSats: bigint): CurveState {
  const state: CurveState = {
    version: "cove-curve-v3",
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
  const circulatingTokens = state.circulatingAtoms / ATOMS_PER_TOKEN;
  const gross = requiredBacking(circulatingTokens + amountTokens) - requiredBacking(circulatingTokens);
  if (gross < 1n) fail("ECONOMIC_DUST", "buy must add at least one sat of backing");
  const protocolFee = 5_000n + 10n * (amountTokens / LOT_TOKENS) + ceilBps(gross, 750n);
  const creatorShare = ceilBps(gross, 5_000n);
  const creatorFee = creatorShare > 546n ? creatorShare : 546n;
  return {
    operation,
    amountAtoms,
    grossSats: gross,
    protocolFeeSats: protocolFee,
    creatorFeeSats: creatorFee,
    buyerTotalSats: gross + protocolFee + creatorFee,
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
  const circulatingTokens = state.circulatingAtoms / ATOMS_PER_TOKEN;
  const gross = requiredBacking(circulatingTokens) - requiredBacking(circulatingTokens - amountTokens);
  if (gross < 1n) fail("ECONOMIC_DUST", "sell must remove at least one sat of backing");
  const percentageFee = ceilBps(gross, 750n);
  const protocolFee = percentageFee > 1_000n ? percentageFee : 1_000n;
  const net = gross - protocolFee;
  const sellerPayoutSats = net > payoutDustSats ? net : payoutDustSats;
  const walletTopUpSats = sellerPayoutSats + protocolFee - gross;
  return {
    operation: "transfer",
    amountAtoms,
    grossSats: gross,
    protocolFeeSats: protocolFee,
    sellerPayoutSats,
    walletTopUpSats,
    sellerNetSats: net,
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
