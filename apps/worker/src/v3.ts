import { Client } from "pg";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb } from "@crclaunch/db";
import {
  V3Store,
  persistentWorker,
  reorgPersistentToTip,
  hydrateState,
} from "@crclaunch/cove-indexer/v3";
import { loadV3AppConfig, V3AppService, Metrics, buildAppTransitionSigner, watchGuardianAgreement, workerLockKey, saveChainObservation, saveFeeObservation } from "@crclaunch/cove-app";
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
  if (!config.enabled) throw new Error(`the V3 app is not enabled for ${config.network} (committed network settings)`);
  const POLL_MS = config.settings.workerPollMs;

  const lock = await acquireNetworkLock(config.network);
  const provider = new CoreRpcProvider({ url: config.coreRpcUrl, user: config.coreRpcUser, password: config.coreRpcPassword, apiKey: config.coreRpcApiKey });
  // §P1-2: arm the two-node Core quorum when a secondary Core is configured.
  const secondaryProvider = config.coreRpcUrlSecondary
    ? new CoreRpcProvider({ url: config.coreRpcUrlSecondary, user: config.coreRpcUser, password: config.coreRpcPassword, apiKey: config.coreRpcApiKey })
    : null;
  const db = createDb(DB_URL);
  const store = new V3Store(config.network);
  // §C4: the transition signer is REQUIRED (no raw-signing fallback).
  const transitionSigner = buildAppTransitionSigner(db, config);
  // Mainnet: stop if the Guardian runs a different profile (fee address included).
  watchGuardianAgreement(transitionSigner, config, { service: "worker" });
  const app = new V3AppService(db, provider, config, transitionSigner, secondaryProvider);
  const metrics = new Metrics();

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
  let lastFeeRefresh = 0;

  const tick = async () => {
    try {
      // 1. check Core + reorg
      const info = await provider.getBlockchainInfo().catch(async (e: unknown) => {
        await saveChainObservation(db, config.network, null);
        throw e;
      });
      await saveChainObservation(db, config.network, info);
      const coreHeight = BigInt(info.blocks);
      if (state.cursor.height > 0n) {
        const shorterTip = state.cursor.height > coreHeight;
        const coreHashAtCursor = shorterTip ? null : state.cursor.height === coreHeight
          ? info.bestBlockHash : await provider.getBlockHash(Number(state.cursor.height));
        if (shorterTip || coreHashAtCursor !== state.cursor.blockHash) {
          console.log(`reorg detected at height ${state.cursor.height}; rolling back to tip`);
          await reorgPersistentToTip({ db, store, state, provider, config: indexerConfig });
          metrics.inc("market.confirmations");
        }
      }
      // 2. catch up persistent indexer
      await persistentWorker({ db, store, state, provider, config: indexerConfig, opts: { chainInfo: info } });
      if (Date.now() - lastFeeRefresh >= 60_000) {
        await saveFeeObservation(db, config.network, await app.feeRates());
        lastFeeRefresh = Date.now();
      }
      // 3. reconcile market
      const market = await app.market.reconcileMarket(coreHeight);
      metrics.gauge("market.listings_active", BigInt(market.confirmed));
      metrics.inc("market.confirmations", market.confirmed);
      // 4. reconcile app tx sessions
      const sessions = await app.reconcileAppSessions();
      metrics.inc("market.broadcasts", sessions.confirmed);
      if (market.confirmed || sessions.confirmed || market.reorged) {
        console.log(`reconciled: market ${JSON.stringify(market)} sessions ${JSON.stringify(sessions)}`);
      }
    } catch (e) {
      console.error("V3 worker tick failed:", e instanceof Error ? e.message : String(e));
    }
  };

  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  void lock;
}

main().catch((e) => {
  console.error("V3 worker failed:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
