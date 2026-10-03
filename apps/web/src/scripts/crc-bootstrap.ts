import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "@crclaunch/db";
import { initializeCrcLedger } from "@crclaunch/crc20-state";
import { crcBootstrapConfig } from "../lib/crc-bootstrap.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
try {
  const { databaseUrl, activationHeight, config } = crcBootstrapConfig(process.env);
  await initializeCrcLedger(createDb(databaseUrl), config, { activationHeight });
  console.log(`CRC ${config.network} ledger initialized at activation ${activationHeight}`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
