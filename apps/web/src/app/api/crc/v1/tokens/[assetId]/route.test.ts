import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cursor: vi.fn(), asset: vi.fn() }));
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("@/lib/crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcCursor: mocks.cursor, readCrcAsset: mocks.asset };
});

import { GET } from "./route";

beforeEach(() => {
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "a".repeat(64) });
  mocks.asset.mockReset().mockResolvedValue(null);
});

describe("CRC token detail route", () => {
  it("never resolves a cross-network or ticker-only asset", async () => {
    const txid = "b".repeat(64);
    for (const assetId of [`mainnet:${txid}`, "LEAF", txid]) {
      const response = await GET(new Request("http://localhost/api/crc/v1/tokens/x"), { params: Promise.resolve({ assetId }) });
      expect(response.status).toBe(404);
    }
    expect(mocks.asset).not.toHaveBeenCalled();
  });

  it("returns only the requested registered deployment", async () => {
    const txid = "b".repeat(64);
    mocks.asset.mockResolvedValue({ assetId: `signet:${txid}`, ticker: "SAME" });
    const response = await GET(new Request("http://localhost/api/crc/v1/tokens/x"), {
      params: Promise.resolve({ assetId: `signet:${txid}` }),
    });
    expect(response.status).toBe(200);
    expect(mocks.asset).toHaveBeenCalledWith({}, "signet", txid);
    expect((await response.json()).data.token.assetId).toBe(`signet:${txid}`);
  });
});
