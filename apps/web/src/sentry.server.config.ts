import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "./lib/server-env";

Sentry.init({
  dsn: serverEnv.SENTRY_DSN,
  environment: serverEnv.SENTRY_ENVIRONMENT,
});
