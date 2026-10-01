import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cursor: vi.fn(),
  list: vi.fn(),
  hasIntent: vi.fn(),
}));
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("@/lib/crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcCursor: mocks.cursor, listCrcAssets: mocks.list,
    hasCrcLaunchIntent: mocks.hasIntent };
});

import { GET } from "./route";

beforeEach(() => {
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "a".repeat(64) });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.hasIntent.mockReset().mockResolvedValue(true);
});

describe("CRC catalog route", () => {
  it("returns indexed records and a keyset cursor without legacy services", async () => {
    const txid = "b".repeat(64);
    mocks.list.mockResolvedValue([
      { assetId: `signet:${txid}`, deployTxid: txid, deployHeight: "100" },
      { assetId: `signet:${"c".repeat(64)}`, deployTxid: "c".repeat(64), deployHeight: "99" },
    ]);
    const response = await GET(new Request("http://localhost/api/crc/v1/tokens?limit=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { network: "signet", nextCursor: `100:${txid}`, tokens: [{ assetId: `signet:${txid}` }] },
    });
    expect(mocks.list).toHaveBeenCalledWith({}, "signet", 2, undefined, undefined);
  });

  it("rejects malformed cursors and missing indexed tips", async () => {
    const invalid = await GET(new Request("http://localhost/api/crc/v1/tokens?before=LEAF"));
    expect(invalid.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.cursor.mockResolvedValue(null);
    const unavailable = await GET(new Request("http://localhost/api/crc/v1/tokens"));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("INDEXER_REBUILDING");
  });

  it("returns an empty catalog before the first authorized launch", async () => {
    mocks.cursor.mockResolvedValue(null);
    mocks.hasIntent.mockResolvedValue(false);
    const response = await GET(new Request("http://localhost/api/crc/v1/tokens?limit=24"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      network: "signet", indexedTip: null, tokens: [], nextCursor: null,
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("passes a bounded ticker search to the database", async () => {
    const response = await GET(new Request("http://localhost/api/crc/v1/tokens?search=TEST&limit=24"));
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({}, "signet", 25, undefined, "TEST");
    const invalid = await GET(new Request("http://localhost/api/crc/v1/tokens?search=%25"));
    expect(invalid.status).toBe(400);
  });
});
