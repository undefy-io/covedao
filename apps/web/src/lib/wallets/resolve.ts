import * as bitcoin from "bitcoinjs-lib";
import { tr } from "../../i18n";
import { Psbt } from "bitcoinjs-lib";
import {
  WalletError,
  type CoveNetwork,
  type SignPsbtRequest,
  type WalletAccount,
  type WalletConnection,
} from "./types";

/**
 * The parts of wallet handling that are pure arithmetic over addresses and
 * PSBTs.
 *
 * Separated from the adapters so they can be tested without a browser or a
 * wallet extension. `inputsOwnedBy` in particular decides which inputs a
 * wallet is asked to sign, and offering it the backing vault input would
 * destroy the Guardian's signature.
 */

/** Browser wallets exist on three networks. Regtest is served by the test signer. */
export type BrowserNetwork = "mainnet" | "testnet" | "signet";

export function browserNetwork(network: CoveNetwork): BrowserNetwork {
  if (network === "regtest") {
    throw new WalletError(
      "WRONG_NETWORK",
      tr("wal.noRegtest"),
    );
  }
  return network;
}

export function bitcoinNetwork(network: CoveNetwork): bitcoin.networks.Network {
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  if (network === "regtest") return bitcoin.networks.regtest;
  return bitcoin.networks.testnet;
}

/**
 * The scriptPubKey an address pays to.
 *
 * Derived from the address itself rather than taken from the wallet: the
 * script is what every later check compares against, and a wallet's own idea
 * of it is one more thing that can be wrong.
 */
export function scriptOf(address: string, network: CoveNetwork): string {
  try {
    return bitcoin.address.toOutputScript(address, bitcoinNetwork(network)).toString("hex");
  } catch {
    throw new WalletError(
      "WRONG_NETWORK",
      `${address} is not a ${network} address — check which network your wallet is on`,
    );
  }
}

export type SdkAddress = { address: string; publicKey: string; format: string };

/**
 * Pick the payments and ordinals addresses out of what a wallet returned.
 *
 * Wallets report a `format` per address. Taproot is where inscriptions and
 * token carriers live; anything else is the payment address. A wallet with a
 * single address uses it for both, which is legitimate — plenty of native
 * segwit wallets work that way.
 */
export function splitAddresses(
  addresses: SdkAddress[],
  network: CoveNetwork,
): { payments: WalletAccount; ordinals: WalletAccount } {
  if (addresses.length === 0) {
    throw new WalletError("FAILED", "the wallet returned no addresses");
  }
  const toAccount = (a: SdkAddress): WalletAccount => ({
    address: a.address,
    script: scriptOf(a.address, network),
    publicKey: a.publicKey,
  });

  const taproot = addresses.find((a) => a.format === "taproot");
  const payment = addresses.find((a) => a.format !== "taproot");

  // Ordinals prefer Taproot; payments prefer anything else. Either falling
  // back to the other is correct for a single-address wallet.
  const ordinals = toAccount(taproot ?? payment ?? addresses[0]!);
  const payments = toAccount(payment ?? taproot ?? addresses[0]!);
  return { payments, ordinals };
}

/**
 * Work out which PSBT inputs the connected wallet owns, and which of its two
 * addresses owns each.
 *
 * Matching on the script is what keeps the backing vault input out: it belongs
 * to neither address, so it is never offered to the wallet, and the Guardian's
 * signature on it survives untouched.
 */
export function inputsOwnedBy(
  psbtBase64: string,
  network: CoveNetwork,
  connection: Pick<WalletConnection, "payments" | "ordinals">,
): SignPsbtRequest["inputsByAddress"] {
  const psbt = Psbt.fromBase64(psbtBase64, { network: bitcoinNetwork(network) });
  const byAddress = new Map<string, number[]>();
  const owners = [connection.payments, connection.ordinals];

  psbt.data.inputs.forEach((input, index) => {
    const script = input.witnessUtxo?.script.toString("hex");
    if (!script) return;
    const owner = owners.find((o) => o.script === script);
    if (!owner) return;
    const list = byAddress.get(owner.address) ?? [];
    list.push(index);
    byAddress.set(owner.address, list);
  });

  return [...byAddress.entries()].map(([address, indexes]) => ({ address, indexes }));
}
