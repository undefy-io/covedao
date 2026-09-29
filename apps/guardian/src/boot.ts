import { cleanEnv, str, bool, makeValidator } from "envalid";
import {
  coveNetworkSettings,
  type CoveNetworkName,
} from "@crclaunch/config";
import {
  resolveMainnetProfile,
  type ResolvedMainnetProfile,
} from "@crclaunch/cove-mainnet";
import type { GuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import { selectCustodyBackend } from "./custody.js";

const budgetRate = makeValidator((value: string) => {
  const rate = Number(value);
  if (!Number.isSafeInteger(rate) || rate < 3 || rate > 300) throw new Error("RPC budget must be 3..300 requests per second");
  return rate;
});
const nonEmpty = makeValidator((value: string) => {
  if (!value.trim()) throw new Error("must not be empty");
  return value;
});
const hexKey = makeValidator((value: string) => {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("must be 32 bytes of hex");
  return value;
});

const endpoint = (protocols: string[]) => makeValidator((value: string) => {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) throw new Error("unsupported URL scheme");
  return value;
});
const databaseUrl = endpoint(["postgres:", "postgresql:"]);
const httpUrl = endpoint(["http:", "https:"]);

export interface GuardianBoot {
  network: CoveNetworkName;
  mainnetGuard: boolean;
  canaryActive: boolean;
  profile: ResolvedMainnetProfile;
  custodyBackend: GuardianCustodyBackend;
  custody: "env-key" | "test" | "unconfigured";
  databaseUrl: string;
  coreRpc: { url: string; user?: string; password?: string; apiKey?: string };
  rpcRequestsPerSecond: number;
  rpcBudgetDatabaseUrl?: string;
  authToken: string;
  port: number;
  ordUrl: string | undefined;
}

export function resolveGuardianBoot(
  raw: Record<string, string | undefined>,
): GuardianBoot {
  const env = cleanEnv(
    {
      ...raw,
      GUARDIAN_KEY_HEX: raw.GUARDIAN_KEY_HEX || undefined,
      GUARDIAN_TEST_KEY_HEX: raw.GUARDIAN_TEST_KEY_HEX || undefined,
      COVE_ORD_URL: raw.COVE_ORD_URL || undefined,
    },
    {
      COVE_NETWORK: str({ choices: ["regtest", "signet", "testnet", "mainnet"] }),
      COVE_DATABASE_URL: databaseUrl(),
      COVE_RPC_BUDGET_DATABASE_URL: databaseUrl({ default: "" }),
      COVE_RPC_REQUESTS_PER_SECOND: budgetRate({ default: raw.COVE_NETWORK === "regtest" ? 90 : 3 }),
      COVE_BITCOIN_RPC_API_KEY: str({ default: "" }),
      COVE_BITCOIN_RPC_URL: httpUrl(),
      COVE_BITCOIN_RPC_USER: str({ default: "" }),
      COVE_BITCOIN_RPC_PASSWORD: str({ default: "" }),
      GUARDIAN_AUTH_TOKEN: nonEmpty(),
      GUARDIAN_KEY_HEX: hexKey({ default: "" }),
      GUARDIAN_TEST_KEY_HEX: hexKey({ default: "" }),
      COVE_FEE_ADDRESS: str({ default: "" }),
      COVE_TEST_ONLY_PROFILE_PATH: str({ default: "" }),
      COVE_V3_CANARY_ACTIVE: bool({ default: false }),
      COVE_ORD_URL: httpUrl({ default: "" }),
    },
    {
      reporter: ({ errors }) => {
        const invalid = Object.entries(errors);
        if (invalid.length) {
          throw new Error(
            invalid
              .map(([key, error]) => `${key} is ${error?.name === "EnvMissingError" ? "required" : "invalid"}`)
              .join("; "),
          );
        }
      },
    },
  );
  const network = env.COVE_NETWORK as CoveNetworkName;
  const profile = resolveMainnetProfile({
    network,
    testOnlyPath: env.COVE_TEST_ONLY_PROFILE_PATH || undefined,
    feeAddress: env.COVE_FEE_ADDRESS || undefined,
  });
  const mainnetGuard = network === "mainnet";
  const keyHex = env.GUARDIAN_KEY_HEX || undefined;
  const testKeyHex = env.GUARDIAN_TEST_KEY_HEX || undefined;
  const custodyBackend = selectCustodyBackend(network, { keyHex, testKeyHex });
  const settings = coveNetworkSettings(network, raw);
  return {
    network,
    mainnetGuard,
    canaryActive: env.COVE_V3_CANARY_ACTIVE,
    profile,
    custodyBackend,
    custody: keyHex ? "env-key" : testKeyHex ? "test" : "unconfigured",
    databaseUrl: env.COVE_DATABASE_URL,
    rpcRequestsPerSecond: env.COVE_RPC_REQUESTS_PER_SECOND,
    rpcBudgetDatabaseUrl: env.COVE_RPC_BUDGET_DATABASE_URL || undefined,
    coreRpc: {
      url: env.COVE_BITCOIN_RPC_URL,
      user: env.COVE_BITCOIN_RPC_USER || undefined,
      password: env.COVE_BITCOIN_RPC_PASSWORD || undefined,
      apiKey: env.COVE_BITCOIN_RPC_API_KEY || undefined,
    },
    authToken: env.GUARDIAN_AUTH_TOKEN,
    port: settings.guardianPort,
    ordUrl: settings.ordUrl ?? undefined,
  };
}
