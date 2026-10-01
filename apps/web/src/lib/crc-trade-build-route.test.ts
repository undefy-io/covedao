import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cursor: vi.fn(), asset: vi.fn(), balance: vi.fn(), tokenCoin: vi.fn(),
  getTxout: vi.fn(), build: vi.fn(),
}));
vi.mock("./crc-mutation", () => ({ getCrcMutationServices: () => ({
  db: {}, config: { network: "signet", maxMinerFeeSats: 20_000n },
  crcVaultConfig: { feeScriptHex: "0014" + "3".repeat(40) }, provider: { getTxout: mocks.getTxout },
}) }));
vi.mock("./crc-rate-limit", () => ({ checkCrcRateLimit: () => null }));
vi.mock("./crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcCursor: mocks.cursor, readCrcQuoteAsset: mocks.asset,
    readCrcBalance: mocks.balance, readCrcTokenUtxo: mocks.tokenCoin };
});
vi.mock("./crc-build", () => ({ buildCrcTradeSession: mocks.build }));

import { addressToScript } from "./address";
import { crcTradeBuildRoute } from "./crc-trade-build-route";

const txid = "a".repeat(64);
const sellerTxid = "b".repeat(64);
const walletAddress = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const walletScriptHex = addressToScript(walletAddress, "signet");
const body = {
  assetId: `signet:${txid}`, amountAtoms: "100000000000", walletAddress,
  ordinalsAddress: walletAddress, paymentFunding: [],
  sellerFunding: [{ txid: sellerTxid, vout: 1 }],
  minerFeeSats: "1000", idempotencyKey: "sell-test",
};
const request = (value: object) => new Request("http://localhost/api/crc/v1/backing/sell/build", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

beforeEach(() => {
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "c".repeat(64) });
  mocks.asset.mockReset().mockResolvedValue({ protocolVersion: 3, availability: "active" });
  mocks.balance.mockReset().mockResolvedValue(100000000000n);
  mocks.tokenCoin.mockReset().mockResolvedValue({ scriptHex: walletScriptHex, atoms: 100000000000n });
  mocks.getTxout.mockReset().mockResolvedValue({ confirmations: 2, scriptPubKeyHex: walletScriptHex, valueSats: 1000n });
  mocks.build.mockReset().mockResolvedValue({ sessionId: "session", psbtBase64: "psbt", intent: {} });
});

describe("CRC sell build authority", () => {
  it("rejects an ordinary same-script Bitcoin output without indexed token allocation", async () => {
    mocks.tokenCoin.mockResolvedValue(null);
    const response = await crcTradeBuildRoute(request(body), "sell");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("TOKEN_OUTPOINT_INVALID");
    expect(mocks.getTxout).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("passes only the exact indexed coin and confirmed Core prevout to the builder", async () => {
    const response = await crcTradeBuildRoute(request(body), "sell");
    expect(response.status).toBe(200);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      verifiedSellerInputs: [expect.objectContaining({
        txid: sellerTxid, vout: 1, tokenAtoms: 100000000000n,
        tokenDeploymentTxid: txid, scriptHex: walletScriptHex, valueSats: 1000,
      })],
    }));
  });
});
