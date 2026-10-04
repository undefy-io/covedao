import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as GET_OPERATION, POST } from "./route";
import { GET } from "../status/route";

const gate = vi.hoisted(() => ({ network: "mainnet", testingEnabled: false }));
const db = vi.hoisted(() => ({ execute: vi.fn(async () => ({ rows: [] })) }));
vi.mock("@/lib/server-env", () => ({
  serverEnv: {
    get COVE_NETWORK() {
      return gate.network;
    },
    get COVE_CRC_MARKET_TESTING_ENABLED() {
      return gate.testingEnabled;
    },
    COVE_CRC_TRADING_ACTIVE: true,
  },
}));
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db, network: gate.network }) }));
vi.mock("@/lib/crc-mutation", () => ({
  getCrcMutationServices: () => ({
    db,
    crcVaultConfig: { feeScriptHex: "0014" + "11".repeat(20) },
    provider: {},
    config: { network: gate.network },
  }),
}));

describe("CRC market settlement gate", () => {
  beforeEach(() => {
    gate.network = "mainnet";
    gate.testingEnabled = false;
    db.execute.mockClear();
  });

  it("fails closed for every market mutation without touching DB or Core", async () => {
    for (const operation of [
      "listings",
      "reserve",
      "buyer-sign",
      "seller-sign",
      "broadcast",
      "cancel",
      "withdraw",
    ]) {
      const response = await POST(
        new Request(`http://localhost/api/crc/v1/market/${operation}`, { method: "POST" }),
        { params: Promise.resolve({ operation }) },
      );
      const body = await response.json();
      expect(operation).toBeTruthy();
      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CRC_MARKET_DISABLED");
    }
  });

  it("reports the market inactive", async () => {
    const response = await GET();
    expect((await response.json()).data.active).toBe(false);
  });

  it("reports an opt-in signet market active while mainnet remains closed", async () => {
    gate.network = "signet";
    gate.testingEnabled = true;
    expect((await (await GET()).json()).data.active).toBe(true);
    gate.network = "mainnet";
    expect((await (await GET()).json()).data.active).toBe(false);
  });

  it("serves signet listings and funding checks through the market services", async () => {
    gate.network = "signet";
    gate.testingEnabled = true;
    const listings = await GET_OPERATION(
      new Request("http://localhost/api/crc/v1/market/listings"),
      { params: Promise.resolve({ operation: "listings" }) },
    );
    expect(listings.status).toBe(200);
    expect((await listings.json()).data).toEqual({ active: true, listings: [], truncated: false });
    const funding = await POST(
      new Request("http://localhost/api/crc/v1/market/funding-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outpoints: [{ txid: "a".repeat(64), vout: 0 }] }),
      }),
      { params: Promise.resolve({ operation: "funding-check" }) },
    );
    expect(funding.status).toBe(200);
    expect((await funding.json()).data.tokenFreeOutpoints).toEqual([
      { txid: "a".repeat(64), vout: 0 },
    ]);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});
