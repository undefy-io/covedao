/**
 * Presigned listing through the API, the way the web does it: split off an
 * exact coin if needed (a transfer to yourself), then sign that coin once,
 * SIGHASH_SINGLE|ANYONECANPAY, over the payout. E2E only.
 */

const BASE = "http://localhost:3100";

async function post(url: string, body: unknown) {
  const j = await fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (!j.ok) throw new Error(`${url}: ${j.error?.code ?? ""} ${j.error?.message ?? ""} ${j.error?.detail ?? ""}`);
  return j.data;
}

export interface ListingWallet {
  /** walletScript / ordinalsScript / public keys, as the web sends them. */
  fields: Record<string, string | undefined>;
  /** The address holding the tokens. */
  tokenAddress: string;
  /** BTC coins for the split's miner fee. */
  getUtxos: () => Promise<{ txid: string; vout: number }[]>;
  /** Signs with whatever sighash each input asks for. */
  sign: (psbtBase64: string) => string;
}

export async function apiListPresigned(
  w: ListingWallet,
  tokenId: string,
  amountAtoms: bigint,
  priceSats: number,
): Promise<{ listingId: string; pending: boolean }> {
  const pf = await fetch(`${BASE}/api/v3/wallet/${w.tokenAddress}/portfolio`).then((r) => r.json());
  const coins = (pf.data.tokenUtxos as { txid: string; vout: number; tokenId: string; amountAtoms: string }[]).filter((u) => u.tokenId === tokenId);
  let source = coins.find((u) => BigInt(u.amountAtoms) === amountAtoms);
  let pending = false;
  if (!source) {
    const built = await post("/api/v3/transfer/build", {
      tokenId,
      amountAtoms: amountAtoms.toString(),
      recipientScript: w.fields.ordinalsScript || w.fields.walletScript,
      ...w.fields,
      funding: await w.getUtxos(),
      idempotencyKey: `split-${Date.now()}-${Math.random()}`,
    });
    const sent = await post("/api/v3/transfer/submit", { sessionId: built.sessionId, signedPsbtBase64: w.sign(built.psbtBase64) });
    source = { txid: sent.txid, vout: 1, tokenId, amountAtoms: amountAtoms.toString() };
    pending = true;
  }
  const prep = await post("/api/v3/market/listings/prepare", {
    tokenId,
    sourceTxid: source.txid,
    sourceVout: String(source.vout),
    amountAtoms: amountAtoms.toString(),
    totalPriceSats: String(priceSats),
    expiryBlocks: "1008",
    ...w.fields,
  });
  const made = await post("/api/v3/market/listings", {
    listing: prep.listing,
    presignedPsbtBase64: w.sign(prep.listingPsbtBase64),
    sellerTokenPublicKey: w.fields.ordinalsPublicKey,
  });
  return { listingId: made.listingId, pending };
}

/** Wait until a listing reaches `status` in the public book (ACTIVE) or the seller's portfolio. */
export async function waitForListing(listingId: string, tokenId: string, status = "ACTIVE", timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const l = await fetch(`${BASE}/api/v3/market/listings?tokenId=${tokenId}`).then((r) => r.json());
    if ((l.data ?? []).some((x: { listingId: string; status: string }) => x.listingId === listingId && x.status === status)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`listing ${listingId.slice(0, 12)} never became ${status}`);
}
