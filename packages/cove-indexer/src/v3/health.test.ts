import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { computeHealth, healthChainObservation } from "./health.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const cursor = { height: 10n, blockHash: "11".repeat(32), stateRoot: "22".repeat(32), rebuilding: false };
  const epoch = { generation: "1" };
  const db = {
    select: () => ({ from: () => ({ where: async () => [cursor] }) }),
    execute: async () => ({ rows: [epoch] }),
  } as unknown as Database;
  const getBlockchainInfo = vi.fn().mockResolvedValue({ chain: "regtest", blocks: 10, bestBlockHash: cursor.blockHash });
  const getBlockHash = vi.fn().mockResolvedValue(cursor.blockHash);
  const provider = { getBlockchainInfo, getBlockHash } as unknown as CoreRpcProvider;
  return { db, cursor, epoch, provider, getBlockchainInfo, getBlockHash, network: "regtest" };
}
describe("live health observation scope", () => {
  it("uses the live equal-height hash and detects same-height reorg", async () => {
    const f = fixture();
    expect((await computeHealth(f)).health).toBe("HEALTHY");
    expect(f.getBlockHash).not.toHaveBeenCalled();
    f.getBlockchainInfo.mockResolvedValue({ chain: "regtest", blocks: 10, bestBlockHash: "33".repeat(32) });
    expect((await computeHealth(f)).health).toBe("DIVERGED");
  });
  it("still resolves the indexed hash when behind", async () => {
    const f = fixture();
    f.getBlockchainInfo.mockResolvedValue({ chain: "regtest", blocks: 11, bestBlockHash: "33".repeat(32) });
    expect((await computeHealth(f)).health).toBe("HEALTHY");
    expect(f.getBlockHash).toHaveBeenCalledWith(10, undefined);
  });
  it("reuses only a trusted frozen report within the same unchanged phase", async () => {
    const f = fixture();
    const report = await computeHealth(f);
    expect(Object.isFrozen(report)).toBe(true);
    expect(await computeHealth({ ...f, observation: report })).toBe(report);
    expect(f.getBlockchainInfo).toHaveBeenCalledTimes(1);
    await computeHealth({ ...f, observation: { ...report } });
    expect(f.getBlockchainInfo).toHaveBeenCalledTimes(2);
  });
  it.each(["generation", "cursor", "delay", "provider", "network"])("revalidates after %s changes", async (change) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const f = fixture();
    const report = await computeHealth(f);
    if (change === "generation") f.epoch.generation = "2";
    if (change === "cursor") f.cursor.stateRoot = "44".repeat(32);
    if (change === "delay") await vi.advanceTimersByTimeAsync(501);
    if (change === "network") f.network = "signet";
    if (change === "provider") f.provider = { getBlockchainInfo: f.getBlockchainInfo, getBlockHash: f.getBlockHash } as unknown as CoreRpcProvider;
    await computeHealth({ ...f, observation: report });
    expect(f.getBlockchainInfo).toHaveBeenCalledTimes(2);
  });
  it("does not renew an observation after a slow cursor hash lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const f = fixture();
    f.getBlockchainInfo.mockResolvedValue({ chain: "regtest", blocks: 11, bestBlockHash: "33".repeat(32) });
    f.getBlockHash.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      return f.cursor.blockHash;
    });
    const report = await computeHealth(f);
    expect(healthChainObservation(report, f.provider)).toBeUndefined();
    await computeHealth({ ...f, observation: report });
    expect(f.getBlockchainInfo).toHaveBeenCalledTimes(2);
  });
  it("never converts a provider failure into cached success", async () => {
    const f = fixture();
    f.getBlockchainInfo.mockRejectedValue(new Error("offline"));
    const report = await computeHealth(f);
    expect((await computeHealth({ ...f, observation: report })).health).toBe("CORE_UNREACHABLE");
    expect(f.getBlockchainInfo).toHaveBeenCalledTimes(2);
  });
});
