import { expect, test, vi } from "vitest";
const cursor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("@/lib/crc-read", () => ({ readCrcCursor: cursor }));
import { GET } from "./route";

test("status exposes only the authoritative CRC indexed tip, including an empty index", async () => {
  for (const indexedTip of [null, { height: "100", blockHash: "a".repeat(64) }]) {
    cursor.mockResolvedValue(indexedTip);
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ network: "signet", indexedTip });
    expect(cursor).toHaveBeenLastCalledWith({}, "signet");
  }
});
