import { expect, test, vi } from "vitest";
import { parseRawTransaction } from "./wire.js";

test("rejects impossible declared input/output/witness counts before allocating their arrays", () => {
  const input = "00".repeat(32) + "00000000" + "00" + "ffffffff";
  const samples = [
    "02000000fe00003d00",
    "0200000001" + input + "fe00003d00",
    "02000000000101" + input + "01010000000000000000fe00003d00",
  ];
  for (const raw of samples) {
    const arrays = vi.spyOn(Array, "from");
    try {
      expect(() => parseRawTransaction(raw)).toThrow();
      expect(arrays.mock.calls.every(([value]) => !("length" in Object(value)) || Number((value as { length: number }).length) <= raw.length / 2)).toBe(true);
    } finally { arrays.mockRestore(); }
  }
});
