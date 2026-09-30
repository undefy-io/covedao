import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { encodeMintV2, decodeV2, encodeDiscovery, serializeDiscovery } from "@crclaunch/cove-wire";
import { checkDiscoveryOutput, opReturnPayload } from "./discoveryOutput.js";

/**
 * The advisory crc-20 discovery envelope must be structurally incapable of
 * influencing state, and a contradicting payload must be refused a signature
 * (§D1). These exercise the Guardian-side check directly.
 */

const TOKEN_ID = Buffer.alloc(32, 0xab);
const WIRE = encodeMintV2({ tokenId: TOKEN_ID, amount: 1_000_000n, recipientVout: 2 });
const BINARY = decodeV2(WIRE);

const opReturn = (payload: Buffer) =>
  Buffer.concat([Buffer.from([0x6a, payload.length]), payload]);

/** vout 0 is the binary envelope; the rest stand in for vault/carrier/fee. */
function outputsWith(trailing?: Buffer, trailingValue = 0n) {
  const outs: { vout: number; script: Buffer; value: bigint }[] = [
    { vout: 0, script: opReturn(WIRE), value: 0n },
    { vout: 1, script: Buffer.alloc(34, 0x51), value: 10_000n },
    { vout: 2, script: Buffer.alloc(22, 0x00), value: 330n },
  ];
  if (trailing) outs.push({ vout: outs.length, script: trailing, value: trailingValue });
  return outs;
}

describe("Guardian discovery-output check (§D1)", () => {
  it("reports absent when there is no trailing OP_RETURN", () => {
    const r = checkDiscoveryOutput(outputsWith(), BINARY, "FROG");
    expect(r.present).toBe(false);
    expect(r.allowance).toBe(0);
  });

  it("accepts the canonical discovery envelope and allows exactly one extra output", () => {
    const payload = encodeDiscovery(BINARY, "FROG");
    const r = checkDiscoveryOutput(outputsWith(opReturn(payload)), BINARY, "FROG");
    expect(r.present).toBe(true);
    expect(r.agrees).toBe(true);
    expect(r.allowance).toBe(1);
  });

  it("REJECTS a discovery envelope that lies about the amount", () => {
    const lying = serializeDiscovery({ p: "crc-20", op: "mint", tick: "FROG", amt: "999999999" });
    const r = checkDiscoveryOutput(outputsWith(opReturn(lying)), BINARY, "FROG");
    expect(r.present).toBe(true);
    expect(r.agrees).toBe(false);
    expect(r.reason).toContain("contradicts");
  });

  it("REJECTS a discovery envelope naming a different ticker", () => {
    const wrong = encodeDiscovery(BINARY, "DOGE");
    const r = checkDiscoveryOutput(outputsWith(opReturn(wrong)), BINARY, "FROG");
    expect(r.agrees).toBe(false);
  });

  it("REJECTS a ticker-bearing envelope when the caller declared none", () => {
    const withTicker = encodeDiscovery(BINARY, "FROG");
    const r = checkDiscoveryOutput(outputsWith(opReturn(withTicker)), BINARY, undefined);
    expect(r.agrees).toBe(false);
  });

  it("REJECTS a discovery output carrying value", () => {
    const payload = encodeDiscovery(BINARY, "FROG");
    const r = checkDiscoveryOutput(outputsWith(opReturn(payload), 546n), BINARY, "FROG");
    expect(r.agrees).toBe(false);
    expect(r.reason).toContain("546");
  });

  it("does not treat a NON-crc-20 trailing OP_RETURN as a discovery envelope", () => {
    // Falls through to the ordinary unexpected-output checks instead of being
    // silently granted an extra-output allowance here.
    const r = checkDiscoveryOutput(outputsWith(opReturn(Buffer.from("hello", "utf8"))), BINARY, "FROG");
    expect(r.present).toBe(false);
    expect(r.allowance).toBe(0);
  });

  it("never grants an allowance for a bare binary envelope alone", () => {
    const only = [{ vout: 0, script: opReturn(WIRE), value: 0n }];
    expect(checkDiscoveryOutput(only, BINARY, "FROG").allowance).toBe(0);
  });

  describe("opReturnPayload", () => {
    it("extracts a direct-push payload", () => {
      expect(opReturnPayload(opReturn(Buffer.from("ab", "hex")))).toEqual(Buffer.from("ab", "hex"));
    });

    it("accepts valid PUSHDATA1 and rejects non-OP_RETURN or malformed pushes", () => {
      expect(opReturnPayload(Buffer.alloc(22, 0x00))).toBeNull();
      expect(opReturnPayload(Buffer.from("6a", "hex"))).toBeNull();
      expect(opReturnPayload(Buffer.from("6a05ab", "hex"))).toBeNull();
      expect(opReturnPayload(Buffer.from("6a4c02abcd", "hex"))).toEqual(Buffer.from("abcd", "hex"));
      expect(opReturnPayload(Buffer.from("6a4c03abcd", "hex"))).toBeNull();
    });
  });
});
