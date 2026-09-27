import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveGuardianBoot } from "./boot.js";
const FIXTURE = resolve(
  process.cwd(),
  "../../packages/cove-mainnet/profiles.toml",
);
const BASE = {
  COVE_DATABASE_URL: "postgres://x",
  COVE_BITCOIN_RPC_URL: "http://127.0.0.1:18443",
  GUARDIAN_AUTH_TOKEN: "t",
};
describe("Guardian boot (env)", () => {
  it("requires COVE_NETWORK — GUARDIAN_NETWORK is not read and there is no default", () => {
    expect(() => resolveGuardianBoot({ ...BASE })).toThrow(
      /COVE_NETWORK is required/,
    );
    expect(() =>
      resolveGuardianBoot({ ...BASE, GUARDIAN_NETWORK: "regtest" }),
    ).toThrow(/COVE_NETWORK is required/);
  });
  it("requires the database, its own node and the auth token", () => {
    const env = {
      ...BASE,
      COVE_NETWORK: "regtest",
      COVE_TEST_ONLY_PROFILE_PATH: FIXTURE,
    };
    expect(() =>
      resolveGuardianBoot({ ...env, COVE_DATABASE_URL: "" }),
    ).toThrow(/COVE_DATABASE_URL/);
    expect(() =>
      resolveGuardianBoot({ ...env, COVE_BITCOIN_RPC_URL: "" }),
    ).toThrow(/COVE_BITCOIN_RPC_URL/);
    expect(() =>
      resolveGuardianBoot({ ...env, GUARDIAN_AUTH_TOKEN: "" }),
    ).toThrow(/GUARDIAN_AUTH_TOKEN/);
  });
  it("rejects invalid env and unsupported network profiles before service construction", () => {
    expect(() => resolveGuardianBoot({ ...BASE, COVE_NETWORK: "regtest", COVE_V3_CANARY_ACTIVE: "maybe" })).toThrow(/COVE_V3_CANARY_ACTIVE/);
    expect(() => resolveGuardianBoot({ ...BASE, COVE_NETWORK: "regtest", COVE_BITCOIN_RPC_URL: "bad-url" })).toThrow(/COVE_BITCOIN_RPC_URL/);
    expect(() => resolveGuardianBoot({ ...BASE, COVE_NETWORK: "regtest", GUARDIAN_TEST_KEY_HEX: "zz" })).toThrow(/GUARDIAN_TEST_KEY_HEX/);
    expect(() => resolveGuardianBoot({ ...BASE, COVE_NETWORK: "signet" })).toThrow(/profiles.toml has no signet profile/);
  });
  it("regtest CI: test profile + test key", () => {
    const boot = resolveGuardianBoot({
      ...BASE,
      COVE_NETWORK: "regtest",
      COVE_TEST_ONLY_PROFILE_PATH: FIXTURE,
      GUARDIAN_TEST_KEY_HEX: "42".repeat(32),
    });
    expect(boot.mainnetGuard).toBe(false);
    expect(boot.custody).toBe("test");
    expect(boot.profile.source).toBe("test-only");
    expect(boot.port).toBe(4391);
  });
  it("regtest selects the bundled regtest profile", () => {
    expect(() =>
      resolveGuardianBoot({
        ...BASE,
        COVE_NETWORK: "regtest",
        GUARDIAN_TEST_KEY_HEX: "42".repeat(32),
      }),
    ).not.toThrow();
  });
  it("mainnet: key required, test key and test profile refused", () => {
    const env = { ...BASE, COVE_NETWORK: "mainnet" };
    expect(() => resolveGuardianBoot(env)).toThrow(
      /GUARDIAN_KEY_HEX is required/,
    );
    expect(() =>
      resolveGuardianBoot({ ...env, GUARDIAN_TEST_KEY_HEX: "42".repeat(32) }),
    ).toThrow(/forbidden on mainnet/);
    expect(() =>
      resolveGuardianBoot({ ...env, GUARDIAN_KEY_HEX: "42".repeat(32) }),
    ).toThrow(/public test keys/);
    expect(() =>
      resolveGuardianBoot({
        ...env,
        GUARDIAN_KEY_HEX: "7a".repeat(32),
        COVE_TEST_ONLY_PROFILE_PATH: FIXTURE,
      }),
    ).toThrow(/refused on mainnet/);
    const boot = resolveGuardianBoot({
      ...env,
      GUARDIAN_KEY_HEX: "7a".repeat(32),
    });
    expect(boot.mainnetGuard).toBe(true);
    expect(boot.custody).toBe("env-key");
    expect(boot.profile.source).toBe("committed");
    expect(boot.ordUrl).toBe("https://ordinals.com");
    expect(boot.canaryActive).toBe(false);
    expect(
      resolveGuardianBoot({
        ...env,
        GUARDIAN_KEY_HEX: "7a".repeat(32),
        COVE_V3_CANARY_ACTIVE: "1",
      }).canaryActive,
    ).toBe(true);
  });
});
