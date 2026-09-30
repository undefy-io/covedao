import { beforeEach, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./v3-server", () => ({ getV3Services: () => ({
  config: { network: "signet" }, db: { execute: services.execute },
}) }));

beforeEach(() => {
  vi.resetModules();
  services.execute.mockReset();
  services.execute.mockResolvedValue({ rows: [{ chain_generation: "1", block_hash: "tip" }] });
});

it("shares the generation read across simultaneous public requests", async () => {
  const { cachePublic } = await import("./public-read");
  const load = vi.fn(async () => new Response('{"ok":true}'));
  const requests = Array.from({ length: 100 }, () =>
    cachePublic(new Request("https://example.com/api/v3/tokens"), "confirmed", 1000, load));
  const responses = await Promise.all(requests);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(services.execute).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
});
