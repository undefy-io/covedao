import { describe, expect, it } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";

/**
 * P0-6: `finalizeAndBroadcastFill` was the only mutation with no server-side
 * guard. It must fail closed on a disabled config before touching any DB or
 * provider state.
 */

const dummySigner = {
  signMint: async () => ({ ok: false, reason: "n/a", detail: "n/a", audit: null }),
  signRedeem: async () => ({ ok: false, reason: "n/a", detail: "n/a", audit: null }),
  health: async () => ({ reachable: true }),
} as GuardianTransitionSigner;

function serviceWith(overrides: Partial<ReturnType<typeof loadV3AppConfig>>): V3AppService {
  const base = loadV3AppConfig({ COVE_NETWORK: "regtest" }); // regtest defaults
  const config = { ...base, ...overrides };
  return new V3AppService({} as never, {} as never, config, dummySigner);
}

describe("P0-6 finalizeAndBroadcastFill guards", () => {
  it("rejects on a disabled config", async () => {
    const app = serviceWith({ enabled: false });
    await expect(app.finalizeAndBroadcastFill("cd".repeat(16))).rejects.toThrow(/APP_DISABLED/);
  });

  it("blocks market mutations while mainnet is disarmed", async () => {
    const app = serviceWith({ network: "mainnet", mainnetProfileValid: true, mainnetMutationsArmed: false });
    expect(() => app.reserveListing({} as never)).toThrow(/mainnet mutations are not armed/);
    expect(() => app.buildFillPsbt("fill", {})).toThrow(/mainnet mutations are not armed/);
    expect(() => app.broadcastFill({} as never)).toThrow(/mainnet mutations are not armed/);
  });
});
