import * as Sentry from "@sentry/nextjs";

/**
 * Runs once when the Next.js server starts.
 *
 * This file is also compiled for the edge runtime, which has no Node built-ins,
 * so the Node-only check lives in instrumentation-node.ts and is imported only
 * behind the literal NEXT_RUNTIME test that lets the edge build drop it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    await import("./instrumentation-node");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
