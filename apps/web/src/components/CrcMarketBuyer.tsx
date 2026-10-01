"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { formatAtoms, formatVaultSats, type CrcToken } from "./CrcHome";
import { buyCrcMarketListing, type CrcMarketListing } from "@/lib/crc-market-client";

export function CrcMarketBuyer() {
  const { connected, network, script, publicKey, ordinalsScript, address, ordinalsAddress, connect, signPsbt } = useWallet();
  const [active, setActive] = useState(false);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);
  const [tokens, setTokens] = useState<CrcToken[]>([]);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [minerFee, setMinerFee] = useState("1000");

  useEffect(() => {
    let live = true;
    void Promise.all([
      fetch("/api/crc/v1/market/status", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/crc/v1/market/listings", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/crc/v1/tokens?limit=100", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([status, book, catalog]) => {
      if (!live) return;
      setActive(status.ok === true && status.data?.active === true && book.ok === true && book.data?.active === true);
      if (book.ok === true && Array.isArray(book.data?.listings)) setListings(book.data.listings);
      if (catalog.ok === true && Array.isArray(catalog.data?.tokens)) setTokens(catalog.data.tokens);
    }).catch(() => { if (live) setError("Could not load the marketplace"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  async function buy(listing: CrcMarketListing) {
    if (!active) return;
    setPending(listing.id);
    setError("");
    setMessage("");
    try {
      if (!connected) { await connect(); return; }
      if (!/^[1-9]\d{0,4}$/.test(minerFee) || Number(minerFee) > 20_000) {
        throw new Error("Miner fee must be 1 to 20,000 sats");
      }
      const result = await buyCrcMarketListing(listing,
        { network, script, publicKey, ordinalsScript, address, ordinalsAddress, signPsbt }, Number(minerFee));
      setMessage(`Buyer signature submitted for fill ${result.fillId}. The seller must sign the same transaction before broadcast.`);
      setListings((current) => current.filter((row) => row.id !== listing.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not fill listing");
    } finally {
      setPending("");
    }
  }

  const open = listings.filter((listing) => listing.status === "OPEN");
  const visible = selected ? open.filter((listing) => `${listing.network}:${listing.deployTxid}` === selected) : open;
  const cards = tokens.filter((token) => token.ticker.toLowerCase().includes(search.trim().toLowerCase()) || token.assetId.includes(search.trim().toLowerCase()));

  return <section>
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="eyebrow">Markets</p><h2 className="mt-2 text-xl text-bone">{selected ? `$${tokens.find((token) => token.assetId === selected)?.ticker ?? "Token"}` : "All tokens"}</h2></div>
      <input aria-label="Search markets" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tokens" className="field max-w-xs" />
    </div>
    <div className="mt-5 grid grid-cols-2 gap-px bg-rule sm:grid-cols-3 lg:grid-cols-4">
      <button type="button" onClick={() => setSelected("")} aria-pressed={!selected} className={`bg-ink-2 p-4 text-left transition-colors hover:bg-ink-3 ${!selected ? "outline outline-1 outline-signal" : ""}`}><div className="text-bone">All tokens</div><div className="mt-1 text-xs text-bone-dim">{open.length} open asks</div></button>
      {cards.map((token) => {
        const tokenAsks = open.filter((listing) => `${listing.network}:${listing.deployTxid}` === token.assetId);
        const minted = Number(BigInt(token.mintedAtoms) * 1000n / 2_100_000_000_000_000n) / 10;
        return <button type="button" key={token.assetId} onClick={() => setSelected(selected === token.assetId ? "" : token.assetId)} aria-pressed={selected === token.assetId} className={`bg-ink-2 p-4 text-left transition-colors hover:bg-ink-3 ${selected === token.assetId ? "outline outline-1 outline-signal" : ""}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-bone">${token.ticker}</span><span className={minted >= 100 ? "chip chip-signal" : "chip chip-verified"}>{minted >= 100 ? "Minted out" : `${minted}%`}</span></div><div className="mt-1 text-xs text-bone-dim">{tokenAsks.length} open asks</div><div className="mt-3 text-xs text-bone-2">Vault: {formatVaultSats(token.vault.btcSats)}</div></button>;
      })}
    </div>
    {selected && <p className="mt-4 text-xs text-bone-dim">Showing one token. <Link href={`/token/${encodeURIComponent(selected)}`} className="text-signal hover:underline">Open token page</Link></p>}
    <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
    <p className="eyebrow">Open orders</p><span className="text-label uppercase tracking-label text-bone-dim">{visible.length} listed</span></div>
    {loading && <p className="text-sm text-bone-dim">Loading listings…</p>}
    {!loading && visible.length === 0 && <p className="mt-5 border border-dashed border-rule px-6 py-10 text-center text-sm text-bone-dim">No open listings yet.</p>}
    {visible.length > 0 && <div className="mt-5 overflow-x-auto"><table className="ledger-table min-w-[42rem]"><thead><tr>
      <th>Token</th><th className="text-right">Tokens</th><th className="text-right">Seller ask</th><th className="text-right">Protocol fee</th><th className="text-right">Action</th>
    </tr></thead><tbody>{visible.map((listing) => <tr key={listing.id}>
      <td><span className="text-bone">${listing.ticker}</span><span className="hex block">{listing.sellerAnchorTxid.slice(0, 12)}:{listing.sellerAnchorVout}</span></td>
      <td className="text-right tabular-nums">{formatAtoms(listing.amountAtoms)}</td>
      <td className="text-right tabular-nums">{formatVaultSats(String(listing.priceSats))}</td>
      <td className="text-right tabular-nums">{formatVaultSats(String(listing.protocolFeeSats))}</td>
      <td className="text-right"><button type="button" className="text-signal hover:underline disabled:opacity-50" disabled={!active || !!pending}
        onClick={() => void buy(listing)}>{pending === listing.id ? "Reviewing…" : connected ? "Review" : "Connect"}</button></td>
    </tr>)}</tbody></table></div>}
    {active && visible.length > 0 && <label className="mt-6 block max-w-xs text-sm text-bone-dim">Miner fee (sats)
      <input className="field mt-2 max-w-xs"
        inputMode="numeric" value={minerFee} onChange={(event) => setMinerFee(event.target.value)} />
    </label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {message && <p role="status" className="break-all text-sm text-signal">{message}</p>}
  </section>;
}
