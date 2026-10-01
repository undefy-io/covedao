import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { parseCrc20Transaction } from "../src/index.js";

type Fixture = {
  kind: "deploy" | "mint" | "transfer";
  txid: string;
  hex: string;
  amountAtoms: string | null;
};

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/leaf-mainnet.json", import.meta.url)), "utf8",
)) as Fixture[];

function read(txid: string) {
  const fixture = fixtures.find((item) => item.txid === txid);
  if (!fixture) throw new Error(`missing Garden transaction ${txid}`);
  const tx = Transaction.fromHex(fixture.hex);
  expect(tx.getId()).toBe(txid);
  const outputs = tx.outs.map((output) => ({ valueSats: output.value, scriptHex: output.script.toString("hex") }));
  const parsed = parseCrc20Transaction(outputs);
  expect(parsed.status).toBe("valid");
  if (parsed.status !== "valid") throw new Error(`invalid Garden transaction ${txid}`);
  return { fixture, tx, outputs, marker: parsed.envelope };
}

describe("Garden mainnet wire goldens", () => {
  it("has an amountless mint marker directly before the recipient carrier", () => {
    const observed = read("17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4");
    expect(observed.marker.kind).toBe("mint");
    expect(observed.marker.markerVout).toBe(0);
    expect(observed.marker.payload).toEqual({ p: "crc-20", op: "mint", tick: "LEAF" });
    expect(observed.outputs[0]?.valueSats).toBe(0);
    expect(observed.outputs[1]?.valueSats).toBe(330);
    expect(observed.outputs[1]?.scriptHex.startsWith("5120")).toBe(true);
    expect(observed.outputs[2]?.valueSats).toBe(30_000);
    expect(observed.fixture.amountAtoms).toBe("108190476191");
  });

  it("binds the sale marker to the immediately following buyer carrier after seller payout", () => {
    const observed = read("532f22d0edcd848d28b81ddb6b089402860d01fda2ec1fdb9701ea13bb0a2dcd");
    expect(observed.marker.kind).toBe("transfer");
    if (observed.marker.kind !== "transfer") throw new Error("expected transfer");
    expect(observed.marker.markerVout).toBe(1);
    expect(observed.marker.recipientVout).toBe(2);
    expect(observed.marker.payload).toEqual({
      p: "crc-20", op: "transfer", tick: "LEAF", amt: "6800000000000",
    });
    expect(observed.outputs[0]?.valueSats).toBe(434_500);
    expect(observed.outputs[1]?.valueSats).toBe(0);
    expect(observed.outputs[2]?.valueSats).toBe(1_000);
    expect(observed.outputs[2]?.scriptHex.startsWith("5120")).toBe(true);
    expect(observed.fixture.amountAtoms).toBe("6800000000000");
  });

  it("uses four-field transfer markers in both observed marker positions", () => {
    const counts = { 0: 0, 1: 0 };
    for (const fixture of fixtures) {
      if (fixture.kind !== "transfer") continue;
      const observed = read(fixture.txid);
      if (observed.marker.kind !== "transfer") throw new Error("expected transfer");
      expect(Object.keys(observed.marker.payload)).toEqual(["p", "op", "tick", "amt"]);
      expect(observed.marker.amountAtoms).toBe(fixture.amountAtoms);
      expect(observed.marker.recipientVout).toBe(observed.marker.markerVout + 1);
      counts[observed.marker.markerVout as 0 | 1]++;
    }
    expect(counts).toEqual({ 0: 314, 1: 823 });
  });
});
