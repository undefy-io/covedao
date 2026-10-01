"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CrcMarketListing } from "@/lib/crc-market-client";
import { formatAtoms, formatVaultSats } from "./CrcHome";
import { Tile } from "./Tile";

export function CrcTokenMarket({ assetId }: { assetId: string }) {
  const [curveSats, setCurveSats] = useState<string | null>(null);
  const [totalSats, setTotalSats] = useState<string | null>(null);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      fetch("/api/crc/v1/backing/buy/quote", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId, amountAtoms: "100000000000" }),
      }).then((response) => response.json()),
      fetch(`/api/crc/v1/market/listings?deployTxid=${assetId.split(":")[1]}`, { cache: "no-store" }).then((response) => response.json()),
    ]).then(([curve, market]) => {
      if (!live) return;
      if (curve.ok && curve.data?.quote) {
        setCurveSats(curve.data.quote.grossSats);
        setTotalSats(curve.data.quote.buyerTotalSats);
      }
      if (market.ok && Array.isArray(market.data?.listings)) {
        setListings((market.data.listings as CrcMarketListing[]).filter((row) =>
          row.status === "OPEN" && `${row.network}:${row.deployTxid}` === assetId));
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [assetId]);

  const lowest = listings.reduce<bigint | null>((price, row) => {
    const unit = (BigInt(row.priceSats) * 100_000_000_000n + BigInt(row.amountAtoms) - 1n) / BigInt(row.amountAtoms);
    return price === null || unit < price ? unit : price;
  }, null);
  return <section className="panel px-6 py-8 sm:px-10">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <p className="eyebrow">Market</p>
      <Link href="/crc/market" className="text-label uppercase tracking-label text-bone-dim hover:text-signal">View all orders →</Link>
    </div>
    <div className="mt-5 grid grid-cols-1 gap-px bg-rule sm:grid-cols-3">
      <Tile size="md" value={curveSats ? formatVaultSats(curveSats) : "—"} label="Curve backing · 1,000 tokens" />
      <Tile size="md" value={totalSats ? formatVaultSats(totalSats) : "—"} label="Buy total · before miner fee" />
      <Tile size="md" value={lowest === null ? "—" : `${lowest.toLocaleString()} sats`} label="Lowest ask · per 1,000" />
    </div>
    <div className="mt-6 flex items-baseline justify-between gap-3">
      <p className="eyebrow">Open holder asks</p>
      <span className="text-label uppercase tracking-label text-bone-dim">{listings.length} listed</span>
    </div>
    {listings.length === 0 ? <p className="mt-4 border border-dashed border-rule px-6 py-8 text-center text-sm text-bone-dim">No holder asks yet. Curve trading is available below.</p>
      : <div className="mt-4 overflow-x-auto"><table className="ledger-table min-w-[32rem]"><thead><tr>
        <th>Seller</th><th className="text-right">Tokens</th><th className="text-right">Ask</th><th className="text-right">Action</th>
      </tr></thead><tbody>{listings.slice(0, 8).map((row) => <tr key={row.id}>
        <td className="hex">{row.sellerAnchorTxid.slice(0, 12)}…</td>
        <td className="text-right tabular-nums">{formatAtoms(row.amountAtoms)}</td>
        <td className="text-right tabular-nums">{formatVaultSats(String(row.priceSats))}</td>
        <td className="text-right"><Link href="/crc/market" className="text-signal hover:underline">Review →</Link></td>
      </tr>)}</tbody></table></div>}
  </section>;
}
