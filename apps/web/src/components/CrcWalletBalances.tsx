"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { formatAtoms } from "./CrcHome";
import { fetchAllCrcWalletBalances, type CrcWalletBalance } from "@/lib/crc-client";

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
    <div className="space-y-5 py-8">
      <p className="eyebrow">Cove CRC-20</p>
      <h1 className="text-2xl text-bone">Wallet balances</h1>
      {!connected && <button className="btn" onClick={() => void connect()}>Connect wallet</button>}
      {loading && <p className="text-sm text-bone-dim">Reading indexed balances…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {connected && !loading && !error && balances.length === 0 && <p className="text-sm text-bone-dim">No confirmed Cove token balance.</p>}
      <div className="space-y-2">
        {balances.map((balance) => (
          <Link key={balance.assetId} href={`/crc/token/${encodeURIComponent(balance.assetId)}`} className="flex justify-between gap-4 border border-rule bg-ink-2 p-4 hover:border-signal">
            <span className="min-w-0"><span className="text-bone">${balance.ticker}</span><span className="block truncate text-xs text-bone-dim">{balance.assetId}</span></span>
            <span className="shrink-0 text-right text-bone">{formatAtoms(balance.atoms)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
