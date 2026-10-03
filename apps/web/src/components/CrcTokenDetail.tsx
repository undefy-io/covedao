"use client";
import { crcWalletData } from "@/lib/crc-wallet-data";

import Link from "next/link";
import { atomsPerToken, capAtoms, carrierSats, curveStepAtoms, decodeProtocolDto, type Plan } from "@crclaunch/crc20-protocol";
import { crcBuiltWalletDelta, signCrcBuildSession } from "@/lib/crc-browser-session";
import { useEffect, useState } from "react";
import { useCrcRead } from "../lib/use-crc-read";
import { crcIndexedRefresh } from "../lib/crc-indexed-refresh";
import { formatAtoms, formatVaultSats } from "./CrcHome";
import { Tile } from "./Tile";
import { TokenImage } from "./TokenImage";
import { CrcTokenActivity } from "./CrcTokenActivity";
import { CrcTokenMarket } from "./CrcTokenMarket";
import { useWallet } from "./WalletProvider";
import { fetchAllCrcWalletBalances, parseCrcTokenQuantity, sellPresetQuantity } from "@/lib/crc-client";
import { affordableFeeTier, FeePicker, type FeeRatesResponse, type FeeTier } from "./FeePicker";

type Token = {
  assetId: string;
  ticker: string;
  network: string;
  deployTxid: string;
  deployHeight: string;
  burnedAtoms: string | null;
  mintedAtoms: string;
  inventoryAtoms: string;
  circulatingAtoms: string;
  availability: "active" | "unavailable";
  vault: { txid: string; vout: number; btcSats: string };
  metadata: { displayName: string; description: string; websiteUrl: string | null; xUrl: string | null; imageUrl: string | null };
};

type TradeQuote = Record<string, string> & {
  amountAtoms: string; vaultOutpoint: string; grossSats: string; protocolFeeSats: string;
  creatorFeeSats: string; buyerTotalSats: string; sellerPayoutSats: string;
  walletTopUpSats: string; sellerNetSats: string;
};
type BuiltTrade = { sessionId: string; psbtBase64: string; intent: {
  [key: string]: unknown; assetId: string; amountAtoms: string; vaultOutpoint: string; feeTier: FeeTier["key"]; minerFeeSats: number;
} };

function CostLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex items-baseline justify-between gap-4"><dt className={strong ? "text-bone" : "text-bone-dim"}>{label}</dt><dd className={`tabular-nums text-right ${strong ? "text-base text-bone" : "text-bone-2"}`}>{value}</dd></div>;
}

export function CrcTokenDetail({ assetId }: { assetId: string }) {
  const { connected, network, address, publicKey, ordinalsAddress, ordinalsPublicKey,
    connect, getUtxos, signPsbt } = useWallet();
  const { data, error } = useCrcRead<{ token: Token; indexedTip: { height: string } }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}`, "Token not found");
  const token = data?.token ?? null;
  const indexedHeight = data?.indexedTip.height ?? "";
  const [quantity, setQuantity] = useState("1000");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [tradingActive, setTradingActive] = useState(false);
  const [rates, setRates] = useState<FeeRatesResponse | null>(null);
  const [feeError, setFeeError] = useState("");
  const [feeTier, setFeeTier] = useState<FeeTier["key"]>("standard");
  const [builtTrade, setBuiltTrade] = useState<BuiltTrade | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedTxid, setSubmittedTxid] = useState("");
  const [heldAtoms, setHeldAtoms] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState("");

  async function trade() {
    if (!quote || !tradingActive || !connected) return;
    setQuoteError("");
    setSubmitting(true);
    try {
      const amountAtoms = parseCrcTokenQuantity(quantity);
      if (quote.amountAtoms !== amountAtoms) throw new Error("Preview the latest amount before signing");
      if (!rates || !affordableFeeTier(rates, feeTier) || feeError) throw new Error("Mining speeds are unavailable. Retry shortly");
      if (builtTrade) {
        if (builtTrade.intent.feeTier !== feeTier || builtTrade.intent.amountAtoms !== amountAtoms ||
          builtTrade.intent.vaultOutpoint !== quote.vaultOutpoint) throw new Error("Trade changed. Review a new quote");
        const signedPsbtBase64 = await signCrcBuildSession(builtTrade, { operation: side, assetId, amountAtoms, minerFeeSats: builtTrade.intent.minerFeeSats },
          { network, address, publicKey, ordinalsAddress, ordinalsPublicKey }, signPsbt);
        const submitResponse = await fetch(`/api/crc/v1/backing/${side}/submit`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: builtTrade.sessionId, signedPsbtBase64 }),
        });
        const submitted = await submitResponse.json();
        if (!submitResponse.ok || !submitted.ok) throw new Error(submitted.error?.detail || submitted.error?.message || "Trade was not submitted");
        setSubmittedTxid(submitted.data.txid);
        setBuiltTrade(null);
        setQuote(null);
        return;
      }
      const candidates = (await getUtxos(true)).slice(0, 40);
      const { funding: paymentFunding, fundingEvidence } = await crcWalletData(network).funding(address, candidates, [address, ordinalsAddress || address]);
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
          walletPublicKey: publicKey, ordinalsPublicKey, paymentFunding, sellerFunding, fundingEvidence,
          feeTier, idempotencyKey: crypto.randomUUID(),
        }),
      });
      const built = await buildResponse.json();
      if (!buildResponse.ok || !built.ok) throw new Error(built.error?.detail || built.error?.message || "Could not build trade");
      if (built.data.intent?.amountAtoms !== amountAtoms || built.data.intent?.assetId !== assetId ||
        built.data.intent?.vaultOutpoint !== quote.vaultOutpoint || built.data.intent?.feeTier !== feeTier) {
        throw new Error("Trade state changed. Preview a new quote before signing");
      }
      setBuiltTrade(built.data as BuiltTrade);
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : "Could not submit trade");
    } finally {
      setSubmitting(false);
    }
  }

  async function preview() {
    setQuote(null);
    setBuiltTrade(null);
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
      setQuote(body.data.quote as TradeQuote);
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : "Could not quote trade");
    } finally {
      setQuoting(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/crc/v1/trading/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => { if (active) setTradingActive(body.ok === true && body.data?.tradingActive === true); })
      .catch(() => { if (active) setTradingActive(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/crc/v1/fees", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error?.message || "Mining speeds are unavailable");
        if (active) { setRates(body.data as FeeRatesResponse); setFeeError(""); }
      })
      .catch((cause) => { if (active) setFeeError(cause instanceof Error ? cause.message : "Mining speeds are unavailable"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setHeldAtoms(null);
    setBalanceError("");
    if (side !== "sell" || !connected || !(ordinalsAddress || address)) return;
    return crcIndexedRefresh.subscribe(async (signal) => {
      try {
        const balances = await fetchAllCrcWalletBalances(ordinalsAddress || address, (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }));
        if (!signal.aborted) {
          setHeldAtoms(BigInt(balances.find((balance) => balance.assetId === assetId)?.atoms ?? "0"));
          setBalanceError("");
        }
      } catch (cause) {
        if (!signal.aborted) setBalanceError(cause instanceof Error ? cause.message : "Could not read token balance");
        throw cause;
      }
    });
  }, [address, assetId, connected, ordinalsAddress, side]);

  if (error && !token) return <section className="panel px-6 py-16 text-center sm:px-10"><p role="alert" className="text-danger">{error}</p><Link href="/explore" className="btn-ghost mt-4 inline-block">Back to tokens</Link></section>;
  if (!token) return <section className="panel px-6 py-16 text-center text-sm text-bone-dim sm:px-10">Reading indexed token state…</section>;

  const minted = BigInt(token.mintedAtoms);
  const cap = capAtoms;
  const pct = Number(minted * 10_000n / cap) / 100;
  const graduated = minted >= cap;
  const estimatedMinerFee = rates
    ? BigInt(rates.tiers.find((tier) => tier.key === feeTier)?.satPerVb ?? "0") * BigInt(rates.typicalVsize[side === "buy" ? "BACKING_BUY" : "REDEEM"])
    : null;
  const reviewMinerFee = builtTrade ? BigInt(builtTrade.intent.minerFeeSats) : estimatedMinerFee;
  const reviewTotal = builtTrade ? (side === "buy" ? crcBuiltWalletDelta(builtTrade) : -crcBuiltWalletDelta(builtTrade)) : quote && reviewMinerFee !== null
    ? side === "buy" ? BigInt(quote.buyerTotalSats) + carrierSats + reviewMinerFee
      : BigInt(quote.sellerNetSats) - reviewMinerFee
    : null;

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <TokenImage tokenId={token.assetId} ticker={token.ticker} imageUrl={token.metadata?.imageUrl} size="lg" />
            <div>
              <p className="eyebrow">Cove CRC-20 token</p>
              <h1 className="mt-3 text-4xl text-bone">{token.metadata?.displayName ?? token.ticker}</h1>
              {token.metadata?.displayName && token.metadata.displayName !== token.ticker && <p className="mt-1 text-sm text-signal">${token.ticker}</p>}
              <p className="mt-1 text-sm text-bone-dim">Confirmed at block {token.deployHeight}</p>
            </div>
          </div>
          <span className={graduated ? "chip chip-signal" : token.availability === "active" ? "chip chip-verified" : "chip chip-pending"}>
            {graduated ? "Minted out" : token.availability === "active" ? "Open" : "Unavailable"}
          </span>
        </div>
        {token.metadata?.description && <p className="mt-5 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-bone-dim">{token.metadata.description}</p>}
        {(token.metadata?.websiteUrl || token.metadata?.xUrl) && <div className="mt-3 flex flex-wrap gap-4 text-sm text-signal">
          {token.metadata.websiteUrl && <a href={token.metadata.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">Website ↗</a>}
          {token.metadata.xUrl && <a href={token.metadata.xUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">X ↗</a>}
        </div>}
        <div className="mt-8">
          <div className="flex items-baseline justify-between text-label uppercase tracking-label text-bone-dim">
            <span>{pct.toFixed(1)}% minted</span><span>{formatAtoms(token.circulatingAtoms)} circulating</span>
          </div>
          <div className="mt-2 h-1.5 w-full bg-rule"><div className="h-1.5 bg-signal" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
          <div className="mt-2 flex items-baseline justify-between text-xs tabular-nums"><span className="text-bone">{formatAtoms(token.mintedAtoms)} <span className="text-bone-dim">({pct.toFixed(1)}%)</span></span><span className="text-bone-dim">21M cap</span></div>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile size="md" label="Vault BTC" value={formatVaultSats(token.vault.btcSats)} />
          <Tile size="md" label="Remaining" value={formatAtoms((cap - minted).toString())} />
          <Tile size="md" label="Vault inventory" value={formatAtoms(token.inventoryAtoms)} />
          <Tile size="md" label="Burned" value={formatAtoms(token.burnedAtoms ?? "0")} />
        </div>
      </section>
      <CrcTokenMarket assetId={assetId} ticker={token.ticker} />
      <CrcTokenActivity assetId={assetId} network={token.network} />
      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">Trade</p>
        <div className="mt-5 grid gap-px bg-rule lg:grid-cols-[1fr_1.1fr]">
        <div className="min-w-0 bg-ink-3 px-5 py-5">
        {!quote ? <>
          <div className="flex flex-wrap">
            <button type="button" onClick={() => { setSide("buy"); setQuoteError(""); }} className={side === "buy" ? "border border-signal bg-signal px-3 py-1.5 text-label uppercase tracking-label text-ink" : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone"}>Buy</button>
            <button type="button" onClick={() => { setSide("sell"); setQuoteError(""); }} className={side === "sell" ? "border border-signal bg-signal px-3 py-1.5 text-label uppercase tracking-label text-ink" : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone"}>Sell</button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-bone-dim">{side === "buy" ? "Buy tokens from the BTC-backed curve." : "Sell tokens back to the BTC-backed vault."}</p>
          <label className="mt-4 block text-sm text-bone-dim">Tokens to {side}
            <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setQuoteError(""); }} inputMode="numeric" className="field mt-2" />
          </label>
          {side === "sell" && <>
            <div className="mt-3 grid grid-cols-3 gap-px bg-rule">
              {([25, 50, 100] as const).map((percent) => {
                const preset = heldAtoms === null ? "0" : sellPresetQuantity(heldAtoms, percent);
                return <button key={percent} type="button" disabled={preset === "0"} onClick={() => { setQuantity(preset); setQuoteError(""); }}
                  className="bg-ink-2 py-2 text-xs text-bone-2 transition-colors hover:text-bone disabled:opacity-40">
                  {percent === 100 ? "All" : `${percent}%`}
                </button>;
              })}
            </div>
            {heldAtoms !== null && <p className="mt-3 text-xs text-bone-dim">You hold {formatAtoms(heldAtoms.toString())} {token.ticker}.</p>}
            {connected && heldAtoms === null && !balanceError && <p className="mt-3 text-xs text-bone-dim">Reading indexed token balance…</p>}
            {heldAtoms !== null && heldAtoms % curveStepAtoms !== 0n && <p className="mt-1 text-xs text-bone-dim">Sell amounts round down to {String(curveStepAtoms / atomsPerToken)}-token increments.</p>}
            {balanceError && <p role="alert" className="mt-3 text-xs text-danger">{balanceError}</p>}
          </>}
          {side === "sell" && !connected && <button type="button" onClick={() => void connect()} className="btn-ghost mt-3">Connect wallet to preview sell</button>}
          <button type="button" disabled={quoting || token.availability !== "active"} onClick={() => void preview()} className="btn mt-4 block disabled:opacity-50">{quoting ? "Calculating…" : `Review ${side}`}</button>
        </> : <div className="space-y-4">
          <div className="border border-signal/40 bg-signal/5 px-4 py-4">
            <p className="eyebrow">You {side === "buy" ? "buy" : "sell"}</p>
            <p className="mt-2 text-2xl tabular-nums text-bone">{quantity} <span className="text-base text-bone-dim">{token.ticker}</span></p>
          </div>
          <dl className="space-y-2 text-sm">
            <CostLine label="Curve price" value={`${BigInt(quote.grossSats).toLocaleString()} sats`} />
            <CostLine label="Protocol fee" value={`${side === "buy" ? "+" : "−"}${BigInt(quote.protocolFeeSats).toLocaleString()} sats`} />
            {side === "buy" ? <>
              <CostLine label="Creator fee" value={`+${BigInt(quote.creatorFeeSats).toLocaleString()} sats`} />
              <CostLine label="Token output" value={`+${carrierSats.toLocaleString()} sats`} />
            </> : <>
              <CostLine label="Wallet top-up" value={`${(builtTrade ? decodeProtocolDto<Plan>(builtTrade.intent.corePlan).walletTopUpSats ?? 0n : BigInt(quote.walletTopUpSats)).toLocaleString()} sats`} />
              <CostLine label="Curve payout" value={`${BigInt(quote.sellerPayoutSats).toLocaleString()} sats`} />
            </>}
            <CostLine label="Network fee" value={reviewMinerFee === null ? "Reading…" : `${builtTrade ? "" : "≈"}${reviewMinerFee.toLocaleString()} sats`} />
            <div className="border-t border-rule-bright pt-2">
              <CostLine label={side === "buy" || (reviewTotal !== null && reviewTotal < 0n) ? "You pay" : "You receive"} value={reviewTotal === null ? "Reading…" : `${builtTrade ? "" : "≈"}${(reviewTotal < 0n ? -reviewTotal : reviewTotal).toLocaleString()} sats`} strong />
            </div>
          </dl>
          <FeePicker rates={rates} selected={feeTier} onSelect={(tier) => { setFeeTier(tier); setBuiltTrade(null); }} vsizeHint={rates?.typicalVsize[side === "buy" ? "BACKING_BUY" : "REDEEM"]} />
          {feeError && <p role="alert" className="text-sm text-danger">{feeError}</p>}
          {builtTrade && <p className="text-xs text-bone-dim">Exact network fee: {builtTrade.intent.minerFeeSats.toLocaleString()} sats. Review it before signing.</p>}
          <div className="grid grid-cols-2 gap-px bg-rule">
            <button type="button" disabled={submitting} onClick={() => { setQuote(null); setBuiltTrade(null); setQuoteError(""); }} className="btn-ghost w-full border-0">Back</button>
            {!connected ? <button type="button" onClick={() => void connect()} className="btn w-full">Connect wallet</button>
              : <button type="button" disabled={submitting || !tradingActive || !rates || !!feeError || !affordableFeeTier(rates, feeTier)} onClick={() => void trade()} className="btn w-full disabled:opacity-50">{submitting ? "Working…" : builtTrade ? `Sign ${side}` : "Build trade"}</button>}
          </div>
        </div>}
        {quoteError && <p role="alert" className="mt-3 text-sm text-danger">{quoteError}</p>}
        {submittedTxid && <p className="mt-4 break-all text-sm text-signal">Submitted: {submittedTxid}</p>}
        {token.availability === "unavailable" && <p className="mt-2 text-sm text-danger">This asset’s vault is unavailable.</p>}
        </div>
        <div className="min-w-0 bg-ink-3 px-5 py-5">
        <p className="eyebrow">On-chain facts</p>
        <dl className="mt-4 space-y-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-bone-dim">Deploy transaction</dt><dd className="hex max-w-[60%] truncate text-bone">{token.deployTxid}</dd></div><div className="flex justify-between gap-3"><dt className="text-bone-dim">Deploy height</dt><dd className="tabular-nums text-bone">{Number(token.deployHeight).toLocaleString()}</dd></div><div className="flex justify-between gap-3"><dt className="text-bone-dim">Vault outpoint</dt><dd className="hex max-w-[60%] truncate text-bone">{token.vault.txid}:{token.vault.vout}</dd></div><div className="flex justify-between gap-3"><dt className="text-bone-dim">Indexed through</dt><dd className="tabular-nums text-bone">{indexedHeight}</dd></div><div className="flex justify-between gap-3"><dt className="text-bone-dim">Token ID</dt><dd className="hex max-w-[60%] truncate text-bone">{token.assetId}</dd></div></dl>
        </div>
        </div>
      </section>
    </div>
  );
}
