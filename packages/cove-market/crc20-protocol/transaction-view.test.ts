import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as core from "./index.js";
const records = JSON.parse(
  readFileSync(
    new URL("../../../artifacts/crc-core-integration/api/mined-api.json", import.meta.url),
    "utf8",
  ),
);
const entry = records.transactions.find(
  (r: { session: { operation: string } }) => r.session.operation === "transfer",
);
const plan = core.decodeProtocolDto<core.Plan>(entry.session.trusted_json.corePlan);
const config = core.decodeProtocolDto<core.Config>(entry.session.trusted_json.coreConfig);
function view() {
  const ledger = core.emptyLedger(config);
  const deployTxid = entry.session.trusted_json.assetId.split(":")[1];
  ledger.assets[deployTxid] = {
    config,
    deployTxid,
    issuedAtoms: core.capAtoms,
    inventoryAtoms: 0n,
    burnedAtoms: 0n,
    vault: {
      txid: "aa".repeat(32),
      vout: 0,
      sats: core.carrierSats + core.backingSats(core.capAtoms),
      scriptHex: config.vaultScriptHex,
    },
  };
  for (const input of plan.inputs.filter((i) => i.atoms !== undefined))
    ledger.allocations[core.outpoint(input)] = {
      atoms: input.atoms!,
      sats: core.sats(input.sats),
      scriptHex: input.scriptHex,
      deployTxid,
    };
  return ledger;
}
const transaction = { rawHex: entry.rawHex, prevouts: plan.inputs };
test("transaction views reuse signed transfer rules without asserting unobserved holder totals", () => {
  const ledger = view();
  expect(() => core.validateFinalTransaction(plan, transaction, ledger)).toThrow(/conservation/);
  expect(core.validateFinalTransactionView(plan, transaction, ledger)).toBe(entry.txid);
  expect(Object.keys(ledger.seen)).toHaveLength(0);
});
test("transaction views still reject wrong allocations, spent inputs and changed signed economics", () => {
  const ledger = view(),
    token = plan.inputs.find((i) => i.atoms !== undefined)!;
  ledger.allocations[core.outpoint(token)]!.atoms++;
  expect(() => core.validateFinalTransactionView(plan, transaction, ledger)).toThrow();
  const spent = view();
  spent.spent[core.outpoint(token)] = true;
  expect(() => core.validateFinalTransactionView(plan, transaction, spent)).toThrow();
  expect(() =>
    core.validateFinalTransactionView(
      { ...plan, minerFeeSats: plan.minerFeeSats + 1n },
      transaction,
      view(),
    ),
  ).toThrow();
});

test("full-amount views bind the declared token owner and carrier sats even without token change", async () => {
  const bitcoin = await import("bitcoinjs-lib");
  const { aliceKey, aliceScript } = await import("./test-support/core.js");
  const { signNativeInput } = await import("./test-support/signing.js");
  const deployTxid = "11".repeat(32);
  const input = {
    txid: "22".repeat(32),
    vout: 0,
    sats: 1000n,
    atoms: 100n,
    scriptHex: aliceScript,
    deployTxid,
  };
  const funding = { txid: "33".repeat(32), vout: 0, sats: 20000n, scriptHex: aliceScript };
  const plan = core.buildTransfer({
    network: "regtest",
    deployTxid,
    ticker: "TEST",
    input,
    funding: [funding],
    amountAtoms: 100n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 400n,
  });
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  plan.inputs.forEach((i) => tx.addInput(Buffer.from(i.txid, "hex").reverse(), i.vout, 0xfffffffe));
  plan.outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, "hex"), Number(o.sats)));
  for (let index = 0; index < plan.inputs.length; index++)
    tx.setWitness(
      index,
      signNativeInput(
        core.parseRawTransaction(tx.toHex()),
        plan.inputs,
        index,
        aliceKey.privateKey!,
        1,
      ).map((w) => Buffer.from(w, "hex")),
    );
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: `0014${"44".repeat(20)}`,
    creatorScriptHex: aliceScript,
    protocolScriptHex: aliceScript,
  };
  const ledger = core.emptyLedger(config);
  ledger.assets[deployTxid] = {
    config,
    deployTxid,
    issuedAtoms: 10000000000n,
    inventoryAtoms: 0n,
    burnedAtoms: 0n,
    vault: { txid: "55".repeat(32), vout: 0, sats: 1003n, scriptHex: config.vaultScriptHex },
  };
  ledger.allocations[core.outpoint(input)] = {
    atoms: 100n,
    sats: 1000n,
    scriptHex: aliceScript,
    deployTxid,
  };
  const transaction = { rawHex: tx.toHex(), prevouts: plan.inputs };
  expect(core.validateFinalTransactionView(plan, transaction, ledger)).toBe(tx.getId());
  const wrongOwner = structuredClone(ledger);
  wrongOwner.allocations[core.outpoint(input)]!.scriptHex = config.vaultScriptHex;
  expect(() => core.validateFinalTransactionView(plan, transaction, wrongOwner)).toThrow();
  const wrongSats = structuredClone(ledger);
  wrongSats.allocations[core.outpoint(input)]!.sats++;
  expect(() => core.validateFinalTransactionView(plan, transaction, wrongSats)).toThrow();
});
