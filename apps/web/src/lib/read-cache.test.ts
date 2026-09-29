import { expect, it, vi } from "vitest";
import { PublicReadCache } from "./read-cache";
it("deduplicates hot requests while separating networks, arguments, and generations", async () => {
  const cache = new PublicReadCache(),
    generation = vi.fn(async () => "1"),
    load = vi.fn(async () => new Response('{"ok":true}'));
  const replies = await Promise.all(
    Array.from({ length: 50 }, () => cache.read("signet:token:one", generation, 1000, load)),
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect(await replies[49]!.text()).toBe('{"ok":true}');
  await cache.read("regtest:token:one", generation, 1000, load);
  await cache.read("signet:token:two", generation, 1000, load);
  generation.mockResolvedValue("2");
  await cache.read("signet:token:one", generation, 1000, load);
  expect(load).toHaveBeenCalledTimes(4);
});
it("rejects an old in-flight result after a reorg and re-reads the new generation", async () => {
  let version = "1",
    resolve!: (r: Response) => void;
  const cache = new PublicReadCache(),
    load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(new Response("new"));
  const read = cache.read("token", async () => version, 1000, load);
  await Promise.resolve();
  await Promise.resolve();
  version = "2";
  resolve(new Response("old"));
  expect(await (await read).text()).toBe("new");
  expect(load).toHaveBeenCalledTimes(2);
  expect(await (await cache.read("token", async () => version, 1000, load)).text()).toBe("new");
  expect(load).toHaveBeenCalledTimes(2);
});
it("expires rolling windows and does not cache errors or private responses", async () => {
  let now = 0;
  const cache = new PublicReadCache(10, 10000, 4, () => now),
    generation = async () => "same";
  const load = vi.fn(async () => new Response(String(now)));
  await cache.read("market", generation, 1000, load);
  now = 1001;
  expect(await (await cache.read("market", generation, 1000, load)).text()).toBe("1001");
  for (const response of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("wallet", { headers: { "cache-control": "private" } }),
  ]) {
    const error = vi.fn(async () => response());
    await cache.read("error", generation, 1000, error);
    await cache.read("error", generation, 1000, error);
    expect(error).toHaveBeenCalledTimes(2);
  }
});
it("bounds memory and in-flight work under adversarial key variation", async () => {
  const cache = new PublicReadCache(3, 30, 2),
    generation = async () => "1";
  for (let i = 0; i < 100; i++)
    await cache.read(String(i), generation, 1000, async () => new Response("1234567890"));
  expect(cache.stats()).toMatchObject({ entries: 3, bytes: 30 });
  let finish!: (r: Response) => void;
  const first = cache.read(
    "blocked1",
    generation,
    1000,
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const second = cache.read("blocked2", generation, 1000, async () => {
    await first;
    return new Response("ok");
  });
  await Promise.resolve();
  await Promise.resolve();
  await expect(
    cache.read("overflow", generation, 1000, async () => new Response("ok")),
  ).rejects.toMatchObject({ name: "CapacityUnavailable" });
  finish(new Response("ok"));
  await Promise.all([first, second]);
});
