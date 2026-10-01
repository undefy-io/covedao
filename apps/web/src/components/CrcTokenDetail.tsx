"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatAtoms, formatVaultSats } from "./CrcHome";
import { Tile } from "./Tile";
import { TokenImage } from "./TokenImage";
import { CrcTokenActivity } from "./CrcTokenActivity";
import { CrcTokenMarket } from "./CrcTokenMarket";
import { useWallet } from "./WalletProvider";
import { parseCrcTokenQuantity } from "@/lib/crc-client";

type Token = {
  assetId: string;
  ticker: string;
  network: string;
  deployTxid: string;
  deployHeight: string;
  protocolVersion: 3;
  burnedAtoms: string | null;
  mintedAtoms: string;
  inventoryAtoms: string;
  circulatingAtoms: string;
  availability: "active" | "unavailable";
  vault: { txid: string; vout: number; btcSats: string };
};

export function CrcTokenDetail({ assetId }: { assetId: string }) {
  const { connected, address, publicKey, ordinalsAddress, ordinalsPublicKey,
    connect, getUtxos, signPsbt } = useWallet();
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
      let sellerFunding: { txid: string; vout: number }[] | undefined;
      if (side === "sell") {
        const response = await fetch(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(ordinalsAddress || address)}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error?.message || "Could not read indexed token outputs");
        if (body.data.truncated) throw new Error("This wallet has more than 100 token outputs. Consolidate before selling.");
        const selected: { txid: string; vout: number }[] = [];
        let selectedAtoms = 0n;
        for (const coin of body.data.utxos as { txid: string; vout: number; atoms: string }[]) {
          if (selectedAtoms >= BigInt(amountAtoms)) break;
          selected.push({ txid: coin.txid, vout: coin.vout });
          selectedAtoms += BigInt(coin.atoms);
        }
        if (selectedAtoms < BigInt(amountAtoms)) throw new Error("Not enough indexed token outputs are available for this sale");
        if (selected.length > 32) throw new Error("This sale needs more than 32 token outputs. Consolidate first.");
        sellerFunding = selected;
      }
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
        body: JSON.stringify({ assetId, amountAtoms, ...(side === "sell" ? { sellerAddress: ordinalsAddress || address, payoutAddress: ordinalsAddress || address } : {}) }),
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

  if (error) return <section className="panel px-6 py-16 text-center sm:px-10"><p role="alert" className="text-danger">{error}</p><Link href="/crc/explore" className="btn-ghost mt-4 inline-block">Back to tokens</Link></section>;
  if (!token) return <section className="panel px-6 py-16 text-center text-sm text-bone-dim sm:px-10">Reading indexed token state…</section>;

  const minted = BigInt(token.mintedAtoms);
  const pct = Number(minted * 100n / 2_100_000_000_000_000n);

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-8 sm:px-10">
        <Link href="/crc/explore" className="text-label uppercase tracking-label text-signal hover:text-bone">← All tokens</Link>
        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <TokenImage tokenId={token.assetId} ticker={token.ticker} size="lg" />
            <div>
              <p className="eyebrow">Cove CRC-20 · {token.network}</p>
              <h1 className="mt-3 text-4xl text-bone">{token.ticker}</h1>
              <p className="mt-2 text-xs text-bone-dim">Confirmed at block {token.deployHeight} · indexed through {indexedHeight}</p>
            </div>
          </div>
          <span className={token.availability === "active" ? "chip chip-verified" : "chip chip-pending"}>
            {token.availability === "active" ? "Open" : "Unavailable"}
          </span>
        </div>
        <p className="hex mt-6">{token.assetId}</p>
        <div className="mt-8">
          <div className="flex justify-between text-label uppercase tracking-label text-bone-dim">
            <span>Lifetime minted</span><span>{pct}% of 21M</span>
          </div>
          <div className="mt-2 h-1.5 w-full bg-rule"><div className="h-1.5 bg-signal" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile size="md" label="Vault BTC" value={formatVaultSats(token.vault.btcSats)} />
          <Tile size="md" label="Circulating" value={formatAtoms(token.circulatingAtoms)} />
          <Tile size="md" label="Vault inventory" value={formatAtoms(token.inventoryAtoms)} />
          <Tile size="md" label="Burned" value={formatAtoms(token.burnedAtoms ?? "0")} />
        </div>
      </section>
      <CrcTokenMarket assetId={assetId} />
      <CrcTokenActivity assetId={assetId} network={token.network} />
      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">Trade on the curve</p>
        <h2 className="mt-3 text-2xl text-bone">Buy and sell</h2>
        <p className="mt-2 text-sm text-bone-dim">Preview exact amounts from the indexed vault before signing.</p>
        <div className="mt-6 grid gap-px bg-rule lg:grid-cols-[1fr_1.1fr]">
        <div className="bg-ink-3 px-5 py-5">
        <div className="flex gap-2">
          <button type="button" onClick={() => { setSide("buy"); setQuote(null); }} className={side === "buy" ? "btn" : "btn-ghost"}>Buy</button>
          <button type="button" onClick={() => { setSide("sell"); setQuote(null); }} className={side === "sell" ? "btn" : "btn-ghost"}>Sell</button>
        </div>
        <label className="mt-4 block text-sm text-bone-dim">
          Tokens ({side})
          <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setQuote(null); }} inputMode="numeric" className="field mt-2" />
        </label>
        {side === "sell" && !connected && <button type="button" onClick={() => void connect()} className="btn-ghost mt-3">Connect wallet to preview sell</button>}
        <button type="button" disabled={quoting || token.availability !== "active"} onClick={() => void preview()} className="btn mt-4 block disabled:opacity-50">{quoting ? "Calculating…" : "Preview quote"}</button>
        {quoteError && <p role="alert" className="mt-3 text-sm text-danger">{quoteError}</p>}
        </div>
        <div className="bg-ink-3 px-5 py-5">
        <p className="eyebrow">Transaction preview</p>
        {quote ? <div className="mt-4 space-y-2 text-sm text-bone-dim">
          <p>Backing: {quote.grossSats} sats</p>
          <p>Protocol fee: {quote.protocolFeeSats} sats</p>
          {side === "buy" ? <><p>Creator fee: {quote.creatorFeeSats} sats</p><p className="text-bone">Total before miner fee: {quote.buyerTotalSats} sats</p></> : <><p>Curve payout: {quote.sellerPayoutSats} sats</p><p>Wallet top-up: {quote.walletTopUpSats} sats</p><p className="text-bone">Net before miner fee: {quote.sellerNetSats} sats</p></>}
          {side === "sell" && <><p className="break-all">BTC payout address: {ordinalsAddress || address}</p><p>Your token output’s BTC is returned in the payout in addition to the curve amount.</p></>}
          <p className="text-xs">Miner fee is separate. The vault may change before signing.</p>
        </div> : <p className="mt-4 text-sm text-bone-dim">Choose an amount to see the curve price and fees.</p>}
        {quote && tradingActive && <div className="mt-4">
          <label className="block text-sm text-bone-dim">Miner fee (sats)
            <input value={minerFeeSats} onChange={(event) => setMinerFeeSats(event.target.value)} inputMode="numeric"
              className="field mt-2" />
          </label>
          {connected ? <button type="button" disabled={submitting} onClick={() => void trade()}
            className="btn mt-4 disabled:opacity-50">{submitting ? "Signing and submitting…" : `Sign ${side}`}</button>
            : <button type="button" onClick={() => void connect()} className="btn mt-4">Connect wallet to {side}</button>}
        </div>}
        {submittedTxid && <p className="mt-4 break-all text-sm text-signal">Submitted: {submittedTxid}</p>}
        {token.availability === "unavailable" && <p className="mt-2 text-sm text-danger">This asset’s vault is unavailable.</p>}
        </div>
        </div>
      </section>
    </div>
  );
}
