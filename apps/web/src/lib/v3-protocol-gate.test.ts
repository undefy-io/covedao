import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("legacy V3 service gate", () => {
  it("blocks V3 even when services were previously initialized", async () => {
    vi.stubEnv("COVE_NETWORK", "regtest");
    vi.stubEnv("COVE_DATABASE_URL", "postgres://localhost:5432/cove_test");
    vi.stubEnv("COVE_PROTOCOL_MODE", "crc20");
    const { getV3Services } = await import("./v3-server");
    const globals = globalThis as typeof globalThis & { __coveV3Services?: unknown };
    const prior = globals.__coveV3Services;
    globals.__coveV3Services = { app: {} };
    try {
      expect(() => getV3Services()).toThrowError(
        expect.objectContaining({ code: "PROTOCOL_MIGRATING" }),
      );
    } finally {
      globals.__coveV3Services = prior;
    }
  });
});
