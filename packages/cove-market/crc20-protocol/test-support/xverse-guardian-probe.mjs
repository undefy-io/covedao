/* global window, console, URL */
// Isolated synthetic Guardian fixture; never uses/export wallet keys or broadcasts.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "@crclaunch/crc20-protocol";
bitcoin.initEccLib(ecc);
const root = new URL(
  "../../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const connection = JSON.parse(readFileSync(new URL("xverse-real-connect.json", root), "utf8"))
  .connect.value.result;
const account = connection.addresses.find((a) => a.purpose === "payment");
const key = Buffer.alloc(32, 1); // Publicly known test Guardian key, never a wallet key.
const publicKey = Buffer.from(ecc.pointFromScalar(key)).subarray(1);
const commitment = Buffer.alloc(32, 0x41);
const execution = bitcoin.script.compile([
  commitment,
  bitcoin.opcodes.OP_EQUALVERIFY,
  publicKey,
  bitcoin.opcodes.OP_CHECKSIG,
]);
const guardian = bitcoin.payments.p2tr({
  internalPubkey: Buffer.from(
    "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
    "hex",
  ),
  scriptTree: [{ output: execution }, { output: Buffer.from("51", "hex") }],
  redeem: { output: execution, redeemVersion: 0xc0 },
});
const payment = bitcoin.address.toOutputScript(account.address, bitcoin.networks.testnet);
const prevouts = [
  { txid: "d".repeat(64), vout: 0, sats: 1000n, scriptHex: guardian.output.toString("hex") },
  { txid: "e".repeat(64), vout: 0, sats: 100000n, scriptHex: payment.toString("hex") },
];
const tx = new bitcoin.Transaction();
tx.version = 2;
prevouts.forEach((p) => tx.addInput(Buffer.from(p.txid, "hex").reverse(), p.vout, 0xfffffffe));
tx.addOutput(payment, 100000);
const leaf = bitcoin.crypto.taggedHash(
  "TapLeaf",
  Buffer.concat([Buffer.from([0xc0, execution.length]), execution]),
);
const digest = tx.hashForWitnessV1(
  0,
  prevouts.map((p) => Buffer.from(p.scriptHex, "hex")),
  prevouts.map((p) => Number(p.sats)),
  1,
  leaf,
);
const witness = [
  Buffer.concat([Buffer.from(ecc.signSchnorr(digest, key)), Buffer.from([1])]),
  commitment,
  execution,
  guardian.witness.at(-1),
];
const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
psbt.setVersion(2);
prevouts.forEach((p, i) =>
  psbt.addInput({
    hash: p.txid,
    index: p.vout,
    sequence: 0xfffffffe,
    witnessUtxo: { script: Buffer.from(p.scriptHex, "hex"), value: Number(p.sats) },
    ...(i === 0
      ? {
          finalScriptWitness: Buffer.from(
            core.encodeMessageWitness(witness.map((w) => w.toString("hex"))),
            "hex",
          ),
        }
      : { sighashType: 1 }),
  }),
);
psbt.addOutput({ script: payment, value: 100000 });
const params = { psbt: psbt.toBase64(), signInputs: { [account.address]: [1] }, broadcast: false };
writeFileSync(
  new URL("xverse-guardian-request.json", root),
  JSON.stringify(
    {
      syntheticPrevouts: true,
      testGuardianFixture: true,
      recoveryLeaf: "OP_TRUE test fixture only; not selected production recovery",
      prevouts,
      method: "signPsbt",
      params,
    },
    (_, x) => (typeof x === "bigint" ? x.toString() : x),
    2,
  ) + "\n",
);
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${readFileSync("/tmp/crc-xverse-cdp-port", "utf8")}`,
);
try {
  const app = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === "http://127.0.0.1:3000/wallet");
  const network = await app.evaluate(() =>
    window.XverseProviders.BitcoinProvider.request("wallet_getNetwork", null),
  );
  if (network.result?.bitcoin?.name !== "Signet") throw new Error("wallet must be Signet");
  await app.evaluate((params) => {
    window.__crcSigningProbe = { state: "pending" };
    window.XverseProviders.BitcoinProvider.request("signPsbt", params).then(
      (value) => (window.__crcSigningProbe = { state: "resolved", value }),
      (error) => (window.__crcSigningProbe = { state: "rejected", error: String(error) }),
    );
  }, params);
  console.log("Started actual Guardian witness preservation probe; broadcast false.");
} finally {
  await browser.close();
}
