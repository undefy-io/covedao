"use client";

import { useT } from "@/i18n/LanguageProvider";
import { useEffect } from "react";
import { useWallet } from "./WalletProvider";
import { DEV_WALLET_STORAGE_KEY } from "@/lib/wallets/dev";

/**
 * Keeps a built-in regtest wallet (alice, bob, carol) connected across page
 * loads, and shows which one is active.
 *
 * The wallets themselves are picked in `WalletPicker`. This reconnects the last
 * one used, or the one named by `?wallet=alice|bob|carol`. It does nothing
 * unless the server confirms the dev wallet is enabled (regtest, dev build,
 * COVE_DEV_WALLET=true); otherwise the app behaves exactly as in production.
 */
export function DevWallet() {
  const { connected, connectDev, devIdentity, address } = useWallet();
  const t = useT();

  useEffect(() => {
    if (connected) return;
    let name: string | null = null;
    try {
      const requested = new URL(window.location.href).searchParams.get("wallet");
      if (requested) window.localStorage.setItem(DEV_WALLET_STORAGE_KEY, requested);
      name = requested ?? window.localStorage.getItem(DEV_WALLET_STORAGE_KEY);
    } catch {
      return;
    }
    if (!name) return;
    void connectDev(name).catch(() => {
      /* dev wallet is off; stay disconnected */
    });
    // Only on first load: after that, connecting and switching go through the picker.
  }, []);

  if (!devIdentity) return null;

  return (
    <div className="fixed bottom-14 right-4 z-50 border border-pending/40 bg-pending/10 px-3 py-2 text-label uppercase tracking-label text-pending">
      {t("dev.badge", { name: devIdentity, address: address.slice(0, 10) })}
    </div>
  );
}
