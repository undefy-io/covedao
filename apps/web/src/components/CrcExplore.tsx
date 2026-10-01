"use client";

import { useEffect, useMemo, useState } from "react";
import { CrcTokenCard, formatVaultSats, type CrcToken } from "./CrcHome";
import { Tile } from "./Tile";

type Catalog = { tokens: CrcToken[]; nextCursor: string | null };
type Sort = "newest" | "backing" | "progress";
type Filter = "all" | "open" | "minted";
const capAtoms = 2_100_000_000_000_000n;

export function CrcExplore() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<CrcToken[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim().replace(/^(mainnet|testnet|signet|regtest):/i, "")), 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function load(before?: string, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "48" });
      if (search) params.set("search", search);
      if (before) params.set("before", before);
      const response = await fetch(`/api/crc/v1/tokens?${params}`, { cache: "no-store", signal });
      const body = await response.json();
      if (signal?.aborted) return;
      if (!body.ok) throw new Error(body.error?.message ?? "Could not load tokens");
      const data = body.data as Catalog;
      setItems((previous) => before ? [...previous, ...data.tokens] : data.tokens);
      setCursor(data.nextCursor);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load tokens");
    } finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [search]);

  const rows = useMemo(() => {
    const filtered = items.filter((token) => filter === "all" ||
      (filter === "minted" ? BigInt(token.mintedAtoms) >= capAtoms : token.availability === "active" && BigInt(token.mintedAtoms) < capAtoms));
    return [...filtered].sort((a, b) => {
      if (sort === "backing") return Number(BigInt(b.vault.btcSats) - BigInt(a.vault.btcSats));
      if (sort === "progress") return Number(BigInt(b.mintedAtoms) - BigInt(a.mintedAtoms));
      return Number(BigInt(b.deployHeight) - BigInt(a.deployHeight));
    });
  }, [items, filter, sort]);
  const totalVault = items.reduce((sum, token) => sum + BigInt(token.vault.btcSats), 0n);
  const mintedOut = items.filter((token) => BigInt(token.mintedAtoms) >= capAtoms).length;

  return <div className="space-y-px">
    <section className="panel px-6 py-8 sm:px-10">
      <p className="eyebrow">Cove CRC-20 tokens</p>
      <h1 className="mt-4 text-3xl text-bone">Explore tokens</h1>
      <p className="mt-2 max-w-xl text-sm text-bone-dim">Confirmed Cove launches and their indexed Bitcoin vaults.</p>
      <div className="mt-6 grid grid-cols-3 gap-px bg-rule">
        <Tile value={String(items.length)} label="Loaded tokens" />
        <Tile value={formatVaultSats(totalVault.toString())} label="Vault BTC" />
        <Tile value={String(mintedOut)} label="Minted out" />
      </div>
    </section>
    <section className="panel px-6 py-5 sm:px-10">
      <div className="flex flex-wrap items-center gap-4">
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ticker or txid" aria-label="Search tokens" className="field min-w-0 flex-1 sm:max-w-sm" />
        <div className="flex items-center gap-2"><span className="eyebrow">Filter</span>
          <div className="flex">{(["all", "open", "minted"] as const).map((value) => <button key={value} type="button" onClick={() => setFilter(value)}
            className={filter === value ? "border border-signal bg-signal px-3 py-1.5 text-label uppercase tracking-label text-ink" : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim hover:text-bone"}>
            {value === "minted" ? "Minted out" : value}</button>)}</div>
        </div>
        <div className="flex items-center gap-2"><span className="eyebrow">Sort</span>
          <div className="flex">{(["newest", "backing", "progress"] as const).map((value) => <button key={value} type="button" onClick={() => setSort(value)}
            className={sort === value ? "border border-rule-bright bg-ink-3 px-3 py-1.5 text-label uppercase tracking-label text-bone" : "border border-rule px-3 py-1.5 text-label uppercase tracking-label text-bone-dim hover:text-bone"}>{value}</button>)}</div>
        </div>
      </div>
    </section>
    <section className="panel px-6 py-8 sm:px-10">
      <div className="flex items-baseline justify-between gap-3"><p className="eyebrow">Results</p><span className="text-label uppercase tracking-label text-bone-dim">{rows.length} shown</span></div>
      {error && <p role="alert" className="mt-5 text-sm text-danger">{error}</p>}
      {!error && rows.length === 0 && <p className="mt-5 border border-dashed border-rule px-6 py-14 text-center text-sm text-bone-dim">{loading ? "Reading indexed tokens…" : "No tokens match."}</p>}
      {rows.length > 0 && <div className="mt-5 grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">{rows.map((token) => <CrcTokenCard key={token.assetId} token={token} />)}</div>}
      {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)} className="btn-ghost mt-5 w-full">{loading ? "Loading…" : "Load more"}</button>}
    </section>
  </div>;
}
