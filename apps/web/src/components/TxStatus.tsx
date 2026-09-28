"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useEffect, useState } from "react";

interface TxState {
  txid: string;
  mempool: boolean | null;
  state: "confirmed" | "pending" | "mined" | "unknown" | "conflicted";
  confirmedHeight: string | null;
  session: { status: string } | null;
}

export function TxStatus({ txid, explorerBase }: { txid: string; explorerBase?: string }) {
  const [state, setState] = useState<TxState | null>(null);
  const t = useT();

  useEffect(() => {
    if (!txid) return;
    let live = true;
    setState(null);
    const unknown: TxState = { txid, mempool: null, state: "unknown", confirmedHeight: null, session: null };
    const poll = () => {
      void fetch(`/api/v3/tx/${txid}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          if (live) setState(j.ok ? j.data as TxState : unknown);
        })
        .catch(() => { if (live) setState(unknown); });
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
  const unknown = !state || state.state === "unknown";
  const conflicted = state?.state === "conflicted";
  const mined = state?.state === "mined";

  const chip = confirmed ? "chip chip-verified" : "chip chip-pending";
  const label = conflicted ? t("tx.conflicted") : confirmed ? t("tx.confirmed") : unknown ? t("tx.unknown") : mined ? t("tx.mined") : t("tx.mempool");
  const detail = conflicted ? t("tx.conflictedDetail") : confirmed
    ? t("tx.settled", { height: state!.confirmedHeight! })
    : unknown
      ? t("tx.unknownDetail")
      : mined ? t("tx.minedDetail")
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
