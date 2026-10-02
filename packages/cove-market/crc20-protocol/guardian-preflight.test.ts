import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";
import type { Asset, Plan, ChainTransaction } from "./types.js";
const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const request = core.decodeProtocolDto<{ state: Asset; plan: Plan }>(
  JSON.parse(readFileSync(new URL("xverse-core-mint-request.json", root), "utf8")),
);
const response = JSON.parse(readFileSync(new URL("xverse-core-mint-response.json", root), "utf8"));
function fixture() {
  const ledger = core.emptyLedger(request.state.config);
  ledger.assets[request.state.deployTxid] = structuredClone(request.state);
  const raw = bitcoin.Transaction.fromHex(response.rawTransaction);
  raw.setWitness(0, []);
  return {
    ledger,
    transaction: {
      rawHex: raw.toHex(),
      prevouts: structuredClone(request.plan.inputs),
    } satisfies ChainTransaction,
  };
}
test("Guardian preflight reuses exact core transition with only its own signature absent", () => {
  const { ledger, transaction } = fixture();
  const result = core.validateGuardianTransaction(ledger, transaction);
  expect(result.kind).toBe("mint");
  expect(result.plan).toEqual(request.plan);
  expect(result.ledger.assets[request.state.deployTxid]!.issuedAtoms).toBe(10000000000n);
  expect(ledger.assets[request.state.deployTxid]).toEqual(request.state);
});
test("Guardian preflight rejects unsigned wallet, forged state, wrong prevouts and changed economics", () => {
  const { ledger, transaction } = fixture();
  const unsignedWallet = bitcoin.Transaction.fromHex(transaction.rawHex);
  unsignedWallet.setWitness(1, []);
  expect(() =>
    core.validateGuardianTransaction(ledger, { ...transaction, rawHex: unsignedWallet.toHex() }),
  ).toThrow();
  expect(() =>
    core.validateGuardianTransaction(ledger, {
      ...transaction,
      prevouts: transaction.prevouts.map((input, n) =>
        n === 1 ? { ...input, sats: core.sats(input.sats) + 1n } : input,
      ),
    }),
  ).toThrow();
  const changed = bitcoin.Transaction.fromHex(transaction.rawHex);
  changed.outs[3]!.value++;
  expect(() =>
    core.validateGuardianTransaction(ledger, { ...transaction, rawHex: changed.toHex() }),
  ).toThrow();
  const forged = structuredClone(ledger);
  forged.assets[request.state.deployTxid]!.issuedAtoms = 10000000000n;
  expect(() => core.validateGuardianTransaction(forged, transaction)).toThrow();
  const stale = structuredClone(ledger);
  stale.assets[request.state.deployTxid]!.vault.vout++;
  expect(() => core.validateGuardianTransaction(stale, transaction)).toThrow();
});
test("Guardian preflight cannot turn missing signatures on ordinary inputs into an authorization bypass", () => {
  const { ledger, transaction } = fixture();
  const downgraded = structuredClone(ledger);
  delete downgraded.assets[request.state.deployTxid]!.config.guardianCustody;
  expect(() => core.validateGuardianTransaction(downgraded, transaction)).toThrow(
    /custody|Guardian/,
  );
  const raw = bitcoin.Transaction.fromHex(response.rawTransaction);
  expect(() =>
    core.validateGuardianTransaction(ledger, { ...transaction, rawHex: raw.toHex() }),
  ).toThrow(/already|unsigned/);
});
