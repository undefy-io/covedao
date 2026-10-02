import { test, expect } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import type { Plan, ChainTransaction } from "./types.js";
import * as p from "./index.ts";

const alice = "0014" + "11".repeat(20),
  bob = "0014" + "22".repeat(20),
  vault = "0014" + "33".repeat(20),
  fee = "0014" + "44".repeat(20);
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: vault,
  creatorScriptHex: alice,
  protocolScriptHex: fee,
};
const funding = [{ txid: "c".repeat(64), vout: 0, sats: 100000n, scriptHex: alice }];
const token = {
  txid: "b".repeat(64),
  vout: 1,
  atoms: 200000000000n,
  sats: 1000n,
  scriptHex: alice,
};
const state = {
  config,
  deployTxid: "a".repeat(64),
  issuedAtoms: 200000000000n,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: { txid: "d".repeat(64), vout: 2, sats: 1054n, scriptHex: vault },
};
function raw(plan: Plan): ChainTransaction {
  const tx = new Transaction();
  tx.version = 2;
  for (const input of plan.inputs)
    tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout, 0xfffffffe);
  for (const output of plan.outputs)
    tx.addOutput(Buffer.from(output.scriptHex, "hex"), Number(output.sats));
  return { rawHex: tx.toHex(), prevouts: plan.inputs };
}
function plans() {
  const args = {
    network: "regtest",
    deployTxid: state.deployTxid,
    ticker: "TEST",
    input: token,
    funding,
    amountAtoms: 50000000000n,
    sellerScriptHex: alice,
    recipientScriptHex: bob,
    changeScriptHex: alice,
    priceSats: 12347n,
    minerFeeSats: 1000n,
  };
  return [
    ["deploy", p.buildDeploy({ config, funding, changeScriptHex: alice })],
    [
      "mint",
      p.buildMint({
        state: { ...state, issuedAtoms: 0n, vault: { ...state.vault, sats: 1000n } },
        funding,
        recipientScriptHex: alice,
        amountAtoms: 200000000000n,
      }),
    ],
    ["transfer", p.buildTransfer(args)],
    [
      "curveSell",
      p.buildSell({
        state,
        inputs: [token],
        funding,
        recipientScriptHex: alice,
        amountAtoms: 100000000000n,
      }),
    ],
    [
      "inventoryBuy",
      p.buildInventoryBuy({
        state: { ...state, inventoryAtoms: 100000000000n, vault: { ...state.vault, sats: 1027n } },
        funding,
        recipientScriptHex: bob,
        amountAtoms: 100000000000n,
      }),
    ],
    ["listing", p.buildListing(args)],
    [
      "marketBuy",
      p.buildPurchase({
        network: "regtest",
        deployTxid: state.deployTxid,
        ticker: "TEST",
        listedInput: { ...token, atoms: 50000000000n },
        buyerFunding: funding,
        buyerScriptHex: bob,
        sellerScriptHex: alice,
        priceSats: 12347n,
        protocolScriptHex: fee,
      }),
    ],
    [
      "cancel",
      p.buildTransfer({
        ...args,
        input: { ...token, atoms: 50000000000n },
        recipientScriptHex: alice,
      }),
    ],
  ] as const;
}

test.each([
  "deploy",
  "mint",
  "transfer",
  "curveSell",
  "inventoryBuy",
  "listing",
  "marketBuy",
  "cancel",
] as const)(
  "SQLite compliance checks every input/output of %s and distinguishes intentional differences",
  async (action) => {
    const { checkGardenCompliance } = await import("./test-support/compliance.ts");
    const plan = plans().find(([name]) => name === action)![1];
    const report = checkGardenCompliance(plan, raw(plan), action);
    expect(report.sharedWirePassed).toBe(true);
    expect(report.exactGardenTransactionMatch).toBe(false);
    expect(report.inputs).toHaveLength(plan.inputs.length);
    expect(report.outputs).toHaveLength(plan.outputs.length);
    expect(report.minerFeeSats).toBe("1000");
    expect(report.archiveReference.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.unprovenClaims).toContain("Garden fee policy and issuance/ownership rules");
  },
);

test("compliance rejects missing prevouts, duplicate inputs, altered output value/script and corrupted marker bytes", async () => {
  const { checkGardenCompliance } = await import("./test-support/compliance.ts");
  const plan = plans().find(([name]) => name === "transfer")![1];
  const transaction = raw(plan);
  expect(() =>
    checkGardenCompliance(
      plan,
      { ...transaction, prevouts: transaction.prevouts.slice(1) },
      "transfer",
    ),
  ).toThrow();
  for (const change of [
    (tx: Transaction) => {
      tx.outs[1]!.value++;
    },
    (tx: Transaction) => {
      tx.outs[1]!.script = Buffer.from(alice, "hex");
    },
    (tx: Transaction) => {
      tx.outs[0]!.script = Buffer.from(
        p.markerScript('{"p":"crc-20","op":"transfer","tick":"TEST","amt":"1"}'),
        "hex",
      );
    },
  ]) {
    const tx = Transaction.fromHex(transaction.rawHex);
    change(tx);
    expect(() =>
      checkGardenCompliance(plan, { ...transaction, rawHex: tx.toHex() }, "transfer"),
    ).toThrow();
  }
  const duplicate = { ...plan, inputs: [plan.inputs[0]!, plan.inputs[0]!] };
  expect(() => checkGardenCompliance(duplicate, raw(duplicate), "transfer")).toThrow();
});
