import { AppError } from "@crclaunch/cove-app";
import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";
import { coveNetworkSettings } from "@crclaunch/config";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { PostgresRpcBudget, providerAccount, type Database } from "@crclaunch/db";
import type { ProtocolMode } from "./protocol-mode";
import { serverEnv } from "./server-env";
import { getCrcReadServices } from "./crc-server";

export function assertCrcMutationEnabled(mode: ProtocolMode, active: boolean): void {
  if (mode !== "crc20" || !active) {
    throw new AppError("CRC_TRADING_DISABLED", "Cove CRC-20 trading is not active on this server");
  }
}

export function requireCrcMutationEnabled(): void {
  assertCrcMutationEnabled(serverEnv.COVE_PROTOCOL_MODE, serverEnv.COVE_CRC_TRADING_ACTIVE);
}

export type CrcMutationServices = {
  db: Database;
  config: {
    network: "regtest" | "signet" | "testnet" | "mainnet";
    settings: ReturnType<typeof coveNetworkSettings>;
    maxMinerFeeSats: bigint;
  };
  crcVaultConfig: { guardianXOnly: Buffer; feeScriptHex: string; recoveryProfile: VaultRecoveryProfile };
  provider: CoreRpcProvider;
  guardianEndpoint: string;
  guardianAuthToken: string;
};

const globalForCrc = globalThis as unknown as { __coveCrcMutationServices?: CrcMutationServices };

export function getCrcMutationServices(): CrcMutationServices {
  requireCrcMutationEnabled();
  if (globalForCrc.__coveCrcMutationServices) return globalForCrc.__coveCrcMutationServices;
  const { db, network } = getCrcReadServices();
  const config = { network, settings: coveNetworkSettings(network, process.env), maxMinerFeeSats: 20_000n };
  const resolved = resolveMainnetProfile({
    network, testOnlyPath: serverEnv.COVE_TEST_ONLY_PROFILE_PATH,
    feeAddress: serverEnv.COVE_FEE_ADDRESS,
  });
  const { profile, validation } = resolved;
  if (!validation.ok || !profile.guardianXOnly || !profile.feeScript ||
    profile.recovery.csvBlocks == null ||
    !((profile.recovery.threshold === 2 && profile.recovery.pubkeys.length === 3) ||
      (profile.recovery.threshold === 1 && profile.recovery.pubkeys.length === 1))) {
    throw new AppError("GUARDIAN_UNAVAILABLE", "CRC Guardian profile is incomplete");
  }
  const crcVaultConfig = {
    guardianXOnly: Buffer.from(profile.guardianXOnly, "hex"),
    feeScriptHex: profile.feeScript,
    recoveryProfile: {
      profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1" as const,
      recoveryCsvBlocks: profile.recovery.csvBlocks,
      recoveryThreshold: profile.recovery.threshold,
      recoveryPubkeys: profile.recovery.pubkeys.map((key) => Buffer.from(key, "hex")),
    },
  };
  const guardianEndpoint = serverEnv.COVE_GUARDIAN_ENDPOINT;
  const guardianAuthToken = serverEnv.COVE_GUARDIAN_AUTH_TOKEN;
  if (!guardianEndpoint || !guardianAuthToken) {
    throw new AppError("GUARDIAN_UNAVAILABLE", "Guardian endpoint and auth token are required for CRC trading");
  }
  const coreRpcUrl = serverEnv.COVE_BITCOIN_RPC_URL ?? "http://127.0.0.1:18443";
  const coreRpcApiKey = serverEnv.COVE_BITCOIN_RPC_API_KEY;
  const coreRpcUser = coreRpcApiKey ? undefined : serverEnv.COVE_BITCOIN_RPC_USER ?? (network === "regtest" ? "user" : undefined);
  const coreRpcPassword = coreRpcApiKey ? undefined : serverEnv.COVE_BITCOIN_RPC_PASSWORD ?? (network === "regtest" ? "pass" : undefined);
  if (coreRpcApiKey && (serverEnv.COVE_BITCOIN_RPC_USER || serverEnv.COVE_BITCOIN_RPC_PASSWORD)) {
    throw new AppError("CORE_UNAVAILABLE", "CRC RPC API key cannot be combined with user/password");
  }
  const budget = new PostgresRpcBudget(db, providerAccount({
    url: coreRpcUrl,
    apiKey: coreRpcApiKey,
    user: coreRpcUser,
    password: coreRpcPassword,
  }), "public", serverEnv.COVE_RPC_REQUESTS_PER_SECOND);
  const provider = new CoreRpcProvider({
    budget, url: coreRpcUrl, user: coreRpcUser,
    password: coreRpcPassword, apiKey: coreRpcApiKey,
  });
  return globalForCrc.__coveCrcMutationServices = { db, config, crcVaultConfig, provider, guardianEndpoint, guardianAuthToken };
}
