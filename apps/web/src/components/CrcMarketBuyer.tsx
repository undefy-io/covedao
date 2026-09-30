"use client";

import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { formatAtoms } from "./CrcHome";
import { buyCrcMarketListing, type CrcMarketListing } from "@/lib/crc-market-client";

export function CrcMarketBuyer() {
  const { connected, network, script, publicKey, ordinalsScript, address, ordinalsAddress, connect, signPsbt } = useWallet();
  const [active, setActive] = useState(false);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);
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
    ]).then(([status, book]) => {
      if (!live) return;
      setActive(status.ok === true && status.data?.active === true && book.ok === true && book.data?.active === true);
      if (book.ok === true && Array.isArray(book.data?.listings)) setListings(book.data.listings);
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

  return <section className="space-y-4 border border-rule bg-ink-2 p-6">
    <h2 className="text-lg text-bone">Buy from a holder</h2>
    {loading && <p className="text-sm text-bone-dim">Loading listings…</p>}
    {!loading && !listings.some((listing) => listing.status === "OPEN") && <p className="text-sm text-bone-dim">No open listings yet.</p>}
    {listings.filter((listing) => listing.status === "OPEN").map((listing) => <div key={listing.id} className="flex flex-wrap items-center justify-between gap-4 border-t border-rule py-4">
      <div>
        <p className="text-bone">${listing.ticker} · {formatAtoms(listing.amountAtoms)} tokens</p>
        <p className="mt-1 text-sm text-bone-dim">Seller receives {listing.priceSats.toLocaleString()} sats · protocol fee {listing.protocolFeeSats.toLocaleString()} sats</p>
        <p className="mt-1 break-all font-mono text-xs text-bone-dim">{listing.sellerAnchorTxid}:{listing.sellerAnchorVout}</p>
      </div>
      <button type="button" className="btn disabled:opacity-50" disabled={!active || !!pending}
        onClick={() => void buy(listing)}>{pending === listing.id ? "Reviewing…" : connected ? "Buy" : "Connect wallet"}</button>
    </div>)}
    {active && listings.some((listing) => listing.status === "OPEN") && <label className="block text-sm text-bone-dim">Miner fee (sats)
      <input className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone outline-none focus:border-signal"
        inputMode="numeric" value={minerFee} onChange={(event) => setMinerFee(event.target.value)} />
    </label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {message && <p role="status" className="break-all text-sm text-signal">{message}</p>}
  </section>;
}
