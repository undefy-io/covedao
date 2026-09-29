import { describe, expect, it } from "vitest";
import { checkRateLimit, clientIp, createRateLimiter } from "./rate-limit.js";

function req(ip?: string): Request {
  return { headers: { get: () => ip ?? null } } as unknown as Request;
}

describe("web rate limiting (§M4)", () => {
  it("ignores spoofed forwarding and trusts only an explicitly configured single-IP header", () => {
    expect(clientIp(req("1.2.3.4"))).toBe("local");
    expect(clientIp(req("1.2.3.4"), "cf-connecting-ip")).toBe("1.2.3.4");
    expect(clientIp(req("1.2.3.4, 10.0.0.1"), "cf-connecting-ip")).toBe("local");
    expect(clientIp(req())).toBe("local");
  });

  it("returns retryable 429 once the per-IP window is exceeded", async () => {
    const limiter = createRateLimiter();
    let response: Response | null = null;
    for (let i = 0; i < 121; i++) {
      response = await checkRateLimit(req("9.9.9.9"), "reserve", limiter);
      if (response) break;
    }
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("retry-after")).toBe("60");
  });
});
