/**
 * Canonical market types (§5). All monetary/supply amounts are bigint; no
 * floats ever touch canonical market data.
 */

export const MARKET_ORDER_VERSION = 1;
export const MARKET_CANCEL_VERSION = 1;

export interface ListingV1 {
  orderVersion: 1;
  chainIdentity: string;
  tokenId: string; // 64-hex
  sellerTokenScript: string; // hex
  sellerPayoutScript: string; // hex
  sellerTokenChangeScript: string; // hex
  sourceTxid: string; // 64-hex
  sourceVout: number;
  sourceAmountAtoms: bigint;
  amountAtoms: bigint;
  totalPriceSats: bigint;
  creationHeight: bigint;
  expiryHeight: bigint;
  nonce: string; // 64-hex
}

export type ListingStatus =
  /** Presigned on a fresh split still in the mempool; live once it confirms. */
  | "PENDING"
  | "ACTIVE"
  | "RESERVED"
  | "BROADCAST"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "INVALIDATED"
  | "REORGED";

export type FillStatus =
  | "RESERVED"
  | "PSBT_BUILT"
  | "BUYER_SIGNED"
  | "BROADCAST"
  | "CONFIRMED"
  | "REORGED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export interface CancellationV1 {
  version: 1;
  listingId: string; // 64-hex
  cancelNonce: string; // 64-hex
}
