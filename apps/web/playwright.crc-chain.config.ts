import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests-crc-chain", timeout: 180_000, fullyParallel: false, workers: 1, retries: 0,
  reporter: [["list"]], use: { ...devices["Desktop Chrome"] },
});
