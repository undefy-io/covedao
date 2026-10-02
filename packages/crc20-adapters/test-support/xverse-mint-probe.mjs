/* global window, console, URL */
// Known Guardian test key only; actual wallet keys stay inside the extension.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import * as adapters from "../dist/index.js";
const ecc = createRequire(
  new URL("../../cove-market/crc20-protocol/package.json", import.meta.url),
)("tiny-secp256k1");
const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const guardianRequest = read("xverse-guardian-request.json");
const witness = core
  .decodeWitness(
    bitcoin.Psbt.fromBase64(guardianRequest.params.psbt).data.inputs[0].finalScriptWitness.toString(
      "hex",
    ),
  )
  .map((w) => Buffer.from(w));
const account = read("xverse-nested-connect.json").value.result.addresses.find(
  (a) => a.purpose === "payment",
);
const redeem = bitcoin.payments
  .p2wpkh({ pubkey: Buffer.from(account.publicKey, "hex") })
  .output.toString("hex");
const script = bitcoin.address
  .toOutputScript(account.address, bitcoin.networks.testnet)
  .toString("hex");
const custody = {
  assetCommitmentHex: witness[1].toString("hex"),
  guardianPublicKeyHex: Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 1)))
    .subarray(1)
    .toString("hex"),
  executionScriptHex: witness[2].toString("hex"),
  controlBlockHex: witness[3].toString("hex"),
  recoveryLeafHashHex: bitcoin.crypto
    .taggedHash("TapLeaf", Buffer.from("c00151", "hex"))
    .toString("hex"),
};
const config = core.guardianConfig(
  {
    network: "signet",
    ticker: "CAPTEST",
    vaultScriptHex: guardianRequest.prevouts[0].scriptHex,
    creatorScriptHex: script,
    protocolScriptHex: script,
  },
  custody,
);
const state = {
  config,
  deployTxid: "a".repeat(64),
  issuedAtoms: 0n,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: { ...guardianRequest.prevouts[0], sats: 1000n },
};
const plan = core.buildMint({
  state,
  funding: [
    { txid: "f".repeat(64), vout: 0, sats: 100000n, scriptHex: script, redeemScriptHex: redeem },
  ],
  amountAtoms: 10000000000n,
  recipientScriptHex: script,
  minerFeeSats: 1000n,
});
const tx = new bitcoin.Transaction();
tx.version = 2;
plan.inputs.forEach((p) => tx.addInput(Buffer.from(p.txid, "hex").reverse(), p.vout, 0xfffffffe));
plan.outputs.forEach((o) => tx.addOutput(Buffer.from(o.scriptHex, "hex"), Number(o.sats)));
const leaf = bitcoin.crypto.taggedHash(
  "TapLeaf",
  Buffer.concat([Buffer.from([0xc0, witness[2].length]), witness[2]]),
);
const digest = tx.hashForWitnessV1(
  0,
  plan.inputs.map((p) => Buffer.from(p.scriptHex, "hex")),
  plan.inputs.map((p) => Number(p.sats)),
  1,
  leaf,
);
witness[0] = Buffer.concat([
  Buffer.from(ecc.signSchnorr(digest, Buffer.alloc(32, 1))),
  Buffer.from([1]),
]);
const options = {
  network: "signet",
  walletInputs: [{ index: 1, ...account }],
  finalizedWitnesses: { 0: witness.map((w) => w.toString("hex")) },
};
const prepared = adapters.preparePlanSigning(plan, options);
writeFileSync(
  new URL("xverse-core-mint-request.json", root),
  JSON.stringify(
    core.encodeProtocolDto({
      state,
      plan,
      options,
      prepared,
      testGuardianFixture: true,
      syntheticPrevoutsNotBroadcast: true,
    }),
    null,
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
  if (network.result?.bitcoin?.name !== "Signet") throw new Error("Signet required");
  await app.evaluate((params) => {
    window.__crcSigningProbe = { state: "pending" };
    window.XverseProviders.BitcoinProvider.request("signPsbt", params).then(
      (value) => (window.__crcSigningProbe = { state: "resolved", value }),
      (error) => (window.__crcSigningProbe = { state: "rejected", error: String(error) }),
    );
  }, prepared.params);
  console.log(
    "Actual core mint plan; synthetic inputs; broadcast:false; known test Guardian fixture.",
  );
} finally {
  await browser.close();
}
