import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import * as bitcoin from "bitcoinjs-lib";
import {
  parseMainnetProfile,
  validateMainnetProfile,
  hashMainnetProfile,
  type MainnetProfile,
  type MainnetProfileValidationResult,
} from "./profile.js";

/** Public protocol and per-network profile values shared by the app and Guardian. */
function bundledProfilesPath(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const path = resolvePath(directory, "packages/cove-mainnet/profiles.toml");
    if (existsSync(path)) return path;
    directory = dirname(directory);
  }
  throw new Error("packages/cove-mainnet/profiles.toml is missing");
}

export const MAINNET_PROFILES_PATH = bundledProfilesPath();

function profileFromToml(text: string, network: string): MainnetProfile {
  const document = parseToml(text) as Record<string, unknown>;
  const protocol = document.protocol as Record<string, unknown> | undefined;
  const networks = document.networks as Record<string, unknown> | undefined;
  const selected = networks?.[network] as Record<string, unknown> | undefined;
  if (!protocol || !selected) {
    throw new Error(`profiles.toml has no ${network} profile`);
  }
  return parseMainnetProfile({ ...protocol, ...selected });
}

function bundledProfile(network: string): MainnetProfile {
  return profileFromToml(readFileSync(MAINNET_PROFILES_PATH, "utf8"), network);
}

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
  const profile = bundledProfile("mainnet");
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
  if (params.testOnlyPath && params.network === "mainnet") {
    throw new Error(`${TEST_ONLY_PROFILE_ENV} is refused on mainnet: mainnet runs only the committed profile`);
  }
  const selectedNetwork = params.network === "tooling"
    ? params.testOnlyPath ? "regtest" : "mainnet"
    : params.network;
  const profile = params.testOnlyPath
    ? profileFromToml(
        readFileSync(
          params.baseDir
            ? resolvePath(params.baseDir, params.testOnlyPath)
            : params.testOnlyPath,
          "utf8",
        ),
        selectedNetwork,
      )
    : bundledProfile(selectedNetwork);
  if (selectedNetwork === "mainnet" && params.feeAddress) {
    profile.feeScript = feeScriptFromAddress(params.feeAddress, bitcoin.networks.bitcoin);
  }
  const testOnly = selectedNetwork !== "mainnet";
  return {
    profile,
    validation: validateMainnetProfile(profile, { allowTestKeys: testOnly }),
    profileHash: hashMainnetProfile(profile),
    source: testOnly ? "test-only" : "committed",
  };
}
