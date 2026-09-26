import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { encodeTransferV2 } from "@crclaunch/cove-wire/codec-v2";
import { verifyClientIntent, verifyListingIntent, unsignedTxDigestHex, LISTING_SIGHASH } from "./cove-intent.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const net = bitcoin.networks.regtest;
const me = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46));
const them = ECPair.fromPrivateKey(Buffer.alloc(32, 0x49));
const p2wpkh = (k: typeof me) => bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: net }).output!;
const hex = (b: Buffer) => b.toString("hex");

const SOURCE = { txid: "11".repeat(32), vout: 1 };

function listing(over: { payout?: Buffer; price?: number; carrier?: Buffer; outs?: number; sighash?: number | null } = {}) {
  const psbt = new bitcoin.Psbt({ network: net });
  psbt.addInput({ hash: SOURCE.txid, index: SOURCE.vout, witnessUtxo: { script: over.carrier ?? p2wpkh(me), value: 1000 } });
  if (over.sighash !== null) psbt.updateInput(0, { sighashType: over.sighash ?? LISTING_SIGHASH });
  psbt.addOutput({ script: over.payout ?? p2wpkh(me), value: over.price ?? 100_000 });
  for (let i = 1; i < (over.outs ?? 1); i++) psbt.addOutput({ script: p2wpkh(them), value: 1_000 });
  return psbt.toBase64();
}
const expectOk = { sourceTxid: SOURCE.txid, sourceVout: SOURCE.vout, carrierScript: hex(p2wpkh(me)), payoutScript: hex(p2wpkh(me)), priceSats: "100000" };

describe("verifyListingIntent — never blind-sign a standing offer", () => {
  it("accepts one own carrier for one exact payment to me, SINGLE|ACP", () => {
    expect(() => verifyListingIntent(listing(), expectOk, net)).not.toThrow();
  });
  it("refuses a payout to someone else, a different price, an extra output, a foreign carrier, or another sighash", () => {
    expect(() => verifyListingIntent(listing({ payout: p2wpkh(them) }), expectOk, net)).toThrow(/does not pay your wallet/);
    expect(() => verifyListingIntent(listing({ price: 99_999 }), expectOk, net)).toThrow(/pays 99999/);
    expect(() => verifyListingIntent(listing({ outs: 2 }), expectOk, net)).toThrow(/one coin for one payment/);
    expect(() => verifyListingIntent(listing({ carrier: p2wpkh(them) }), expectOk, net)).toThrow(/not on your token address/);
    expect(() => verifyListingIntent(listing({ sighash: bitcoin.Transaction.SIGHASH_ALL }), expectOk, net)).toThrow(/SINGLE\|ANYONECANPAY/);
    expect(() => verifyListingIntent(listing(), { ...expectOk, sourceVout: 0 }, net)).toThrow(/different coin/);
  });
});

describe("verifyClientIntent — SPLIT (list part of a coin)", () => {
  const tokenId = Buffer.alloc(32, 0x0b);
  function split(recipient: Buffer) {
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: "22".repeat(32), index: 0, witnessUtxo: { script: p2wpkh(me), value: 1000 } });
    psbt.addInput({ hash: "33".repeat(32), index: 0, witnessUtxo: { script: p2wpkh(me), value: 10_000 } });
    const wire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: 400n }, { vout: 2, amount: 600n }] });
    psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
    psbt.addOutput({ script: recipient, value: 1000 });
    psbt.addOutput({ script: p2wpkh(me), value: 1000 });
    psbt.addOutput({ script: p2wpkh(me), value: 8_000 });
    return psbt;
  }
  const intentFor = (psbt: bitcoin.Psbt) => ({
    operation: "SPLIT",
    tokenId: tokenId.toString("hex"),
    tokenAmountAtoms: "400",
    grossSats: null,
    protocolFeeSats: null,
    minerFeeSats: "1000",
    netSats: null,
    walletScript: hex(p2wpkh(me)),
    ordinalsScript: hex(p2wpkh(me)),
    stateHash: null,
    unsignedTxDigest: unsignedTxDigestHex(psbt),
  });
  it("accepts a split that keeps every token and makes an exact coin", () => {
    const psbt = split(p2wpkh(me));
    expect(() => verifyClientIntent(psbt.toBase64(), intentFor(psbt), net)).not.toThrow();
  });
  it("refuses a 'split' that sends tokens away", () => {
    const psbt = split(p2wpkh(them));
    expect(() => verifyClientIntent(psbt.toBase64(), intentFor(psbt), net)).toThrow(/keep every token|splitting costs/);
  });
});
