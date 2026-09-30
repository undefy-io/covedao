import { describe, expect, it } from "vitest";
import { assertLegacyProtocolMode, parseProtocolMode } from "./protocol-mode";
import { handleError } from "./api";

describe("web protocol mode", () => {
  it("keeps the current V3 API as the default", () => {
    expect(parseProtocolMode(undefined)).toBe("legacy");
    expect(assertLegacyProtocolMode("legacy")).toBeUndefined();
  });

  it("rejects unknown modes before the app starts", () => {
    expect(() => parseProtocolMode("crc-20")).toThrow(/COVE_PROTOCOL_MODE/);
    expect(() => parseProtocolMode("")).toThrow(/COVE_PROTOCOL_MODE/);
  });

  it("refuses all legacy V3 operations during CRC cutover", () => {
    expect(parseProtocolMode("crc20")).toBe("crc20");
    expect(() => assertLegacyProtocolMode("crc20")).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_MIGRATING" }),
    );
  });

  it("returns a retryable 503 rather than a misleading V3 response", async () => {
    let error: unknown;
    try { assertLegacyProtocolMode("crc20"); } catch (caught) { error = caught; }
    const response = handleError(error);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MIGRATING", retryable: true },
    });
  });
});
