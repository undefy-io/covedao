import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";
import { aliceKey, aliceScript, bobKey, bobScript, protocolScript } from "./test-support/core.js";
const atoms = (n: number) => BigInt(n) * core.atomsPerToken;
const deployTxid = "aa".repeat(32);
const config: core.Config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
};
function fixture(issued = 400, inventory = 400, custody = false) {
  const selected = custody
    ? core.decodeProtocolDto<{ state: core.Asset }>(
        JSON.parse(
          readFileSync(
            new URL(
              "../../../artifacts/crc-core-integration/wallet-capabilities/xverse-core-mint-request.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ).state.config
    : config;
  const ledger = core.emptyLedger(selected);
  const asset: core.Asset = {
    config: selected,
    deployTxid,
    issuedAtoms: atoms(issued),
    inventoryAtoms: atoms(inventory),
    burnedAtoms: 0n,
    vault: {
      txid: "bb".repeat(32),
      vout: 2,
      sats: 1000n + core.backingSats(atoms(issued - inventory)),
      scriptHex: selected.vaultScriptHex,
    },
  };
  ledger.assets[deployTxid] = asset;
  if (issued > inventory)
    ledger.allocations[`${"dd".repeat(32)}:0`] = {
      deployTxid,
      scriptHex: aliceScript,
      sats: 1000n,
      atoms: atoms(issued - inventory),
    };
  const funding = [{ txid: "cc".repeat(32), vout: 0, sats: 100000n, scriptHex: bobScript }];
  return { ledger, asset, funding };
}
function signed(plan: core.Plan, skipVault = false, unsignedWallet = false): core.ChainTransaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const input of plan.inputs)
    tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout, 0xfffffffe);
  for (const output of plan.outputs)
    tx.addOutput(Buffer.from(output.scriptHex, "hex"), Number(output.sats));
  plan.inputs.forEach((input, index) => {
    if ((skipVault && index === 0) || (unsignedWallet && index > 0)) return;
    const key = input.scriptHex === aliceScript ? aliceKey : bobKey;
    const digest = tx.hashForWitnessV0(
      index,
      bitcoin.payments.p2pkh({ pubkey: key.publicKey }).output!,
      Number(input.sats),
      bitcoin.Transaction.SIGHASH_ALL,
    );
    tx.setWitness(index, [bitcoin.script.signature.encode(key.sign(digest), 1), key.publicKey]);
  });
  return { rawHex: tx.toHex(), prevouts: plan.inputs };
}
const block = (transaction: core.ChainTransaction): core.Block => ({
  hash: "11".repeat(32),
  parentHash: "00".repeat(32),
  height: 1,
  transactions: [transaction],
});

for (const [issued, inventory, requested, minted] of [
  [400, 400, 500, 100],
  [400, 400, 1000, 600],
  [1000, 400, 1000, 600],
  [99500, 400, 1500, 1100],
] as const) {
  test(`signed mixed ${requested}-token purchase replays full receipt and only ${minted} new tokens`, () => {
    const { ledger, asset, funding } = fixture(issued, inventory),
      before = structuredClone(ledger);
    const plan = core.buildBuy({
      state: asset,
      funding,
      amountAtoms: atoms(requested),
      recipientScriptHex: bobScript,
    });
    const transaction = signed(plan),
      next = core.applyBlock(ledger, block(transaction));
    const txid = core.parseRawTransaction(transaction.rawHex).txid;
    expect(core.validateFinalTransaction(plan, transaction, ledger)).toBe(txid);
    expect(next.assets[deployTxid]).toMatchObject({
      issuedAtoms: atoms(issued + minted),
      inventoryAtoms: 0n,
    });
    expect(next.allocations[`${txid}:1`]).toMatchObject({
      atoms: atoms(requested),
      scriptHex: bobScript,
    });
    const detailed = core.applyConfirmedBlockDetailed(ledger, block(transaction));
    expect(detailed.events[0]).toMatchObject({
      kind: "mint",
      valid: true,
      amountAtoms: atoms(requested),
      inventoryBuyAtoms: atoms(inventory),
      newlyMintedAtoms: atoms(minted),
    });
    expect(detailed.ledger).toEqual(next);
    expect(core.applyBlock(next, block(transaction))).toBe(next);
    expect(core.applyConfirmedBlockDetailed(detailed.ledger, block(transaction)).events).toEqual(
      [],
    );
    expect(core.rollbackBlock(next, block(transaction).hash)).toEqual(before);
    expect(ledger).toEqual(before);
  });
}

test("Guardian and input-scoped preflight accept the same mixed purchase without its own signature", () => {
  const { ledger, asset, funding } = fixture(1000, 400, true);
  const plan = core.buildBuy({
    state: asset,
    funding,
    amountAtoms: atoms(1000),
    recipientScriptHex: bobScript,
  });
  const transaction = signed(plan, true),
    before = structuredClone(ledger);
  const result = core.validateGuardianTransaction(ledger, transaction);
  expect(result).toMatchObject({
    kind: "mint",
    amountAtoms: atoms(1000),
    inventoryBuyAtoms: atoms(400),
    newlyMintedAtoms: atoms(600),
  });
  expect(result.ledger.assets[deployTxid]).toMatchObject({
    issuedAtoms: atoms(1600),
    inventoryAtoms: 0n,
  });
  const view = structuredClone(ledger);
  view.allocations = {};
  expect(core.validateGuardianTransactionView(view, transaction)).toMatchObject({
    amountAtoms: atoms(1000),
    newlyMintedAtoms: atoms(600),
  });
  expect(core.validateGuardianTransactionView(view, transaction)).not.toHaveProperty("ledger");
  expect(() => core.validateGuardianTransaction(ledger, signed(plan, true, true))).toThrow(
    /signature|SegWit/,
  );
  expect(ledger).toEqual(before);
});

for (const field of ["backing", "protocol fee", "creator fee", "recipient"] as const) {
  test(`mixed purchase rejects independently signed wrong ${field}`, () => {
    const { ledger, asset, funding } = fixture();
    const plan = core.buildBuy({
      state: asset,
      funding,
      amountAtoms: atoms(1000),
      recipientScriptHex: bobScript,
    });
    const changed = structuredClone(plan);
    if (field === "recipient") changed.outputs[1]!.scriptHex = aliceScript;
    else {
      const index = field === "backing" ? 2 : field === "protocol fee" ? 3 : 4;
      changed.outputs[index]!.sats++;
      changed.outputs.at(-1)!.sats--;
    }
    const transaction = signed(changed);
    expect(() => core.validateFinalTransaction(plan, transaction, ledger)).toThrow();
    if (field !== "recipient")
      expect(() => core.applyBlock(ledger, block(transaction))).toThrow(
        /transition|payment|outputs/,
      );
  });
}

test("mixed purchase rejects stale vaults, hidden token funding, duplicate spends and invalid signatures", () => {
  const { ledger, asset, funding } = fixture();
  const plan = core.buildBuy({
    state: asset,
    funding,
    amountAtoms: atoms(1000),
    recipientScriptHex: bobScript,
  });
  const transaction = signed(plan);
  const stale = structuredClone(ledger);
  stale.assets[deployTxid]!.vault.vout++;
  expect(() => core.validateFinalTransaction(plan, transaction, stale)).toThrow();
  const hidden = structuredClone(ledger);
  hidden.assets[deployTxid]!.issuedAtoms += atoms(100);
  hidden.allocations[core.outpoint(funding[0]!)] = {
    atoms: atoms(100),
    sats: funding[0]!.sats,
    scriptHex: bobScript,
    deployTxid,
  };
  hidden.assets[deployTxid]!.vault.sats = 1000n + core.backingSats(atoms(100));
  expect(() => core.validateFinalTransaction(plan, transaction, hidden)).toThrow();
  const invalid = bitcoin.Transaction.fromHex(transaction.rawHex);
  invalid.ins[1]!.witness[0]![10] ^= 1;
  expect(() => core.applyBlock(ledger, block({ ...transaction, rawHex: invalid.toHex() }))).toThrow(
    /signature|SegWit/,
  );
  const next = core.applyBlock(ledger, block(transaction));
  expect(() =>
    core.applyBlock(next, {
      ...block(transaction),
      hash: "22".repeat(32),
      parentHash: next.tip!.hash,
      height: 2,
    }),
  ).toThrow(/replay|spent/);
});

test("a mixed buy quote cannot misstate the receipt or inventory/new issuance breakdown", () => {
  const { ledger, asset, funding } = fixture();
  const plan = core.buildBuy({
    state: asset,
    funding,
    amountAtoms: atoms(1000),
    recipientScriptHex: bobScript,
  });
  const transaction = signed(plan);
  for (const field of ["receipt", "inventory", "issuance", "missing breakdown"] as const) {
    const claimed = structuredClone(plan);
    if (field === "receipt") claimed.outputs[1]!.atoms = atoms(600);
    if (field === "inventory") claimed.inventoryBuyAtoms = atoms(300);
    if (field === "issuance") claimed.newlyMintedAtoms = atoms(700);
    if (field === "missing breakdown") delete claimed.newlyMintedAtoms;
    expect(() => core.validateFinalTransaction(claimed, transaction, ledger)).toThrow(
      /amount|allocation|breakdown/,
    );
    expect(() => core.validateFinalTransactionView(claimed, transaction, ledger)).toThrow(
      /amount|allocation|breakdown/,
    );
  }
});

test("inventory-only purchases cannot use a mint marker to claim new issuance", () => {
  const { ledger, asset, funding } = fixture();
  for (const amount of [100, 400]) {
    const plan = core.buildBuy({
      state: asset,
      funding,
      amountAtoms: atoms(amount),
      recipientScriptHex: bobScript,
    });
    const changed = structuredClone(plan);
    changed.markerJson = core.mintMarker("TEST");
    changed.outputs[0]!.scriptHex = core.markerScript(changed.markerJson);
    expect(() => core.applyBlock(ledger, block(signed(changed)))).toThrow(/inventory|issuance/);
    expect(() =>
      core.buildMint({
        state: asset,
        funding,
        amountAtoms: atoms(amount),
        recipientScriptHex: bobScript,
      }),
    ).toThrow(/inventory|issuance/);
  }
});
