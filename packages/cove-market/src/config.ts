import { COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import { CHAIN_BITCOIN_REGTEST, CHAIN_BITCOIN_SIGNET, CHAIN_BITCOIN_TESTNET, CHAIN_BITCOIN_MAINNET } from "@crclaunch/cove-wire";

/**
 * Market operational config (§29/§22/§10). NOT Cove protocol constants — these
 * are production/dev operational values.
 */
export interface MarketConfig {
  enabled: boolean;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  /** Chain identity this market operates on; listings must match (§M5). */
  chainIdentity: string;
  p2pFeeBps: bigint;
  /** The market fee never drops below this, so a small fill is never refused for a dust fee. */
  p2pFeeMinSats: bigint;
  feeScript: Buffer;
  /** Add the readable CRC-20 OP_RETURN to market fills. */
  discoveryEnvelope?: boolean;
  /** How long a buyer holds a listing while their own wallet signs. */
  reservationTtlSeconds: number;
  /**
   * How long a seller has to countersign once the buyer has signed. The seller
   * is usually not online at the moment someone buys, so this has to be long
   * enough to come back and approve. The buyer's coins are only committed to
   * this one transaction; spending them elsewhere cancels the fill.
   */
  sellerSignTtlSeconds: number;
  maxListingBlocks: bigint;
  maxMinerFeeSats: bigint;
  /** Canary P2P settlement cap (sats); undefined = uncapped (dev/regtest only). */
  maxP2pSettlementSats?: bigint;
}

function chainIdentityForNetwork(network: MarketConfig["network"]): string {
  switch (network) {
    case "regtest":
      return CHAIN_BITCOIN_REGTEST;
    case "signet":
      return CHAIN_BITCOIN_SIGNET;
    case "testnet":
      return CHAIN_BITCOIN_TESTNET;
    case "mainnet":
      return CHAIN_BITCOIN_MAINNET;
  }
}

export function defaultMarketConfig(network: MarketConfig["network"], feeScript: Buffer, chainIdentity: string = chainIdentityForNetwork(network)): MarketConfig {
  return {
    enabled: true,
    network,
    chainIdentity,
    p2pFeeBps: COVE_FEE_CONFIG.p2pFeeBps,
    p2pFeeMinSats: COVE_FEE_CONFIG.p2pFeeMinSats,
    feeScript,
    reservationTtlSeconds: 300,
    sellerSignTtlSeconds: 24 * 60 * 60,
    maxListingBlocks: 21_000n, // ~5 months at 10-min blocks; operational, not protocol
    maxMinerFeeSats: 20_000n,
  };
}

/**
 * Explicit mainnet market config driven by the committed public profile (§16/§17).
 * NEVER falls back to development economics: p2pFeeBps + feeScript + the canary
 * P2P cap come from the profile, not COVE_FEE_CONFIG dev defaults.
 */
export function mainnetMarketConfig(params: {
  p2pFeeBps: number;
  feeScript: Buffer;
  maxP2pSettlementSats: bigint;
  chainIdentity?: string;
}): MarketConfig {
  return {
    enabled: true,
    network: "mainnet",
    chainIdentity: params.chainIdentity ?? CHAIN_BITCOIN_MAINNET,
    p2pFeeBps: BigInt(params.p2pFeeBps),
    p2pFeeMinSats: COVE_FEE_CONFIG.p2pFeeMinSats,
    feeScript: params.feeScript,
    reservationTtlSeconds: 300,
    sellerSignTtlSeconds: 24 * 60 * 60,
    maxListingBlocks: 21_000n,
    maxMinerFeeSats: 20_000n,
    maxP2pSettlementSats: params.maxP2pSettlementSats,
  };
}
