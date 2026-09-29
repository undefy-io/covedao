"use client";

import { notifyLocalBroadcast } from "./use-indexed-block";
import { fetchPortfolio } from "./portfolio";

import { tr, translateError } from "@/i18n";
import { verifyClientIntent, verifyListingIntent } from "@crclaunch/wallets";
import { scriptOf, bitcoinNetwork } from "@/lib/wallets/resolve";
import type { CoveNetwork } from "@/lib/wallets/types";

/**
 * Trades shared by more than one page: filling someone's ask, and sending
 * tokens. Each takes the wallet functions it needs rather than reaching for
 * the wallet context, so a page decides what it shows while these decide
 * what is signed.
 */

export interface WalletOps {
  script: string;
  publicKey: string;
  ordinalsScript: string;
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>;
  signBip322: (message: string) => Promise<string>;
  getUtxos: () => Promise<{ txid: string; vout: number }[]>;
}

/**
 * The server's own words when it has them; the short copy otherwise. In
 * Chinese, a known error code shows its translation instead.
 */
export function errorText(j: {
  error?: { code?: string; message?: string; detail?: string };
}): string {
  return translateError(
    j.error?.code,
    j.error?.detail || j.error?.message || tr("common.somethingWrong"),
  );
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(errorText(j));
  if (/\/(submit|buyer-signature|reserve|cancel)$/.test(url) || url.endsWith("/market/listings"))
    notifyLocalBroadcast();
  return j.data;
}

/**
 * Buy a listing: reserve it with a signed nonce, have the buyer sign the fill,
 * and the server completes it with the seller's presignature and broadcasts.
 * The seller does nothing. Returns the transaction id.
 */
export async function buyListing(
  listing: { listingId: string; amountAtoms: string; totalPriceSats: string },
  w: WalletOps,
  satPerVb: bigint | string | null,
): Promise<{ fillId: string; txid: string }> {
  const funding = await w.getUtxos();
  const tokenScript = w.ordinalsScript || w.script;
  // A signed nonce, so nobody can lock every listing for free.
  const prep = await post(`/api/v3/market/listings/${listing.listingId}/reserve/prepare`, {
    buyerTokenScript: tokenScript,
  });
  const signatureB64 = await w.signBip322(prep.message);
  const { fillId } = await post(`/api/v3/market/listings/${listing.listingId}/reserve`, {
    // Bought tokens go to the ordinals address; BTC change returns to the one that paid.
    buyerTokenScript: tokenScript,
    buyerChangeScript: w.script,
    buyerFundPublicKey: w.publicKey || undefined,
    funding,
    nonceHex: prep.reserveNonce,
    signatureB64,
  });
  const built = await post(`/api/v3/market/fills/${fillId}/build`, {
    feeRateSatPerVb: satPerVb ?? undefined,
  });
  // The wallet's own scripts and the price on the listing are the user's
  // facts; the server's copy of them is not trusted.
  if (!built.intent) throw new Error(tr("trade.noIntent"));
  verifyClientIntent(built.psbtBase64, {
    ...built.intent,
    walletScript: w.script,
    ordinalsScript: tokenScript,
    grossSats: listing.totalPriceSats,
    tokenAmountAtoms: listing.amountAtoms,
  });
  const signed = await w.signPsbt(built.psbtBase64, "P2P_BUY");
  const done = await post(`/api/v3/market/fills/${fillId}/buyer-signature`, {
    signedPsbtBase64: signed,
  });
  return { fillId, txid: done.txid as string };
}

function networkOf(network: string) {
  return bitcoinNetwork(network as CoveNetwork);
}

/** A recipient typed as an address, or (for tooling) as a raw scriptPubKey in hex. */
export function recipientScript(input: string, network: string): string {
  if (/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/i.test(input)) return input.toLowerCase();
  return scriptOf(input, network as CoveNetwork);
}

/** Send tokens to another wallet. Returns the txid. */
export async function sendTokens(params: {
  tokenId: string;
  amountAtoms: string;
  recipient: string;
  network: string;
  walletFields: Record<string, string | undefined>;
  getUtxos: WalletOps["getUtxos"];
  signPsbt: WalletOps["signPsbt"];
  satPerVb: bigint | string | null;
}): Promise<string> {
  const funding = await params.getUtxos();
  const built = await post("/api/v3/transfer/build", {
    tokenId: params.tokenId,
    amountAtoms: params.amountAtoms,
    recipientScript: recipientScript(params.recipient, params.network),
    ...params.walletFields,
    funding,
    feeRateSatPerVb: params.satPerVb ?? undefined,
    idempotencyKey: `transfer-${params.tokenId}-${Date.now()}`,
  });
  verifyClientIntent(built.psbtBase64, built.intent);
  const signed = await params.signPsbt(built.psbtBase64, "TRANSFER");
  const sent = await post("/api/v3/transfer/submit", {
    sessionId: built.sessionId,
    signedPsbtBase64: signed,
  });
  return sent.txid;
}

/**
 * List tokens for sale, presigned the way Ordinals marketplaces do it.
 *
 * A listing sells ONE whole token coin (carrier). If no coin holds exactly
 * the amount, the wallet first splits one: a transfer to itself that makes a
 * coin of exactly that amount (one signature). Then the seller signs that
 * coin once, SIGHASH_SINGLE|ANYONECANPAY, over their payout (one signature).
 * That is everything: when someone buys, the seller signs nothing.
 *
 * A listing on a fresh split waits as PENDING until the split confirms.
 */
export async function createListing(params: {
  tokenId: string;
  amountAtoms: bigint;
  totalPriceSats: string;
  expiryBlocks: string;
  network: string;
  /** The address holding the tokens (ordinals address, or the only one). */
  tokenAddress: string;
  walletFields: Record<string, string | undefined>;
  getUtxos: WalletOps["getUtxos"];
  signPsbt: WalletOps["signPsbt"];
  satPerVb: bigint | string | null;
}): Promise<{ listingId: string; pending: boolean }> {
  if (params.amountAtoms <= 0n) throw new Error(tr("trade.enterAmount"));
  if (!/^\d+$/.test(params.totalPriceSats) || BigInt(params.totalPriceSats) <= 0n)
    throw new Error(tr("trade.enterPrice"));
  const tokenScript = params.walletFields.ordinalsScript || params.walletFields.walletScript!;
  const payoutScript = params.walletFields.walletScript!;
  const pf = await fetchPortfolio(params.tokenAddress, { onlyTokenUtxos: true });
  const mine = pf.tokenUtxos.filter((u) => u.tokenId === params.tokenId);
  const held = mine.reduce((a, u) => a + BigInt(u.amountAtoms), 0n);
  if (held < params.amountAtoms) throw new Error(tr("trade.notEnoughTokens"));

  // A coin of exactly this amount, or split one off.
  let source: { txid: string; vout: number };
  let split = false;
  const exact = mine.find((u) => BigInt(u.amountAtoms) === params.amountAtoms);
  if (exact) {
    source = { txid: exact.txid, vout: exact.vout };
  } else {
    const funding = await params.getUtxos();
    const built = await post("/api/v3/transfer/build", {
      tokenId: params.tokenId,
      amountAtoms: params.amountAtoms.toString(),
      recipientScript: tokenScript,
      ...params.walletFields,
      funding,
      feeRateSatPerVb: params.satPerVb ?? undefined,
      idempotencyKey: `split-${params.tokenId}-${Date.now()}`,
    });
    // The split keeps every token in the wallet and makes an exact coin.
    verifyClientIntent(built.psbtBase64, { ...built.intent, operation: "SPLIT" });
    const signed = await params.signPsbt(built.psbtBase64, "TRANSFER");
    const sent = await post("/api/v3/transfer/submit", {
      sessionId: built.sessionId,
      signedPsbtBase64: signed,
    });
    // The transfer builder puts the recipient's (exact) coin at output 1.
    source = { txid: sent.txid as string, vout: 1 };
    split = true;
  }

  const prep = await post("/api/v3/market/listings/prepare", {
    tokenId: params.tokenId,
    sourceTxid: source.txid,
    sourceVout: String(source.vout),
    amountAtoms: params.amountAtoms.toString(),
    totalPriceSats: params.totalPriceSats,
    expiryBlocks: params.expiryBlocks,
    ...params.walletFields,
  });
  // Never blind-sign a standing offer: one coin of mine, one payment to me.
  verifyListingIntent(
    prep.listingPsbtBase64,
    {
      sourceTxid: source.txid,
      sourceVout: source.vout,
      carrierScript: tokenScript,
      payoutScript,
      priceSats: params.totalPriceSats,
    },
    networkOf(params.network),
  );
  const presigned = await params.signPsbt(prep.listingPsbtBase64, "P2P_LIST");
  const created = await post("/api/v3/market/listings", {
    listing: prep.listing,
    presignedPsbtBase64: presigned,
    sellerTokenPublicKey: params.walletFields.ordinalsPublicKey,
  });
  return { listingId: created.listingId as string, pending: split };
}
