"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { NETWORK as COVE_NETWORK } from "@/lib/network";
import type { WalletCapabilities } from "@crclaunch/wallets";
import { adapterFor, inputsOwnedBy } from "@/lib/wallets/adapters";
import { LISTING_SIGHASH } from "@crclaunch/wallets";
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
  getUtxos: () => Promise<{ txid: string; vout: number }[]>;
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
      if (!test) throw new WalletError("FAILED", "dev wallet did not install");
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
      if (!conn) throw new WalletError("FAILED", "No wallet connected");
      if (conn.isTestWallet) {
        const test = getTestWallet();
        if (!test) throw new WalletError("FAILED", "No wallet connected");
        return test.signPsbt({ psbtBase64, operation });
      }
      // Tell the wallet exactly which inputs are its own. The backing vault
      // input belongs to neither address, so it is never offered — the
      // Guardian has already signed it and a second signature would only
      // invalidate the transaction.
      const inputsByAddress = inputsOwnedBy(psbtBase64, NETWORK, conn);
      if (inputsByAddress.length === 0) {
        throw new WalletError("FAILED", "this transaction has no inputs belonging to your wallet");
      }
      return adapterFor(conn.walletId as WalletId).signPsbt(NETWORK, {
        psbtBase64,
        inputsByAddress,
        // A listing is presigned SIGHASH_SINGLE|ANYONECANPAY; everything else is SIGHASH_ALL.
        sighashType: operation === "P2P_LIST" ? LISTING_SIGHASH : undefined,
      });
    },
    [conn],
  );

  const signBip322 = useCallback(
    async (message: string) => {
      if (!conn) throw new WalletError("FAILED", "No wallet connected");
      if (conn.isTestWallet) {
        const test = getTestWallet();
        if (!test?.signBip322Simple) {
          throw new WalletError("UNSUPPORTED", "Wallet does not support BIP-322");
        }
        return test.signBip322Simple({ message });
      }
      // Marketplace orders are authorised by the address that holds the
      // tokens, which is the ordinals address.
      return adapterFor(conn.walletId as WalletId).signMessage(
        NETWORK,
        conn.ordinals.address,
        message,
      );
    },
    [conn],
  );

  const getUtxos = useCallback(async () => {
    if (!conn) return [];
    if (conn.isTestWallet) {
      const test = getTestWallet();
      return test?.getUtxos ? test.getUtxos() : [];
    }
    // From Cove's own node, not the wallet: the server re-resolves every
    // outpoint against Core at build time, and a list from somewhere else
    // just produces failures nobody can explain.
    const r = await fetch(`/api/v3/wallet/utxos?address=${encodeURIComponent(conn.payments.address)}`);
    const j = await r.json();
    if (!j.ok) throw new WalletError("FAILED", j.error?.detail || j.error?.message || "cannot list your coins");
    return (j.data.utxos as { txid: string; vout: number }[]).map((u) => ({
      txid: u.txid,
      vout: u.vout,
    }));
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
      walletFields,
      pickerOpen,
      openPicker: () => setPickerOpen(true),
      closePicker: () => setPickerOpen(false),
    }),
    [conn, capabilities, connect, connectDev, devIdentity, disconnect, signPsbt, signBip322, getUtxos, walletFields, pickerOpen],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
