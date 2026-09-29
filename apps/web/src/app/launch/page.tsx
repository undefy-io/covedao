"use client";

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { verifyClientIntent } from "@crclaunch/wallets";
import { FeePicker, useFeeRates } from "@/components/FeePicker";
import { fmtInt } from "@/lib/format";
import { errorText } from "@/lib/trade";
import { notifyLocalBroadcast } from "@/lib/use-indexed-block";
import { useT } from "@/i18n/LanguageProvider";

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
  const t = useT();
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
        body: JSON.stringify({
          ticker,
          displayName: name,
          description,
          websiteUrl: website,
          xUrl,
          imageUrl,
        }),
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
    setStatus(t("launch.building"));
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
      setStatus(t("launch.signing"));
      const signed = await signPsbt(bj.data.psbtBase64, "DEPLOY");
      const submit = await fetch("/api/v3/launch/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: bj.data.sessionId, signedPsbtBase64: signed }),
      });
      const sj = await submit.json();
      if (!sj.ok) throw new Error(errorText(sj));
      setTokenId(bj.data.tokenId);
      notifyLocalBroadcast();
      setStatus(t("launch.broadcast", { txid: sj.data.txid.slice(0, 16) }));
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
        <h1 className="text-2xl text-bone">{t("launch.title")}</h1>
        <p className="text-sm text-bone-dim">{t("launch.subtitle")}</p>
      </div>

      <div className="space-y-3">
        <Field label={t("launch.name")} value={name} onChange={setName} placeholder="Frog Coin" />
        <Field
          label={t("launch.ticker")}
          value={ticker}
          onChange={(v) => setTicker(v.toUpperCase())}
          placeholder="FROG"
        />
        <Field
          label={t("launch.description")}
          value={description}
          onChange={setDescription}
          placeholder={t("launch.descriptionPh")}
        />
        <Field label={t("launch.website")} value={website} onChange={setWebsite} />
        <Field label={t("launch.x")} value={xUrl} onChange={setXUrl} />
        <Field label={t("launch.image")} value={imageUrl} onChange={setImageUrl} />
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
            <span className="text-xs text-bone-dim">{t("launch.imageNote")}</span>
          </div>
        ) : null}
      </div>

      {!prepared ? (
        <button
          onClick={prepare}
          disabled={busy || !name.trim() || !ticker.trim()}
          className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253] disabled:opacity-50"
        >
          {busy ? t("launch.preparing") : t("launch.review")}
        </button>
      ) : (
        <div className="border border-rule bg-ink-2 p-5 text-sm">
          <h2 className="text-bone">{t("launch.reviewTitle")}</h2>
          <Row
            k="tokenId"
            v={
              <span className="break-all font-mono text-xs">
                {prepared.tokenId ?? t("launch.tokenIdPending")}
              </span>
            }
          />
          <Row k={t("launch.rowTicker")} v={`$${prepared.ticker}`} />
          <Row k={t("launch.rowPolicy")} v={`V${prepared.policyVersion}`} />
          <Row
            k={t("launch.rowSupply")}
            v={t("launch.tokensN", { n: fmtInt(BigInt(prepared.publicCapAtoms) / 100_000_000n) })}
          />
          <Row k={t("launch.rowTeam")} v={t("launch.zeroTokens")} />
          <Row
            k={t("launch.rowCurve")}
            v={t("launch.tokensN", {
              n: fmtInt(BigInt(prepared.publicSupplyAtoms) / 100_000_000n),
            })}
          />
          <Row k={t("launch.rowPrice")} v={t("launch.priceValue")} />
          <Row k={t("launch.rowEarn")} v={t("launch.earnValue")} />
          <Row
            k={t("launch.rowFee")}
            v={t("launch.feeValue", { n: fmtInt(prepared.launchFeeSats) })}
          />
          <Row
            k={t("launch.rowSeed")}
            v={t("launch.seedValue", { n: fmtInt(prepared.vaultAnchorSats) })}
          />
          <Row
            k={t("launch.rowPay")}
            v={t("launch.payValue", {
              n: fmtInt(BigInt(prepared.launchFeeSats) + BigInt(prepared.vaultAnchorSats)),
            })}
          />
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
              <button
                onClick={() => void connect()}
                className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253]"
              >
                {t("launch.connectToBuild")}
              </button>
            ) : (
              <button
                onClick={buildAndSign}
                disabled={busy}
                className="w-full bg-signal px-6 py-3 text-bone hover:bg-[#F0A253] disabled:opacity-50"
              >
                {busy ? status || t("launch.working") : t("launch.buildSign")}
              </button>
            )}
          </div>
        </div>
      )}

      {status && <p className="text-sm text-success">{status}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {tokenId && (
        <Link
          href={`/token/${tokenId}`}
          className="block text-center text-sm text-signal hover:underline"
        >
          {t("launch.openToken")}
        </Link>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-bone-dim">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-rule bg-ink-2 px-4 py-2 text-sm text-bone outline-none placeholder:text-bone-dim/50 focus:border-brand"
      />
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
