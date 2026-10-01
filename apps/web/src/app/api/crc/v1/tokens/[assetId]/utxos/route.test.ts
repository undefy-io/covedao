import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ asset: vi.fn(), cursor: vi.fn(), utxos: vi.fn() }));
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("@/lib/crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcAsset: mocks.asset, readCrcCursor: mocks.cursor, readCrcTokenUtxos: mocks.utxos };
});

import { GET } from "./route";

const txid = "a".repeat(64);
const address = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const req = (assetId = `signet:${txid}`) => new Request(`http://localhost/api/crc/v1/tokens/${assetId}/utxos?address=${address}`);
const params = (assetId = `signet:${txid}`) => ({ params: Promise.resolve({ assetId }) });

beforeEach(() => {
  mocks.asset.mockReset().mockResolvedValue({ assetId: `signet:${txid}`, protocolVersion: 3 });
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "b".repeat(64) });
  mocks.utxos.mockReset().mockResolvedValue([{ txid: "c".repeat(64), vout: 1, atoms: "100000000000" }]);
});

describe("CRC indexed token output route", () => {
  it("returns only exact network-scoped indexed coins", async () => {
    const response = await GET(req(), params());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      assetId: `signet:${txid}`, utxos: [{ txid: "c".repeat(64), vout: 1, atoms: "100000000000" }],
      truncated: false,
    });
    expect(mocks.utxos).toHaveBeenCalledWith({}, "signet", txid, expect.any(String), 101);
  });

  it("rejects asset IDs from another network", async () => {
    const assetId = `mainnet:${txid}`;
    const response = await GET(req(assetId), params(assetId));
    expect(response.status).toBe(404);
    expect(mocks.utxos).not.toHaveBeenCalled();
  });
});
