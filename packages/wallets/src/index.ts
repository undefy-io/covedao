export type {
  WalletNetwork,
  WalletCapabilities,
  WalletConnection,
  WalletAddresses,
  SignPsbtParams,
  SignBip322Params,
  WalletAdapter,
} from "./types.js";
// Browser-safe client intent verification (ECC-free).
export {
  verifyClientIntent,
  unsignedTxDigestHex,
  verifyListingIntent,
  LISTING_SIGHASH,
  type ClientIntent,
  type VerifiedIntent,
} from "./cove-intent.js";
// Demo-only mock adapter — NEVER auto-connect in production, no real keys.
export { MockWalletAdapter } from "./mock.js";
