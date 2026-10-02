import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests-crc-core", timeout: 90_000, fullyParallel: false, workers: 1, retries: 0,
  reporter: [["list"]], use: { baseURL: process.env.CRC_CORE_UI_URL ?? "http://127.0.0.1:3118" },
  projects: [ { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } } ],
});
