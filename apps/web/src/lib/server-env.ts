import { bool, cleanEnv, str, url, makeValidator } from "envalid";
import { parseProtocolMode } from "./protocol-mode";

const budgetRate = makeValidator((value: string) => {
  const rate = Number(value);
  if (!Number.isSafeInteger(rate) || rate < 3 || rate > 300) throw new Error("RPC budget must be 3..300 requests per second");
  return rate;
});

/**
 * Validated on first use, not at import. `next build` imports every route to
 * collect page data, and a build has no database or RPC; checking here at
 * import made every build without the runtime env fail.
 */
function loadServerEnv() {
  const env = cleanEnv(
    {
      COVE_RPC_REQUESTS_PER_SECOND: process.env.COVE_RPC_REQUESTS_PER_SECOND,
      COVE_TRUSTED_CLIENT_IP_HEADER: process.env.COVE_TRUSTED_CLIENT_IP_HEADER,
      COVE_NETWORK: process.env.COVE_NETWORK,
      COVE_PROTOCOL_MODE: process.env.COVE_PROTOCOL_MODE,
      COVE_CRC_TRADING_ACTIVE: process.env.COVE_CRC_TRADING_ACTIVE,
      COVE_CRC_MARKET_TESTING_ENABLED: process.env.COVE_CRC_MARKET_TESTING_ENABLED,
      COVE_DATABASE_URL: process.env.COVE_DATABASE_URL || process.env.DATABASE_URL,
      COVE_BITCOIN_RPC_URL: process.env.COVE_BITCOIN_RPC_URL || undefined,
      COVE_BITCOIN_RPC_API_KEY: process.env.COVE_BITCOIN_RPC_API_KEY || undefined,
      COVE_BITCOIN_RPC_USER: process.env.COVE_BITCOIN_RPC_USER || undefined,
      COVE_BITCOIN_RPC_PASSWORD: process.env.COVE_BITCOIN_RPC_PASSWORD || undefined,
      COVE_GUARDIAN_ENDPOINT: process.env.COVE_GUARDIAN_ENDPOINT || undefined,
      COVE_GUARDIAN_AUTH_TOKEN: process.env.COVE_GUARDIAN_AUTH_TOKEN || undefined,
      COVE_FEE_ADDRESS: process.env.COVE_FEE_ADDRESS || undefined,
      COVE_TEST_ONLY_PROFILE_PATH: process.env.COVE_TEST_ONLY_PROFILE_PATH || undefined,
      COVE_V3_CANARY_ACTIVE: process.env.COVE_V3_CANARY_ACTIVE || undefined,
      SENTRY_DSN: process.env.SENTRY_DSN || undefined,
      SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT || undefined,
    },
    {
      COVE_RPC_REQUESTS_PER_SECOND: budgetRate({ default: process.env.COVE_NETWORK === "regtest" ? 90 : 3 }),
      COVE_TRUSTED_CLIENT_IP_HEADER: str({ choices: ["none", "cf-connecting-ip", "x-real-ip"], default: "none" }),
      COVE_NETWORK: str({ choices: ["regtest", "signet", "testnet", "mainnet"] }),
      COVE_PROTOCOL_MODE: makeValidator(parseProtocolMode)({ default: "legacy" }),
      COVE_CRC_TRADING_ACTIVE: bool({ default: false }),
      COVE_CRC_MARKET_TESTING_ENABLED: bool({ default: false }),
      COVE_DATABASE_URL: url(),
      COVE_BITCOIN_RPC_URL: url({ default: undefined }),
      COVE_BITCOIN_RPC_API_KEY: str({ default: undefined }),
      COVE_BITCOIN_RPC_USER: str({ default: undefined }),
      COVE_BITCOIN_RPC_PASSWORD: str({ default: undefined }),
      COVE_GUARDIAN_ENDPOINT: url({ default: undefined }),
      COVE_GUARDIAN_AUTH_TOKEN: str({ default: undefined }),
      COVE_FEE_ADDRESS: str({ default: undefined }),
      COVE_TEST_ONLY_PROFILE_PATH: str({ default: undefined }),
      COVE_V3_CANARY_ACTIVE: bool({ default: false }),
      SENTRY_DSN: url({ default: undefined }),
      SENTRY_ENVIRONMENT: str({ choices: ["dev", "staging", "prod"], default: "dev" }),
    },
    {
      reporter: ({ errors }) => {
        const names = Object.keys(errors);
        if (names.length) throw new Error(`Invalid environment variables: ${names.join(", ")}`);
      },
    },
  );

  if (env.COVE_NETWORK !== "regtest" && !env.COVE_BITCOIN_RPC_URL) {
    throw new Error("COVE_BITCOIN_RPC_URL is required outside regtest");
  }

  if (env.COVE_NETWORK === "mainnet") {
    for (const [name, value] of [
      ["COVE_GUARDIAN_ENDPOINT", env.COVE_GUARDIAN_ENDPOINT],
      ["COVE_GUARDIAN_AUTH_TOKEN", env.COVE_GUARDIAN_AUTH_TOKEN],
      ["COVE_FEE_ADDRESS", env.COVE_FEE_ADDRESS],
    ]) {
      if (!value) throw new Error(`${name} is required on mainnet`);
    }
  }
  return env;
}

let cached: ReturnType<typeof loadServerEnv> | undefined;

export const serverEnv = new Proxy({} as ReturnType<typeof loadServerEnv>, {
  get(_target, key) {
    cached ??= loadServerEnv();
    return cached[key as keyof typeof cached];
  },
});
