import * as core from "@crclaunch/crc20-protocol";
import { loadCrcCoreLedger, saveCrcOfferAuthorization } from "@crclaunch/crc20-state";
import type { Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { AppError } from "@crclaunch/cove-app";
import type { CrcNetwork } from "./crc-read";
export async function activateCrcCoreOffer(params: {
  db: Database;
  network: CrcNetwork;
  provider: Pick<CoreRpcProvider, "getBlockchainInfo" | "getBlockHash" | "getTxout">;
  offer: core.ProtocolDto<core.Offer>;
}) {
  let offer: core.Offer;
  try {
    offer = core.decodeProtocolDto<core.Offer>(params.offer);
  } catch (error) {
    throw new AppError(
      "CLIENT_INTENT_MISMATCH",
      error instanceof Error ? error.message : "Invalid offer DTO",
    );
  }
  if (offer.network !== core.protocolNetwork(params.network))
    throw new AppError("WRONG_NETWORK", "Offer network differs from server");
  try {
    core.verifyOffer(offer);
  } catch (error) {
    throw new AppError(
      "WALLET_SIGNATURE_INVALID",
      error instanceof Error ? error.message : "Invalid offer authorization",
    );
  }
  const ledger = await loadCrcCoreLedger(params.db, params.network);
  if (!ledger) throw new AppError("STATE_CHANGED", "CRC index is unavailable");
  await core.registerOffer(ledger, offer);
  const info = await params.provider.getBlockchainInfo();
  const chain =
    params.network === "mainnet" ? "main" : params.network === "testnet" ? "test" : params.network;
  if (info.chain !== chain) throw new AppError("WRONG_NETWORK", "Offer backend network mismatch");
  if (ledger.tip && (await params.provider.getBlockHash(ledger.tip.height)) !== ledger.tip.hash)
    throw new AppError("STATE_CHANGED", "CRC indexed offer state is no longer canonical");
  const observed = await params.provider.getTxout(offer.listedInput.txid, offer.listedInput.vout);
  if (
    !observed ||
    observed.confirmations < 1 ||
    observed.scriptPubKeyHex !== offer.sellerScriptHex ||
    observed.valueSats !== core.sats(offer.listedInput.sats)
  )
    throw new AppError("STATE_CHANGED", "Listed token output is no longer confirmed and unspent");
  return saveCrcOfferAuthorization(params.db, offer);
}
