"use client";

import { useCallback, useEffect, useState } from "react";
import { COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import { crcCancelMessage, crcListingMessage, type CrcFillOptions, type CrcListing, type IndexedCrcAsset } from "@crclaunch/cove-market";
import { fetchAllCrcWalletBalances, type CrcWalletBalance } from "@/lib/crc-client";
import { makeCrcSellerListing, sellerFillTermsFromPsbt, signCrcSellerFillAfterReview } from "@/lib/crc-market-seller";
import { formatAtoms } from "./CrcHome";
import { useWallet } from "./WalletProvider";

type TokenCoin = { txid: string; vout: number; atoms: string; scriptHex: string };
type BitcoinCoin = { txid: string; vout: number; valueSats: string };
type Token = { assetId: string; network: CrcListing["network"]; deployTxid: string; ticker: string;
  protocolVersion: number; protocolScriptHex: string; vault: { scriptHex: string } };
type FillRequest = { fillId: string; listingId: string; buyerSignedPsbtBase64: string;
  amountAtoms: string; priceSats: string; expiresAt: string;
  listing: Omit<CrcListing, "amountAtoms" | "expiresAtHeight"> & { amountAtoms: string; expiresAtHeight: string } };
type ListingRow = FillRequest["listing"] & { status: string };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.error?.detail || result?.error?.message || `Request failed: ${response.status}`);
  }
  return result.data as T;
}

function decimal(value: string, name: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} is invalid`);
  return BigInt(value);
}

function deserializeListing(row: FillRequest["listing"]): CrcListing {
  return { ...row, amountAtoms: decimal(row.amountAtoms, "token amount"),
    expiresAtHeight: decimal(row.expiresAtHeight, "expiry") };
}

function serializeListing(listing: CrcListing) {
  return { ...listing, amountAtoms: listing.amountAtoms.toString(),
    expiresAtHeight: listing.expiresAtHeight.toString() };
}

function sellerAsset(token: Token, coin: TokenCoin | undefined): IndexedCrcAsset {
  return { network: token.network, deployTxid: token.deployTxid, ticker: token.ticker,
    protocolVersion: token.protocolVersion,
    tokenOutpoint: coin ? `${coin.txid}:${coin.vout}` : null,
    tokenScriptHex: coin?.scriptHex ?? null, tokenAtoms: BigInt(coin?.atoms ?? "0"),
    protocolScriptHex: token.protocolScriptHex, vaultScriptHex: token.vault.scriptHex };
}

export function CrcMarketSeller() {
  const wallet = useWallet();
  const { connected, ordinalsAddress, ordinalsScript, network, connect, signPsbt, signBip322 } = wallet;
  const [active, setActive] = useState(false);
  const [balances, setBalances] = useState<CrcWalletBalance[]>([]);
  const [assetId, setAssetId] = useState("");
  const [token, setToken] = useState<Token | null>(null);
  const [height, setHeight] = useState(0n);
  const [coins, setCoins] = useState<TokenCoin[]>([]);
  const [btcCoins, setBtcCoins] = useState<BitcoinCoin[]>([]);
  const [selected, setSelected] = useState("");
  const [price, setPrice] = useState("");
  const [expiryBlocks, setExpiryBlocks] = useState("12");
  const [preview, setPreview] = useState<CrcListing | null>(null);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [requests, setRequests] = useState<FillRequest[]>([]);
  const [reviewedFill, setReviewedFill] = useState<{ request: FillRequest; terms: CrcFillOptions } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refreshSeller = useCallback(async () => {
    if (!connected || !ordinalsAddress || !ordinalsScript) return;
    const [held, market] = await Promise.all([
      fetchAllCrcWalletBalances(ordinalsAddress),
      api<{ active: boolean; listings: ListingRow[] }>("/api/crc/v1/market/listings"),
    ]);
    setBalances(held);
    setListings(market.listings.filter((listing) => listing.sellerScriptHex.toLowerCase() === ordinalsScript.toLowerCase()));
    setActive(market.active);
    setAssetId((previous) => previous || held[0]?.assetId || "");
  }, [connected, ordinalsAddress, ordinalsScript]);

  useEffect(() => {
    let alive = true;
    if (!connected) { setBalances([]); setListings([]); return; }
    void refreshSeller().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load seller balance"); });
    return () => { alive = false; };
  }, [connected, refreshSeller]);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setToken(null);
    setCoins([]);
    setBtcCoins([]);
    setSelected("");
    if (!assetId || !connected || !ordinalsAddress) return;
    void Promise.all([
      api<{ indexedTip: { height: string }; token: Token }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`),
      api<{ utxos: TokenCoin[]; truncated: boolean }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
      api<{ utxos: BitcoinCoin[] }>(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
    ]).then(([detail, tokenOutputs, bitcoinOutputs]) => {
      if (!alive) return;
      if (tokenOutputs.truncated) throw new Error("This address has more than 100 token outputs. Consolidate before listing.");
      if (detail.token.protocolVersion !== 2 || detail.token.network !== network) throw new Error("Only Cove v2 token outputs can be listed");
      setToken(detail.token);
      setHeight(decimal(detail.indexedTip.height, "indexed height"));
      setCoins(tokenOutputs.utxos);
      setBtcCoins(bitcoinOutputs.utxos);
      setSelected(tokenOutputs.utxos[0] ? `${tokenOutputs.utxos[0].txid}:${tokenOutputs.utxos[0].vout}` : "");
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load token outputs"); });
    return () => { alive = false; };
  }, [assetId, connected, ordinalsAddress, network]);

  const loadRequests = useCallback(async () => {
    if (!active || !connected || !ordinalsScript) return;
    const data = await api<{ requests: FillRequest[] }>("/api/crc/v1/market/seller-requests", { sellerScriptHex: ordinalsScript });
    setRequests(data.requests);
  }, [active, connected, ordinalsScript]);

  function buildPreview() {
    setError("");
    setSuccess("");
    try {
      if (!token || !selected) throw new Error("Select a whole token output");
      if (!/^[1-9]\d*$/.test(price) || !Number.isSafeInteger(Number(price))) throw new Error("Enter a whole satoshi price");
      if (!/^[1-9]\d*$/.test(expiryBlocks) || BigInt(expiryBlocks) > 2016n) throw new Error("Expiry must be 1 to 2,016 blocks");
      const coin = coins.find((item) => `${item.txid}:${item.vout}` === selected);
      if (!coin) throw new Error("Selected token output is unavailable");
      const bitcoinCoin = btcCoins.find((item) => `${item.txid}:${item.vout}` === selected) ?? null;
      const asset = sellerAsset(token, coin);
      const listing = makeCrcSellerListing({ id: crypto.randomUUID(), network: token.network,
        deployTxid: token.deployTxid, ticker: token.ticker, sellerScriptHex: ordinalsScript,
        sellerPayoutScriptHex: ordinalsScript, tokenCoin: coin, bitcoinCoin,
        priceSats: Number(price), currentHeight: height,
        expiresAtHeight: height + BigInt(expiryBlocks), asset },
      COVE_FEE_CONFIG.p2pFeeBps, COVE_FEE_CONFIG.p2pFeeMinSats);
      setPreview(listing);
    } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "Could not preview listing"); }
  }

  async function submitListing() {
    if (!preview || !active) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const current = await api<{ indexedTip: { height: string }; token: Token }>(`/api/crc/v1/tokens/${encodeURIComponent(`${preview.network}:${preview.deployTxid}`)}`);
      const tokenOutputs = await api<{ utxos: TokenCoin[] }>(`/api/crc/v1/tokens/${encodeURIComponent(`${preview.network}:${preview.deployTxid}`)}/utxos?address=${encodeURIComponent(ordinalsAddress)}`);
      const bitcoinOutputs = await api<{ utxos: BitcoinCoin[] }>(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(ordinalsAddress)}`);
      const coin = tokenOutputs.utxos.find((item) => item.txid === preview.sellerAnchorTxid && item.vout === preview.sellerAnchorVout);
      if (!coin) throw new Error("Selected token output moved. Preview again.");
      const bitcoinCoin = bitcoinOutputs.utxos.find((item) => item.txid === coin.txid && item.vout === coin.vout) ?? null;
      const rechecked = makeCrcSellerListing({ ...preview, tokenCoin: coin, bitcoinCoin,
        currentHeight: decimal(current.indexedTip.height, "indexed height"), asset: sellerAsset(current.token, coin) },
      COVE_FEE_CONFIG.p2pFeeBps, COVE_FEE_CONFIG.p2pFeeMinSats);
      if (crcListingMessage(rechecked) !== crcListingMessage(preview)) throw new Error("Listing terms changed. Preview again.");
      const sellerAuthorizationB64 = await signBip322(crcListingMessage(preview));
      const result = await api<{ listingId: string }>("/api/crc/v1/market/listings", {
        listing: serializeListing(preview), sellerAuthorizationB64,
      });
      setSuccess(`Listed token output ${result.listingId}`);
      setPreview(null);
      await refreshSeller();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not list token output"); }
    finally { setBusy(false); }
  }

  async function cancelListing(row: ListingRow) {
    if (!active) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const listing = deserializeListing(row);
      if (listing.sellerScriptHex.toLowerCase() !== ordinalsScript.toLowerCase()) throw new Error("Listing belongs to another wallet");
      const sellerAuthorizationB64 = await signBip322(crcCancelMessage(listing));
      await api("/api/crc/v1/market/cancel", { listingId: listing.id, sellerAuthorizationB64 });
      setSuccess("Listing canceled");
      await refreshSeller();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel listing"); }
    finally { setBusy(false); }
  }

  async function reviewFill(request: FillRequest) {
    if (!active) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const listing = deserializeListing(request.listing);
      if (listing.id !== request.listingId || listing.sellerScriptHex.toLowerCase() !== ordinalsScript.toLowerCase()) {
        throw new Error("Fill listing does not match the connected wallet");
      }
      const assetId = `${listing.network}:${listing.deployTxid}`;
      const [detail, tokenOutputs, bitcoinOutputs] = await Promise.all([
        api<{ indexedTip: { height: string }; token: Token }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`),
        api<{ utxos: TokenCoin[] }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
        api<{ utxos: BitcoinCoin[] }>(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
      ]);
      const coin = tokenOutputs.utxos.find((item) => item.txid === listing.sellerAnchorTxid && item.vout === listing.sellerAnchorVout);
      const btc = bitcoinOutputs.utxos.find((item) => item.txid === listing.sellerAnchorTxid && item.vout === listing.sellerAnchorVout);
      if (!coin || !btc || coin.atoms !== listing.amountAtoms.toString() || btc.valueSats !== String(listing.sellerAnchorSats)) {
        throw new Error("Listed token output no longer matches the indexed Bitcoin output");
      }
      const asset = sellerAsset(detail.token, coin);
      const terms = sellerFillTermsFromPsbt(request.buyerSignedPsbtBase64, listing, asset,
        decimal(detail.indexedTip.height, "indexed height"));
      setReviewedFill({ request, terms });
    } catch (cause) { setReviewedFill(null); setError(cause instanceof Error ? cause.message : "Could not review sale"); }
    finally { setBusy(false); }
  }

  async function signFill() {
    if (!active || !reviewedFill) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const { request, terms } = reviewedFill;
      const signedPsbtBase64 = await signCrcSellerFillAfterReview(request.buyerSignedPsbtBase64,
        terms, ordinalsScript, signPsbt);
      const signed = await api<{ txid: string }>("/api/crc/v1/market/seller-sign", {
        fillId: request.fillId, signedPsbtBase64,
      });
      const broadcast = await api<{ txid: string }>("/api/crc/v1/market/broadcast", { fillId: request.fillId });
      if (broadcast.txid !== signed.txid) throw new Error("Broadcast transaction differs from signed sale");
      setSuccess(`Sale submitted: ${broadcast.txid}`);
      setReviewedFill(null);
      await loadRequests();
      await refreshSeller();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign sale"); }
    finally { setBusy(false); }
  }

  return <section className="space-y-4 border border-rule bg-ink-2 p-6">
    <div><h2 className="text-lg text-bone">Sell a token output</h2>
      <p className="mt-1 text-sm text-bone-dim">Each listing sells one whole confirmed token output. You approve the complete sale transaction when a buyer is ready.</p></div>
    {!connected && <button type="button" className="btn" onClick={() => void connect()}>Connect wallet</button>}
    {connected && <>
      <label className="block text-sm text-bone-dim">Token
        <select className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone" value={assetId}
          onChange={(event) => setAssetId(event.target.value)}>
          {balances.map((balance) => <option key={balance.assetId} value={balance.assetId}>${balance.ticker} · {formatAtoms(balance.atoms)} tokens</option>)}
        </select>
      </label>
      {balances.length === 0 && <p className="text-sm text-bone-dim">No confirmed Cove tokens in this wallet.</p>}
      {coins.length > 0 && <label className="block text-sm text-bone-dim">Whole token output
        <select className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone" value={selected}
          onChange={(event) => { setSelected(event.target.value); setPreview(null); }}>
          {coins.map((coin) => <option key={`${coin.txid}:${coin.vout}`} value={`${coin.txid}:${coin.vout}`}>
            {formatAtoms(coin.atoms)} tokens · {coin.txid.slice(0, 12)}:{coin.vout}
          </option>)}
        </select>
      </label>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm text-bone-dim">Your BTC price (sats)
          <input className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone" inputMode="numeric"
            value={price} onChange={(event) => { setPrice(event.target.value); setPreview(null); }} />
        </label>
        <label className="block text-sm text-bone-dim">Expiry (blocks)
          <input className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone" inputMode="numeric"
            value={expiryBlocks} onChange={(event) => { setExpiryBlocks(event.target.value); setPreview(null); }} />
        </label>
      </div>
      <button type="button" className="btn-ghost" disabled={!token || !selected || busy} onClick={buildPreview}>Review listing</button>
      {preview && <div className="space-y-1 border-t border-rule pt-4 text-sm text-bone-dim">
        <p>Tokens: {formatAtoms(preview.amountAtoms.toString())} ${preview.ticker}</p>
        <p>Your BTC payout: {preview.priceSats} sats</p>
        <p>Buyer pays protocol fee: {preview.protocolFeeSats} sats</p>
        <p>Expires after block {preview.expiresAtHeight.toString()}</p>
        <p className="break-all">Your token coin: {preview.sellerAnchorTxid}:{preview.sellerAnchorVout}</p>
        <p className="break-all">Payout script: {preview.sellerPayoutScriptHex}</p>
        <button type="button" className="btn mt-3" disabled={!active || busy} onClick={() => void submitListing()}>
          {busy ? "Working…" : "Sign and create listing"}
        </button>
      </div>}
      <div className="border-t border-rule pt-4">
        <div className="flex gap-2"><button type="button" className="btn-ghost" disabled={!active || busy}
          onClick={() => void loadRequests().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load sale requests"))}>
          Check buyer requests
        </button></div>
        {requests.map((request) => <div key={request.fillId} className="mt-3 border border-rule p-3 text-sm text-bone-dim">
          <p>Buyer request · {formatAtoms(request.amountAtoms)} tokens · {request.priceSats} sats to you</p>
          <p>Expires {new Date(request.expiresAt).toLocaleString()}</p>
          <button type="button" className="btn-ghost mt-2" disabled={!active || busy} onClick={() => void reviewFill(request)}>
            Review full transaction
          </button>
        </div>)}
        {reviewedFill && <div className="mt-3 space-y-1 border border-signal p-3 text-sm text-bone-dim">
          <p className="text-bone">Confirm exact sale</p>
          <p>Tokens: {formatAtoms(reviewedFill.terms.listing.amountAtoms.toString())} ${reviewedFill.terms.listing.ticker}</p>
          <p>Your BTC payout: {reviewedFill.terms.listing.priceSats} sats</p>
          <p>Protocol fee: {reviewedFill.terms.listing.protocolFeeSats} sats</p>
          <p>Miner fee: {reviewedFill.terms.minerFeeSats} sats</p>
          <p>Sale expires after block {reviewedFill.terms.listing.expiresAtHeight.toString()}</p>
          <p className="break-all">Token coin: {reviewedFill.terms.listing.sellerAnchorTxid}:{reviewedFill.terms.listing.sellerAnchorVout}</p>
          <p className="break-all">Buyer token script: {reviewedFill.terms.buyerScriptHex}</p>
          <p className="break-all">Buyer BTC funding script: {reviewedFill.terms.buyerFunding[0]?.scriptHex}</p>
          <p className="break-all">Your payout script: {reviewedFill.terms.listing.sellerPayoutScriptHex}</p>
          <button type="button" className="btn mt-2" disabled={busy} onClick={() => void signFill()}>Sign exact transaction</button>
        </div>}
      </div>
      {listings.length > 0 && <div className="border-t border-rule pt-4"><h3 className="text-sm text-bone">Your open listings</h3>
        {listings.map((row) => <div key={row.id} className="mt-2 flex items-center justify-between gap-3 text-sm text-bone-dim">
          <span>{formatAtoms(row.amountAtoms)} ${row.ticker} · {row.priceSats} sats</span>
          <button type="button" className="btn-ghost" disabled={!active || busy} onClick={() => void cancelListing(row)}>Cancel</button>
        </div>)}
      </div>}
    </>}
    {!active && <p className="text-sm text-bone-dim">Marketplace signing is paused until the v2 sale tests pass.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {success && <p role="status" className="break-all text-sm text-signal">{success}</p>}
  </section>;
}
