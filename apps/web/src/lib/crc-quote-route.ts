import { CurveTransitionError } from "@crclaunch/crc20-curve";
import { addressToScript } from "./address";
import { bigintField, fail, handleError, ok, readJson, strField } from "./api";
import { parseCrcAssetId, readCrcAsset, readCrcQuoteAsset, readCrcBalance, readCrcCursor } from "./crc-read";
import { CrcQuoteError, quoteCrcBuy, quoteCrcSell } from "./crc-quote";
import { getCrcReadServices } from "./crc-server";

export async function crcQuoteRoute(req: Request, operation: "buy" | "sell"): Promise<Response> {
  try {
    const body = await readJson(req);
    const { db, network } = getCrcReadServices();
    const id = parseCrcAssetId(strField(body, "assetId"), network);
    if (!id) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const amountAtoms = bigintField(body, "amountAtoms", 0n);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const token = await readCrcQuoteAsset(db, network, id.deployTxid);
    if (!token) {
      const registered = await readCrcAsset(db, network, id.deployTxid);
      return registered
        ? fail("INVALID_STATE", "Trusted launch state is unavailable", 503, true)
        : fail("TOKEN_NOT_FOUND", "Token not found", 404);
    }
    if (token.availability !== "active") return fail("ASSET_UNAVAILABLE", "This token's vault is unavailable", 503, true);

    if (operation === "buy") return ok({ indexedTip, quote: quoteCrcBuy(token, amountAtoms) });

    const sellerAddress = strField(body, "sellerAddress");
    const payoutAddress = strField(body, "payoutAddress") || sellerAddress;
    const sellerScriptHex = addressToScript(sellerAddress, network);
    const payoutScriptHex = addressToScript(payoutAddress, network);
    const balanceAtoms = await readCrcBalance(db, network, id.deployTxid, sellerScriptHex);
    if (amountAtoms > balanceAtoms) return fail("INSUFFICIENT_BALANCE", "Sell amount exceeds indexed wallet balance", 400);
    return ok({ indexedTip, sellerBalanceAtoms: balanceAtoms.toString(), quote: quoteCrcSell(token, amountAtoms, payoutScriptHex) });
  } catch (error) {
    if (error instanceof CrcQuoteError) {
      return fail(error.code, error.message, error.code === "ASSET_UNAVAILABLE" || error.code === "INVALID_STATE" ? 503 : 400,
        error.code === "ASSET_UNAVAILABLE" || error.code === "INVALID_STATE");
    }
    if (error instanceof CurveTransitionError) return fail(error.code, error.message, 400);
    return handleError(error);
  }
}
