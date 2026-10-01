"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { TokenImage } from "./TokenImage";
import { Tile } from "./Tile";
import { Sparkline } from "./Sparkline";
import { useT } from "@/i18n/LanguageProvider";

const capAtoms = 2_100_000_000_000_000n;

export type CrcToken = {
  assetId: string;
  ticker: string;
  deployHeight: string;
  mintedAtoms: string;
  circulatingAtoms: string;
  availability: "active" | "unavailable";
  vault: { btcSats: string };
  metadata: { displayName: string; description: string; websiteUrl: string | null; xUrl: string | null; imageUrl: string | null };
};

type Catalog = {
  indexedTip: { height: string; blockHash: string } | null;
  tokens: CrcToken[];
  nextCursor: string | null;
};

export function CrcHome() {
  const t = useT();
  const [items, setItems] = useState<CrcToken[]>([]);
  const [tip, setTip] = useState<Catalog["indexedTip"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(before?: string) {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ limit: "24" });
      if (before) query.set("before", before);
      const response = await fetch(`/api/crc/v1/tokens?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error?.message ?? t("crc.home.loadError"));
      const data = body.data as Catalog;
      setItems((previous) => before ? [...previous, ...data.tokens] : data.tokens);
      setTip(data.indexedTip);
      setCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("crc.home.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-14 sm:px-10 sm:py-20">
        <Image src="/logo.png" alt="covs" width={72} height={72} priority className="mb-6 h-16 w-16 sm:h-[72px] sm:w-[72px]" />
        <p className="eyebrow">{t("home.eyebrow")}</p>
        <h1 className="mt-5 max-w-3xl text-display text-bone">
          {t("crc.home.title1")}<br />{t("crc.home.title2")}
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-relaxed text-bone-dim">{t("crc.home.pitch")}</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/launch" className="btn">{t("home.ctaLaunch")}</Link>
          <Link href="/explore" className="btn-ghost">{t("home.ctaExplore")}</Link>
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.rules")}</p>
        <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile value="21M" label={t("crc.home.supply")} />
          <Tile value="1,000" label={t("crc.home.lot")} />
          <Tile value="BTC" label={t("crc.home.backing")} />
          <Tile value="50%" label={t("crc.home.creator")} help={t("crc.home.creatorHelp")} />
        </div>
      </section>

      <section id="tokens" className="panel scroll-mt-20 px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="eyebrow">{t("home.recent")}</p>
          <div className="flex flex-wrap items-baseline gap-4">
            {tip && <span className="text-label uppercase tracking-label text-bone-dim">{t("crc.home.indexed", { height: tip.height })}</span>}
            <Link href="/explore" className="text-label uppercase tracking-label text-bone-dim hover:text-signal">{t("home.viewAll")}</Link>
          </div>
        </div>
        <div className="mt-5">
          {error && <p role="alert" className="border border-rejected/40 px-5 py-4 text-sm text-rejected">{error}</p>}
          {items.length > 0 ? (
            <div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
              {items.map((token) => <CrcTokenCard key={token.assetId} token={token} />)}
            </div>
          ) : !error && (
            <p className="border border-dashed border-rule px-6 py-14 text-center text-sm text-bone-dim">
              {loading ? t("common.readingChain") : t("home.noTokens")}
            </p>
          )}
        </div>
        {cursor && <button className="btn-ghost mt-5" disabled={loading} onClick={() => void load(cursor)}>{t("crc.home.more")}</button>}
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.how")}</p>
        <ol className="mt-6 grid gap-px bg-rule sm:grid-cols-3">
          <Step n="01" title={t("crc.home.step1")} body={t("crc.home.step1Body")} />
          <Step n="02" title={t("crc.home.step2")} body={t("crc.home.step2Body")} />
          <Step n="03" title={t("crc.home.step3")} body={t("crc.home.step3Body")} />
        </ol>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.enforces")}</p>
        <div className="mt-5 grid gap-px bg-rule md:grid-cols-2">
          <Boundary kind="consensus" chip={t("home.consensus")} heading={t("home.consensusHeading")}
            items={[t("crc.home.bitcoin1"), t("crc.home.bitcoin2")]} />
          <Boundary kind="policy" chip={t("home.policy")} heading={t("crc.home.policyHeading")}
            items={[t("crc.home.policy1"), t("crc.home.policy2")]} />
        </div>
      </section>
    </div>
  );
}

export function CrcTokenCard({ token }: { token: CrcToken }) {
  const t = useT();
  const minted = BigInt(token.mintedAtoms);
  const pct = Number(minted * 100n / capAtoms);
  return (
    <Link href={`/token/${encodeURIComponent(token.assetId)}`} className="group block min-w-0 bg-ink-3 px-5 py-5 transition-colors hover:bg-ink-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <TokenImage tokenId={token.assetId} ticker={token.ticker} imageUrl={token.metadata?.imageUrl} />
          <div className="min-w-0">
            <div className="truncate text-sm text-bone group-hover:text-signal">{token.metadata?.displayName ?? token.ticker} <span className="text-bone-dim">${token.ticker}</span></div>
            <div className="mt-0.5 truncate text-xs text-bone-dim">{t("crc.home.block", { height: token.deployHeight })}</div>
          </div>
        </div>
        <span className={token.availability === "active" ? "chip chip-verified shrink-0" : "chip chip-pending shrink-0"}>
          {token.availability === "active" ? t("common.open") : t("crc.home.unavailable")}
        </span>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-label uppercase tracking-label text-bone-dim">{t("card.last")}</div>
          <div className="mt-1 text-lg tabular-nums text-bone">—</div>
        </div>
        <Sparkline values={[]} label={t("common.recentPrice", { ticker: token.ticker })} />
      </div>
      <div className="mt-4">
        <div className="h-1 w-full bg-rule"><div className="h-1 bg-signal" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
        <div className="mt-2 flex justify-between text-label uppercase tracking-label text-bone-dim">
          <span>{formatAtoms(token.mintedAtoms)}</span><span>21M</span>
        </div>
      </div>
      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-bone-dim">{t("card.backing")}</dt><dd className="tabular-nums text-bone-2">{formatVaultSats(token.vault.btcSats)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-bone-dim">{t("crc.home.circulating")}</dt><dd className="tabular-nums text-bone-2">{formatAtoms(token.circulatingAtoms)}</dd></div>
      </dl>
      <div className="hex mt-4 truncate border-t border-rule pt-3">{token.assetId.slice(0, 24)}…</div>
    </Link>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return <li className="bg-ink-3 px-5 py-5">
    <span className="text-label tracking-label text-signal">{n}</span>
    <div className="mt-2 text-sm text-bone">{title}</div>
    <p className="mt-2 text-xs leading-relaxed text-bone-dim">{body}</p>
  </li>;
}

function Boundary({ kind, chip, heading, items }: { kind: "consensus" | "policy"; chip: string; heading: string; items: string[] }) {
  return <div className="bg-ink-3 px-5 py-5">
    <span className={kind === "consensus" ? "chip chip-verified" : "chip chip-pending"}>{chip}</span>
    <div className="mt-3 text-sm text-bone">{heading}</div>
    <ul className="mt-3 space-y-2">{items.map((item) => <li key={item} className="flex gap-2 text-xs leading-relaxed text-bone-dim">
      <span className="mt-[0.45rem] h-px w-2.5 shrink-0 bg-rule-bright" />{item}
    </li>)}</ul>
  </div>;
}

export function formatAtoms(atoms: string): string {
  const value = BigInt(atoms);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

export function formatVaultSats(sats: string): string {
  const value = BigInt(sats);
  return value < 100_000n ? `${value.toLocaleString()} sats` : `${(Number(value) / 1e8).toFixed(5)} BTC`;
}
