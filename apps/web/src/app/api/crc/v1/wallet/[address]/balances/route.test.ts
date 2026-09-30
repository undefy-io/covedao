import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cursor: vi.fn(), balances: vi.fn() }));
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("@/lib/crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcCursor: mocks.cursor, readCrcWalletBalances: mocks.balances };
});

import { GET } from "./route";

beforeEach(() => {
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "a".repeat(64) });
  mocks.balances.mockReset().mockResolvedValue([]);
});

describe("CRC wallet balances route", () => {
  it("converts a signet address to the owner script before querying", async () => {
    const address = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
    const response = await GET(new Request("http://localhost/api/crc/v1/wallet/x/balances"), { params: Promise.resolve({ address }) });
    expect(response.status).toBe(200);
    expect(mocks.balances).toHaveBeenCalledWith({}, "signet", "001444687443fd8bdab32947e445d3aa9114f01135d6", 101, undefined);
  });

  it("rejects a mainnet address without querying balances", async () => {
    const response = await GET(new Request("http://localhost/api/crc/v1/wallet/x/balances"), {
      params: Promise.resolve({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.balances).not.toHaveBeenCalled();
  });
});
