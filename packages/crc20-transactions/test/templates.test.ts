import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import { applyBuy, applySell, createCurveState, quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import {
  buildCurveBuy,
  buildCurveDeploy,
  buildCurveSell,
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
    expect(decode(template.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "deploy", markerVout: 0 },
    });
  });

  it("new mint buy puts recipient immediately after the marker and pays exact reserve and fees", () => {
    const quote = quoteBuy(state0, 100_000n);
    const template = buildCurveBuy({
      ticker: "COVE",
      state: state0,
      amountTokens: 100_000n,
      scripts,
      recipientSats: 330,
    });
    expect(template.operation).toBe("mint");
    expect(decode(template.tx)).toMatchObject({
      status: "valid",
      envelope: { kind: "mint", markerVout: 0, payload: { amt: quote.amountAtoms.toString() } },
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
    const saleQuote = quoteSell(minted, 40_000n);
    const sale = buildCurveSell({ ticker: "COVE", state: minted, amountTokens: 40_000n, scripts });
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
      payoutDustSats: 330n,
    });
    const resale = buildCurveBuy({
      ticker: "COVE",
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
});
