"use client";

import { useTradeRevision } from "./use-indexed-block";
import { useEffect, useState } from "react";
import { demoCandles } from "./demo-candles";

/**
 * Recent price series for a list of tokens, keyed by token id.
 *
 * Explore and Market both draw a sparkline per row, so this batches the whole
 * page into one request instead of one per row. In demo mode it derives the
 * same shape from the deterministic fixture, so the two paths render
 * identically and the design can be reviewed before anything has traded.
 *
 * A token with no trades maps to an empty array. Callers should treat that as
 * "no market yet", not as an error.
 */

export interface SparklineSubject {
  tokenId: string;
  ticker: string;
  curveStage: number;
}

export interface SparklineData {
  series: Record<string, number[]>;
  lastPrice: Record<string, number | null>;
  loading: boolean;
}

/** Points per series — matches the sparklines endpoint. */
const POINTS = 32;

export function useSparklines(subjects: SparklineSubject[], demo: boolean): SparklineData {
  const revision = useTradeRevision();
  const [series, setSeries] = useState<Record<string, number[]>>({});
  const [lastPrice, setLastPrice] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);

  // Re-fetch only when the actual set of tokens changes, not on every render of
  // a freshly built array.
  const key = subjects.map((s) => s.tokenId).join(",");

  useEffect(() => {
    if (subjects.length === 0) {
      setSeries({});
      setLastPrice({});
      setLoading(false);
      return;
    }

    if (demo) {
      const s: Record<string, number[]> = {};
      const p: Record<string, number | null> = {};
      for (const subject of subjects) {
        const candles = demoCandles(subject.ticker, subject.curveStage, "1h", POINTS);
        s[subject.tokenId] = candles.map((c) => c.close);
        p[subject.tokenId] = candles[candles.length - 1]?.close ?? null;
      }
      setSeries(s);
      setLastPrice(p);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void fetch(`/api/v3/tokens/sparklines?tokenIds=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setSeries(j.ok ? j.data.series : {});
        setLastPrice(j.ok ? j.data.lastPrice : {});
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSeries({});
        setLastPrice({});
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `key` stands in for the token set; `subjects` is rebuilt every render.
  }, [key, demo, revision]);

  return { series, lastPrice, loading };
}
