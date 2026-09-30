import { describe, expect, it } from "vitest";
import { POST } from "./route";
import { GET } from "../status/route";

describe("CRC market settlement gate", () => {
  it("fails closed for every market mutation without touching DB or Core", async () => {
    for (const operation of ["listings", "reserve", "buyer-sign", "seller-sign", "broadcast", "cancel", "withdraw"]) {
      const response = await POST();
      const body = await response.json();
      expect(operation).toBeTruthy();
      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CRC_MARKET_DISABLED");
    }
  });

  it("reports the market inactive", async () => {
    const response = await GET();
    expect((await response.json()).data.active).toBe(false);
  });
});
