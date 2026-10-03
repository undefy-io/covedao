import { test, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { readyTransactionId } from "./crc-ready-transaction";
const tx = new bitcoin.Transaction(); tx.addInput(Buffer.alloc(32, 1), 0, 0xfffffffe); tx.addOutput(Buffer.from("0014" + "12".repeat(20), "hex"), 1000);
const psbt = new bitcoin.Psbt(); psbt.setVersion(tx.version); psbt.addInput({hash:Buffer.alloc(32,1),index:0,sequence:0xfffffffe,witnessUtxo:{script:tx.outs[0]!.script,value:2000}}); psbt.addOutput(tx.outs[0]!);
const signed = tx.clone(); signed.ins[0]!.script = Buffer.from("160014" + "12".repeat(20), "hex"); signed.ins[0]!.witness = [Buffer.from("01","hex")];
test("checks txid and reviewed unsigned bytes while permitting wallet witness/scriptSig finalization", () => {
  expect(readyTransactionId(signed.toHex(), psbt.toBase64())).toBe(signed.getId());
  const changed = signed.clone(); changed.outs[0]!.value++;
  expect(() => readyTransactionId(changed.toHex(), psbt.toBase64())).toThrow("reviewed");
  expect(() => readyTransactionId("00", psbt.toBase64())).toThrow();
});
