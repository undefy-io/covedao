import * as bitcoin from "bitcoinjs-lib";
import type { Network, RuntimeConfig } from "./types.js";

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function str(env: Env, key: string, fallback = ""): string {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function bool(env: Env, key: string, fallback = false): boolean {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return ["true", "1", "yes", "on"].includes(v.toLowerCase());
}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ConfigError(`Environment variable ${key} must be an integer.`);
  return n;
}

function bigintOrNull(env: Env, key: string): bigint | null {
  const v = env[key];
  if (v === undefined || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    throw new ConfigError(`Environment variable ${key} must be a base-10 integer.`);
  }
}

function parseNetwork(raw: string): Network {
  switch (raw) {
    case "mock":
    case "test":
    case "mainnet":
    case "mainnet-read-only":
      return raw;
    case "mutinynet":
    case "signet":
    case "regtest":
    case "testnet":
      return "test";
    default:
      throw new ConfigError(
        `Unknown CRC_NETWORK "${raw}". Expected mock, test, mainnet, or mainnet-read-only.`,
      );
  }
}

/** Load a RuntimeConfig from a process-like environment object. */
export function loadConfig(env: Env): RuntimeConfig {
  const nodeEnvRaw = str(env, "NODE_ENV", "development");
  const nodeEnv =
    nodeEnvRaw === "production"
      ? "production"
      : nodeEnvRaw === "test"
        ? "test"
        : "development";

  const network = parseNetwork(str(env, "CRC_NETWORK", "mock"));

  const config: RuntimeConfig = {
    nodeEnv,
    appUrl: str(env, "APP_URL", "http://localhost:3000"),
    appName: str(env, "NEXT_PUBLIC_APP_NAME", "CRC Launch"),
    databaseUrl: str(env, "DATABASE_URL", ""),
    redisUrl: str(env, "REDIS_URL", "redis://localhost:6379"),
    network,
    protocolUrl: str(env, "CRC_PROTOCOL_URL") || null,
    protocolVerified: bool(env, "CRC_PROTOCOL_VERIFIED", false),
    flags: {
      deployMainnet: bool(env, "CRC_DEPLOY_MAINNET_ENABLED", false),
      mintMainnet: bool(env, "CRC_MINT_MAINNET_ENABLED", false),
      marketMainnet: bool(env, "CRC_MARKET_MAINNET_ENABLED", false),
      graduationMainnet: bool(env, "CRC_GRADUATION_MAINNET_ENABLED", false),
    },
    coveFlags: {
      mainnetEnabled: bool(env, "COVE_MAINNET_ENABLED", false),
      deployMainnet: bool(env, "COVE_DEPLOY_MAINNET_ENABLED", false),
      mintMainnet: bool(env, "COVE_MINT_MAINNET_ENABLED", false),
      transferMainnet: bool(env, "COVE_TRANSFER_MAINNET_ENABLED", false),
    },
    coveMainnetGenesisHeight: bigintOrNull(env, "COVE_V1_MAINNET_GENESIS_HEIGHT"),
    coveMainnetCanary: {
      deployTxid: str(env, "COVE_V1_MAINNET_CANARY_DEPLOY_TXID") || null,
      mintTxid: str(env, "COVE_V1_MAINNET_CANARY_MINT_TXID") || null,
      transferTxid: str(env, "COVE_V1_MAINNET_CANARY_TRANSFER_TXID") || null,
      stateRoot: str(env, "COVE_V1_MAINNET_CANARY_STATE_ROOT") || null,
      replayRoot: str(env, "COVE_V1_MAINNET_CANARY_REPLAY_ROOT") || null,
    },
    bitcoinRpc: str(env, "BITCOIN_RPC_URL")
      ? {
          url: str(env, "BITCOIN_RPC_URL"),
          user: str(env, "BITCOIN_RPC_USER") || null,
          password: str(env, "BITCOIN_RPC_PASSWORD") || null,
        }
      : null,
    explorerUrl: str(env, "BITCOIN_EXPLORER_URL", "https://blockstream.info"),
    treasuryAddress: str(env, "PLATFORM_TREASURY_ADDRESS") || null,
    launchFeeSats: bigintOrNull(env, "LAUNCH_FEE_SATS") ?? 10_000n,
    primaryMintFeeBps: bigintOrNull(env, "PRIMARY_MINT_FEE_BPS") ?? 100n,
    finalityConfirmations: int(env, "FINALITY_CONFIRMATIONS", 6),
    quoteTtlSeconds: int(env, "QUOTE_TTL_SECONDS", 120),
    quoteTtlBlocks: int(env, "QUOTE_TTL_BLOCKS", 2),
    s3: str(env, "S3_ENDPOINT") && str(env, "S3_BUCKET")
      ? {
          endpoint: str(env, "S3_ENDPOINT"),
          bucket: str(env, "S3_BUCKET"),
          accessKey: str(env, "S3_ACCESS_KEY"),
          secretKey: str(env, "S3_SECRET_KEY"),
        }
      : null,
    sentryDsn: str(env, "SENTRY_DSN") || null,
    adminAuthSecret: str(env, "ADMIN_AUTH_SECRET") || null,
  };

  return config;
}

/** True when the network implies a Bitcoin mainnet context. */
export function isMainnetNetwork(network: Network): boolean {
  return network === "mainnet" || network === "mainnet-read-only";
}

const TXID_RE = /^[0-9a-f]{64}$/;

/**
 * Whether the owner's canary self-attestation is syntactically complete: a
 * committed future activation height, three 64-hex txids, and matching
 * final/replay state-root strings.
 *
 * IMPORTANT: this is an ASSERTION, not a proof. It performs six regex tests and
 * one string equality — it does NOT query mainnet for those txids, does not
 * recompute the state root from those blocks, and does not compare against the
 * `.cove-mainnet-canary.json` manifest. It is named `…Asserted` so a
 * self-attestation is never mistaken for chain verification. The chain-level
 * verification happens in the canary process (cove-indexer), which replays and
 * confirms the txids and recomputes the root before recording them.
 */
export function isCoveMainnetCanaryAsserted(config: RuntimeConfig): boolean {
  return (
    config.coveMainnetGenesisHeight !== null &&
    config.coveMainnetGenesisHeight > 0n &&
    config.coveMainnetCanary.deployTxid !== null &&
    TXID_RE.test(config.coveMainnetCanary.deployTxid) &&
    config.coveMainnetCanary.mintTxid !== null &&
    TXID_RE.test(config.coveMainnetCanary.mintTxid) &&
    config.coveMainnetCanary.transferTxid !== null &&
    TXID_RE.test(config.coveMainnetCanary.transferTxid) &&
    config.coveMainnetCanary.stateRoot !== null &&
    TXID_RE.test(config.coveMainnetCanary.stateRoot) &&
    config.coveMainnetCanary.replayRoot !== null &&
    TXID_RE.test(config.coveMainnetCanary.replayRoot) &&
    config.coveMainnetCanary.stateRoot === config.coveMainnetCanary.replayRoot
  );
}

/**
 * Startup assertions. Throws ConfigError when a write-enabled mainnet
 * configuration is internally inconsistent (e.g. missing treasury or an
 * invalid treasury network).
 */
export function validateConfig(config: RuntimeConfig): void {
  if (config.nodeEnv === "production" && config.adminAuthSecret === null) {
    throw new ConfigError(
      "ADMIN_AUTH_SECRET is required in production. Set a strong random secret.",
    );
  }

  // Cove mainnet two-stage activation gate (fail-closed, enforced in code).
  // Stage 2 (public writes) is reachable ONLY after stage 1 (OWNER_CANARY):
  // a public write flag without COVE_MAINNET_ENABLED is refused.
  const { mainnetEnabled, deployMainnet, mintMainnet, transferMainnet } = config.coveFlags;
  const anyPublicWrite = deployMainnet || mintMainnet || transferMainnet;
  if (anyPublicWrite && !mainnetEnabled) {
    throw new ConfigError(
      "A Cove public write flag is enabled but COVE_MAINNET_ENABLED (stage 1) is not. " +
        "Public writes require stage 1 first. Refusing to boot.",
    );
  }
  const coveMainnetWrites = mainnetEnabled || anyPublicWrite;
  if (coveMainnetWrites && !isCoveMainnetCanaryAsserted(config)) {
    throw new ConfigError(
      "A Cove mainnet flag is enabled but the full owner canary proof is not recorded. " +
        "Requires COVE_V1_MAINNET_GENESIS_HEIGHT (future H), the confirmed DEPLOY/MINT/TRANSFER " +
        "txids, and matching COVE_V1_MAINNET_CANARY_STATE_ROOT / REPLAY_ROOT. Refusing to boot.",
    );
  }

  const writesEnabled = Object.values(config.flags).some(Boolean);
  if (isMainnetNetwork(config.network) && writesEnabled) {
    if (!config.protocolVerified) {
      // Fail closed — must be explicit.
      throw new ConfigError(
        "A mainnet write flag is enabled but CRC_PROTOCOL_VERIFIED is false. " +
          "Refusing to boot. Verify the protocol first.",
      );
    }
    if (!config.treasuryAddress) {
      throw new ConfigError(
        "PLATFORM_TREASURY_ADDRESS is required when mainnet writes are enabled.",
      );
    }
  }

  if (config.treasuryAddress && config.network !== "mock") {
    // Real Bitcoin address decoding + checksum + network validation (not regex).
    const isMainnetAddr = isDecodableAddress(config.treasuryAddress, "mainnet");
    const isTestnetAddr = isDecodableAddress(config.treasuryAddress, "testnet");
    if (isMainnetNetwork(config.network)) {
      if (!isMainnetAddr) {
        throw new ConfigError(
          "PLATFORM_TREASURY_ADDRESS is not a valid mainnet Bitcoin address.",
        );
      }
    } else {
      if (!isTestnetAddr) {
        throw new ConfigError(
          "PLATFORM_TREASURY_ADDRESS is not a valid testnet Bitcoin address.",
        );
      }
    }
  }
}

/** Decode an address with bitcoinjs-lib (checksum + network enforced). */
function isDecodableAddress(address: string, network: "mainnet" | "testnet"): boolean {
  try {
    const net = network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
    return bitcoin.address.toOutputScript(address, net).length > 0;
  } catch {
    return false;
  }
}
