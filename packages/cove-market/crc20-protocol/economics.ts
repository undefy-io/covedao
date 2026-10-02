import type { Asset } from "./types.js";
export const atomsPerToken = 100000000n;
export const lotAtoms = 1000n * atomsPerToken;
/** Execution quantum; 1,000 tokens remain the price and per-lot fee unit. */
export const curveStepAtoms = 100n * atomsPerToken;
export const capAtoms = 21000000n * atomsPerToken;
export const launchFeeSats = 7000n;
export const carrierSats = 1000n;
export const maxMinerFeeSats = 20000n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const maximum = (a: bigint, b: bigint) => (a > b ? a : b);
export function curveAmount(amount: bigint): void {
  if (typeof amount !== "bigint" || amount <= 0n || amount % curveStepAtoms)
    throw new Error("curve trades require positive 100-token increments");
}
export function backingSats(atoms: bigint): bigint {
  if (atoms < 0n || atoms > capAtoms || atoms % curveStepAtoms)
    throw new Error("invalid circulating supply");
  const stageAtoms = 100000n * atomsPerToken;
  const stages = atoms / stageAtoms,
    remainder = atoms % stageAtoms;
  return (2700n * stages * (stages + 1n)) / 2n + ceil(remainder * 27n * (stages + 1n), lotAtoms);
}
export function marketFee(price: bigint): bigint {
  if (price <= 0n) throw new Error("positive integer-sat price required");
  return maximum(ceil(price * 750n, 10000n), 1000n);
}
export function quoteBuy(state: Pick<Asset, "issuedAtoms" | "inventoryAtoms">, amount: bigint) {
  curveAmount(amount);
  if (state.inventoryAtoms < 0n || state.inventoryAtoms > state.issuedAtoms)
    throw new Error("invalid inventory");
  if (state.inventoryAtoms && amount > state.inventoryAtoms)
    throw new Error("split inventory buy from new issuance");
  const before = state.issuedAtoms - state.inventoryAtoms;
  const grossSats = backingSats(before + amount) - backingSats(before);
  if (grossSats <= 0n) throw new Error("economic dust");
  return {
    grossSats,
    protocolFeeSats: 5000n + ceil(10n * amount, lotAtoms) + ceil(grossSats * 750n, 10000n),
    creatorFeeSats: maximum(ceil(grossSats, 2n), 546n),
  };
}
export function quoteSell(state: Pick<Asset, "issuedAtoms" | "inventoryAtoms">, amount: bigint) {
  curveAmount(amount);
  const before = state.issuedAtoms - state.inventoryAtoms;
  if (amount > before) throw new Error("insufficient circulating supply");
  const grossSats = backingSats(before) - backingSats(before - amount);
  if (grossSats <= 0n) throw new Error("economic dust");
  const protocolFeeSats = maximum(ceil(grossSats * 750n, 10000n), 1000n);
  return {
    grossSats,
    protocolFeeSats,
    creatorFeeSats: 0n,
    economicSats: grossSats - protocolFeeSats,
  };
}
