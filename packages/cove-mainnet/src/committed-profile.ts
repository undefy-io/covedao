import { resolve as resolvePath } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import {
  loadMainnetProfile,
  parseMainnetProfileJson,
  validateMainnetProfile,
  hashMainnetProfile,
  type MainnetProfile,
  type MainnetProfileValidationResult,
} from "./profile.js";

/**
 * THE committed Cove V3 mainnet profile. Every mainnet service (web, worker,
 * Guardian) and the readiness CLI read this; there is no profile path in the
 * environment. Changing it changes the profile hash, which the app and the
 * Guardian compare, so both must be deployed from the same commit.
 *
 * Public values only — never a private key. The owner decisions below are
 * still null (placeholders), so validation FAILS and mainnet refuses to start
 * until they are filled in:
 *   activationHeight, guardianXOnly, recovery.pubkeys (+ threshold) and
 *   recovery.csvBlocks, buyFeeBps, redeemFeeBps, p2pFeeBps,
 *   canary.allowedWalletScripts, canary.allowedTokenIds and the canary caps.
 *
 * feeScript stays null here: every service fills it from COVE_FEE_ADDRESS
 * (see FEE_ADDRESS_ENV) before validating and hashing, so a service with a
 * different fee address has a different profile hash and is caught by the
 * app ↔ Guardian hash comparison.
 * Recovery is 2-of-3 (threshold 2, three keys) or 1-of-1 (threshold 1, one key).
 *
 * The frozen protocol fields at the bottom (carrier, anchor, supply, reserve,
 * CMRs) are a verification surface: validation compares them to the code
 * constants and rejects any drift. Do not edit them here.
 *
 * Written in the profile's JSON wire format (big numbers as decimal strings)
 * and parsed by the same parser as any profile file.
 */
export const COMMITTED_MAINNET_PROFILE_JSON = `{
  "profileVersion": 1,
  "chainIdentity": "bitcoin-mainnet",
  "activationHeight": null,
  "guardianXOnly": null,
  "recovery": {
    "threshold": 1,
    "csvBlocks": null,
    "pubkeys": []
  },
  "feeScript": null,
  "buyFeeBps": null,
  "redeemFeeBps": null,
  "p2pFeeBps": null,
  "canary": {
    "allowedWalletScripts": [],
    "allowedTokenIds": [],
    "maxBackingSats": null,
    "maxSingleBuySats": "200000",
    "maxSingleRedeemPayoutSats": null,
    "maxP2pSettlementSats": null,
    "maxMintAtoms": "2100000000000000",
    "minMintGrossSats": "5000"
  },
  "policyVersion": 3,
  "vaultProfileVersion": "COVE_V3_VAULT_PROFILE_MAINNET1",
  "carrierSats": "1000",
  "anchorSats": "10000",
  "maxProtocolSupplyAtoms": "2100000000000000",
  "reserveAllocationAtoms": "0",
  "mintCmr": "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
  "redeemCmr": "37e681b3e70a34acc3b38680c06fbe4f1b2799bede2607c6c9ed7fcac8c95d56"
}`;

export interface CommittedMainnetProfile {
  profile: MainnetProfile;
  validation: MainnetProfileValidationResult;
  profileHash: string;
}

/**
 * The env var holding the ONE address every protocol fee (mint, redeem,
 * marketplace) is paid to. Web, worker and Guardian must all be given the same
 * value; set it once, as a shared variable.
 */
export const FEE_ADDRESS_ENV = "COVE_FEE_ADDRESS";

/** A fee address as the hex scriptPubKey the profile stores. Throws on an address not valid for `network`. */
export function feeScriptFromAddress(address: string, network: bitcoin.networks.Network): string {
  try {
    return Buffer.from(bitcoin.address.toOutputScript(address.trim(), network)).toString("hex");
  } catch {
    throw new Error(`${FEE_ADDRESS_ENV} "${address}" is not a valid address for this network`);
  }
}

/**
 * Parse + validate + hash the committed profile, with feeScript taken from
 * `feeAddress` (COVE_FEE_ADDRESS). Never throws on an incomplete profile; check
 * `validation.ok`. Throws only on a fee address that is not a mainnet address.
 */
export function committedMainnetProfile(opts: { feeAddress?: string } = {}): CommittedMainnetProfile {
  const profile = parseMainnetProfileJson(COMMITTED_MAINNET_PROFILE_JSON);
  if (opts.feeAddress) profile.feeScript = feeScriptFromAddress(opts.feeAddress, bitcoin.networks.bitcoin);
  return { profile, validation: validateMainnetProfile(profile), profileHash: hashMainnetProfile(profile) };
}

/** The env var naming a TEST-ONLY profile file. Refused on mainnet. */
export const TEST_ONLY_PROFILE_ENV = "COVE_TEST_ONLY_PROFILE_PATH";

export interface ResolvedMainnetProfile extends CommittedMainnetProfile {
  /** "committed" in production; "test-only" when a test profile file was named. */
  source: "committed" | "test-only";
}

/**
 * The profile a service or tool should use: the committed one, or — for
 * regtest harnesses and CI only — a test profile file named by
 * COVE_TEST_ONLY_PROFILE_PATH, validated with the test-key bypass. Naming a
 * test profile while COVE_NETWORK=mainnet is refused, so a mainnet service can
 * only ever run the committed profile.
 */
export function resolveMainnetProfile(params: {
  network: string;
  testOnlyPath?: string;
  /** Directory a relative testOnlyPath resolves against. */
  baseDir?: string;
  /** COVE_FEE_ADDRESS; fills the committed profile's feeScript. A test profile keeps its own. */
  feeAddress?: string;
}): ResolvedMainnetProfile {
  if (!params.testOnlyPath) {
    return { ...committedMainnetProfile({ feeAddress: params.feeAddress }), source: "committed" };
  }
  if (params.network === "mainnet") {
    throw new Error(`${TEST_ONLY_PROFILE_ENV} is refused on mainnet: mainnet runs only the committed profile`);
  }
  const path = params.baseDir ? resolvePath(params.baseDir, params.testOnlyPath) : params.testOnlyPath;
  const { profile, validation } = loadMainnetProfile(path, { allowTestKeys: true });
  return { profile, validation, profileHash: hashMainnetProfile(profile), source: "test-only" };
}
