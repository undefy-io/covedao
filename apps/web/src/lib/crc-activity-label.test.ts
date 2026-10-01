import { describe, expect, it } from "vitest";
import { crcActivityLabel } from "./crc-activity-label";

describe("CRC activity labels", () => {
  it("shows curve trades by their indexed side without relabeling peer transfers", () => {
    expect(crcActivityLabel({ operation: "transfer", tradeSide: "sell", valid: true })).toBe("SELL");
    expect(crcActivityLabel({ operation: "transfer", tradeSide: "buy", valid: true })).toBe("BUY");
    expect(crcActivityLabel({ operation: "transfer", tradeSide: null, valid: true })).toBe("TRANSFER");
    expect(crcActivityLabel({ operation: "transfer", tradeSide: "sell", valid: false })).toBe("TRANSFER");
    expect(crcActivityLabel({ operation: "mint", tradeSide: "buy", valid: true })).toBe("MINT");
  });
});
