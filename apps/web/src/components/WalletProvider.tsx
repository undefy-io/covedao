"use client";

import { crcWalletData } from "@/lib/crc-wallet-data";
import { tr } from "@/i18n";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NETWORK as COVE_NETWORK } from "@/lib/network";
import { selectFundingCandidates, type WalletFundingCoin } from "@/lib/funding-candidates";
import type { WalletCapabilities } from "@crclaunch/wallets";
import { adapterFor, inputsOwnedBy } from "@/lib/wallets/adapters";
import { Transaction } from "bitcoinjs-lib";
const LISTING_SIGHASH = Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY;
import { WalletError, type CoveNetwork, type WalletId } from "@/lib/wallets/types";
import {
  DEV_WALLET_ID,
  DEV_WALLET_STORAGE_KEY,
  fetchDevIdentity,
  installDevWallet,
  removeDevWallet,
} from "@/lib/wallets/dev";

/**
 * The connected wallet.
 *
 * Two addresses, not one. `script` is the PAYMENTS address — where BTC comes
 * from and change returns. `ordinalsScript` is where token carriers live, and
 * in most wallets it is a different, Taproot address. Code that only knows
 * about the first will build transactions those wallets cannot sign.
 */
interface WalletState {
  connected: boolean;
  /** Payments address. */
  address: string;
  /** Payments scriptPubKey, hex. */
  script: string;
  /** Payments public key, hex. Needed to spend anything but native segwit. */
  publicKey: string;
  /** Ordinals address — where tokens are held. */
  ordinalsAddress: string;
  /** Ordinals scriptPubKey, hex. */
  ordinalsScript: string;
  ordinalsPublicKey: string;
  adapterId: string;
  network: string;
  capabilities: WalletCapabilities | null;
  /** Open the picker, or connect a named wallet directly. */
  connect: (walletId?: WalletId) => Promise<void>;
  /** Connect a built-in regtest wallet (alice, bob, carol). */
  connectDev: (identity: string) => Promise<void>;
  /** The connected built-in regtest wallet's name, or "" for any other wallet. */
  devIdentity: string;
  disconnect: () => void;
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>;
  signBip322: (message: string) => Promise<string>;
  getUtxos: (confirmedOnly?: boolean) => Promise<{ txid: string; vout: number }[]>;
  getUtxosForAddress: (address: string, confirmedOnly?: boolean) => Promise<{ txid: string; vout: number }[]>;
  /** Everything a build needs to describe this wallet to the server. */
  walletFields: () => {
    walletScript: string;
    walletAddress: string;
    walletPublicKey?: string;
    ordinalsScript?: string;
    ordinalsPublicKey?: string;
  };
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * The regtest test signer.
 *
 * No browser wallet supports regtest, so the local harness and the end-to-end
 * suite inject this instead. It is only ever present when something has put it
 * on `window`; nothing auto-attaches it.
 */
interface TestWallet {
  id: string;
  connect(): Promise<{
    adapterId: string;
    paymentAddress: string;
    paymentScript: string;
    paymentPublicKey?: string;
    /** A two-address signer (shaped like Xverse); absent for a single-address one. */
    ordinalsAddress?: string;
    ordinalsScript?: string;
    ordinalsPublicKey?: string;
    network: string;
    capabilities: WalletCapabilities;
  }>;
  disconnect?(): Promise<void>;
  signPsbt(params: { psbtBase64: string; inputIndexes?: number[]; operation: string }): Promise<string>;
  signBip322Simple?(params: { message: string }): Promise<string>;
  getUtxos?(): Promise<{ txid: string; vout: number }[]>;
  getUtxosForAddress?(address: string): Promise<{ txid: string; vout: number }[]>;
}

function getTestWallet(): TestWallet | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __COVE_TEST_WALLET__?: TestWallet }).__COVE_TEST_WALLET__ ?? null;
}

const NETWORK = COVE_NETWORK as CoveNetwork;
const STORAGE_KEY = "cove.wallet";

interface Connected {
  walletId: string;
  payments: { address: string; script: string; publicKey: string };
  ordinals: { address: string; script: string; publicKey: string };
  isTestWallet: boolean;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [conn, setConn] = useState<Connected | null>(null);
  const liveConnection = useRef<Connected | null>(null);
  useEffect(() => { liveConnection.current = conn; }, [conn]);
  const [capabilities, setCapabilities] = useState<WalletCapabilities | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devIdentity, setDevIdentity] = useState("");

  const connectTestWallet = useCallback(async (wallet: TestWallet) => {
    const c = await wallet.connect();
    const account = { address: c.paymentAddress, script: c.paymentScript, publicKey: c.paymentPublicKey ?? "" };
    setConn({
      walletId: c.adapterId,
      // A single-address signer uses the same address for both roles, which is
      // legitimate: plenty of native-segwit wallets work that way.
      payments: account,
      ordinals: c.ordinalsAddress && c.ordinalsScript
        ? { address: c.ordinalsAddress, script: c.ordinalsScript, publicKey: c.ordinalsPublicKey ?? "" }
        : account,
      isTestWallet: true,
    });
    setCapabilities(c.capabilities);
  }, []);

  const connect = useCallback(
    async (walletId?: WalletId) => {
      // A harness-injected test signer wins when present: it is only there on
      // a regtest harness, where no browser wallet can connect anyway. The
      // built-in dev wallets are picked in the picker instead, so they can be
      // switched.
      const test = getTestWallet();
      if (test && test.id !== DEV_WALLET_ID) {
        await connectTestWallet(test);
        return;
      }
      if (!walletId) {
        setPickerOpen(true);
        return;
      }
      const adapter = adapterFor(walletId);
      const c = await adapter.connect(NETWORK);
      setConn({
        walletId: c.walletId,
        payments: c.payments,
        ordinals: c.ordinals,
        isTestWallet: false,
      });
      setCapabilities(null);
      setPickerOpen(false);
      try {
        window.localStorage.setItem(STORAGE_KEY, c.walletId);
      } catch {
        // A blocked localStorage costs a reconnect, nothing more.
      }
    },
    [connectTestWallet],
  );

  const connectDev = useCallback(
    async (identity: string) => {
      const id = await fetchDevIdentity(identity);
      installDevWallet(id);
      const test = getTestWallet();
      if (!test) throw new WalletError("FAILED", tr("wal.devNotInstalled"));
      await connectTestWallet(test);
      setDevIdentity(id.identity);
      setPickerOpen(false);
      try {
        window.localStorage.setItem(DEV_WALLET_STORAGE_KEY, id.identity);
      } catch {
        // A blocked localStorage costs a reconnect, nothing more.
      }
    },
    [connectTestWallet],
  );

  const disconnect = useCallback(() => {
    liveConnection.current = null;
    if (conn?.walletId === DEV_WALLET_ID) removeDevWallet();
    setConn(null);
    setCapabilities(null);
    setDevIdentity("");
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(DEV_WALLET_STORAGE_KEY);
    } catch {
      // ignored
    }
  }, [conn]);

  // Reconnect silently to the wallet last used, but only if it is still
  // installed and still willing. A failure here is not an error the user needs
  // to see — they simply stay disconnected.
  useEffect(() => {
    if (conn || getTestWallet()) return;
    let cancelled = false;
    void (async () => {
      let last: string | null = null;
      try {
        last = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        return;
      }
      if (!last) return;
      try {
        const adapter = adapterFor(last as WalletId);
        if (!(await adapter.isInstalled())) return;
        const c = await adapter.connect(NETWORK);
        if (!cancelled) {
          setConn({ walletId: c.walletId, payments: c.payments, ordinals: c.ordinals, isTestWallet: false });
        }
      } catch {
        // Still disconnected; the picker is one click away.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn]);

  const signPsbt = useCallback(
    async (psbtBase64: string, operation: string) => {
      if (!conn || liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
      if (conn.isTestWallet) {
        const test = getTestWallet();
        if (!test) throw new WalletError("FAILED", tr("wal.noWallet"));
        const response = await test.signPsbt({ psbtBase64, operation });
        if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
        return response;
      }
      // Tell the wallet exactly which inputs are its own. The backing vault
      // input belongs to neither address, so it is never offered — the
      // Guardian signs it after wallet submission. Finalized seller witnesses
      // are also excluded from the wallet signing request.
      const inputsByAddress = inputsOwnedBy(psbtBase64, NETWORK, conn);
      if (inputsByAddress.length === 0) {
        throw new WalletError("FAILED", tr("wal.noInputs"));
      }
      const response = await adapterFor(conn.walletId as WalletId).signPsbt(NETWORK, {
        psbtBase64,
        inputsByAddress,
        // A listing is presigned SIGHASH_SINGLE|ANYONECANPAY; everything else is SIGHASH_ALL.
        sighashType: operation === "P2P_LIST" ? LISTING_SIGHASH : undefined,
        assertCurrent: () => { if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet")); },
      });
      if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
      return response;
    },
    [conn],
  );

  const signBip322 = useCallback(
    async (message: string) => {
      if (!conn || liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
      if (conn.isTestWallet) {
        const test = getTestWallet();
        if (!test?.signBip322Simple) {
          throw new WalletError("UNSUPPORTED", tr("wal.noBip322"));
        }
        const response = await test.signBip322Simple({ message });
        if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
        return response;
      }
      // Marketplace orders are authorised by the address that holds the
      // tokens, which is the ordinals address.
      const response = await adapterFor(conn.walletId as WalletId).signMessage(
        NETWORK,
        conn.ordinals.address,
        message,
        () => { if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet")); },
      );
      if (liveConnection.current !== conn) throw new WalletError("FAILED", tr("wal.noWallet"));
      return response;
    },
    [conn],
  );

  const getUtxos = useCallback(async (confirmedOnly = false) => {
    if (!conn) return [];
    if (conn.isTestWallet) {
      const test = getTestWallet();
      return test?.getUtxos ? selectFundingCandidates(await test.getUtxos(), confirmedOnly) : [];
    }
    const coins = await crcWalletData(NETWORK).coins(conn.payments.address);
    return selectFundingCandidates(coins, confirmedOnly);
  }, [conn]);

  const getUtxosForAddress = useCallback(async (walletAddress: string, confirmedOnly = false) => {
    if (!conn) return [];
    if (conn.isTestWallet) {
      const test = getTestWallet();
      if (test?.getUtxosForAddress) return selectFundingCandidates(await test.getUtxosForAddress(walletAddress), confirmedOnly);
      return test?.getUtxos ? selectFundingCandidates(await test.getUtxos(), confirmedOnly) : [];
    }
    const observed = await crcWalletData(NETWORK).coins(walletAddress);
    const coins = (observed as WalletFundingCoin[]).filter((coin) =>
      !confirmedOnly || coin.confirmations === undefined || coin.confirmations > 0);
    return coins.sort((a, b) => {
      const left = BigInt(a.valueSats ?? "0");
      const right = BigInt(b.valueSats ?? "0");
      return left < right ? -1 : left > right ? 1 : 0;
    }).slice(0, 256).map(({ txid, vout }) => ({ txid, vout }));

  }, [conn]);

  const walletFields = useCallback(() => {
    if (!conn) return { walletScript: "", walletAddress: "" };
    return {
      walletScript: conn.payments.script,
      walletAddress: conn.payments.address,
      walletPublicKey: conn.payments.publicKey || undefined,
      ordinalsScript: conn.ordinals.script,
      ordinalsPublicKey: conn.ordinals.publicKey || undefined,
    };
  }, [conn]);

  const value = useMemo(
    () => ({
      connected: conn !== null,
      address: conn?.payments.address ?? "",
      script: conn?.payments.script ?? "",
      publicKey: conn?.payments.publicKey ?? "",
      ordinalsAddress: conn?.ordinals.address ?? "",
      ordinalsScript: conn?.ordinals.script ?? "",
      ordinalsPublicKey: conn?.ordinals.publicKey ?? "",
      adapterId: conn?.walletId ?? "",
      network: NETWORK,
      capabilities,
      connect,
      connectDev,
      devIdentity,
      disconnect,
      signPsbt,
      signBip322,
      getUtxos,
      getUtxosForAddress,
      walletFields,
      pickerOpen,
      openPicker: () => setPickerOpen(true),
      closePicker: () => setPickerOpen(false),
    }),
    [conn, capabilities, connect, connectDev, devIdentity, disconnect, signPsbt, signBip322, getUtxos, getUtxosForAddress, walletFields, pickerOpen],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
