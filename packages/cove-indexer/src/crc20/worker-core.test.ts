import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import * as worker from "./worker.js";
import type { Asset } from "@crclaunch/crc20-protocol";
const root = new URL(
  "../../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const fixture = core.decodeProtocolDto<any>(read("xverse-core-mint-request.json"));
const response = read("xverse-core-mint-response.json");
const asset = fixture.state as Asset;
function seeded() {
  const state = core.emptyLedger(asset.config);
  state.assets[asset.deployTxid] = asset;
  return state;
}
const rawBlock = {
  network: "signet",
  height: 1,
  hash: "a".repeat(64),
  parentHash: "b".repeat(64),
  rawTxs: [response.rawTransaction],
  timestamp: 1700000000,
};
test("observation adapter reaches actual provider for parents before committing a core block", async () => {
  const provider = {
    getRawTransaction: vi.fn().mockRejectedValue(new Error("parent RPC unavailable")),
  };
  const before = seeded();
  await expect(worker.observeCrcBlock(before, rawBlock, {}, provider)).rejects.toThrow(
    /unavailable/,
  );
  expect(provider.getRawTransaction).toHaveBeenCalled();
  expect(before.tip).toBeUndefined();
});
test("unrelated/external transactions are observed without parent RPC and excluded by core", async () => {
  const provider = { getRawTransaction: vi.fn().mockRejectedValue(new Error("unexpected RPC")) };
  const before = core.emptyLedger(asset.config);
  const observed = await worker.observeCrcBlock(before, rawBlock, {}, provider);
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
  expect(observed.transactions[0]!.prevouts).toEqual([]);
  expect(core.applyConfirmedBlock(before, observed).assets).toEqual({});
});
test("raw transaction id list mismatch refuses before provider work", async () => {
  const provider = { getRawTransaction: vi.fn() };
  await expect(
    worker.observeCrcBlock(seeded(), { ...rawBlock, txids: ["0".repeat(64)] }, {}, provider),
  ).rejects.toThrow(/transaction/i);
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
});
