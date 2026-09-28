import * as Sentry from "@sentry/nextjs";
import { cleanEnv, str, url } from "envalid";

const env = cleanEnv(
  {
    SENTRY_DSN: process.env.SENTRY_DSN || undefined,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT || undefined,
  },
  {
    SENTRY_DSN: url({ default: undefined }),
    SENTRY_ENVIRONMENT: str({ choices: ["dev", "staging", "prod"], default: "dev" }),
  },
);

Sentry.init({ dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT });
