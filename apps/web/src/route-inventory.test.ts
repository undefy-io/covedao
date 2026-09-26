import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * V3 route inventory test (§99). Confirms every V3 API route referenced by the
 * frontend/build flow actually exists — a missing/typo'd route fails CI. Legacy
 * CRC routes must NOT exist on the production path.
 */
const REQUIRED_ROUTES = [
  "/api/v3/status",
  "/api/v3/tokens",
  "/api/v3/tokens/[tokenId]",
  "/api/v3/tokens/[tokenId]/activity",
  "/api/v3/tokens/[tokenId]/holders",
  "/api/v3/tokens/[tokenId]/buy/routes",
  "/api/v3/launch/prepare",
  "/api/v3/launch/build",
  "/api/v3/launch/submit",
  "/api/v3/backing/buy/quote",
  "/api/v3/backing/buy/quote-sats",
  "/api/v3/backing/buy/build",
  "/api/v3/backing/buy/submit",
  "/api/v3/backing/redeem/quote",
  "/api/v3/backing/redeem/build",
  "/api/v3/backing/redeem/submit",
  "/api/v3/transfer/build",
  "/api/v3/transfer/submit",
  "/api/v3/market/listings",
  "/api/v3/market/listings/prepare",
  "/api/v3/market/listings/[listingId]/cancel/prepare",
  "/api/v3/market/listings/[listingId]/cancel",
  "/api/v3/market/listings/[listingId]/reserve",
  "/api/v3/market/fills/[fillId]/build",
  "/api/v3/market/fills/[fillId]/buyer-signature",
  "/api/v3/market/fills/[fillId]/finalize",
  "/api/v3/market/fills/[fillId]",
  "/api/v3/wallet/[address]/portfolio",
  "/api/v3/tx/[txid]",
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
