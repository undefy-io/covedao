import { authorizeOffer } from "./test-support/signing.js";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "./index.js";
import { aliceKey, aliceScript } from "./test-support/core.js";

bitcoin.initEccLib(ecc);
const internal = aliceKey.publicKey.subarray(1);
const taproot = bitcoin.payments.p2tr({ internalPubkey: internal }).output!.toString("hex");
const tweaked = ecc.privateAdd(
  aliceKey.publicKey[0] === 3 ? ecc.privateNegate(aliceKey.privateKey!) : aliceKey.privateKey!,
  bitcoin.crypto.taggedHash("TapTweak", internal),
)!;
const terms = (scriptHex: string) => ({
  network: "regtest",
  ticker: "TEST",
  deployTxid: "a".repeat(64),
  listedInput: { txid: "b".repeat(64), vout: 1, sats: 1000n, atoms: 123456789n, scriptHex },
  sellerScriptHex: scriptHex,
  priceSats: 12347n,
  expiryHeight: 200,
  publicKeyHex: aliceKey.publicKey.toString("hex"),
});
// Independent wallet stand-in: bitcoinjs virtual transactions and its signature hashes.
function bip322(scriptHex: string, message: string, aux?: Uint8Array): string {
  const spend = new bitcoin.Transaction();
  spend.version = 0;
  spend.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0,
    bitcoin.script.compile([
      bitcoin.opcodes.OP_0,
      bitcoin.crypto.sha256(
        Buffer.concat([
          bitcoin.crypto.sha256(Buffer.from("BIP0322-signed-message")),
          bitcoin.crypto.sha256(Buffer.from("BIP0322-signed-message")),
          Buffer.from(message),
        ]),
      ),
    ]),
  );
  spend.addOutput(Buffer.from(scriptHex, "hex"), 0);
  const sign = new bitcoin.Transaction();
  sign.version = 0;
  sign.addInput(spend.getHash(), 0, 0);
  sign.addOutput(Buffer.from("6a", "hex"), 0);
  const witness =
    scriptHex === aliceScript
      ? [
          bitcoin.script.signature.encode(
            Buffer.from(
              ecc.sign(
                sign.hashForWitnessV0(
                  0,
                  Buffer.from(`76a914${aliceScript.slice(4)}88ac`, "hex"),
                  0,
                  1,
                ),
                aliceKey.privateKey!,
              ),
            ),
            1,
          ),
          aliceKey.publicKey,
        ]
      : [
          Buffer.from(
            ecc.signSchnorr(
              sign.hashForWitnessV1(0, [Buffer.from(scriptHex, "hex")], [0], 0),
              tweaked,
              aux,
            ),
          ),
        ];
  return Buffer.concat([
    Buffer.from([witness.length]),
    ...witness.flatMap((w) => [Buffer.from([w.length]), w]),
  ]).toString("hex");
}
function presign(t: ReturnType<typeof terms>): string[] {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(t.listedInput.txid, "hex").reverse(), t.listedInput.vout, 0xfffffffe);
  tx.addOutput(Buffer.from(t.sellerScriptHex, "hex"), Number(t.priceSats + t.listedInput.sats));
  if (t.sellerScriptHex === aliceScript)
    return [
      bitcoin.script.signature
        .encode(
          Buffer.from(
            ecc.sign(
              tx.hashForWitnessV0(
                0,
                Buffer.from(`76a914${aliceScript.slice(4)}88ac`, "hex"),
                1000,
                131,
              ),
              aliceKey.privateKey!,
            ),
          ),
          131,
        )
        .toString("hex"),
      aliceKey.publicKey.toString("hex"),
    ];
  return [
    Buffer.concat([
      Buffer.from(
        ecc.signSchnorr(
          tx.hashForWitnessV1(0, [Buffer.from(t.sellerScriptHex, "hex")], [1000], 131),
          tweaked,
        ),
      ),
      Buffer.from([131]),
    ]).toString("hex"),
  ];
}

test.each([aliceScript, taproot])(
  "external wallet authorizations bind all terms and reusable witness for %s",
  (script) => {
    const t = terms(script);
    const message = core.offerMessage(t);
    const signatureHex = bip322(script, message);
    const witness = presign(t);
    const offer = core.attachOfferAuthorization(t, signatureHex, witness);
    expect(() => core.verifyOffer(offer)).not.toThrow();
    for (const change of [
      { priceSats: 12348n },
      { expiryHeight: 201 },
      { network: "signet" },
      { ticker: "TAMPER" },
      { publicKeyHex: `02${"ff".repeat(32)}` },
      { sellerScriptHex: script === aliceScript ? taproot : aliceScript },
      { listedInput: { ...t.listedInput, vout: 2 } },
      { deployTxid: "c".repeat(64) },
      { listedInput: { ...t.listedInput, atoms: 123456788n } },
      { listedInput: { ...t.listedInput, txid: "d".repeat(64) } },
      { listedInput: { ...t.listedInput, sats: 1001n } },
    ])
      expect(() => core.verifyOffer({ ...offer, ...change })).toThrow();
    expect(() => core.attachOfferAuthorization(t, signatureHex + "00", witness)).toThrow();
    expect(() =>
      core.attachOfferAuthorization(t, signatureHex, [
        witness[0]!.slice(0, -2) + "01",
        ...witness.slice(1),
      ]),
    ).toThrow();
    expect(() =>
      core.attachOfferAuthorization(t, bip322(script, "unbound message"), witness),
    ).toThrow();
  },
);

test("strict wallet BIP322 witness decoding rejects oversized and noncanonical vectors", () => {
  const t = terms(aliceScript),
    witness = presign(t);
  for (const bad of [
    "",
    "00",
    "fd0200",
    "ff" + "00".repeat(8),
    "01ff" + "ff".repeat(8),
    "01",
    "02" + "00".repeat(2000),
  ])
    expect(() => core.attachOfferAuthorization(t, bad, witness)).toThrow();
});

test("Taproot listings and private test helper use the same wallet-signable offer scheme", async () => {
  const t = terms(taproot);
  const { publicKeyHex, ...withoutKey } = t;
  expect(publicKeyHex).toBe(aliceKey.publicKey.toString("hex"));
  const offer = await authorizeOffer(withoutKey, aliceKey.privateKey!);
  expect(offer.signatureHex).toBe(bip322(taproot, core.offerMessage(t)));
  expect(offer.sellerWitnessHex[0]!.slice(-2)).toBe("83");
  expect(
    core.buildListing({
      ...t,
      input: t.listedInput,
      amountAtoms: 1n,
      funding: [{ txid: "e".repeat(64), vout: 0, sats: 5000n, scriptHex: aliceScript }],
      changeScriptHex: aliceScript,
    }).listedAtoms,
  ).toBe(1n);
});

test("Core confirms a fractional Taproot listing and buyer-only presigned fill with exact allocations", async () => {
  const { Core, bobScript } = await import("./test-support/core.js");
  const chain = new Core();
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: aliceScript,
    creatorScriptHex: aliceScript,
    protocolScriptHex: aliceScript,
  };
  let ledger = core.emptyLedger(config);
  const excluded = () =>
    new Set(
      Object.keys(ledger.allocations).concat(
        Object.values(ledger.assets).map((a) => core.outpoint(a.vault)),
      ),
    );
  const confirm = (plan: core.Plan, rawHex: string) => {
    core.validateFinalTransaction(plan, { rawHex, prevouts: plan.inputs }, ledger);
    expect(chain.accepted(rawHex).allowed).toBe(true);
    const txid = chain.broadcast(rawHex),
      [blockHash] = chain.mine();
    const block = chain.block(blockHash);
    const before = ledger;
    ledger = core.applyBlock(ledger, block);
    expect(core.rollbackBlock(ledger, blockHash)).toEqual(before);
    const actual = chain.transaction(txid);
    expect(core.validateFinalTransaction(plan, actual, before)).toBe(txid);
    return txid;
  };
  try {
    chain.start();
    const deploy = core.buildDeploy({
      config,
      funding: [chain.funding("alice", excluded())],
      changeScriptHex: aliceScript,
    });
    const deployTxid = confirm(deploy, chain.sign(deploy));
    const mint = core.buildMint({
      state: ledger.assets[deployTxid]!,
      amountAtoms: 50000000000n,
      recipientScriptHex: taproot,
      changeScriptHex: aliceScript,
      funding: [chain.funding("alice", excluded())],
    });
    const mintTxid = confirm(mint, chain.sign(mint));
    const carrier = { txid: mintTxid, vout: 1, ...ledger.allocations[`${mintTxid}:1`]! };
    const listing = core.buildListing({
      network: "regtest",
      ticker: "TEST",
      deployTxid,
      input: carrier,
      amountAtoms: 123456789n,
      sellerScriptHex: taproot,
      priceSats: 12347n,
      funding: [chain.funding("alice", excluded())],
      changeScriptHex: aliceScript,
    });
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    listing.inputs.forEach((i) =>
      tx.addInput(Buffer.from(i.txid, "hex").reverse(), i.vout, 0xfffffffe),
    );
    listing.outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, "hex"), Number(o.sats)));
    tx.setWitness(0, [
      Buffer.concat([
        Buffer.from(
          ecc.signSchnorr(
            tx.hashForWitnessV1(
              0,
              listing.inputs.map((i) => Buffer.from(i.scriptHex, "hex")),
              listing.inputs.map((i) => Number(i.sats)),
              1,
            ),
            tweaked,
          ),
        ),
        Buffer.from([1]),
      ]),
    ]);
    const signedListing = chain.rpc("signrawtransactionwithwallet", [tx.toHex()], "alice");
    expect(signedListing.complete).toBe(true);
    const listedTxid = confirm(listing, signedListing.hex);
    const listedInput = { txid: listedTxid, vout: 1, ...ledger.allocations[`${listedTxid}:1`]! };
    const t = { ...terms(taproot), deployTxid, listedInput, expiryHeight: 200 };
    const offer = core.attachOfferAuthorization(
      t,
      bip322(taproot, core.offerMessage(t)),
      presign(t),
    );
    ledger = await core.registerOffer(ledger, offer);
    const purchase = core.buildPurchase({
      offer,
      currentHeight: ledger.tip!.height,
      buyerFunding: [chain.funding("bob", excluded())],
      buyerScriptHex: bobScript,
      protocolScriptHex: aliceScript,
      changeScriptHex: bobScript,
    });
    const calls = chain.calls.length;
    const raw = chain.sign(purchase, ["bob"]);
    expect(chain.calls.slice(calls)).toEqual(["signrawtransactionwithwallet"]);
    const fillId = confirm(purchase, raw);
    expect(ledger.allocations[`${fillId}:2`]!.atoms).toBe(123456789n);
    expect(ledger.allocations[`${fillId}:2`]!.scriptHex).toBe(bobScript);
    expect(ledger.offers[core.offerId(offer)]!.status).toBe("filled");
    expect(purchase.sellerPayoutSats).toBe(12347n);
    expect(purchase.protocolFeeSats).toBe(1000n);
    expect(purchase.minerFeeSats).toBe(1000n);
    expect(bitcoin.Transaction.fromHex(raw).ins[0]!.witness.map((w) => w.toString("hex"))).toEqual(
      offer.sellerWitnessHex,
    );
  } finally {
    chain.stop();
  }
});

test("offer messages reject unsupported ownership and malformed identity before a wallet prompt", () => {
  const t = terms(aliceScript);
  for (const change of [
    { network: "mainnet" },
    { ticker: "bad ticker" },
    { deployTxid: "unknown" },
    { sellerScriptHex: "51" },
    { publicKeyHex: "02" + "ff".repeat(32) },
    { listedInput: { ...t.listedInput, scriptHex: taproot } },
    { listedInput: { ...t.listedInput, vout: -1 } },
    { listedInput: { ...t.listedInput, atoms: 0n } },
    { priceSats: 0n },
    { expiryHeight: NaN },
  ])
    expect(() => core.offerMessage({ ...t, ...change })).toThrow();
});

test("wallet retry with a new valid Schnorr proof preserves registered authorization and status", async () => {
  const t = terms(taproot),
    message = core.offerMessage(t);
  const first = core.attachOfferAuthorization(t, bip322(taproot, message), presign(t));
  const retry = core.attachOfferAuthorization(
    t,
    bip322(taproot, message, new Uint8Array(32).fill(7)),
    presign(t),
  );
  expect(retry.signatureHex).not.toBe(first.signatureHex);
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: aliceScript,
    creatorScriptHex: aliceScript,
    protocolScriptHex: aliceScript,
  };
  const ledger = {
    ...core.emptyLedger(config),
    assets: {
      [t.deployTxid]: {
        config,
        deployTxid: t.deployTxid,
        issuedAtoms: 50000000000n,
        inventoryAtoms: 0n,
        burnedAtoms: 0n,
        vault: { txid: "f".repeat(64), vout: 2, sats: 1014n, scriptHex: aliceScript },
      },
    },
    allocations: {
      [core.outpoint(t.listedInput)]: {
        atoms: t.listedInput.atoms,
        sats: 1000n,
        scriptHex: taproot,
        deployTxid: t.deployTxid,
      },
    },
  };
  const registered = await core.registerOffer(ledger, first);
  const unavailable = core.markOfferUnavailable(registered, core.offerId(first));
  const twice = await core.registerOffer(unavailable, retry);
  expect(twice.offers[core.offerId(first)]).toEqual(unavailable.offers[core.offerId(first)]);
  const changed = { ...t, priceSats: t.priceSats + 1n };
  const conflict = core.attachOfferAuthorization(
    changed,
    bip322(taproot, core.offerMessage(changed)),
    presign(changed),
  );
  await expect(core.registerOffer(registered, conflict)).rejects.toThrow(/conflicting/i);
});
