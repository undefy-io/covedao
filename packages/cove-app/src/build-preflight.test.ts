import { afterEach, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());
const script = "0014" + "11".repeat(20);
const input = {
  tokenId: "22".repeat(32), amountAtoms: 1000n * 100_000_000n,
  ticker: "TEST", nonceHex: "33".repeat(32),
  walletScript: script, recipientScript: script, walletAddress: null,
  metadata: { displayName: "Test", description: "" }, idempotencyKey: "preflight",
  funding: [{ txid: "44".repeat(32), vout: 0 }],
  quoteBinding: { stateHash: "55".repeat(32), backingOutpoint: { txid: "66".repeat(32), vout: 1 }, expiresAtHeight: null },
};
type Build = "buildLaunch" | "buildBackingBuy" | "buildRedeem" | "buildTransfer";
function fixture() {
  const external = vi.fn(async () => { throw new Error("unexpected external work"); });
  vi.stubGlobal("fetch", external);
  const db = { execute: async () => ({ rows: [{ generation: "1" }] }), select: () => ({ from: (table: unknown) => ({ where: async () =>
    table === schema.coveV3Cursor ? [{ height: 10n, blockHash: "77".repeat(32), stateRoot: "88".repeat(32), rebuilding: false }] : [],
  }) }) } as unknown as Database;
  const provider = new Proxy({}, { get: () => external }) as CoreRpcProvider;
  const signer = new Proxy({}, { get: () => external }) as GuardianTransitionSigner;
  const app = new V3AppService(db, provider, loadV3AppConfig({ COVE_NETWORK: "regtest" }), signer);
  return { app, external };
}
async function invoke(app: V3AppService, operation: Build, overrides: Record<string, unknown>) {
  return app[operation]({ ...input, ...overrides } as never);
}

describe("local transaction rejection before external requests", () => {
  it.each<Build>(["buildLaunch", "buildBackingBuy", "buildRedeem", "buildTransfer"])(
    "%s rejects malformed wallets before health checks", async (operation) => {
      const { app, external } = fixture();
      await expect(invoke(app, operation, { walletScript: "not-hex" })).rejects.toThrow("FUNDING_INPUT_INVALID");
      expect(external).not.toHaveBeenCalled();
    },
  );
  it.each<Build>(["buildLaunch", "buildBackingBuy", "buildRedeem", "buildTransfer"])(
    "%s rejects duplicate funding before health checks", async (operation) => {
      const { app, external } = fixture();
      await expect(invoke(app, operation, { funding: [input.funding[0], input.funding[0]] })).rejects.toThrow("duplicate");
      expect(external).not.toHaveBeenCalled();
    },
  );
  it.each<Build>(["buildBackingBuy", "buildRedeem", "buildTransfer"])(
    "%s rejects a zero amount and a missing token locally", async (operation) => {
      const { app, external } = fixture();
      await expect(invoke(app, operation, { amountAtoms: 0n })).rejects.toThrow("TOKEN_AMOUNT_INVALID");
      await expect(invoke(app, operation, {})).rejects.toThrow("TOKEN_NOT_FOUND");
      expect(external).not.toHaveBeenCalled();
    },
  );
  it("rejects non-lot redeem amounts without external work", async () => {
    const { app, external } = fixture();
    await expect(invoke(app, "buildRedeem", { amountAtoms: 1001n * 100_000_000n })).rejects.toThrow("TOKEN_AMOUNT_INVALID");
    expect(external).not.toHaveBeenCalled();
  });
  it("rejects bad metadata, nonce and quote bindings locally", async () => {
    const { app, external } = fixture();
    await expect(invoke(app, "buildLaunch", { metadata: { displayName: "x".repeat(81) } })).rejects.toThrow("METADATA_INVALID");
    await expect(invoke(app, "buildLaunch", { nonceHex: "xx" })).rejects.toThrow("nonce");
    await expect(invoke(app, "buildBackingBuy", { quoteBinding: null })).rejects.toThrow("QUOTE_STALE");
    expect(external).not.toHaveBeenCalled();
  });
  it("rejects missing fills at both app and market entry points locally", async () => {
    const { app, external } = fixture();
    await expect(app.finalizeAndBroadcastFill("missing")).rejects.toThrow("fill not found");
    await expect(app.market.buildFillPsbt("missing", 1000n)).rejects.toThrow("fill not found");
    await expect(app.market.finalizeP2PFill("missing")).rejects.toThrow("fill not found");
    expect(external).not.toHaveBeenCalled();
  });
  it("retains live validation for a structurally valid launch", async () => {
    const { app, external } = fixture();
    await expect(invoke(app, "buildLaunch", {})).rejects.toThrow("CORE_UNAVAILABLE");
    expect(external).toHaveBeenCalled();
  });
});
