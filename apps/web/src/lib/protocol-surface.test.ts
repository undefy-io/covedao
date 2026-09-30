import { describe, expect, it } from "vitest";
import { protocolSurface } from "./protocol-surface";

describe("protocol page selection", () => {
  it("keeps V3 pages as the default", () => {
    expect(protocolSurface(undefined)).toBe("legacy");
    expect(protocolSurface("legacy")).toBe("legacy");
  });

  it("selects read-only CRC pages during cutover", () => {
    expect(protocolSurface("crc20")).toBe("crc-read-only");
  });
});
