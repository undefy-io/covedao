"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CrcToken = {
  assetId: string;
  ticker: string;
  circulatingAtoms: string;
  inventoryAtoms: string;
  availability: "active" | "unavailable";
};

type Catalog = {
  network: string;
  indexedTip: { height: string; blockHash: string };
  tokens: CrcToken[];
  nextCursor: string | null;
};

export function CrcHome() {
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
      if (!body.ok) throw new Error(body.error?.message ?? "Could not load Cove tokens");
      const data = body.data as Catalog;
      setItems((previous) => before ? [...previous, ...data.tokens] : data.tokens);
      setTip(data.indexedTip);
      setCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Cove tokens");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-6 py-8">
      <section className="border border-rule bg-ink-2 p-6">
        <p className="eyebrow">Cove CRC-20</p>
        <h1 className="mt-3 text-3xl text-bone">Cove tokens</h1>
        <p className="mt-3 max-w-2xl text-sm text-bone-dim">
          Confirmed Cove-issued tokens indexed from Bitcoin. Trading and launches will appear after transaction signing is enabled.
        </p>
        {tip && <p className="mt-4 text-xs text-bone-dim">Indexed block {tip.height}</p>}
      </section>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((token) => (
          <Link key={token.assetId} href={`/crc/token/${encodeURIComponent(token.assetId)}`} className="border border-rule bg-ink-2 p-5 hover:border-signal">
            <span className="text-xl text-bone">${token.ticker}</span>
            <span className="ml-2 text-xs text-bone-dim">{token.availability}</span>
            <p className="mt-3 text-sm text-bone-dim">Circulating: {formatAtoms(token.circulatingAtoms)} tokens</p>
            <p className="mt-1 text-xs text-bone-dim">{token.assetId}</p>
          </Link>
        ))}
      </section>
      {!loading && !error && items.length === 0 && <p className="text-sm text-bone-dim">No confirmed Cove tokens yet.</p>}
      {cursor && <button className="btn-ghost" disabled={loading} onClick={() => void load(cursor)}>Load more</button>}
      {loading && <p className="text-sm text-bone-dim">Reading indexed state…</p>}
    </div>
  );
}

export function formatAtoms(atoms: string): string {
  const value = BigInt(atoms);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}
