"use client";

import { useT } from "@/i18n/LanguageProvider";
import { fmtInt, fmtBtc } from "@/lib/format";

/**
 * The header strip above a token's chart: floor, last, market cap, volume,
 * range, and who has been trading.
 *
 * Every figure comes from the same settled fills the candles are built from, so
 * the header and the chart can never tell different stories. Prices are sats —
 * quoting dollars would mean depending on an exchange-rate feed that nothing
 * else in the product needs.
 */

export interface MarketSummary {
  floorSats: number | null;
  lastPriceSats: number | null;
  change24hPct: number | null;
  marketCapSats: number | null;
  volume7dSats: string;
  volume7dChangePct: number | null;
  highSats: number | null;
  lowSats: number | null;
  trades: number;
  buyers: number;
}

function Pct({ value }: { value: number | null }) {
  if (value === null) return null;
  const up = value >= 0;
  return (
    <span className={up ? "text-verified" : "text-rejected"}>
      {up ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "up" | "down";
}) {
  const color = tone === "up" ? "text-verified" : tone === "down" ? "text-rejected" : "text-bone";
  return (
    <div className="flex flex-1 shrink-0 basis-auto items-baseline gap-2 whitespace-nowrap bg-ink-3 px-4 py-2.5">
      <span className="text-label uppercase tracking-label text-bone-dim">{label}</span>
      <span className={`tabular-nums ${color}`}>{value}</span>
      {sub ? <span className="text-label tabular-nums">{sub}</span> : null}
    </div>
  );
}

export function MarketStats({ s }: { s: MarketSummary }) {
  const t = useT();
  const dash = "—";
  const up24 = (s.change24hPct ?? 0) >= 0;
  return (
    <div className="flex flex-wrap items-center gap-x-px gap-y-px bg-rule text-sm">
      <Cell
        label={t("mkt.floor")}
        value={s.floorSats === null ? dash : fmtInt(Math.round(s.floorSats))}
        tone={s.floorSats === null ? undefined : "up"}
      />
      <Cell
        label={t("mkt.lastShort")}
        value={s.lastPriceSats === null ? dash : fmtInt(Math.round(s.lastPriceSats))}
        sub={<Pct value={s.change24hPct} />}
        tone={s.lastPriceSats === null ? undefined : up24 ? "up" : "down"}
      />
      <Cell
        label={t("mkt.mcap")}
        value={s.marketCapSats === null ? dash : fmtBtc(BigInt(s.marketCapSats))}
      />
      <Cell
        label={t("mkt.vol7d")}
        value={fmtBtc(BigInt(s.volume7dSats))}
        sub={<Pct value={s.volume7dChangePct} />}
      />
      <Cell label={t("mkt.high")} value={s.highSats === null ? dash : fmtInt(Math.round(s.highSats))} />
      <Cell label={t("mkt.low")} value={s.lowSats === null ? dash : fmtInt(Math.round(s.lowSats))} />
      <Cell
        label={t("mkt.trades")}
        value={fmtInt(s.trades)}
        sub={<span className="text-bone-dim">{t("mkt.buyers", { n: fmtInt(s.buyers) })}</span>}
      />
    </div>
  );
}
