import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";
import type { Input } from "./types.js";
test("verify finalized Guardian input before requesting unfinished wallet input", () => {
  const request = JSON.parse(
    readFileSync(
      new URL(
        "../../../artifacts/crc-core-integration/wallet-capabilities/xverse-guardian-request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const psbt = bitcoin.Psbt.fromBase64(request.params.psbt);
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  tx.setWitness(
    0,
    core
      .decodeWitness(psbt.data.inputs[0]!.finalScriptWitness!.toString("hex"))
      .map((h) => Buffer.from(h)),
  );
  const prevouts = request.prevouts.map((p: Input) => ({ ...p, sats: BigInt(p.sats) }));
  core.verifyInputSignature(core.parseRawTransaction(tx.toHex()), prevouts, 0);
  expect(() =>
    core.verifyInputSignature(core.parseRawTransaction(tx.toHex()), prevouts, 1),
  ).toThrow();
  expect(() =>
    core.verifyInputSignature(core.parseRawTransaction(tx.toHex()), prevouts, 2),
  ).toThrow();
  tx.outs[0]!.value--;
  expect(() =>
    core.verifyInputSignature(core.parseRawTransaction(tx.toHex()), prevouts, 0),
  ).toThrow();
});
