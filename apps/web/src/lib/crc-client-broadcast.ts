import { crcWalletData } from "./crc-wallet-data";
import { crcBrowserData, type CrcBrowserBuild, type CrcRequest } from "./crc-browser-session";
import { readyTransactionId } from "./crc-ready-transaction";

export async function submitCrcFromBrowser(
  built: Pick<CrcBrowserBuild, "sessionId" | "psbtBase64">,
  wallet: {network: string; address: string}, endpoint: string, sign: () => Promise<string>, request: CrcRequest = fetch,
): Promise<{txid: string; fillId?: string}> {
  if (wallet.network === "regtest") return crcBrowserData(request, endpoint, {sessionId: built.sessionId, signedPsbtBase64: await sign()});
  const data = crcWalletData(wallet.network, request);
  if (!data.canBroadcast) throw new Error("Public broadcast is unavailable. Refresh this page and retry.");
  const receipt = await crcBrowserData<{
    network: string; status: "READY" | "BROADCAST"; txid: string; rawTxHex: string; fillId?: string;
  }>(request, endpoint, {sessionId: built.sessionId, signedPsbtBase64: await sign(), broadcast: "client"});
  if (receipt.network !== wallet.network || !["READY", "BROADCAST"].includes(receipt.status) ||
    readyTransactionId(receipt.rawTxHex, built.psbtBase64) !== receipt.txid ||
    (receipt.fillId !== undefined && receipt.fillId !== built.sessionId))
    throw new Error("Prepared transaction differs from the reviewed transaction");
  const txid = await data.broadcast(receipt.rawTxHex, receipt.txid);
  return {txid, ...(receipt.fillId === undefined ? {} : {fillId: receipt.fillId})};
}
