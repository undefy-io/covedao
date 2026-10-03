import { serverEnv } from "./server-env";

export function crcMarketAvailable(config: {
  network: string;
  tradingActive: boolean;
  testingEnabled: boolean;
}): boolean {
  return (config.network === "signet" || config.network === "regtest") &&
    config.tradingActive && config.testingEnabled;
}

export function isCrcMarketReleased(): boolean {
  return crcMarketAvailable({
    network: serverEnv.COVE_NETWORK,
    tradingActive: serverEnv.COVE_CRC_TRADING_ACTIVE,
    testingEnabled: serverEnv.COVE_CRC_MARKET_TESTING_ENABLED,
  });
}
