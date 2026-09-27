import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 7 product E2E. The V3 worker + Next.js web app are started by the CI
 * workflow (they need Core/Postgres/Simplicity); Playwright only drives the
 * browser against http://localhost:3100. No webServer here — the harness owns
 * the runtime.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
});
