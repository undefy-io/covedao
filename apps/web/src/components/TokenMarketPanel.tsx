"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { TokenChart } from "./TokenChart";
import { MarketStats, type MarketSummary } from "./MarketStats";
import { SalesFeed, type Sale } from "./SalesFeed";
import { summarize, type Interval, type OhlcCandle } from "@/lib/ohlc";
import { demoCandles } from "@/lib/demo-candles";
import { demoMarket } from "@/lib/demo-market";
import { fmtInt } from "@/lib/format";

/**
 * Price history for a token: the candlestick chart plus the summary strip and
 * ask ladder that make it readable.
 *
 * Real tokens are charted from settled peer-to-peer trades via the candles API.
 * When a token has never traded there is no series to draw, and the panel says
 * so instead of inventing one — a chart is a claim about what happened, and an
 * empty market is a real answer.
 *
 * Under `?demo=1` the series is the deterministic curve fixture, clearly
 * labelled, so the design can be reviewed before any token has traded.
 */

interface Ask {
  /** sats per 1,000,000 tokens */
  unitPriceSats: number;
  amountTokens: number;
  status: string;
}

export function TokenMarketPanel({
  tokenId,
  ticker,
  curveStage,
  demo = false,
  asks = [],
  explorerBase,
  refreshKey,
}: {
  tokenId: string;
  ticker: string;
  curveStage: number;
  demo?: boolean;
  asks?: Ask[];
  /** Block-explorer root, so every sale links to the real transaction. */
  explorerBase?: string;
  /** Changes when a new block is indexed; the panel refetches quietly. */
  refreshKey?: string;
}) {
  const t = useT();
  const [interval, setInterval] = useState<Interval>("1h");
  const [candles, setCandles] = useState<OhlcCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [market, setMarket] = useState<
    (MarketSummary & { asks: Ask[]; recentSales: Sale[] }) | null
  >(null);

  // Market header, ask ladder and sales feed all come from one request, so the
  // header can never disagree with the chart beneath it.
  useEffect(() => {
    if (demo) {
      const m = demoMarket(ticker, curveStage, asks);
      setMarket({ ...m, asks });
      return;
    }
    let cancelled = false;
    void fetch(`/api/v3/tokens/${tokenId}/market`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.ok) setMarket(j.data);
      })
      .catch(() => {
        /* leave the header empty rather than showing invented numbers */
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId, demo, ticker, curveStage, refreshKey]);

  // Generated at the interval actually being shown, so a day candle covers a
  // real day instead of being rolled up from a four-day base.
  const demoSeries = useMemo(
    () => (demo ? demoCandles(ticker, curveStage, interval) : []),
    [demo, ticker, curveStage, interval],
  );

  // A new block refetches without the loading state, so the chart does not
  // flicker; only a new token or interval shows it.
  const shown = useRef("");
  useEffect(() => {
    if (demo) {
      setCandles(demoSeries);
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (shown.current !== `${tokenId}:${interval}`) setLoading(true);
    shown.current = `${tokenId}:${interval}`;
    void fetch(`/api/v3/tokens/${tokenId}/candles?interval=${interval}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setCandles(j.ok ? (j.data.candles as OhlcCandle[]) : []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setCandles([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId, interval, demo, demoSeries, refreshKey]);

  const ladder = market?.asks ?? asks;
  const stats = summarize(candles);
  const up = (stats?.changePct ?? 0) >= 0;

  return (
    <section className="panel px-6 py-8 sm:px-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="eyebrow">{t("mkt.eyebrow")}</p>
        {demo ? (
          <span className="chip chip-pending">{t("mkt.demoSeries")}</span>
        ) : (
          <span className="text-label uppercase tracking-label text-bone-dim">
            {t("mkt.settledP2p")}
          </span>
        )}
      </div>

      {market ? (
        <div className="mt-5 border border-rule">
          <MarketStats s={market} />
        </div>
      ) : null}

      {/* Fallback strip for demo mode, where there is no market payload. */}
      <div className={`mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-5${market ? " hidden" : ""}`}>
        <Stat
          value={stats ? fmtInt(Math.round(stats.last)) : "—"}
          label={t("mkt.last1k")}
          tone={stats ? (up ? "up" : "down") : undefined}
        />
        <Stat
          value={stats ? `${up ? "+" : ""}${stats.changePct.toFixed(1)}%` : "—"}
          label={t("mkt.change")}
          tone={stats ? (up ? "up" : "down") : undefined}
        />
        <Stat value={stats ? fmtInt(Math.round(stats.high)) : "—"} label={t("mkt.high")} />
        <Stat value={stats ? fmtInt(Math.round(stats.low)) : "—"} label={t("mkt.low")} />
        <Stat value={stats ? fmtInt(stats.trades) : "—"} label={t("mkt.trades")} />
      </div>

      <div className="mt-5 grid gap-px bg-rule lg:grid-cols-[1.9fr_1fr]">
        {candles.length === 0 && !loading ? (
          <div className="flex min-h-[420px] items-center justify-center border border-dashed border-rule bg-ink-3 px-6 text-center">
            <div>
              <p className="text-sm text-bone">{t("mkt.noTrades")}</p>
              <p className="mt-2 max-w-xs text-xs leading-relaxed text-bone-dim">{t("mkt.noTradesBody")}</p>
            </div>
          </div>
        ) : (
          <TokenChart
            ticker={ticker}
            candles={candles}
            interval={interval}
            onIntervalChange={setInterval}
            loading={loading}
            className="border-0"
          />
        )}

        <AskLadder asks={ladder} />
      </div>

      {market ? (
        <div className="mt-8">
          <SalesFeed sales={market.recentSales} explorerBase={explorerBase} />
        </div>
      ) : null}
    </section>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-verified" : tone === "down" ? "text-rejected" : "text-bone";
  return (
    <div className="tile">
      <div className={`text-xl tabular-nums ${color}`}>{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

/**
 * Open asks, cheapest first. Every row is a real token UTXO a buyer can fill,
 * so the depth bar is sized by the tokens actually on offer, not by notional.
 */
function AskLadder({ asks }: { asks: Ask[] }) {
  const t = useT();
  const sorted = [...asks].sort((a, b) => a.unitPriceSats - b.unitPriceSats);
  const max = Math.max(1, ...sorted.map((a) => a.amountTokens));

  return (
    <div className="bg-ink-3 px-5 py-4">
      <p className="eyebrow">{t("mkt.asks")}</p>
      {sorted.length === 0 ? (
        <p className="mt-5 text-xs leading-relaxed text-bone-dim">{t("mkt.nothingListed")}</p>
      ) : (
        <div className="mt-4 space-y-px">
          <div className="flex justify-between pb-1 text-label uppercase tracking-label text-bone-dim">
            <span>{t("mkt.price")}</span>
            <span>{t("mkt.size")}</span>
          </div>
          {sorted.map((a, i) => (
            <div key={i} className="relative flex justify-between py-1.5 text-xs tabular-nums">
              {/* Depth is drawn behind the numbers, never on top of them. */}
              <span
                className="absolute inset-y-0 right-0 bg-rejected/25"
                style={{ width: `${(a.amountTokens / max) * 100}%` }}
                aria-hidden
              />
              <span className="relative text-rejected">{fmtInt(Math.round(a.unitPriceSats))}</span>
              <span className="relative text-bone-dim">
                {fmtInt(a.amountTokens)}
                {a.status !== "ACTIVE" ? (
                  <span className="ml-2 text-pending">{a.status[0]}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
