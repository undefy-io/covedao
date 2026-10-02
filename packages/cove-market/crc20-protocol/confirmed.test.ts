import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";
import { aliceKey, aliceScript, bobScript, protocolScript } from "./test-support/core.js";
import { signNativeInput, authorizeOffer } from "./test-support/signing.js";
import type { Config, Input, Ledger, ChainTransaction } from "./types.js";
const config: Config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: bobScript,
  protocolScriptHex: protocolScript,
};
const id = "a".repeat(64),
  token = {
    txid: "b".repeat(64),
    vout: 0,
    sats: 1000n,
    scriptHex: aliceScript,
    atoms: 10000000000n,
    deployTxid: id,
  };
function seeded(): Ledger {
  const ledger = core.emptyLedger(config);
  ledger.assets[id] = {
    config,
    deployTxid: id,
    issuedAtoms: token.atoms,
    inventoryAtoms: 0n,
    burnedAtoms: 0n,
    vault: {
      txid: id,
      vout: 1,
      sats: 1000n + core.backingSats(token.atoms),
      scriptHex: aliceScript,
    },
  };
  ledger.allocations[core.outpoint(token)] = {
    atoms: token.atoms,
    sats: 1000n,
    scriptHex: aliceScript,
    deployTxid: id,
  };
  return ledger;
}
function sign(inputs: Input[], outputs: { scriptHex: string; sats: bigint }[]): ChainTransaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  inputs.forEach((i) => tx.addInput(Buffer.from(i.txid, "hex").reverse(), i.vout, 0xfffffffe));
  outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, "hex"), Number(o.sats)));
  inputs.forEach((_, i) =>
    tx.setWitness(
      i,
      signNativeInput(core.parseRawTransaction(tx.toHex()), inputs, i, aliceKey.privateKey!, 1).map(
        (h) => Buffer.from(h, "hex"),
      ),
    ),
  );
  return { rawHex: tx.toHex(), prevouts: inputs };
}
const block = (transactions: ChainTransaction[], height = 1, parentHash = "c".repeat(64)) => ({
  hash: height.toString(16).padStart(64, "0"),
  parentHash,
  height,
  transactions,
});
test("confirmed non-protocol carrier spend burns atoms and retires offer; rollback restores all", async () => {
  let ledger = seeded();
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: id,
      ticker: "TEST",
      listedInput: token,
      sellerScriptHex: aliceScript,
      priceSats: 10000n,
      expiryHeight: 10,
    },
    aliceKey.privateKey!,
  );
  ledger = await core.registerOffer(ledger, offer);
  const tx = sign([token], [{ scriptHex: bobScript, sats: 500n }]);
  const next = core.applyConfirmedBlock(ledger, block([tx]));
  expect(next.allocations).toEqual({});
  expect(next.assets[id]!.burnedAtoms).toBe(token.atoms);
  expect(next.assets[id]!.issuedAtoms).toBe(token.atoms);
  expect(next.offers[core.offerId(offer)]!.status).toBe("cancelled");
  expect(core.rollbackBlock(next, next.tip!.hash)).toEqual(ledger);
});
test("broken vault preserves circulating carriers and refuses further curve construction", () => {
  const ledger = seeded(),
    vault = ledger.assets[id]!.vault;
  const tx = sign([vault], [{ scriptHex: bobScript, sats: 500n }]);
  const next = core.applyConfirmedBlock(ledger, block([tx]));
  expect(next.assets[id]!.vaultAvailable).toBe(false);
  expect(next.allocations).toEqual(ledger.allocations);
  expect(() =>
    core.buildMint({
      state: next.assets[id]!,
      funding: [
        { ...token, atoms: undefined, deployTxid: undefined, txid: "d".repeat(64), sats: 100000n },
      ],
      recipientScriptHex: aliceScript,
      amountAtoms: 10000000000n,
    }),
  ).toThrow(/vault/i);
  const plan = core.buildTransfer({
    network: "regtest",
    deployTxid: id,
    ticker: "TEST",
    inputs: [token],
    funding: [{ txid: "d".repeat(64), vout: 0, sats: 10000n, scriptHex: aliceScript }],
    amountAtoms: token.atoms,
    recipientScriptHex: bobScript,
  });
  const result = core.applyConfirmedBlock(
    next,
    block([sign(plan.inputs, plan.outputs)], 2, next.tip!.hash),
  );
  expect(Object.values(result.allocations)[0]!.atoms).toBe(token.atoms);
  expect(result.assets[id]!.burnedAtoms).toBe(0n);
});
test("unavailable parent data for tracked spend blocks atomically; unrelated tx does not require parents", () => {
  const ledger = seeded(),
    tx = sign([token], [{ scriptHex: bobScript, sats: 500n }]);
  expect(() => core.applyConfirmedBlock(ledger, block([{ ...tx, prevouts: [] }]))).toThrow(
    /parent/i,
  );
  expect(ledger.allocations[core.outpoint(token)]).toBeDefined();
  const unrelated = sign(
    [{ ...token, txid: "d".repeat(64) }],
    [{ scriptHex: bobScript, sats: 500n }],
  );
  const next = core.applyConfirmedBlock(ledger, block([{ ...unrelated, prevouts: [] }]));
  expect(next.allocations).toEqual(ledger.allocations);
});
test("durable undo is bounded without nested ledger histories and survives JSON restart", () => {
  let ledger = core.emptyLedger(config);
  for (let height = 1; height <= 6; height++)
    ledger = core.applyConfirmedBlock(ledger, block([], height, ledger.tip?.hash), {
      undoLimit: 2,
    });
  expect(Object.keys(ledger.history)).toHaveLength(2);
  for (const undo of Object.values(ledger.history))
    expect(JSON.stringify(core.encodeProtocolDto(undo))).not.toContain('"history"');
  const restarted = core.restoreLedger(
    core.decodeProtocolDto(core.encodeProtocolDto(core.snapshotLedger(ledger))),
    core.decodeProtocolDto(core.encodeProtocolDto(ledger.history)),
  );
  expect(restarted).toEqual(ledger);
  const rolled = core.rollbackBlock(restarted, ledger.tip!.hash);
  expect(rolled.tip!.height).toBe(5);
  expect(Object.keys(rolled.history)).toHaveLength(1);
});
test("multiple registered deployments in block order use their exact configs", () => {
  const configs = [config, { ...config, ticker: "OTHER" }];
  const transactions = configs.map((config, n) => {
    const plan = core.buildDeploy({
      config,
      funding: [
        { txid: (n + 7).toString(16).repeat(64), vout: 0, sats: 1000000n, scriptHex: aliceScript },
      ],
      changeScriptHex: aliceScript,
    });
    return sign(plan.inputs, plan.outputs);
  });
  const registeredDeployments = Object.fromEntries(
    transactions.map((tx, n) => [core.parseRawTransaction(tx.rawHex).txid, configs[n]!]),
  );
  const ledger = core.applyConfirmedBlock(core.emptyLedger(config), block(transactions), {
    registeredDeployments,
  });
  expect(Object.values(ledger.assets).map((a) => a.config.ticker)).toEqual(["TEST", "OTHER"]);
  expect(ledger.config).toEqual(config);
});
test("intra-block transfers consume earlier outputs and retain exact fractional allocations", () => {
  const ledger = seeded();
  const funding = (char: string) => ({
    txid: char.repeat(64),
    vout: 0,
    sats: 10000n,
    scriptHex: aliceScript,
  });
  const first = core.buildTransfer({
    network: "regtest",
    deployTxid: id,
    ticker: "TEST",
    inputs: [token],
    funding: [funding("d")],
    amountAtoms: token.atoms,
    recipientScriptHex: aliceScript,
  });
  const firstTx = sign(first.inputs, first.outputs);
  const carrier = { ...token, txid: core.parseRawTransaction(firstTx.rawHex).txid, vout: 1 };
  const amount = 123456789n;
  const second = core.buildTransfer({
    network: "regtest",
    deployTxid: id,
    ticker: "TEST",
    inputs: [carrier],
    funding: [funding("e")],
    amountAtoms: amount,
    recipientScriptHex: bobScript,
  });
  const next = core.applyConfirmedBlock(
    ledger,
    block([firstTx, sign(second.inputs, second.outputs)]),
  );
  expect(
    Object.values(next.allocations)
      .filter((a) => a.scriptHex === bobScript)
      .reduce((sum, a) => sum + a.atoms, 0n),
  ).toBe(amount);
  expect(Object.values(next.allocations).reduce((sum, a) => sum + a.atoms, 0n)).toBe(token.atoms);
  expect(next.allocations[core.outpoint(carrier)]).toBeUndefined();
  expect(core.rollbackBlock(next, next.tip!.hash)).toEqual(ledger);
});
test("invalid vault spend burns inventory only and preserves circulation conservation", () => {
  const ledger = seeded(),
    asset = ledger.assets[id]!;
  asset.issuedAtoms = token.atoms * 2n;
  asset.inventoryAtoms = token.atoms;
  asset.vault.sats = 1000n + core.backingSats(token.atoms);
  ledger.allocations[core.outpoint(token)]!.atoms = token.atoms;
  const next = core.applyConfirmedBlock(
    ledger,
    block([sign([asset.vault], [{ scriptHex: bobScript, sats: 500n }])]),
  );
  expect(next.assets[id]!.inventoryAtoms).toBe(0n);
  expect(next.assets[id]!.burnedAtoms).toBe(token.atoms);
  expect(Object.values(next.allocations)[0]!.atoms).toBe(token.atoms);
});
test("Core mines non-protocol carrier burn; production transition and durable rollback follow actual prevouts", async () => {
  const { Core } = await import("./test-support/core.js");
  const node = new Core();
  try {
    node.start();
    const deployPlan = core.buildDeploy({
      config,
      funding: [node.funding("alice")],
      changeScriptHex: aliceScript,
    });
    const deployRaw = node.sign(deployPlan);
    expect(node.accepted(deployRaw).allowed).toBe(true);
    const deployId = node.broadcast(deployRaw);
    node.mine();
    let ledger = core.applyConfirmedBlock(
      core.emptyLedger(config),
      block([node.transaction(deployId)]),
      { registeredDeployments: { [deployId]: config } },
    );
    const mintPlan = core.buildMint({
      state: ledger.assets[deployId]!,
      funding: [node.funding("alice")],
      amountAtoms: token.atoms,
      recipientScriptHex: aliceScript,
    });
    const mintRaw = node.sign(mintPlan);
    expect(node.accepted(mintRaw).allowed).toBe(true);
    const mintId = node.broadcast(mintRaw);
    node.mine();
    ledger = core.applyConfirmedBlock(
      ledger,
      block([node.transaction(mintId)], 2, ledger.tip!.hash),
    );
    const allocation = ledger.allocations[`${mintId}:1`]!;
    const burnRaw = node.sign({
      inputs: [{ txid: mintId, vout: 1, sats: allocation.sats, scriptHex: allocation.scriptHex }],
      outputs: [{ scriptHex: bobScript, sats: 500n }],
    });
    expect(node.accepted(burnRaw).allowed).toBe(true);
    const burnId = node.broadcast(burnRaw);
    node.mine();
    const observed = node.transaction(burnId);
    expect(observed.prevouts[0]!.sats).toBe(1000n);
    const next = core.applyConfirmedBlock(ledger, block([observed], 3, ledger.tip!.hash));
    expect(next.allocations).toEqual({});
    expect(next.assets[deployId]!.burnedAtoms).toBe(token.atoms);
    expect(core.rollbackBlock(next, next.tip!.hash)).toEqual(ledger);
  } finally {
    node.stop();
  }
});
test("inconsistent ordinary funding observations retry rather than burn valid tokens", () => {
  const ledger = seeded();
  const funding = { txid: "d".repeat(64), vout: 0, sats: 10000n, scriptHex: aliceScript };
  const plan = core.buildTransfer({
    network: "regtest",
    deployTxid: id,
    ticker: "TEST",
    inputs: [token],
    funding: [funding],
    amountAtoms: token.atoms,
    recipientScriptHex: bobScript,
  });
  const tx = sign(plan.inputs, plan.outputs);
  const wrong = {
    ...tx,
    prevouts: tx.prevouts.map((p, n) => (n === 1 ? { ...p, sats: 10001n } : p)),
  };
  expect(() => core.applyConfirmedBlock(ledger, block([wrong]))).toThrow(/parent/i);
  expect(ledger.assets[id]!.burnedAtoms).toBe(0n);
});
test("rollback removes later offers for orphaned allocations while signed terms remain external", async () => {
  const ledger = seeded();
  const plan = core.buildTransfer({
    network: "regtest",
    deployTxid: id,
    ticker: "TEST",
    inputs: [token],
    funding: [{ txid: "d".repeat(64), vout: 0, sats: 10000n, scriptHex: aliceScript }],
    amountAtoms: token.atoms,
    recipientScriptHex: aliceScript,
  });
  const tx = sign(plan.inputs, plan.outputs);
  let next = core.applyConfirmedBlock(ledger, block([tx]));
  const listedInput = { ...token, txid: core.parseRawTransaction(tx.rawHex).txid, vout: 1 };
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: id,
      ticker: "TEST",
      listedInput,
      sellerScriptHex: aliceScript,
      priceSats: 10000n,
      expiryHeight: 10,
    },
    aliceKey.privateKey!,
  );
  next = await core.registerOffer(next, offer);
  expect(core.rollbackBlock(next, next.tip!.hash)).toEqual(ledger);
});
test("authenticated ordinary parents permit permanent invalidity, while wrong authenticated metadata retries", () => {
  const parent = new bitcoin.Transaction();
  parent.addInput(Buffer.alloc(32, 0x44), 0);
  parent.addOutput(Buffer.from(aliceScript, "hex"), 10000);
  const funding = { txid: parent.getId(), vout: 0, sats: 10000n, scriptHex: aliceScript };
  const raw = sign([token, funding], [{ scriptHex: bobScript, sats: 10500n }]);
  const observed = { ...raw, parentRawTransactions: { [funding.txid]: parent.toHex() } };
  const next = core.applyConfirmedBlock(seeded(), block([observed]));
  expect(next.assets[id]!.burnedAtoms).toBe(token.atoms);
  expect(() =>
    core.applyConfirmedBlock(
      seeded(),
      block([{ ...observed, prevouts: [token, { ...funding, sats: 10001n }] }]),
    ),
  ).toThrow(/parent/i);
  expect(() =>
    core.applyConfirmedBlock(
      seeded(),
      block([{ ...observed, prevouts: [token, { ...funding, scriptHex: "51" }] }]),
    ),
  ).toThrow(/parent/i);
  expect(() => core.applyConfirmedBlock(seeded(), block([raw]))).toThrow(/parent/i);
});
test("consensus-valid unsupported SIGHASH_NONE spend burns instead of retrying", () => {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(token.txid, "hex").reverse(), 0, 0xfffffffe);
  tx.addOutput(Buffer.from(bobScript, "hex"), 500);
  const digest = tx.hashForWitnessV0(
    0,
    Buffer.from(`76a914${aliceScript.slice(4)}88ac`, "hex"),
    1000,
    2,
  );
  tx.setWitness(0, [bitcoin.script.signature.encode(aliceKey.sign(digest), 2), aliceKey.publicKey]);
  const next = core.applyConfirmedBlock(
    seeded(),
    block([{ rawHex: tx.toHex(), prevouts: [token] }]),
  );
  expect(next.assets[id]!.burnedAtoms).toBe(token.atoms);
});
test("confirmed paid fill settles after off-chain expiry and cancel request from stored signed terms", async () => {
  let ledger = seeded();
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: id,
      ticker: "TEST",
      listedInput: token,
      sellerScriptHex: aliceScript,
      priceSats: 10000n,
      expiryHeight: 1,
    },
    aliceKey.privateKey!,
  );
  ledger = await core.registerOffer(ledger, offer);
  ledger = core.markOfferUnavailable(ledger, core.offerId(offer));
  ledger.tip = { hash: "e".repeat(64), height: 10, fingerprint: "observed" };
  const plan = core.buildPurchase({
    listedInput: token,
    priceSats: offer.priceSats,
    sellerScriptHex: aliceScript,
    ticker: "TEST",
    buyerFunding: [{ txid: "d".repeat(64), vout: 0, sats: 100000n, scriptHex: aliceScript }],
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
    minerFeeSats: 1000n,
  });
  const raw = sign(plan.inputs, plan.outputs);
  const tx = bitcoin.Transaction.fromHex(raw.rawHex);
  tx.setWitness(
    0,
    offer.sellerWitnessHex.map((h) => Buffer.from(h, "hex")),
  );
  const next = core.applyConfirmedBlock(
    ledger,
    block([{ ...raw, rawHex: tx.toHex() }], 11, ledger.tip.hash),
  );
  expect(next.offers[core.offerId(offer)]!.status).toBe("filled");
  expect(Object.values(next.allocations)[0]!.scriptHex).toBe(bobScript);
  expect(next.assets[id]!.burnedAtoms).toBe(0n);
});
