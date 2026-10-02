export { MarketError, type MarketErrorCode } from "./errors.js";
export {
  MARKET_ORDER_VERSION,
  MARKET_CANCEL_VERSION,
  type ListingV1,
  type ListingStatus,
  type FillStatus,
  type CancellationV1,
} from "./types.js";
export { serializeListingV1 } from "./order/serialization.js";
export {
  LISTING_DOMAIN,
  CANCEL_DOMAIN,
  RESERVE_DOMAIN,
  listingIdOf,
  cancellationHashOf,
  listingMessageToSign,
  cancellationMessageToSign,
  reservationHashOf,
  reservationMessageToSign,
  type ReservationV1,
} from "./order/hash.js";
export {
  signBip322P2wpkh,
  signBip322P2tr,
  verifyBip322,
  verifyBip322P2wpkh,
  bip322MessageHash,
  verifyListingAuthorization,
  verifyCancellationAuthorization,
  verifyReservationAuthorization,
} from "./order/signature.js";
export { validateListingShape } from "./order/validate.js";
export { defaultMarketConfig, mainnetMarketConfig, type MarketConfig } from "./config.js";
export {
  unsignedTxDigest,
  sighashTypeOf,
  isSighashAll,
  partialSigOfInput,
  validateP2wpkhPartialSig,
  parsePsbt,
} from "./psbt.js";
export {
  validateFinalizedP2PFill,
  broadcastValidatedP2PFill,
  isP2PFillValidated,
  type ValidatedP2PFill,
  type P2PFillTerms,
} from "./finalize.js";
export {
  buildListingPsbt,
  verifyListingPsbt,
  buildPresignedFillPsbt,
  attachSellerPresig,
  LISTING_TX_VERSION,
  LISTING_LOCKTIME,
  LISTING_SEQUENCE,
  SIGHASH_SINGLE_ANYONECANPAY,
  FILL_SELLER_INPUT,
  FILL_PAYOUT_VOUT,
  FILL_BUYER_CARRIER_VOUT,
  FILL_FEE_VOUT,
  type ListingSource,
  type SellerPresig,
} from "./presign.js";
export {
  MarketService,
  publicListing,
  PENDING_LISTING_MAX_BLOCKS,
  type BuyerFundInput,
  type CreateListingInput,
  type ReserveListingInput,
} from "./service.js";
export { getBuyRoutes, getSellOptions, type BuyRoute, type SellOption } from "./best-execution.js";
export { assertMarketReady, assertMarketEnabled, healthErrorFor, marketEnabledFlag } from "./health.js";

export { readStoredFeeObservation } from "./fee-observation.js";
export {
  crcMarketFee,
  buildCrcListingPsbt,
  verifyCrcListingPresign,
  crcListingMessage,
  crcCancelMessage,
  verifyCrcFillTransaction,
  type CrcFillOptions,
  type CrcListing,
  type IndexedCrcAsset,
  type CrcNetwork,
} from "./crc20/market.js";
export {
  createCrcListing,
  cancelCrcListing,
  reserveCrcFill,
  submitBuyerSignedCrcFill,
  completePresignedCrcFill,
  listCrcSellerFillRequests,
  acceptSignedCrcFill,
  broadcastCrcFill,
} from "./crc20/store.js";
