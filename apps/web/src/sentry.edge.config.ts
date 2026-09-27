import * as Sentry from "@sentry/nextjs";
import { cleanEnv, str, url } from "envalid";

const env = cleanEnv(
  {
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  },
  {
    SENTRY_DSN: url(),
    SENTRY_ENVIRONMENT: str({ choices: ["dev", "staging", "prod"] }),
  },
);

Sentry.init({ dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT });
