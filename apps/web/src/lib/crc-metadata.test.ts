import { describe, expect, it } from "vitest";
import { parseCrcLaunchMetadata } from "./crc-metadata";

describe("CRC launch metadata", () => {
  it("keeps the original launch fields as bounded display metadata", () => {
    expect(parseCrcLaunchMetadata({
      displayName: " Frog Coin ", description: " A coin ", websiteUrl: "https://example.com",
      xUrl: "https://x.com/frog", imageUrl: "https://example.com/frog.png",
    }, "FROG")).toEqual({ displayName: "Frog Coin", description: "A coin",
      websiteUrl: "https://example.com", xUrl: "https://x.com/frog", imageUrl: "https://example.com/frog.png" });
    expect(parseCrcLaunchMetadata(undefined, "FROG").displayName).toBe("FROG");
  });

  it("rejects invalid links and oversized fields before creating a session", () => {
    expect(() => parseCrcLaunchMetadata({ displayName: "Frog", websiteUrl: "http://example.com" }, "FROG")).toThrow();
    expect(() => parseCrcLaunchMetadata({ displayName: "Frog", imageUrl: "javascript:alert(1)" }, "FROG")).toThrow();
    expect(() => parseCrcLaunchMetadata({ displayName: "X".repeat(81) }, "FROG")).toThrow();
    expect(() => parseCrcLaunchMetadata({ displayName: "Frog", xUrl: "https://a.com/" + "x".repeat(512) }, "FROG")).toThrow();
  });
});
