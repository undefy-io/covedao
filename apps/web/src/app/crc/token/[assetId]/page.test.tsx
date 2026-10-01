import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/CrcTokenDetail", () => ({ CrcTokenDetail: () => null }));
import CrcTokenPage from "./page";

const assetId = `signet:${"a".repeat(64)}`;

describe("CRC token page", () => {
  it.each([assetId, encodeURIComponent(assetId)])("passes a canonical asset ID for %s", async (param) => {
    const page = await CrcTokenPage({ params: Promise.resolve({ assetId: param }) });
    expect(page.props.assetId).toBe(assetId);
  });
});
