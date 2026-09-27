import * as Sentry from "@sentry/nextjs";
import { clientEnv } from "./lib/client-env";

Sentry.init({
  dsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
  environment: clientEnv.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
