import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import { dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { applyBuy, applySell, createCurveState, quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import {
  buildCurveBuy,
  buildCurveDeploy,
  buildCurveSell,
  buildCoveTransfer,
  buildCoveDeployWithVault,
  buildCoveMarketFill,
  buildUnsignedPsbt,
} from "../src/index.js";

const ECPair = ECPairFactory(ecc);
const buyer = ECPair.fromPrivateKey(Buffer.alloc(32, 1));
const seller = ECPair.fromPrivateKey(Buffer.alloc(32, 2));
const vault = ECPair.fromPrivateKey(Buffer.alloc(32, 3));
const protocol = ECPair.fromPrivateKey(Buffer.alloc(32, 4));
const creator = ECPair.fromPrivateKey(Buffer.alloc(32, 5));
const script = (key: typeof buyer) =>
  bitcoin.payments.p2wpkh({ pubkey: key.publicKey }).output!.toString("hex");
const scripts = {
  buyer: script(buyer),
  seller: script(seller),
  vault: script(vault),
  protocol: script(protocol),
  creator: script(creator),
};
const state0 = createCurveState(`${"11".repeat(32)}:1`, 330n);
const minted = applyBuy(state0, {
  amountAtoms: 100_000n * 100_000_000n,
  previousVaultOutpoint: state0.vaultOutpoint,
  nextVaultOutpoint: `${"22".repeat(32)}:2`,
  nextVaultSats: state0.vaultSats + quoteBuy(state0, 100_000n).grossSats,
  protocolFeeSats: quoteBuy(state0, 100_000n).protocolFeeSats,
  creatorFeeSats: quoteBuy(state0, 100_000n).creatorFeeSats,
});

function decode(tx: bitcoin.Transaction) {
  const serialized = bitcoin.Transaction.fromHex(tx.toHex());
  return parseCrc20Transaction(
    serialized.outs.map((out) => ({ valueSats: out.value, scriptHex: out.script.toString("hex") })),
  );
}

function funding(valueSats: number, key = buyer) {
  return { txid: "ab".repeat(32), vout: 0, valueSats, scriptHex: script(key) };
}

describe("CRC-first Cove transaction prototype", () => {
  it("puts a >80-byte deploy marker at vout 0 and fixes the initial vault and fee scripts", () => {
    const template = buildCurveDeploy({
      ticker: "COVE",
      maxAtoms: "2100000000000000",
      scripts,
      vaultAnchorSats: 330,
    });
    expect(template.markerBytes).toBeGreaterThan(80);
    expect(template.outputs.map((out) => out.scriptHex).slice(1)).toEqual([
      scripts.vault,
      scripts.creator,
      scripts.protocol,
    ]);
    expect(template.outputs[2]?.valueSats).toBe(1_000);
    expect(template.outputs[3]?.valueSats).toBe(7_000);
    expect(template.requiredFundingSats).toBe(8_330);
    expect(decode(template.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "deploy", markerVout: 0 },
    });
  });

  it("rejects an alternative cap and dust outputs for this curve version", () => {
    expect(() =>
      buildCurveDeploy({
        ticker: "COVE",
        maxAtoms: "2100000000000001",
        scripts,
        vaultAnchorSats: 330,
      }),
    ).toThrow(/maximum supply/i);
    const legacyScript = bitcoin.payments.p2pkh({ pubkey: buyer.publicKey }).output!.toString("hex");
    expect(() =>
      buildCurveDeploy({
        ticker: "COVE",
        maxAtoms: "2100000000000000",
        scripts: { ...scripts, vault: legacyScript },
        vaultAnchorSats: 330,
      }),
    ).toThrow(/dust/i);
  });

  it("new mint buy puts recipient immediately after the marker and pays exact reserve and fees", () => {
    const quote = quoteBuy(state0, 100_000n);
    const template = buildCurveBuy({
      ticker: "COVE",
      deploymentTxid: "99".repeat(32),
      state: state0,
      amountTokens: 100_000n,
      scripts,
      recipientSats: 330,
    });
    expect(template.operation).toBe("mint");
    expect(decode(template.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "mint", markerVout: 0, payload: { amt: quote.amountAtoms.toString(), id: "99".repeat(32) } },
    });
    expect(template.outputs[1]).toMatchObject({ valueSats: 330, scriptHex: scripts.buyer });
    expect(template.outputs[2]).toMatchObject({
      valueSats: Number(state0.vaultSats + quote.grossSats),
      scriptHex: scripts.vault,
    });
    expect(template.outputs[3]?.valueSats).toBe(Number(quote.protocolFeeSats));
    expect(template.outputs[4]?.valueSats).toBe(Number(quote.creatorFeeSats));
    expect(template.requiredFundingSats).toBe(
      Number(quote.grossSats + quote.protocolFeeSats + quote.creatorFeeSats + 330n),
    );
  });

  it("sell sends tokens to the next vault output; resale transfers vault inventory before minting", () => {
    const saleQuote = quoteSell(minted, 40_000n, 294n);
    const sale = buildCurveSell({ ticker: "COVE", deploymentTxid: "99".repeat(32), state: minted, amountTokens: 40_000n, scripts });
    expect(decode(sale.tx)).toMatchObject({
      status: "valid",
      envelope: {
        kind: "transfer",
        markerVout: 0,
        recipientVout: 1,
        amountAtoms: saleQuote.amountAtoms.toString(),
      },
    });
    expect(sale.outputs[1]).toMatchObject({
      scriptHex: scripts.vault,
      valueSats: Number(minted.vaultSats - saleQuote.grossSats),
    });
    expect(sale.outputs[2]).toMatchObject({
      scriptHex: scripts.seller,
      valueSats: Number(saleQuote.sellerPayoutSats),
    });
    expect(sale.outputs[3]).toMatchObject({
      scriptHex: scripts.protocol,
      valueSats: Number(saleQuote.protocolFeeSats),
    });
    expect(sale.requiredFundingSats).toBe(Number(saleQuote.walletTopUpSats));
    const inventory = applySell(minted, {
      amountAtoms: saleQuote.amountAtoms,
      previousVaultOutpoint: minted.vaultOutpoint,
      nextVaultOutpoint: `${"33".repeat(32)}:1`,
      nextVaultSats: minted.vaultSats - saleQuote.grossSats,
      protocolFeeSats: saleQuote.protocolFeeSats,
      sellerPayoutSats: saleQuote.sellerPayoutSats,
      walletTopUpSats: saleQuote.walletTopUpSats,
      payoutDustSats: 294n,
    });
    const resale = buildCurveBuy({
      ticker: "COVE",
      deploymentTxid: "99".repeat(32),
      state: inventory,
      amountTokens: 40_000n,
      scripts,
      recipientSats: 330,
    });
    expect(resale.operation).toBe("transfer");
    expect(decode(resale.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "transfer", markerVout: 0, recipientVout: 1 },
    });
    expect(resale.outputs[1]?.scriptHex).toBe(scripts.buyer);
  });

  it("requires exact funding and a seller-online full-transaction signature that rejects mutation", () => {
    const template = buildCurveSell({
      ticker: "COVE",
      deploymentTxid: "99".repeat(32),
      state: minted,
      amountTokens: 40_000n,
      scripts,
    });
    const sellerFund = funding(template.requiredFundingSats + 1_000, seller);
    const psbt = buildUnsignedPsbt(
      template,
      [
        {
          txid: "22".repeat(32),
          vout: 2,
          valueSats: Number(minted.vaultSats),
          scriptHex: scripts.vault,
        },
        sellerFund,
      ],
      1_000,
    );
    expect(
      psbt.data.inputs.every((input) => input.sighashType === bitcoin.Transaction.SIGHASH_ALL),
    ).toBe(true);
    psbt.signInput(1, seller);
    expect(
      psbt.validateSignaturesOfInput(1, (pubkey, hash, signature) =>
        ecc.verify(hash, pubkey, signature),
      ),
    ).toBe(true);
    const signed = psbt.data.inputs[1]!.partialSig![0]!;
    const sig = bitcoin.script.signature.decode(signed.signature);
    expect(sig.hashType).toBe(bitcoin.Transaction.SIGHASH_ALL);
    const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx!.toBuffer());
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: signed.pubkey }).output!;
    const valid = (candidate: bitcoin.Transaction) =>
      ecc.verify(
        candidate.hashForWitnessV0(1, scriptCode, sellerFund.valueSats, sig.hashType),
        signed.pubkey,
        sig.signature,
      );
    expect(valid(tx)).toBe(true);
    for (const index of [0, 1, 2, 3]) {
      const mutated = tx.clone();
      mutated.outs[index]!.value += 1;
      expect(valid(mutated)).toBe(false);
    }
    const recipient = tx.clone();
    recipient.outs[1]!.script = Buffer.from(scripts.buyer, "hex");
    expect(valid(recipient)).toBe(false);
    const addedInput = tx.clone();
    addedInput.addInput(Buffer.alloc(32, 9), 0);
    expect(valid(addedInput)).toBe(false);
    expect(() => buildUnsignedPsbt(template, [sellerFund], 1_000)).toThrow(/vault input/i);
  });

  it("requires an unambiguous deployment id on every post-deploy marker", () => {
    expect(() => buildCurveBuy({
      ticker: "COVE",
      deploymentTxid: "not-a-txid",
      state: state0,
      amountTokens: 1_000n,
      scripts,
      recipientSats: 330,
    })).toThrow(/deployment/i);
    const buy = buildCurveBuy({
      ticker: "COVE",
      deploymentTxid: "99".repeat(32),
      state: state0,
      amountTokens: 1_000n,
      scripts,
      recipientSats: 330,
    });
    expect(decode(buy.tx)).toMatchObject({ status: "valid", envelope: { payload: { id: "99".repeat(32) } } });
  });

  it("builds an ordinary peer transfer with explicit identity and recipient-first output", () => {
    const transfer = buildCoveTransfer({
      ticker: "COVE",
      deploymentTxid: "99".repeat(32),
      amountAtoms: 123_000_000n,
      senderScriptHex: scripts.seller,
      recipientScriptHex: scripts.buyer,
      recipientSats: 330,
      changeSats: 670,
    });
    expect(decode(transfer.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "transfer", recipientVout: 1, amountAtoms: "123000000", payload: { id: "99".repeat(32) } },
    });
    expect(transfer.outputs[1]).toMatchObject({ scriptHex: scripts.buyer, valueSats: 330 });
    expect(transfer.outputs[2]).toMatchObject({ scriptHex: scripts.seller, valueSats: 670 });
    expect(transfer.requiredFundingSats).toBe(1_000);
    expect(() => buildCoveTransfer({ ticker: "COVE", deploymentTxid: "99".repeat(32), amountAtoms: 0n, senderScriptHex: scripts.seller, recipientScriptHex: scripts.buyer, recipientSats: 330 })).toThrow(/amount/i);
    expect(() => buildCoveTransfer({ ticker: "COVE", deploymentTxid: "BAD", amountAtoms: 1n, senderScriptHex: scripts.seller, recipientScriptHex: scripts.buyer, recipientSats: 330 })).toThrow(/deployment/i);
  });

  it("rejects legacy funding inputs until a full parent transaction is supplied", () => {
    const template = buildCurveDeploy({ ticker: "COVE", maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330 });
    const legacyScript = bitcoin.payments.p2pkh({ pubkey: buyer.publicKey }).output!.toString("hex");
    expect(() => buildUnsignedPsbt(template, [{ txid: "ab".repeat(32), vout: 0, valueSats: 9_330, scriptHex: legacyScript }], 1_000)).toThrow(/funding script/i);
  });

  it("signs a verified nested SegWit wallet input and rejects a mismatched public key", () => {
    const nested = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: buyer.publicKey }) });
    const template = buildCurveDeploy({ ticker: "COVE", maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330 });
    const input = { txid: "ab".repeat(32), vout: 0, valueSats: 9_330, scriptHex: nested.output!.toString("hex"), publicKeyHex: buyer.publicKey.toString("hex") };
    const psbt = buildUnsignedPsbt(template, [input], 1_000);
    expect(psbt.data.inputs[0]!.redeemScript).toEqual(nested.redeem!.output);
    psbt.signInput(0, buyer);
    expect(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => ecc.verify(hash, pubkey, signature))).toBe(true);
    expect(() => buildUnsignedPsbt(template, [{ ...input, publicKeyHex: seller.publicKey.toString("hex") }], 1_000)).toThrow(/public key|script/i);
    expect(() => buildUnsignedPsbt(template, [{ ...input, publicKeyHex: undefined }], 1_000)).toThrow(/public key/i);
  });

  it("attaches only a Taproot internal key that derives the wallet funding output", () => {
    const internal = buyer.publicKey.subarray(1);
    const taproot = bitcoin.payments.p2tr({ internalPubkey: internal });
    const template = buildCurveDeploy({ ticker: "COVE", maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330 });
    const input = { txid: "ab".repeat(32), vout: 0, valueSats: 9_330, scriptHex: taproot.output!.toString("hex"), publicKeyHex: internal.toString("hex") };
    const psbt = buildUnsignedPsbt(template, [input], 1_000);
    expect(psbt.data.inputs[0]!.tapInternalKey).toEqual(internal);
    const tweak = bitcoin.crypto.taggedHash("TapTweak", internal);
    const tweakedPrivate = ecc.privateAdd(
      buyer.publicKey[0] === 3 ? ecc.privateNegate(buyer.privateKey!) : buyer.privateKey!,
      tweak,
    );
    psbt.signInput(0, ECPair.fromPrivateKey(Buffer.from(tweakedPrivate!), { network: bitcoin.networks.regtest }), [bitcoin.Transaction.SIGHASH_ALL]);
    expect(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => ecc.verifySchnorr(hash, pubkey, signature))).toBe(true);
    expect(() => buildUnsignedPsbt(template, [{ ...input, publicKeyHex: seller.publicKey.subarray(1).toString("hex") }], 1_000)).toThrow(/public key|script/i);
  });

  it("derives the deploy vault from the same salted commitment as standalone Guardian", () => {
    const result = buildCoveDeployWithVault({
      ticker: "COVE",
      launchSalt: Buffer.alloc(32, 0x45),
      guardianXOnly: Buffer.from("eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619", "hex"),
      recoveryProfile: dev1RecoveryProfile(Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex")),
      creatorScriptHex: scripts.creator,
      protocolScriptHex: scripts.protocol,
      vaultAnchorSats: 330,
      network: bitcoin.networks.regtest,
    });
    expect(result.vault.scriptPubKey.toString("hex")).toBe("5120479e34077d1df9edc40ef105217331dcf71a050974c46a2d0d7c185415aacc17");
    expect(result.template.outputs[1]?.scriptHex).toBe(result.vault.scriptPubKey.toString("hex"));
    expect(result.template.outputs[2]?.valueSats).toBe(1_000);
    expect(result.template.outputs[3]?.valueSats).toBe(7_000);
  });

  it("adds final wallet change while preserving CRC output positions and exact PSBT funding", () => {
    const deploy = buildCurveDeploy({
      ticker: "COVE", maxAtoms: "2100000000000000", scripts,
      vaultAnchorSats: 330, changeSats: 670, changeScriptHex: scripts.buyer,
    });
    expect(deploy.outputs[4]).toEqual({ valueSats: 670, scriptHex: scripts.buyer });
    expect(deploy.requiredFundingSats).toBe(9_000);
    expect(buildUnsignedPsbt(deploy, [{ txid: "ab".repeat(32), vout: 0, valueSats: 10_000, scriptHex: scripts.buyer }], 1_000).txOutputs).toHaveLength(5);

    const buy = buildCurveBuy({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state: state0,
      amountTokens: 1_000n, scripts, recipientSats: 330, changeSats: 700,
    });
    expect(buy.outputs[5]).toEqual({ valueSats: 700, scriptHex: scripts.buyer });
    expect(decode(buy.tx)).toMatchObject({ status: "valid", envelope: { kind: "mint", markerVout: 0 } });
    const buyWalletSats = buy.requiredFundingSats + 1_000;
    expect(buildUnsignedPsbt(buy, [
      { txid: state0.vaultOutpoint.split(":")[0]!, vout: 1, valueSats: 330, scriptHex: scripts.vault },
      { txid: "ab".repeat(32), vout: 0, valueSats: buyWalletSats, scriptHex: scripts.buyer },
    ], 1_000).txOutputs).toHaveLength(6);

    const sell = buildCurveSell({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state: minted,
      amountTokens: 40_000n, scripts, changeSats: 700,
    });
    expect(sell.outputs[4]).toEqual({ valueSats: 700, scriptHex: scripts.seller });
    expect(decode(sell.tx)).toMatchObject({ status: "valid", envelope: { kind: "transfer", recipientVout: 1 } });
    expect(() => buildCurveSell({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state: minted,
      amountTokens: 40_000n, scripts, changeSats: 1,
    })).toThrow(/dust/i);
  });

  it("keeps token recipient separate from payment payout and change scripts", () => {
    const tokenScript = bitcoin.payments.p2tr({ internalPubkey: buyer.publicKey.subarray(1) }).output!.toString("hex");
    const tradeScripts = { ...scripts, buyer: tokenScript, seller: tokenScript };
    const buy = buildCurveBuy({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state: state0,
      amountTokens: 1_000n, scripts: tradeScripts, recipientSats: 330,
      changeSats: 700, changeScriptHex: scripts.buyer,
    });
    expect(buy.outputs[1]?.scriptHex).toBe(tokenScript);
    expect(buy.outputs[5]?.scriptHex).toBe(scripts.buyer);
    const sell = buildCurveSell({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state: minted,
      amountTokens: 40_000n, scripts: tradeScripts,
      sellerPayoutScriptHex: scripts.buyer, changeSats: 700, changeScriptHex: scripts.buyer,
    });
    expect(sell.outputs[2]).toMatchObject({ valueSats: 294, scriptHex: scripts.buyer });
    expect(sell.outputs[4]?.scriptHex).toBe(scripts.buyer);
  });

  it("builds a seller-online exact market fill whose seller signature binds payout and recipient", () => {
    const fill = buildCoveMarketFill({
      ticker: "COVE", deploymentTxid: "99".repeat(32), amountAtoms: 1_000n * 100_000_000n,
      sellerScriptHex: scripts.seller, buyerScriptHex: scripts.buyer,
      recipientSats: 330, sellerPayoutSats: 10_000, protocolScriptHex: scripts.protocol,
      protocolFeeSats: 1_000, buyerChangeSats: 1_000,
    });
    expect(fill.outputs.slice(1)).toEqual([
      { valueSats: 330, scriptHex: scripts.buyer },
      { valueSats: 10_000, scriptHex: scripts.seller },
      { valueSats: 1_000, scriptHex: scripts.protocol },
      { valueSats: 1_000, scriptHex: scripts.buyer },
    ]);
    expect(decode(fill.tx)).toMatchObject({ status: "valid", envelope: { kind: "transfer", recipientVout: 1 } });
    expect(() => buildUnsignedPsbt(fill, [
      { txid: "aa".repeat(32), vout: 0, valueSats: 1_000, scriptHex: scripts.buyer },
      { txid: "bb".repeat(32), vout: 0, valueSats: 12_330, scriptHex: scripts.buyer },
    ], 1_000)).toThrow(/seller input/i);
    const psbt = buildUnsignedPsbt(fill, [
      { txid: "aa".repeat(32), vout: 0, valueSats: 1_000, scriptHex: scripts.seller },
      { txid: "bb".repeat(32), vout: 0, valueSats: 12_330, scriptHex: scripts.buyer },
    ], 1_000);
    psbt.signInput(0, seller);
    expect(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => ecc.verify(hash, pubkey, signature))).toBe(true);
    const signed = psbt.data.inputs[0]!.partialSig![0]!;
    const signature = bitcoin.script.signature.decode(signed.signature);
    expect(signature.hashType).toBe(bitcoin.Transaction.SIGHASH_ALL);
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: signed.pubkey }).output!;
    const unsigned = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx!.toBuffer());
    const valid = (candidate: bitcoin.Transaction) => ecc.verify(
      candidate.hashForWitnessV0(0, scriptCode, 1_000, signature.hashType), signed.pubkey, signature.signature,
    );
    expect(valid(unsigned)).toBe(true);
    for (const index of [0, 1, 2, 3, 4]) {
      const mutated = unsigned.clone();
      mutated.outs[index]!.value += 1;
      expect(valid(mutated)).toBe(false);
    }
    const extraInput = unsigned.clone();
    extraInput.addInput(Buffer.alloc(32, 7), 0);
    expect(valid(extraInput)).toBe(false);
  });
});
