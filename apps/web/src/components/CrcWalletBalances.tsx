"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { formatAtoms } from "./CrcHome";
import { fetchAllCrcWalletBalances, type CrcWalletBalance } from "@/lib/crc-client";
import { CrcMarketSeller } from "./CrcMarketSeller";

export function CrcWalletBalances() {
  const { connected, address, ordinalsAddress, connect } = useWallet();
  const [balances, setBalances] = useState<CrcWalletBalance[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connected) { setBalances([]); return; }
    let active = true;
    const addresses = [...new Set([address, ordinalsAddress].filter(Boolean))];
    setLoading(true);
    setError("");
    void Promise.all(addresses.map((walletAddress) => fetchAllCrcWalletBalances(walletAddress))).then((groups) => {
      if (!active) return;
      const combined = new Map<string, CrcWalletBalance>();
      for (const group of groups) for (const balance of group) {
        const previous = combined.get(balance.assetId);
        combined.set(balance.assetId, { ...balance, atoms: (BigInt(previous?.atoms ?? "0") + BigInt(balance.atoms)).toString() });
      }
      setBalances([...combined.values()]);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load balances"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connected, address, ordinalsAddress]);

  return (
    <div className="space-y-px">
      <section className="panel px-6 py-8 sm:px-10">
      <div>
        <h1 className="text-2xl text-bone">Your tokens</h1>
        <p className="mt-1 break-all font-mono text-xs text-bone-dim">{connected ? ordinalsAddress || address : "Confirmed balances held by your wallet"}</p>
      </div>
      <div className="mt-8">
      <h2 className="eyebrow">Holdings</h2>
      {!connected && <div className="mt-3 border border-dashed border-rule bg-ink-3 px-6 py-12 text-center"><p className="text-sm text-bone-dim">Connect a wallet to view your balances.</p><button className="btn mt-4" onClick={() => void connect()}>Connect wallet</button></div>}
      {loading && <p className="text-sm text-bone-dim">Reading indexed balances…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {connected && !loading && !error && balances.length === 0 && <p className="text-sm text-bone-dim">No confirmed Cove token balance.</p>}
      <div className="mt-3 grid gap-px bg-rule sm:grid-cols-2">
        {balances.map((balance) => (
          <Link key={balance.assetId} href={`/token/${encodeURIComponent(balance.assetId)}`} className="group block min-w-0 bg-ink-3 p-5 transition-colors hover:bg-ink-2">
            <span className="block text-bone group-hover:text-signal">${balance.ticker}</span>
            <span className="hex mt-1 block truncate">{balance.assetId}</span>
            <span className="mt-3 block text-xl tabular-nums text-bone">{formatAtoms(balance.atoms)} <span className="text-sm text-bone-dim">{balance.ticker}</span></span>
          </Link>
        ))}
      </div>
      </div>
      </section>
      {connected && <section className="panel px-6 py-8 sm:px-10"><CrcMarketSeller /></section>}
    </div>
  );
}
