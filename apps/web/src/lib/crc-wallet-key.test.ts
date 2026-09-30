import { describe, expect, it } from "vitest";
import { normalizeCrcWalletPublicKey } from "./crc-wallet-key";

describe("CRC wallet public key metadata", () => {
  it("passes x-only Taproot keys and strips a compressed parity byte", () => {
    const script = "5120" + "2".repeat(64);
    expect(normalizeCrcWalletPublicKey(script, "3".repeat(64))).toBe("3".repeat(64));
    expect(normalizeCrcWalletPublicKey(script, "02" + "3".repeat(64))).toBe("3".repeat(64));
  });

  it("keeps compressed nested SegWit keys intact and rejects other shapes", () => {
    const script = "a914" + "2".repeat(40) + "87";
    expect(normalizeCrcWalletPublicKey(script, "03" + "4".repeat(64))).toBe("03" + "4".repeat(64));
    expect(() => normalizeCrcWalletPublicKey(script, "4".repeat(64))).toThrow();
  });
});
