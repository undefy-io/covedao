import { beforeEach, expect, it, vi } from "vitest";
import { GET as transactionStatus } from "./app/api/v3/tx/[txid]/route";
import { GET as fillStatus } from "./app/api/v3/market/fills/[fillId]/route";

const services = vi.hoisted(() => ({ txStatus: vi.fn(), publicFillStatus: vi.fn(), getFill: vi.fn() }));
const rateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/v3-server", () => ({ getV3Services: () => ({ app: services }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: rateLimit }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("public transaction responses disable caching and validate txids before observation", async () => {
  services.txStatus.mockResolvedValue({ state: "unknown", mempool: null });
  const response = await transactionStatus(new Request("https://example.com"), { params: Promise.resolve({ txid: "ab".repeat(32) }) });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, data: { state: "unknown", mempool: null } });
  const invalid = await transactionStatus(new Request("https://example.com"), { params: Promise.resolve({ txid: "invalid" }) });
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("cache-control")).toBe("no-store");
  expect(services.txStatus).toHaveBeenCalledTimes(1);
});

it("fill responses use the public projection rather than the internal signing row", async () => {
  services.publicFillStatus.mockResolvedValue({ status: "BROADCAST", txid: "ab".repeat(32) });
  services.getFill.mockResolvedValue([{ psbtBase64: "private signing data" }]);
  const response = await fillStatus(new Request("https://example.com"), { params: Promise.resolve({ fillId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("private signing data");
  expect(services.publicFillStatus).toHaveBeenCalledTimes(1);
  expect(services.getFill).not.toHaveBeenCalled();
});

it("rate-limited status responses cannot be cached", async () => {
  rateLimit.mockReturnValue(new Response(null, { status: 429 }));
  const response = await transactionStatus(new Request("https://example.com"), { params: Promise.resolve({ txid: "ab".repeat(32) }) });
  expect(response.status).toBe(429);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(services.txStatus).not.toHaveBeenCalled();
});
