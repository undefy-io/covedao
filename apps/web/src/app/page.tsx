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

/**
 * The hero states the protocol's actual claim rather than a slogan: state is
 * committed on-chain and the reader can reproduce it. The numbers under it are
 * frozen protocol constants, so the first thing a visitor sees is something
 * verifiable instead of a promise.
 */
export default function HomePage() {
  const [tokens, setTokens] = useState<V3TokenCardData[]>([]);
  const [loaded, setLoaded] = useState(false);
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
        <p className="eyebrow">covs.trade · CRC-20 · Bitcoin L1</p>
        <h1 className="mt-5 max-w-3xl text-display text-bone">
          Covenant-powered
          <br />
          CRC launchpad.
        </h1>
        <p className="mt-6 max-w-xl text-sm leading-relaxed text-bone-dim">
          The first fair-launch bonding curve on Bitcoin.
          <br />
          Mint as the price climbs. Sell back to the vault anytime.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/launch" className="btn">Launch a token</Link>
          <Link href="/explore" className="btn-ghost">Explore</Link>
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">Every token, same rules</p>
        <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Tile value={fmtCompact(PUBLIC_SUPPLY_TOKENS)} label="Total supply" />
          <Tile value={fmtCompact(TEAM_ALLOCATION_TOKENS + CREATOR_PREMINE_TOKENS)} label="Team tokens" />
          <Tile value="50%" label="Of each mint to the creator" />
          <Tile value={`${(Number(getTheoreticalFullRaise()) / 1e8).toFixed(3)} BTC`} label="In the vault at mint-out" />
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">Recent launches</p>
          <Link href="/explore" className="text-label uppercase tracking-label text-bone-dim hover:text-signal">
            View all →
          </Link>
        </div>
        <div className="mt-5">
          {!loaded ? (
            <Empty message="Reading the chain…" />
          ) : tokens.length === 0 ? (
            <Empty message="No confirmed tokens yet." />
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
        <p className="eyebrow">How it works</p>
        <ol className="mt-6 grid gap-px bg-rule sm:grid-cols-3">
          <Step
            n="01"
            title="Buy from backing"
            body="BTC enters the deterministic reserve and freshly issued tokens come out. The price is a frozen 20-stage integer curve — no oracle, no discretion."
          />
          <Step
            n="02"
            title="Redeem to backing"
            body="Sell tokens back to the reserve for the exact R-delta, minus the protocol fee. The Guardian recomputes every amount from canonical state."
          />
          <Step
            n="03"
            title="Trade peer to peer"
            body="List a real token UTXO at a fixed BTC price. Buyer and seller both sign SIGHASH_ALL and it settles atomically in one Bitcoin transaction."
          />
        </ol>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <p className="eyebrow">What Bitcoin enforces</p>
        <div className="mt-5 grid gap-px bg-rule md:grid-cols-2">
          <Boundary
            kind="verified"
            heading="Bitcoin consensus"
            items={[
              "The Taproot signature on every spend",
              "UTXO rules — no double-spend, no BTC inflation",
              "The successor output exists at the exact value and script committed to",
            ]}
          />
          <Boundary
            kind="pending"
            heading="The Guardian — not Bitcoin"
            items={[
              "Supply conservation and the issuance curve",
              "Payment amounts and the recovery profile",
              "Bitcoin will not reject an invalid covs transition; the indexer ignores it",
            ]}
          />
        </div>
        <p className="mt-6 max-w-2xl text-xs leading-relaxed text-bone-dim">
          covs is client-validated, like every Bitcoin metaprotocol today — there are no covenants on
          Bitcoin mainnet; every proposal is still a draft. The difference is that this validator is
          reproducible: the indexer is public, the state root is deterministic, and two independent
          operators can check each other.
        </p>
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
  heading,
  items,
}: {
  kind: "verified" | "pending";
  heading: string;
  items: string[];
}) {
  const chip = kind === "verified" ? "chip chip-verified" : "chip chip-pending";
  return (
    <div className="bg-ink-3 px-5 py-5">
      <span className={chip}>{kind === "verified" ? "Consensus" : "Policy"}</span>
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
