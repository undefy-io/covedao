"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";

type LaunchBuild = { sessionId: string; psbtBase64: string; intent: {
  ticker: string; vaultAnchorSats: number; creatorRecordSats: number; launchFeeSats: number; minerFeeSats: number;
} };

export function CrcLaunchForm() {
  const { connected, connect, address, ordinalsAddress, publicKey, getUtxos, signPsbt } = useWallet();
  const [active, setActive] = useState(false);
  const [ticker, setTicker] = useState("");
  const [minerFeeSats, setMinerFeeSats] = useState("1000");
  const [built, setBuilt] = useState<LaunchBuild | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [txid, setTxid] = useState("");

  useEffect(() => {
    let mounted = true;
    void fetch("/api/crc/v1/trading/status", { cache: "no-store" }).then((r) => r.json())
      .then((body) => { if (mounted) setActive(body.ok === true && body.data?.tradingActive === true); })
      .catch(() => { if (mounted) setActive(false); });
    return () => { mounted = false; };
  }, []);

  async function review() {
    setError(""); setBuilt(null); setBusy(true);
    try {
      const normalized = ticker.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,16}$/.test(normalized)) throw new Error("Ticker must be 1 to 16 letters or digits");
      if (!/^[1-9]\d{0,4}$/.test(minerFeeSats) || Number(minerFeeSats) > 20_000) throw new Error("Miner fee must be 1 to 20,000 sats");
      const funding = (await getUtxos(true)).slice(0, 40);
      const response = await fetch("/api/crc/v1/launch/build", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: normalized, walletAddress: address, ordinalsAddress: ordinalsAddress || address,
          walletPublicKey: publicKey, funding, minerFeeSats, idempotencyKey: crypto.randomUUID() }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.detail || body.error?.message || "Could not prepare launch");
      if (body.data.intent?.ticker !== normalized) throw new Error("Launch ticker changed. Review again");
      setBuilt(body.data as LaunchBuild);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare launch"); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!built) return;
    setError(""); setBusy(true);
    try {
      const signedPsbtBase64 = await signPsbt(built.psbtBase64, "CRC_LAUNCH");
      const response = await fetch("/api/crc/v1/launch/submit", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64 }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.detail || body.error?.message || "Could not submit launch");
      setTxid(body.data.txid); setBuilt(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit launch"); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-xl space-y-5 py-8">
    <p className="eyebrow">Cove CRC-20</p><h1 className="text-2xl text-bone">Launch a token</h1>
    <p className="text-sm leading-relaxed text-bone-dim">Create a CRC-20 token with Cove curve backing. Review the transaction before your wallet signs it.</p>
    {active ? <section className="space-y-4 border border-rule bg-ink-2 p-6">
      <label className="block text-sm text-bone-dim">Ticker
        <input value={ticker} onChange={(event) => { setTicker(event.target.value.toUpperCase()); setBuilt(null); }} maxLength={16}
          className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone outline-none focus:border-signal" />
      </label>
      <label className="block text-sm text-bone-dim">Miner fee (sats)
        <input value={minerFeeSats} onChange={(event) => { setMinerFeeSats(event.target.value); setBuilt(null); }} inputMode="numeric"
          className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone outline-none focus:border-signal" />
      </label>
      {connected ? <button type="button" className="btn disabled:opacity-50" disabled={busy} onClick={() => void review()}>
        {busy && !built ? "Preparing…" : "Review launch"}
      </button> : <button type="button" className="btn" onClick={() => void connect()}>Connect wallet</button>}
      {built && <div className="space-y-1 border-t border-rule pt-4 text-sm text-bone-dim">
        <p className="text-bone">${built.intent.ticker}</p>
        <p>Vault anchor: {built.intent.vaultAnchorSats} sats</p><p>Creator record: {built.intent.creatorRecordSats} sats</p>
        <p>Launch fee: {built.intent.launchFeeSats} sats</p><p>Miner fee: {built.intent.minerFeeSats} sats</p>
        <button type="button" className="btn mt-4 disabled:opacity-50" disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing and submitting…" : "Sign and broadcast launch"}
        </button>
      </div>}
    </section> : <p className="text-sm text-bone-dim">Token launches are paused on this server.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {txid && <p className="break-all text-sm text-signal">Submitted: {txid}</p>}
    <Link href="/" className="btn-ghost inline-block">Browse confirmed tokens</Link>
  </div>;
}
