import * as bitcoin from "bitcoinjs-lib";
import {
  checkListingSignature,
  psbtInputFor,
  unfinalizeKeyInputs,
  SIGHASH_SINGLE_ANYONECANPAY,
} from "@crclaunch/bitcoin";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { encodeTransferV2 } from "@crclaunch/cove-wire";
import { dustThreshold } from "@crclaunch/cove-economics";
import { MarketError } from "./errors.js";

/**
 * Presigned listings, the way Ordinals marketplaces do it.
 *
 * At listing time the seller signs ONE input (the whole token carrier) with
 * SIGHASH_SINGLE | SIGHASH_ANYONECANPAY over ONE output (their payout). That
 * signature commits to the carrier and to "pay me exactly this, here" and to
 * nothing else: not the input's position, not the other inputs, not the
 * other outputs. A buyer can later wrap it in a transaction of their own —
 * their coins, the Cove envelope, their token carrier, the market fee — and
 * the seller never signs again.
 *
 * What the signature DOES commit to must match between the listing PSBT and
 * the fill: the transaction version, the locktime, the carrier input's
 * nSequence, and the payout output sitting at the same index as the carrier.
 * Those constants live here, and both builders use them.
 *
 * The signature is a bearer instrument for that exact sale, so the server
 * keeps it to itself until it has the buyer's own signed transaction — the
 * buyer never sees it, and so cannot settle without paying the market fee.
 */

export const LISTING_TX_VERSION = 2;
export const LISTING_LOCKTIME = 0;
export const LISTING_SEQUENCE = 0xffffffff;
export { SIGHASH_SINGLE_ANYONECANPAY };

/** In a fill, the seller's carrier sits here — and so does their payout. */
export const FILL_SELLER_INPUT = 1;
export const FILL_PAYOUT_VOUT = 1;
export const FILL_BUYER_CARRIER_VOUT = 2;
export const FILL_FEE_VOUT = 3;
export const FILL_BUYER_CHANGE_VOUT = 4;

export interface ListingSource {
  txid: string;
  vout: number;
  /** The carrier's scriptPubKey (the seller's token address). */
  script: Buffer;
  valueSats: bigint;
  /** Needed for a Taproot carrier (internal key); optional for P2WPKH. */
  publicKey?: Buffer;
}

/** The seller's signature on their carrier, as it will be attached to the fill. */
export interface SellerPresig {
  tapKeySig?: Buffer;
  partialSig?: { pubkey: Buffer; signature: Buffer }[];
}

/** The unsigned listing PSBT the seller is asked to sign. */
export function buildListingPsbt(params: {
  network: bitcoin.networks.Network;
  source: ListingSource;
  payoutScript: Buffer;
  priceSats: bigint;
}): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.setVersion(LISTING_TX_VERSION);
  psbt.setLocktime(LISTING_LOCKTIME);
  psbt.addInput({
    ...psbtInputFor(params.source, params.network),
    sequence: LISTING_SEQUENCE,
    // Tells the wallet which sighash to use; it signs nothing else.
    sighashType: SIGHASH_SINGLE_ANYONECANPAY,
  });
  psbt.addOutput({ script: params.payoutScript, value: Number(params.priceSats) });
  return psbt;
}

/**
 * Check a seller-signed listing PSBT and extract the signature.
 *
 * It must be exactly the listing PSBT for these terms (same outpoint,
 * sequence, version, locktime, and one output paying `payoutScript`
 * `priceSats`), and the carrier input must carry a valid signature with
 * sighash SINGLE|ANYONECANPAY — any other sighash would either let the buyer
 * redirect the payout or tie the signature to a transaction that never exists.
 */
export function verifyListingPsbt(
  psbtBase64: string,
  expected: { network: bitcoin.networks.Network; source: ListingSource; payoutScript: Buffer; priceSats: bigint },
): SellerPresig {
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: expected.network });
  } catch (e) {
    throw new MarketError("LISTING_BAD_SIGNATURE", `cannot parse the signed listing: ${(e as Error).message}`);
  }
  unfinalizeKeyInputs(psbt);

  const want = buildListingPsbt(expected);
  const got = psbt.data.globalMap.unsignedTx.toBuffer();
  if (!got.equals(want.data.globalMap.unsignedTx.toBuffer())) {
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      "the signed listing is not the listing for these terms (carrier, payout, price, version, locktime or sequence differ)",
    );
  }
  const input = psbt.data.inputs[0]!;
  const wu = input.witnessUtxo;
  if (!wu || !Buffer.from(wu.script).equals(expected.source.script) || BigInt(wu.value) !== expected.source.valueSats) {
    throw new MarketError("LISTING_BAD_SIGNATURE", "the signed listing does not describe the carrier being sold");
  }
  const check = checkListingSignature(psbt, 0);
  if (!check.ok) {
    throw new MarketError(
      check.reason === "NOT_SIGHASH_ALL" ? "UNSAFE_SIGHASH" : "LISTING_BAD_SIGNATURE",
      `listing signature: ${check.detail}`,
    );
  }
  if (input.tapKeySig) return { tapKeySig: Buffer.from(input.tapKeySig) };
  return {
    partialSig: input.partialSig!.map((p) => ({ pubkey: Buffer.from(p.pubkey), signature: Buffer.from(p.signature) })),
  };
}

/** Read the stored signature back out of a verified listing PSBT (server side only). */
export function presigOf(psbtBase64: string, network: bitcoin.networks.Network): SellerPresig {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  unfinalizeKeyInputs(psbt);
  const input = psbt.data.inputs[0]!;
  if (input.tapKeySig) return { tapKeySig: Buffer.from(input.tapKeySig) };
  if (input.partialSig?.length) {
    return { partialSig: input.partialSig.map((p) => ({ pubkey: Buffer.from(p.pubkey), signature: Buffer.from(p.signature) })) };
  }
  throw new MarketError("LISTING_BAD_SIGNATURE", "stored listing has no signature");
}

export interface FillFundInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  publicKey?: Buffer;
}

/**
 * The fill transaction:
 *
 *   inputs   [0] buyer coin  [1] seller carrier  [2..] more buyer coins
 *   outputs  [0] Cove TRANSFER (all tokens → vout 2)  [1] seller payout
 *            [2] buyer token carrier  [3] market fee  [4] buyer change?
 *
 * Input 1 pairs with output 1 for the seller's SIGHASH_SINGLE. The seller's
 * carrier brings its 1,000 sats in; the buyer's new carrier takes 1,000 out,
 * so the buyer pays exactly price + market fee + miner fee.
 */
export function buildPresignedFillPsbt(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  seller: ListingSource & { amountAtoms: bigint };
  payoutScript: Buffer;
  priceSats: bigint;
  buyerTokenScript: Buffer;
  fundInputs: FillFundInput[];
  buyerChangeScript: Buffer;
  feeScript: Buffer;
  marketFeeSats: bigint;
  minerFeeSats: bigint;
}): { psbt: bitcoin.Psbt; minerFeeSats: bigint; changeSats: bigint } {
  if (params.fundInputs.length === 0) {
    throw new MarketError("BUYER_FUNDS_INSUFFICIENT", "a purchase needs at least one funding coin");
  }
  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.setVersion(LISTING_TX_VERSION);
  psbt.setLocktime(LISTING_LOCKTIME);
  const [first, ...rest] = params.fundInputs;
  psbt.addInput(psbtInputFor(first!, params.network));
  psbt.addInput({ ...psbtInputFor(params.seller, params.network), sequence: LISTING_SEQUENCE });
  for (const f of rest) psbt.addInput(psbtInputFor(f, params.network));

  const wire = encodeTransferV2({
    tokenId: params.tokenId,
    allocations: [{ vout: FILL_BUYER_CARRIER_VOUT, amount: params.seller.amountAtoms }],
  });
  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  psbt.addOutput({ script: params.payoutScript, value: Number(params.priceSats) });
  psbt.addOutput({ script: params.buyerTokenScript, value: Number(TOKEN_CARRIER_SATS) });
  psbt.addOutput({ script: params.feeScript, value: Number(params.marketFeeSats) });

  const totalIn = params.fundInputs.reduce((s, f) => s + f.valueSats, 0n) + params.seller.valueSats;
  const spent = params.priceSats + TOKEN_CARRIER_SATS + params.marketFeeSats + params.minerFeeSats;
  const change = totalIn - spent;
  if (change < 0n) throw new MarketError("BUYER_FUNDS_INSUFFICIENT", `short ${-change} sats`);
  // Change below dust cannot be an output; it goes to the miner.
  if (change >= dustThreshold(params.buyerChangeScript)) {
    psbt.addOutput({ script: params.buyerChangeScript, value: Number(change) });
    return { psbt, minerFeeSats: params.minerFeeSats, changeSats: change };
  }
  return { psbt, minerFeeSats: params.minerFeeSats + change, changeSats: 0n };
}

/** Put the seller's stored signature on their carrier input. */
export function attachSellerPresig(psbt: bitcoin.Psbt, presig: SellerPresig): void {
  if (presig.tapKeySig) psbt.updateInput(FILL_SELLER_INPUT, { tapKeySig: presig.tapKeySig });
  else if (presig.partialSig) psbt.updateInput(FILL_SELLER_INPUT, { partialSig: presig.partialSig });
  else throw new MarketError("LISTING_BAD_SIGNATURE", "no seller signature to attach");
}
