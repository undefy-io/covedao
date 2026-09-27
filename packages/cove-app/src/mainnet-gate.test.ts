import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMainnetProfile } from "@crclaunch/cove-mainnet";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import { workerLockKey } from "./readiness-probes.js";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";

const FIXTURE = resolve(process.cwd(), "../../test/fixtures/mainnet-profile.json");
const signer = {
  signMint: async () => ({ ok: false, reason: "n/a", detail: "n/a", audit: null }),
  signRedeem: async () => ({ ok: false, reason: "n/a", detail: "n/a", audit: null }),
  health: async () => ({ reachable: true }),
} as GuardianTransitionSigner;

function mainnetApp(mainnetProfileValid: boolean | undefined, armed = true): V3AppService {
  const cfg = loadV3AppConfig(
    { COVE_NETWORK: "mainnet", COVE_BITCOIN_RPC_URL: "https://btc.example", COVE_V3_CANARY_ACTIVE: armed ? "1" : "0" },
    { testOnlyMainnetProfile: loadMainnetProfile(FIXTURE, { allowTestKeys: true }).profile },
  );
  return new V3AppService({} as never, {} as never, { ...cfg, mainnetProfileValid }, signer);
}

const build = (app: V3AppService) =>
  app.buildLaunch({
    ticker: "TST", nonceHex: "11".repeat(32), walletScript: "0014" + "22".repeat(20), walletAddress: null,
    funding: [], minerFeeSats: 1000n, metadata: { displayName: "T", description: "D" }, idempotencyKey: "k",
  });

describe("mainnet unlock (§6)", () => {
  it("a validated profile unlocks mainnet mutations (the gate no longer refuses mainnet)", async () => {
    // Past the network gate it fails on the fake DB/provider, not on MAINNET_DISABLED.
    await expect(build(mainnetApp(true))).rejects.not.toThrow(/MAINNET_DISABLED/);
  });

  it("without a validated committed profile, mainnet mutations stay refused", async () => {
    await expect(build(mainnetApp(undefined))).rejects.toThrow(/MAINNET_DISABLED/);
    await expect(build(mainnetApp(false))).rejects.toThrow(/MAINNET_DISABLED/);
  });

  it("requires the operator to arm mainnet mutations", async () => {
    await expect(build(mainnetApp(true, false))).rejects.toThrow(/mainnet mutations are not armed/);
  });

  it("loadV3AppConfig marks the profile validated only on mainnet", () => {
    expect(loadV3AppConfig({ COVE_NETWORK: "regtest" }).mainnetProfileValid).toBeUndefined();
  });

  it("each network has its own worker lock key", () => {
    const keys = ["regtest", "signet", "testnet", "mainnet"].map(workerLockKey);
    expect(new Set(keys).size).toBe(4);
    expect(() => workerLockKey("bogus")).toThrow();
  });
});
