import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ecc from "tiny-secp256k1";
import { TOKEN_CARRIER_SATS, RESERVE_ANCHOR_SATS } from "@crclaunch/cove-covenant";
import { MINT_CMR, REDEEM_CMR } from "@crclaunch/cove-simplicity";
import { CHAIN_BITCOIN_MAINNET, COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import { PUBLIC_SUPPLY_ATOMS, GRADUATION_RESERVE_ATOMS } from "@crclaunch/curve";
import { isKnownTestScript, isKnownTestXOnly } from "./test-keys.js";

/**
 * THE canonical Cove V3 mainnet profile (Phase 8.1 §2-§6). ONE schema, ONE
 * parser, ONE validator, ONE canonical hash. Every mainnet runtime component
 * (app, indexer, worker, market, Guardian service, readiness CLI, canary tool)
 * consumes this module — there is no ad-hoc flat schema anywhere.
 *
 * The JSON file contains ONLY PUBLIC values (no private keys, no RPC/DB
 * credentials). Frozen protocol fields (carrier/anchor/supply/reserve/CMRs/
 * policy version) are duplicated in the file as a verification surface ONLY;
 * the validator compares them to the code constants and rejects any drift
 * (PROFILE_PROTOCOL_MISMATCH). The code constants are the source of truth.
 */

export const MAINNET_PROFILE_DOMAIN = "Cove/MainnetProfile/v1";

export interface MainnetRecoveryProfile {
  /** 2 (with 3 keys) or 1 (with 1 key). */
  threshold: number;
  /** 3 x-only pubkeys (2-of-3) or 1 (1-of-1), 64-hex, canonical (lexicographic) order. */
  pubkeys: string[];
  /** Relative CSV delay (blocks), null until the operator commits it. */
  csvBlocks: number | null;
}

export interface MainnetCanary {
  /** Approved wallet scripts (hex) for every mutation during CANARY_ACTIVE. */
  allowedWalletScripts: string[];
  /** Approved token ids (64-hex) during CANARY_ACTIVE. */
  allowedTokenIds: string[];
  maxBackingSats: bigint | null;
  maxSingleBuySats: bigint | null;
  maxSingleRedeemPayoutSats: bigint | null;
  maxP2pSettlementSats: bigint | null;
  /**
   * Largest single mint, in atoms. The Guardian enforces this inside the
   * signer, where a compromised API cannot route around it. Development is
   * deliberately permissive (the regtest harnesses mint the whole curve in one
   * step); mainnet has to state a real number, and the operator has to choose
   * it rather than inherit it.
   */
  maxMintAtoms: bigint | null;
  /**
   * Smallest mint, in satoshis of curve price. A mint below the protocol fee's
   * dust threshold cannot produce a standard fee output, so this is the floor
   * that keeps the Guardian from being asked to sign one.
   */
  minMintGrossSats: bigint | null;
}

export interface MainnetProfile {
  profileVersion: 1;
  chainIdentity: "bitcoin-mainnet";
  /** Absolute activation block height; null until the operator commits it. */
  activationHeight: bigint | null;
  policyVersion: 3;
  vaultProfileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1";
  /** Guardian custody x-only pubkey (64-hex); null until ceremony. */
  guardianXOnly: string | null;
  recovery: MainnetRecoveryProfile;
  /** Protocol fee destination script (hex); null until ceremony. */
  feeScript: string | null;
  buyFeeBps: number | null;
  redeemFeeBps: number | null;
  p2pFeeBps: number | null;
  // Frozen protocol verification surface (must equal code constants):
  carrierSats: bigint;
  anchorSats: bigint;
  maxProtocolSupplyAtoms: bigint;
  reserveAllocationAtoms: bigint;
  mintCmr: string;
  redeemCmr: string;
  canary: MainnetCanary;
}

export interface MainnetProfileValidationResult {
  ok: boolean;
  errors: string[];
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * An x-only key must be 32 hex-encoded bytes AND a point on secp256k1. A hex
 * string that is well-formed but off-curve produces a tapleaf no signature can
 * ever satisfy — and because the keys derive the vault address, the defect is
 * undetectable after funding. Curve-check here, at profile validation, so an
 * unspendable vault can never be committed (§C8).
 */
function isXOnlyKey(hex: string): boolean {
  if (!HEX64.test(hex)) return false;
  return ecc.isXOnlyPoint(Buffer.from(hex, "hex"));
}

/** x-only pubkeys must be 32 bytes; canonical order is lexicographic (raw hex). */
function normalizePubkeys(pubkeys: string[]): string[] {
  return [...pubkeys].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

/** A standard Bitcoin output script for the protocol fee destination. */
export function isStandardMainnetScript(hex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length === 0) return false;
  const s = Buffer.from(hex, "hex");
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return true; // P2WPKH
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return true; // P2TR
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return true; // P2WSH
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return true; // P2PKH
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return true; // P2SH
  return false;
}

function bpsValid(bps: number | null): boolean {
  return bps === null || (Number.isInteger(bps) && bps >= 0 && bps <= 10_000);
}

function csvValid(csv: number | null): boolean {
  // BIP68/BIP112 block-relative locktime: 1..65535 (16-bit, type bit 22 = 0).
  return csv !== null && Number.isInteger(csv) && csv >= 1 && csv <= 65_535;
}

export interface ValidateMainnetProfileOptions {
  /**
   * TESTS ONLY: accept keys and scripts controlled by the repo's known test
   * private keys (test/fixtures/mainnet-profile.json uses them). Production
   * code never sets this; a mainnet profile holding a public key is refused.
   */
  allowTestKeys?: boolean;
}

/**
 * Validate a parsed profile against the frozen protocol constants + the
 * operator-decision completeness rules. Returns every failure (not just the
 * first) so the readiness CLI can report each missing owner decision.
 */
export function validateMainnetProfile(p: MainnetProfile, opts: ValidateMainnetProfileOptions = {}): MainnetProfileValidationResult {
  const errors: string[] = [];
  const fail = (e: string) => errors.push(e);

  if (p.profileVersion !== 1) fail(`PROFILE_VERSION_UNKNOWN: ${p.profileVersion}`);
  if (p.chainIdentity !== CHAIN_BITCOIN_MAINNET) fail(`CHAIN_IDENTITY_MISMATCH: ${p.chainIdentity} != ${CHAIN_BITCOIN_MAINNET}`);
  if (p.policyVersion !== COVE_POLICY_V3) fail(`POLICY_VERSION_MISMATCH: ${p.policyVersion} != ${COVE_POLICY_V3}`);
  if (p.vaultProfileVersion !== "COVE_V3_VAULT_PROFILE_MAINNET1") fail(`VAULT_PROFILE_MISMATCH: ${p.vaultProfileVersion}`);

  // Frozen protocol verification surface.
  if (p.carrierSats !== TOKEN_CARRIER_SATS) fail(`PROFILE_PROTOCOL_MISMATCH: carrierSats ${p.carrierSats} != ${TOKEN_CARRIER_SATS}`);
  if (p.anchorSats !== RESERVE_ANCHOR_SATS) fail(`PROFILE_PROTOCOL_MISMATCH: anchorSats ${p.anchorSats} != ${RESERVE_ANCHOR_SATS}`);
  if (p.maxProtocolSupplyAtoms !== PUBLIC_SUPPLY_ATOMS) fail(`PROFILE_PROTOCOL_MISMATCH: maxProtocolSupplyAtoms ${p.maxProtocolSupplyAtoms} != ${PUBLIC_SUPPLY_ATOMS}`);
  if (p.reserveAllocationAtoms !== GRADUATION_RESERVE_ATOMS) fail(`PROFILE_PROTOCOL_MISMATCH: reserveAllocationAtoms ${p.reserveAllocationAtoms} != ${GRADUATION_RESERVE_ATOMS}`);
  if (p.mintCmr.toLowerCase() !== MINT_CMR.toLowerCase()) fail(`PROFILE_PROTOCOL_MISMATCH: mintCmr`);
  if (p.redeemCmr.toLowerCase() !== REDEEM_CMR.toLowerCase()) fail(`PROFILE_PROTOCOL_MISMATCH: redeemCmr`);

  // Activation height.
  if (p.activationHeight === null) fail("OWNER_DECISION_REQUIRED: activationHeight");
  else if (p.activationHeight <= 0n) fail(`INVALID_ACTIVATION_HEIGHT: ${p.activationHeight}`);

  // Guardian public key.
  if (p.guardianXOnly === null) fail("OWNER_DECISION_REQUIRED: guardianXOnly");
  else if (!isXOnlyKey(p.guardianXOnly)) fail("INVALID_GUARDIAN_KEY");

  // Recovery: 2-of-3, or 1-of-1 (one offline key; simpler, but that one key
  // alone can sweep every vault after the CSV delay).
  const RECOVERY_KEYS_FOR: Record<number, number> = { 2: 3, 1: 1 };
  const wantKeys = RECOVERY_KEYS_FOR[p.recovery.threshold];
  if (wantKeys === undefined) fail(`INVALID_RECOVERY_THRESHOLD: ${p.recovery.threshold} (allowed: 2-of-3 or 1-of-1)`);
  if (p.recovery.pubkeys.length === 0) fail("OWNER_DECISION_REQUIRED: recovery.pubkeys");
  else if (wantKeys !== undefined && p.recovery.pubkeys.length !== wantKeys) {
    fail(`INVALID_RECOVERY_KEYS: threshold ${p.recovery.threshold} needs ${wantKeys} key(s), got ${p.recovery.pubkeys.length}`);
  }
  for (const k of p.recovery.pubkeys) if (!isXOnlyKey(k)) fail(`INVALID_RECOVERY_KEY: ${k.slice(0, 12)}…`);
  if (p.guardianXOnly !== null && p.recovery.pubkeys.some((k) => k.toLowerCase() === p.guardianXOnly!.toLowerCase())) {
    fail("GUARDIAN_KEY_IN_RECOVERY_SET");
  }
  if (new Set(p.recovery.pubkeys.map((k) => k.toLowerCase())).size !== p.recovery.pubkeys.length) fail("DUPLICATE_RECOVERY_KEYS");
  if (!csvValid(p.recovery.csvBlocks)) fail(p.recovery.csvBlocks === null ? "OWNER_DECISION_REQUIRED: recovery.csvBlocks" : `INVALID_RECOVERY_CSV: ${p.recovery.csvBlocks}`);

  // Fee destination + schedule.
  if (p.feeScript === null) fail("OWNER_DECISION_REQUIRED: feeScript");
  else if (!isStandardMainnetScript(p.feeScript)) fail("INVALID_FEE_SCRIPT");
  if (p.buyFeeBps === null) fail("OWNER_DECISION_REQUIRED: buyFeeBps");
  else if (!bpsValid(p.buyFeeBps)) fail(`INVALID_BUY_FEE_BPS: ${p.buyFeeBps}`);
  if (p.redeemFeeBps === null) fail("OWNER_DECISION_REQUIRED: redeemFeeBps");
  else if (!bpsValid(p.redeemFeeBps)) fail(`INVALID_REDEEM_FEE_BPS: ${p.redeemFeeBps}`);
  if (p.p2pFeeBps === null) fail("OWNER_DECISION_REQUIRED: p2pFeeBps");
  else if (!bpsValid(p.p2pFeeBps)) fail(`INVALID_P2P_FEE_BPS: ${p.p2pFeeBps}`);

  // Canary controls.
  for (const s of p.canary.allowedWalletScripts) if (!/^[0-9a-f]+$/i.test(s) || s.length === 0) fail(`INVALID_CANARY_WALLET_SCRIPT: ${s.slice(0, 12)}…`);
  for (const t of p.canary.allowedTokenIds) if (!HEX64.test(t)) fail(`INVALID_CANARY_TOKEN_ID: ${t.slice(0, 12)}…`);
  if (p.canary.allowedWalletScripts.length === 0) fail("OWNER_DECISION_REQUIRED: canary.allowedWalletScripts");
  if (p.canary.allowedTokenIds.length === 0) fail("OWNER_DECISION_REQUIRED: canary.allowedTokenIds");
  for (const [name, cap] of [
    ["maxBackingSats", p.canary.maxBackingSats],
    ["maxSingleBuySats", p.canary.maxSingleBuySats],
    ["maxSingleRedeemPayoutSats", p.canary.maxSingleRedeemPayoutSats],
    ["maxP2pSettlementSats", p.canary.maxP2pSettlementSats],
    ["maxMintAtoms", p.canary.maxMintAtoms],
    ["minMintGrossSats", p.canary.minMintGrossSats],
  ] as const) {
    if (cap === null) fail(`OWNER_DECISION_REQUIRED: canary.${name}`);
    else if (cap <= 0n) fail(`INVALID_CANARY_CAP: ${name} ${cap}`);
  }
  // Keys and scripts the repo's public test keys control (§8). Their private
  // keys are in this repository, so a profile using them is spendable by anyone.
  if (!opts.allowTestKeys) {
    if (p.guardianXOnly !== null && isKnownTestXOnly(p.guardianXOnly)) fail("TEST_KEY_IN_PROFILE: guardianXOnly");
    for (const k of p.recovery.pubkeys) if (isKnownTestXOnly(k)) fail(`TEST_KEY_IN_PROFILE: recovery key ${k.slice(0, 12)}…`);
    if (p.feeScript !== null && isKnownTestScript(p.feeScript)) fail("TEST_KEY_IN_PROFILE: feeScript");
    for (const w of p.canary.allowedWalletScripts) if (isKnownTestScript(w)) fail(`TEST_KEY_IN_PROFILE: canary wallet ${w.slice(0, 12)}…`);
  }

  // A per-mint cap above the whole protocol supply is not a cap.
  if (p.canary.maxMintAtoms !== null && p.canary.maxMintAtoms > p.maxProtocolSupplyAtoms) {
    fail(`INVALID_CANARY_CAP: maxMintAtoms ${p.canary.maxMintAtoms} exceeds the protocol supply`);
  }

  return { ok: errors.length === 0, errors };
}

// ── deterministic endian-frozen canonical serialization ─────────────────────

function u8(n: number): Buffer { const b = Buffer.alloc(1); b.writeUInt8(n, 0); return b; }
function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }
function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64BE(n, 0); return b; }
function str(s: string): Buffer { const b = Buffer.from(s, "utf8"); return Buffer.concat([u16(b.length), b]); }
function h32(hex: string): Buffer { return Buffer.from(hex.replace(/^0x/, ""), "hex"); }
function optU64(v: bigint | null): Buffer { return v === null ? u8(0) : Buffer.concat([u8(1), u64(v)]); }
function optU16(v: number | null): Buffer { return v === null ? u8(0) : Buffer.concat([u8(1), u16(v)]); }
function optStr(v: string | null): Buffer { return v === null ? u8(0) : Buffer.concat([u8(1), str(v)]); }
function optBytes(v: Buffer | null): Buffer { return v === null ? u8(0) : Buffer.concat([u8(1), u16(v.length), v]); }

/** Canonical, endian-frozen bytes for the profile (never JS property order). */
export function canonicalMainnetProfileBytes(p: MainnetProfile): Buffer {
  const parts: Buffer[] = [
    u32(p.profileVersion),
    str(p.chainIdentity),
    optU64(p.activationHeight),
    u32(p.policyVersion),
    str(p.vaultProfileVersion),
    optStr(p.guardianXOnly ? p.guardianXOnly.toLowerCase() : null),
    // recovery (canonical lexicographic key order)
    u8(p.recovery.threshold),
    p.recovery.csvBlocks === null ? u8(0) : Buffer.concat([u8(1), u32(p.recovery.csvBlocks)]),
    u8(p.recovery.pubkeys.length),
    ...normalizePubkeys(p.recovery.pubkeys).map((k) => h32(k)),
    // fee destination + schedule
    optBytes(p.feeScript === null ? null : Buffer.from(p.feeScript, "hex")),
    optU16(p.buyFeeBps),
    optU16(p.redeemFeeBps),
    optU16(p.p2pFeeBps),
    // frozen protocol surface
    u64(p.carrierSats),
    u64(p.anchorSats),
    u64(p.maxProtocolSupplyAtoms),
    u64(p.reserveAllocationAtoms),
    h32(p.mintCmr),
    h32(p.redeemCmr),
    // canary
    optU64(p.canary.maxBackingSats),
    optU64(p.canary.maxSingleBuySats),
    optU64(p.canary.maxSingleRedeemPayoutSats),
    optU64(p.canary.maxP2pSettlementSats),
    optU64(p.canary.maxMintAtoms),
    optU64(p.canary.minMintGrossSats),
    u16(p.canary.allowedWalletScripts.length),
    ...p.canary.allowedWalletScripts.map((s) => s.toLowerCase()).sort().map((s) => str(s)),
    u16(p.canary.allowedTokenIds.length),
    ...p.canary.allowedTokenIds.map((t) => t.toLowerCase()).sort().map((t) => h32(t)),
  ];
  return Buffer.concat(parts);
}

/** H("Cove/MainnetProfile/v1" || canonicalBytes). */
export function hashMainnetProfile(p: MainnetProfile): string {
  return createHash("sha256")
    .update(Buffer.from(MAINNET_PROFILE_DOMAIN, "utf8"))
    .update(canonicalMainnetProfileBytes(p))
    .digest("hex");
}

// ── JSON wire format (bigint fields are decimal STRINGS in JSON) ────────────

const PROFILE_KEYS = new Set([
  "profileVersion", "chainIdentity", "activationHeight", "policyVersion", "vaultProfileVersion",
  "guardianXOnly", "recovery", "feeScript", "buyFeeBps", "redeemFeeBps", "p2pFeeBps",
  "carrierSats", "anchorSats", "maxProtocolSupplyAtoms", "reserveAllocationAtoms",
  "mintCmr", "redeemCmr", "canary",
]);
const RECOVERY_KEYS = new Set(["threshold", "pubkeys", "csvBlocks"]);
const CANARY_KEYS = new Set([
  "allowedWalletScripts", "allowedTokenIds", "maxBackingSats",
  "maxSingleBuySats", "maxSingleRedeemPayoutSats", "maxP2pSettlementSats",
  "maxMintAtoms", "minMintGrossSats",
]);

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, scope: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`unknown ${scope} key: "${k}"`);
  }
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`profile field "${key}" must be a string`);
  return value;
}
function requiredInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`profile field "${key}" must be an integer`);
  return value;
}
function requiredBigint(value: unknown, key: string): bigint {
  if (typeof value === "string" && value !== "") return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "bigint") return value;
  throw new Error(`profile field "${key}" must be a bigint`);
}
function optBigint(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value !== "") return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "bigint") return value;
  throw new Error(`invalid bigint value: ${String(value)}`);
}
function optNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`invalid integer value: ${String(value)}`);
}
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

/** Parse the canonical JSON wire format into a typed MainnetProfile. */
export function parseMainnetProfile(raw: Record<string, unknown>): MainnetProfile {
  assertNoUnknownKeys(raw, PROFILE_KEYS, "profile");
  const r = (raw.recovery ?? {}) as Record<string, unknown>;
  const c = (raw.canary ?? {}) as Record<string, unknown>;
  assertNoUnknownKeys(r, RECOVERY_KEYS, "recovery");
  assertNoUnknownKeys(c, CANARY_KEYS, "canary");

  // Frozen identity/version fields are read from the file and MUST match the
  // committed protocol values — never hardcoded, never defaulted.
  const profileVersion = requiredInt(raw.profileVersion, "profileVersion");
  if (profileVersion !== 1) throw new Error(`profileVersion must be 1, got ${profileVersion}`);
  const chainIdentity = requiredString(raw.chainIdentity, "chainIdentity");
  if (chainIdentity !== "bitcoin-mainnet") throw new Error(`chainIdentity must be "bitcoin-mainnet", got "${chainIdentity}"`);
  const policyVersion = requiredInt(raw.policyVersion, "policyVersion");
  if (policyVersion !== 3) throw new Error(`policyVersion must be 3, got ${policyVersion}`);
  const vaultProfileVersion = requiredString(raw.vaultProfileVersion, "vaultProfileVersion");
  if (vaultProfileVersion !== "COVE_V3_VAULT_PROFILE_MAINNET1") throw new Error(`vaultProfileVersion must be "COVE_V3_VAULT_PROFILE_MAINNET1", got "${vaultProfileVersion}"`);

  const profile: MainnetProfile = {
    profileVersion: 1,
    chainIdentity: "bitcoin-mainnet",
    activationHeight: optBigint(raw.activationHeight),
    policyVersion: 3,
    vaultProfileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
    guardianXOnly: raw.guardianXOnly == null ? null : String(raw.guardianXOnly),
    recovery: {
      threshold: requiredInt(r.threshold, "recovery.threshold"),
      pubkeys: normalizePubkeys(strArray(r.pubkeys)),
      csvBlocks: optNum(r.csvBlocks),
    },
    feeScript: raw.feeScript == null ? null : String(raw.feeScript),
    buyFeeBps: optNum(raw.buyFeeBps),
    redeemFeeBps: optNum(raw.redeemFeeBps),
    p2pFeeBps: optNum(raw.p2pFeeBps),
    // Frozen protocol verification surface: REQUIRED, never fall back to code
    // constants (a deleted field must change the hash, not silently re-derive).
    carrierSats: requiredBigint(raw.carrierSats, "carrierSats"),
    anchorSats: requiredBigint(raw.anchorSats, "anchorSats"),
    maxProtocolSupplyAtoms: requiredBigint(raw.maxProtocolSupplyAtoms, "maxProtocolSupplyAtoms"),
    reserveAllocationAtoms: requiredBigint(raw.reserveAllocationAtoms, "reserveAllocationAtoms"),
    mintCmr: requiredString(raw.mintCmr, "mintCmr"),
    redeemCmr: requiredString(raw.redeemCmr, "redeemCmr"),
    canary: {
      allowedWalletScripts: strArray(c.allowedWalletScripts),
      allowedTokenIds: strArray(c.allowedTokenIds),
      maxBackingSats: optBigint(c.maxBackingSats),
      maxSingleBuySats: optBigint(c.maxSingleBuySats),
      maxSingleRedeemPayoutSats: optBigint(c.maxSingleRedeemPayoutSats),
      maxP2pSettlementSats: optBigint(c.maxP2pSettlementSats),
      maxMintAtoms: optBigint(c.maxMintAtoms),
      minMintGrossSats: optBigint(c.minMintGrossSats),
    },
  };
  return profile;
}

/** Load + parse + validate a profile file. Throws on parse/validation failure. */
export function parseMainnetProfileJson(text: string): MainnetProfile {
  return parseMainnetProfile(JSON.parse(text) as Record<string, unknown>);
}

export function loadMainnetProfile(
  path: string,
  opts: ValidateMainnetProfileOptions = {},
): { profile: MainnetProfile; validation: MainnetProfileValidationResult } {
  const text = readFileSync(path, "utf8");
  const profile = parseMainnetProfileJson(text);
  const validation = validateMainnetProfile(profile, opts);
  return { profile, validation };
}
