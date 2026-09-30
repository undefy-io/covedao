import { afterEach, beforeEach, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({ status: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/v3-server", () => ({ getV3Services: () => ({
  config: { network: "signet" }, db: { execute: services.execute }, app: { status: services.status },
}) }));
vi.mock("@/lib/server-env", () => ({ serverEnv: { COVE_TRUSTED_CLIENT_IP_HEADER: "none" } }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
let get: (request: Request) => Promise<Response>;
const snapshot = (pendingRevision: string, reachable = true) => ({
  network: "signet", core: { reachable, height: "100", tip: "same-block" },
  observations: { pendingRevision, feesObservedAt: pendingRevision },
});
const request = (query = "") => new Request(`https://example.com/api/v3/status${query}`);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  services.status.mockResolvedValue(snapshot("1"));
  get = (await import("../app/api/v3/status/route")).GET;
});
afterEach(() => vi.useRealTimers());

it("serves 1,000 simultaneous status readers with one snapshot load and no per-reader SQL", async () => {
  const responses = await Promise.all(Array.from({ length: 1_000 }, (_, i) => get(request(`?tokenId=${i}`))));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(services.status).toHaveBeenCalledTimes(1);
  expect(services.execute).not.toHaveBeenCalled();
  expect(await responses[999]!.json()).toEqual({ ok: true, data: snapshot("1") });
  expect(responses[0]!.headers.get("cache-control")).toBe("no-store");
});

it("shares cached reads, then refreshes pending, fee and health changes without a new block", async () => {
  await get(request());
  services.status.mockResolvedValue(snapshot("2", false));
  vi.advanceTimersByTime(999);
  expect(await (await get(request())).json()).toEqual({ ok: true, data: snapshot("1") });
  vi.advanceTimersByTime(1);
  const responses = await Promise.all(Array.from({ length: 50 }, () => get(request())));
  expect(await responses[0]!.json()).toEqual({ ok: true, data: snapshot("2", false) });
  expect(services.status).toHaveBeenCalledTimes(2);
  expect(services.execute).not.toHaveBeenCalled();
});

it("does not cache a failed snapshot and recovers on the next read", async () => {
  const { AppError } = await import("@crclaunch/cove-app");
  services.status.mockRejectedValueOnce(new AppError("CORE_UNAVAILABLE", "temporary failure"));
  expect((await get(request())).status).toBe(503);
  expect((await get(request())).status).toBe(200);
  expect(services.status).toHaveBeenCalledTimes(2);
});

it("keeps shared database quota enforcement for mutations", async () => {
  services.execute.mockResolvedValue({ rows: [{ count: 1 }] });
  const { checkRateLimit } = await import("./rate-limit");
  expect(await checkRateLimit(request(), "build-buy")).toBeNull();
  expect(services.execute).toHaveBeenCalledTimes(1);
});

it("admits ordinary public reads without updating a shared database quota row", async () => {
  const { checkRateLimit } = await import("./rate-limit");
  const responses = await Promise.all(Array.from({ length: 100 }, () => checkRateLimit(request(), "read-token")));
  expect(responses.every((response) => response === null)).toBe(true);
  expect(services.execute).not.toHaveBeenCalled();
});
