import { describe, expect, it } from "vitest";
import { assertCrcMutationEnabled } from "./crc-mutation";

describe("CRC mutation activation", () => {
  it("stays disabled by default and under the legacy protocol", () => {
    expect(() => assertCrcMutationEnabled("legacy", false)).toThrow();
    expect(() => assertCrcMutationEnabled("crc20", false)).toThrow();
    expect(() => assertCrcMutationEnabled("legacy", true)).toThrow();
  });

  it("requires both explicit CRC mode and trading activation", () => {
    expect(assertCrcMutationEnabled("crc20", true)).toBeUndefined();
  });
});
