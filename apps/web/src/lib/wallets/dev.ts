/**
 * The built-in regtest wallets (alice, bob, carol).
 *
 * No browser wallet supports regtest, so locally the app signs through
 * `/api/dev/wallet`, which holds the PUBLIC regtest fixture keys. That endpoint
 * refuses outside regtest, outside a dev build, and without COVE_DEV_WALLET=true,
 * so none of this does anything in a real deployment.
 *
 * Installing one sets `window.__COVE_TEST_WALLET__`, the same hook the
 * Playwright suite uses, so `WalletProvider` signs through it unchanged.
 */

export const DEV_WALLET_ID = "dev";
export const DEV_WALLET_STORAGE_KEY = "cove.devWallet.identity";

export interface DevIdentity {
  identity: string;
  address: string;
  script: string;
  publicKey: string;
}

export interface DevIdentityWithBalance extends DevIdentity {
  balanceSats: number;
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch("/api/dev/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.message ?? "dev wallet request failed");
  return j.data as Record<string, unknown>;
}

/** Every identity with its spendable BTC, or null when the dev wallet is off. */
export async function listDevIdentities(): Promise<DevIdentityWithBalance[] | null> {
  try {
    const j = await (await fetch("/api/dev/wallet")).json();
    return j.ok ? (j.data.identities as DevIdentityWithBalance[]) : null;
  } catch {
    return null;
  }
}

export async function fetchDevIdentity(name: string): Promise<DevIdentity> {
  const j = await (await fetch(`/api/dev/wallet?identity=${encodeURIComponent(name)}`)).json();
  if (!j.ok) throw new Error(j.error?.message ?? "dev wallet is not available");
  return j.data as DevIdentity;
}

export function installDevWallet(id: DevIdentity): void {
  (window as unknown as Record<string, unknown>).__COVE_TEST_WALLET__ = {
    id: DEV_WALLET_ID,
    connect: async () => ({
      adapterId: DEV_WALLET_ID,
      paymentAddress: id.address,
      paymentScript: id.script,
      paymentPublicKey: id.publicKey,
      network: "regtest",
      capabilities: {
        psbt: true,
        bip322Simple: true,
        p2wpkh: true,
        p2tr: false,
        utxoDiscovery: true,
      },
    }),
    signPsbt: async (p: { psbtBase64: string }) =>
      (await post({ action: "signPsbt", identity: id.identity, psbtBase64: p.psbtBase64 }))
        .signedPsbtBase64 as string,
    signBip322Simple: async (p: { message: string }) =>
      (await post({ action: "signBip322", identity: id.identity, message: p.message }))
        .signatureB64 as string,
    getUtxos: async () =>
      (await post({ action: "getUtxos", identity: id.identity })).utxos as unknown,
  };
}

export function removeDevWallet(): void {
  delete (window as unknown as Record<string, unknown>).__COVE_TEST_WALLET__;
}
