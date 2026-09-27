"use client";

import { useLang, useT } from "@/i18n/LanguageProvider";
import type { Lang } from "@/i18n";
import { fmtInt, fmtBtc } from "@/lib/format";

/**
 * Settled sales for a token: a scatter of recent fill sizes and the ledger of
 * confirmed trades beneath it.
 *
 * Every row is a real Bitcoin transaction. The txid is shown rather than hidden
 * behind a label, because the whole claim of this product is that a reader can
 * go and check.
 */

export interface Sale {
  txid: string;
  blockHeight: string;
  at: string;
  amountTokens: number;
  unitPriceSats: number;
  totalPriceSats: string;
}

function when(iso: string, lang: Lang): string {
  const d = new Date(iso);
  return d.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Scatter of the most recent fills, sized by value. */
function Scatter({ sales }: { sales: Sale[] }) {
  const t = useT();
  const { lang } = useLang();
  const pts = sales.slice(0, 120).reverse();
  if (pts.length < 2) return null;
  const vals = pts.map((s) => Number(s.totalPriceSats));
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;

  return (
    <div className="relative h-40 border border-rule bg-ink px-2 pb-6 pt-3">
      <div className="flex h-full items-end gap-[3px]">
        {pts.map((s, i) => {
          const v = Number(s.totalPriceSats);
          const h = 6 + ((v - min) / span) * 88;
          return (
            <div key={s.txid + i} className="group relative flex-1" style={{ height: "100%" }}>
              <span
                className="absolute left-1/2 w-px -translate-x-1/2 bg-rule-bright"
                style={{ bottom: 0, height: `${h}%` }}
                aria-hidden
              />
              <span
                className="absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-signal transition-transform group-hover:scale-150"
                style={{ bottom: `calc(${h}% - 3px)` }}
                title={t("sales.tokensTitle", { n: fmtInt(s.amountTokens), btc: fmtBtc(BigInt(s.totalPriceSats)) })}
              />
            </div>
          );
        })}
      </div>
      <div className="absolute inset-x-2 bottom-1.5 flex justify-between text-label uppercase tracking-label text-bone-dim">
        <span>{when(pts[0]!.at, lang)}</span>
        <span>{t("sales.latest", { n: pts.length })}</span>
        <span>{when(pts[pts.length - 1]!.at, lang)}</span>
      </div>
    </div>
  );
}

export function SalesFeed({ sales, explorerBase }: { sales: Sale[]; explorerBase?: string }) {
  const t = useT();
  const { lang } = useLang();
  if (sales.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-14 text-center text-sm text-bone-dim">
        {t("sales.none")}
      </div>
    );
  }
  const shown = sales.slice(0, 40);
  return (
    <div>
      <Scatter sales={sales} />
      <div className="mt-5 flex items-baseline justify-between">
        <p className="eyebrow">{t("sales.title")}</p>
        <span className="text-label uppercase tracking-label text-bone-dim">
          {t("sales.ofTotal", { a: fmtInt(shown.length), b: fmtInt(sales.length) })}
        </span>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="ledger-table min-w-[44rem]">
          <thead>
            <tr>
              <th>{t("sales.time")}</th>
              <th>{t("sales.tx")}</th>
              <th>{t("sales.tokens")}</th>
              <th>{t("sales.unit")}</th>
              <th>{t("sales.total")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.txid} className="transition-colors hover:bg-ink-3">
                <td className="whitespace-nowrap text-bone-dim">{when(s.at, lang)}</td>
                <td className="hex">
                  {explorerBase ? (
                    <a
                      href={`${explorerBase}/tx/${s.txid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-bone-dim underline decoration-rule-bright underline-offset-2 hover:text-signal"
                    >
                      {s.txid.slice(0, 10)}…{s.txid.slice(-6)}
                    </a>
                  ) : (
                    <>
                      {s.txid.slice(0, 10)}…{s.txid.slice(-6)}
                    </>
                  )}
                </td>
                <td className="whitespace-nowrap text-bone-2">{fmtInt(s.amountTokens)}</td>
                <td className="whitespace-nowrap text-bone">{fmtInt(Math.round(s.unitPriceSats))}</td>
                <td className="whitespace-nowrap text-bone-2">{fmtBtc(BigInt(s.totalPriceSats))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
