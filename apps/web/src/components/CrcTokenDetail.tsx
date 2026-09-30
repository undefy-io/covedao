"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatAtoms } from "./CrcHome";
import { useWallet } from "./WalletProvider";
import { parseCrcTokenQuantity } from "@/lib/crc-client";

type Token = {
  assetId: string;
  ticker: string;
  network: string;
  deployTxid: string;
  deployHeight: string;
  mintedAtoms: string;
  inventoryAtoms: string;
  circulatingAtoms: string;
  availability: "active" | "unavailable";
  vault: { txid: string; vout: number; btcSats: string };
};

export function CrcTokenDetail({ assetId }: { assetId: string }) {
  const { connected, address, publicKey, ordinalsAddress, ordinalsPublicKey,
    connect, getUtxos, getUtxosForAddress, signPsbt } = useWallet();
  const [token, setToken] = useState<Token | null>(null);
  const [indexedHeight, setIndexedHeight] = useState("");
  const [error, setError] = useState("");
  const [quantity, setQuantity] = useState("1000");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<Record<string, string> | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [tradingActive, setTradingActive] = useState(false);
  const [minerFeeSats, setMinerFeeSats] = useState("1000");
  const [submitting, setSubmitting] = useState(false);
  const [submittedTxid, setSubmittedTxid] = useState("");

  async function trade() {
    if (!quote || !tradingActive || !connected) return;
    setQuoteError("");
    setSubmitting(true);
    try {
      const amountAtoms = parseCrcTokenQuantity(quantity);
      if (quote.amountAtoms !== amountAtoms) throw new Error("Preview the latest amount before signing");
      if (!/^[1-9]\d{0,4}$/.test(minerFeeSats) || Number(minerFeeSats) > 20_000) {
        throw new Error("Miner fee must be 1 to 20,000 sats");
      }
      const paymentFunding = (await getUtxos(true)).slice(0, 40);
      const sellerFunding = side === "sell"
        ? (await getUtxosForAddress(ordinalsAddress || address, true))[0]
        : undefined;
      if (side === "sell" && !sellerFunding) throw new Error("No confirmed token carrier found in your ordinals wallet");
      const buildResponse = await fetch(`/api/crc/v1/backing/${side}/build`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetId, amountAtoms, walletAddress: address, ordinalsAddress: ordinalsAddress || address,
          walletPublicKey: publicKey, ordinalsPublicKey, paymentFunding, sellerFunding,
          minerFeeSats, idempotencyKey: crypto.randomUUID(),
        }),
      });
      const built = await buildResponse.json();
      if (!buildResponse.ok || !built.ok) throw new Error(built.error?.detail || built.error?.message || "Could not build trade");
      if (built.data.intent?.amountAtoms !== amountAtoms || built.data.intent?.assetId !== assetId ||
        built.data.intent?.vaultOutpoint !== quote.vaultOutpoint) {
        throw new Error("Trade state changed. Preview a new quote before signing");
      }
      const signedPsbtBase64 = await signPsbt(built.data.psbtBase64, side === "buy" ? "CRC_BUY" : "CRC_SELL");
      const submitResponse = await fetch(`/api/crc/v1/backing/${side}/submit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: built.data.sessionId, signedPsbtBase64 }),
      });
      const submitted = await submitResponse.json();
      if (!submitResponse.ok || !submitted.ok) throw new Error(submitted.error?.detail || submitted.error?.message || "Trade was not submitted");
      setSubmittedTxid(submitted.data.txid);
      setQuote(null);
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : "Could not submit trade");
    } finally {
      setSubmitting(false);
    }
  }

  async function preview() {
    setQuote(null);
    setQuoteError("");
    setQuoting(true);
    try {
      if (side === "sell" && !connected) throw new Error("Connect a wallet to preview a sale");
      const amountAtoms = parseCrcTokenQuantity(quantity);
      const response = await fetch(`/api/crc/v1/backing/${side}/quote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId, amountAtoms, ...(side === "sell" ? { sellerAddress: ordinalsAddress || address, payoutAddress: address } : {}) }),
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error?.message ?? "Could not quote trade");
      setQuote(body.data.quote as Record<string, string>);
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : "Could not quote trade");
    } finally {
      setQuoting(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetch(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (!active) return;
        if (!body.ok) throw new Error(body.error?.message ?? "Token not found");
        setToken(body.data.token as Token);
        setIndexedHeight(body.data.indexedTip.height);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Token not found"); });
    return () => { active = false; };
  }, [assetId]);

  useEffect(() => {
    let active = true;
    void fetch("/api/crc/v1/trading/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => { if (active) setTradingActive(body.ok === true && body.data?.tradingActive === true); })
      .catch(() => { if (active) setTradingActive(false); });
    return () => { active = false; };
  }, []);

  if (error) return <div className="py-8"><p role="alert" className="text-danger">{error}</p><Link href="/" className="btn-ghost mt-4 inline-block">Back to tokens</Link></div>;
  if (!token) return <p className="py-8 text-sm text-bone-dim">Reading indexed token state…</p>;

  return (
    <div className="space-y-6 py-8">
      <Link href="/" className="text-sm text-signal hover:underline">← All tokens</Link>
      <section className="border border-rule bg-ink-2 p-6">
        <p className="eyebrow">Cove CRC-20 · {token.network}</p>
        <h1 className="mt-3 text-3xl text-bone">${token.ticker}</h1>
        <p className="mt-2 break-all font-mono text-xs text-bone-dim">{token.assetId}</p>
        <p className="mt-3 text-xs text-bone-dim">Confirmed at block {token.deployHeight} · indexed through {indexedHeight}</p>
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <Metric name="Circulating" value={`${formatAtoms(token.circulatingAtoms)} tokens`} />
        <Metric name="Vault inventory" value={`${formatAtoms(token.inventoryAtoms)} tokens`} />
        <Metric name="Lifetime minted" value={`${formatAtoms(token.mintedAtoms)} tokens`} />
        <Metric name="Vault BTC" value={`${token.vault.btcSats} sats`} />
      </section>
      <section className="border border-rule bg-ink-2 p-6">
        <h2 className="text-lg text-bone">Buy and sell</h2>
        <p className="mt-2 text-sm text-bone-dim">Preview exact curve amounts from the indexed vault before signing.</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={() => { setSide("buy"); setQuote(null); }} className={side === "buy" ? "btn" : "btn-ghost"}>Buy</button>
          <button type="button" onClick={() => { setSide("sell"); setQuote(null); }} className={side === "sell" ? "btn" : "btn-ghost"}>Sell</button>
        </div>
        <label className="mt-4 block text-sm text-bone-dim">
          Tokens ({side})
          <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setQuote(null); }} inputMode="numeric" className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone outline-none focus:border-signal" />
        </label>
        {side === "sell" && !connected && <button type="button" onClick={() => void connect()} className="btn-ghost mt-3">Connect wallet to preview sell</button>}
        <button type="button" disabled={quoting || token.availability !== "active"} onClick={() => void preview()} className="btn mt-4 block disabled:opacity-50">{quoting ? "Calculating…" : "Preview quote"}</button>
        {quoteError && <p role="alert" className="mt-3 text-sm text-danger">{quoteError}</p>}
        {quote && <div className="mt-4 space-y-1 border-t border-rule pt-4 text-sm text-bone-dim">
          <p>Backing: {quote.grossSats} sats</p>
          <p>Protocol fee: {quote.protocolFeeSats} sats</p>
          {side === "buy" ? <><p>Creator fee: {quote.creatorFeeSats} sats</p><p className="text-bone">Total before miner fee: {quote.buyerTotalSats} sats</p></> : <><p>Seller payout: {quote.sellerPayoutSats} sats</p><p>Wallet top-up: {quote.walletTopUpSats} sats</p><p className="text-bone">Net before miner fee: {quote.sellerNetSats} sats</p></>}
          <p className="text-xs">Miner fee is separate. The vault may change before signing.</p>
        </div>}
        {quote && tradingActive && <div className="mt-4">
          <label className="block text-sm text-bone-dim">Miner fee (sats)
            <input value={minerFeeSats} onChange={(event) => setMinerFeeSats(event.target.value)} inputMode="numeric"
              className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone outline-none focus:border-signal" />
          </label>
          {connected ? <button type="button" disabled={submitting} onClick={() => void trade()}
            className="btn mt-4 disabled:opacity-50">{submitting ? "Signing and submitting…" : `Sign ${side}`}</button>
            : <button type="button" onClick={() => void connect()} className="btn mt-4">Connect wallet to {side}</button>}
        </div>}
        {submittedTxid && <p className="mt-4 break-all text-sm text-signal">Submitted: {submittedTxid}</p>}
        {token.availability === "unavailable" && <p className="mt-2 text-sm text-danger">This asset’s vault is unavailable.</p>}
      </section>
    </div>
  );
}

function Metric({ name, value }: { name: string; value: string }) {
  return <div className="border border-rule bg-ink-2 p-5"><p className="text-xs text-bone-dim">{name}</p><p className="mt-2 text-lg text-bone">{value}</p></div>;
}
