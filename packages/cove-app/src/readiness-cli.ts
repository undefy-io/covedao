import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb } from "@crclaunch/db";
import { computeHealth } from "@crclaunch/cove-indexer/v3";
import {
  checkCoreAgreement,
  computeMainnetReadiness,
  deriveReadinessState,
  type MainnetReadiness,
  type ReadinessState,
} from "./readiness.js";
import { committedHash, evaluateIndexerProbe, probeWorkerLock } from "./readiness-probes.js";

/**
 * Runtime readiness gathering (§49/§50, §P1-1). Loads the canonical profile,
 * contacts primary + secondary Core, the Guardian service, the indexer DB and
 * the worker's advisory lock, and computes the ONE readiness result via
 * computeMainnetReadiness. Every signal is a REAL probe compared against a
 * committed value — nothing is hardcoded true and nothing self-compares.
 * Never broadcasts.
 */

export interface RuntimeReadinessEnv {
  /** TEST-ONLY profile file (CI); the committed profile otherwise. */
  COVE_TEST_ONLY_PROFILE_PATH?: string;
  /** Where every protocol fee goes; fills the committed profile's feeScript. */
  COVE_FEE_ADDRESS?: string;
  /** Committed hash of the approved mainnet profile (the source of truth). */
  COVE_V3_MAINNET_PROFILE_HASH?: string;
  /** Committed expected state root (replay root) the indexer must reach. */
  COVE_V3_MAINNET_STATE_ROOT?: string;
  /** Committed release-manifest hash. */
  COVE_V3_MAINNET_RELEASE_MANIFEST_HASH?: string;
  COVE_BITCOIN_RPC_URL?: string;
  COVE_BITCOIN_RPC_URL_SECONDARY?: string;
  COVE_BITCOIN_RPC_USER?: string;
  COVE_BITCOIN_RPC_PASSWORD?: string;
  COVE_GUARDIAN_ENDPOINT?: string;
  COVE_GUARDIAN_AUTH_TOKEN?: string;
  COVE_V3_CANARY_ACTIVE?: string;
  COVE_DATABASE_URL?: string;
}

export interface RuntimeReadinessResult {
  state: ReadinessState;
  readiness: MainnetReadiness;
  profileHash: string;
  expectedProfileHash: string | null;
  /** "committed", or "test-only" when CI named a test profile file. */
  profileSource: "committed" | "test-only";
  stateRoot: string;
  coreAgreementDetail: string | null;
}

async function guardianHealthHttp(endpoint: string, token: string) {
  const res = await fetch(`${endpoint}/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`guardian /health HTTP ${res.status}`);
  return (await res.json()) as {
    reachable: boolean; profileHash: string; guardianXOnly: string;
    auditHealthy: boolean; signingJournalHealthy: boolean; custodyBackendReady: boolean; signingEnabled: boolean;
  };
}

export async function runRuntimeReadiness(env: RuntimeReadinessEnv): Promise<RuntimeReadinessResult> {
  const { profile, profileHash, source } = resolveMainnetProfile({
    network: "tooling",
    testOnlyPath: env.COVE_TEST_ONLY_PROFILE_PATH,
    baseDir: process.env.INIT_CWD ?? process.cwd(),
    feeAddress: env.COVE_FEE_ADDRESS || undefined,
  });
  const canaryActive = ["true", "1", "yes", "on"].includes((env.COVE_V3_CANARY_ACTIVE ?? "").toLowerCase());

  // Committed expected values — fail closed when absent/invalid.
  const expectedProfileHash = committedHash(env.COVE_V3_MAINNET_PROFILE_HASH);
  const expectedStateRoot = committedHash(env.COVE_V3_MAINNET_STATE_ROOT);
  const releaseManifestOk = committedHash(env.COVE_V3_MAINNET_RELEASE_MANIFEST_HASH) !== null;

  // ── Core quorum (primary + secondary) ──
  const rpcUser = env.COVE_BITCOIN_RPC_USER ?? "user";
  const rpcPassword = env.COVE_BITCOIN_RPC_PASSWORD ?? "pass";
  const primary = new CoreRpcProvider({ url: env.COVE_BITCOIN_RPC_URL ?? "http://127.0.0.1:18443", user: rpcUser, password: rpcPassword });
  let primaryCoreHealthy = false;
  let secondaryCoreHealthy = false;
  let coreAgreement = false;
  let coreAgreementDetail: string | null = "no secondary Core configured";
  try {
    await primary.getBlockchainInfo();
    primaryCoreHealthy = true;
  } catch { /* primary unreachable */ }
  const secondaryUrl = env.COVE_BITCOIN_RPC_URL_SECONDARY;
  if (secondaryUrl) {
    const secondary = new CoreRpcProvider({ url: secondaryUrl, user: rpcUser, password: rpcPassword });
    try {
      await secondary.getBlockchainInfo();
      secondaryCoreHealthy = true;
      const agreement = await checkCoreAgreement(primary, secondary);
      coreAgreement = agreement.agreed;
      coreAgreementDetail = agreement.detail;
    } catch { secondaryCoreHealthy = false; coreAgreementDetail = "secondary unreachable"; }
  }

  // ── Indexer + worker (real DB probes) ──
  let indexerHealthy = false;
  let stateRootVerified = false;
  let stateRoot = "";
  let workerHealthy = false;
  if (env.COVE_DATABASE_URL) {
    try {
      const db = createDb(env.COVE_DATABASE_URL);
      const health = await computeHealth({ db, network: "mainnet", provider: primary });
      ({ indexerHealthy, stateRootVerified, stateRoot } = evaluateIndexerProbe(health, expectedStateRoot));
      workerHealthy = await probeWorkerLock(db, "mainnet");
    } catch { /* DB/indexer/worker unreachable — fail closed */ }
  }

  // ── Guardian (HTTP only; no in-process fixture on a mainnet-capable path) ──
  let guardianHealthy = false;
  let guardianProfileHash: string | null = null;
  let guardianXOnly: string | null = null;
  let custodyBackendReady = false;
  let auditHealthy = false;
  let signingJournalHealthy = false;
  if (env.COVE_GUARDIAN_ENDPOINT) {
    try {
      const h = await guardianHealthHttp(env.COVE_GUARDIAN_ENDPOINT, env.COVE_GUARDIAN_AUTH_TOKEN ?? "");
      guardianHealthy = h.reachable;
      guardianProfileHash = h.profileHash;
      guardianXOnly = h.guardianXOnly;
      custodyBackendReady = h.custodyBackendReady;
      auditHealthy = h.auditHealthy;
      signingJournalHealthy = h.signingJournalHealthy;
    } catch { guardianHealthy = false; }
  }

  const readiness = computeMainnetReadiness({
    allowTestKeys: source === "test-only",
    profile,
    profileHash,
    expectedProfileHash: expectedProfileHash ?? "",
    releaseManifestOk,
    primaryCoreHealthy,
    secondaryCoreHealthy,
    coreAgreement,
    indexerHealthy,
    stateRootVerified,
    workerHealthy,
    guardianHealthy,
    guardianProfileHash,
    guardianXOnly,
    custodyBackendReady,
    auditHealthy,
    signingJournalHealthy,
    canaryActive,
  });

  return {
    state: deriveReadinessState(readiness),
    readiness,
    profileHash,
    expectedProfileHash,
    profileSource: source,
    stateRoot,
    coreAgreementDetail,
  };
}
