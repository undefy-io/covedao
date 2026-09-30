import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import fixture from "./leaf-sale-mainnet.fixture.json";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const realSale = bitcoin.Transaction.fromHex(fixture.hex);
const sellerScript = Buffer.from(fixture.sellerPrevouts[0]!.scriptHex, "hex");
const sellerValue = fixture.sellerPrevouts[0]!.valueSats;
const sellerWitness = realSale.ins
  .slice(0, 2)
  .map((input) => input.witness.map((part) => Buffer.from(part)));
const ownKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x51));
const ownScript = bitcoin.payments.p2wpkh({ pubkey: ownKey.publicKey }).output!;

function signatureValid(
  tx: bitcoin.Transaction,
  inputIndex: number,
  witness: Buffer[],
  inputValueSats = sellerValue,
) {
  const decoded = bitcoin.script.signature.decode(witness[0]!);
  const scriptCode = bitcoin.payments.p2pkh({ pubkey: witness[1]! }).output!;
  const sighash = tx.hashForWitnessV0(inputIndex, scriptCode, inputValueSats, decoded.hashType);
  return ecc.verify(sighash, witness[1]!, decoded.signature);
}

function signOwnInput(tx: bitcoin.Transaction, index: number, valueSats: number) {
  const scriptCode = bitcoin.payments.p2pkh({ pubkey: ownKey.publicKey }).output!;
  const hash = tx.hashForWitnessV0(index, scriptCode, valueSats, bitcoin.Transaction.SIGHASH_ALL);
  const signature = bitcoin.script.signature.encode(
    Buffer.from(ownKey.sign(hash)),
    bitcoin.Transaction.SIGHASH_ALL,
  );
  tx.setWitness(index, [signature, Buffer.from(ownKey.publicKey)]);
  return signatureValid(tx, index, tx.ins[index]!.witness, valueSats);
}

describe("archived LEAF market sale seller signatures", () => {
  it("verifies both real P2WPKH seller signatures as SINGLE|ANYONECANPAY", () => {
    expect(Buffer.from(realSale.ins[0]!.hash).reverse().toString("hex")).toBe(
      fixture.sellerPrevouts[0]!.txid,
    );
    expect(Buffer.from(realSale.ins[1]!.hash).reverse().toString("hex")).toBe(
      fixture.sellerPrevouts[1]!.txid,
    );
    expect(realSale.ins[0]!.index).toBe(0);
    expect(realSale.ins[1]!.index).toBe(1);
    expect(sellerScript).toEqual(bitcoin.payments.p2wpkh({ pubkey: sellerWitness[0]![1]! }).output);
    for (const index of [0, 1]) {
      expect(bitcoin.script.signature.decode(sellerWitness[index]![0]!).hashType).toBe(0x83);
      expect(signatureValid(realSale, index, sellerWitness[index]!)).toBe(true);
    }
  });

  it("binds seller input zero to BTC payout, but not marker or recipient", () => {
    const changed = realSale.clone();
    changed.outs[0]!.value += 1;
    expect(signatureValid(changed, 0, sellerWitness[0]!)).toBe(false);
    expect(signatureValid(changed, 1, sellerWitness[1]!)).toBe(true);

    const changedRecipient = realSale.clone();
    changedRecipient.outs[2]!.script = ownScript;
    expect(signatureValid(changedRecipient, 0, sellerWitness[0]!)).toBe(true);
    expect(signatureValid(changedRecipient, 1, sellerWitness[1]!)).toBe(true);
  });

  it("binds seller input one to CRC marker, but not payout or recipient", () => {
    const changed = realSale.clone();
    changed.outs[1]!.script = bitcoin.script.compile([
      bitcoin.opcodes.OP_RETURN!,
      Buffer.from("different"),
    ]);
    expect(signatureValid(changed, 0, sellerWitness[0]!)).toBe(true);
    expect(signatureValid(changed, 1, sellerWitness[1]!)).toBe(false);
  });

  it("cannot reuse either seller signature at the wrong input index without moving its paired output", () => {
    const changed = realSale.clone();
    [changed.ins[0], changed.ins[1]] = [changed.ins[1]!, changed.ins[0]!];
    expect(signatureValid(changed, 0, sellerWitness[1]!)).toBe(false);
    expect(signatureValid(changed, 1, sellerWitness[0]!)).toBe(false);
  });

  it("allows a valid seller marker signature with no seller payout input", () => {
    const tx = new bitcoin.Transaction();
    tx.version = realSale.version;
    tx.locktime = realSale.locktime;
    const ownValue = 10_000;
    tx.addInput(Buffer.alloc(32, 0x72), 0, realSale.ins[0]!.sequence);
    tx.addInput(realSale.ins[1]!.hash, realSale.ins[1]!.index, realSale.ins[1]!.sequence);
    tx.addOutput(ownScript, 500);
    tx.addOutput(realSale.outs[1]!.script, 0);
    tx.addOutput(ownScript, 330);
    tx.setWitness(1, sellerWitness[1]!);
    expect(signatureValid(tx, 1, sellerWitness[1]!)).toBe(true);
    expect(signOwnInput(tx, 0, ownValue)).toBe(true);
    expect(tx.outs[0]!.script).toEqual(ownScript);
    expect(tx.outs[2]!.script).toEqual(ownScript);
  });

  it("moves the marker-signed seller input to index zero and pays that seller nothing", () => {
    const tx = new bitcoin.Transaction();
    tx.version = realSale.version;
    tx.locktime = realSale.locktime;
    tx.addInput(realSale.ins[1]!.hash, realSale.ins[1]!.index, realSale.ins[1]!.sequence);
    tx.addInput(Buffer.alloc(32, 0x75), 0, 0xffffffff);
    tx.addOutput(realSale.outs[1]!.script, 0);
    tx.addOutput(ownScript, 330);
    tx.addOutput(ownScript, 9_000);
    tx.setWitness(0, sellerWitness[1]!);
    expect(signatureValid(tx, 0, sellerWitness[1]!)).toBe(true);
    expect(signOwnInput(tx, 1, 10_000)).toBe(true);
    expect(tx.outs[0]!.value).toBe(0);
    expect(tx.outs[1]!.script).toEqual(ownScript);
    expect(
      tx.ins.map((input) => `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`),
    ).not.toContain(`${fixture.sellerPrevouts[0]!.txid}:0`);
  });

  it("retains only the payout-signed seller input while changing the marker amount", () => {
    const tx = new bitcoin.Transaction();
    tx.version = realSale.version;
    tx.locktime = realSale.locktime;
    tx.addInput(realSale.ins[0]!.hash, realSale.ins[0]!.index, realSale.ins[0]!.sequence);
    tx.addInput(Buffer.alloc(32, 0x76), 0, 0xffffffff);
    tx.addOutput(realSale.outs[0]!.script, realSale.outs[0]!.value);
    const marker = Buffer.from(
      JSON.stringify({ p: "crc-20", op: "transfer", tick: "LEAF", amt: "999999999999999" }),
    );
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, marker]), 0);
    tx.addOutput(ownScript, 330);
    tx.setWitness(0, sellerWitness[0]!);
    expect(signatureValid(tx, 0, sellerWitness[0]!)).toBe(true);
    expect(signOwnInput(tx, 1, realSale.outs[0]!.value + 10_000)).toBe(true);
    expect(tx.outs[1]!.script).not.toEqual(realSale.outs[1]!.script);
  });

  it("allows competing fully signed seller-side layouts; the shared UTXOs make only one confirmable", () => {
    for (const buyerInput of [0x73, 0x74]) {
      const tx = new bitcoin.Transaction();
      tx.version = realSale.version;
      tx.locktime = realSale.locktime;
      tx.addInput(realSale.ins[0]!.hash, realSale.ins[0]!.index, realSale.ins[0]!.sequence);
      tx.addInput(realSale.ins[1]!.hash, realSale.ins[1]!.index, realSale.ins[1]!.sequence);
      tx.addInput(Buffer.alloc(32, buyerInput), 0, 0xffffffff);
      tx.addOutput(realSale.outs[0]!.script, realSale.outs[0]!.value);
      tx.addOutput(realSale.outs[1]!.script, realSale.outs[1]!.value);
      tx.addOutput(ownScript, 330);
      tx.setWitness(0, sellerWitness[0]!);
      tx.setWitness(1, sellerWitness[1]!);
      expect(signatureValid(tx, 0, sellerWitness[0]!)).toBe(true);
      expect(signatureValid(tx, 1, sellerWitness[1]!)).toBe(true);
      expect(signOwnInput(tx, 2, 10_000)).toBe(true);
    }
  });
});
