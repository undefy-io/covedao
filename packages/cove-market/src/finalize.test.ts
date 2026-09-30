import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { encodeTransferV2, serializeDiscovery } from "@crclaunch/cove-wire";
import { CoveChainView, TOKEN_CARRIER_SATS, s0StateV2 } from "@crclaunch/cove-covenant";
import { COVE_FEE_CONFIG, deterministicFee } from "@crclaunch/cove-economics";
import { validateFinalizedP2PFill, assertSettlementCap, type P2PFillTerms } from "./finalize.js";
import { buildListingPsbt, buildPresignedFillPsbt, attachSellerPresig, verifyListingPsbt, SIGHASH_SINGLE_ANYONECANPAY } from "./presign.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const net = bitcoin.networks.regtest;
const seller = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46));
const buyer = ECPair.fromPrivateKey(Buffer.alloc(32, 0x49));
const fee = ECPair.fromPrivateKey(Buffer.alloc(32, 0x44));
const p2wpkh = (k: typeof seller) => bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: net }).output!;

const tokenId = Buffer.alloc(32, 0x0b);
const tokenIdHex = tokenId.toString("hex");
const sourceTxid = "11".repeat(32);
const sourceVout = 0;
const sourceAmount = 42_000_000n * 100_000_000n;
const totalPrice = 100_000n;
const marketFee = deterministicFee(totalPrice, COVE_FEE_CONFIG.p2pFeeBps);
const minerFee = 1_000n;

function view(): CoveChainView {
  const v = new CoveChainView();
  v.deploy(
    { tokenId, ticker: "FROG", policyVersion: 3, deployTxid: "33".repeat(32), tokenNonce: Buffer.alloc(32, 0xab), creatorScript: p2wpkh(fee) },
    { txid: "ff".repeat(32), vout: 0 },
    s0StateV2({ tokenId: tokenIdHex }),
  );
  v.tokenUtxos.set(`${sourceTxid}:${sourceVout}`, {
    outpoint: { txid: sourceTxid, vout: sourceVout },
    tokenId,
    amountAtoms: sourceAmount,
    scriptPubKey: p2wpkh(seller),
  });
  return v;
}

function buildTerms(overrides: Partial<P2PFillTerms> = {}): P2PFillTerms {
  return {
    listingId: "ab".repeat(32),
    fillId: "cd".repeat(16),
    tokenId: tokenIdHex,
    sourceTxid,
    sourceVout,
    sourceAmountAtoms: sourceAmount,
    sellerTokenScript: p2wpkh(seller),
    sellerTokenChangeScript: p2wpkh(seller),
    sellerPayoutScript: p2wpkh(seller),
    amountAtoms: sourceAmount,
    totalPriceSats: totalPrice,
    marketFeeSats: marketFee,
    minerFeeSats: minerFee,
    buyerTokenScript: p2wpkh(buyer),
    buyerChangeScript: p2wpkh(buyer),
    feeScript: p2wpkh(fee),
    buyerFundInputs: [{ txid: "22".repeat(32), vout: 0, script: p2wpkh(buyer), valueSats: 200_000n }],
    ...overrides,
  };
}

/** The seller presigns the listing, the buyer signs the fill, the server attaches the presig. */
function buildSigned(terms: P2PFillTerms): string {
  const source = { txid: terms.sourceTxid, vout: terms.sourceVout, script: terms.sellerTokenScript, valueSats: TOKEN_CARRIER_SATS };
  const listing = buildListingPsbt({ network: net, source, payoutScript: terms.sellerPayoutScript, priceSats: terms.totalPriceSats });
  listing.signInput(0, seller, [SIGHASH_SINGLE_ANYONECANPAY]);
  const presig = verifyListingPsbt(listing.toBase64(), { network: net, source, payoutScript: terms.sellerPayoutScript, priceSats: terms.totalPriceSats });
  const { psbt } = buildPresignedFillPsbt({
    network: net,
    tokenId: Buffer.from(terms.tokenId, "hex"),
    seller: { ...source, amountAtoms: terms.sourceAmountAtoms },
    payoutScript: terms.sellerPayoutScript,
    priceSats: terms.totalPriceSats,
    buyerTokenScript: terms.buyerTokenScript,
    fundInputs: terms.buyerFundInputs,
    buyerChangeScript: terms.buyerChangeScript,
    feeScript: terms.feeScript,
    marketFeeSats: terms.marketFeeSats,
    minerFeeSats: terms.minerFeeSats,
    discoveryEnvelope: terms.discoveryTicker ? { ticker: terms.discoveryTicker } : undefined,
  });
  psbt.signInput(0, buyer);
  attachSellerPresig(psbt, presig);
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}

/** Re-sign a hand-edited fill so only the market rules can reject it (the seller's SINGLE sig survives). */
function mutate(terms: P2PFillTerms, edit: (tx: bitcoin.Transaction) => void): string {
  const tx = bitcoin.Transaction.fromHex(buildSigned(terms));
  edit(tx);
  return tx.toHex();
}

const opReturn = (allocations: { vout: number; amount: bigint }[]) => {
  const wire = encodeTransferV2({ tokenId, allocations });
  return Buffer.concat([Buffer.from([0x6a, wire.length]), wire]);
};

describe("validateFinalizedP2PFill — presigned layout", () => {
  it("accepts a matching CRC-20 output and rejects a changed ticker", () => {
    const terms = buildTerms({ discoveryTicker: "FROG" });
    const tx = bitcoin.Transaction.fromHex(buildSigned(terms));
    expect(tx.outs[tx.outs.length - 1]!.script.subarray(2).toString("utf8")).toContain('"p":"crc-20"');
    expect(validateFinalizedP2PFill({ rawTxHex: tx.toHex(), terms, view: view(), network: "regtest" }).txid).toHaveLength(64);
    const wrong = serializeDiscovery({ p: "crc-20", op: "transfer", tick: "DOGE", amt: sourceAmount.toString() });
    tx.outs[tx.outs.length - 1]!.script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, wrong]);
    expect(() => validateFinalizedP2PFill({ rawTxHex: tx.toHex(), terms, view: view(), network: "regtest" })).toThrow(/DISCOVERY_MISMATCH/);
  });
  it("accepts a well-formed presigned fill (whole carrier → buyer, seller paid at vout 1)", () => {
    const terms = buildTerms();
    const hex = buildSigned(terms);
    const out = validateFinalizedP2PFill({ rawTxHex: hex, terms, view: view(), network: "regtest" });
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(out.tokenId).toBe(tokenIdHex);
    const tx = bitcoin.Transaction.fromHex(hex);
    expect(Buffer.from(tx.ins[1]!.hash).reverse().toString("hex")).toBe(sourceTxid);
    expect(tx.outs[1]!.value).toBe(Number(totalPrice));
    expect(tx.outs[2]!.value).toBe(Number(TOKEN_CARRIER_SATS));
    expect(tx.outs[3]!.value).toBe(Number(marketFee));
  });

  it("rejects the payout at the wrong index", () => {
    const terms = buildTerms();
    const hex = mutate(terms, (tx) => {
      const [a, b] = [tx.outs[1]!, tx.outs[3]!];
      tx.outs[1] = b;
      tx.outs[3] = a;
    });
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms, view: view(), network: "regtest" })).toThrow(/SELLER_PAYOUT|P2P_FEE|TRANSFER_VALIDATION/);
  });

  it("rejects a fill with the market fee missing", () => {
    const terms = buildTerms();
    const hex = mutate(terms, (tx) => {
      tx.outs.splice(3, 1);
    });
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms, view: view(), network: "regtest" })).toThrow(/P2P_FEE|MINER_FEE|BUYER_CHANGE/);
  });

  it("rejects tokens allocated to the wrong vout", () => {
    const terms = buildTerms();
    const hex = mutate(terms, (tx) => {
      tx.outs[0]!.script = opReturn([{ vout: 1, amount: sourceAmount }]);
    });
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms, view: view(), network: "regtest" })).toThrow(/BUYER_ALLOCATION|TRANSFER_VALIDATION/);
  });

  it("rejects an extra output", () => {
    const terms = buildTerms();
    const hex = mutate(terms, (tx) => {
      tx.addOutput(p2wpkh(buyer), 5_000);
      tx.outs[4]!.value -= 5_000;
    });
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms, view: view(), network: "regtest" })).toThrow(/UNEXPECTED_OUTPUT/);
  });

  it("rejects a wrong seller payout / p2p fee / miner fee in the terms", () => {
    const hex = buildSigned(buildTerms());
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms: buildTerms({ totalPriceSats: totalPrice + 1n }), view: view(), network: "regtest" })).toThrow(/SELLER_PAYOUT/);
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms: buildTerms({ marketFeeSats: marketFee + 1n }), view: view(), network: "regtest" })).toThrow(/P2P_FEE/);
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms: buildTerms({ minerFeeSats: minerFee + 1n }), view: view(), network: "regtest" })).toThrow(/MINER_FEE/);
  });

  it("rejects a partial carrier (presigned listings sell the whole carrier)", () => {
    const hex = buildSigned(buildTerms());
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms: buildTerms({ amountAtoms: sourceAmount - 100n }), view: view(), network: "regtest" })).toThrow(/PARTIAL_CARRIER/);
  });

  it("rejects when input 1 is not the listing outpoint, or an input is not a reserved buyer coin", () => {
    const hex = buildSigned(buildTerms());
    expect(() => validateFinalizedP2PFill({ rawTxHex: hex, terms: buildTerms({ sourceTxid: "99".repeat(32) }), view: view(), network: "regtest" })).toThrow(/SOURCE_INPUT/);
    expect(() =>
      validateFinalizedP2PFill({
        rawTxHex: hex,
        terms: buildTerms({ buyerFundInputs: [{ txid: "77".repeat(32), vout: 0, script: p2wpkh(buyer), valueSats: 200_000n }] }),
        view: view(),
        network: "regtest",
      }),
    ).toThrow(/BUYER_INPUT/);
  });
});

describe("assertSettlementCap (§P0-6)", () => {
  it("allows a settlement at or below the cap", () => {
    expect(() => assertSettlementCap(10_000_000n, 10_000_000n)).not.toThrow();
    expect(() => assertSettlementCap(9_999_999n, 10_000_000n)).not.toThrow();
  });

  it("allows any settlement when no cap is configured (dev/regtest)", () => {
    expect(() => assertSettlementCap(1_000_000_000_000n, null)).not.toThrow();
    expect(() => assertSettlementCap(1_000_000_000_000n, undefined)).not.toThrow();
  });

  it("rejects a settlement above the cap", () => {
    expect(() => assertSettlementCap(10_000_001n, 10_000_000n)).toThrow(/P2P_SETTLEMENT_CAP_EXCEEDED/);
  });
});
