import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { collectFeeObservation, saveFeeObservation } from "@crclaunch/cove-app";
import { createDb, PostgresRpcBudget, providerAccount } from "@crclaunch/db";
import { assertCrcChainIdentity, syncCrcTip, type CrcWorkerSnapshot } from "@crclaunch/cove-indexer/crc20";
import { parseCrcWorkerEnv } from "./crc-env.js";
import { acquireCrcOwner } from "./crc-owner.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main() {
  const env = parseCrcWorkerEnv(process.env);
  const owner = await acquireCrcOwner(env.databaseUrl, env.network);
  const lost = () => {
    console.error("CRC worker ownership connection lost");
    process.exit(1);
  };
  owner.on("error", lost);
  owner.on("end", lost);
  const db = createDb(env.databaseUrl);
  const budget = new PostgresRpcBudget(db, providerAccount({ url: env.rpcUrl, apiKey: env.rpcApiKey, user: env.rpcUser, password: env.rpcPassword }), "worker", env.rpcRequestsPerSecond);
  const provider = new CoreRpcProvider({ budget, url: env.rpcUrl, apiKey: env.rpcApiKey, user: env.rpcUser, password: env.rpcPassword });
  assertCrcChainIdentity(env.network, (await provider.getBlockchainInfo()).chain);
  let stopping = false;
  let snapshot: CrcWorkerSnapshot | undefined;
  let feeInFlight: Promise<void> | null = null;
  let nextFeeAt = 0;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`CRC worker started for ${env.network} at activation ${env.activationHeight}`);
  while (!stopping) {
    if (!feeInFlight && Date.now() >= nextFeeAt) {
      nextFeeAt = Date.now() + 60_000;
      feeInFlight = (async () => {
        try {
          const observation = await collectFeeObservation(provider, env.network);
          await saveFeeObservation(db, env.network, observation.rates, observation.observedAt);
        } catch (error) {
          console.error("CRC fee observation failed:", error instanceof Error ? error.message : String(error));
        }
      })().finally(() => { feeInFlight = null; });
    }
    try {
      const result = await syncCrcTip({
        db, provider, network: env.network, activationHeight: env.activationHeight,
        protocolScriptHex: env.protocolScriptHex, snapshot,
      });
      snapshot = result.snapshot;
      if (result.indexed || result.rolledBack) console.log(`CRC cursor ${snapshot.cursor?.height ?? "none"}; indexed ${result.indexed}, rolled back ${result.rolledBack}`);
    } catch (error) {
      snapshot = undefined;
      console.error("CRC index tick failed:", error instanceof Error ? error.message : String(error));
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, env.pollMs));
  }
  if (feeInFlight) await feeInFlight;
  owner.removeAllListeners("end");
  owner.removeAllListeners("error");
  await owner.end();
}

main().catch((error) => {
  console.error("CRC worker failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
