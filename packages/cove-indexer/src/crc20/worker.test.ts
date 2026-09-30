import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCoveLedger } from "@crclaunch/crc20-ledger/cove-replay";
import { requiredBackingV1 } from "@crclaunch/crc20-curve";
import { applyCrcBlock, rollbackCrcBlock } from "./persistence.js";
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

  it("replays an unmarked spend of a v2 token outpoint as a burn and projects its undoable coin state", async () => {
    const parent = rawTx(null, [
      { scriptHex: protocol, valueSats: 500 }, { scriptHex: buyer, valueSats: 1000 },
    ]);
    const spend = rawTx({ txid: parent.txid, vout: 1 }, [{ scriptHex: creator, valueSats: 900 }]);
    const deploy = h("e");
    const key = `regtest:${deploy}`;
    const initial = createCoveLedger();
    initial.assets[key] = {
      ticker: "V2", status: "live", protocolVersion: 2,
      vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol,
      curve: { version: "cove-curve-v1", mintedAtoms: 100000000000n, vaultAtoms: 0n,
        circulatingAtoms: 100000000000n, vaultSats: 330n + requiredBackingV1(1000n),
        vaultAnchorSats: 330n, vaultOutpoint: `${h("f")}:1` },
      tokenUtxos: { [`${parent.txid}:1`]: { scriptHex: buyer, atoms: "100000000000" } },
      burnedAtoms: "0", balances: { [buyer]: "100000000000", [vault]: "0" },
    };
    const result = await replayCrcBlock(initial, {
      network: "regtest", height: 102, hash: h("a"), parentHash: h("0"), rawTxs: [spend.rawHex],
    }, [], { getRawTransaction: async () => parent.rawHex });
    expect(result.events).toMatchObject([{ txid: spend.txid, status: "invalid", valid: false }]);
    expect(result.state.assets[key]?.tokenUtxos).toEqual({});
    expect(result.state.assets[key]?.burnedAtoms).toBe("100000000000");
    const before = {
      assets: { [key]: { ticker: "V2", deployTxid: deploy, deployHeight: 100,
        deployBlockHash: h("b"), launchSaltHex: h("c"), creatorScriptHex: creator,
        protocolScriptHex: protocol, protocolVersion: 2 as const, burnedAtoms: "0" } },
      vaults: { [key]: { txid: h("f"), vout: 1, scriptHex: vault,
        btcSats: (330n + requiredBackingV1(1000n)).toString(), mintedAtoms: "100000000000",
        inventoryAtoms: "0", availability: "active" as const } },
      balances: { [key]: { [buyer]: "100000000000" } },
      tokenUtxos: { [key]: { [`${parent.txid}:1`]: { scriptHex: buyer, atoms: "100000000000",
        createdHeight: 101, createdBlockHash: h("b") } } },
    };
    const projected = projectionFromCoveLedger(result.state, before,
      { height: 102, hash: h("a"), parentHash: h("0") }, []);
    expect(projected.assets[key]?.burnedAtoms).toBe("100000000000");
    expect(projected.tokenUtxos?.[key]).toEqual({});
    expect(coveLedgerFromProjection(projected, result.events, "regtest", { [key]: 330n }).assets[key]?.burnedAtoms).toBe("100000000000");
  });

  it("burns a same-block v2 token spend disguised as an unregistered deploy and undoes it on reorg", async () => {
    const parent = rawTx(null, [{ scriptHex: buyer, valueSats: 1000 }]);
    const deploy = h("d");
    const key = `regtest:${deploy}`;
    const transfer = rawTx({ txid: parent.txid, vout: 0 }, [
      { scriptHex: marker({ p: "crc-20", op: "transfer", tick: "V2", amt: "100000000000", id: deploy, v: 2 }), valueSats: 0 },
      { scriptHex: creator, valueSats: 900 },
    ]);
    const burn = rawTx({ txid: transfer.txid, vout: 1 }, [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "FAKE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v2" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: buyer, valueSats: 470 },
    ]);
    const initial = createCoveLedger();
    initial.assets[key] = {
      ticker: "V2", status: "live", protocolVersion: 2,
      vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol,
      curve: { version: "cove-curve-v1", mintedAtoms: 100000000000n, vaultAtoms: 0n,
        circulatingAtoms: 100000000000n, vaultSats: 330n + requiredBackingV1(1000n),
        vaultAnchorSats: 330n, vaultOutpoint: `${h("f")}:1` },
      tokenUtxos: { [`${parent.txid}:0`]: { scriptHex: buyer, atoms: "100000000000" } },
      burnedAtoms: "0", balances: { [buyer]: "100000000000", [vault]: "0" },
    };
    const provider = { getRawTransaction: vi.fn(async () => parent.rawHex) };
    const replay = await replayCrcBlock(initial, {
      network: "regtest", height: 102, hash: h("a"), parentHash: h("0"), rawTxs: [transfer.rawHex, burn.rawHex],
    }, [], provider);
    expect(replay.events.map((event) => event.status)).toEqual(["applied", "invalid"]);
    expect(replay.events[1]?.operation).toBe("deploy");
    expect(provider.getRawTransaction).toHaveBeenCalledTimes(1);
    expect(replay.state.assets[key]?.tokenUtxos).toEqual({});
    expect(replay.state.assets[key]?.burnedAtoms).toBe("100000000000");
    const before = {
      assets: { [key]: { ticker: "V2", deployTxid: deploy, deployHeight: 100,
        deployBlockHash: h("b"), launchSaltHex: h("c"), creatorScriptHex: creator,
        protocolScriptHex: protocol, protocolVersion: 2 as const, burnedAtoms: "0" } },
      vaults: { [key]: { txid: h("f"), vout: 1, scriptHex: vault,
        btcSats: (330n + requiredBackingV1(1000n)).toString(), mintedAtoms: "100000000000",
        inventoryAtoms: "0", availability: "active" as const } },
      balances: { [key]: { [buyer]: "100000000000" } },
      tokenUtxos: { [key]: { [`${parent.txid}:0`]: { scriptHex: buyer, atoms: "100000000000",
        createdHeight: 101, createdBlockHash: h("b") } } },
    };
    const projected = projectionFromCoveLedger(replay.state, before,
      { height: 102, hash: h("a"), parentHash: h("b") }, []);
    const applied = applyCrcBlock(before, projected, "regtest");
    expect(rollbackCrcBlock(applied.state, applied.undo)).toEqual(before);
  });
});
