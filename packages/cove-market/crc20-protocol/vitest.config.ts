import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: new URL("./.vitest-cache", import.meta.url).pathname,
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
