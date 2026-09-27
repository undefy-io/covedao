"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useEffect, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import type { OhlcCandle, Interval } from "@/lib/ohlc";

/**
 * Candlestick chart for a Cove token, priced in sats per 1,000,000 tokens.
 *
 * KLineCharts is canvas-only and touches `window` at module scope, so it is
 * imported inside the effect rather than at the top of the file — a static
 * import crashes the Next.js server render.
 *
 * The theme is the Ledger palette, not KLineCharts' defaults: ink ground,
 * hairline grid, amber crosshair, and the semantic verified/rejected pair for
 * up and down candles so the colours mean the same thing here as everywhere
 * else in the product.
 */

const INK = "#0B0B0C";
const BONE_DIM = "#9A958A";
const RULE = "#26262A";
const SIGNAL = "#E08A2B";
const UP = "#5E9E76";
const DOWN = "#C4553F";
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const INTERVALS: { key: Interval; label: string }[] = [
  { key: "10m", label: "10M" },
  { key: "1h", label: "1H" },
  { key: "4h", label: "4H" },
  { key: "1D", label: "1D" },
];

export function TokenChart({
  ticker,
  candles,
  interval,
  onIntervalChange,
  loading = false,
  className = "",
}: {
  ticker: string;
  candles: OhlcCandle[];
  interval: Interval;
  onIntervalChange: (i: Interval) => void;
  loading?: boolean;
  className?: string;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const [ready, setReady] = useState(false);

  // Keep the latest series in a ref so new data replays through the existing
  // loader instead of tearing down and rebuilding the chart instance.
  const dataRef = useRef<OhlcCandle[]>(candles);
  dataRef.current = candles;

  useEffect(() => {
    let disposed = false;
    let chart: Chart | null = null;

    void (async () => {
      const { init, dispose } = await import("klinecharts");
      if (disposed || !containerRef.current) return;

      chart = init(containerRef.current, {
        styles: {
          grid: {
            show: true,
            horizontal: { color: "rgba(255,255,255,0.045)", style: "solid" },
            vertical: { color: "rgba(255,255,255,0.045)", style: "solid" },
          },
          candle: {
            bar: {
              upColor: UP,
              downColor: DOWN,
              noChangeColor: BONE_DIM,
              upBorderColor: UP,
              downBorderColor: DOWN,
              noChangeBorderColor: BONE_DIM,
              upWickColor: UP,
              downWickColor: DOWN,
              noChangeWickColor: BONE_DIM,
            },
            priceMark: {
              high: { show: false },
              low: { show: false },
              last: {
                line: { style: "dashed", dashedValue: [3, 3] },
                text: { family: MONO, size: 10, borderRadius: 0, paddingLeft: 6, paddingRight: 6 },
              },
            },
            tooltip: {
              showRule: "follow_cross",
              title: { show: false },
              legend: { color: "#E8E4DB", family: MONO, size: 10 },
            },
          },
          indicator: {
            bars: [{ upColor: "rgba(94,158,118,0.55)", downColor: "rgba(196,85,63,0.55)", noChangeColor: RULE }],
            lines: [
              { color: SIGNAL, size: 1 },
              { color: "#7C7669", size: 1 },
              { color: "#4A4640", size: 1 },
            ],
            tooltip: {
              showRule: "follow_cross",
              title: { show: false, color: BONE_DIM, family: MONO, size: 10 },
              legend: { color: BONE_DIM, family: MONO, size: 10 },
            },
            lastValueMark: { show: false },
          },
          xAxis: {
            axisLine: { color: RULE },
            tickLine: { color: RULE },
            tickText: { color: BONE_DIM, family: MONO, size: 10 },
          },
          yAxis: {
            axisLine: { color: RULE },
            tickLine: { color: RULE },
            tickText: { color: BONE_DIM, family: MONO, size: 10 },
          },
          separator: { color: RULE },
          crosshair: {
            horizontal: {
              line: { color: SIGNAL, style: "dashed", dashedValue: [3, 3] },
              text: { backgroundColor: SIGNAL, color: INK, family: MONO, size: 10, borderRadius: 0 },
            },
            vertical: {
              line: { color: SIGNAL, style: "dashed", dashedValue: [3, 3] },
              text: { backgroundColor: SIGNAL, color: INK, family: MONO, size: 10, borderRadius: 0 },
            },
          },
        },
      });
      if (!chart) return;

      chart.setSymbol({ ticker, pricePrecision: 2, volumePrecision: 0 });
      chart.setPeriod({ type: "minute", span: 10 });
      chart.setDataLoader({
        getBars: ({ callback }) => {
          callback(dataRef.current, false);
        },
      });
      chart.createIndicator("VOL", false);

      chartRef.current = chart;
      setReady(true);

      // Chart canvases do not reflow on their own.
      const ro = new ResizeObserver(() => chart?.resize());
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        dispose(chart!);
      };
    })();

    return () => {
      disposed = true;
      if (chart) {
        void import("klinecharts").then((m) => m.dispose(chart!));
      }
      chartRef.current = null;
    };
    // The instance is built once; data changes go through the loader below.
  }, [ticker]);

  // Re-run the loader whenever the interval (and therefore the series) changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chart.setDataLoader({
      getBars: ({ callback }) => {
        callback(dataRef.current, false);
      },
    });
  }, [interval, ready, candles]);

  return (
    <div className={`panel ${className}`}>
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <p className="eyebrow">{t("chart.title", { ticker })}</p>
        <div className="flex gap-px bg-rule">
          {INTERVALS.map((i) => (
            <button
              key={i.key}
              onClick={() => onIntervalChange(i.key)}
              aria-pressed={interval === i.key}
              className={
                interval === i.key
                  ? "bg-signal px-2.5 py-1 text-label tracking-label text-ink"
                  : "bg-ink-3 px-2.5 py-1 text-label tracking-label text-bone-dim transition-colors hover:text-bone"
              }
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={containerRef} className="h-[420px] w-full" />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/60 text-label uppercase tracking-label text-bone-dim">
            {t("chart.loading")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
