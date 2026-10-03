import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
const root = new URL("../../../../", import.meta.url);

test("the application has one CRC implementation and no legacy route selection", () => {
  for (const packageName of ["crc20-base", "crc20-curve", "crc20-ledger", "crc20-transactions"])
    expect(existsSync(new URL(`packages/${packageName}/package.json`, root)), packageName).toBe(false);
  expect(existsSync(new URL("apps/web/src/app/api/v3", root))).toBe(false);
  expect(existsSync(new URL("apps/web/src/components/legacy-pages", root))).toBe(false);
  for (const path of ["apps/web/src/app/layout.tsx", "apps/web/src/app/page.tsx", "apps/web/src/app/token/[tokenId]/page.tsx", "apps/web/src/components/WalletProvider.tsx", "apps/web/src/lib/server-env.ts"])
    expect(readFileSync(new URL(path, root), "utf8"), path).not.toMatch(/protocolSurface|protocolMode|COVE_PROTOCOL_MODE|\/api\/v3/);
});

test("default runtime and E2E entrypoints select the core CRC path", () => {
  const worker = JSON.parse(readFileSync(new URL("apps/worker/package.json", root), "utf8"));
  expect(worker.scripts.start).toBe("tsx src/crc.ts");
  expect(worker.scripts.dev).toBe("tsx watch src/crc.ts");
  for (const path of ["docker-compose.yml", "apps/worker/src/crc-health.ts", "apps/web/playwright.config.ts"])
    expect(readFileSync(new URL(path, root), "utf8"), path).not.toMatch(/\/api\/v3|cove_v3_|tests\/global-setup/);
  expect(existsSync(new URL(".github/workflows/cove-v3-product.yml", root))).toBe(false);
  expect(existsSync(new URL("apps/web/tests/global-setup.ts", root))).toBe(false);
});

test("regtest development bootstraps migrations and enables the coordinated CRC services", () => {
  const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
  expect(scripts["dev:db"]).toContain("drizzle-kit migrate");
  expect(readFileSync(new URL(".env.example", root), "utf8")).toContain("COVE_CRC_WORKER_ENABLED=true");
  const compose = readFileSync(new URL("docker-compose.yml", root), "utf8");
  for (const flag of ["COVE_CRC_SIGNING_ACTIVE", "COVE_CRC_TRADING_ACTIVE", "COVE_GUARDIAN_ENDPOINT", "COVE_GUARDIAN_AUTH_TOKEN"])
    expect(compose).toContain(flag);
});

test("obsolete executable web probes are retired", () => {
  for (const path of ["scripts/mempool-chain-proof.mjs", "scripts/testing/release-read-load.mjs"])
    expect(existsSync(new URL(path, root)), path).toBe(false);
  const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
  expect(scripts["cove:mempool-chain-proof"]).toBeUndefined();
});

test("fresh app images build the authoritative core whose dist is excluded from context", () => {
  for (const path of ["Dockerfile.dev", "Dockerfile.prod"])
    expect(readFileSync(new URL(path, root), "utf8"), path).toContain("pnpm --filter @crclaunch/crc20-protocol build");
});

test("fresh host and direct CI entrypoints build the core before importing it", () => {
  const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
  for (const name of ["dev", "dev:web", "dev:worker"]) expect(scripts[name]).toContain("pnpm build:crc-runtime &&");
  expect(scripts["build:crc-runtime"]).toContain("pnpm --filter @crclaunch/crc20-protocol build && pnpm --filter @crclaunch/crc20-adapters build");
  expect(readFileSync(new URL(".github/workflows/crc-product.yml", root), "utf8")).toContain("pnpm build:crc-runtime");
});
