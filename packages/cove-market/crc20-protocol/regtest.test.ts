import { afterAll, beforeAll, expect, test } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import { writeFileSync } from "node:fs";
import {
  checkGardenCompliance,
  type ComplianceReport,
  type CoveAction,
} from "./test-support/compliance.ts";
import type { Plan } from "./types.js";
import { Core, aliceScript, bobScript, protocolScript, aliceKey } from "./test-support/core.ts";

const core = new Core();
const complianceReports: ComplianceReport[] = [];
function checkConfirmed(
  plan: Plan,
  transaction: Parameters<typeof checkGardenCompliance>[1],
  override?: CoveAction,
) {
  const operation = JSON.parse(plan.markerJson).op;
  const action: CoveAction =
    override ??
    (operation === "deploy"
      ? "deploy"
      : operation === "mint"
        ? "mint"
        : plan.listedAtoms !== undefined
          ? "listing"
          : plan.markerVout === 1
            ? "marketBuy"
            : plan.outputs[1]?.role === "vault"
              ? "curveSell"
              : plan.outputs[2]?.role === "vault"
                ? "inventoryBuy"
                : "transfer");
  const report = checkGardenCompliance(plan, transaction, action);
  expect(report.sharedWirePassed).toBe(true);
  complianceReports.push(report);
}
beforeAll(() => core.start());
afterAll(() => {
  try {
    expect(new Set(complianceReports.map((r) => r.action))).toEqual(
      new Set([
        "deploy",
        "mint",
        "transfer",
        "curveSell",
        "inventoryBuy",
        "listing",
        "marketBuy",
        "cancel",
      ]),
    );
    expect(complianceReports).toHaveLength(18);
    writeFileSync(
      new URL("./compliance-report.json", import.meta.url),
      JSON.stringify(
        {
          scope:
            "Every confirmed protocol transaction, including the orphan cancellation and replacement fill",
          sharedWirePassed: true,
          exactGardenLedgerCompatibilityProven: false,
          transactions: complianceReports,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    core.stop();
  }
});

// Expected economics are literal vectors independent of the protocol implementation.
test("two-wallet raw-chain lifecycle, invalid transitions, signatures, competitors, both cancel races, replay and reorg", async () => {
  const p = await import("./index.ts");
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: aliceScript,
    creatorScriptHex: aliceScript,
    protocolScriptHex: protocolScript,
  };
  let ledger = p.emptyLedger(config);
  const blocks: any[] = [];
  let deployTxid = "";
  let count = 0;
  const excluded = () =>
    new Set(
      Object.keys(ledger.allocations).concat(
        deployTxid
          ? [`${ledger.assets[deployTxid].vault.txid}:${ledger.assets[deployTxid].vault.vout}`]
          : [],
      ),
    );
  const funding = (wallet: "alice" | "bob") => [core.funding(wallet, excluded())];
  const asset = () => ledger.assets[deployTxid];
  const owned = (script: string, minimum = 1n) => {
    const entry = Object.entries(ledger.allocations)
      .sort((a: any, b: any) => (a[1].atoms > b[1].atoms ? -1 : 1))
      .find(
        ([, a]: any) => a.scriptHex === script && a.atoms >= minimum && a.deployTxid === deployTxid,
      );
    if (!entry) throw new Error(`no carrier for ${script}, ${minimum}`);
    const [txid, vout] = entry[0].split(":");
    return { ...(entry[1] as any), txid, vout: Number(vout) };
  };
  const balance = (script: string) =>
    Object.values(ledger.allocations).reduce(
      (sum: bigint, a: any) =>
        sum + (a.scriptHex === script && a.deployTxid === deployTxid ? a.atoms : 0n),
      0n,
    );
  function conservation() {
    if (!deployTxid) return;
    expect(
      balance(aliceScript) + balance(bobScript) + asset().inventoryAtoms + asset().burnedAtoms,
    ).toBe(asset().issuedAtoms);
  }
  async function confirm(
    plan: any,
    wallets: ("alice" | "bob")[],
    expectedOutputs?: bigint[],
    action?: CoveAction,
  ) {
    const hex = core.sign(plan, wallets);
    expect(
      p.validateFinalTransaction(plan, { rawHex: hex, prevouts: plan.inputs }, ledger),
    ).toBeTruthy();
    expect(core.accepted(hex).allowed).toBe(true);
    const txid = core.broadcast(hex);
    const [hash] = core.mine();
    const block = core.block(hash);
    expect(p.validateFinalTransaction(plan, block.transactions[0])).toBe(txid);
    checkConfirmed(plan, block.transactions[0], action);
    expect(block.transactions).toHaveLength(1);
    expect(block.transactions[0].rawHex).toBe(hex);
    const raw = Transaction.fromHex(hex);
    expect(raw.getId()).toBe(txid);
    expect(raw.outs.map((o) => BigInt(o.value))).toEqual(plan.outputs.map((o: any) => o.sats));
    expect(raw.outs.map((o) => o.script.toString("hex"))).toEqual(
      plan.outputs.map((o: any) => o.scriptHex),
    );
    if (expectedOutputs)
      expect(raw.outs.slice(0, expectedOutputs.length).map((o) => BigInt(o.value))).toEqual(
        expectedOutputs,
      );
    const inputs = block.transactions[0].prevouts.reduce((sum: bigint, i: any) => sum + i.sats, 0n);
    expect(inputs - raw.outs.reduce((sum, o) => sum + BigInt(o.value), 0n)).toBe(1000n);
    ledger = p.applyBlock(ledger, block);
    blocks.push(block);
    count++;
    conservation();
    return txid;
  }
  const base = { changeScriptHex: aliceScript, minerFeeSats: 1000n };
  deployTxid = await confirm(
    p.buildDeploy({ config, funding: funding("alice"), ...base }),
    ["alice"],
    [0n, 1000n, 1000n, 7000n],
  );
  expect(asset().issuedAtoms).toBe(0n);
  expect(asset().inventoryAtoms).toBe(0n);

  const mint = p.buildMint({
    state: asset(),
    funding: funding("alice"),
    recipientScriptHex: aliceScript,
    amountAtoms: 200000000000n,
    ...base,
  });
  // Every mutation is re-signed, so these exercise protocol rejection of Bitcoin-valid transactions.
  for (const mutate of [
    (x: any) => {
      x.outputs[2].sats -= 1n;
      x.outputs.at(-1).sats += 1n;
    },
    (x: any) => {
      x.outputs[3].scriptHex = bobScript;
    },
    (x: any) => {
      x.outputs[4].sats -= 1n;
      x.outputs.at(-1).sats += 1n;
    },
    (x: any) => {
      x.outputs[1].scriptHex = "6a00";
    },
    (x: any) => {
      x.outputs[0].scriptHex = p.markerScript('{"p":"crc-20","op":"mint","tick":"FAKE"}');
    },
    (x: any) => {
      x.outputs.at(-1).sats -= 20001n;
    },
    (x: any) => {
      x.outputs.push({ ...x.outputs[0] });
    },
  ]) {
    const bad = structuredClone(mint);
    mutate(bad);
    const hex = core.sign(bad);
    const transaction = { rawHex: hex, prevouts: bad.inputs };
    expect(() =>
      p.applyBlock(ledger, {
        hash: "f".repeat(64),
        parentHash: blocks.at(-1).hash,
        height: blocks.at(-1).height + 1,
        transactions: [transaction],
      }),
    ).toThrow();
  }
  const redirected = structuredClone(mint);
  redirected.outputs[1].scriptHex = bobScript;
  const redirectedHex = core.sign(redirected);
  expect(core.accepted(redirectedHex).allowed).toBe(true);
  expect(() =>
    p.validateFinalTransaction(mint, { rawHex: redirectedHex, prevouts: mint.inputs }),
  ).toThrow();
  const staleMint = core.sign(mint);
  await confirm(mint, ["alice"], [0n, 1000n, 1054n, 5025n, 546n]);
  expect(balance(aliceScript)).toBe(200000000000n);
  expect(balance(bobScript)).toBe(0n);
  expect(asset().issuedAtoms).toBe(200000000000n);
  expect(core.accepted(staleMint).allowed).toBe(false);

  const transfer = p.buildTransfer({
    network: "regtest",
    deployTxid,
    ticker: "TEST",
    inputs: [owned(aliceScript)],
    funding: funding("alice"),
    amountAtoms: 50000000000n,
    recipientScriptHex: bobScript,
    ...base,
  });
  for (const mutation of [
    (x: any) => {
      x.outputs[2].scriptHex = bobScript;
    },
    (x: any) => {
      x.outputs.splice(2, 1);
      x.outputs.at(-1).sats += 1000n;
    },
    (x: any) => {
      x.outputs[0].scriptHex = p.markerScript(
        '{"p":"crc-20","op":"transfer","tick":"TEST","amt":"200000000001"}',
      );
    },
    (x: any) => {
      x.inputs.splice(0, 1);
      x.outputs.at(-1).sats -= 1000n;
    },
  ]) {
    const invalid = structuredClone(transfer);
    mutation(invalid);
    const rawHex = core.sign(invalid);
    expect(core.accepted(rawHex).allowed).toBe(true);
    expect(() =>
      p.applyBlock(ledger, {
        hash: "6".repeat(64),
        parentHash: blocks.at(-1).hash,
        height: blocks.at(-1).height + 1,
        transactions: [{ rawHex, prevouts: invalid.inputs }],
      }),
    ).toThrow();
  }
  await confirm(transfer, ["alice"], [0n, 1000n, 1000n]);
  expect(balance(aliceScript)).toBe(150000000000n);
  expect(balance(bobScript)).toBe(50000000000n);

  const sell = p.buildSell({
    state: asset(),
    inputs: [owned(aliceScript)],
    funding: funding("alice"),
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    ...base,
  });
  await confirm(sell, ["alice"], [0n, 1027n, 1000n, 1000n, 1000n]);
  expect(balance(aliceScript)).toBe(50000000000n);
  expect(balance(bobScript)).toBe(50000000000n);
  expect(asset().inventoryAtoms).toBe(100000000000n);
  expect(asset().issuedAtoms).toBe(200000000000n);
  expect(asset().vault.sats).toBe(1027n);

  await confirm(
    p.buildInventoryBuy({
      state: asset(),
      funding: funding("bob"),
      amountAtoms: 100000000000n,
      recipientScriptHex: bobScript,
      changeScriptHex: bobScript,
      minerFeeSats: 1000n,
    }),
    ["alice", "bob"],
    [0n, 1000n, 1054n, 5013n, 546n],
  );
  expect(balance(bobScript)).toBe(150000000000n);
  expect(asset().issuedAtoms).toBe(200000000000n);
  expect(asset().inventoryAtoms).toBe(0n);

  // Separate mint to give Alice 2,000 TEST before the custom 500-token listing story.
  await confirm(
    p.buildMint({
      state: asset(),
      funding: funding("alice"),
      amountAtoms: 200000000000n,
      recipientScriptHex: aliceScript,
      ...base,
    }),
    ["alice"],
    [0n, 1000n, 1108n, 5025n, 546n],
  );
  expect(asset().issuedAtoms).toBe(400000000000n);
  async function list(amountAtoms: bigint, priceSats: bigint) {
    const before = count;
    const plan = p.buildListing({
      network: "regtest",
      deployTxid,
      ticker: "TEST",
      input: owned(aliceScript, amountAtoms),
      funding: funding("alice"),
      amountAtoms,
      priceSats,
      sellerScriptHex: aliceScript,
      ...base,
    });
    if (amountAtoms === 50000000000n && count === 6) {
      expect(plan.inputs[0].atoms).toBe(200000000000n);
      expect(plan.changeAtoms).toBe(150000000000n);
      expect(plan.outputs[2].atoms).toBe(150000000000n);
    }
    const id = await confirm(plan, ["alice"]);
    expect(count - before).toBe(1);
    const listedInput = {
      txid: id,
      vout: plan.recipientVout,
      atoms: amountAtoms,
      sats: 1000n,
      scriptHex: aliceScript,
    };
    const offer = await p.authorizeOffer(
      {
        network: "regtest",
        deployTxid,
        ticker: "TEST",
        listedInput,
        sellerScriptHex: aliceScript,
        priceSats,
        expiryHeight: core.rpc("getblockcount") + 50,
      },
      aliceKey.privateKey!,
    );
    ledger = await p.registerOffer(ledger, offer);
    return offer;
  }
  const offer = await list(50000000000n, 12347n);
  expect(balance(aliceScript)).toBe(250000000000n);
  const fillArgs = {
    offer,
    currentHeight: core.rpc("getblockcount"),
    buyerFunding: funding("bob"),
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
    changeScriptHex: bobScript,
    minerFeeSats: 1000n,
  };
  const fill = p.buildPurchase(fillArgs);
  expect(fill.inputWitnesses![0]).toHaveLength(2);
  const signedFill = core.sign(fill, ["bob"]);
  // Editing the jointly signed recipient/payout invalidates Bitcoin signatures.
  for (const vout of [
    0,
    fill.recipientVout,
    fill.outputs.findIndex((o: any) => o.role === "protocolFee"),
  ]) {
    const tampered = Transaction.fromHex(signedFill);
    tampered.outs[vout]!.value++;
    expect(core.accepted(tampered.toHex()).allowed).toBe(false);
  }
  const alteredAmount = Transaction.fromHex(signedFill);
  alteredAmount.outs[fill.markerVout]!.script = Buffer.from(
    p.markerScript(p.transferMarker("TEST", 49999999999n)),
    "hex",
  );
  expect(core.accepted(alteredAmount.toHex()).allowed).toBe(false);
  const wrongOutpoint = structuredClone(fill);
  wrongOutpoint.inputs[0] = owned(bobScript, 100000000000n);
  delete wrongOutpoint.inputWitnesses;
  const wrongOutpointHex = core.sign(wrongOutpoint, ["bob"]);
  expect(core.accepted(wrongOutpointHex).allowed).toBe(true);
  expect(() =>
    p.applyBlock(ledger, {
      hash: "5".repeat(64),
      parentHash: blocks.at(-1).hash,
      height: blocks.at(-1).height + 1,
      transactions: [{ rawHex: wrongOutpointHex, prevouts: wrongOutpoint.inputs }],
    }),
  ).toThrow();
  for (const extra of [
    { priceSats: 12348n },
    { amountAtoms: 49999999999n },
    { sellerScriptHex: bobScript },
    { deployTxid: "f".repeat(64) },
    { network: "mainnet" },
  ]) {
    const badOffer = { ...offer, ...extra };
    await expect(p.registerOffer(ledger, badOffer)).rejects.toThrow();
  }
  // Protocol-invalid but Bitcoin-valid fill is refused by pure replay.
  const wrongFee = structuredClone(fill);
  wrongFee.outputs.find((o: any) => o.role === "protocolFee")!.sats--;
  wrongFee.outputs.at(-1)!.sats++;
  const wrongFeeHex = core.sign(wrongFee, ["bob"]);
  expect(core.accepted(wrongFeeHex).allowed).toBe(true);
  expect(() =>
    p.applyBlock(ledger, {
      hash: "e".repeat(64),
      parentHash: blocks.at(-1).hash,
      height: blocks.at(-1).height + 1,
      transactions: [{ rawHex: wrongFeeHex, prevouts: wrongFee.inputs }],
    }),
  ).toThrow();
  const competitor = p.buildPurchase({
    ...fillArgs,
    buyerScriptHex: aliceScript,
    changeScriptHex: aliceScript,
    buyerFunding: funding("alice"),
  });
  const competingHex = core.sign(competitor, ["alice"]);
  expect(core.accepted(competingHex).allowed).toBe(true);
  const beforeFill = count;
  await confirm(fill, ["bob"], [13347n, 0n, 1000n, 1000n]);
  expect(count - beforeFill).toBe(1);
  expect(core.accepted(competingHex).allowed).toBe(false);
  expect(balance(aliceScript)).toBe(200000000000n);
  expect(balance(bobScript)).toBe(200000000000n);
  expect(ledger.offers[p.offerId(offer)].status).toBe("filled");

  // One arbitrary atom listing and purchase with integer price.
  const arbitrary = await list(123456789n, 20001n);
  await confirm(
    p.buildPurchase({
      offer: arbitrary,
      currentHeight: core.rpc("getblockcount"),
      buyerFunding: funding("bob"),
      buyerScriptHex: bobScript,
      protocolScriptHex: protocolScript,
      changeScriptHex: bobScript,
      minerFeeSats: 1000n,
    }),
    ["bob"],
    [21001n, 0n, 1000n, 1501n],
  );
  expect(balance(bobScript)).toBe(200123456789n);

  // Cancellation-first race. Off-chain unavailability does not spend the carrier.
  const cancelOffer = await list(1n, 12347n);
  const beforeCancel = ledger;
  const pendingCancel = p.markOfferUnavailable(ledger, p.offerId(cancelOffer));
  expect(pendingCancel.offers[p.offerId(cancelOffer)].status).toBe("cancelPending");
  expect(pendingCancel.allocations).toEqual(ledger.allocations);
  expect(ledger.offers[p.offerId(cancelOffer)].status).toBe("open");
  const cancelPlan = p.buildCancel({ offer: cancelOffer, funding: funding("alice"), ...base });
  expect(cancelPlan.protocolFeeSats).toBe(0n);
  expect(cancelPlan.creatorFeeSats).toBe(0n);
  const reorgFillPlan = p.buildPurchase({
    offer: cancelOffer,
    currentHeight: core.rpc("getblockcount"),
    buyerFunding: funding("bob"),
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
    changeScriptHex: bobScript,
    minerFeeSats: 1000n,
  });
  const losingFill = core.sign(reorgFillPlan, ["bob"]);
  const beforeCancelCount = count;
  await confirm(cancelPlan, ["alice"], [0n, 1000n], "cancel");
  expect(count - beforeCancelCount).toBe(1);
  expect(core.accepted(losingFill).allowed).toBe(false);
  expect(ledger.offers[p.offerId(cancelOffer)].status).toBe("cancelled");
  const cancelBlock = blocks.at(-1);
  // Immutable replay snapshots provide deterministic rollback, then apply competing fill.
  expect(p.rollbackBlock(ledger, cancelBlock.hash)).toEqual(beforeCancel);
  core.rpc("invalidateblock", [cancelBlock.hash]);
  ledger = p.rollbackBlock(ledger, cancelBlock.hash);
  blocks.pop();
  // The orphan cancellation may occupy mempool; clear it via a fresh same-tip block before the second race.
  core.clearOrphanMempool();
  expect(core.accepted(losingFill).allowed).toBe(true);
  core.broadcast(losingFill);
  const [replacementHash] = core.mine();
  const replacement = core.block(replacementHash);
  checkConfirmed(reorgFillPlan, replacement.transactions[0], "marketBuy");
  expect(replacement.height).toBe(cancelBlock.height);
  expect(replacement.hash).not.toBe(cancelBlock.hash);
  ledger = p.applyBlock(ledger, replacement);
  blocks.push(replacement);
  count++;
  expect(ledger.offers[p.offerId(cancelOffer)].status).toBe("filled");
  conservation();

  // Fill-first race.
  const fillOffer = await list(50000000000n, 12347n);
  const losingCancel = core.sign(
    p.buildCancel({ offer: fillOffer, funding: funding("alice"), ...base }),
  );
  await confirm(
    p.buildPurchase({
      offer: fillOffer,
      currentHeight: core.rpc("getblockcount"),
      buyerFunding: funding("bob"),
      buyerScriptHex: bobScript,
      protocolScriptHex: protocolScript,
      changeScriptHex: bobScript,
      minerFeeSats: 1000n,
    }),
    ["bob"],
  );
  expect(core.accepted(losingCancel).allowed).toBe(false);
  expect(ledger.offers[p.offerId(fillOffer)].status).toBe("filled");
  expect(balance(aliceScript)).toBe(149876543210n);
  expect(balance(bobScript)).toBe(250123456790n);
  conservation();

  // Replay block ordering, duplicate blocks, detached blocks, and raw transaction replay.
  let replay = p.emptyLedger(config);
  for (const block of blocks) {
    replay = p.applyBlock(replay, block);
    for (const registered of Object.values(ledger.offers) as any[]) {
      const outpoint = `${registered.listedInput.txid}:${registered.listedInput.vout}`;
      if (replay.allocations[outpoint] && !replay.offers[p.offerId(registered)])
        replay = await p.registerOffer(replay, registered);
    }
    expect(p.applyBlock(replay, block)).toEqual(replay);
  }
  expect(replay.assets).toEqual(ledger.assets);
  expect(replay.allocations).toEqual(ledger.allocations);
  expect(replay.offers).toEqual(ledger.offers);
  expect(() =>
    p.applyBlock(ledger, { ...blocks.at(-1), hash: "9".repeat(64), parentHash: "8".repeat(64) }),
  ).toThrow();
  const oldMint = blocks[1].transactions[0];
  expect(() =>
    p.applyBlock(ledger, {
      hash: "7".repeat(64),
      parentHash: blocks.at(-1).hash,
      height: blocks.at(-1).height + 1,
      transactions: [oldMint],
    }),
  ).toThrow();
  expect(count).toBe(15);
  expect(blocks).toHaveLength(14);
  expect(blocks.reduce((sum, b) => sum + b.transactions.length, 0)).toBe(14);
}, 120000);

test("Bob independently mints and raw-chain ownership never credits Alice with Bob's carrier", async () => {
  const p = await import("./index.ts");
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: aliceScript,
    creatorScriptHex: aliceScript,
    protocolScriptHex: protocolScript,
  };
  let ledger = p.emptyLedger(config);
  let deployTxid = "";
  let confirmed = 0;
  async function confirm(plan: any, wallets: ("alice" | "bob")[], values: bigint[]) {
    const rawHex = core.sign(plan, wallets);
    expect(
      p.validateFinalTransaction(plan, { rawHex, prevouts: plan.inputs }, ledger),
    ).toBeTruthy();
    expect(core.accepted(rawHex).allowed).toBe(true);
    const txid = core.broadcast(rawHex);
    const [hash] = core.mine();
    const block = core.block(hash);
    expect(block.transactions).toHaveLength(1);
    const tx = Transaction.fromHex(block.transactions[0].rawHex);
    expect(tx.outs.slice(0, values.length).map((o) => BigInt(o.value))).toEqual(values);
    expect(p.validateFinalTransaction(plan, block.transactions[0])).toBe(txid);
    checkConfirmed(plan, block.transactions[0]);
    ledger = p.applyBlock(ledger, block);
    confirmed++;
    return txid;
  }
  deployTxid = await confirm(
    p.buildDeploy({
      config,
      funding: [core.funding("alice")],
      changeScriptHex: aliceScript,
      minerFeeSats: 1000n,
    }),
    ["alice"],
    [0n, 1000n, 1000n, 7000n],
  );
  await confirm(
    p.buildMint({
      state: ledger.assets[deployTxid],
      funding: [core.funding("alice")],
      recipientScriptHex: aliceScript,
      amountAtoms: 200000000000n,
      changeScriptHex: aliceScript,
      minerFeeSats: 1000n,
    }),
    ["alice"],
    [0n, 1000n, 1054n, 5025n, 546n],
  );
  await confirm(
    p.buildMint({
      state: ledger.assets[deployTxid],
      funding: [core.funding("bob")],
      recipientScriptHex: bobScript,
      amountAtoms: 100000000000n,
      changeScriptHex: bobScript,
      minerFeeSats: 1000n,
    }),
    ["alice", "bob"],
    [0n, 1000n, 1081n, 5013n, 546n],
  );
  const balance = (script: string) =>
    Object.values(ledger.allocations).reduce(
      (sum, a) => sum + (a.scriptHex === script ? a.atoms : 0n),
      0n,
    );
  expect(balance(aliceScript)).toBe(200000000000n);
  expect(balance(bobScript)).toBe(100000000000n);
  expect(ledger.assets[deployTxid].issuedAtoms).toBe(300000000000n);
  expect(ledger.assets[deployTxid].inventoryAtoms).toBe(0n);
  expect(confirmed).toBe(3);
});
