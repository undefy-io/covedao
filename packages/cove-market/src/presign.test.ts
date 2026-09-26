import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { checkListingSignature } from "@crclaunch/bitcoin";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import {
  buildListingPsbt,
  verifyListingPsbt,
  buildPresignedFillPsbt,
  attachSellerPresig,
  SIGHASH_SINGLE_ANYONECANPAY,
  FILL_SELLER_INPUT,
  LISTING_SEQUENCE,
  type ListingSource,
} from "./presign.js";
import { publicListing } from "./service.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const net = bitcoin.networks.regtest;
const seller = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46));
const buyer = ECPair.fromPrivateKey(Buffer.alloc(32, 0x49));
const p2wpkh = (k: typeof seller) => bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: net }).output!;
const xonly = (k: typeof seller) => Buffer.from(k.publicKey.subarray(1, 33));
const p2tr = (k: typeof seller) => bitcoin.payments.p2tr({ internalPubkey: xonly(k), network: net }).output!;
const tweaked = (k: typeof seller) => k.tweak(bitcoin.crypto.taggedHash("TapTweak", xonly(k)));

const PRICE = 100_000n;
const payout = p2wpkh(seller);
const segwitSource: ListingSource = { txid: "11".repeat(32), vout: 2, script: p2wpkh(seller), valueSats: TOKEN_CARRIER_SATS };
const taprootSource: ListingSource = { txid: "12".repeat(32), vout: 1, script: p2tr(seller), valueSats: TOKEN_CARRIER_SATS, publicKey: Buffer.from(seller.publicKey) };

function presign(source: ListingSource, sighash = SIGHASH_SINGLE_ANYONECANPAY, price = PRICE) {
  const psbt = buildListingPsbt({ network: net, source, payoutScript: payout, priceSats: price });
  if (source.script.length === 34) {
    // Taproot: honour the requested sighash (0 = SIGHASH_DEFAULT, a bare 64-byte sig).
    if (sighash !== SIGHASH_SINGLE_ANYONECANPAY) psbt.data.inputs[0]!.sighashType = sighash;
    psbt.signInput(0, tweaked(seller), [sighash]);
  } else {
    if (sighash !== SIGHASH_SINGLE_ANYONECANPAY) psbt.data.inputs[0]!.sighashType = sighash;
    psbt.signInput(0, seller, [sighash]);
  }
  return psbt.toBase64();
}

const expected = (source: ListingSource, over: Partial<{ payoutScript: Buffer; priceSats: bigint }> = {}) => ({
  network: net,
  source,
  payoutScript: over.payoutScript ?? payout,
  priceSats: over.priceSats ?? PRICE,
});

describe("listing PSBT", () => {
  it("is one input (sequence fixed, SINGLE|ACP requested) and one output (the payout)", () => {
    const psbt = buildListingPsbt({ network: net, source: segwitSource, payoutScript: payout, priceSats: PRICE });
    expect(psbt.txInputs).toHaveLength(1);
    expect(psbt.txInputs[0]!.sequence).toBe(LISTING_SEQUENCE);
    expect(psbt.data.inputs[0]!.sighashType).toBe(SIGHASH_SINGLE_ANYONECANPAY);
    expect(psbt.txOutputs).toHaveLength(1);
    expect(psbt.txOutputs[0]!.value).toBe(Number(PRICE));
  });
});

describe("verifyListingPsbt — presignature checks", () => {
  for (const [name, source] of [["P2WPKH", segwitSource], ["Taproot", taprootSource]] as const) {
    it(`accepts a valid ${name} SINGLE|ACP presignature`, () => {
      const presig = verifyListingPsbt(presign(source), expected(source));
      expect(presig.tapKeySig ?? presig.partialSig).toBeTruthy();
    });

    it(`refuses a ${name} signature with the wrong sighash`, () => {
      const sighash = name === "Taproot" ? bitcoin.Transaction.SIGHASH_ALL : bitcoin.Transaction.SIGHASH_ALL;
      expect(() => verifyListingPsbt(presign(source, sighash), expected(source))).toThrow(/UNSAFE_SIGHASH|sighash/);
    });

    it(`refuses a ${name} listing for another price, payout or outpoint`, () => {
      const signed = presign(source);
      expect(() => verifyListingPsbt(signed, expected(source, { priceSats: PRICE + 1n }))).toThrow(/not the listing for these terms/);
      expect(() => verifyListingPsbt(signed, expected(source, { payoutScript: p2wpkh(buyer) }))).toThrow(/not the listing for these terms/);
      expect(() => verifyListingPsbt(signed, expected({ ...source, vout: source.vout + 1 }))).toThrow(/not the listing for these terms/);
    });

    it(`refuses a forged ${name} signature`, () => {
      const psbt = bitcoin.Psbt.fromBase64(presign(source), { network: net });
      const input = psbt.data.inputs[0]!;
      if (input.tapKeySig) {
        const bad = Buffer.from(input.tapKeySig);
        bad[5] = bad[5]! ^ 0xff;
        input.tapKeySig = bad;
      } else {
        // Flip a byte inside r: still well-formed DER, no longer a valid signature.
        const sig = Buffer.from(input.partialSig![0]!.signature);
        sig[10] = sig[10]! ^ 0x01;
        input.partialSig = [{ pubkey: Buffer.from(seller.publicKey), signature: sig }];
      }
      expect(() => verifyListingPsbt(psbt.toBase64(), expected(source))).toThrow(/LISTING_BAD_SIGNATURE|signature invalid/);
    });
  }

  it("refuses an unsigned listing", () => {
    const unsigned = buildListingPsbt({ network: net, source: segwitSource, payoutScript: payout, priceSats: PRICE }).toBase64();
    expect(() => verifyListingPsbt(unsigned, expected(segwitSource))).toThrow(/unsigned/);
  });
});

describe("presigned fill", () => {
  for (const [name, source] of [["P2WPKH", segwitSource], ["Taproot", taprootSource]] as const) {
    it(`${name}: the seller's listing signature stays valid inside the buyer's transaction`, () => {
      const presig = verifyListingPsbt(presign(source), expected(source));
      const fund = { txid: "22".repeat(32), vout: 0, script: p2wpkh(buyer), valueSats: 300_000n };
      const extra = { txid: "23".repeat(32), vout: 3, script: p2wpkh(buyer), valueSats: 50_000n };
      const { psbt, changeSats } = buildPresignedFillPsbt({
        network: net,
        tokenId: Buffer.alloc(32, 0x0b),
        seller: { ...source, amountAtoms: 5n },
        payoutScript: payout,
        priceSats: PRICE,
        buyerTokenScript: p2tr(buyer),
        fundInputs: [fund, extra],
        buyerChangeScript: p2wpkh(buyer),
        feeScript: p2wpkh(ECPair.fromPrivateKey(Buffer.alloc(32, 0x44))),
        marketFeeSats: 7_500n,
        minerFeeSats: 1_000n,
      });
      // Layout: inputs [buyer, seller, buyer]; outputs [OP_RETURN, payout, carrier, fee, change].
      expect(psbt.txInputs.map((i) => Buffer.from(i.hash).reverse().toString("hex"))).toEqual([fund.txid, source.txid, extra.txid]);
      expect(psbt.txInputs[FILL_SELLER_INPUT]!.sequence).toBe(LISTING_SEQUENCE);
      expect(psbt.txOutputs[1]!.script.equals(payout) && psbt.txOutputs[1]!.value === Number(PRICE)).toBe(true);
      expect(psbt.txOutputs[2]!.value).toBe(Number(TOKEN_CARRIER_SATS));
      expect(changeSats).toBe(300_000n + 50_000n + TOKEN_CARRIER_SATS - PRICE - TOKEN_CARRIER_SATS - 7_500n - 1_000n);
      // The buyer's copy carries no seller signature.
      expect(psbt.data.inputs[FILL_SELLER_INPUT]!.tapKeySig ?? psbt.data.inputs[FILL_SELLER_INPUT]!.partialSig).toBeFalsy();
      psbt.signInput(0, buyer);
      psbt.signInput(2, buyer);
      attachSellerPresig(psbt, presig);
      // Verified against the FILL transaction: SINGLE|ACP ignores the input's position and the other coins.
      expect(checkListingSignature(psbt, FILL_SELLER_INPUT)).toEqual({ ok: true });
      psbt.finalizeAllInputs();
      expect(psbt.extractTransaction().ins).toHaveLength(3);
    });
  }

  it("a changed payout invalidates the seller's signature", () => {
    const presig = verifyListingPsbt(presign(segwitSource), expected(segwitSource));
    const { psbt } = buildPresignedFillPsbt({
      network: net,
      tokenId: Buffer.alloc(32, 0x0b),
      seller: { ...segwitSource, amountAtoms: 5n },
      payoutScript: payout,
      priceSats: PRICE - 1n,
      buyerTokenScript: p2wpkh(buyer),
      fundInputs: [{ txid: "22".repeat(32), vout: 0, script: p2wpkh(buyer), valueSats: 300_000n }],
      buyerChangeScript: p2wpkh(buyer),
      feeScript: p2wpkh(buyer),
      marketFeeSats: 7_500n,
      minerFeeSats: 1_000n,
    });
    attachSellerPresig(psbt, presig);
    expect(checkListingSignature(psbt, FILL_SELLER_INPUT).ok).toBe(false);
  });
});

describe("the presignature never leaves the server", () => {
  it("publicListing strips it", () => {
    const row = { listingId: "x", sellerPresignedPsbt: "cHNidP8secret", status: "ACTIVE" };
    const pub = publicListing(row);
    expect(pub).toEqual({ listingId: "x", status: "ACTIVE" });
    expect(JSON.stringify(pub)).not.toContain("secret");
  });
});
