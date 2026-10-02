import { defineConfig } from "vitest/config";

// The nested CRC core owns its independent tests and Docker lifecycle.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
