import { hash160, hex, unhex } from "./bytes.js";

/** Canonical core names. API/wallet adapters use `mainnet` for `bitcoin`. */
export type ProtocolNetwork = "bitcoin" | "signet" | "testnet" | "regtest";
export function protocolNetwork(network: string): ProtocolNetwork {
  if (network === "mainnet") return "bitcoin";
  if (
    network === "bitcoin" ||
    network === "signet" ||
    network === "testnet" ||
    network === "regtest"
  )
    return network;
  throw new Error("unsupported Bitcoin network");
}

/** This names a registration; it does not establish that the deployment is trusted. */
export function deploymentIdentity(network: string, deployTxid: string): string {
  if (!/^[0-9a-f]{64}$/.test(deployTxid)) throw new Error("invalid deployment txid");
  return `${protocolNetwork(network)}:${deployTxid}`;
}

export type WalletScriptKind = "p2wpkh" | "p2sh-p2wpkh" | "p2tr";
/** Classification alone proves neither ownership nor Taproot spend-path authorization. */
export function walletScriptKind(scriptHex: string, redeemScriptHex?: string): WalletScriptKind {
  if (/^0014[0-9a-f]{40}$/.test(scriptHex)) return "p2wpkh";
  if (/^a914[0-9a-f]{40}87$/.test(scriptHex)) {
    if (
      !redeemScriptHex ||
      !/^0014[0-9a-f]{40}$/.test(redeemScriptHex) ||
      hex(hash160(unhex(redeemScriptHex))) !== scriptHex.slice(4, -2)
    )
      throw new Error("P2SH requires a matching P2WPKH redeem script");
    return "p2sh-p2wpkh";
  }
  if (/^5120[0-9a-f]{64}$/.test(scriptHex)) return "p2tr";
  throw new Error("unsupported wallet script");
}

/** Keep the builder's input support equal to the signature verifier's support.
 * Extend both with signed/mined tests before enabling additional spend paths.
 */
export function requireSupportedInputScript(scriptHex: string, redeemScriptHex?: string): void {
  try {
    walletScriptKind(scriptHex, redeemScriptHex);
  } catch {
    throw new Error("unsupported input script or missing matching redeem script");
  }
}
export function requireSupportedOutputScript(scriptHex: string): void {
  if (
    !/^0014[0-9a-f]{40}$/.test(scriptHex) &&
    !/^a914[0-9a-f]{40}87$/.test(scriptHex) &&
    !/^5120[0-9a-f]{64}$/.test(scriptHex)
  )
    throw new Error("unsupported output script");
}
