import { bool, cleanEnv, str, url } from "envalid";

export const serverEnv = cleanEnv(
  {
    COVE_NETWORK: process.env.COVE_NETWORK,
    COVE_DATABASE_URL: process.env.COVE_DATABASE_URL || process.env.DATABASE_URL,
    COVE_BITCOIN_RPC_URL: process.env.COVE_BITCOIN_RPC_URL || undefined,
    COVE_BITCOIN_RPC_API_KEY: process.env.COVE_BITCOIN_RPC_API_KEY || undefined,
    COVE_GUARDIAN_ENDPOINT: process.env.COVE_GUARDIAN_ENDPOINT || undefined,
    COVE_GUARDIAN_AUTH_TOKEN: process.env.COVE_GUARDIAN_AUTH_TOKEN || undefined,
    COVE_FEE_ADDRESS: process.env.COVE_FEE_ADDRESS || undefined,
    COVE_V3_CANARY_ACTIVE: process.env.COVE_V3_CANARY_ACTIVE || undefined,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
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
    SENTRY_DSN: url(),
    SENTRY_ENVIRONMENT: str({ choices: ["dev", "staging", "prod"] }),
  },
  {
    reporter: ({ errors }) => {
      const names = Object.keys(errors);
      if (names.length) throw new Error(`Invalid environment variables: ${names.join(", ")}`);
    },
  },
);

if (serverEnv.COVE_NETWORK !== "regtest" && !serverEnv.COVE_BITCOIN_RPC_URL) {
  throw new Error("COVE_BITCOIN_RPC_URL is required outside regtest");
}

if (serverEnv.COVE_NETWORK === "mainnet") {
  for (const [name, value] of [
    ["COVE_GUARDIAN_ENDPOINT", serverEnv.COVE_GUARDIAN_ENDPOINT],
    ["COVE_GUARDIAN_AUTH_TOKEN", serverEnv.COVE_GUARDIAN_AUTH_TOKEN],
    ["COVE_FEE_ADDRESS", serverEnv.COVE_FEE_ADDRESS],
  ]) {
    if (!value) throw new Error(`${name} is required on mainnet`);
  }
}
