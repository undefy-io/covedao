import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

/**
 * Deterministic regtest E2E signing primitives (§21). These hold NO keys and
 * are used ONLY by the Playwright test harness (Node) with the deterministic
 * REGTEST fixture keys. They must NEVER be imported by a production client
 * bundle — the architecture gate scans for that.
 */

/** The sighash an input asks for, as the allowed list bitcoinjs wants; default otherwise. */
function sighashesFor(psbt: bitcoin.Psbt, index: number): number[] | undefined {
  const t = psbt.data.inputs[index]?.sighashType;
  return t === undefined ? undefined : [t];
}

export function signPsbtWithKey(psbtBase64: string, privKeyHex: string, network: bitcoin.networks.Network = bitcoin.networks.regtest): string {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  const key = ECPair.fromPrivateKey(Buffer.from(privKeyHex, "hex"), { network });
  const script = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network }).output!;
  const indexes: number[] = [];
  psbt.data.inputs.forEach((input, i) => {
    if (input.witnessUtxo && input.witnessUtxo.script.equals(script) && !input.partialSig?.length) indexes.push(i);
  });
  // Honour a requested sighash (a presigned listing asks for SINGLE|ANYONECANPAY).
  for (const i of indexes) psbt.signInput(i, key, sighashesFor(psbt, i));
  return psbt.toBase64();
}

/** BIP-322 simple signature as a P2WPKH wallet returns it: base64 witness stack. */
export function signBip322WithKey(message: string, privKeyHex: string, network: bitcoin.networks.Network = bitcoin.networks.regtest): string {
  const key = ECPair.fromPrivateKey(Buffer.from(privKeyHex, "hex"), { network });
  const payment = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network });
  const tag = bitcoin.crypto.sha256(Buffer.from("BIP0322-signed-message", "utf8"));
  const messageHash = bitcoin.crypto.sha256(Buffer.concat([tag, tag, Buffer.from(message, "utf8")]));

  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.addInput(Buffer.alloc(32), 0xffffffff, 0, bitcoin.script.compile([bitcoin.opcodes.OP_0!, messageHash]));
  toSpend.addOutput(payment.output!, 0);

  const toSign = new bitcoin.Transaction();
  toSign.version = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!]), 0);

  const scriptCode = bitcoin.payments.p2pkh({ hash: payment.hash! }).output!;
  const sighash = toSign.hashForWitnessV0(0, scriptCode, 0, bitcoin.Transaction.SIGHASH_ALL);
  const sig = bitcoin.script.signature.encode(Buffer.from(key.sign(sighash)), bitcoin.Transaction.SIGHASH_ALL);
  const pubkey = Buffer.from(key.publicKey);
  return Buffer.concat([Buffer.from([2, sig.length]), sig, Buffer.from([pubkey.length]), pubkey]).toString("base64");
}

/**
 * A two-address wallet shaped like Xverse or Magic Eden: BTC on a nested-segwit
 * payment address, tokens on a Taproot ordinals address. Regtest E2E only.
 */
export function twoAddressIdentity(paymentPrivHex: string, ordinalsPrivHex: string, network: bitcoin.networks.Network = bitcoin.networks.regtest) {
  const pay = ECPair.fromPrivateKey(Buffer.from(paymentPrivHex, "hex"), { network });
  const ord = ECPair.fromPrivateKey(Buffer.from(ordinalsPrivHex, "hex"), { network });
  const payment = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pay.publicKey, network }), network });
  const ordinals = bitcoin.payments.p2tr({ internalPubkey: Buffer.from(ord.publicKey.subarray(1)), network });
  return {
    paymentAddress: payment.address!,
    paymentScript: payment.output!.toString("hex"),
    paymentPublicKey: Buffer.from(pay.publicKey).toString("hex"),
    ordinalsAddress: ordinals.address!,
    ordinalsScript: ordinals.output!.toString("hex"),
    ordinalsPublicKey: Buffer.from(ord.publicKey).toString("hex"),
  };
}

/** Sign every input a two-address wallet owns: nested segwit with one key, Taproot key-path with the other. */
export function signPsbtTwoAddress(psbtBase64: string, paymentPrivHex: string, ordinalsPrivHex: string, network: bitcoin.networks.Network = bitcoin.networks.regtest): string {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  const id = twoAddressIdentity(paymentPrivHex, ordinalsPrivHex, network);
  const pay = ECPair.fromPrivateKey(Buffer.from(paymentPrivHex, "hex"), { network });
  const ord = ECPair.fromPrivateKey(Buffer.from(ordinalsPrivHex, "hex"), { network });
  const tweaked = ord.tweak(bitcoin.crypto.taggedHash("TapTweak", Buffer.from(ord.publicKey.subarray(1))));
  psbt.data.inputs.forEach((input, i) => {
    const script = input.witnessUtxo?.script.toString("hex");
    if (script === id.paymentScript && !input.partialSig?.length) psbt.signInput(i, pay, sighashesFor(psbt, i));
    if (script === id.ordinalsScript && !input.tapKeySig) psbt.signInput(i, tweaked, sighashesFor(psbt, i));
  });
  return psbt.toBase64();
}

/** BIP-322 simple signature from a key-path Taproot address, as Xverse returns it. */
export function signBip322P2trWithKey(message: string, privKeyHex: string, network: bitcoin.networks.Network = bitcoin.networks.regtest): string {
  const key = ECPair.fromPrivateKey(Buffer.from(privKeyHex, "hex"), { network });
  const payment = bitcoin.payments.p2tr({ internalPubkey: Buffer.from(key.publicKey.subarray(1)), network });
  const tag = bitcoin.crypto.sha256(Buffer.from("BIP0322-signed-message", "utf8"));
  const messageHash = bitcoin.crypto.sha256(Buffer.concat([tag, tag, Buffer.from(message, "utf8")]));

  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.addInput(Buffer.alloc(32), 0xffffffff, 0, bitcoin.script.compile([bitcoin.opcodes.OP_0!, messageHash]));
  toSpend.addOutput(payment.output!, 0);

  const toSign = new bitcoin.Transaction();
  toSign.version = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!]), 0);

  const sighash = toSign.hashForWitnessV1(0, [payment.output!], [0], bitcoin.Transaction.SIGHASH_DEFAULT);
  const tweaked = key.tweak(bitcoin.crypto.taggedHash("TapTweak", Buffer.from(key.publicKey.subarray(1))));
  const sig = Buffer.from(tweaked.signSchnorr(sighash));
  return Buffer.concat([Buffer.from([1, sig.length]), sig]).toString("base64");
}
