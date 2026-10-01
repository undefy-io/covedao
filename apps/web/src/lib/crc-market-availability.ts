import { serverEnv } from "./server-env";

export function crcMarketAvailable(config: {
  network: string;
  protocolMode: string;
  tradingActive: boolean;
  testingEnabled: boolean;
}): boolean {
  return (config.network === "signet" || config.network === "regtest") &&
    config.protocolMode === "crc20" && config.tradingActive && config.testingEnabled;
}

export function isCrcMarketReleased(): boolean {
  return crcMarketAvailable({
    network: serverEnv.COVE_NETWORK,
    protocolMode: serverEnv.COVE_PROTOCOL_MODE,
    tradingActive: serverEnv.COVE_CRC_TRADING_ACTIVE,
    testingEnabled: serverEnv.COVE_CRC_MARKET_TESTING_ENABLED,
  });
}
