"use client";

import { useStatusSnapshot } from "@/lib/use-indexed-block";
import { useT } from "@/i18n/LanguageProvider";
import type { MessageKey } from "@/i18n";
import { useEffect, useState } from "react";

/**
 * Bitcoin miner-fee speed.
 *
 * Every build used to send a flat 1,000 sats. A backing buy is 370–440
 * vbytes, so that was roughly 2 sat/vB: enough on a quiet chain, and below
 * the relay floor on a busy one, where the transaction simply never confirms.
 * The rates here come from the node itself, and the server sizes the fee to
 * the transaction it actually builds.
 */

export interface FeeTier {
  key: "eco" | "standard" | "priority";
  label: string;
  blocks: number;
  satPerVb: string;
}

export interface FeeRatesResponse {
  maxMinerFeeSats: string;
  floorSatPerVb: string;
  ceilingSatPerVb: string;
  estimated: boolean;
  tiers: FeeTier[];
  /** Typical vbyte size per operation, for previewing a fee before building. */
  typicalVsize: Record<"DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER", number>;
}

export function affordableFeeTier(
  rates: FeeRatesResponse,
  selected: FeeTier["key"],
): FeeTier | null {
  const maxVsize = BigInt(Math.max(...Object.values(rates.typicalVsize)));
  const affordable = rates.tiers.filter(
    (tier) => BigInt(tier.satPerVb) * maxVsize <= BigInt(rates.maxMinerFeeSats),
  );
  return affordable.find((tier) => tier.key === selected) ?? affordable[0] ?? null;
}

export function useFeeRates() {
  const snapshot = useStatusSnapshot();
  const feeRevision = `${snapshot.status?.observations?.feesObservedAt}:${snapshot.available}:${snapshot.feesAvailable}:${snapshot.resumeRevision}`;
  const [rates, setRates] = useState<FeeRatesResponse | null>(null);
  const [selected, setSelected] = useState<FeeTier["key"]>("standard");

  useEffect(() => {
    let live = true;
    const load = () => {
      void fetch("/api/v3/fees")
        .then((r) => r.json())
        .then((j) => {
          if (live) setRates(j.ok ? (j.data as FeeRatesResponse) : null);
        })
        .catch(() => {
          if (live) setRates(null);
        });
    };
    load();
    // The relay floor climbs as the mempool fills; a stale rate is the exact
    // thing that strands a transaction.
    return () => {
      live = false;
    };
  }, [feeRevision]);

  const tier = rates ? affordableFeeTier(rates, selected) : null;

  /**
   * A preview of the miner fee, never the real one. The server sizes the fee
   * against the transaction it actually builds, so this is marked "≈" wherever
   * it is shown.
   */
  const previewFeeSats = (op: keyof FeeRatesResponse["typicalVsize"]): bigint | null => {
    if (!rates || !tier) return null;
    return BigInt(tier.satPerVb) * BigInt(rates.typicalVsize[op] ?? 0);
  };

  return {
    rates,
    selected: tier?.key ?? selected,
    setSelected,
    satPerVb: tier?.satPerVb ?? null,
    previewFeeSats,
  };
}

export function FeePicker({
  rates,
  selected,
  onSelect,
  vsizeHint,
}: {
  rates: FeeRatesResponse | null;
  selected: FeeTier["key"];
  onSelect: (key: FeeTier["key"]) => void;
  /** Rough size of the transaction, used only to preview the fee in sats. */
  vsizeHint?: number;
}) {
  const t = useT();
  if (!rates) {
    return (
      <div className="border border-rule bg-ink-3 px-3 py-2.5 text-xs text-bone-dim">
        {t("fee.reading")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{t("fee.title")}</span>
        {rates.estimated ? (
          <span className="text-label uppercase tracking-label text-pending">
            {t("fee.estimated")}
          </span>
        ) : (
          <span className="text-label uppercase tracking-label text-bone-dim">
            {t("fee.floor", { n: rates.floorSatPerVb })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-px bg-rule">
        {rates.tiers.map((tier) => {
          const active = tier.key === selected;
          const preview = vsizeHint ? BigInt(tier.satPerVb) * BigInt(Math.ceil(vsizeHint)) : null;
          const unaffordable = preview !== null && preview > BigInt(rates.maxMinerFeeSats);
          return (
            <button
              key={tier.key}
              type="button"
              onClick={() => onSelect(tier.key)}
              disabled={unaffordable}
              aria-pressed={active}
              className={`px-3 py-2.5 text-left transition-colors ${
                active
                  ? "bg-signal/10 text-bone"
                  : unaffordable
                    ? "bg-ink-3 text-bone-dim opacity-50 cursor-not-allowed"
                    : "bg-ink-3 text-bone-dim hover:bg-ink-2"
              }`}
            >
              <div className={`text-sm ${active ? "text-signal" : ""}`}>
                {t(`fee.${tier.key}` as MessageKey)}
              </div>
              <div className="mt-1 text-label uppercase tracking-label tabular-nums">
                {tier.satPerVb} sat/vB
              </div>
              <div className="mt-0.5 text-label tabular-nums text-bone-dim">
                {unaffordable
                  ? t("fee.aboveCap")
                  : preview !== null
                    ? `≈${preview.toLocaleString()} sats`
                    : t("fee.blocks", { n: tier.blocks })}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
