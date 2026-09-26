"use client";

import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { verifyClientIntent } from "@crclaunch/wallets";
import { FeePicker, useFeeRates } from "@/components/FeePicker";
import { fmtInt } from "@/lib/format";

/** The server's own words when it has them; the short copy otherwise. */
function errorText(j: { error?: { message?: string; detail?: string } }): string {
  return j.error?.detail || j.error?.message || "Something went wrong.";
}

interface Prepared {
  /** Null until a wallet is known: the id commits to the creator address. */
  tokenId: string | null;
  ticker: string;
  nonceHex: string;
  policyVersion: number;
  publicCapAtoms: string;
  publicSupplyAtoms: string;
  curve: string;
  vaultAnchorSats: string;
  launchFeeSats: string;
}

export default function LaunchPage() {
  const { connected, walletFields, connect, signPsbt, getUtxos } = useWallet();
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const { rates, selected: feeTier, setSelected: setFeeTier, satPerVb } = useFeeRates();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [error, setError] = useState("");

  async function prepare() {
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/v3/launch/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, displayName: name, description, websiteUrl: website, xUrl, imageUrl }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(errorText(j));
      setPrepared(j.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function buildAndSign() {
    if (!prepared || !connected) return;
    setError("");
    setBusy(true);
    setStatus("Building…");
    try {
      const funding = await getUtxos();
      const build = await fetch("/api/v3/launch/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticker: prepared.ticker,
          nonceHex: prepared.nonceHex,
          ...walletFields(),
          funding,
          feeRateSatPerVb: satPerVb ?? undefined,
          displayName: name,
          description,
          websiteUrl: website,
          xUrl,
          imageUrl,
          idempotencyKey: `launch-${prepared.nonceHex}`,
        }),
      });
      const bj = await build.json();
      if (!bj.ok) throw new Error(errorText(bj));
      // Client-side intent verification before opening the wallet.
      verifyClientIntent(bj.data.psbtBase64, bj.data.intent);
      setStatus("Signing…");
      const signed = await signPsbt(bj.data.psbtBase64, "DEPLOY");
      const submit = await fetch("/api/v3/launch/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: bj.data.sessionId, signedPsbtBase64: signed }),
      });
      const sj = await submit.json();
      if (!sj.ok) throw new Error(errorText(sj));
      setTokenId(bj.data.tokenId);
      setStatus(`Broadcast ${sj.data.txid.slice(0, 16)}…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl text-bone">Launch a token</h1>
        <p className="text-sm text-bone-dim">Precomputable tokenId, deterministic stairs210 backing, policy V3.</p>
      </div>

      <div className="space-y-3">
        <Field label="Name" value={name} onChange={setName} placeholder="Frog Coin" />
        <Field label="Ticker (1–16 uppercase alphanumeric)" value={ticker} onChange={(v) => setTicker(v.toUpperCase())} placeholder="FROG" />
        <Field label="Description" value={description} onChange={setDescription} placeholder="What is this token for?" />
        <Field label="Website (https)" value={website} onChange={setWebsite} />
        <Field label="X (https)" value={xUrl} onChange={setXUrl} />
        <Field label="Image URL (https)" value={imageUrl} onChange={setImageUrl} />
        {imageUrl ? (
          <div className="flex items-center gap-3 border border-rule bg-ink-2 px-4 py-3">
            <img
              src={imageUrl}
              alt=""
              className="h-12 w-12 shrink-0 border border-rule object-cover"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span className="text-xs text-bone-dim">
              This is how the token image will appear. It is metadata, not chain state.
            </span>
          </div>
        ) : null}
      </div>

      {!prepared ? (
        <button onClick={prepare} disabled={busy || !name.trim() || !ticker.trim()} className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253] disabled:opacity-50">
          {busy ? "Preparing…" : "Review launch identity"}
        </button>
      ) : (
        <div className="border border-rule bg-ink-2 p-5 text-sm">
          <h2 className="text-bone">Review</h2>
          <Row k="tokenId" v={<span className="break-all font-mono text-xs">{prepared.tokenId ?? "set when you sign (it includes your address)"}</span>} />
          <Row k="Ticker" v={`$${prepared.ticker}`} />
          <Row k="Policy" v={`V${prepared.policyVersion}`} />
          <Row k="Total supply" v={`${fmtInt(BigInt(prepared.publicCapAtoms) / 100_000_000n)} tokens`} />
          <Row k="Held back for the team" v="0 tokens" />
          <Row k="Sold on the curve" v={`${fmtInt(BigInt(prepared.publicSupplyAtoms) / 100_000_000n)} tokens`} />
          <Row k="Price" v="210 even stairs, lots of 1,000" />
          <Row k="You earn" v="50% of the curve price of every mint" />
          <Row k="Launch fee" v={`${fmtInt(prepared.launchFeeSats)} sats (~$6)`} />
          <Row k="Vault seed" v={`${fmtInt(prepared.vaultAnchorSats)} sats (stays in the token's vault)`} />
          <Row k="You pay" v={`${fmtInt(BigInt(prepared.launchFeeSats) + BigInt(prepared.vaultAnchorSats))} sats + network fee`} />
          <div className="mt-5">
            <FeePicker
              rates={rates}
              selected={feeTier}
              onSelect={setFeeTier}
              vsizeHint={rates?.typicalVsize.DEPLOY}
            />
          </div>
          <div className="mt-4">
            {!connected ? (
              <button onClick={() => void connect()} className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253]">
                Connect wallet to build
              </button>
            ) : (
              <button onClick={buildAndSign} disabled={busy} className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253] disabled:opacity-50">
                {busy ? status || "Working…" : "Build, review and sign"}
              </button>
            )}
          </div>
        </div>
      )}

      {status && <p className="text-sm text-success">{status}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {tokenId && (
        <a href={`/token/${tokenId}`} className="block text-center text-sm text-signal hover:underline">
          Open token page →
        </a>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-bone-dim">{label}</span>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full border border-rule bg-ink-2 px-4 py-2 text-sm text-bone outline-none placeholder:text-bone-dim/50 focus:border-brand" />
    </label>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/40 py-1.5 last:border-0">
      <span className="text-bone-dim">{k}</span>
      <span className="text-right text-bone">{v}</span>
    </div>
  );
}
