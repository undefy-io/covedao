"use client";

import { useEffect, useRef, useState } from "react";
import * as core from "@crclaunch/crc20-protocol";
import { fetchAllCrcWalletBalances, type CrcWalletBalance } from "@/lib/crc-client";
import { parseCrcMarketQuantity } from "@/lib/crc-market-amount";
import {
  loadCrcSellerSnapshot,
  prepareCrcAmountListing,
  reviewCrcAmountListing,
  type AmountListingReview,
  type SellerSnapshot,
} from "@/lib/crc-market-listing";
import { crcBrowserData, type CrcRequest } from "@/lib/crc-browser-session";
import { crcIndexedRefresh } from "@/lib/crc-indexed-refresh";
import { cancelCrcMarketListing, type CrcMarketListing } from "@/lib/crc-market-client";
import { formatAtoms } from "./CrcHome";
import { useWallet } from "./WalletProvider";

export function CrcMarketSeller() {
  const wallet = useWallet();
  const identity = JSON.stringify([
    wallet.connected,
    wallet.network,
    wallet.address,
    wallet.script,
    wallet.publicKey,
    wallet.ordinalsAddress,
    wallet.ordinalsScript,
    wallet.ordinalsPublicKey,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0);
  const action = useRef<AbortController | null>(null);
  const [active, setActive] = useState(false);
  const [balances, setBalances] = useState<CrcWalletBalance[]>([]);
  const [assetId, setAssetId] = useState("");
  const [snapshot, setSnapshot] = useState<SellerSnapshot | null>(null);
  const [listings, setListings] = useState<CrcMarketListing[]>([]);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [expiry, setExpiry] = useState("12");
  const [review, setReview] = useState<AmountListingReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    generation.current++;
    action.current?.abort();
    action.current = null;
    setReview(null);
    setBusy(false);
    setSnapshot(null);
    setError("");
    setSuccess("");
    return () => {
      generation.current++;
      action.current?.abort();
      action.current = null;
    };
  }, [identity, assetId]);

  useEffect(() => {
    const controller = new AbortController();
    const request: CrcRequest = async (url, init) => {
      controller.signal.throwIfAborted();
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15_000),
        ]),
      });
      controller.signal.throwIfAborted();
      if (currentIdentity.current !== identity) throw new Error("Wallet changed");
      return response;
    };
    const stop = crcIndexedRefresh.subscribe(
      async (signal) => {
        signal.throwIfAborted();
        try {
          const market = await crcBrowserData<{ active: boolean; listings: CrcMarketListing[] }>(
            request,
            `/api/crc/v1/market/listings${wallet.connected ? `?sellerScriptHex=${encodeURIComponent(wallet.ordinalsScript)}` : ""}`,
          );
          controller.signal.throwIfAborted();
          setActive(market.active);
          if (!wallet.connected || !market.active) {
            setBalances([]);
            setListings([]);
            setSnapshot(null);
            return;
          }
          const [held, loaded] = await Promise.all([
            fetchAllCrcWalletBalances(wallet.ordinalsAddress, request),
            assetId ? loadCrcSellerSnapshot(assetId, wallet, request) : Promise.resolve(null),
          ]);
          controller.signal.throwIfAborted();
          signal.throwIfAborted();
          setBalances(held);
          setListings(market.listings);
          setSnapshot(loaded);
          if (!assetId) setAssetId(held[0]?.assetId || "");
        } catch (cause) {
          if (!controller.signal.aborted && !signal.aborted)
            setError(cause instanceof Error ? cause.message : "Could not read seller balance");
          throw cause;
        }
      },
      (cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not read indexed status");
      },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [identity, assetId, revision, wallet]);

  function invalidate() {
    generation.current++;
    action.current?.abort();
    setReview(null);
    setError("");
    setSuccess("");
  }
  async function run(work: (request: CrcRequest, guard: () => void) => Promise<void>) {
    if (action.current) return;
    const controller = new AbortController(),
      version = generation.current,
      owner = identity;
    action.current = controller;
    setBusy(true);
    setError("");
    setSuccess("");
    const guard = () => {
      controller.signal.throwIfAborted();
      if (currentIdentity.current !== owner || generation.current !== version)
        throw new Error("Wallet or listing terms changed. Review again.");
    };
    const request: CrcRequest = async (url, init) => {
      guard();
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15_000),
        ]),
      });
      guard();
      return response;
    };
    try {
      await work(request, guard);
      guard();
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        currentIdentity.current === owner &&
        generation.current === version
      )
        setError(cause instanceof Error ? cause.message : "Could not create listing");
    } finally {
      if (action.current === controller) {
        action.current = null;
        setBusy(false);
      }
    }
  }
  function reviewAmount() {
    void run(async (request, guard) => {
      if (!/^[1-9]\d{0,15}$/.test(price)) throw new Error("Enter a total price in whole satoshis");
      if (!/^[1-9]\d{0,3}$/.test(expiry) || Number(expiry) > 2016)
        throw new Error("Expiry must be 1 to 2,016 blocks");
      const next = await reviewCrcAmountListing(
        {
          assetId,
          amountAtoms: parseCrcMarketQuantity(amount),
          priceSats: BigInt(price),
          expiryBlocks: Number(expiry),
        },
        wallet,
        request,
        guard,
      );
      guard();
      setReview(next);
    });
  }
  function submit() {
    if (!review) return;
    void run(async (request, guard) => {
      const result = await prepareCrcAmountListing(review, wallet, request, guard);
      guard();
      setSuccess(
        `Listing transaction submitted: ${result.txid}. Your offer will appear automatically after confirmation and indexing.`,
      );
      setReview(null);
      setAmount("");
      setRevision((value) => value + 1);
      window.dispatchEvent(new Event("crc-market-listings-changed"));
    });
  }
  function cancel(row: CrcMarketListing) {
    void run(async (request, guard) => {
      await cancelCrcMarketListing(
        row,
        {
          ...wallet,
          signPsbt: async (psbt, operation) => {
            guard();
            const result = await wallet.signPsbt(psbt, operation);
            guard();
            return result;
          },
        },
        1000,
        request,
      );
      guard();
      setSuccess("Cancellation submitted. Tokens become available after confirmation.");
      setRevision((value) => value + 1);
    });
  }
  const blocked = new Set(snapshot?.unavailableOutpoints.map(core.outpoint));
  const held = snapshot?.coins.reduce((sum, c) => sum + BigInt(c.atoms), 0n) || 0n;
  const listed =
    snapshot?.coins
      .filter((c) => blocked.has(core.outpoint(c)))
      .reduce((sum, c) => sum + BigInt(c.atoms), 0n) || 0n;
  const locked = busy;
  return (
    <section
      className="space-y-4 border border-rule bg-ink-2 p-6"
      aria-label="Create token listing"
    >
      <div>
        <h2 className="text-lg text-bone">Sell tokens</h2>
        <p className="mt-1 text-sm text-bone-dim">
          Choose how many tokens to sell and your total BTC price. Buyers complete published offers
          without another seller approval.
        </p>
      </div>
      {!wallet.connected && active && (
        <button type="button" className="btn" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      )}
      {wallet.connected && active && (
        <>
          <label className="block text-sm text-bone-dim">
            Token
            <select
              className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone"
              disabled={locked}
              value={assetId}
              onChange={(event) => {
                invalidate();
                setAmount("");
                setAssetId(event.target.value);
              }}
            >
              {balances.map((balance) => (
                <option key={balance.assetId} value={balance.assetId}>
                  ${balance.ticker} · {formatAtoms(balance.atoms)} tokens
                </option>
              ))}
            </select>
          </label>
          {!balances.length && (
            <p className="text-sm text-bone-dim">No confirmed Cove tokens in this wallet.</p>
          )}
          {snapshot && (
            <p className="text-sm text-bone-dim">
              Confirmed: {formatAtoms(held.toString())} · Already listed:{" "}
              {formatAtoms(listed.toString())} · Available:{" "}
              {formatAtoms((held - listed).toString())}
              {snapshot.truncated ? " · Balance incomplete" : ""}
            </p>
          )}
          <label className="block text-sm text-bone-dim">
            Amount to sell
            <input
              className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone"
              inputMode="decimal"
              placeholder="300"
              disabled={locked}
              value={amount}
              onChange={(event) => {
                invalidate();
                setAmount(event.target.value);
              }}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-bone-dim">
              Total price (sats)
              <input
                className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone"
                inputMode="numeric"
                disabled={locked}
                value={price}
                onChange={(event) => {
                  invalidate();
                  setPrice(event.target.value);
                }}
              />
            </label>
            <label className="block text-sm text-bone-dim">
              Expiry (blocks)
              <input
                className="mt-2 block w-full border border-rule bg-ink px-3 py-2 text-bone"
                inputMode="numeric"
                disabled={locked}
                value={expiry}
                onChange={(event) => {
                  invalidate();
                  setExpiry(event.target.value);
                }}
              />
            </label>
          </div>
          <button
            type="button"
            className="btn-ghost"
            disabled={!snapshot || snapshot.truncated || busy}
            onClick={reviewAmount}
          >
            {busy ? "Working…" : "Review listing"}
          </button>
          {review && (
            <div className="space-y-2 border-t border-rule pt-4 text-sm text-bone-dim">
              <p>
                Sell: {formatAtoms(review.amountAtoms.toString())} ${snapshot?.token.ticker}
              </p>
              <p>Total BTC payout: {review.priceSats} sats</p>
              <p>Buyer pays protocol fee: {core.marketFee(review.priceSats).toString()} sats</p>
              <p>Tokens returned as change: {formatAtoms(review.changeAtoms.toString())}</p>
              <p>Estimated network fee: {String(review.built?.intent.minerFeeSats)} sats</p>
              <p>
                {review.walletDeltaSats >= 0n
                  ? "BTC used from your payment wallet"
                  : "BTC returned to your payment wallet"}
                :{" "}
                {(review.walletDeltaSats < 0n
                  ? -review.walletDeltaSats
                  : review.walletDeltaSats
                ).toString()}{" "}
                sats, including token output costs.
              </p>
              <p>
                Approve one transaction to place these tokens in marketplace custody. Your listing
                appears automatically after confirmation and expires at block{" "}
                {review.escrowTerms?.expiryHeight}. No further seller approval is needed to sell.
              </p>
              <button type="button" className="btn" disabled={busy || !active} onClick={submit}>
                {busy ? "Working…" : "Sign and list"}
              </button>
            </div>
          )}
          {!!listings.length && (
            <div className="border-t border-rule pt-4">
              <h3 className="text-sm text-bone">Your listings</h3>
              {listings.map((row) => (
                <div
                  key={row.id}
                  className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm text-bone-dim"
                >
                  <span>
                    {formatAtoms(row.amountAtoms)} ${row.ticker} · {row.priceSats} sats
                    {row.status !== "OPEN" ? " · Cancellation pending" : ""}
                  </span>
                  {row.status === "OPEN" && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => cancel(row)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {!active && <p className="text-sm text-bone-dim">Marketplace trading is currently paused.</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="break-all text-sm text-signal">
          {success}
        </p>
      )}
    </section>
  );
}
