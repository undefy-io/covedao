import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import sentry from "@sentry/nextjs/config";

const { withSentryConfig } = sentry;

// Load the monorepo-root .env so both web + worker share one configuration.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

// COVE_NETWORK is required: the browser bundle is built for one network.
const NETWORKS = ["regtest", "signet", "testnet", "mainnet"];
const network = process.env.COVE_NETWORK;
if (!network || !NETWORKS.includes(network)) {
  throw new Error(`COVE_NETWORK is required to build the web app (one of ${NETWORKS.join(", ")}); got "${network ?? ""}"`);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  outputFileTracingIncludes: {
    "/*": ["../../packages/cove-mainnet/profiles.toml"],
  },
  // Inlined into the browser bundle. The explorer is committed per network
  // (@crclaunch/config); the env override is honoured off mainnet only.
  env: {
    NEXT_PUBLIC_COVE_NETWORK: network,
    NEXT_PUBLIC_EXPLORER_URL: network === "mainnet" ? "" : (process.env.NEXT_PUBLIC_EXPLORER_URL ?? ""),
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN ?? "",
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT ?? "dev",
  },
  transpilePackages: [
    "@crclaunch/config",
    "@crclaunch/curve",
    "@crclaunch/db",
    "@crclaunch/protocol",
    "@crclaunch/wallets",
  ],
  serverExternalPackages: ["pg", "ioredis", "bullmq"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  webpack: (config) => {
    // Workspace packages use ESM-style `.js` import specifiers that resolve to
    // `.ts` sources; teach webpack to resolve them (TS/tsx already do natively).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default withSentryConfig(nextConfig, { silent: true, sourcemaps: { disable: true } });
