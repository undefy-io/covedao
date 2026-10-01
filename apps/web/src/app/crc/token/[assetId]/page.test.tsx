import { describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));
import CrcTokenPage from "./page";

const assetId = `signet:${"a".repeat(64)}`;

describe("CRC token page", () => {
  it.each([assetId, encodeURIComponent(assetId)])("redirects a canonical asset ID for %s", async (param) => {
    await CrcTokenPage({ params: Promise.resolve({ assetId: param }) });
    expect(redirect).toHaveBeenCalledWith(`/token/${encodeURIComponent(assetId)}`);
  });
});
