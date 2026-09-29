"use client";

import type { MessageKey } from "@/i18n";
import { useT } from "@/i18n/LanguageProvider";
import { Suspense, useCallback, useEffect, useState } from "react";
import { EXPLORER_URL } from "@/lib/network";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { verifyClientIntent } from "@crclaunch/wallets";
import {
  fmtBtc,
  fmtTokens,
  fmtInt,
  displayTokensToAtoms,
  atomsToDisplayTokens,
} from "@/lib/format";
import { DEMO_TOKEN_DETAIL, DEMO_LISTINGS } from "@/lib/demo-tokens";
import { TokenMarketPanel } from "@/components/TokenMarketPanel";
import {
  FeePicker,
  useFeeRates,
  type FeeRatesResponse,
  type FeeTier,
} from "@/components/FeePicker";
import { TxStatus } from "@/components/TxStatus";
import { TokenActivity } from "@/components/TokenActivity";
import { TokenImage } from "@/components/TokenImage";
import { Tile } from "@/components/Tile";
import { unitPriceSats } from "@/lib/ohlc";
import {
  useIndexedBlock,
  usePendingRevision,
  useMarketRevision,
  notifyLocalBroadcast,
} from "@/lib/use-indexed-block";
import { createListing, buyListing, errorText } from "@/lib/trade";
import { fetchBuyQuote } from "@/lib/buy-quote";

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
const TAB_LABEL: Record<Tab, MessageKey> = {
  mint: "tok.tabMint",
  redeem: "tok.tabRedeem",
  buy: "tok.tabBuy",
  sell: "tok.tabSell",
};
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
  const t = useT();
  const {
    connected,
    address,
    ordinalsAddress,
    script,
    publicKey,
    ordinalsScript,
    walletFields,
    network,
    connect,
    signPsbt,
    signBip322,
    getUtxos,
  } = useWallet();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("mint");
  const [amount, setAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [quoteState, setMintQuote] = useState<{
    forAmount: string;
    forBlock: string;
    quote: Quote;
  } | null>(null);
  const [mintQuoteError, setMintQuoteError] = useState("");
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
  const {
    rates,
    selected: feeTier,
    setSelected: setFeeTier,
    satPerVb,
    previewFeeSats,
  } = useFeeRates();
  // What the user is about to commit to, held between "Review" and "Confirm".
  // Nothing is built, signed or broadcast until they have seen these numbers.
  const [review, setReview] = useState<Review | null>(null);
  // Refetch everything below whenever a new block is indexed: that is the only
  // time any of it changes (a mint shows up once its block is confirmed).
  const block = useIndexedBlock();
  const pendingRevision = usePendingRevision();
  const marketRevision = useMarketRevision();

  useEffect(() => {
    if (demo) {
      setDetail(DEMO_TOKEN_DETAIL as unknown as Detail);
      setLoaded(true);
      return;
    }
    // A token exists only once its DEPLOY is in a block, so right after a launch
    // this 404s for a while. Keep asking until the indexer has it.
    let cancelled = false;
    const load = () => {
      void fetch(`/api/v3/tokens/${tokenId}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.ok) setDetail(j.data);
          setLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          setLoaded(true);
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [tokenId, marketRevision]);

  const graduatedNow = detail
    ? BigInt(detail.issuedSupplyAtoms) >= BigInt(detail.publicCapAtoms)
    : false;
  const tabs = graduatedNow ? TABS_GRADUATED : TABS_OPEN;
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0]!);
  }, [graduatedNow, tab, tabs]);

  // Quote the exact token amount. A changed input or indexed block invalidates
  // the old quote, including while a newer request is still in flight.
  useEffect(() => {
    if (busy || review) return;
    setMintQuote(null);
    setMintQuoteError("");
    if (demo || tab !== "mint" || !amount) return;
    if (!/^\d+$/.test(amount) || BigInt(amount) === 0n || BigInt(amount) % 1_000n !== 0n) {
      setMintQuoteError(t("tok.errLots"));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchBuyQuote<Quote>(tokenId, displayTokensToAtoms(amount), controller.signal)
        .then((j) => {
          if (controller.signal.aborted) return;
          if (j.ok) setMintQuote({ forAmount: amount, forBlock: pendingRevision, quote: j.data });
          else setMintQuoteError(errorText(j));
        })
        .catch(() => {
          if (!controller.signal.aborted) setMintQuoteError(t("tok.quoteUnavailable"));
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [amount, tokenId, demo, tab, pendingRevision, t, busy, review]);

  // What the connected wallet holds of this token, and what it can spend.
  const refreshWallet = useCallback(async () => {
    if (demo || !connected) return;
    try {
      const pf = await fetch(`/api/v3/wallet/${ordinalsAddress || address}/portfolio`).then((r) =>
        r.json(),
      );
      const mine = (pf.data?.tokenUtxos ?? []) as { tokenId: string; amountAtoms: string }[];
      setHeldAtoms(
        mine.filter((u) => u.tokenId === tokenId).reduce((a, u) => a + BigInt(u.amountAtoms), 0n),
      );
      const ux = await fetch(`/api/v3/wallet/utxos?address=${encodeURIComponent(address)}`).then(
        (r) => r.json(),
      );
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
        open.sort(
          (a, b) =>
            unitPriceSats(a.amountAtoms, a.totalPriceSats) -
            unitPriceSats(b.amountAtoms, b.totalPriceSats),
        );
        setOpenAsks(open);
      })
      .catch(() => setOpenAsks([]));
  }, [demo, graduatedNow, tokenId, txid, marketRevision]);

  async function buyAsk(ask: Ask) {
    if (!connected) return;
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      if (BigInt(displayTokensToAtoms(buyAmount)) !== BigInt(ask.amountAtoms)) {
        throw new Error(t("tok.buyExactListing"));
      }
      const { txid } = await buyListing(
        ask,
        { script, publicKey, ordinalsScript, signPsbt, signBip322, getUtxos },
        satPerVb,
      );
      setMsg(t("tok.bought", { txid: txid.slice(0, 16) }));
      setBuyAmount("");
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
      if (BigInt(amountAtoms) <= 0n)
        throw new Error(kind === "buy" ? t("tok.errMintNothing") : t("tok.errRedeemAmount"));
      if (BigInt(amountAtoms) % (1_000n * 100_000_000n) !== 0n) throw new Error(t("tok.errLots"));
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
      const funding = await getUtxos(true);
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
      notifyLocalBroadcast();
      setMsg(isBuy ? t("tok.minted") : t("tok.redeemed"));
      setReview(null);
      setAmount("");
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
        amountAtoms: BigInt(displayTokensToAtoms(sellAmount)),
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
        t("tok.listed", { id: listingId.slice(0, 16) }) +
          (pending ? ` ${t("tok.listedPending")}` : "") +
          ` ${t("tok.listedNoSign")}`,
      );
      setSellAmount("");
      setPrice("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const mintQuote =
    quoteState && quoteState.forAmount === amount && quoteState.forBlock === pendingRevision
      ? quoteState.quote
      : null;
  const requestedBuyAtoms = /^\d+(\.\d{1,8})?$/.test(buyAmount)
    ? BigInt(displayTokensToAtoms(buyAmount))
    : null;
  const matchingAsks =
    requestedBuyAtoms === null || requestedBuyAtoms === 0n
      ? []
      : openAsks.filter((ask) => BigInt(ask.amountAtoms) === requestedBuyAtoms);

  if (!loaded) return <DetailSkeleton />;
  if (!detail) {
    return (
      <section className="panel px-6 py-16 text-center sm:px-10">
        <span className="chip chip-pending">{t("tok.pending")}</span>
        <div className="mt-4 text-bone">{t("tok.creating")}</div>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-bone-dim">
          {t("tok.creatingBody")}
        </p>
        <Link href="/explore" className="btn-ghost mt-5">
          {t("tok.backExplore")}
        </Link>
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
            {t("common.demoData")}
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
              <p className="eyebrow">{t("tok.eyebrow")}</p>
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
                      {t("tok.website")}
                    </a>
                  ) : null}
                  {detail.xUrl ? (
                    <a
                      href={detail.xUrl}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-label uppercase tracking-label text-bone-dim hover:text-signal"
                    >
                      {t("tok.x")}
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <span className={graduated ? "chip chip-signal" : "chip chip-verified"}>
            {graduated ? t("common.graduated") : t("common.open")}
          </span>
        </div>
        {detail.description ? (
          <p className="mt-5 max-w-xl text-sm leading-relaxed text-bone-dim">
            {detail.description}
          </p>
        ) : null}

        {graduated ? (
          <div className="mt-6 border border-signal/40 bg-signal/10 px-5 py-4">
            <p className="text-label uppercase tracking-label text-signal">
              {t("tok.graduatedTitle")}
            </p>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-bone-dim">
              {t("tok.graduatedBody")}
            </p>
          </div>
        ) : null}

        {/* The curve is the single most important thing on this page. */}
        <div className="mt-8">
          <div className="flex items-baseline justify-between text-label uppercase tracking-label text-bone-dim">
            <span>{t("tok.pctMinted", { pct: pct.toFixed(1) })}</span>
            <span>
              {t("tok.stairOf", { n: detail.curveStage })}
              {!graduated
                ? t("tok.nextStair", {
                    n: fmtTokens(BigInt(detail.curveStage) * 100_000n * 100_000_000n),
                  })
                : ""}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full bg-rule">
            <div className="h-1.5 bg-signal" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="mt-2 flex items-baseline justify-between text-xs tabular-nums">
            <span className="text-bone">
              {fmtTokens(issued)} <span className="text-bone-dim">({pct.toFixed(1)}%)</span>
            </span>
            <span className="text-bone-dim">{t("tok.cap", { n: fmtTokens(cap) })}</span>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile
            size="md"
            value={fmtBtc(BigInt(detail.backingSats))}
            label={t("tok.btcBacking")}
            help={t("tok.btcBackingHelp", { ticker: detail.ticker })}
          />
          <Tile
            size="md"
            value={fmtTokens(BigInt(detail.remainingCapacityAtoms))}
            label={t("tok.remaining")}
            help={t("tok.remainingHelp")}
          />
          <Tile
            size="md"
            value={fmtInt(detail.holderCount)}
            label={t("tok.holders")}
            help={t("tok.holdersHelp", { ticker: detail.ticker })}
          />
          <Tile
            size="md"
            value={detail.bestAskSats ? fmtBtc(BigInt(detail.bestAskSats)) : "—"}
            label={
              detail.activeListingCount
                ? t("tok.bestAskListed", { n: detail.activeListingCount })
                : t("tok.bestAsk")
            }
            help={t("tok.bestAskHelp")}
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
        refreshKey={marketRevision}
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
        <p className="eyebrow">{t("tok.trade")}</p>
        <div className="mt-5 grid gap-px bg-rule lg:grid-cols-[1fr_1.1fr]">
          <div className="bg-ink-3 px-5 py-5">
            <div className="flex flex-wrap">
              {tabs.map((tb) => (
                <button
                  key={tb}
                  onClick={() => {
                    setTab(tb);
                    setReview(null);
                    setErr("");
                  }}
                  className={
                    tab === tb
                      ? "border border-signal bg-signal px-3 py-1.5 text-label uppercase tracking-label text-ink"
                      : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone"
                  }
                >
                  {t(TAB_LABEL[tb])}
                </button>
              ))}
            </div>

            <p className="mt-4 text-xs leading-relaxed text-bone-dim">
              {tab === "mint"
                ? t("tok.introMint", { ticker: detail.ticker })
                : tab === "redeem"
                  ? t("tok.introRedeem", { ticker: detail.ticker })
                  : tab === "buy"
                    ? t("tok.introBuy", { ticker: detail.ticker })
                    : t("tok.introSell", { ticker: detail.ticker })}
            </p>

            {!connected ? (
              <button onClick={() => void connect()} className="btn mt-5 w-full">
                {t("tok.connect")}
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
                feeAvailable={satPerVb !== null}
                onConfirm={() => void confirmTrade()}
                onCancel={() => setReview(null)}
              />
            ) : tab === "mint" ? (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">{t("tok.mintAmount", { ticker: detail.ticker })}</span>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                    inputMode="numeric"
                    placeholder={t("tok.redeemPh")}
                    className="field mt-2"
                  />
                </label>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-bone-dim">{t("tok.youPay")}</span>
                  <span className="tabular-nums text-bone">
                    {mintQuote
                      ? fmtBtc(
                          BigInt(mintQuote.grossSats) +
                            BigInt(mintQuote.feeSats) +
                            BigInt(mintQuote.creatorFeeSats ?? "0") +
                            1_000n,
                        )
                      : "—"}
                  </span>
                </div>
                {mintQuoteError ? <p className="text-xs text-pending">{mintQuoteError}</p> : null}
                {mintQuote ? (
                  <p className="text-xs text-bone-dim">{t("tok.mintNetworkFeeNote")}</p>
                ) : null}
                {balanceSats !== null ? (
                  <p className="text-xs text-bone-dim">
                    {t("tok.yourBtc", { btc: fmtBtc(balanceSats) })}
                  </p>
                ) : null}
                <button
                  onClick={() => void reviewTrade("buy", displayTokensToAtoms(amount))}
                  disabled={busy || !mintQuote}
                  className="btn w-full"
                >
                  {busy ? t("tok.working") : t("tok.reviewMint")}
                </button>
              </div>
            ) : tab === "redeem" ? (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">{t("tok.redeemLabel", { ticker: detail.ticker })}</span>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder={
                      heldAtoms ? fmtTokens(heldAtoms).replace(/[^0-9.]/g, "") : t("tok.redeemPh")
                    }
                    className="field mt-2"
                  />
                </label>
                {heldAtoms !== null ? (
                  <div className="grid grid-cols-3 gap-px bg-rule">
                    {[25n, 50n, 100n].map((pctOf) => (
                      <button
                        key={pctOf.toString()}
                        // Whole lots of 1,000 only: that is all the vault takes back.
                        onClick={() =>
                          setAmount(
                            (
                              ((heldAtoms * pctOf) / 100n / 100_000_000n / 1_000n) *
                              1_000n
                            ).toString(),
                          )
                        }
                        disabled={heldAtoms === 0n}
                        className="bg-ink-2 py-2 text-xs text-bone-2 hover:text-bone disabled:opacity-40"
                      >
                        {pctOf === 100n ? t("tok.all") : `${pctOf}%`}
                      </button>
                    ))}
                  </div>
                ) : null}
                {heldAtoms !== null ? (
                  <p className="text-xs text-bone-dim">
                    {t("tok.youHold", { amount: fmtTokens(heldAtoms), ticker: detail.ticker })}
                  </p>
                ) : null}
                <button
                  onClick={() => void reviewTrade("sell")}
                  disabled={busy}
                  className="btn w-full"
                >
                  {busy ? t("tok.working") : t("tok.reviewRedeem")}
                </button>
              </div>
            ) : tab === "buy" ? (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">{t("tok.buyAmount", { ticker: detail.ticker })}</span>
                  <input
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder={t("tok.buyAmountPh")}
                    className="field mt-2"
                  />
                </label>
                <p className="text-xs leading-relaxed text-bone-dim">{t("tok.buyExactListing")}</p>
                {openAsks.length === 0 ? (
                  <p className="border border-dashed border-rule px-4 py-6 text-center text-xs text-bone-dim">
                    {t("tok.nobodyListed", { ticker: detail.ticker })}
                  </p>
                ) : (
                  <>
                    {buyAmount && matchingAsks.length === 0 ? (
                      <p className="border border-dashed border-rule px-4 py-6 text-center text-xs text-bone-dim">
                        {requestedBuyAtoms === null || requestedBuyAtoms === 0n
                          ? t("tok.buyInvalidAmount")
                          : t("tok.buyNoExactListing")}
                      </p>
                    ) : null}
                    {(buyAmount && matchingAsks.length > 0 ? matchingAsks : openAsks).map((a) => (
                      <div
                        key={a.listingId}
                        className="flex items-center justify-between border border-rule bg-ink-2 px-3 py-2 text-sm"
                      >
                        <div>
                          <div className="text-bone">
                            {atomsToDisplayTokens(a.amountAtoms)} {detail.ticker}
                          </div>
                          <div className="text-xs text-bone-dim">
                            {t("tok.plusFee", { btc: fmtBtc(BigInt(a.totalPriceSats)) })}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            buyAmount && matchingAsks.length > 0
                              ? void buyAsk(a)
                              : setBuyAmount(atomsToDisplayTokens(a.amountAtoms))
                          }
                          disabled={busy}
                          className="btn px-4 py-1.5 text-xs"
                        >
                          {buyAmount && matchingAsks.length > 0
                            ? t("tok.buy")
                            : t("tok.chooseAmount")}
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="eyebrow">{t("tok.sellAmount", { ticker: detail.ticker })}</span>
                  <input
                    value={sellAmount}
                    onChange={(e) => setSellAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder={t("tok.redeemPh")}
                    className="field mt-2"
                  />
                </label>
                {heldAtoms !== null ? (
                  <p className="text-xs text-bone-dim">
                    {t("tok.youHold", {
                      amount: atomsToDisplayTokens(heldAtoms),
                      ticker: detail.ticker,
                    })}
                  </p>
                ) : null}
                <label className="block">
                  <span className="eyebrow">{t("tok.forSats")}</span>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="41500"
                    className="field mt-2"
                  />
                </label>
                <label className="block">
                  <span className="eyebrow">{t("tok.expires")}</span>
                  <select
                    value={listingBlocks}
                    onChange={(e) => setListingBlocks(e.target.value)}
                    className="field mt-2"
                  >
                    <option value="144">{t("tok.day1")}</option>
                    <option value="1008">{t("tok.week1")}</option>
                    <option value="4320">{t("tok.month1")}</option>
                    <option value="21000">{t("tok.months5")}</option>
                  </select>
                  <span className="mt-2 block text-xs leading-relaxed text-bone-dim">
                    {t("tok.listNote")}
                  </span>
                </label>
                <button
                  onClick={() => void list()}
                  disabled={busy || !sellAmount || !price}
                  className="btn w-full"
                >
                  {busy ? t("tok.working") : t("tok.listForSale")}
                </button>
              </div>
            )}

            {msg ? (
              <p className="mt-4 border border-verified/40 bg-verified/10 px-3 py-2 text-xs text-verified">
                {msg}
              </p>
            ) : null}
            {err ? (
              <p className="mt-4 border border-rejected/40 bg-rejected/10 px-3 py-2 text-xs text-rejected">
                {err}
              </p>
            ) : null}
            {txid ? <TxStatus txid={txid} explorerBase={EXPLORER_URL} /> : null}
          </div>

          {/* ── The verifiable facts. This is what separates Cove from a
                 dashboard: every one of these can be checked on-chain. ── */}
          <div className="bg-ink-3 px-5 py-5">
            <p className="eyebrow">{t("tok.onchain")}</p>
            <dl className="mt-4 space-y-3">
              <Fact k={t("tok.deployTxid")} v={detail.deployTxid} mono />
              <Fact k={t("tok.deployHeight")} v={fmtInt(Number(detail.deployHeight))} />
              <Fact
                k={t("tok.backingOutpoint")}
                v={`${detail.backingOutpoint.txid}:${detail.backingOutpoint.vout}`}
                mono
              />
              <Fact k={t("tok.stateHash")} v={detail.stateHash} mono />
              <Fact k={t("tok.policyVersion")} v={`V${detail.policyVersion}`} />
              <Fact k={t("tok.tokenId")} v={detail.tokenId} mono />
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-bone-dim">{t("tok.onchainNote")}</p>
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
  feeAvailable,
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
  feeAvailable: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isBuy = review.kind === "buy";
  const gross = BigInt(review.quote.grossSats);
  const protocolFee = BigInt(review.quote.feeSats);
  const creatorFee = isBuy ? BigInt(review.quote.creatorFeeSats ?? "0") : 0n;
  const minerFee = previewFeeSats(isBuy ? "BACKING_BUY" : "REDEEM") ?? 0n;
  // The buyer also funds the 1,000-sat output their tokens ride on; it stays in
  // their wallet, but it is BTC they spend on this screen.
  const total = isBuy
    ? gross + protocolFee + creatorFee + 1_000n + minerFee
    : gross - protocolFee - minerFee;

  return (
    <div className="mt-5 space-y-4">
      <div className="border border-signal/40 bg-signal/5 px-4 py-4">
        <p className="eyebrow">{isBuy ? t("tok.youMint") : t("tok.youRedeem")}</p>
        <p className="mt-2 text-2xl tabular-nums text-bone">
          {fmtTokens(review.amountAtoms)} <span className="text-base text-bone-dim">{ticker}</span>
        </p>
      </div>

      <dl className="space-y-2 text-sm">
        <Line k={t("tok.curvePrice")} v={fmtBtc(gross)} />
        {isBuy ? <Line k={t("tok.creator50")} v={`+${fmtBtc(creatorFee)}`} /> : null}
        {isBuy ? <Line k={t("tok.carrier")} v={`+${fmtBtc(1_000n)}`} /> : null}
        <Line k={t("tok.protocolFee")} v={`${isBuy ? "+" : "−"}${fmtBtc(protocolFee)}`} />
        <Line k={t("tok.networkFee")} v={`${isBuy ? "+" : "−"}\u2248${fmtBtc(minerFee)}`} />
        <div className="border-t border-rule-bright pt-2">
          <Line
            k={isBuy || total < 0n ? t("tok.youPay") : t("tok.youReceive")}
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

      {rates && !feeAvailable ? (
        <p className="text-xs text-pending">{t("fee.noAffordable")}</p>
      ) : null}
      {!isBuy && total < 0n ? (
        <p className="text-xs leading-relaxed text-bone-dim">{t("tok.redeemFeeShortfall")}</p>
      ) : null}
      <p className="text-xs leading-relaxed text-bone-dim">{t("tok.lockedNote")}</p>

      <div className="grid grid-cols-2 gap-px bg-rule">
        <button onClick={onCancel} disabled={busy} className="btn-ghost w-full border-0">
          {t("tok.back")}
        </button>
        <button onClick={onConfirm} disabled={busy || !feeAvailable} className="btn w-full">
          {busy ? t("tok.working") : t("tok.confirmSign")}
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
      <dd className={mono ? "hex mt-1 text-bone-2" : "mt-1 text-sm tabular-nums text-bone-2"}>
        {v}
      </dd>
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

function SuspenseLoading() {
  const t = useT();
  return (
    <div className="panel px-6 py-16 text-center text-sm text-bone-dim">{t("common.loading")}</div>
  );
}

/**
 * useSearchParams opts this route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary.
 */
export default function TokenPage() {
  return (
    <Suspense fallback={<SuspenseLoading />}>
      <TokenContent />
    </Suspense>
  );
}
