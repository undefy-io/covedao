import "dotenv/config";
import { createDb, type Database } from "@crclaunch/db";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";
import { loadV3AppConfig, V3AppService, buildAppTransitionSigner, type V3AppConfig } from "@crclaunch/cove-app";
import { AppError } from "@crclaunch/cove-app";
import { serverEnv } from "./server-env";

/**
 * Production V3 server runtime (§6/§7/§8/§11/§12). Real Core RPC + real Postgres.
 * Regtest/staging MAY use a local Guardian key; mainnet requires the remote
 * transition signer (fail-closed). No PrecopCRCAdapter, no MockChainNode, no
 * mock Bitcoin provider. The mutation path always signs through a
 * GuardianTransitionSigner (journal + audit + risk policy) — never a raw fallback.
 */

export interface V3Services {
  config: V3AppConfig;
  db: Database;
  provider: CoreRpcProvider;
  secondaryProvider: CoreRpcProvider | null;
  transitionSigner: GuardianTransitionSigner;
  app: V3AppService;
}

const globalForV3 = globalThis as unknown as { __coveV3Services?: V3Services };

export function getV3Services(): V3Services {
  if (globalForV3.__coveV3Services) return globalForV3.__coveV3Services;
  const config = loadV3AppConfig(process.env);
  // Mainnet signs only through the Guardian service; refuse to start without it.
  if (config.network === "mainnet" && (!config.guardianEndpoint || !config.guardianAuthToken)) {
    throw new AppError("GUARDIAN_UNAVAILABLE", "COVE_GUARDIAN_ENDPOINT and COVE_GUARDIAN_AUTH_TOKEN are required on mainnet");
  }
  const dbUrl = serverEnv.COVE_DATABASE_URL;
  const db = createDb(dbUrl);
  const provider = new CoreRpcProvider({
    url: config.coreRpcUrl,
    user: config.coreRpcUser,
    password: config.coreRpcPassword,
  });
  // §P1-2: arm the two-node Core quorum when a secondary Core is configured.
  const secondaryProvider = config.coreRpcUrlSecondary
    ? new CoreRpcProvider({ url: config.coreRpcUrlSecondary, user: config.coreRpcUser, password: config.coreRpcPassword })
    : null;

  // §C4: the transition signer is REQUIRED — local for non-mainnet, remote for
  // mainnet. There is no raw-signing fallback.
  const transitionSigner = buildAppTransitionSigner(db, config);

  const app = new V3AppService(db, provider, config, transitionSigner, secondaryProvider);
  const services: V3Services = { config, db, provider, secondaryProvider, transitionSigner, app };
  globalForV3.__coveV3Services = services;
  return services;
}

export function assertV3Enabled(): V3Services {
  const s = getV3Services();
  if (!s.config.enabled) throw new AppError("APP_DISABLED", "covs is disabled on this server");
  return s;
}
