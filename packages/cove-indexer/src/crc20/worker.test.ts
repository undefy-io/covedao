import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCoveLedger } from "@crclaunch/crc20-ledger/cove-replay";
import { coveLedgerFromProjection, projectionFromCoveLedger, replayCrcBlock } from "./worker.js";

const h = (byte: string) => byte.repeat(64);
const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1"), creator = script("2"), protocol = script("3"), buyer = script("4");
const rawHash = (rawHex: string) => createHash("sha256").update(Buffer.from(rawHex, "hex")).digest("hex");
function rawTx(input: { txid: string; vout: number } | null, outputs: { scriptHex: string; valueSats: number }[]) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(input ? Buffer.from(input.txid, "hex").reverse() : Buffer.alloc(32), input?.vout ?? 0xffffffff);
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { rawHex: tx.toHex(), txid: tx.getId() };
}
function rawTxMany(inputs: { txid: string; vout: number }[], outputs: { scriptHex: string; valueSats: number }[]) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const input of inputs) tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout);
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { rawHex: tx.toHex(), txid: tx.getId() };
}
function marker(payload: object) {
  return bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload))]).toString("hex");
}

describe("confirmed CRC block adapter", () => {
  it("uses earlier same-block raw transaction as verified parent and records registered deploy", async () => {
    const funding = rawTx(null, [{ scriptHex: buyer, valueSats: 10_000 }]);
    const deploy = rawTx({ txid: funding.txid, vout: 0 }, [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: creator, valueSats: 1000 }, { scriptHex: protocol, valueSats: 7000 }, { scriptHex: buyer, valueSats: 1670 },
    ]);
    const provider = { getRawTransaction: vi.fn() };
    const replay = await replayCrcBlock(createCoveLedger(), { network: "regtest", height: 100, hash: h("a"), parentHash: h("0"), rawTxs: [funding.rawHex, deploy.rawHex] }, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ], provider);
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
    expect(replay.state.assets[`regtest:${deploy.txid}`]?.status).toBe("live");
    expect(replay.events).toMatchObject([{ txid: deploy.txid, status: "applied", operation: "deploy" }]);
    const projected = projectionFromCoveLedger(replay.state, { assets: {}, vaults: {}, balances: {} }, { height: 100, hash: h("a"), parentHash: h("0") }, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ]);
    expect(projected.assets[`regtest:${deploy.txid}`]?.launchSaltHex).toBe("ab".repeat(32));
    expect(coveLedgerFromProjection(projected, replay.events, "regtest", { [`regtest:${deploy.txid}`]: 330n }).assets[`regtest:${deploy.txid}`]?.curve.vaultSats).toBe(330n);
    const corrupted = structuredClone(projected);
    corrupted.vaults[`regtest:${deploy.txid}`]!.btcSats = "331";
    expect(() => coveLedgerFromProjection(corrupted, replay.events, "regtest", { [`regtest:${deploy.txid}`]: 330n })).toThrow();
  });

  it("fails closed if an external parent cannot be fetched", async () => {
    const deploy = rawTx({ txid: h("b"), vout: 0 }, [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: creator, valueSats: 1000 }, { scriptHex: protocol, valueSats: 7000 },
    ]);
    await expect(replayCrcBlock(createCoveLedger(), { network: "regtest", height: 100, hash: h("a"), parentHash: h("0"), rawTxs: [deploy.rawHex] }, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ], { getRawTransaction: async () => { throw new Error("Core unavailable"); } })).rejects.toThrow("Core unavailable");
  });

  it("does not fetch parents for ordinary non-CRC transactions", async () => {
    const ordinary = rawTx({ txid: h("b"), vout: 0 }, [{ scriptHex: buyer, valueSats: 5000 }]);
    const provider = { getRawTransaction: vi.fn() };
    const result = await replayCrcBlock(createCoveLedger(), { network: "regtest", height: 100, hash: h("a"), parentHash: h("0"), rawTxs: [ordinary.rawHex] }, [], provider);
    expect(result.events).toEqual([]);
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
  });

  it("persists an invalid confirmed vault spend as unavailable instead of skipping the block", async () => {
    const funding = rawTx(null, [{ scriptHex: buyer, valueSats: 10_000 }]);
    const deploy = rawTx({ txid: funding.txid, vout: 0 }, [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: creator, valueSats: 1000 }, { scriptHex: protocol, valueSats: 7000 }, { scriptHex: buyer, valueSats: 1670 },
    ]);
    const escape = rawTx({ txid: deploy.txid, vout: 1 }, [{ scriptHex: buyer, valueSats: 330 }]);
    const block = { network: "regtest" as const, height: 100, hash: h("a"), parentHash: h("0"), rawTxs: [funding.rawHex, deploy.rawHex, escape.rawHex] };
    const replay = await replayCrcBlock(createCoveLedger(), block, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ], { getRawTransaction: async () => { throw new Error("unexpected RPC"); } });
    expect(replay.events.map((event) => event.status)).toEqual(["applied", "broken"]);
    const projection = projectionFromCoveLedger(replay.state, { assets: {}, vaults: {}, balances: {} }, block, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ]);
    expect(projection.vaults[`regtest:${deploy.txid}`]?.availability).toBe("unavailable");
    expect(coveLedgerFromProjection(projection, replay.events, "regtest", { [`regtest:${deploy.txid}`]: 330n }).assets[`regtest:${deploy.txid}`]?.status).toBe("broken");
  });

  it("tracks a replacement vault spent later in the same block", async () => {
    const launchFunding = rawTx(null, [{ scriptHex: buyer, valueSats: 10_001 }]);
    const deploy = rawTx({ txid: launchFunding.txid, vout: 0 }, [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: creator, valueSats: 1000 }, { scriptHex: protocol, valueSats: 7000 }, { scriptHex: buyer, valueSats: 1671 },
    ]);
    const buyFunding = rawTx(null, [{ scriptHex: buyer, valueSats: 10_000 }]);
    const buy = rawTxMany([{ txid: deploy.txid, vout: 1 }, { txid: buyFunding.txid, vout: 0 }], [
      { scriptHex: marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000", id: deploy.txid }), valueSats: 0 },
      { scriptHex: buyer, valueSats: 330 }, { scriptHex: vault, valueSats: 357 }, { scriptHex: protocol, valueSats: 5013 }, { scriptHex: creator, valueSats: 546 }, { scriptHex: buyer, valueSats: 3084 },
    ]);
    const escape = rawTx({ txid: buy.txid, vout: 2 }, [{ scriptHex: buyer, valueSats: 357 }]);
    const replay = await replayCrcBlock(createCoveLedger(), { network: "regtest", height: 100, hash: h("a"), parentHash: h("0"), rawTxs: [launchFunding.rawHex, deploy.rawHex, buyFunding.rawHex, buy.rawHex, escape.rawHex] }, [
      { network: "regtest", txid: deploy.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32), rawSha256: rawHash(deploy.rawHex) },
    ], { getRawTransaction: async () => { throw new Error("unexpected RPC"); } });
    expect(replay.events.map((event) => event.status)).toEqual(["applied", "applied", "broken"]);
    expect(replay.state.assets[`regtest:${deploy.txid}`]?.status).toBe("broken");
  });
});
