"use client";

import { isMessageKey, type MessageKey } from "@/i18n";
import { useT } from "@/i18n/LanguageProvider";
import { useRouter, useSearchParams } from "next/navigation";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useMarketRevision } from "@/lib/use-indexed-block";
import Link from "next/link";
import { DEMO_LISTINGS, DEMO_TOKENS } from "@/lib/demo-tokens";
import { useWallet } from "@/components/WalletProvider";
import { fmtBtc, fmtTokens, fmtInt } from "@/lib/format";
import { Sparkline } from "@/components/Sparkline";
import { Tile } from "@/components/Tile";
import { useSparklines } from "@/lib/use-sparklines";
import { unitPriceSats } from "@/lib/ohlc";
import { buyListing } from "@/lib/trade";
import { FeePicker, useFeeRates } from "@/components/FeePicker";

interface Listing {
  id: string;
  listingId: string;
  tokenId: string;
  amountAtoms: string;
  totalPriceSats: string;
  expiryHeight: string;
  status: string;
  sellerTokenScript: string;
  /** Joined from the token row; null if that row is missing. */
  ticker?: string | null;
}

/** A launched token, as a market card. */
interface MarketToken {
  tokenId: string;
  ticker: string;
  displayName: string;
  issuedSupplyAtoms: string;
  publicCapAtoms: string;
  graduated?: boolean;
  imageUrl?: string | null;
}

function MarketContent() {
  const searchParams = useSearchParams();
  // Client-side design-preview path: no API calls, no writes.
  const demo = searchParams.get("demo") === "1";
  const router = useRouter();
  // The market being viewed: one token's book, or every book when unset.
  const selected = searchParams.get("token");
  const t = useT();
  const [tokens, setTokens] = useState<MarketToken[]>([]);
  const [query, setQuery] = useState("");
  const { connected, script, publicKey, ordinalsScript, connect, signPsbt, signBip322, getUtxos } =
    useWallet();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Refetch when a new block is indexed.
  const block = useMarketRevision();
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const { rates, selected: feeTier, setSelected: setFeeTier, satPerVb } = useFeeRates();

  // Every launched token, for the market cards.
  useEffect(() => {
    if (demo) {
      setTokens(DEMO_TOKENS as unknown as MarketToken[]);
      return;
    }
    void fetch("/api/v3/tokens")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setTokens(j.data);
      })
      .catch(() => undefined);
  }, [demo, block]);

  /** Open one token's market (or all, with null); kept in the URL so it can be shared. */
  function selectToken(tokenId: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (tokenId) params.set("token", tokenId);
    else params.delete("token");
    const qs = params.toString();
    router.replace(qs ? `/market?${qs}` : "/market", { scroll: false });
  }

  useEffect(() => {
    if (demo) {
      setListings(
        DEMO_LISTINGS.map((l) => ({
          ...l,
          ticker: DEMO_TOKENS.find((t) => t.tokenId === l.tokenId)?.ticker ?? null,
        })),
      );
      setLoaded(true);
      return;
    }
    void fetch("/api/v3/market/listings")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setListings(j.data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [block]);

  async function buy(listing: Listing) {
    if (!connected) return;
    setErr("");
    setBuying(listing.listingId);
    setMsg("");
    try {
      const { txid } = await buyListing(
        listing,
        { script, publicKey, ordinalsScript, signPsbt, signBip322, getUtxos },
        satPerVb,
      );
      setMsg(t("market.bought", { txid: txid.slice(0, 16) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(null);
    }
  }

  // Quote every listing in the unit the charts use, so a buyer can compare an
  // ask against that token's recent trades without doing arithmetic.
  //
  // Grouped by token, then cheapest first within each token. Sorting the whole
  // book by absolute price would rank a cheap token above an expensive one and
  // read as a bargain, when the two prices are not comparable at all.
  const visible = useMemo(
    () => (selected ? listings.filter((l) => l.tokenId === selected) : listings),
    [listings, selected],
  );

  // Per-token book stats for the cards: open asks and the floor per 1,000.
  const bookByToken = useMemo(() => {
    const m = new Map<string, { asks: number; floor: number | null }>();
    for (const l of listings) {
      if (l.status !== "ACTIVE") continue;
      const u = unitPriceSats(l.amountAtoms, l.totalPriceSats);
      const cur = m.get(l.tokenId) ?? { asks: 0, floor: null };
      m.set(l.tokenId, {
        asks: cur.asks + 1,
        floor: cur.floor === null ? u : Math.min(cur.floor, u),
      });
    }
    return m;
  }, [listings]);

  // Cards: search by ticker or name; tokens with open asks first, then by ticker.
  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tokens
      .filter(
        (t) =>
          !q ||
          t.ticker.toLowerCase().includes(q) ||
          (t.displayName ?? "").toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          (bookByToken.get(b.tokenId)?.asks ?? 0) - (bookByToken.get(a.tokenId)?.asks ?? 0) ||
          a.ticker.localeCompare(b.ticker),
      );
  }, [tokens, query, bookByToken]);
  const selectedToken = tokens.find((t) => t.tokenId === selected) ?? null;

  const rows = useMemo(
    () =>
      visible
        .map((l) => ({
          listing: l,
          unitPrice: unitPriceSats(l.amountAtoms, l.totalPriceSats),
          tokens: Number(BigInt(l.amountAtoms) / 100_000_000n),
          label: l.ticker ?? l.tokenId,
        }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.unitPrice - b.unitPrice),
    [visible],
  );

  const { series, lastPrice } = useSparklines(
    listings.map((l) => ({
      tokenId: l.tokenId,
      ticker: l.ticker ?? l.tokenId.slice(0, 6),
      curveStage: DEMO_TOKENS.find((t) => t.tokenId === l.tokenId)?.curveStage ?? 10,
    })),
    demo,
  );

  const totalTokens = rows.reduce((a, r) => a + r.tokens, 0);
  const totalSats = visible.reduce((a, l) => a + BigInt(l.totalPriceSats), 0n);

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-8 sm:px-10">
        {demo ? (
          <p className="mb-5 inline-block border border-pending/40 bg-pending/10 px-3 py-1.5 text-label uppercase tracking-label text-pending">
            {t("common.demoData")}
          </p>
        ) : null}
        <p className="eyebrow">{t("market.eyebrow")}</p>
        <h1 className="mt-3 text-4xl text-bone">{t("market.title")}</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone-dim">{t("market.body")}</p>

        <div className="mt-8 grid grid-cols-2 gap-px bg-rule sm:grid-cols-3">
          <Tile value={fmtInt(visible.length)} label={t("market.openAsks")} />
          <Tile value={fmtInt(totalTokens)} label={t("market.tokensOffered")} />
          <Tile
            value={totalSats > 0n ? fmtBtc(totalSats) : "\u2014"}
            label={t("market.bookValue")}
          />
        </div>
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{t("market.markets")}</p>
            <h2 className="mt-2 text-xl text-bone">
              {selectedToken ? `$${selectedToken.ticker}` : t("market.allTokens")}
            </h2>
          </div>
          <input
            aria-label={t("market.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("market.searchPh")}
            className="field max-w-xs"
          />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-3 lg:grid-cols-4">
          <button
            onClick={() => selectToken(null)}
            aria-pressed={!selected}
            className={`bg-ink-2 p-4 text-left transition-colors hover:bg-ink-3 ${!selected ? "outline outline-1 outline-signal" : ""}`}
          >
            <div className="text-bone">{t("market.allTokens")}</div>
            <div className="mt-1 text-xs text-bone-dim">
              {t("market.nOpenAsks", {
                n: fmtInt(listings.filter((l) => l.status === "ACTIVE").length),
              })}
            </div>
          </button>
          {cards.map((tk) => {
            const book = bookByToken.get(tk.tokenId);
            const minted =
              BigInt(tk.publicCapAtoms) > 0n
                ? Number((BigInt(tk.issuedSupplyAtoms) * 1000n) / BigInt(tk.publicCapAtoms)) / 10
                : 0;
            const out = tk.graduated ?? BigInt(tk.issuedSupplyAtoms) >= BigInt(tk.publicCapAtoms);
            const on = selected === tk.tokenId;
            return (
              <button
                key={tk.tokenId}
                onClick={() => selectToken(on ? null : tk.tokenId)}
                aria-pressed={on}
                aria-label={t("market.cardAria", { ticker: tk.ticker })}
                className={`bg-ink-2 p-4 text-left transition-colors hover:bg-ink-3 ${on ? "outline outline-1 outline-signal" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-bone">${tk.ticker}</span>
                  <span className={out ? "chip chip-signal" : "chip chip-verified"}>
                    {out ? t("market.mintedOut") : `${minted}%`}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs text-bone-dim">{tk.displayName}</div>
                <div className="mt-3 text-xs text-bone-2">
                  {book
                    ? t(book.asks === 1 ? "market.askFloor" : "market.asksFloor", {
                        n: fmtInt(book.asks),
                        floor: fmtInt(Math.ceil(book.floor ?? 0)),
                      })
                    : out
                      ? t("market.noAsksYet")
                      : t("market.minting")}
                </div>
              </button>
            );
          })}
        </div>
        {tokens.length > 0 && cards.length === 0 ? (
          <p className="mt-4 text-sm text-bone-dim">{t("market.noMatch", { q: query })}</p>
        ) : null}
        {selectedToken ? (
          <p className="mt-4 text-xs text-bone-dim">
            {t("market.showingOnly", { ticker: selectedToken.ticker })}{" "}
            <Link href={`/token/${selectedToken.tokenId}`} className="text-signal hover:underline">
              {t("market.openPage")}
            </Link>
            {t("market.toMint")}
          </p>
        ) : null}
      </section>

      <section className="panel px-6 py-8 sm:px-10">
        {!loaded ? (
          <Empty message={t("market.loadingListings")} />
        ) : rows.length === 0 ? (
          <Empty
            message={
              selectedToken
                ? t("market.noAsksFor", { ticker: selectedToken.ticker })
                : t("market.noListings")
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger-table min-w-[64rem]">
              <thead>
                <tr>
                  <th>{t("market.colToken")}</th>
                  <th>{t("market.colAsk")}</th>
                  <th>{t("market.colLast")}</th>
                  <th>{t("market.colTrend")}</th>
                  <th>{t("market.colLot")}</th>
                  <th>{t("market.colTotal")}</th>
                  <th>{t("market.colStatus")}</th>
                  <th>{t("market.colSeller")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ listing: l, unitPrice }, i) => {
                  const last = lastPrice[l.tokenId] ?? null;
                  const firstOfToken = i === 0 || rows[i - 1]!.listing.tokenId !== l.tokenId;
                  // Below the last trade is the interesting case for a buyer.
                  const cheap = last !== null && unitPrice < last;
                  return (
                    <tr key={l.listingId} className="transition-colors hover:bg-ink-3">
                      <td>
                        {firstOfToken ? (
                          <Link
                            href={`/token/${l.tokenId}`}
                            className="text-bone hover:text-signal"
                          >
                            {l.ticker ?? `${l.tokenId.slice(0, 10)}\u2026`}
                          </Link>
                        ) : (
                          <span className="text-bone-dim">&#8226;</span>
                        )}
                      </td>
                      <td className={cheap ? "text-verified" : "text-bone"}>
                        {fmtInt(Math.round(unitPrice))}
                      </td>
                      <td className="text-bone-dim">
                        {firstOfToken && last !== null ? fmtInt(Math.round(last)) : ""}
                      </td>
                      <td>
                        {firstOfToken ? (
                          <Sparkline values={series[l.tokenId] ?? []} width={80} height={22} />
                        ) : null}
                      </td>
                      <td className="text-bone-2">{fmtTokens(BigInt(l.amountAtoms))}</td>
                      <td className="text-bone-2">{fmtBtc(BigInt(l.totalPriceSats))}</td>
                      <td>
                        <span className={statusChip(l.status)}>
                          {isMessageKey(`lst.${l.status}`)
                            ? t(`lst.${l.status}` as MessageKey)
                            : l.status}
                        </span>
                      </td>
                      <td className="hex">{l.sellerTokenScript.slice(0, 10)}&hellip;</td>
                      <td>
                        <button
                          onClick={() => void buy(l)}
                          disabled={!connected || buying === l.listingId || l.status !== "ACTIVE"}
                          className="btn px-3 py-1.5 text-label"
                        >
                          {buying === l.listingId ? t("market.reserving") : t("market.buy")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!connected ? (
          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-rule pt-6">
            <button onClick={() => void connect()} className="btn">
              {t("market.connect")}
            </button>
            <p className="text-xs text-bone-dim">{t("market.required")}</p>
          </div>
        ) : (
          <div className="mt-6 max-w-md border-t border-rule pt-6">
            <FeePicker
              rates={rates}
              selected={feeTier}
              onSelect={setFeeTier}
              vsizeHint={rates?.typicalVsize.TRANSFER}
            />
          </div>
        )}

        {msg ? <p className="mt-5 text-sm text-verified">{msg}</p> : null}
        {err ? <p className="mt-5 text-sm text-rejected">{err}</p> : null}
      </section>
    </div>
  );
}

/** Status is protocol state, so it gets the semantic chips, not grey text. */
function statusChip(status: string): string {
  if (status === "ACTIVE") return "chip chip-verified";
  if (status === "RESERVED" || status === "BROADCAST") return "chip chip-pending";
  return "chip chip-rejected";
}

function Empty({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-rule px-6 py-16 text-center text-sm text-bone-dim">
      {message}
    </div>
  );
}

function SuspenseLoading() {
  const t = useT();
  return (
    <div className="panel px-6 py-16 text-center text-sm text-bone-dim">{t("common.loading")}</div>
  );
}

/**
 * useSearchParams opts this route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary.
 */
export default function MarketPage() {
  return (
    <Suspense fallback={<SuspenseLoading />}>
      <MarketContent />
    </Suspense>
  );
}
