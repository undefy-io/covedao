import { beforeAll, afterAll, expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as p from "./index.js";
import { hex, unhex } from "./bytes.js";
import type { Config, EscrowTerms, Ledger, Offer, Plan } from "./types.js";
import {
  Core,
  aliceKey,
  bobKey,
  aliceScript,
  bobScript,
  protocolScript,
} from "./test-support/core.js";
import { signNativeInput } from "./test-support/signing.js";
bitcoin.initEccLib(ecc);
const chain = new Core();
const key = aliceKey.publicKey.subarray(1);
const commit = Buffer.alloc(32, 7);
const script = bitcoin.script.compile([
  commit,
  bitcoin.opcodes.OP_EQUALVERIFY!,
  key,
  bitcoin.opcodes.OP_CHECKSIG!,
]);
const internalPubkey = Buffer.from(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
  "hex",
);
const vault = bitcoin.payments.p2tr({
  internalPubkey,
  scriptTree: [{ output: script }, { output: Buffer.from("51", "hex") }],
  redeem: { output: script, redeemVersion: 0xc0 },
});
const config: Config = {
  network: "regtest",
  ticker: "ESC",
  vaultScriptHex: vault.output!.toString("hex"),
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
  guardianCustody: {
    assetCommitmentHex: commit.toString("hex"),
    guardianPublicKeyHex: key.toString("hex"),
    executionScriptHex: script.toString("hex"),
    controlBlockHex: vault.witness!.at(-1)!.toString("hex"),
    recoveryLeafHashHex: bitcoin.crypto
      .taggedHash("TapLeaf", Buffer.from("c00151", "hex"))
      .toString("hex"),
  },
};
const unit = 100000000n;
beforeAll(() => chain.start());
afterAll(() => chain.stop());
function walletSigned(plan: Plan, wallet: "alice" | "bob" = "alice") {
  const raw = new bitcoin.Transaction();
  raw.version = 2;
  for (const input of plan.inputs)
    raw.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout, 0xfffffffe);
  for (const output of plan.outputs)
    raw.addOutput(Buffer.from(output.scriptHex, "hex"), Number(output.sats));
  const parsed = p.parseRawTransaction(raw.toHex());
  plan.inputs.forEach((input, index) => {
    if (input.scriptHex === (wallet === "alice" ? aliceScript : bobScript))
      raw.setWitness(
        index,
        signNativeInput(
          parsed,
          plan.inputs,
          index,
          (wallet === "alice" ? aliceKey : bobKey).privateKey!,
          1,
        ).map((w) => Buffer.from(w, "hex")),
      );
  });
  return raw.toHex();
}
function signed(
  plan: Plan,
  guardian?: { commitmentHex: string; executionScriptHex: string; controlBlockHex: string },
  wallet: "alice" | "bob" = "alice",
) {
  const raw = bitcoin.Transaction.fromHex(walletSigned(plan, wallet));
  if (guardian) {
    const parsed = p.parseRawTransaction(raw.toHex());
    const leaf = p.taggedHash(
      "TapLeaf",
      Uint8Array.from([0xc0, 68, ...unhex(guardian.executionScriptHex)]),
    );
    const signature = ecc.signSchnorr(
      p.taprootSignatureHash(parsed, plan.inputs, 0, 1, leaf),
      aliceKey.privateKey!,
    );
    raw.setWitness(0, [
      Buffer.from([...signature, 1]),
      Buffer.from(guardian.commitmentHex, "hex"),
      Buffer.from(guardian.executionScriptHex, "hex"),
      Buffer.from(guardian.controlBlockHex, "hex"),
    ]);
  }
  return raw.toHex();
}
function confirm(
  ledger: Ledger,
  plan: Plan,
  guardian?: Parameters<typeof signed>[1],
  authorizations: Offer[] = [],
  wallet: "alice" | "bob" = "alice",
) {
  const rawHex = signed(plan, guardian, wallet);
  expect(chain.accepted(rawHex).allowed).toBe(true);
  const txid = chain.broadcast(rawHex);
  const block = chain.block(chain.mine()[0]);
  return {
    ledger: p.applyConfirmedBlockDetailed(ledger, block, {
      registeredDeployments: { [txid]: config },
      authorizations,
    }).ledger,
    txid,
    block,
  };
}
function setup() {
  const deployment = confirm(
    p.emptyLedger(config),
    p.buildDeploy({ config, funding: [chain.funding("alice")], changeScriptHex: aliceScript }),
  );
  const minted = confirm(
    deployment.ledger,
    p.buildMint({
      state: deployment.ledger.assets[deployment.txid]!,
      amountAtoms: 400n * unit,
      funding: [chain.funding("alice")],
      recipientScriptHex: aliceScript,
    }),
    { ...config.guardianCustody!, commitmentHex: hex(commit) },
  );
  const [point, allocation] = Object.entries(minted.ledger.allocations).find(
    ([, a]) => a.scriptHex === aliceScript,
  )!;
  const [txid, vout] = point.split(":");
  const input = { txid: txid!, vout: Number(vout), ...allocation };
  const terms: EscrowTerms = {
    version: 1,
    network: "regtest",
    deployTxid: deployment.txid,
    ticker: "ESC",
    amountAtoms: 250n * unit,
    priceSats: 12347n,
    sellerTokenScriptHex: aliceScript,
    sellerPayoutScriptHex: aliceScript,
    sellerAuthorityScriptHex: aliceScript,
    protocolScriptHex: protocolScript,
    feePolicy: "market-v1",
    expiryHeight: minted.ledger.tip!.height + 10,
    guardianPublicKeyHex: hex(key),
    nonceHex: "ab".repeat(32),
  };
  return { ledger: minted.ledger, input, terms };
}
test("one listing transaction automatically activates250 from400 and refunds150; one atomic buyer transaction fills it", () => {
  const { ledger, input, terms } = setup();
  const plan = p.buildEscrowListing({
    config,
    terms,
    inputs: [input],
    funding: [chain.funding("alice")],
    changeScriptHex: aliceScript,
  });
  expect(plan.outputs[1]!.atoms).toBe(250n * unit);
  expect(plan.outputs[2]!.atoms).toBe(150n * unit);
  const rawHex = signed(plan);
  const txid = p.parseRawTransaction(rawHex).txid;
  const offer = p.escrowOffer(terms, { txid, vout: 1, ...plan.outputs[1]! });
  expect(p.rehydrateOfferAuthorizations(ledger, [offer]).offers).toEqual({});
  const listing = confirm(ledger, plan, undefined, [offer]);
  expect(listing.txid).toBe(txid);
  expect(listing.ledger.offers[p.offerId(offer)]!.status).toBe("open");
  const purchase = p.buildEscrowPurchase({
    offer,
    currentHeight: listing.ledger.tip!.height,
    buyerFunding: [chain.funding("bob")],
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
  });
  const pending = { rawHex: walletSigned(purchase, "bob"), prevouts: purchase.inputs };
  expect(p.validateEscrowGuardianTransaction(listing.ledger, pending).kind).toBe("fill");
  const fill = confirm(listing.ledger, purchase, p.escrowCustody(terms), [offer], "bob");
  expect(fill.ledger.offers[p.offerId(offer)]!.status).toBe("filled");
  expect(Object.values(fill.ledger.allocations).find((a) => a.scriptHex === bobScript)!.atoms).toBe(
    250n * unit,
  );
  expect(p.rollbackBlock(fill.ledger, fill.block.hash).offers[p.offerId(offer)]!.status).toBe(
    "open",
  );
  expect(p.rollbackBlock(listing.ledger, listing.block.hash).offers).toEqual({});
});
test("seller cancellation requires signed authority funding and returns exact tokens even after expiry", () => {
  const { ledger, input, terms } = setup();
  const plan = p.buildEscrowListing({
    config,
    terms,
    inputs: [input],
    funding: [chain.funding("alice")],
    changeScriptHex: aliceScript,
  });
  const txid = p.parseRawTransaction(signed(plan)).txid;
  const offer = p.escrowOffer(terms, { txid, vout: 1, ...plan.outputs[1]! });
  const listing = confirm(ledger, plan, undefined, [offer]);
  expect(() => p.buildEscrowCancel({ offer, funding: [chain.funding("bob")] })).toThrow(
    /authority/,
  );
  const cancel = p.buildEscrowCancel({ offer, funding: [chain.funding("alice")] });
  const expired = {
    ...listing.ledger,
    tip: { ...listing.ledger.tip!, height: terms.expiryHeight },
  };
  expect(
    p.validateEscrowGuardianTransaction(expired, {
      rawHex: walletSigned(cancel),
      prevouts: cancel.inputs,
    }).kind,
  ).toBe("transfer");
  const done = confirm(listing.ledger, cancel, p.escrowCustody(terms), [offer]);
  expect(done.ledger.offers[p.offerId(offer)]!.status).toBe("cancelled");
  expect(
    Object.values(done.ledger.allocations)
      .filter((a) => a.scriptHex === aliceScript)
      .reduce((n, a) => n + a.atoms, 0n),
  ).toBe(400n * unit);
});
test("terms bind every amount, destination and authority; arbitrary atoms and exact inputs need one listing", () => {
  const { terms, input } = setup();
  const original = p.escrowCustody(terms).scriptHex;
  for (const changed of [
    { amountAtoms: terms.amountAtoms + 1n },
    { priceSats: 1n },
    { sellerPayoutScriptHex: bobScript },
    { sellerTokenScriptHex: bobScript },
    { sellerAuthorityScriptHex: bobScript },
    { expiryHeight: terms.expiryHeight + 1 },
    { nonceHex: "cd".repeat(32) },
  ])
    expect(p.escrowCustody({ ...terms, ...changed }).scriptHex).not.toBe(original);
  for (const changed of [
    { amountAtoms: 0n },
    { priceSats: 0n },
    { nonceHex: "ab" },
    { expiryHeight: 1.5 },
    { guardianPublicKeyHex: "00".repeat(32) },
    { unknown: true },
  ])
    expect(() => p.escrowCustody({ ...terms, ...changed })).toThrow();
  const funding = [chain.funding("alice")];
  for (const amountAtoms of [1n, 250n * unit + 1n, 400n * unit]) {
    const plan = p.buildEscrowListing({
      config,
      terms: { ...terms, amountAtoms },
      inputs: [input],
      funding,
    });
    expect(plan.outputs[1]!.atoms).toBe(amountAtoms);
    expect(plan.changeAtoms).toBe(input.atoms - amountAtoms);
  }
  expect(() =>
    p.buildEscrowListing({
      config,
      terms: { ...terms, guardianPublicKeyHex: hex(bobKey.publicKey.subarray(1)) },
      inputs: [input],
      funding,
    }),
  ).toThrow(/authority/);
});
test("Guardian rejects malformed funding and payouts; expiry blocks new signatures but permits an already signed late fill", () => {
  const { ledger, input, terms } = setup();
  const plan = p.buildEscrowListing({
    config,
    terms,
    inputs: [input],
    funding: [chain.funding("alice")],
  });
  const offer = p.escrowOffer(terms, {
    txid: p.parseRawTransaction(signed(plan)).txid,
    vout: 1,
    ...plan.outputs[1]!,
  });
  const listing = confirm(ledger, plan, undefined, [offer]);
  const purchase = p.buildEscrowPurchase({
    offer,
    currentHeight: listing.ledger.tip!.height,
    buyerFunding: [chain.funding("bob")],
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
  });
  const pending = { rawHex: walletSigned(purchase, "bob"), prevouts: purchase.inputs };
  const expired = {
    ...listing.ledger,
    tip: { ...listing.ledger.tip!, height: terms.expiryHeight },
  };
  expect(() => p.validateEscrowGuardianTransaction(expired, pending)).toThrow(/expired/);
  const unsigned = bitcoin.Transaction.fromHex(pending.rawHex);
  unsigned.setWitness(1, []);
  expect(() =>
    p.validateEscrowGuardianTransaction(listing.ledger, { ...pending, rawHex: unsigned.toHex() }),
  ).toThrow();
  const diverted = bitcoin.Transaction.fromHex(pending.rawHex);
  diverted.outs[0]!.script = Buffer.from(bobScript, "hex");
  expect(() =>
    p.validateEscrowGuardianTransaction(listing.ledger, { ...pending, rawHex: diverted.toHex() }),
  ).toThrow();
  const rawHex = signed(purchase, p.escrowCustody(terms), "bob");
  expect(() =>
    p.validateFinalTransaction(purchase, { rawHex, prevouts: purchase.inputs }, expired),
  ).not.toThrow();
  const keypath = bitcoin.Transaction.fromHex(rawHex);
  keypath.setWitness(0, [keypath.ins[0]!.witness[0]!]);
  expect(() =>
    p.validateFinalTransaction(
      purchase,
      { rawHex: keypath.toHex(), prevouts: purchase.inputs },
      listing.ledger,
    ),
  ).toThrow();
  let delayed = listing.ledger;
  while (delayed.tip!.height < terms.expiryHeight) {
    const empty = chain.block(chain.mine()[0]);
    delayed = p.applyConfirmedBlockDetailed(delayed, empty, { authorizations: [offer] }).ledger;
  }
  const txid = chain.broadcast(rawHex);
  const block = chain.block(chain.mine()[0]);
  const filled = p.applyConfirmedBlockDetailed(delayed, block, {
    authorizations: [offer],
  }).ledger;
  expect(filled.offers[p.offerId(offer)]!.status).toBe("filled");
  expect(() => p.validateEscrowGuardianTransaction(filled, pending)).toThrow();
  expect(txid).toBe(p.parseRawTransaction(rawHex).txid);
  expect(p.restoreLedger(p.snapshotLedger(filled))).toMatchObject({
    offers: filled.offers,
    allocations: filled.allocations,
  });
});

test("multi-input listing250.00000001 preserves exact atom change in one transaction", () => {
  const start = setup();
  const split = confirm(
    start.ledger,
    p.buildTransfer({
      network: "regtest",
      deployTxid: start.terms.deployTxid,
      ticker: config.ticker,
      input: start.input,
      amountAtoms: 200n * unit,
      recipientScriptHex: aliceScript,
      funding: [chain.funding("alice")],
    }),
  );
  const inputs = Object.entries(split.ledger.allocations)
    .filter(([, a]) => a.deployTxid === start.terms.deployTxid && a.scriptHex === aliceScript)
    .map(([point, a]) => ({ txid: point.split(":")[0]!, vout: Number(point.split(":")[1]), ...a }));
  expect(inputs).toHaveLength(2);
  const terms = { ...start.terms, amountAtoms: 250n * unit + 1n };
  const plan = p.buildEscrowListing({ config, terms, inputs, funding: [chain.funding("alice")] });
  expect(plan.transactions).toHaveLength(1);
  expect(plan.changeAtoms).toBe(150n * unit - 1n);
  const offer = p.escrowOffer(terms, {
    txid: p.parseRawTransaction(signed(plan)).txid,
    vout: 1,
    ...plan.outputs[1]!,
  });
  const listed = confirm(split.ledger, plan, undefined, [offer]);
  expect(listed.ledger.offers[p.offerId(offer)]!.listedInput.atoms).toBe(250n * unit + 1n);
});
