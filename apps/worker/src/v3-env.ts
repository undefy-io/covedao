import { bool, cleanEnv, str, url } from "envalid";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export const workerEnv = cleanEnv(
  {
    COVE_NETWORK: process.env.COVE_NETWORK,
    COVE_DATABASE_URL: process.env.COVE_DATABASE_URL || process.env.DATABASE_URL,
    COVE_BITCOIN_RPC_URL: process.env.COVE_BITCOIN_RPC_URL || undefined,
    COVE_BITCOIN_RPC_API_KEY: process.env.COVE_BITCOIN_RPC_API_KEY || undefined,
    COVE_GUARDIAN_ENDPOINT: process.env.COVE_GUARDIAN_ENDPOINT || undefined,
    COVE_GUARDIAN_AUTH_TOKEN: process.env.COVE_GUARDIAN_AUTH_TOKEN || undefined,
    COVE_FEE_ADDRESS: process.env.COVE_FEE_ADDRESS || undefined,
    COVE_V3_CANARY_ACTIVE: process.env.COVE_V3_CANARY_ACTIVE || undefined,
  },
  {
    COVE_NETWORK: str({ choices: ["regtest", "signet", "testnet", "mainnet"] }),
    COVE_DATABASE_URL: url(),
    COVE_BITCOIN_RPC_URL: url({ default: undefined }),
    COVE_BITCOIN_RPC_API_KEY: str({ default: undefined }),
    COVE_GUARDIAN_ENDPOINT: url({ default: undefined }),
    COVE_GUARDIAN_AUTH_TOKEN: str({ default: undefined }),
    COVE_FEE_ADDRESS: str({ default: undefined }),
    COVE_V3_CANARY_ACTIVE: bool({ default: false }),
  },
  {
    reporter: ({ errors }) => {
      const names = Object.keys(errors);
      if (names.length) throw new Error(`Invalid environment variables: ${names.join(", ")}`);
    },
  },
);

if (workerEnv.COVE_NETWORK !== "regtest" && !workerEnv.COVE_BITCOIN_RPC_URL) {
  throw new Error("COVE_BITCOIN_RPC_URL is required outside regtest");
}

if (workerEnv.COVE_NETWORK === "mainnet") {
  for (const [name, value] of [
    ["COVE_GUARDIAN_ENDPOINT", workerEnv.COVE_GUARDIAN_ENDPOINT],
    ["COVE_GUARDIAN_AUTH_TOKEN", workerEnv.COVE_GUARDIAN_AUTH_TOKEN],
    ["COVE_FEE_ADDRESS", workerEnv.COVE_FEE_ADDRESS],
  ]) {
    if (!value) throw new Error(`${name} is required on mainnet`);
  }
}
