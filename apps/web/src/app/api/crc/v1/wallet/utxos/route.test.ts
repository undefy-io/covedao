import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@crclaunch/bitcoin", async (original) => ({
  ...await original<Record<string, unknown>>(),
  AddressUtxoCache: class { read = mocks.read; },
}));
vi.mock("@crclaunch/db", async (original) => ({
  ...await original<Record<string, unknown>>(), saveWalletFundingSnapshot: mocks.save,
}));
vi.mock("@/lib/crc-mutation", () => ({ getCrcMutationServices: () => ({ db: {}, provider: {}, config: { network: "signet", settings: { esploraUrl: "https://index.example" } } }) }));
vi.mock("@/lib/server-env", () => ({ serverEnv: { COVE_RPC_REQUESTS_PER_SECOND: 3 } }));
vi.mock("@/lib/crc-rate-limit", () => ({ checkCrcRateLimit: () => undefined }));
import { AddressLookupBusy } from "@crclaunch/bitcoin";
import { GET } from "./route";
const request = () => new Request("http://localhost/api/crc/v1/wallet/utxos?address=tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem");
beforeEach(() => { mocks.read.mockReset(); mocks.save.mockReset().mockResolvedValue(undefined); });

describe("CRC wallet funding observation", () => {
  it.each([new DOMException("upstream timeout", "TimeoutError"), new TypeError("fetch failed"), new Error("Esplora utxo HTTP 502"), new SyntaxError("invalid upstream JSON")])("returns retryable unavailable on lookup failure without replacing funding: %s", async (error) => {
    mocks.read.mockRejectedValue(error);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toEqual({ ok: false, error: { code: "ADDRESS_INDEX_UNAVAILABLE", message: "Wallet funding data is temporarily unavailable. Please retry shortly.", retryable: true } });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps the capacity error distinct and retryable", async () => {
    mocks.read.mockRejectedValue(new AddressLookupBusy());
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({ code: "ADDRESS_INDEX_BUSY", retryable: true });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("saves an exact successful observation after a transient lookup failure", async () => {
    mocks.read.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")).mockResolvedValueOnce([{ txid: "ab".repeat(32), vout: 4, valueSats: 1805775n, confirmations: 116 }]);
    await GET(request());
    const response = await GET(request());
    const data = (await response.json()).data;
    expect(response.status).toBe(200);
    expect(data.utxos).toEqual([{ txid: "ab".repeat(32), vout: 4, valueSats: "1805775", confirmations: 116 }]);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[3]).toEqual(data.utxos);
  });
});
