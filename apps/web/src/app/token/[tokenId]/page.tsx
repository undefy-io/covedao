"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { EXPLORER_URL } from "@/lib/network";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { verifyClientIntent } from "@crclaunch/wallets";
import { fmtBtc, fmtTokens, fmtInt, displayTokensToAtoms } from "@/lib/format";
import { DEMO_TOKEN_DETAIL, DEMO_LISTINGS } from "@/lib/demo-tokens";
import { TokenMarketPanel } from "@/components/TokenMarketPanel";
import { FeePicker, useFeeRates, type FeeRatesResponse, type FeeTier } from "@/components/FeePicker";
import { TxStatus } from "@/components/TxStatus";
import { TokenActivity } from "@/components/TokenActivity";
import { TokenImage } from "@/components/TokenImage";
import { Tile } from "@/components/Tile";
import { unitPriceSats } from "@/lib/ohlc";
import { useIndexedBlock } from "@/lib/use-indexed-block";
import { createListing, buyListing, errorText } from "@/lib/trade";

/**
 * What a token page lets you do depends on where the token is.
 *
 * While the curve still has tokens, the only sensible trades are with the
 * curve itself: MINT new tokens, or REDEEM them back into the vault. Nobody
 * should pay another holder more than the curve price, so the market is not
 * offered yet. Once every token is minted, trading moves to other holders
 * (BUY and SELL), and REDEEM stays as the floor.
 */
type Tab = "mint" | "redeem" | "buy" | "sell";
const TABS_OPEN: Tab[] = ["mint", "redeem"];
const TABS_GRADUATED: Tab[] = ["buy", "sell", "redeem"];
const TAB_LABEL: Record<Tab, string> = { mint: "Mint", redeem: "Redeem", buy: "Buy", sell: "Sell" };
// The flat mint fee alone is 5,000 sats, so the smallest button must clear it.
/**
 * Quick mint buttons. The first is always the smallest mint that works right
 * now (it moves with the curve and the fees), then larger round amounts.
 */
function quickSats(minSpend: bigint | null): bigint[] {
  if (minSpend === null) return [10_000n, 25_000n, 100_000n];
  const rest = [25_000n, 100_000n].filter((q) => q > minSpend);
  while (rest.length < 2) rest.push((rest.at(-1) ?? minSpend) * 4n);
  return [minSpend, ...rest];
}

interface Ask {
  listingId: string;
  amountAtoms: string;
  totalPriceSats: string;
  status: string;
}

interface Detail {
  tokenId: string;
  ticker: string;
  displayName: string;
  description: string;
  deployTxid: string;
  deployHeight: string;
  policyVersion: number;
  issuedSupplyAtoms: string;
  publicCapAtoms: string;
  remainingCapacityAtoms: string;
  backingSats: string;
  backingOutpoint: { txid: string; vout: number };
  stateHash: string;
  curveStage: number;
  holderCount: number;
  bestAskSats: string | null;
  activeListingCount: number;
  imageUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
}

function TokenContent() {
  const params = useParams<{ tokenId: string }>();
  const search = useSearchParams();
  // Client-side render path for design review. Never calls the API, never writes.
  const demo = search.get("demo") === "1";
  const tokenId = params.tokenId;
  const { connected, address, ordinalsAddress, script, publicKey, ordinalsScript, walletFields, network, connect, signPsbt, signBip322, getUtxos } = useWallet();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("mint");
  const [amount, setAmount] = useState("");
  // Mint is asked in sats — what people think in — and answered in tokens.
  const [budget, setBudget] = useState("");
  const [quoteState, setMintQuote] = useState<{
    /** The budget this quote answers; a quote for any other budget is stale. */
    forBudget: string;
    amountAtoms: string;
    totalSats: string;
    limitedBy: "budget" | "per-mint limit" | "supply";
    minGrossSats: string;
    maxGrossSats: string | null;
    minSpendSats: string | null;
  } | null>(null);
  const [heldAtoms, setHeldAtoms] = useState<bigint | null>(null);
  const [balanceSats, setBalanceSats] = useState<bigint | null>(null);
  const [openAsks, setOpenAsks] = useState<Ask[]>([]);
  const [price, setPrice] = useState("");
  // How long the ask stays fillable. An ask that outlives its price is a gift
  // to whoever notices it after the market has moved.
  const [listingBlocks, setListingBlocks] = useState("1008");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [txid, setTxid] = useState("");
  const { rates, selected: feeTier, setSelected: setFeeTier, satPerVb, previewFeeSats } = useFeeRates();
  // What the user is about to commit to, held between "Review" and "Confirm".
  // Nothing is built, signed or broadcast until they have seen these numbers.
  const [review, setReview] = useState<Review | null>(null);
  // Refetch everything below whenever a new block is indexed: that is the only
  // time any of it changes (a mint shows up once its block is confirmed).
  const block = useIndexedBlock();

  useEffect(() => {
    if (demo) {
      setDetail(DEMO_TOKEN_DETAIL as unknown as Detail);
      setLoaded(true);
      return;
    }
    // A token exists only once its DEPLOY is in a block, so right after a launch
    // this 404s for a while. Keep asking until the indexer has it.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void fetch(`/api/v3/tokens/${tokenId}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.ok) setDetail(j.data);
          else timer = setTimeout(load, 5_000);
          setLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          timer = setTimeout(load, 5_000);
          setLoaded(true);
        });
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tokenId, block]);

  const graduatedNow = detail ? BigInt(detail.issuedSupplyAtoms) >= BigInt(detail.publicCapAtoms) : false;
  const tabs = graduatedNow ? TABS_GRADUATED : TABS_OPEN;
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0]!);
  }, [graduatedNow, tab, tabs]);

  // The smallest mint right now, for the first quick button (budget 0 quotes
  // nothing but still reports minSpendSats). Refreshed each block.
  const [minSpend, setMinSpend] = useState<bigint | null>(null);
  useEffect(() => {
    if (demo) return;
    void fetch("/api/v3/backing/buy/quote-sats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenId, budgetSats: "0" }),
    })
      .then((r) => r.json())
      .then((j) => setMinSpend(j.ok && j.data.minSpendSats ? BigInt(j.data.minSpendSats) : null))
      .catch(() => setMinSpend(null));
  }, [tokenId, demo, block]);

  // Live answer to "what does this many sats mint?"
  useEffect(() => {
    if (demo || !budget || !/^\d+$/.test(budget)) {
      setMintQuote(null);
      return;
    }
    const t = setTimeout(() => {
      void fetch("/api/v3/backing/buy/quote-sats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId, budgetSats: budget }),
      })
        .then((r) => r.json())
        .then((j) => setMintQuote(j.ok ? { ...j.data, forBudget: budget } : null))
        .catch(() => setMintQuote(null));
    }, 250);
    return () => clearTimeout(t);
  }, [budget, tokenId, demo]);

  // What the connected wallet holds of this token, and what it can spend.
  const refreshWallet = useCallback(async () => {
    if (demo || !connected) return;
    try {
      const pf = await fetch(`/api/v3/wallet/${ordinalsAddress || address}/portfolio`).then((r) => r.json());
      const mine = (pf.data?.tokenUtxos ?? []) as { tokenId: string; amountAtoms: string }[];
      setHeldAtoms(mine.filter((u) => u.tokenId === tokenId).reduce((a, u) => a + BigInt(u.amountAtoms), 0n));
      const ux = await fetch(`/api/v3/wallet/utxos?address=${encodeURIComponent(address)}`).then((r) => r.json());
      const coins = (ux.data?.utxos ?? []) as { valueSats?: string }[];
      setBalanceSats(coins.reduce((a, c) => a + BigInt(c.valueSats ?? "0"), 0n));
    } catch {
      // Balances are a convenience; trading works without them.
    }
  }, [demo, connected, ordinalsAddress, address, tokenId]);
  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet, block]);

  // Open asks for this token — only shown once it has graduated.
  useEffect(() => {
    if (demo || !graduatedNow) return;
    void fetch(`/api/v3/market/listings?tokenId=${tokenId}`)
      .then((r) => r.json())
      .then((j) => {
        const open = ((j.data ?? []) as Ask[]).filter((l) => l.status === "ACTIVE");
        open.sort((a, b) => unitPriceSats(a.amountAtoms, a.totalPriceSats) - unitPriceSats(b.amountAtoms, b.totalPriceSats));
        setOpenAsks(open);
      })
      .catch(() => setOpenAsks([]));
  }, [demo, graduatedNow, tokenId, txid, block]);

  /** Spend-everything for Mint: the wallet's BTC less a network fee and a margin. */
  function maxBudget(): bigint | null {
    if (balanceSats === null) return null;
    const fee = previewFeeSats("BACKING_BUY") ?? 1_000n;
    const b = balanceSats - fee * 2n - 500n;
    return b > 0n ? b : 0n;
  }

  async function buyAsk(ask: Ask) {
    if (!connected) return;
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const { txid } = await buyListing(ask, { script, publicKey, ordinalsScript, signPsbt, signBip322, getUtxos }, satPerVb);
      setMsg(`Bought — arrives when the next block confirms it (${txid.slice(0, 16)}…).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Step one of a trade: price it, and show the user what it costs.
   *
   * Nothing is built, nothing is signed and nothing is broadcast here. The
   * whole point is that the amounts below are on screen BEFORE a wallet popup
   * appears, because a wallet popup is a poor place to discover a price.
   */
  async function reviewTrade(kind: "buy" | "sell", atoms?: string) {
    if (!detail || !connected) return;
    setErr("");
    setMsg("");
    setTxid("");
    setBusy(true);
    try {
      const amountAtoms = atoms ?? displayTokensToAtoms(amount);
      if (BigInt(amountAtoms) <= 0n) throw new Error(kind === "buy" ? "That amount does not mint any tokens." : "Enter how many tokens to redeem.");
      if (BigInt(amountAtoms) % (1_000n * 100_000_000n) !== 0n) throw new Error("Tokens move in lots of 1,000 — use a multiple of 1,000.");
      const endpoint = kind === "buy" ? "buy" : "redeem";
      const qr = await fetch(`/api/v3/backing/${endpoint}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId, amountAtoms }),
      });
      const qj = await qr.json();
      if (!qj.ok) throw new Error(errorText(qj));
      setReview({ kind, amountAtoms, quote: qj.data });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Step two: build against the reviewed quote, verify it, sign it, send it. */
  async function confirmTrade() {
    if (!detail || !connected || !review) return;
    setErr("");
    setBusy(true);
    try {
      const funding = await getUtxos();
      const isBuy = review.kind === "buy";
      const br = await fetch(`/api/v3/backing/${isBuy ? "buy" : "redeem"}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tokenId,
          amountAtoms: review.amountAtoms,
          // The buy binds to the exact backing state that was quoted, so the
          // price cannot move between the review and the signature.
          ...(isBuy
            ? {
                quoteBinding: {
                  stateHash: review.quote.stateHash,
                  backingOutpoint: review.quote.backingOutpoint,
                  expiresAtHeight: review.quote.expiresAtHeight,
                },
              }
            : {}),
          ...walletFields(),
          funding,
          feeRateSatPerVb: satPerVb ?? undefined,
          idempotencyKey: `${review.kind}-${tokenId}-${Date.now()}`,
        }),
      });
      const bj = await br.json();
      if (!bj.ok) throw new Error(errorText(bj));
      // Independently re-check the PSBT against the intent before signing: the
      // price, the fees, the token amount and where the tokens land.
      verifyClientIntent(bj.data.psbtBase64, bj.data.intent);
      const signed = await signPsbt(bj.data.psbtBase64, isBuy ? "BACKING_BUY" : "REDEEM");
      const sr = await fetch(`/api/v3/backing/${isBuy ? "buy" : "redeem"}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: bj.data.sessionId, signedPsbtBase64: signed }),
      });
      const sj = await sr.json();
      if (!sj.ok) throw new Error(errorText(sj));
      setTxid(sj.data.txid);
      setMsg(
        isBuy
          ? "Minted. Your tokens arrive when the next block confirms it."
          : "Redeemed. Your BTC arrives when the next block confirms it.",
      );
      setReview(null);
      setAmount("");
      setBudget("");
      void refreshWallet();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function list() {
    if (!detail || !connected) return;
    setErr("");
    setBusy(true);
    try {
      const { listingId, pending } = await createListing({
        tokenId,
        amountAtoms: BigInt(displayTokensToAtoms(amount)),
        totalPriceSats: price,
        expiryBlocks: listingBlocks,
        network,
        tokenAddress: ordinalsAddress || address!,
        walletFields: walletFields(),
        getUtxos,
        signPsbt,
        satPerVb,
      });
      setMsg(
        `Listing created ${listingId.slice(0, 16)}…` +
          (pending ? " It goes live when the split confirms." : "") +
          " You do not need to sign anything when it sells.",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Only a quote for exactly the typed budget counts. Typing a new amount and
  // pressing Review Mint before the new quote lands used to mint the OLD one.
  const mintQuote = quoteState && quoteState.forBudget === budget ? quoteState : null;

  if (!loaded) return <DetailSkeleton />;
  if (!detail) {
    return (
      <section className="panel px-6 py-16 text-center sm:px-10">
        <span className="chip chip-pending">Pending</span>
        <div className="mt-4 text-bone">This token is still being created</div>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-bone-dim">
          A token appears once its launch transaction is confirmed in a Bitcoin block, which can
          take a few minutes. This page checks again every few seconds and opens the token as soon
          as it is ready. If you did not just launch it, check the link.
        </p>
        <Link href="/explore" className="btn-ghost mt-5">Back to explore</Link>
      </section>
    );
  }

  const issued = BigInt(detail.issuedSupplyAtoms);
  const cap = BigInt(detail.publicCapAtoms);
  const pct = cap > 0n ? Number((issued * 10_000n) / cap) / 100 : 0;
  const graduated = (detail as { graduated?: boolean }).graduated ?? issued >= cap;

  // Open asks for this token, quoted in the same unit as the chart.
  const asks = (demo ? DEMO_LISTINGS.filter((l) => l.tokenId === detail.tokenId) : []).map((l) => ({
    unitPriceSats: unitPriceSats(l.amountAtoms, l.totalPriceSats),
    amountTokens: Number(BigInt(l.amountAtoms) / 100_000_000n),
    status: l.status,
  }));

  return (
    <div className="space-y-px">
      {/* ── Identity ─────────────────────────────────────────────────── */}
      <section className="panel px-6 py-8 sm:px-10">
        {demo ? (
          <p className="mb-5 inline-block border border-pending/40 bg-pending/10 px-3 py-1.5 text-label uppercase tracking-label text-pending">
            Demo data · not from the chain
          </p>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <TokenImage
              tokenId={detail.tokenId}
              ticker={detail.ticker}
              imageUrl={detail.imageUrl}
              size="lg"
            />
            <div>
              <p className="eyebrow">Token</p>
              <h1 className="mt-3 text-4xl text-bone">{detail.ticker}</h1>
              <p className="mt-1 text-sm text-bone-dim">{detail.displayName}</p>
              {detail.websiteUrl || detail.xUrl ? (
                <div className="mt-3 flex flex-wrap gap-4">
                  {detail.websiteUrl ? (
                    <a
                      href={detail.websiteUrl}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-label uppercase tracking-label text-bone-dim hover:text-signal"
                    >
                      Website →
                    </a>
                  ) : null}
                  {detail.xUrl ? (
                    <a
                      href={detail.xUrl}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-label uppercase tracking-label text-bone-dim hover:text-signal"
                    >
                      X →
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <span className={graduated ? "chip chip-signal" : "chip chip-verified"}>
            {graduated ? "Graduated" : "Open"}
          </span>
        </div>
        {detail.description ? (
          <p className="mt-5 max-w-xl text-sm leading-relaxed text-bone-dim">{detail.description}</p>
        ) : null}

        {graduated ? (
          <div className="mt-6 border border-signal/40 bg-signal/10 px-5 py-4">
            <p className="text-label uppercase tracking-label text-signal">Graduated</p>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-bone-dim">
              All 1B tokens are minted, so trading is now between holders: Buy and Sell below.
              Redeem stays open as the floor &mdash; the vault still pays the curve price for any
              token handed back, and redeeming reopens minting until the curve is full again.
            </p>
          </div>
        ) : null}

        {/* The curve is the single most important thing on this page. */}
        <div className="mt-8">
          <div className="flex items-baseline justify-between text-label uppercase tracking-label text-bone-dim">
            <span>{pct.toFixed(1)}% minted</span>
            <span>
              Stair {detail.curveStage} of 210
              {!graduated ? ` · next stair at ${fmtTokens(BigInt(detail.curveStage) * 100_000n * 100_000_000n)}` : ""}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full bg-rule">
            <div className="h-1.5 bg-signal" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="mt-2 flex items-baseline justify-between text-xs tabular-nums">
            <span className="text-bone">{fmtTokens(issued)} <span className="text-bone-dim">({pct.toFixed(1)}%)</span></span>
            <span className="text-bone-dim">{fmtTokens(cap)} cap</span>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile
            size="md"
            value={fmtBtc(BigInt(detail.backingSats))}
            label="BTC backing"
            help={`Real Bitcoin held in a vault for ${detail.ticker} — you can always sell back into it, no buyer needed.`}
          />
          <Tile
            size="md"
            value={fmtTokens(BigInt(detail.remainingCapacityAtoms))}
            label="Remaining"
            help="Tokens nobody has bought yet. The price steps up as they go."
          />
          <Tile
            size="md"
            value={fmtInt(detail.holderCount)}
            label="Holders"
            help={`Wallets holding at least one ${detail.ticker}, counted from confirmed blocks.`}
          />
          <Tile
            size="md"
            value={detail.bestAskSats ? fmtBtc(BigInt(detail.bestAskSats)) : "—"}
            label={detail.activeListingCount ? `Best ask · ${detail.activeListingCount} listed` : "Best ask"}
            help="The cheapest price another holder is asking — person to person, not the vault."
          />
        </div>
      </section>

      {/* ── Market ───────────────────────────────────────────────────── */}
      <TokenMarketPanel
        tokenId={detail.tokenId}
        ticker={detail.ticker}
        curveStage={detail.curveStage}
        demo={demo}
        asks={asks}
        explorerBase={EXPLORER_URL}
        refreshKey={block}
      />

      {/* ── History ──────────────────────────────────────────────────── */}
      <TokenActivity
        tokenId={detail.tokenId}
        ticker={detail.ticker}
        explorerBase={EXPLORER_URL}
        demoRows={demo ? [] : undefined}
        refreshKey={block}
      />

      {/* ── Actions ──────────────────────────────────────────────────── */}
      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">Trade</p>
        <div className="mt-5 grid gap-px bg-rule lg:grid-cols-[1fr_1.1fr]">
          <div className="bg-ink-3 px-5 py-5">
            <div className="flex flex-wrap">
              {tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setTab(t);
                    setReview(null);
                    setErr("");
                  }}
                  className={
                    tab === t
                      ? "border border-signal bg-signal px-3 py-1.5 text-label uppercase tracking-label text-ink"
                      : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone"
                  }
                >
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>

            <p className="mt-4 text-xs leading-relaxed text-bone-dim">
              {tab === "mint"
                ? `Pay BTC, get new ${detail.ticker}. The BTC goes into the token's vault; the price rises as more is minted.`
                : tab === "redeem"
                  ? `Give ${detail.ticker} back to the vault and get BTC out at the curve price. Always available — no buyer needed.`
                  : tab === "buy"
                    ? `All ${detail.ticker} is minted. Buy from holders who have listed theirs.`
                    : `List your ${detail.ticker} at your own price. It sells when someone buys it; cancel any time.`}
            </p>

            {!connected ? (
              <button onClick={() => void connect()} className="btn mt-5 w-full">
                Connect wallet
              </button>
            ) : review ? (
              <TradeReview
                review={review}
                ticker={detail.ticker}
                rates={rates}
                feeTier={feeTier}
                onFeeTier={setFeeTier}
                previewFeeSats={previewFeeSats}
                busy={busy}
                onConfirm={() => void confirmTrade()}
                onCancel={() => setReview(null)}
              />
            ) : tab === "mint" ? (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">Spend · sats</span>
                  <input
                    value={budget}
                    onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
                    inputMode="numeric"
                    placeholder="e.g. 25000"
                    className="field mt-2"
                  />
                </label>
                <div className="grid grid-cols-4 gap-px bg-rule">
                  {quickSats(minSpend).map((q) => (
                    <button key={q.toString()} onClick={() => setBudget(q.toString())} className="bg-ink-2 py-2 text-xs text-bone-2 hover:text-bone">
                      {fmtInt(Number(q))}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      const m = maxBudget();
                      if (m !== null) setBudget(m.toString());
                    }}
                    disabled={maxBudget() === null}
                    className="bg-ink-2 py-2 text-xs text-bone-2 hover:text-bone disabled:opacity-40"
                  >
                    Max
                  </button>
                </div>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-bone-dim">You get</span>
                  <span className="tabular-nums text-bone">
                    {mintQuote && BigInt(mintQuote.amountAtoms) > 0n
                      ? `≈ ${fmtTokens(BigInt(mintQuote.amountAtoms))} ${detail.ticker}`
                      : budget
                        ? mintQuote?.minSpendSats
                          ? `nothing — the smallest mint is ${fmtInt(BigInt(mintQuote.minSpendSats))} sats`
                          : "too little to mint"
                        : "—"}
                  </span>
                </div>
                {mintQuote?.limitedBy === "per-mint limit" && BigInt(mintQuote.amountAtoms) > 0n ? (
                  <p className="text-xs text-pending">
                    That is the most one mint can take{mintQuote.maxGrossSats ? ` (${fmtBtc(BigInt(mintQuote.maxGrossSats))} of curve price)` : ""}. Mint again for more.
                  </p>
                ) : null}
                {mintQuote?.limitedBy === "supply" ? (
                  <p className="text-xs text-pending">That mints the last tokens on the curve.</p>
                ) : null}
                {budget && mintQuote && BigInt(mintQuote.amountAtoms) === 0n && BigInt(mintQuote.minGrossSats) > 0n ? (
                  <p className="text-xs text-bone-dim">The smallest mint is {fmtBtc(BigInt(mintQuote.minGrossSats))} of curve price.</p>
                ) : null}
                {balanceSats !== null ? (
                  <p className="text-xs text-bone-dim">Your BTC: {fmtBtc(balanceSats)} · network fee is added on the next screen</p>
                ) : null}
                <button
                  onClick={() => void reviewTrade("buy", mintQuote?.amountAtoms)}
                  disabled={busy || !mintQuote || BigInt(mintQuote.amountAtoms) <= 0n}
                  className="btn w-full"
                >
                  {busy ? "Working…" : "Review mint"}
                </button>
              </div>
            ) : tab === "redeem" ? (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">Redeem · {detail.ticker} · lots of 1,000</span>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder={heldAtoms ? fmtTokens(heldAtoms).replace(/[^0-9.]/g, "") : "e.g. 1000000"}
                    className="field mt-2"
                  />
                </label>
                {heldAtoms !== null ? (
                  <div className="grid grid-cols-3 gap-px bg-rule">
                    {[25n, 50n, 100n].map((pctOf) => (
                      <button
                        key={pctOf.toString()}
                        // Whole lots of 1,000 only: that is all the vault takes back.
                        onClick={() => setAmount((((heldAtoms * pctOf) / 100n / 100_000_000n / 1_000n) * 1_000n).toString())}
                        disabled={heldAtoms === 0n}
                        className="bg-ink-2 py-2 text-xs text-bone-2 hover:text-bone disabled:opacity-40"
                      >
                        {pctOf === 100n ? "All" : `${pctOf}%`}
                      </button>
                    ))}
                  </div>
                ) : null}
                {heldAtoms !== null ? (
                  <p className="text-xs text-bone-dim">You hold {fmtTokens(heldAtoms)} {detail.ticker}</p>
                ) : null}
                <button onClick={() => void reviewTrade("sell")} disabled={busy} className="btn w-full">
                  {busy ? "Working…" : "Review redeem"}
                </button>
              </div>
            ) : tab === "buy" ? (
              <div className="mt-5 space-y-2">
                {openAsks.length === 0 ? (
                  <p className="border border-dashed border-rule px-4 py-6 text-center text-xs text-bone-dim">
                    Nobody has listed {detail.ticker} yet. Redeem is always open.
                  </p>
                ) : (
                  openAsks.map((a) => (
                    <div key={a.listingId} className="flex items-center justify-between border border-rule bg-ink-2 px-3 py-2 text-sm">
                      <div>
                        <div className="text-bone">{fmtTokens(BigInt(a.amountAtoms))} {detail.ticker}</div>
                        <div className="text-xs text-bone-dim">{fmtBtc(BigInt(a.totalPriceSats))} + 7.5% fee</div>
                      </div>
                      <button onClick={() => void buyAsk(a)} disabled={busy} className="btn px-4 py-1.5 text-xs">
                        Buy
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">Sell · {detail.ticker}</span>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" className="field mt-2" />
                </label>
                <label className="block">
                  <span className="eyebrow">For · sats</span>
                  <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))} placeholder="41500" className="field mt-2" />
                </label>
                <label className="block">
                  <span className="eyebrow">Expires after</span>
                  <select value={listingBlocks} onChange={(e) => setListingBlocks(e.target.value)} className="field mt-2">
                    <option value="144">1 day</option>
                    <option value="1008">1 week</option>
                    <option value="4320">1 month</option>
                    <option value="21000">5 months (maximum)</option>
                  </select>
                  <span className="mt-2 block text-xs leading-relaxed text-bone-dim">
                    Your tokens never move until someone buys. When they do, you approve the sale
                    on your Wallet page within 24 hours.
                  </span>
                </label>
                <button onClick={() => void list()} disabled={busy} className="btn w-full">
                  {busy ? "Working…" : "List for sale"}
                </button>
              </div>
            )}

            {msg ? (
              <p className="mt-4 border border-verified/40 bg-verified/10 px-3 py-2 text-xs text-verified">{msg}</p>
            ) : null}
            {err ? (
              <p className="mt-4 border border-rejected/40 bg-rejected/10 px-3 py-2 text-xs text-rejected">{err}</p>
            ) : null}
            {txid ? <TxStatus txid={txid} explorerBase={EXPLORER_URL} /> : null}
          </div>

          {/* ── The verifiable facts. This is what separates Cove from a
                 dashboard: every one of these can be checked on-chain. ── */}
          <div className="bg-ink-3 px-5 py-5">
            <p className="eyebrow">On-chain record</p>
            <dl className="mt-4 space-y-3">
              <Fact k="Deploy txid" v={detail.deployTxid} mono />
              <Fact k="Deploy height" v={fmtInt(Number(detail.deployHeight))} />
              <Fact k="Backing outpoint" v={`${detail.backingOutpoint.txid}:${detail.backingOutpoint.vout}`} mono />
              <Fact k="State hash" v={detail.stateHash} mono />
              <Fact k="Policy version" v={`V${detail.policyVersion}`} />
              <Fact k="tokenId" v={detail.tokenId} mono />
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-bone-dim">
              Every value above is derivable from confirmed blocks. Run the indexer and you should
              reach the same state hash.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

interface Quote {
  stateHash: string;
  backingOutpoint: { txid: string; vout: number };
  expiresAtHeight: string;
  grossSats: string;
  feeSats: string;
  /** Mint only: the creator's share, paid on top of the curve price. */
  creatorFeeSats?: string;
  netSats?: string;
  supplyAfterAtoms: string;
}

interface Review {
  kind: "buy" | "sell";
  amountAtoms: string;
  quote: Quote;
}


/**
 * What this trade costs, before anything is signed.
 *
 * The price and the protocol fee are exact — they come from the quote the
 * build binds to, so they cannot move underneath the user. The miner fee is
 * marked "≈" because only the server knows the final transaction size, and
 * saying "≈" is better than showing a precise number that turns out to be a
 * different one.
 */
function TradeReview({
  review,
  ticker,
  rates,
  feeTier,
  onFeeTier,
  previewFeeSats,
  busy,
  onConfirm,
  onCancel,
}: {
  review: Review;
  ticker: string;
  rates: FeeRatesResponse | null;
  feeTier: FeeTier["key"];
  onFeeTier: (k: FeeTier["key"]) => void;
  previewFeeSats: (op: "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER") => bigint | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isBuy = review.kind === "buy";
  const gross = BigInt(review.quote.grossSats);
  const protocolFee = BigInt(review.quote.feeSats);
  const creatorFee = isBuy ? BigInt(review.quote.creatorFeeSats ?? "0") : 0n;
  const minerFee = previewFeeSats(isBuy ? "BACKING_BUY" : "REDEEM") ?? 0n;
  // The buyer also funds the 1,000-sat output their tokens ride on; it stays in
  // their wallet, but it is BTC they spend on this screen.
  const total = isBuy ? gross + protocolFee + creatorFee + 1_000n + minerFee : gross - protocolFee - minerFee;

  return (
    <div className="mt-5 space-y-4">
      <div className="border border-signal/40 bg-signal/5 px-4 py-4">
        <p className="eyebrow">{isBuy ? "You are minting" : "You are redeeming"}</p>
        <p className="mt-2 text-2xl tabular-nums text-bone">
          {fmtTokens(review.amountAtoms)} <span className="text-base text-bone-dim">{ticker}</span>
        </p>
      </div>

      <dl className="space-y-2 text-sm">
        <Line k="Curve price" v={fmtBtc(gross)} />
        {isBuy ? <Line k="Creator (50%)" v={`+${fmtBtc(creatorFee)}`} /> : null}
        {isBuy ? <Line k="Token carrier" v={`+${fmtBtc(1_000n)}`} /> : null}
        <Line k="Protocol fee" v={`${isBuy ? "+" : "−"}${fmtBtc(protocolFee)}`} />
        <Line k="Network fee" v={`${isBuy ? "+" : "−"}\u2248${fmtBtc(minerFee)}`} />
        <div className="border-t border-rule-bright pt-2">
          <Line
            k={isBuy ? "You pay" : "You receive"}
            v={`\u2248${fmtBtc(total < 0n ? -total : total)}`}
            strong
          />
        </div>
      </dl>

      <FeePicker
        rates={rates}
        selected={feeTier}
        onSelect={onFeeTier}
        vsizeHint={rates?.typicalVsize[isBuy ? "BACKING_BUY" : "REDEEM"]}
      />

      <p className="text-xs leading-relaxed text-bone-dim">
        The curve price and the protocol fee are locked to the backing state quoted above. If
        someone else trades first, this is refused and re-quoted rather than filled at a different
        price. Your wallet will show the final amounts before you sign.
      </p>

      <div className="grid grid-cols-2 gap-px bg-rule">
        <button onClick={onCancel} disabled={busy} className="btn-ghost w-full border-0">
          Back
        </button>
        <button onClick={onConfirm} disabled={busy} className="btn w-full">
          {busy ? "Working…" : isBuy ? "Confirm & sign" : "Confirm & sign"}
        </button>
      </div>
    </div>
  );
}

/**
 * One line of the cost breakdown. A leading "≈" on the value is the only mark
 * of an estimate — a separate "est" badge beside the label said the same thing
 * twice and ran into the label text when read aloud.
 */
function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "text-bone" : "text-bone-dim"}>{k}</dt>
      <dd className={`tabular-nums ${strong ? "text-base text-bone" : "text-bone-2"}`}>{v}</dd>
    </div>
  );
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-label uppercase tracking-label text-bone-dim">{k}</dt>
      <dd className={mono ? "hex mt-1 text-bone-2" : "mt-1 text-sm tabular-nums text-bone-2"}>{v}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="panel px-6 py-8 sm:px-10">
      <div className="h-3 w-16 animate-pulse bg-rule-bright" />
      <div className="mt-4 h-9 w-40 animate-pulse bg-rule-bright" />
      <div className="mt-2 h-3 w-28 animate-pulse bg-rule" />
      <div className="mt-8 h-1.5 w-full bg-rule" />
      <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-ink-3 px-4 py-5">
            <div className="h-5 w-24 animate-pulse bg-rule" />
            <div className="mt-2 h-2.5 w-16 animate-pulse bg-rule" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * useSearchParams opts this route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary.
 */
export default function TokenPage() {
  return (
    <Suspense fallback={<div className="panel px-6 py-16 text-center text-sm text-bone-dim">Loading…</div>}>
      <TokenContent />
    </Suspense>
  );
}
