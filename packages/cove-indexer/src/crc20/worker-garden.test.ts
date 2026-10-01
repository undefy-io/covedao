import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCoveLedger } from "@crclaunch/crc20-ledger/cove-replay";
import { coveLedgerFromProjection, projectionFromCoveLedger, replayCrcBlock } from "./worker.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1"), creator = script("2"), protocol = script("3");
const seller = script("4"), buyer = script("5");
const marker = (payload: object) => bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload)),
]).toString("hex");

function transaction(inputs: readonly { txid: string; vout: number }[], outputs: readonly { scriptHex: string; valueSats: number }[]) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  if (!inputs.length) tx.addInput(Buffer.alloc(32), 0xffffffff);
  for (const input of inputs) tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout);
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { txid: tx.getId(), rawHex: tx.toHex() };
}

describe("Garden-shaped Cove block replay", () => {
  it("indexes amountless mint and its same-block transfer from exact token outpoints", async () => {
    const launchFunding = transaction([], [{ scriptHex: seller, valueSats: 10_000 }]);
    const deploy = transaction([{ txid: launchFunding.txid, vout: 0 }], [
      { scriptHex: marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v3" }), valueSats: 0 },
      { scriptHex: vault, valueSats: 330 }, { scriptHex: creator, valueSats: 1_000 },
      { scriptHex: protocol, valueSats: 7_000 }, { scriptHex: seller, valueSats: 1_670 },
    ]);
    const payment = transaction([], [{ scriptHex: seller, valueSats: 10_001 }]);
    const mint = transaction([{ txid: deploy.txid, vout: 1 }, { txid: payment.txid, vout: 0 }], [
      { scriptHex: marker({ p: "crc-20", op: "mint", tick: "COVE" }), valueSats: 0 },
      { scriptHex: seller, valueSats: 330 }, { scriptHex: vault, valueSats: 357 },
      { scriptHex: protocol, valueSats: 5_013 }, { scriptHex: creator, valueSats: 546 },
      { scriptHex: seller, valueSats: 3_085 },
    ]);
    const transfer = transaction([{ txid: mint.txid, vout: 1 }], [
      { scriptHex: marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }), valueSats: 0 },
      { scriptHex: buyer, valueSats: 330 },
    ]);
    const registration = { network: "regtest" as const, txid: deploy.txid,
      vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol,
      vaultAnchorSats: 330, launchSaltHex: "ab".repeat(32),
      rawSha256: createHash("sha256").update(Buffer.from(deploy.rawHex, "hex")).digest("hex") };
    const provider = { getRawTransaction: vi.fn(async () => { throw new Error("unexpected Core lookup"); }) };
    const block = { network: "regtest" as const, height: 100, hash: "aa".repeat(32), parentHash: "bb".repeat(32),
      rawTxs: [launchFunding.rawHex, deploy.rawHex, payment.rawHex, mint.rawHex, transfer.rawHex] };
    const replay = await replayCrcBlock(createCoveLedger(), block, [registration], provider);
    expect(provider.getRawTransaction).not.toHaveBeenCalled();
    expect(replay.events.map(({ operation, status, amountAtoms }) => ({ operation, status, amountAtoms }))).toEqual([
      { operation: "deploy", status: "applied", amountAtoms: null },
      { operation: "mint", status: "applied", amountAtoms: "100000000000" },
      { operation: "transfer", status: "applied", amountAtoms: "100000000000" },
    ]);
    const assetId = `regtest:${deploy.txid}`;
    expect(replay.state.assets[assetId]?.tokenUtxos?.[`${transfer.txid}:1`]).toEqual({ scriptHex: buyer, atoms: "100000000000" });
    const projection = projectionFromCoveLedger(replay.state, { assets: {}, vaults: {}, balances: {} }, block, [registration]);
    expect(coveLedgerFromProjection(projection, replay.events, "regtest", { [assetId]: 330n }).assets[assetId]?.balances[buyer]).toBe("100000000000");
  });
});
