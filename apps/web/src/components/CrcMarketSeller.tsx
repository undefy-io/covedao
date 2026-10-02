"use client";

import { useCallback, useEffect, useState } from "react";
import * as core from "@crclaunch/crc20-protocol";
import { fetchAllCrcWalletBalances, type CrcWalletBalance } from "@/lib/crc-client";
import { makeCrcSellerListing, signCrcSellerListing, type CrcSellerListing } from "@/lib/crc-market-seller";
import { crcBrowserData } from "@/lib/crc-browser-session";
import { cancelCrcMarketListing, type CrcMarketListing } from "@/lib/crc-market-client";
import { formatAtoms } from "./CrcHome";
import { useWallet } from "./WalletProvider";

type TokenCoin = { txid: string; vout: number; atoms: string; scriptHex: string };
type BitcoinCoin = { txid: string; vout: number; valueSats: string; confirmations?: number };
type Token = { assetId: string; network: string; deployTxid: string; ticker: string; coreState: unknown };
type FillRequest = { fillId: string; amountAtoms: string; priceSats: string; expiresAt: string };
type ReviewedFillDisplay = { terms: { listing: CrcSellerListing; minerFeeSats: number; buyerScriptHex: string; buyerFunding: { scriptHex: string }[]; buyerFundingScriptHex?: string } };
const api = <T,>(url: string, body?: unknown) => crcBrowserData<T>(fetch, url, body);

export function CrcMarketSeller() {
  const wallet = useWallet();
  const { connected, ordinalsAddress, ordinalsScript, ordinalsPublicKey, network, connect, signPsbt, signBip322 } = wallet;
  const [active, setActive] = useState(false);
  const [balances, setBalances] = useState<CrcWalletBalance[]>([]);
  const [assetId, setAssetId] = useState("");
  const [token, setToken] = useState<Token | null>(null);
  const [height, setHeight] = useState(0);
  const [coins, setCoins] = useState<TokenCoin[]>([]);
  const [btcCoins, setBtcCoins] = useState<BitcoinCoin[]>([]);
  const [selected, setSelected] = useState("");
  const [price, setPrice] = useState("");
  const [expiryBlocks, setExpiryBlocks] = useState("12");
  const [preview, setPreview] = useState<CrcSellerListing | null>(null);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);
  const [requests, setRequests] = useState<FillRequest[]>([]);
  const [reviewedFill] = useState<ReviewedFillDisplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refreshSeller = useCallback(async () => {
    const market = await api<{ active: boolean; listings: CrcMarketListing[] }>("/api/crc/v1/market/listings");
    setActive(market.active);
    if (!market.active || !connected || !ordinalsAddress || !ordinalsScript) { setBalances([]); setListings([]); return; }
    const held = await fetchAllCrcWalletBalances(ordinalsAddress);
    setBalances(held);
    setListings(market.listings.filter((listing) => listing.sellerScriptHex === ordinalsScript));
    setAssetId((previous) => previous || held[0]?.assetId || "");
  }, [connected, ordinalsAddress, ordinalsScript]);

  useEffect(() => {
    let alive = true;
    void refreshSeller().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load seller balance"); });
    return () => { alive = false; };
  }, [connected, refreshSeller]);

  useEffect(() => {
    let alive = true;
    setPreview(null); setToken(null); setCoins([]); setBtcCoins([]); setSelected("");
    if (!active || !assetId || !connected || !ordinalsAddress) return;
    void Promise.all([
      api<{ indexedTip: { height: string }; token: Token }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`),
      api<{ utxos: TokenCoin[]; truncated: boolean }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
      api<{ utxos: BitcoinCoin[] }>(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
    ]).then(([detail, tokenOutputs, bitcoinOutputs]) => {
      if (!alive) return;
      if (tokenOutputs.truncated) throw new Error("This address has more than 100 token outputs. Consolidate before listing.");
      if (detail.token.network !== network) throw new Error("Wallet network differs from indexed token");
      const indexed = Number(detail.indexedTip.height);
      if (!Number.isSafeInteger(indexed) || indexed < 0) throw new Error("Invalid indexed height");
      setToken(detail.token); setHeight(indexed); setCoins(tokenOutputs.utxos); setBtcCoins(bitcoinOutputs.utxos);
      setSelected(tokenOutputs.utxos[0] ? `${tokenOutputs.utxos[0].txid}:${tokenOutputs.utxos[0].vout}` : "");
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load token outputs"); });
    return () => { alive = false; };
  }, [active, assetId, connected, ordinalsAddress, network]);

  const loadRequests = useCallback(async () => {
    if (!active || !connected || !ordinalsScript) return;
    const data = await api<{ requests: FillRequest[] }>("/api/crc/v1/market/seller-requests", { sellerScriptHex: ordinalsScript });
    if (data.requests.length) throw new Error("Presigned offers require only the buyer's signature");
    setRequests(data.requests);
  }, [active, connected, ordinalsScript]);

  function buildPreview() {
    setError(""); setSuccess("");
    try {
      if (!token || !selected) throw new Error("Select a whole token output");
      if (!/^[1-9]\d*$/.test(price)) throw new Error("Enter a whole satoshi price");
      if (!/^[1-9]\d*$/.test(expiryBlocks) || BigInt(expiryBlocks) > 2016n) throw new Error("Expiry must be 1 to 2,016 blocks");
      const coin = coins.find((item) => `${item.txid}:${item.vout}` === selected);
      if (!coin) throw new Error("Selected token output is unavailable");
      setPreview(makeCrcSellerListing({ network, coreState: token.coreState, sellerScriptHex: ordinalsScript,
        publicKeyHex: ordinalsPublicKey || wallet.publicKey, tokenCoin: coin,
        bitcoinCoin: btcCoins.find((item) => `${item.txid}:${item.vout}` === selected) ?? null,
        priceSats: BigInt(price), currentHeight: height, expiryHeight: height + Number(expiryBlocks) }));
    } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "Could not preview listing"); }
  }

  async function submitListing() {
    if (!preview || !active) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const [current, tokens, bitcoins] = await Promise.all([
        api<{ indexedTip: { height: string }; token: Token }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`),
        api<{ utxos: TokenCoin[]; truncated: boolean }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
        api<{ utxos: BitcoinCoin[] }>(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(ordinalsAddress)}`),
      ]);
      const coin = tokens.utxos.find((item) => item.txid === preview.sellerAnchorTxid && item.vout === preview.sellerAnchorVout);
      if (!coin || tokens.truncated) throw new Error("Selected token output moved. Preview again.");
      const rechecked = makeCrcSellerListing({ network, coreState: current.token.coreState, sellerScriptHex: ordinalsScript,
        publicKeyHex: ordinalsPublicKey || wallet.publicKey, tokenCoin: coin,
        bitcoinCoin: bitcoins.utxos.find((item) => item.txid === coin.txid && item.vout === coin.vout) ?? null,
        priceSats: preview.priceSats, currentHeight: Number(current.indexedTip.height), expiryHeight: Number(preview.expiresAtHeight) });
      if (core.offerMessage(rechecked.terms) !== core.offerMessage(preview.terms)) throw new Error("Listing terms changed. Preview again.");
      const offer = await signCrcSellerListing(preview, { address: ordinalsAddress, publicKey: ordinalsPublicKey || wallet.publicKey }, signPsbt, signBip322);
      const result = await api<{ listingId: string }>("/api/crc/v1/market/listings", { offer: core.encodeProtocolDto(offer) });
      if (result.listingId !== core.offerId(offer)) throw new Error("Listing identity changed");
      setSuccess(`Listed token output ${result.listingId}`); setPreview(null); await refreshSeller();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not list token output"); }
    finally { setBusy(false); }
  }

  async function cancelListing(row: CrcMarketListing) {
    if (!active) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      await cancelCrcMarketListing(row, wallet, 1000);
      setSuccess("Listing canceled"); await refreshSeller();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel listing"); }
    finally { setBusy(false); }
  }

  async function reviewFill(_request: FillRequest) { setError("Presigned offers require only the buyer's signature"); }
  async function signFill() { setError("Presigned offers require only the buyer's signature"); }

  return <section className="space-y-4 border border-rule bg-ink-2 p-6">
    <div><h2 className="text-lg text-bone">Sell a token output</h2>
      <p className="mt-1 text-sm text-bone-dim">Each listing sells one whole confirmed token output. Sign once now; a buyer can complete the sale without another approval.</p></div>
    {!connected && active && <button type="button" className="btn" onClick={() => void connect()}>Connect wallet</button>}
    {connected && active && <>
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
    {!active && <p className="text-sm text-bone-dim">Marketplace trading is currently paused.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {success && <p role="status" className="break-all text-sm text-signal">{success}</p>}
  </section>;
}
