"use client";

import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { formatAtoms, formatVaultSats } from "./CrcHome";
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

  return <section>
    <div className="flex flex-wrap items-baseline justify-between gap-3"><p className="eyebrow">Open orders</p><span className="text-label uppercase tracking-label text-bone-dim">{listings.filter((row) => row.status === "OPEN").length} listed</span></div>
    {loading && <p className="text-sm text-bone-dim">Loading listings…</p>}
    {!loading && !listings.some((listing) => listing.status === "OPEN") && <p className="mt-5 border border-dashed border-rule px-6 py-10 text-center text-sm text-bone-dim">No open listings yet.</p>}
    {listings.some((listing) => listing.status === "OPEN") && <div className="mt-5 overflow-x-auto"><table className="ledger-table min-w-[42rem]"><thead><tr>
      <th>Token</th><th className="text-right">Tokens</th><th className="text-right">Seller ask</th><th className="text-right">Protocol fee</th><th className="text-right">Action</th>
    </tr></thead><tbody>{listings.filter((listing) => listing.status === "OPEN").map((listing) => <tr key={listing.id}>
      <td><span className="text-bone">${listing.ticker}</span><span className="hex block">{listing.sellerAnchorTxid.slice(0, 12)}:{listing.sellerAnchorVout}</span></td>
      <td className="text-right tabular-nums">{formatAtoms(listing.amountAtoms)}</td>
      <td className="text-right tabular-nums">{formatVaultSats(String(listing.priceSats))}</td>
      <td className="text-right tabular-nums">{formatVaultSats(String(listing.protocolFeeSats))}</td>
      <td className="text-right"><button type="button" className="text-signal hover:underline disabled:opacity-50" disabled={!active || !!pending}
        onClick={() => void buy(listing)}>{pending === listing.id ? "Reviewing…" : connected ? "Review" : "Connect"}</button></td>
    </tr>)}</tbody></table></div>}
    {active && listings.some((listing) => listing.status === "OPEN") && <label className="block text-sm text-bone-dim">Miner fee (sats)
      <input className="field mt-2 max-w-xs"
        inputMode="numeric" value={minerFee} onChange={(event) => setMinerFee(event.target.value)} />
    </label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {message && <p role="status" className="break-all text-sm text-signal">{message}</p>}
  </section>;
}
