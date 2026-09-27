import { cleanEnv, str, url } from "envalid";

export const clientEnv = cleanEnv(
  {
    NEXT_PUBLIC_COVE_NETWORK: process.env.NEXT_PUBLIC_COVE_NETWORK,
    NEXT_PUBLIC_EXPLORER_URL: process.env.NEXT_PUBLIC_EXPLORER_URL || undefined,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  },
  {
    NEXT_PUBLIC_COVE_NETWORK: str({ choices: ["regtest", "signet", "testnet", "mainnet"] }),
    NEXT_PUBLIC_EXPLORER_URL: url({ default: undefined }),
    NEXT_PUBLIC_SENTRY_DSN: url(),
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: str({ choices: ["dev", "staging", "prod"] }),
  },
);
