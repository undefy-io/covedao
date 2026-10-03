"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCrcRead } from "../lib/use-crc-read";
import { crcIndexedRefresh } from "../lib/crc-indexed-refresh";
import type { Interval, OhlcCandle } from "@/lib/ohlc";
import type { CrcMarketListing } from "@/lib/crc-market-client";
import { formatAtoms, formatVaultSats } from "./CrcHome";
import { Tile } from "./Tile";
import { TokenChart } from "./TokenChart";

export function CrcTokenMarket({ assetId, ticker }: { assetId: string; ticker: string }) {
  const [curveSats, setCurveSats] = useState<string | null>(null);
  const [totalSats, setTotalSats] = useState<string | null>(null);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);
  const [interval, setInterval] = useState<Interval>("1h");
  const { data: history } = useCrcRead<{ candles: OhlcCandle[] }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/candles?interval=${interval}`, "Could not load price history");
  const candles = history?.candles ?? [];
  const chartLoading = history === null;

  useEffect(() => crcIndexedRefresh.subscribe(async (signal) => {
    const response = await fetch("/api/crc/v1/backing/buy/quote", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, amountAtoms: "100000000000" }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const curve = await response.json();
    if (!response.ok || !curve.ok) throw new Error(curve.error?.message ?? "Could not read curve price");
    if (!signal.aborted && curve.data?.quote) {
      setCurveSats(curve.data.quote.grossSats);
      setTotalSats(curve.data.quote.buyerTotalSats);
    }
  }), [assetId]);

  useEffect(() => {
    let live = true;
    void fetch(`/api/crc/v1/market/listings?deployTxid=${assetId.split(":")[1]}`, { cache: "no-store" })
      .then((response) => response.json()).then((market) => {
        if (live && market.ok && Array.isArray(market.data?.listings)) {
          setListings((market.data.listings as CrcMarketListing[]).filter((row) =>
            row.status === "OPEN" && `${row.network}:${row.deployTxid}` === assetId));
        }
      }).catch(() => {});
    return () => { live = false; };
  }, [assetId]);

  const asks = listings.map((row) => ({
    ...row,
    unitSats: (BigInt(row.priceSats) * 100_000_000_000n + BigInt(row.amountAtoms) - 1n) / BigInt(row.amountAtoms),
  })).sort((a, b) => a.unitSats < b.unitSats ? -1 : a.unitSats > b.unitSats ? 1 : 0);
  const maxAtoms = asks.reduce((largest, row) => BigInt(row.amountAtoms) > largest ? BigInt(row.amountAtoms) : largest, 1n);

  return <section className="panel px-6 py-8 sm:px-10">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <p className="eyebrow">Market</p>
      <Link href="/market" className="text-label uppercase tracking-label text-bone-dim hover:text-signal">View all orders →</Link>
    </div>
    <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-5">
      <Tile value={curveSats ? formatVaultSats(curveSats) : "—"} label="Curve price · 1,000" />
      <Tile value={totalSats ? formatVaultSats(totalSats) : "—"} label="Buy total · 1,000" />
      <Tile value={asks.length ? `${asks[0]!.unitSats.toLocaleString()} sats` : "—"} label="Lowest ask · 1,000" />
      <Tile value={String(asks.length)} label="Open asks" />
      <Tile value={candles.length ? `${candles.at(-1)!.close.toLocaleString()} sats` : "—"} label="Last trade · 1,000" />
    </div>
    <div className="mt-5 grid gap-px bg-rule lg:grid-cols-[1.9fr_1fr]">
      {candles.length ? <div className="min-w-0"><TokenChart ticker={ticker} candles={candles} interval={interval} onIntervalChange={setInterval} loading={chartLoading} className="border-0" /></div> : <div className="flex min-h-[420px] min-w-0 items-center justify-center border border-dashed border-rule bg-ink-3 px-6 text-center">
        <div>
          <p className="text-sm text-bone">No indexed price history yet</p>
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-bone-dim">The chart appears when confirmed trades with a recorded BTC value are indexed.</p>
        </div>
      </div>}
      <div className="bg-ink-3 px-5 py-4">
        <div className="flex items-center justify-between gap-3"><p className="eyebrow">Ask ladder</p><span className="text-label uppercase tracking-label text-bone-dim">{asks.length} listed</span></div>
        {asks.length === 0 ? <p className="mt-5 text-xs leading-relaxed text-bone-dim">No holder asks yet.</p> : <div className="mt-4 space-y-px">
          {asks.slice(0, 10).map((row) => <Link href="/market" key={row.id} className="group relative block overflow-hidden bg-ink-2 px-3 py-2.5 hover:bg-ink">
            <div className="absolute inset-y-0 right-0 bg-signal/10" style={{ width: `${Number(BigInt(row.amountAtoms) * 100n / maxAtoms)}%` }} />
            <div className="relative flex items-center justify-between gap-3 text-xs">
              <span className="tabular-nums text-bone">{row.unitSats.toLocaleString()} sats / 1,000</span>
              <span className="tabular-nums text-bone-dim">{formatAtoms(row.amountAtoms)}</span>
            </div>
          </Link>)}
        </div>}
      </div>
    </div>
  </section>;
}
