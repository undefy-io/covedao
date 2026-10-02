/* global window, console, process, URL */
// Actual-extension capability test only. No keys, funding, RPC or broadcast.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "@crclaunch/crc20-protocol";
bitcoin.initEccLib(ecc);
const outputRoot = new URL(
  "../../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const connection = JSON.parse(readFileSync(new URL("xverse-real-connect.json", outputRoot), "utf8"))
  .connect.value.result;
if (connection.network.bitcoin.name !== "Signet") throw new Error("Signet required");
const purpose = process.argv[3] ?? "ordinals";
const account =
  purpose === "nested"
    ? JSON.parse(
        readFileSync(new URL("xverse-nested-connect.json", outputRoot), "utf8"),
      ).value.result.addresses.find((a) => a.purpose === "payment")
    : connection.addresses.find((a) => a.purpose === purpose);
if (!account) throw new Error("missing test account");
const script = bitcoin.address
  .toOutputScript(account.address, bitcoin.networks.testnet)
  .toString("hex");
const termAccount =
  purpose === "nested" ? connection.addresses.find((a) => a.purpose === "ordinals") : account;
const termScript = bitcoin.address
  .toOutputScript(termAccount.address, bitcoin.networks.testnet)
  .toString("hex");
const redeem =
  account.addressType === "p2sh"
    ? bitcoin.payments.p2wpkh({ pubkey: Buffer.from(account.publicKey, "hex") }).output
    : undefined;
const terms = {
  network: "signet",
  deployTxid: "a".repeat(64),
  ticker: "CAPTEST",
  listedInput: {
    txid: "b".repeat(64),
    vout: 0,
    atoms: 123456789n,
    sats: 1000n,
    scriptHex: termScript,
  },
  sellerScriptHex: termScript,
  priceSats: 12347n,
  expiryHeight: 1000000,
  publicKeyHex: core.canonicalOfferPublicKey(termAccount.publicKey, termScript),
};
const message = core.offerMessage(terms);
const serialize = (value) =>
  JSON.stringify(value, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n";
const port = readFileSync("/tmp/crc-xverse-cdp-port", "utf8");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const app = pages.find((page) => page.url() === "http://127.0.0.1:3000/wallet");
  if (!app) throw new Error("isolated capability browser missing");
  const action = process.argv[2];
  const currentNetwork = await app.evaluate(() =>
    window.XverseProviders.BitcoinProvider.request("wallet_getNetwork", null),
  );
  if (currentNetwork.result?.bitcoin?.name !== "Signet") throw new Error("wallet must be Signet");
  if (purpose === "nested" && action !== "buyer") throw new Error("nested is funding only");
  let method, params;
  if (action === "message") {
    method = "signMessage";
    params = { address: account.address, message, protocol: "BIP322" };
  } else if (action === "buyer") {
    method = "signPsbt";
    const sellerPurpose = purpose === "ordinals" ? "payment" : "ordinals";
    const saved = JSON.parse(
      readFileSync(new URL(`xverse-${sellerPurpose}-offer.json`, outputRoot), "utf8"),
    );
    const offer = saved.offer;
    offer.listedInput.atoms = BigInt(offer.listedInput.atoms);
    offer.listedInput.sats = BigInt(offer.listedInput.sats);
    offer.priceSats = BigInt(offer.priceSats);
    const plan = core.buildPurchase({
      offer,
      currentHeight: 0,
      buyerFunding: [
        {
          txid: "c".repeat(64),
          vout: 0,
          sats: 100000n,
          scriptHex: script,
          ...(redeem ? { redeemScriptHex: redeem.toString("hex") } : {}),
        },
      ],
      buyerScriptHex: script,
      protocolScriptHex: `0014${"11".repeat(20)}`,
      minerFeeSats: 1000n,
    });
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    psbt.setVersion(2);
    psbt.setLocktime(0);
    plan.inputs.forEach((input, index) =>
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        sequence: 0xfffffffe,
        witnessUtxo: { script: Buffer.from(input.scriptHex, "hex"), value: Number(input.sats) },
        ...(index === 0
          ? {
              finalScriptWitness: Buffer.from(
                core.encodeMessageWitness(offer.sellerWitnessHex),
                "hex",
              ),
            }
          : {
              sighashType: 1,
              ...(redeem ? { redeemScript: redeem } : {}),
              ...(account.addressType === "p2tr"
                ? { tapInternalKey: Buffer.from(account.publicKey, "hex") }
                : {}),
            }),
      }),
    );
    for (const output of plan.outputs)
      psbt.addOutput({ script: Buffer.from(output.scriptHex, "hex"), value: Number(output.sats) });
    writeFileSync(
      new URL(`xverse-buyer-${purpose}-plan.json`, outputRoot),
      serialize({ plan, offer, sellerPurpose }),
    );
    params = { psbt: psbt.toBase64(), signInputs: { [account.address]: [1] }, broadcast: false };
  } else if (action === "seller") {
    method = "signPsbt";
    const tx = core.offerSigningTransaction(terms);
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    psbt.setVersion(tx.version);
    psbt.setLocktime(tx.locktime);
    psbt.addInput({
      hash: tx.inputs[0].txid,
      index: tx.inputs[0].vout,
      sequence: tx.inputs[0].sequence,
      witnessUtxo: { script: Buffer.from(script, "hex"), value: 1000 },
      sighashType: action === "seller" ? 131 : 1,
      ...(account.addressType === "p2tr"
        ? { tapInternalKey: Buffer.from(account.publicKey, "hex") }
        : {}),
    });
    for (const output of tx.outputs)
      psbt.addOutput({ script: Buffer.from(output.scriptHex, "hex"), value: Number(output.sats) });
    params = { psbt: psbt.toBase64(), signInputs: { [account.address]: [0] }, broadcast: false };
  } else throw new Error("action must be message, seller or buyer");
  writeFileSync(
    new URL(`xverse-${action}-${purpose}-request.json`, outputRoot),
    serialize({
      walletVersion: "2.9.3",
      unfunded: true,
      syntheticPrevout: action !== "message",
      terms,
      method,
      params,
    }),
  );
  await app.evaluate(
    ({ method, params }) => {
      window.__crcSigningProbe = { state: "pending" };
      window.XverseProviders.BitcoinProvider.request(method, params).then(
        (value) => (window.__crcSigningProbe = { state: "resolved", value }),
        (error) => (window.__crcSigningProbe = { state: "rejected", error: String(error) }),
      );
    },
    { method, params },
  );
  console.log(`Started actual ${method} for ${purpose}; broadcast disabled.`);
} finally {
  await browser.close();
}
