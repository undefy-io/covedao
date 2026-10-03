import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * CRC route inventory test. Confirms every CRC API route referenced by the
 * frontend/build flow actually exists — a missing/typo'd route fails CI. Legacy
 * routes must NOT exist on the production path.
 */
const REQUIRED_ROUTES = [
  "/api/crc/v1/activity",
  "/api/crc/v1/backing/buy/build",
  "/api/crc/v1/backing/buy/quote",
  "/api/crc/v1/backing/buy/submit",
  "/api/crc/v1/backing/sell/build",
  "/api/crc/v1/backing/sell/quote",
  "/api/crc/v1/backing/sell/submit",
  "/api/crc/v1/fees",
  "/api/crc/v1/launch/build",
  "/api/crc/v1/launch/submit",
  "/api/crc/v1/market/[operation]",
  "/api/crc/v1/market/status",
  "/api/crc/v1/tokens",
  "/api/crc/v1/tokens/[assetId]",
  "/api/crc/v1/tokens/[assetId]/activity",
  "/api/crc/v1/tokens/[assetId]/candles",
  "/api/crc/v1/tokens/[assetId]/market",
  "/api/crc/v1/tokens/[assetId]/utxos",
  "/api/crc/v1/trading/status",
  "/api/crc/v1/wallet/[address]/balances",
  "/api/crc/v1/wallet/utxos"
];

const FORBIDDEN_LEGACY_ROUTES = [
  "/api/launch/build",
  "/api/mint/build",
  "/api/market/buy/build",
];

describe("route inventory", () => {
  for (const route of REQUIRED_ROUTES) {
    it(`${route} exists`, () => {
      const rel = route.startsWith("/") ? route.slice(1) : route;
      const file = fileURLToPath(new URL(`./app/${rel}/route.ts`, import.meta.url));
      expect(existsSync(file), `${file} should exist`).toBe(true);
    });
  }
  for (const route of FORBIDDEN_LEGACY_ROUTES) {
    it(`${route} is not on the production path`, () => {
      const rel = route.startsWith("/") ? route.slice(1) : route;
      const file = fileURLToPath(new URL(`./app/${rel}/route.ts`, import.meta.url));
      expect(existsSync(file), `${file} must not exist`).toBe(false);
    });
  }
});
