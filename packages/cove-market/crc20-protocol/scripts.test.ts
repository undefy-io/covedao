import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { Core, aliceKey, aliceScript } from "./test-support/core.js";
import { parseRawTransaction, verifySignatures } from "./wire.js";
import { hex } from "./bytes.js";
import type { Input } from "./types.js";

bitcoin.initEccLib(ecc);
const key = Buffer.from(aliceKey.publicKey).subarray(1);
const commit = Buffer.alloc(32, 0x41);
const script = bitcoin.script.compile([
  commit,
  bitcoin.opcodes.OP_EQUALVERIFY,
  key,
  bitcoin.opcodes.OP_CHECKSIG,
]);
const internalPubkey = Buffer.from(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
  "hex",
);
const guardian = bitcoin.payments.p2tr({
  internalPubkey,
  scriptTree: [{ output: script }, { output: Buffer.from("51", "hex") }],
  redeem: { output: script, redeemVersion: 0xc0 },
});
const nested = bitcoin.payments.p2sh({
  redeem: bitcoin.payments.p2wpkh({ pubkey: aliceKey.publicKey }),
});
const taproot = bitcoin.payments.p2tr({ internalPubkey: key });
const tweaked = ecc.privateAdd(
  aliceKey.publicKey[0] === 3 ? ecc.privateNegate(aliceKey.privateKey!) : aliceKey.privateKey!,
  bitcoin.crypto.taggedHash("TapTweak", key),
)!;

function signed(
  kind: "nested" | "taproot" | "guardian",
  hashType = 1,
  actual?: Pick<Input, "txid" | "vout">,
) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(
    actual ? Buffer.from(actual.txid, "hex").reverse() : Buffer.alloc(32, 0xaa),
    actual?.vout ?? 0,
    0xfffffffe,
  );
  tx.addOutput(Buffer.from(aliceScript, "hex"), 19000);
  const prevout: Input = {
    txid: actual?.txid ?? "aa".repeat(32),
    vout: actual?.vout ?? 0,
    sats: 20000n,
    scriptHex: (kind === "nested"
      ? nested
      : kind === "taproot"
        ? taproot
        : guardian
    ).output!.toString("hex"),
  };
  if (kind === "nested") {
    const digest = tx.hashForWitnessV0(
      0,
      bitcoin.script.compile([
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        bitcoin.crypto.hash160(aliceKey.publicKey),
        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG,
      ]),
      20000,
      hashType,
    );
    tx.setInputScript(0, bitcoin.script.compile([nested.redeem!.output!]));
    tx.setWitness(0, [
      bitcoin.script.signature.encode(
        Buffer.from(ecc.sign(digest, aliceKey.privateKey!)),
        hashType,
      ),
      aliceKey.publicKey,
    ]);
  } else {
    const leaf =
      kind === "guardian"
        ? bitcoin.crypto.taggedHash(
            "TapLeaf",
            Buffer.concat([Buffer.from([0xc0, script.length]), script]),
          )
        : undefined;
    const digest = tx.hashForWitnessV1(
      0,
      [Buffer.from(prevout.scriptHex, "hex")],
      [20000],
      hashType,
      leaf,
    );
    const sig = Buffer.from(
      ecc.signSchnorr(digest, kind === "guardian" ? aliceKey.privateKey! : tweaked),
    );
    const withType = hashType === 0 ? sig : Buffer.concat([sig, Buffer.from([hashType])]);
    tx.setWitness(
      0,
      kind === "guardian" ? [withType, commit, script, guardian.witness!.at(-1)!] : [withType],
    );
  }
  return { tx, prevout };
}

test.each(["nested", "taproot", "guardian"] as const)(
  "verify independently signed %s input, binding actual prevout and payout",
  (kind) => {
    const { tx, prevout } = signed(kind);
    expect(() => verifySignatures(parseRawTransaction(tx.toHex()), [prevout])).not.toThrow();
    const changed = tx.clone();
    changed.outs[0]!.value--;
    expect(() => verifySignatures(parseRawTransaction(changed.toHex()), [prevout])).toThrow();
    expect(() =>
      verifySignatures(parseRawTransaction(tx.toHex()), [{ ...prevout, sats: 20001n }]),
    ).toThrow();
    expect(() =>
      verifySignatures(parseRawTransaction(tx.toHex()), [{ ...prevout, txid: "bb".repeat(32) }]),
    ).toThrow();
  },
);

test("Taproot DEFAULT is accepted; explicit zero flag and unauthorized 0x83 are refused", () => {
  const { tx, prevout } = signed("taproot", 0);
  expect(() => verifySignatures(parseRawTransaction(tx.toHex()), [prevout])).not.toThrow();
  tx.setWitness(0, [Buffer.concat([tx.ins[0]!.witness[0]!, Buffer.from([0])])]);
  expect(() => verifySignatures(parseRawTransaction(tx.toHex()), [prevout])).toThrow();
  const seller = signed("taproot", 131);
  expect(() =>
    verifySignatures(parseRawTransaction(seller.tx.toHex()), [seller.prevout]),
  ).toThrow();
  expect(() =>
    verifySignatures(
      parseRawTransaction(seller.tx.toHex()),
      [seller.prevout],
      "aa".repeat(32) + ":0",
    ),
  ).not.toThrow();
});

test("Guardian execution requires the actual commitment, control branch and parity", () => {
  const { tx, prevout } = signed("guardian", 0);
  for (const index of [1, 2, 3]) {
    const changed = tx.clone();
    const witness = changed.ins[0]!.witness.map((w) => Buffer.from(w));
    witness[index]![0] ^= 1;
    changed.setWitness(0, witness);
    expect(() => verifySignatures(parseRawTransaction(changed.toHex()), [prevout])).toThrow();
  }
  const extra = tx.clone();
  extra.setWitness(0, [...extra.ins[0]!.witness, Buffer.from("50", "hex")]);
  expect(() => verifySignatures(parseRawTransaction(extra.toHex()), [prevout])).toThrow();
  expect(hex(commit)).toBe("41".repeat(32));
});

test("nested signature cannot authorize a different redeem program or noncanonical scriptSig", () => {
  const { tx, prevout } = signed("nested");
  tx.setInputScript(0, Buffer.from("160014" + "22".repeat(20), "hex"));
  expect(() => verifySignatures(parseRawTransaction(tx.toHex()), [prevout])).toThrow();
});

test("Docker Core mines all three independently signed supported paths with exact fees", () => {
  const core = new Core();
  try {
    core.start();
    const funding = core.funding("alice");
    const scripts = [nested.output!, taproot.output!, guardian.output!];
    const parent = core.sign({
      inputs: [funding],
      outputs: [
        ...scripts.map((script) => ({ scriptHex: script.toString("hex"), sats: 20000n })),
        { scriptHex: aliceScript, sats: funding.sats - 61000n },
      ],
    });
    expect(core.accepted(parent).allowed).toBe(true);
    const parentId = core.broadcast(parent);
    core.mine();
    for (const [vout, kind] of (["nested", "taproot", "guardian"] as const).entries()) {
      const { tx, prevout } = signed(kind, kind === "guardian" ? 0 : 1, { txid: parentId, vout });
      const rawHex = tx.toHex();
      verifySignatures(parseRawTransaction(rawHex), [prevout]);
      expect(core.accepted(rawHex).allowed).toBe(true);
      const txid = core.broadcast(rawHex);
      core.mine();
      const observed = core.transaction(txid);
      verifySignatures(parseRawTransaction(observed.rawHex), observed.prevouts);
      expect(observed.prevouts).toEqual([prevout]);
      expect(parseRawTransaction(observed.rawHex).outputs).toEqual([
        { sats: 19000n, scriptHex: aliceScript },
      ]);
    }
  } finally {
    core.stop();
  }
});

test("registered replay derives proven nested redeem data from raw input rather than caller annotations", async () => {
  const core = await import("./index.js");
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: guardian.output!.toString("hex"),
    creatorScriptHex: taproot.output!.toString("hex"),
    protocolScriptHex: aliceScript,
  };
  const prevout: Input = {
    txid: "aa".repeat(32),
    vout: 0,
    sats: 20000n,
    scriptHex: nested.output!.toString("hex"),
  };
  const plan = core.buildDeploy({
    config,
    funding: [{ ...prevout, redeemScriptHex: nested.redeem!.output!.toString("hex") }],
    changeScriptHex: aliceScript,
  });
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0xaa), 0, 0xfffffffe);
  plan.outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, "hex"), Number(o.sats)));
  tx.setInputScript(0, bitcoin.script.compile([nested.redeem!.output!]));
  const digest = tx.hashForWitnessV0(
    0,
    Buffer.from(`76a914${aliceScript.slice(4)}88ac`, "hex"),
    20000,
    1,
  );
  tx.setWitness(0, [
    bitcoin.script.signature.encode(Buffer.from(ecc.sign(digest, aliceKey.privateKey!)), 1),
    aliceKey.publicKey,
  ]);
  const transaction = { rawHex: tx.toHex(), prevouts: [prevout] };
  const ledger = core.emptyLedger(config);
  const block = {
    hash: "dd".repeat(32),
    parentHash: "cc".repeat(32),
    height: 1,
    transactions: [transaction],
  };
  expect(core.validateFinalTransaction(plan, transaction, ledger)).toBe(tx.getId());
  expect(core.applyBlock(ledger, block).assets[tx.getId()]!.vault.scriptHex).toBe(
    config.vaultScriptHex,
  );
  expect(core.rollbackBlock(core.applyBlock(ledger, block), block.hash)).toEqual(ledger);
});

test("Guardian registration pins NUMS, asset commitment, controller and selected recovery branch", async () => {
  const core = await import("./index.js");
  const recoveryScript = Buffer.from("51", "hex");
  const custody = {
    assetCommitmentHex: commit.toString("hex"),
    guardianPublicKeyHex: key.toString("hex"),
    executionScriptHex: script.toString("hex"),
    controlBlockHex: guardian.witness!.at(-1)!.toString("hex"),
    recoveryLeafHashHex: bitcoin.crypto
      .taggedHash("TapLeaf", Buffer.concat([Buffer.from([0xc0, 1]), recoveryScript]))
      .toString("hex"),
  };
  expect(() =>
    core.validateGuardianCustody(guardian.output!.toString("hex"), custody),
  ).not.toThrow();
  for (const change of [
    { assetCommitmentHex: "42".repeat(32) },
    { guardianPublicKeyHex: "43".repeat(32) },
    { recoveryLeafHashHex: "44".repeat(32) },
    {
      controlBlockHex:
        (Number.parseInt(custody.controlBlockHex.slice(0, 2), 16) ^ 1).toString(16) +
        custody.controlBlockHex.slice(2),
    },
  ])
    expect(() =>
      core.validateGuardianCustody(guardian.output!.toString("hex"), { ...custody, ...change }),
    ).toThrow();
  expect(() => core.validateGuardianCustody(aliceScript, custody)).toThrow();
  expect(() => core.validateGuardianCustody(taproot.output!.toString("hex"), custody)).toThrow();
});

test("BIP341 hashes match bitcoinjs with mixed prevouts, input indexes and Guardian extension", async () => {
  const { taprootSignatureHash } = await import("./taproot.js");
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 123;
  const prevouts: Input[] = [
    { txid: "ab".repeat(32), vout: 7, sats: 12345n, scriptHex: taproot.output!.toString("hex") },
    { txid: "cd".repeat(32), vout: 3, sats: 23456n, scriptHex: guardian.output!.toString("hex") },
    { txid: "ef".repeat(32), vout: 2, sats: 34567n, scriptHex: nested.output!.toString("hex") },
  ];
  prevouts.forEach((p, i) =>
    tx.addInput(Buffer.from(p.txid, "hex").reverse(), p.vout, 0xfffffffa + i),
  );
  for (let i = 0; i < 3; i++) tx.addOutput(Buffer.from(aliceScript, "hex"), 10000 + i);
  const leaf = bitcoin.crypto.taggedHash(
    "TapLeaf",
    Buffer.concat([Buffer.from([0xc0, script.length]), script]),
  );
  for (const hashType of [0, 1, 131])
    for (const index of [0, 1, 2])
      for (const extension of [undefined, leaf]) {
        if (hashType === 131 && index === 2) continue; // Current Taproot input must be P2TR.
        expect(
          hex(
            taprootSignatureHash(
              parseRawTransaction(tx.toHex()),
              prevouts,
              index,
              hashType,
              extension,
            ),
          ),
        ).toBe(
          tx
            .hashForWitnessV1(
              index,
              prevouts.map((p) => Buffer.from(p.scriptHex, "hex")),
              prevouts.map((p) => Number(p.sats)),
              hashType,
              extension,
            )
            .toString("hex"),
        );
      }
});

test("Guardian custody rejects an execution controller that is not a curve point", async () => {
  const core = await import("./index.js");
  const badKey = Buffer.alloc(32, 0xff);
  const badScript = bitcoin.script.compile([
    commit,
    bitcoin.opcodes.OP_EQUALVERIFY,
    badKey,
    bitcoin.opcodes.OP_CHECKSIG,
  ]);
  const recovery = Buffer.from("51", "hex");
  const badVault = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree: [{ output: badScript }, { output: recovery }],
    redeem: { output: badScript, redeemVersion: 0xc0 },
  });
  expect(() =>
    core.validateGuardianCustody(badVault.output!.toString("hex"), {
      assetCommitmentHex: commit.toString("hex"),
      guardianPublicKeyHex: badKey.toString("hex"),
      executionScriptHex: badScript.toString("hex"),
      controlBlockHex: badVault.witness!.at(-1)!.toString("hex"),
      recoveryLeafHashHex: bitcoin.crypto
        .taggedHash("TapLeaf", Buffer.from("c00151", "hex"))
        .toString("hex"),
    }),
  ).toThrow(/controller/i);
});
