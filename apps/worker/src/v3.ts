import { Client } from "pg";
import { eq } from "drizzle-orm";
import { schema } from "@crclaunch/db";
import { CoreRpcProvider, withRpcDeadline } from "@crclaunch/bitcoin";
import {
  createDb,
  PostgresRpcBudget,
  providerAccount,
  pruneQuotaWindows,
  claimObservationWorker,
  assertObservationWorker,
} from "@crclaunch/db";
import {
  V3Store,
  persistentWorker,
  reorgPersistentToTip,
  hydrateState,
} from "@crclaunch/cove-indexer/v3";
import {
  loadV3AppConfig,
  V3AppService,
  Metrics,
  buildAppTransitionSigner,
  watchGuardianAgreement,
  workerLockKey,
  saveChainObservation,
  saveFeeObservation,
  collectFeeObservation,
  PendingObservationWorker,
} from "@crclaunch/cove-app";
import type { V3IndexerConfig } from "@crclaunch/cove-indexer/v3";
import { workerEnv } from "./v3-env.js";

/**
 * V3 worker runtime (§84-§86): continuous Core → persistent V3 indexer → market
 * reconcile → app transaction-session reconcile, with a single-owner Postgres
 * advisory lock per network. No MockCRCAdapter, no block mining, no graduation.
 */

const DB_URL = workerEnv.COVE_DATABASE_URL;

async function acquireNetworkLock(network: string): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const lost = () => {
    console.error("V3 worker ownership lost; stopping before further writes");
    process.exit(1);
  };
  client.on("error", lost);
  client.on("end", lost);
  // Deterministic advisory-lock key per network (single-owner guard).
  const key = workerLockKey(network);
  const res = await client.query("SELECT pg_try_advisory_lock($1)", [key]);
  if (res.rows[0]?.pg_try_advisory_lock !== true) {
    await client.end();
    throw new Error(`another V3 worker owns network "${network}" (advisory lock held)`);
  }
  console.log(`✓ acquired V3 worker advisory lock for ${network}`);
  return client;
}

async function main() {
  const config = loadV3AppConfig(process.env);
  if (!config.enabled)
    throw new Error(`the V3 app is not enabled for ${config.network} (committed network settings)`);
  const POLL_MS = config.settings.workerPollMs;

  const lock = await acquireNetworkLock(config.network);
  const db = createDb(DB_URL);
  const budget = new PostgresRpcBudget(
    db,
    providerAccount({
      url: config.coreRpcUrl,
      apiKey: config.coreRpcApiKey,
      user: config.coreRpcUser,
      password: config.coreRpcPassword,
    }),
    "worker",
    workerEnv.COVE_RPC_REQUESTS_PER_SECOND,
  );
  const provider = new CoreRpcProvider({
    budget,
    url: config.coreRpcUrl,
    user: config.coreRpcUser,
    password: config.coreRpcPassword,
    apiKey: config.coreRpcApiKey,
  });
  // §P1-2: arm the two-node Core quorum when a secondary Core is configured.
  const secondaryProvider = config.coreRpcUrlSecondary
    ? new CoreRpcProvider({
        budget: new PostgresRpcBudget(
          db,
          providerAccount({
            url: config.coreRpcUrlSecondary,
            apiKey: config.coreRpcApiKey,
            user: config.coreRpcUser,
            password: config.coreRpcPassword,
          }),
          "worker",
          workerEnv.COVE_RPC_REQUESTS_PER_SECOND,
        ),
        url: config.coreRpcUrlSecondary,
        user: config.coreRpcUser,
        password: config.coreRpcPassword,
        apiKey: config.coreRpcApiKey,
      })
    : null;
  const workerEpoch = await claimObservationWorker(db, config.network);
  const store = new V3Store(config.network, workerEpoch);
  // §C4: the transition signer is REQUIRED (no raw-signing fallback).
  const transitionSigner = buildAppTransitionSigner(db, config);
  // Mainnet: stop if the Guardian runs a different profile (fee address included).
  watchGuardianAgreement(transitionSigner, config, { service: "worker" });
  const app = new V3AppService(db, provider, config, transitionSigner, secondaryProvider);
  const metrics = new Metrics();
  const observations = new PendingObservationWorker(db, provider, config, workerEpoch);

  const indexerConfig: V3IndexerConfig = {
    network: config.network,
    chainIdentity: config.chainIdentity,
    guardianXOnly: config.guardianXOnly,
    recoveryKeyXOnly: config.recoveryKeyXOnly,
    recoveryProfile: config.recoveryProfile,
    feeScript: config.feeScript,
    genesisHeight: config.activationHeight,
    buyFeeBps: config.buyFeeBps,
    redeemFeeBps: config.redeemFeeBps,
  };

  const state = await hydrateState(db, config.network, indexerConfig);
  console.log(`V3 worker started (${config.network}), cursor ${state.cursor.height}`);
  const runLoop = async (name: string, intervalMs: number, task: () => Promise<unknown>) => {
    for (;;) {
      try {
        await withRpcDeadline(AbortSignal.timeout(180_000), task);
      } catch (error) {
        if (error instanceof Error && error.name === "WorkerOwnershipLost") process.exit(1);
        console.error(`V3 ${name} failed:`, error instanceof Error ? error.message : "unavailable");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
  const indexedCursor = async () =>
    (
      await db
        .select()
        .from(schema.coveV3Cursor)
        .where(eq(schema.coveV3Cursor.network, config.network))
    )[0];
  await Promise.all([
    runLoop("indexing", POLL_MS, async () => {
      const info = await provider.getBlockchainInfo().catch(async (error: unknown) => {
        await db.transaction(async (tx) => {
          await assertObservationWorker(tx, config.network, workerEpoch);
          await saveChainObservation(tx, config.network, null);
        });
        throw error;
      });
      await db.transaction(async (tx) => {
        await assertObservationWorker(tx, config.network, workerEpoch);
        await saveChainObservation(tx, config.network, info);
      });
      const coreHeight = BigInt(info.blocks);
      if (state.cursor.height > 0n) {
        const shorterTip = state.cursor.height > coreHeight;
        const hash = shorterTip
          ? null
          : state.cursor.height === coreHeight
            ? info.bestBlockHash
            : await provider.getBlockHash(Number(state.cursor.height));
        if (shorterTip || hash !== state.cursor.blockHash)
          await reorgPersistentToTip({ db, store, state, provider, config: indexerConfig });
      }
      await persistentWorker({
        db,
        store,
        state,
        provider,
        config: indexerConfig,
        opts: { chainInfo: info },
      });
    }),
    runLoop("pending projections", 1_000, () => observations.refresh()),
    runLoop("fees", 60_000, async () => {
      const observation = await collectFeeObservation(provider, config.network);
      await db.transaction(async (tx) => {
        await assertObservationWorker(tx, config.network, workerEpoch);
        await saveFeeObservation(tx, config.network, observation.rates, observation.observedAt);
      });
    }),
    runLoop("market observations", 5_000, async () => {
      const cursor = await indexedCursor();
      if (!cursor || cursor.rebuilding) return;
      const market = await app.market.reconcileMarket(
        cursor.height,
        `${cursor.height}:${cursor.blockHash}:${cursor.stateRoot}`,
      );
      metrics.inc("market.confirmations", market.confirmed);
    }),
    runLoop("reservation expiry", 5_000, async () => {
      const cursor = await indexedCursor();
      if (cursor) await app.market.expireReservations(cursor.height);
    }),
    runLoop("app sessions", 5_000, () => app.reconcileAppSessions()),
    runLoop("canonical submission conflicts", 5_000, () => app.reconcileSubmissionConflicts()),
    runLoop("submission recovery", 60_000, () => app.recoverSubmissions(2)),
    runLoop("quota cleanup", 60_000, () => pruneQuotaWindows(db)),
  ]);

  void lock;
}

main().catch((e) => {
  console.error("V3 worker failed:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
