"use client";

import { fetchPortfolio } from "@/lib/portfolio";

import { isMessageKey, type MessageKey } from "@/i18n";
import { useT } from "@/i18n/LanguageProvider";
import { useSearchParams } from "next/navigation";

import { Suspense, useEffect, useState } from "react";
import { useIndexedBlock } from "@/lib/use-indexed-block";
import { useWallet } from "@/components/WalletProvider";
import { fmtBtc, fmtTokens } from "@/lib/format";
import { DEMO_PORTFOLIO } from "@/lib/demo-tokens";
import { sendTokens, createListing, errorText } from "@/lib/trade";
import { unitPriceSats } from "@/lib/ohlc";
import { fmtInt } from "@/lib/format";
import { displayTokensToAtoms } from "@/lib/format";
import { useFeeRates } from "@/components/FeePicker";

interface TokenInfo {
  ticker: string;
  displayName: string;
  graduated: boolean;
  /** Lowest open ask, sats per 1,000 tokens. */
  floorPer1k: number | null;
  /** What the vault pays to buy 1,000 back right now, before its fee. */
  vaultPer1k: number | null;
}

/** Sats for `tokens` whole tokens at `per1k` sats per 1,000, rounded up. */
function totalFor(tokens: string, per1k: string): bigint | null {
  if (!/^\d+$/.test(tokens) || !/^\d+$/.test(per1k) || BigInt(tokens) === 0n || BigInt(per1k) === 0n) return null;
  return (BigInt(tokens) * BigInt(per1k) + 999n) / 1000n;
}

interface Portfolio {
  holdings: { tokenId: string; amountAtoms: string; utxoCount: number }[];
  tokenUtxos: { txid: string; vout: number; tokenId: string; amountAtoms: string }[];
  listings: { listingId: string; tokenId: string; amountAtoms: string; totalPriceSats: string; status: string }[];
  fills: { id: string; listingId: string; tokenId: string; status: string; amountAtoms: string; totalPriceSats: string; marketFeeSats: string; minerFeeSats: string; txid: string | null }[];
}

function WalletContent() {
  const searchParams = useSearchParams();
  // Client-side design-preview path: no API calls, no writes.
  const demo = searchParams.get("demo") === "1";
  const t = useT();
  const { connected, address, ordinalsAddress, network, walletFields, connect, signPsbt, signBip322, getUtxos } = useWallet();
  const { satPerVb } = useFeeRates();
  // Which holding has its Send form open, and what is typed into it.
  const [sending, setSending] = useState<string | null>(null);
  const [sendAmount, setSendAmount] = useState("");
  const [sendTo, setSendTo] = useState("");
  // Which holding has its List form open, and what is typed into it.
  const [listing, setListing] = useState<string | null>(null);
  const [listAmount, setListAmount] = useState("");
  /** Asking price in sats per 1,000 tokens (the unit every price here uses). */
  const [listPricePer1k, setListPricePer1k] = useState("");
  const [listBlocks, setListBlocks] = useState("1008");
  // Per-token facts for the holdings: ticker, minted out, and market prices.
  const [tokenInfo, setTokenInfo] = useState<Record<string, TokenInfo>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Refetch when a new block is indexed: holdings change only then.
  const block = useIndexedBlock();

  useEffect(() => {
    if (demo) {
      setPortfolio(DEMO_PORTFOLIO as unknown as Portfolio);
      setLoaded(true);
      return;
    }
    if (!connected || !address) return;
    void refresh();
  }, [connected, address, demo, block]);

  async function refresh() {
    if (!address) return;
    if (demo) {
      setPortfolio(DEMO_PORTFOLIO as unknown as Portfolio);
      setLoaded(true);
      return;
    }
    // Holdings sit on the ordinals address; a wallet with one address for
    // everything falls back to it.
    try {
      const data = await fetchPortfolio(ordinalsAddress || address);
      setPortfolio(data as unknown as Portfolio);
      void loadTokenInfo(data.holdings.map((h) => h.tokenId));
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }

  /** Ticker, mint-out status, floor and vault price for each held token. */
  async function loadTokenInfo(tokenIds: string[]) {
    const entries = await Promise.all(
      tokenIds.map(async (id): Promise<[string, TokenInfo] | null> => {
        try {
          const [d, l, q] = await Promise.all([
            fetch(`/api/v3/tokens/${id}`).then((x) => x.json()),
            fetch(`/api/v3/market/listings?tokenId=${id}`).then((x) => x.json()),
            fetch("/api/v3/backing/redeem/quote", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tokenId: id, amountAtoms: (1_000n * 100_000_000n).toString() }),
            }).then((x) => x.json()),
          ]);
          if (!d.ok) return null;
          const asks = ((l.data ?? []) as { status: string; amountAtoms: string; totalPriceSats: string }[]).filter((a) => a.status === "ACTIVE");
          const floor = asks.length ? Math.min(...asks.map((a) => unitPriceSats(a.amountAtoms, a.totalPriceSats))) : null;
          return [id, {
            ticker: d.data.ticker,
            displayName: d.data.displayName ?? "",
            graduated: d.data.graduated ?? BigInt(d.data.issuedSupplyAtoms) >= BigInt(d.data.publicCapAtoms),
            floorPer1k: floor,
            vaultPer1k: q.ok ? Number(q.data.grossSats) : null,
          }];
        } catch {
          return null;
        }
      }),
    );
    setTokenInfo(Object.fromEntries(entries.filter((e): e is [string, TokenInfo] => e !== null)));
  }

  async function list(tokenId: string) {
    setErr("");
    setMsg("");
    const total = totalFor(listAmount, listPricePer1k);
    if (total === null) {
      setErr(t("wallet.enterBoth"));
      return;
    }
    setBusy(`list-${tokenId}`);
    try {
      const { listingId, pending } = await createListing({
        tokenId,
        amountAtoms: BigInt(displayTokensToAtoms(listAmount)),
        totalPriceSats: total.toString(),
        expiryBlocks: listBlocks,
        network,
        tokenAddress: ordinalsAddress || address!,
        walletFields: walletFields(),
        getUtxos,
        signPsbt,
        satPerVb,
      });
      setMsg(
        `${t("wallet.listed", { n: fmtInt(listAmount), sats: fmtInt(total), id: listingId.slice(0, 12) })} ` +
          (pending ? t("wallet.listedPending") : t("wallet.listedNoSign")),
      );
      setListing(null);
      setListAmount("");
      setListPricePer1k("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function send(tokenId: string) {
    setErr("");
    setMsg("");
    setBusy(`send-${tokenId}`);
    try {
      const txid = await sendTokens({
        tokenId,
        amountAtoms: displayTokensToAtoms(sendAmount),
        recipient: sendTo,
        network,
        walletFields: walletFields(),
        getUtxos,
        signPsbt,
        satPerVb,
      });
      setMsg(t("wallet.sent", { txid: txid.slice(0, 16) }));
      setSending(null);
      setSendAmount("");
      setSendTo("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancel(listingId: string) {
    setErr("");
    setBusy(listingId);
    try {
      const pr = await fetch(`/api/v3/market/listings/${listingId}/cancel/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const pj = await pr.json();
      if (!pj.ok) throw new Error(errorText(pj) || t("wallet.cancelPrepFailed"));
      const sig = await signBip322(pj.data.message);
      const cr = await fetch(`/api/v3/market/listings/${listingId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonceHex: pj.data.cancelNonce, signatureB64: sig }),
      });
      const cj = await cr.json();
      if (!cj.ok) throw new Error(errorText(cj) || t("wallet.cancelFailed"));
      setMsg(t("wallet.cancelled"));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!connected && !demo) {
    return (
      <div className="border border-dashed border-rule bg-ink-3 px-6 py-12 text-center">
        <p className="text-bone-dim">{t("wallet.connectToView")}</p>
        <button onClick={() => void connect()} className="mt-4 bg-signal px-6 py-3 text-bone hover:bg-[#F0A253]">{t("wallet.connect")}</button>
      </div>
    );
  }

  if (!loaded || !portfolio) return <div className="text-bone-dim">{err || t("wallet.loading")}</div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl text-bone">{t("wallet.title")}</h1>
        <p className="break-all font-mono text-xs text-bone-dim">{address}</p>
      </div>

      <section>
        <h2 className="text-lg text-bone">{t("wallet.holdings")}</h2>
        {portfolio.holdings.length === 0 ? (
          <p className="mt-2 text-sm text-bone-dim">{t("wallet.noHoldings")}</p>
        ) : (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {portfolio.holdings.map((h) => (
              <div key={h.tokenId} className="border border-rule bg-ink-2 p-4">
                <a href={`/token/${h.tokenId}`} className="block">
                  <div className="text-bone">
                    {tokenInfo[h.tokenId] ? (
                      <>
                        ${tokenInfo[h.tokenId]!.ticker}
                        {tokenInfo[h.tokenId]!.displayName ? <span className="text-bone-dim"> · {tokenInfo[h.tokenId]!.displayName}</span> : null}
                      </>
                    ) : (
                      "…"
                    )}
                  </div>
                  <div className="font-mono text-xs text-bone-dim">{h.tokenId.slice(0, 16)}…</div>
                  <div className="mt-1 text-xl text-bone">
                    {fmtTokens(BigInt(h.amountAtoms))}
                    {tokenInfo[h.tokenId] ? <span className="text-sm text-bone-dim"> {tokenInfo[h.tokenId]!.ticker}</span> : null}
                  </div>
                  <div className="text-xs text-bone-dim">{t(h.utxoCount === 1 ? "wallet.utxo" : "wallet.utxos", { n: h.utxoCount })}</div>
                </a>
                {sending === h.tokenId ? (
                  <div className="mt-3 space-y-2">
                    <input
                      aria-label={t("wallet.sendAmount")}
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      placeholder={t("wallet.sendAmountPh")}
                      className="field"
                    />
                    <input
                      aria-label={t("wallet.sendTo")}
                      value={sendTo}
                      onChange={(e) => setSendTo(e.target.value.trim())}
                      placeholder={t("wallet.sendToPh")}
                      className="field"
                    />
                    <div className="grid grid-cols-2 gap-px bg-rule">
                      <button onClick={() => setSending(null)} className="btn-ghost w-full border-0">{t("wallet.cancel")}</button>
                      <button onClick={() => void send(h.tokenId)} disabled={busy !== null} className="btn w-full">
                        {busy === `send-${h.tokenId}` ? t("wallet.sending") : t("wallet.send")}
                      </button>
                    </div>
                  </div>
                ) : listing === h.tokenId ? (
                  <ListForm
                    holding={h}
                    info={tokenInfo[h.tokenId]}
                    amount={listAmount}
                    setAmount={setListAmount}
                    per1k={listPricePer1k}
                    setPer1k={setListPricePer1k}
                    blocks={listBlocks}
                    setBlocks={setListBlocks}
                    busy={busy === `list-${h.tokenId}`}
                    disabled={busy !== null}
                    onCancel={() => setListing(null)}
                    onList={() => void list(h.tokenId)}
                  />
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => setSending(h.tokenId)} className="border border-rule px-3 py-1.5 text-xs text-bone-2 hover:text-bone">
                      {t("wallet.send")}
                    </button>
                    {tokenInfo[h.tokenId]?.graduated === false ? (
                      <span className="self-center text-xs text-bone-dim">
                        {t("wallet.listOpens", { ticker: tokenInfo[h.tokenId]!.ticker })}
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setSending(null);
                          setListing(h.tokenId);
                          setListAmount(String(BigInt(h.amountAtoms) / 100_000_000n));
                          const info = tokenInfo[h.tokenId];
                          const ref = info?.floorPer1k ?? info?.vaultPer1k;
                          setListPricePer1k(ref ? String(Math.ceil(ref)) : "");
                        }}
                        disabled={!tokenInfo[h.tokenId]}
                        className="border border-rule px-3 py-1.5 text-xs text-bone-2 hover:text-bone disabled:opacity-40"
                      >
                        {t("wallet.list")}
                      </button>
                    )}
                  </div>
                )}              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg text-bone">{t("wallet.myListings")}</h2>
        {portfolio.listings.length === 0 ? (
          <p className="mt-2 text-sm text-bone-dim">{t("wallet.noListings")}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {portfolio.listings.map((l) => (
              <div key={l.listingId} className="flex items-center justify-between border border-rule bg-ink-2 p-3 text-sm">
                <div>
                  <div className="text-bone">
                    {fmtTokens(BigInt(l.amountAtoms))} {tokenInfo[l.tokenId]?.ticker ?? `${l.tokenId.slice(0, 8)}…`} @ {fmtBtc(BigInt(l.totalPriceSats))}
                  </div>
                  <div className="text-xs text-bone-dim">{isMessageKey(`lst.${l.status}`) ? t(`lst.${l.status}` as MessageKey) : l.status}</div>
                </div>
                {l.status === "ACTIVE" && (
                  <button onClick={() => void cancel(l.listingId)} disabled={busy === l.listingId} className="border border-rule px-3 py-1.5 text-xs text-bone-2 hover:border-danger hover:text-danger disabled:opacity-50">
                    {t("wallet.cancelListing")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {msg && <p className="text-sm text-success">{msg}</p>}
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

/** The List form: amount, price per 1,000 with market references, expiry. */
function ListForm(props: {
  holding: { tokenId: string; amountAtoms: string };
  info: TokenInfo | undefined;
  amount: string;
  setAmount: (v: string) => void;
  per1k: string;
  setPer1k: (v: string) => void;
  blocks: string;
  setBlocks: (v: string) => void;
  busy: boolean;
  disabled: boolean;
  onCancel: () => void;
  onList: () => void;
}) {
  const t = useT();
  const { info } = props;
  const held = BigInt(props.holding.amountAtoms) / 100_000_000n;
  const total = totalFor(props.amount, props.per1k);
  const per1k = /^\d+$/.test(props.per1k) ? Number(props.per1k) : null;
  const belowVault = per1k !== null && info?.vaultPer1k != null && per1k < info.vaultPer1k;
  return (
    <div className="mt-3 space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-px bg-rule">
        <button
          onClick={() => info?.floorPer1k != null && props.setPer1k(String(Math.ceil(info.floorPer1k)))}
          disabled={info?.floorPer1k == null}
          className="bg-ink-3 px-3 py-2 text-left disabled:opacity-60"
        >
          <div className="text-bone-dim">{t("wallet.floorLowest")}</div>
          <div className="text-bone">{info?.floorPer1k != null ? t("wallet.per1k", { n: fmtInt(Math.ceil(info.floorPer1k)) }) : t("wallet.noAsksYet")}</div>
        </button>
        <button
          onClick={() => info?.vaultPer1k != null && props.setPer1k(String(Math.ceil(info.vaultPer1k)))}
          disabled={info?.vaultPer1k == null}
          className="bg-ink-3 px-3 py-2 text-left disabled:opacity-60"
        >
          <div className="text-bone-dim">{t("wallet.vaultBuys")}</div>
          <div className="text-bone">{info?.vaultPer1k != null ? t("wallet.per1k", { n: fmtInt(info.vaultPer1k) }) : "—"}</div>
        </button>
      </div>
      <label className="block text-bone-dim">
        {t("wallet.tokensToList")} <span className="text-bone-dim">{t("wallet.youHold", { n: fmtInt(held) })}</span>
        <div className="mt-1 flex gap-2">
          <input aria-label={t("wallet.listAmount")} value={props.amount} onChange={(e) => props.setAmount(e.target.value.trim())} inputMode="numeric" className="field" />
          <button onClick={() => props.setAmount(String(held))} className="border border-rule px-3 text-bone-2 hover:text-bone">{t("wallet.all")}</button>
        </div>
      </label>
      <label className="block text-bone-dim">
        {t("wallet.pricePer1k")}
        <input aria-label={t("wallet.pricePer1kAria")} value={props.per1k} onChange={(e) => props.setPer1k(e.target.value.trim())} inputMode="numeric" className="field mt-1" />
      </label>
      <label className="block text-bone-dim">
        {t("wallet.lasts")}
        <select value={props.blocks} onChange={(e) => props.setBlocks(e.target.value)} className="field mt-1">
          <option value="144">{t("wallet.day")}</option>
          <option value="1008">{t("wallet.week")}</option>
          <option value="4320">{t("wallet.month")}</option>
        </select>
      </label>
      <div className="flex justify-between text-sm">
        <span className="text-bone-dim">{t("wallet.youReceive")}</span>
        <span className="tabular-nums text-bone">{total !== null ? t("wallet.sats", { n: fmtInt(total) }) : "—"}</span>
      </div>
      <p className="text-bone-dim">{t("wallet.feeNote")}</p>
      {belowVault ? <p className="text-pending">{t("wallet.belowVault")}</p> : null}
      <div className="grid grid-cols-2 gap-px bg-rule">
        <button onClick={props.onCancel} className="btn-ghost w-full border-0">{t("wallet.cancel")}</button>
        <button onClick={props.onList} disabled={props.disabled || total === null} className="btn w-full">
          {props.busy ? t("wallet.listing") : t("wallet.list")}
        </button>
      </div>
    </div>
  );
}

function SuspenseLoading() {
  const t = useT();
  return <div className="panel px-6 py-16 text-center text-sm text-bone-dim">{t("common.loading")}</div>;
}

/**
 * useSearchParams opts this route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary.
 */
export default function WalletPage() {
  return (
    <Suspense fallback={<SuspenseLoading />}>
      <WalletContent />
    </Suspense>
  );
}
