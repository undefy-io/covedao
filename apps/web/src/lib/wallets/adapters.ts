"use client";

import { tr } from "@/i18n";
import * as bitcoin from "bitcoinjs-lib";
import { Psbt } from "bitcoinjs-lib";
import * as unisat from "@ordzaar/ordit-sdk/unisat";
import * as xverse from "@ordzaar/ordit-sdk/xverse";
import * as magiceden from "@ordzaar/ordit-sdk/magiceden";
import * as leather from "@ordzaar/ordit-sdk/leather";
import { LeatherAddressType } from "@ordzaar/ordit-sdk/leather";
import * as okx from "@ordzaar/ordit-sdk/okx";
import * as phantom from "@ordzaar/ordit-sdk/phantom";
import * as oyl from "@ordzaar/ordit-sdk/oyl";
import {
  WalletError,
  type SignPsbtRequest,
  type WalletAdapter,
  type WalletConnection,
  type WalletId,
} from "./types";
import {
  browserNetwork,
  bitcoinNetwork,
  splitAddresses,
  type BrowserNetwork,
  type SdkAddress,
} from "./resolve";
export { inputsOwnedBy } from "./resolve";

/**
 * Adapters over @ordzaar/ordit-sdk.
 *
 * The SDK is used directly rather than through ord-connect, its React wrapper:
 * ord-connect pins React 18 against this app's 19 and ships its own stylesheet,
 * while the SDK it wraps has no peer dependencies at all. What ord-connect adds
 * is a wallet picker, and Cove has its own design to answer to.
 */

/** bc1p… / tb1p… / bcrt1p… — a segwit v1 (taproot) address. */
function isTaprootAddress(address: string): boolean {
  return /^(bc|tb|bcrt)1p/i.test(address);
}

function fail(walletName: string, e: unknown): never {
  if (e instanceof WalletError) throw e;
  const message = e instanceof Error ? e.message : String(e);
  if (/cancel|reject|denied|user/i.test(message)) {
    throw new WalletError("REJECTED", tr("wal.cancelled", { wallet: walletName }));
  }
  if (/not installed|no provider|is not defined/i.test(message)) {
    throw new WalletError("NOT_INSTALLED", tr("wal.notInstalled", { wallet: walletName }));
  }
  throw new WalletError("FAILED", `${walletName}: ${message}`);
}

/** The PSBT, signed but not finalized, back as base64. */
function serialized(result: { base64: string | null; hex: string }): string {
  if (result.base64) return result.base64;
  // A wallet that only returned hex still returned a PSBT, because finalize
  // and extractTx were both off.
  return Psbt.fromHex(result.hex).toBase64();
}

const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL;

/** One call to Xverse's JSON-RPC provider; throws its error message on refusal. */
async function xverseRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const provider = (window as unknown as {
    XverseProviders?: { BitcoinProvider?: { request(m: string, p: unknown): Promise<unknown> } };
  }).XverseProviders?.BitcoinProvider;
  if (!provider) throw new WalletError("NOT_INSTALLED", tr("wal.notInstalled", { wallet: "Xverse" }));
  const res = (await provider.request(method, params)) as {
    result?: T;
    error?: { code?: number; message?: string };
  };
  if (res?.error) {
    // 4001 / -32000 is the user closing or rejecting the prompt.
    if (res.error.code === 4001 || /reject|cancel/i.test(res.error.message ?? "")) {
      throw new WalletError("REJECTED", tr("wal.declined", { wallet: "Xverse" }));
    }
    throw new WalletError("FAILED", res.error.message ?? tr("wal.refused", { wallet: "Xverse" }));
  }
  if (!res?.result) throw new WalletError("FAILED", tr("wal.returnedNothing", { wallet: "Xverse" }));
  return res.result;
}

/**
 * Every wallet is asked for the same thing: sign these indexes, with
 * SIGHASH_ALL (or a listing's SINGLE|ANYONECANPAY), and do not finalize. They differ only in how they want to be
 * told, which is all these adapters resolve.
 */
function makeAdapter(spec: {
  id: WalletId;
  name: string;
  installUrl: string;
  mainnetOnly?: boolean;
  isInstalled: () => boolean | Promise<boolean>;
  getAddresses: (network: BrowserNetwork) => Promise<SdkAddress[]>;
  sign: (psbt: Psbt, network: BrowserNetwork, request: SignPsbtRequest) => Promise<string>;
  signMessage: (network: BrowserNetwork, address: string, message: string) => Promise<string>;
}): WalletAdapter {
  return {
    id: spec.id,
    name: spec.name,
    installUrl: spec.installUrl,
    mainnetOnly: spec.mainnetOnly,
    async isInstalled() {
      try {
        return await spec.isInstalled();
      } catch {
        return false;
      }
    },
    async connect(network) {
      const net = browserNetwork(network);
      let addresses: SdkAddress[];
      try {
        addresses = await spec.getAddresses(net);
      } catch (e) {
        fail(spec.name, e);
      }
      const { payments, ordinals } = splitAddresses(addresses, network);
      return { walletId: spec.id, payments, ordinals } satisfies WalletConnection;
    },
    async signPsbt(network, request) {
      const net = browserNetwork(network);
      const psbt = Psbt.fromBase64(request.psbtBase64, { network: bitcoinNetwork(network) });
      try {
        return await spec.sign(psbt, net, request);
      } catch (e) {
        fail(spec.name, e);
      }
    },
    async signMessage(network, address, message) {
      const net = browserNetwork(network);
      try {
        return await spec.signMessage(net, address, message);
      } catch (e) {
        fail(spec.name, e);
      }
    },
  };
}

/** The shape four of the seven wallets want: per-address signing indexes. */
function inputsToSign(request: SignPsbtRequest) {
  return request.inputsByAddress.map((group) => ({
    address: group.address,
    signingIndexes: group.indexes,
    sigHash: request.sighashType ?? SIGHASH_ALL,
  }));
}

function allIndexes(request: SignPsbtRequest): number[] {
  return request.inputsByAddress.flatMap((g) => g.indexes).sort((a, b) => a - b);
}

export const ADAPTERS: WalletAdapter[] = [
  makeAdapter({
    id: "xverse",
    name: "Xverse",
    installUrl: "https://www.xverse.app/download",
    isInstalled: () => xverse.isInstalled(),
    getAddresses: (network) => xverse.getAddresses(network) as Promise<SdkAddress[]>,
    // Xverse's current RPC, not the SDK's legacy `signTransaction` token API,
    // which current Xverse builds fail on ("(intermediate value).map is not a
    // function") before the user ever sees the request.
    sign: async (psbt, _network, request) => {
      const signInputs: Record<string, number[]> = {};
      for (const g of request.inputsByAddress) signInputs[g.address] = g.indexes;
      // Xverse reads the sighash from each input's PSBT_IN_SIGHASH_TYPE, which
      // a listing PSBT carries (SINGLE|ANYONECANPAY).
      const r = await xverseRpc<{ psbt: string }>("signPsbt", {
        psbt: psbt.toBase64(),
        signInputs,
        broadcast: false,
      });
      return r.psbt;
    },
    signMessage: async (_network, address, message) => {
      // Once, not twice: each call is a prompt the user has to approve.
      const r = await xverseRpc<{ signature: string }>("signMessage", {
        address,
        message,
        protocol: "BIP322",
      });
      return r.signature;
    },
  }),
  makeAdapter({
    id: "unisat",
    name: "Unisat",
    installUrl: "https://unisat.io/download",
    isInstalled: () => unisat.isInstalled(),
    getAddresses: (network) => unisat.getAddresses(network) as Promise<SdkAddress[]>,
    // Called directly: the SDK neither passes the input list (so Unisat would
    // try every input it can) nor surfaces Unisat's own error text.
    sign: async (psbt, _network, request) => {
      const u = (window as unknown as {
        unisat?: { signPsbt(hex: string, o: unknown): Promise<string> };
      }).unisat;
      if (!u) throw new WalletError("NOT_INSTALLED", tr("wal.notInstalled", { wallet: "Unisat" }));
      const toSignInputs = request.inputsByAddress.flatMap((g) =>
        g.indexes.map((index) => ({ index, address: g.address, sighashTypes: [request.sighashType ?? SIGHASH_ALL] })),
      );
      try {
        const hex = await u.signPsbt(psbt.toHex(), { autoFinalized: false, toSignInputs });
        return Psbt.fromHex(hex).toBase64();
      } catch (e) {
        const err = e as { code?: number; message?: string };
        if (err?.code === 4001) throw new WalletError("REJECTED", tr("wal.declined", { wallet: "Unisat" }));
        throw new WalletError("FAILED", err?.message ?? tr("wal.couldNotSign", { wallet: "Unisat" }));
      }
    },
    signMessage: async (_network, _address, message) => {
      const r = await unisat.signMessage(message, "bip322-simple");
      return r.base64 ?? r.hex;
    },
  }),
  makeAdapter({
    id: "magiceden",
    name: "Magic Eden",
    installUrl: "https://wallet.magiceden.io/",
    mainnetOnly: true,
    isInstalled: () => magiceden.isInstalled(),
    getAddresses: (network) => magiceden.getAddresses(network) as Promise<SdkAddress[]>,
    sign: async (psbt, network, request) =>
      serialized(
        await magiceden.signPsbt(psbt, {
          network,
          inputsToSign: inputsToSign(request),
          finalize: false,
          extractTx: false,
        }),
      ),
    signMessage: async (network, address, message) => {
      const r = await magiceden.signMessage(message, address, network);
      return r.base64 ?? r.hex;
    },
  }),
  makeAdapter({
    id: "okx",
    name: "OKX",
    installUrl: "https://www.okx.com/web3",
    isInstalled: () => okx.isInstalled(),
    getAddresses: (network) => okx.getAddresses(network) as Promise<SdkAddress[]>,
    sign: async (psbt, network, request) =>
      serialized(
        await okx.signPsbt(psbt, {
          network,
          inputsToSign: inputsToSign(request),
          finalize: false,
          extractTx: false,
        }),
      ),
    signMessage: async (network, _address, message) => {
      const r = await okx.signMessage(message, "bip322-simple", network);
      return r.base64 ?? r.hex;
    },
  }),
  makeAdapter({
    id: "leather",
    name: "Leather",
    installUrl: "https://leather.io/install-extension",
    isInstalled: () => leather.isInstalled(),
    getAddresses: (network) => leather.getAddresses(network) as Promise<SdkAddress[]>,
    sign: async (psbt, network, request) =>
      serialized(
        await leather.signPsbt(psbt, {
          network,
          signAtIndexes: allIndexes(request),
          allowedSighash: [request.sighashType ?? SIGHASH_ALL],
          finalize: false,
          extractTx: false,
        }),
      ),
    signMessage: async (network, address, message) => {
      // Leather signs with whichever of its two addresses we name by type; the
      // server verifies against the address it was asked for, so they must match.
      const r = await leather.signMessage(message, {
        network,
        paymentType: isTaprootAddress(address) ? LeatherAddressType.P2TR : LeatherAddressType.P2WPKH,
      });
      return r.base64 ?? r.hex;
    },
  }),
  makeAdapter({
    id: "phantom",
    name: "Phantom",
    installUrl: "https://phantom.app/download",
    mainnetOnly: true,
    isInstalled: () => phantom.isInstalled(),
    getAddresses: (network) => phantom.getAddresses(network) as Promise<SdkAddress[]>,
    sign: async (psbt, network, request) =>
      serialized(
        await phantom.signPsbt(psbt, {
          network,
          inputsToSign: inputsToSign(request),
          finalize: false,
          extractTx: false,
        }),
      ),
    signMessage: async (network, address, message) => {
      const r = await phantom.signMessage(message, address, network);
      return r.base64 ?? r.hex;
    },
  }),
  makeAdapter({
    id: "oyl",
    name: "Oyl",
    installUrl: "https://www.oyl.io/",
    mainnetOnly: true,
    isInstalled: () => oyl.isInstalled(),
    getAddresses: (network) => oyl.getAddresses(network) as Promise<SdkAddress[]>,
    sign: async (psbt, network) =>
      serialized(await oyl.signPsbt(psbt, { network, finalize: false, extractTx: false })),
    signMessage: async (network, address, message) => {
      const r = await oyl.signMessage(message, address, network);
      return r.base64 ?? r.hex;
    },
  }),
];

export function adapterFor(id: WalletId): WalletAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new WalletError("UNSUPPORTED", `unknown wallet ${id}`);
  return adapter;
}

