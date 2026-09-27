"use client";

import { useT } from "@/i18n/LanguageProvider";
import type { MessageKey } from "@/i18n";
import { useEffect, useState } from "react";
import { fmtBtc, fmtInt, fmtTokens } from "@/lib/format";
import { unitPriceSats } from "@/lib/ohlc";

/** Rows shown at first, and per "Show more". */
const PAGE = 10;

/**
 * One token's confirmed history.
 *
 * The API has existed for a while with nothing rendering it. Every row here is
 * a settled Bitcoin transaction — the amounts are the ones the chain recorded,
 * not a projection — so this doubles as the thing a holder checks when they
 * want to know what actually happened to their trade.
 */

interface ActivityRow {
  txid: string;
  blockHeight: string;
  operation: string | null;
  valid: boolean;
  reason: string | null;
  amountAtoms: string | null;
  grossSats: string | null;
  feeSats: string | null;
  supplyAfterAtoms: string | null;
  backingAfterSats: string | null;
}

const LABEL: Record<string, MessageKey> = {
  DEPLOY: "hist.deploy",
  MINT: "hist.mint",
  REDEEM: "hist.redeem",
  TRANSFER: "hist.transfer",
};

export function TokenActivity({
  tokenId,
  ticker,
  explorerBase,
  demoRows,
  refreshKey,
}: {
  tokenId: string;
  ticker: string;
  explorerBase?: string;
  demoRows?: ActivityRow[];
  /** Changes when a new block is indexed; the history refetches. */
  refreshKey?: string;
}) {
  const t = useT();
  const [rows, setRows] = useState<ActivityRow[] | null>(demoRows ?? null);
  // The newest few by default; the rest one click away.
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (demoRows) return;
    void fetch(`/api/v3/tokens/${tokenId}/activity`)
      .then((r) => r.json())
      .then((j) => setRows(j.ok ? (j.data as ActivityRow[]) : []))
      .catch(() => setRows([]));
  }, [tokenId, demoRows, refreshKey]);

  return (
    <section className="panel px-6 py-8 sm:px-10">
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">{t("hist.title")}</p>
        <span className="text-label uppercase tracking-label text-bone-dim">
          {t("hist.confirmed")}
        </span>
      </div>

      {rows === null ? (
        <p className="mt-5 text-sm text-bone-dim">{t("hist.reading")}</p>
      ) : rows.length === 0 ? (
        <p className="mt-5 border border-dashed border-rule px-6 py-10 text-center text-sm text-bone-dim">
          {t("hist.empty")}
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="text-right">{t("hist.block")}</th>
                <th>{t("hist.what")}</th>
                <th className="text-right">{t("hist.amount")}</th>
                <th className="text-right">{t("hist.value")}</th>
                <th className="text-right">{t("hist.price1k")}</th>
                <th className="text-right">{t("hist.tx")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r) => {
                const isCurveTrade = r.grossSats !== null && r.amountAtoms !== null;
                const price = isCurveTrade
                  ? unitPriceSats(r.amountAtoms!, r.grossSats!)
                  : null;
                return (
                  <tr key={r.txid}>
                    <td className="text-right text-bone-dim">{fmtInt(r.blockHeight)}</td>
                    <td>
                      <span className={r.valid ? "text-bone" : "text-rejected"}>
                        {LABEL[r.operation ?? ""] ? t(LABEL[r.operation ?? ""]!) : r.operation ?? "—"}
                      </span>
                      {!r.valid && r.reason ? (
                        <span className="ml-2 text-label uppercase tracking-label text-rejected">
                          {t("hist.rejected")}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right">
                      {r.amountAtoms ? (
                        <>
                          {fmtTokens(r.amountAtoms)}{" "}
                          <span className="text-bone-dim">{ticker}</span>
                        </>
                      ) : (
                        <span className="text-bone-dim">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      {r.grossSats ? fmtBtc(r.grossSats) : <span className="text-bone-dim">—</span>}
                    </td>
                    <td className="text-right">
                      {price !== null ? (
                        `${price.toLocaleString()} sats`
                      ) : (
                        <span className="text-bone-dim">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      {explorerBase ? (
                        <a
                          href={`${explorerBase}/tx/${r.txid}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hex hover:text-signal"
                        >
                          {r.txid.slice(0, 12)}…
                        </a>
                      ) : (
                        <span className="hex">{r.txid.slice(0, 12)}…</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown ? (
            <button onClick={() => setShown((n) => n + PAGE)} className="btn-ghost mt-4 w-full">
              {t("hist.more", { n: fmtInt(rows.length - shown) })}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
