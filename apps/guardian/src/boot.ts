import { requireCoveNetwork, coveNetworkSettings, type CoveNetworkName } from "@crclaunch/config";
import { resolveMainnetProfile, TEST_ONLY_PROFILE_ENV, FEE_ADDRESS_ENV, type ResolvedMainnetProfile } from "@crclaunch/cove-mainnet";
import { CHAIN_BITCOIN_MAINNET } from "@crclaunch/cove-wire";
import type { GuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import { selectCustodyBackend } from "./custody.js";
import { requireAuthToken } from "./auth.js";

/**
 * Everything the Guardian needs before it can start, from the environment:
 *
 *   COVE_NETWORK        required, no default
 *   COVE_DATABASE_URL   required
 *   COVE_BITCOIN_RPC_URL required: the Guardian's OWN view of the chain, used
 *                       to refuse unconfirmed funding inputs (the app could lie)
 *   GUARDIAN_AUTH_TOKEN required
 *   GUARDIAN_KEY_HEX    required on mainnet
 *   COVE_FEE_ADDRESS    required on mainnet: where every protocol fee goes;
 *                       must equal the web app's and the worker's
 *
 * Everything else (port, ord server) is committed per network. Regtest CI may
 * also name COVE_TEST_ONLY_PROFILE_PATH and GUARDIAN_TEST_KEY_HEX.
 */
export interface GuardianBoot {
  network: CoveNetworkName;
  /** Mainnet rules apply: COVE_NETWORK=mainnet, or the committed (mainnet) profile. */
  mainnetGuard: boolean;
  canaryActive: boolean;
  profile: ResolvedMainnetProfile;
  custodyBackend: GuardianCustodyBackend;
  custody: "env-key" | "test" | "unconfigured";
  databaseUrl: string;
  coreRpc: { url: string; user?: string; password?: string };
  authToken: string;
  port: number;
  ordUrl: string | undefined;
}

export function resolveGuardianBoot(env: Record<string, string | undefined>): GuardianBoot {
  const network = requireCoveNetwork(env);
  const authToken = requireAuthToken(env.GUARDIAN_AUTH_TOKEN);
  const databaseUrl = env.COVE_DATABASE_URL;
  if (!databaseUrl) throw new Error("COVE_DATABASE_URL is required");
  const coreRpcUrl = env.COVE_BITCOIN_RPC_URL;
  if (!coreRpcUrl) throw new Error("COVE_BITCOIN_RPC_URL is required (the Guardian checks funding inputs against its own node)");

  const profile = resolveMainnetProfile({
    network,
    testOnlyPath: env[TEST_ONLY_PROFILE_ENV] || undefined,
    feeAddress: env[FEE_ADDRESS_ENV] || undefined,
  });
  // The committed profile is always a bitcoin-mainnet profile. Running it
  // under any other network would sign for mainnet vaults with non-mainnet
  // rules, so it forces the mainnet guard — and must be declared as mainnet.
  const committedMainnet = profile.source === "committed" && profile.profile.chainIdentity === CHAIN_BITCOIN_MAINNET;
  if (committedMainnet && network !== "mainnet") {
    throw new Error(
      `the committed profile is for bitcoin-mainnet but COVE_NETWORK is ${network}; ` +
        `set COVE_NETWORK=mainnet, or name a test profile with ${TEST_ONLY_PROFILE_ENV} (regtest CI)`,
    );
  }
  const mainnetGuard = network === "mainnet" || committedMainnet;

  const keyHex = env.GUARDIAN_KEY_HEX || undefined;
  const testKeyHex = env.GUARDIAN_TEST_KEY_HEX || undefined;
  const custodyBackend = selectCustodyBackend(mainnetGuard ? "mainnet" : network, { keyHex, testKeyHex });
  const settings = coveNetworkSettings(network, env);

  return {
    network,
    mainnetGuard,
    canaryActive: ["1", "true", "yes", "on"].includes((env.COVE_V3_CANARY_ACTIVE ?? "").toLowerCase()),
    profile,
    custodyBackend,
    custody: keyHex ? "env-key" : testKeyHex ? "test" : "unconfigured",
    databaseUrl,
    coreRpc: { url: coreRpcUrl, user: env.COVE_BITCOIN_RPC_USER || undefined, password: env.COVE_BITCOIN_RPC_PASSWORD || undefined },
    authToken,
    port: settings.guardianPort,
    ordUrl: settings.ordUrl ?? undefined,
  };
}
