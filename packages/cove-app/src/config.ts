import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CHAIN_BITCOIN_REGTEST, CHAIN_BITCOIN_SIGNET, CHAIN_BITCOIN_TESTNET, CHAIN_BITCOIN_MAINNET } from "@crclaunch/cove-wire";
import {
  committedMainnetProfile,
  feeScriptFromAddress,
  hashMainnetProfile,
  validateMainnetProfile,
  FEE_ADDRESS_ENV,
  type MainnetProfile,
} from "@crclaunch/cove-mainnet";
import { COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import { PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";
import { AppError } from "./errors.js";
import { requireCoveNetwork, coveNetworkSettings, CoveNetworkError, type CoveNetworkSettings } from "@crclaunch/config";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

export type V3Network = "regtest" | "signet" | "testnet" | "mainnet";

export interface V3AppConfig {
  enabled: boolean;
  /** The committed per-network settings (explorer, esplora, ord, poll, …). */
  settings: CoveNetworkSettings;
  network: V3Network;
  chainIdentity: string;
  coreRpcUrl: string;
  /** Optional: hosted providers put the API key in the URL. */
  coreRpcUser?: string;
  coreRpcPassword?: string;
  /** Optional secondary Core URL for the two-node quorum (§29/§P1-2). */
  coreRpcUrlSecondary?: string;
  feeScript: Buffer;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  /** Optional versioned recovery profile (MAINNET1); defaults to DEV1 single-key. */
  recoveryProfile?: VaultRecoveryProfile;
  /** Guardian private key (server-side secret, regtest/staging ONLY). */
  guardianPrivateKey: Buffer | null;
  /** Absolute activation height (0 = genesis); Cove ops below this are ignored. */
  activationHeight: bigint;
  /** Canary token allowlist (hex); enforced at the app/signer during canary. */
  canaryAllowedTokenIds?: string[];
  /** Canary wallet-script allowlist (hex); enforced at the app during canary. */
  canaryAllowedWalletScripts?: string[];
  /** P2P fee bps (mainnet: from the profile). */
  p2pFeeBps?: number;
  /** Protocol backing-buy fee, basis points (§P1-4; mainnet: from the profile). */
  buyFeeBps: bigint;
  /** Flat buy-fee component at the TOP stage; scaled down for earlier stages. */
  buyFeeFlatSats: bigint;
  /**
   * Emit the advisory crc-20 discovery envelope (§D1). OFF by default: it needs
   * two OP_RETURNs per transaction, which Bitcoin Core rejects as
   * `multi-op-return` before v30 relaxed the datacarrier policy.
   */
  discoveryEnvelope: boolean;
  /** Protocol backing-redeem fee, basis points (§P1-4; mainnet: from the profile). */
  redeemFeeBps: bigint;
  /** Flat redemption fee, not stage-scaled — the exit price should be predictable. */
  redeemFeeFlatSats: bigint;
  /** Canary P2P settlement cap (mainnet: from the profile). */
  maxP2pSettlementSats?: bigint;
  /**
   * Per-mint limits the Guardian enforces, so the app can quote within them
   * instead of building a mint the Guardian will refuse. Mainnet: from the
   * profile. Absent: the development risk policy.
   */
  mintLimits?: { maxMintAtoms: bigint; maxGrossSats: bigint | null; minGrossSats: bigint };
  maxMinerFeeSats: bigint;
  maxListingBlocks: bigint;
  reservationTtlSeconds: number;
  /**
   * Mainnet only: the committed profile passed validateMainnetProfile at boot.
   * The mutation gate requires it, so mainnet never runs on a partial profile.
   */
  mainnetProfileValid?: boolean;
  /** Operator-controlled mainnet mutation switch; OFF unless explicitly armed. */
  mainnetMutationsArmed?: boolean;
  /** Committed profile hash (mainnet) — used to verify the remote Guardian (§P1-2/C4). */
  mainnetProfileHash?: string;
  /** Remote Guardian service endpoint (mainnet). */
  guardianEndpoint?: string;
  /** Remote Guardian service bearer token (mainnet). */
  guardianAuthToken?: string;
  /**
   * An ord server (with --index-runes) used to refuse funding inputs that hold
   * inscriptions or runes. Required on mainnet.
   */
  ordUrl?: string;
}

const PUBLIC_SUPPLY_ATOMS_CAP = PUBLIC_SUPPLY_ATOMS;
const REGTEST_GUARDIAN_PRIV = Buffer.alloc(32, 0x42);
const REGTEST_RECOVERY_PRIV = Buffer.alloc(32, 0x43);
const REGTEST_FEE_PRIV = Buffer.alloc(32, 0x44);

function xonly(priv: Buffer): Buffer {
  const key = ECPair.fromPrivateKey(priv, { network: bitcoin.networks.regtest });
  return Buffer.from(key.publicKey.subarray(1));
}

function p2wpkh(priv: Buffer): Buffer {
  const key = ECPair.fromPrivateKey(priv, { network: bitcoin.networks.regtest });
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!;
}

function chainIdentityFor(network: V3Network): string {
  switch (network) {
    case "regtest":
      return CHAIN_BITCOIN_REGTEST;
    case "signet":
      return CHAIN_BITCOIN_SIGNET;
    case "testnet":
      return CHAIN_BITCOIN_TESTNET;
    case "mainnet":
      return CHAIN_BITCOIN_MAINNET;
  }
}

function hexOrNull(v: string | undefined): Buffer | null {
  if (!v) return null;
  const b = Buffer.from(v, "hex");
  if (b.length !== 32) throw new AppError("GUARDIAN_UNAVAILABLE", "private key hex must be 32 bytes");
  return b;
}

type Env = Record<string, string | undefined>;

/** Map the canonical mainnet profile's recovery (2-of-3 or 1-of-1) to a VaultRecoveryProfile. */
export function recoveryProfileFromMainnetProfile(profile: MainnetProfile): VaultRecoveryProfile {
  const n = profile.recovery.pubkeys.length;
  const shapeOk = (profile.recovery.threshold === 2 && n === 3) || (profile.recovery.threshold === 1 && n === 1);
  if (!shapeOk || profile.recovery.csvBlocks == null) {
    throw new AppError("MAINNET_DISABLED", "mainnet profile recovery is incomplete");
  }
  return {
    profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
    recoveryCsvBlocks: profile.recovery.csvBlocks,
    recoveryThreshold: profile.recovery.threshold,
    recoveryPubkeys: profile.recovery.pubkeys.map((k) => Buffer.from(k, "hex")),
  };
}

export interface LoadV3AppConfigOptions {
  /**
   * TESTS ONLY: use this profile instead of the committed one, validated with
   * the test-key bypass. Production code never passes it (there is no env
   * route to it), so a mainnet service always runs the committed profile.
   */
  testOnlyMainnetProfile?: MainnetProfile;
}

/**
 * The committed mainnet profile with its feeScript from COVE_FEE_ADDRESS, which
 * must validate (no private keys in it).
 */
function loadMainnetConfig(env: Env, opts: LoadV3AppConfigOptions): MainnetProfile {
  let profile: MainnetProfile;
  try {
    profile = opts.testOnlyMainnetProfile ?? committedMainnetProfile({ feeAddress: env[FEE_ADDRESS_ENV] }).profile;
  } catch (e) {
    throw new AppError("MAINNET_DISABLED", (e as Error).message);
  }
  const validation = validateMainnetProfile(profile, { allowTestKeys: opts.testOnlyMainnetProfile !== undefined });
  if (!validation.ok) {
    throw new AppError("MAINNET_DISABLED", `invalid mainnet profile: ${validation.errors.join("; ")}`);
  }
  if (profile.guardianXOnly == null || profile.feeScript == null) {
    throw new AppError("MAINNET_DISABLED", `mainnet profile missing guardianXOnly, or ${FEE_ADDRESS_ENV} is not set`);
  }
  return profile;
}

export function loadV3AppConfig(env: Env, opts: LoadV3AppConfigOptions = {}): V3AppConfig {
  // COVE_NETWORK is required; there is no fallback to CRC_NETWORK or regtest.
  let network: V3Network;
  try {
    network = requireCoveNetwork(env);
  } catch (e) {
    if (e instanceof CoveNetworkError) throw new AppError("WRONG_NETWORK", e.message);
    throw e;
  }
  const settings = coveNetworkSettings(network, env);
  const enabled = settings.v3Enabled;

  // Regtest keeps its fixture defaults (the local node every harness starts).
  // Every other network names its node explicitly; user/password are optional
  // because hosted providers put the API key in the URL.
  let coreRpcUrl: string;
  let coreRpcUser: string | undefined;
  let coreRpcPassword: string | undefined;
  if (network === "regtest") {
    coreRpcUrl = env.COVE_BITCOIN_RPC_URL ?? env.COVE_REGTEST_RPC_URL ?? env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443";
    coreRpcUser = env.COVE_BITCOIN_RPC_USER ?? env.COVE_REGTEST_RPC_USER ?? env.BITCOIN_RPC_USER ?? "user";
    coreRpcPassword = env.COVE_BITCOIN_RPC_PASSWORD ?? env.COVE_REGTEST_RPC_PASSWORD ?? env.BITCOIN_RPC_PASSWORD ?? "pass";
  } else {
    if (!env.COVE_BITCOIN_RPC_URL) {
      throw new AppError("CORE_UNAVAILABLE", `COVE_BITCOIN_RPC_URL is required on ${network}`);
    }
    coreRpcUrl = env.COVE_BITCOIN_RPC_URL;
    coreRpcUser = env.COVE_BITCOIN_RPC_USER || undefined;
    coreRpcPassword = env.COVE_BITCOIN_RPC_PASSWORD || undefined;
  }
  // Optional second node for the two-node quorum; never required.
  const coreRpcUrlSecondary = env.COVE_BITCOIN_RPC_URL_SECONDARY || undefined;

  // Mainnet: public profile ONLY. Any local private-key env var is fatal (§15).
  if (network === "mainnet") {
    if (env.COVE_GUARDIAN_PRIVATE_KEY_HEX || env.COVE_RECOVERY_PRIVATE_KEY_HEX || env.COVE_FEE_PRIVATE_KEY_HEX) {
      throw new AppError("MAINNET_DISABLED", "mainnet must not load local Guardian/recovery/fee private keys");
    }
    if (!settings.ordUrl) {
      throw new AppError("MAINNET_DISABLED", "mainnet needs an ord server: funding inputs must be checked for inscriptions and runes");
    }
    const profile = loadMainnetConfig(env, opts);
    const recoveryProfile = recoveryProfileFromMainnetProfile(profile);
    return {
      enabled,
      settings,
      network,
      chainIdentity: CHAIN_BITCOIN_MAINNET,
      coreRpcUrl,
      coreRpcUser,
      coreRpcPassword,
      coreRpcUrlSecondary,
      feeScript: Buffer.from(profile.feeScript!, "hex"),
      guardianXOnly: Buffer.from(profile.guardianXOnly!, "hex"),
      recoveryKeyXOnly: recoveryProfile.recoveryPubkeys[0]!, // unused for MAINNET1
      recoveryProfile,
      guardianPrivateKey: null,
      activationHeight: profile.activationHeight ?? 0n,
      canaryAllowedTokenIds: profile.canary.allowedTokenIds,
      canaryAllowedWalletScripts: profile.canary.allowedWalletScripts,
      p2pFeeBps: profile.p2pFeeBps ?? undefined,
      buyFeeBps: BigInt(profile.buyFeeBps!),
      buyFeeFlatSats: COVE_FEE_CONFIG.buyFeeFlatSats,
      discoveryEnvelope: settings.discoveryEnvelope,
      redeemFeeBps: BigInt(profile.redeemFeeBps!),
      redeemFeeFlatSats: COVE_FEE_CONFIG.redeemFeeFlatSats,
      maxP2pSettlementSats: profile.canary.maxP2pSettlementSats ?? undefined,
      mintLimits: {
        maxMintAtoms: profile.canary.maxMintAtoms ?? PUBLIC_SUPPLY_ATOMS_CAP,
        maxGrossSats: profile.canary.maxSingleBuySats ?? null,
        minGrossSats: profile.canary.minMintGrossSats ?? 0n,
      },
      maxMinerFeeSats: 20_000n,
      maxListingBlocks: 21_000n,
      reservationTtlSeconds: 90,
      mainnetProfileValid: true, // loadMainnetConfig threw otherwise
      mainnetMutationsArmed: ["1", "true", "yes", "on"].includes((env.COVE_V3_CANARY_ACTIVE ?? "").toLowerCase()),
      mainnetProfileHash: hashMainnetProfile(profile),
      guardianEndpoint: env.COVE_GUARDIAN_ENDPOINT,
      guardianAuthToken: env.COVE_GUARDIAN_AUTH_TOKEN,
      ordUrl: settings.ordUrl ?? undefined,
    };
  }

  // Regtest defaults match the deterministic protocol fixture; staging must set
  // these explicitly.
  const guardianPriv = hexOrNull(env.COVE_GUARDIAN_PRIVATE_KEY_HEX) ?? (network === "regtest" ? REGTEST_GUARDIAN_PRIV : null);
  // Off regtest the Guardian key is named explicitly. Falling back to the
  // recovery key silently put one key behind both the signing and the
  // recovery path of every vault.
  if (!guardianPriv && network !== "regtest") {
    throw new AppError("GUARDIAN_UNAVAILABLE", "COVE_GUARDIAN_PRIVATE_KEY_HEX is required off regtest");
  }
  const recoveryPriv = hexOrNull(env.COVE_RECOVERY_PRIVATE_KEY_HEX) ?? (network === "regtest" ? REGTEST_RECOVERY_PRIV : null);
  // Fees go to COVE_FEE_ADDRESS when set, as on mainnet; otherwise to the
  // fee key's address (the public fixture key on regtest).
  const feeAddress = env[FEE_ADDRESS_ENV];
  const feePriv = hexOrNull(env.COVE_FEE_PRIVATE_KEY_HEX) ?? (network === "regtest" ? REGTEST_FEE_PRIV : null);

  if (!recoveryPriv || (!feePriv && !feeAddress)) {
    throw new AppError("GUARDIAN_UNAVAILABLE", `recovery key and ${FEE_ADDRESS_ENV} (or a fee key) required for non-regtest`);
  }
  let feeScript: Buffer;
  try {
    feeScript = feeAddress
      ? Buffer.from(feeScriptFromAddress(feeAddress, network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet), "hex")
      : p2wpkh(feePriv!);
  } catch (e) {
    throw new AppError("WRONG_NETWORK", (e as Error).message);
  }

  return {
    enabled,
    settings,
    network,
    chainIdentity: chainIdentityFor(network),
    coreRpcUrl,
    coreRpcUser,
    coreRpcPassword,
    coreRpcUrlSecondary,
    feeScript,
    guardianXOnly: xonly(guardianPriv!),
    recoveryKeyXOnly: xonly(recoveryPriv),
    guardianPrivateKey: guardianPriv,
    // Where the indexer starts. Required in practice on a public test network:
    // a pruned node cannot serve the blocks before it, and nothing Cove made
    // exists there anyway.
    activationHeight: BigInt(env.COVE_ACTIVATION_HEIGHT ?? "0"),
    buyFeeBps: COVE_FEE_CONFIG.buyFeeBps,
    buyFeeFlatSats: COVE_FEE_CONFIG.buyFeeFlatSats,
    discoveryEnvelope: settings.discoveryEnvelope,
    redeemFeeBps: COVE_FEE_CONFIG.redeemFeeBps,
    redeemFeeFlatSats: COVE_FEE_CONFIG.redeemFeeFlatSats,
    maxMinerFeeSats: 20_000n,
    maxListingBlocks: 21_000n,
    reservationTtlSeconds: 90,
    ordUrl: settings.ordUrl ?? undefined,
    // Regtest only: the end-to-end suite mints a whole curve, which at the
    // real 200,000-sat limit would take about 5,000 mints.
    ...(network === "regtest" && env.COVE_REGTEST_MAX_MINT_GROSS_SATS
      ? { mintLimits: { maxMintAtoms: PUBLIC_SUPPLY_ATOMS_CAP, maxGrossSats: BigInt(env.COVE_REGTEST_MAX_MINT_GROSS_SATS), minGrossSats: 0n } }
      : {}),
  };
}
