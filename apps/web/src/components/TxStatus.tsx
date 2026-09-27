"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useEffect, useState } from "react";

/**
 * What happened to the transaction the user just signed.
 *
 * Broadcasting used to end the story: a txid appeared and nothing ever
 * updated. A transaction can sit unconfirmed for a long time, and it can be
 * dropped from the mempool entirely — in which case the trade never happened
 * and the user needs to know rather than assume. The backend already tracks
 * both; this just says so.
 */

interface TxState {
  txid: string;
  mempool: boolean;
  confirmedHeight: string | null;
  session: { status: string; errorCode: string | null } | null;
}

export function TxStatus({ txid, explorerBase }: { txid: string; explorerBase?: string }) {
  const [state, setState] = useState<TxState | null>(null);
  const t = useT();

  useEffect(() => {
    if (!txid) return;
    let live = true;
    const poll = () => {
      void fetch(`/api/v3/tx/${txid}`)
        .then((r) => r.json())
        .then((j) => {
          if (live && j.ok) setState(j.data as TxState);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [txid]);

  if (!txid) return null;

  const confirmed = state?.confirmedHeight != null;
  const dropped = state != null && !confirmed && !state.mempool;

  const chip = confirmed ? "chip chip-verified" : dropped ? "chip chip-rejected" : "chip chip-pending";
  const label = confirmed ? t("tx.confirmed") : dropped ? t("tx.dropped") : t("tx.mempool");
  const detail = confirmed
    ? t("tx.settled", { height: state!.confirmedHeight! })
    : dropped
      ? t("tx.droppedDetail")
      : t("tx.waitingDetail");

  return (
    <div className="mt-4 border border-rule bg-ink-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={chip}>{label}</span>
        {explorerBase ? (
          <a
            href={`${explorerBase}/tx/${txid}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-label uppercase tracking-label text-bone-dim hover:text-signal"
          >
            {t("tx.viewExplorer")}
          </a>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-bone-dim">{detail}</p>
      <p className="hex mt-2">{txid}</p>
    </div>
  );
}
