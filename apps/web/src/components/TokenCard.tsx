"use client";

import Link from "next/link";
import { fmtBtc, fmtTokens, fmtInt } from "@/lib/format";
import { Sparkline } from "./Sparkline";
import { TokenImage } from "./TokenImage";
import { useT } from "@/i18n/LanguageProvider";

export interface V3TokenCardData {
  tokenId: string;
  ticker: string;
  displayName: string;
  description: string;
  deployHeight: string | number;
  issuedSupplyAtoms: string | number | bigint;
  publicCapAtoms: string | number | bigint;
  backingSats: string | number | bigint;
  curveStage: number;
  holderCount: number;
  bestAskSats: string | null;
  imageUrl?: string | null;
  /** Public cap fully minted. Derived server-side; see V3TokenSummary. */
  graduated?: boolean;
}

export function TokenCard({
  token,
  spark = [],
}: {
  token: V3TokenCardData;
  /** Recent closes, sats per 1,000 tokens. Empty when the token has not traded. */
  spark?: number[];
}) {
  const t = useT();
  const issued = BigInt(token.issuedSupplyAtoms);
  const cap = BigInt(token.publicCapAtoms);
  const graduated = token.graduated ?? issued >= cap;
  const pct = cap > 0n ? Number((issued * 100n) / cap) : 0;

  return (
    <Link
      href={`/token/${token.tokenId}`}
      className="group block bg-ink-3 px-5 py-5 transition-colors hover:bg-ink-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <TokenImage tokenId={token.tokenId} ticker={token.ticker} imageUrl={token.imageUrl} />
          <div className="min-w-0">
            <div className="truncate text-sm text-bone transition-colors group-hover:text-signal">
              {token.ticker}
            </div>
            <div className="mt-0.5 truncate text-xs text-bone-dim">{token.displayName}</div>
          </div>
        </div>
        <span className={graduated ? "chip chip-signal shrink-0" : "chip chip-verified shrink-0"}>
          {graduated ? t("common.graduated") : t("common.open")}
        </span>
      </div>

      {/* Market price and its recent shape. A token that has never traded shows
          the label without a number rather than a zero, which would read as a
          real price of nothing. */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-label uppercase tracking-label text-bone-dim">{t("card.last")}</div>
          <div className="mt-1 text-lg tabular-nums text-bone">
            {spark.length > 0 ? fmtInt(Math.round(spark[spark.length - 1]!)) : "—"}
          </div>
        </div>
        <Sparkline values={spark} label={t("common.recentPrice", { ticker: token.ticker })} />
      </div>

      {/* Progress against the public cap — the one number deciding whether this
          token is still mintable, so it gets a bar rather than a row. */}
      <div className="mt-4">
        <div className="h-1 w-full bg-rule">
          <div className="h-1 bg-signal" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-label uppercase tracking-label text-bone-dim">
          <span>{fmtTokens(issued)}</span>
          <span>{fmtTokens(cap)}</span>
        </div>
      </div>

      <dl className="mt-4 space-y-1.5 text-xs">
        <Row label={t("card.backing")} value={fmtBtc(BigInt(token.backingSats))} />
        <Row label={t("card.stage")} value={`${token.curveStage} / 210`} />
        <Row label={t("card.holders")} value={String(token.holderCount)} />
        {token.bestAskSats ? <Row label={t("card.bestAsk")} value={fmtBtc(BigInt(token.bestAskSats))} /> : null}
      </dl>

      <div className="hex mt-4 truncate border-t border-rule pt-3">
        {token.tokenId.slice(0, 24)}…
      </div>
    </Link>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-bone-dim">{label}</dt>
      <dd className="tabular-nums text-bone-2">{value}</dd>
    </div>
  );
}
