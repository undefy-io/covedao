"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useIndexedBlock } from "@/lib/use-indexed-block";
import { TokenCard, type V3TokenCardData } from "@/components/TokenCard";
import { Tile } from "@/components/Tile";
import { PUBLIC_SUPPLY_TOKENS, TEAM_ALLOCATION_TOKENS, CREATOR_PREMINE_TOKENS, getTheoreticalFullRaise } from "@crclaunch/curve";

/** 21000000n → "21M". Computed from the curve so the numbers cannot go stale. */
function fmtCompact(n: bigint): string {
  if (n >= 1_000_000n) return `${Number(n) / 1_000_000}M`;
  if (n >= 1_000n) return `${Number(n) / 1_000}K`;
  return n.toString();
}
import { useSparklines } from "@/lib/use-sparklines";
import { useT } from "@/i18n/LanguageProvider";

/**
 * The hero states the protocol's actual claim rather than a slogan: state is
 * committed on-chain and the reader can reproduce it. The numbers under it are
 * frozen protocol constants, so the first thing a visitor sees is something
 * verifiable instead of a promise.
 */
export default function HomePage() {
  const [tokens, setTokens] = useState<V3TokenCardData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const t = useT();
  // Refetch when a new block is indexed.
  const block = useIndexedBlock();

  useEffect(() => {
    void fetch("/api/v3/tokens?limit=9")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setTokens(j.data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [block]);

  const { series } = useSparklines(
    tokens.map((t) => ({ tokenId: t.tokenId, ticker: t.ticker, curveStage: t.curveStage })),
    false,
  );

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-14 sm:px-10 sm:py-20">
        <Image src="/logo.png" alt="covs" width={72} height={72} priority className="mb-6 h-16 w-16 sm:h-[72px] sm:w-[72px]" />
        <p className="eyebrow">{t("home.eyebrow")}</p>
        <h1 className="mt-5 max-w-3xl text-display text-bone">
          {t("home.title1")}
          <br />
          {t("home.title2")}
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-relaxed text-bone-dim">
          {t("home.pitch1")}
          <br />
          {t("home.pitch2")}
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/launch" className="btn">{t("home.ctaLaunch")}</Link>
          <Link href="/explore" className="btn-ghost">{t("home.ctaExplore")}</Link>
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.rules")}</p>
        <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile value={fmtCompact(PUBLIC_SUPPLY_TOKENS)} label={t("home.totalSupply")} />
          <Tile value={fmtCompact(TEAM_ALLOCATION_TOKENS + CREATOR_PREMINE_TOKENS)} label={t("home.teamTokens")} />
          <Tile value="50%" label={t("home.creatorShare")} />
          <Tile value={`${(Number(getTheoreticalFullRaise()) / 1e8).toFixed(3)} BTC`} label={t("home.vaultAtMintOut")} />
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">{t("home.recent")}</p>
          <Link href="/explore" className="text-label uppercase tracking-label text-bone-dim hover:text-signal">
            {t("home.viewAll")}
          </Link>
        </div>
        <div className="mt-5">
          {!loaded ? (
            <Empty message={t("common.readingChain")} />
          ) : tokens.length === 0 ? (
            <Empty message={t("home.noTokens")} />
          ) : (
            <div className="grid gap-px bg-rule sm:grid-cols-2 lg:grid-cols-3">
              {tokens.map((t) => (
                <TokenCard key={t.tokenId} token={t} spark={series[t.tokenId] ?? []} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.how")}</p>
        <ol className="mt-6 grid gap-px bg-rule sm:grid-cols-3">
          <Step n="01" title={t("home.step1Title")} body={t("home.step1Body")} />
          <Step n="02" title={t("home.step2Title")} body={t("home.step2Body")} />
          <Step n="03" title={t("home.step3Title")} body={t("home.step3Body")} />
        </ol>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">{t("home.enforces")}</p>
        <div className="mt-5 grid gap-px bg-rule md:grid-cols-2">
          <Boundary
            kind="verified"
            chip={t("home.consensus")}
            heading={t("home.consensusHeading")}
            items={[t("home.consensus1"), t("home.consensus2"), t("home.consensus3")]}
          />
          <Boundary
            kind="pending"
            chip={t("home.policy")}
            heading={t("home.guardianHeading")}
            items={[t("home.guardian1"), t("home.guardian2"), t("home.guardian3")]}
          />
        </div>
        <p className="mt-6 max-w-2xl text-xs leading-relaxed text-bone-dim">{t("home.honest")}</p>
      </section>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="bg-ink-3 px-5 py-5">
      <span className="text-label tracking-label text-signal">{n}</span>
      <div className="mt-2 text-sm text-bone">{title}</div>
      <p className="mt-2 text-xs leading-relaxed text-bone-dim">{body}</p>
    </li>
  );
}

function Boundary({
  kind,
  chip: chipLabel,
  heading,
  items,
}: {
  kind: "verified" | "pending";
  chip: string;
  heading: string;
  items: string[];
}) {
  const chip = kind === "verified" ? "chip chip-verified" : "chip chip-pending";
  return (
    <div className="bg-ink-3 px-5 py-5">
      <span className={chip}>{chipLabel}</span>
      <div className="mt-3 text-sm text-bone">{heading}</div>
      <ul className="mt-3 space-y-2">
        {items.map((t) => (
          <li key={t} className="flex gap-2 text-xs leading-relaxed text-bone-dim">
            <span className="mt-[0.45rem] h-px w-2.5 shrink-0 bg-rule-bright" />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-rule px-6 py-14 text-center text-sm text-bone-dim">
      {message}
    </div>
  );
}
