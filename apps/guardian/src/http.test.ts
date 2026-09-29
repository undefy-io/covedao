import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { getRpcOperationSignal } from "@crclaunch/bitcoin";
import type { GuardianTransport } from "@crclaunch/cove-guardian/v3";
import { createGuardianHttpServer } from "./http.js";

const servers: ReturnType<typeof createGuardianHttpServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function start(sign: GuardianTransport["sign"]) {
  const server = createGuardianHttpServer({ authToken: "test", transport: { health: vi.fn(), sign } });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/sign`;
}
const failure = { ok: false as const, reason: "test", detail: "test" };
describe("Guardian request lifecycle", () => {
  it("normal completed POST does not abort the signing operation", async () => {
    const url = await start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getRpcOperationSignal()?.aborted).toBe(false);
      return failure;
    });
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(failure);
  });

  it("disconnect aborts in-flight work and later requests regain signing capacity", async () => {
    let aborted = 0;
    let entered = 0;
    const url = await start(async () => {
      entered++;
      if (entered > 2) return failure;
      const signal = getRpcOperationSignal()!;
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true }));
    });
    const clients = Array.from({ length: 2 }, () => {
      const client = request(url, { method: "POST", headers: { authorization: "Bearer test" } });
      client.on("error", () => {});
      client.end("{}");
      return client;
    });
    await vi.waitFor(() => expect(entered).toBe(2));
    clients.forEach((client) => client.destroy());
    await vi.waitFor(() => expect(aborted).toBe(2));
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" });
    expect(response.status).toBe(200);
  });

  it("an incomplete disconnected request never enters signing", async () => {
    const sign = vi.fn(async () => failure);
    const url = await start(sign);
    const client = request(url, { method: "POST", headers: { authorization: "Bearer test", "content-length": "1000" } });
    client.on("error", () => {});
    client.write("{");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sign).not.toHaveBeenCalled();
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" });
    expect(response.status).toBe(200);
  });
});
