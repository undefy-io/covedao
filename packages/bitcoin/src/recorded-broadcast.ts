import * as bitcoin from "bitcoinjs-lib";
import { RpcError, type CoreRpcProvider } from "./provider.js";

export async function broadcastRecordedTransaction(provider: CoreRpcProvider, signed: { rawTxHex: string; txid: string }, network: "regtest" | "signet" | "testnet" | "mainnet"): Promise<string> {
  if (bitcoin.Transaction.fromHex(signed.rawTxHex).getId() !== signed.txid) throw new Error("recorded transaction identity mismatch");
  const expectedChain = network === "mainnet" ? "main" : network === "testnet" ? "test" : network;
  if ((await provider.getBlockchainInfo()).chain !== expectedChain) throw new Error("recorded transaction network mismatch");
  const observed = async () => {
    const result = await provider.observeTransaction(signed.txid, { retry: false, signal: AbortSignal.timeout(5_000) });
    return result.state === "mempool" || result.state === "mined";
  };
  const acceptance = await provider.testMempoolAccept(signed.rawTxHex);
  if (acceptance.allowed !== true) {
    if (await observed()) return signed.txid;
    throw new Error("recorded transaction is not currently accepted");
  }
  try {
    const result = await provider.broadcastTransaction(signed.rawTxHex);
    if (result !== signed.txid) throw new Error("broadcast transaction identity mismatch");
    return result;
  } catch (error) {
    if (error instanceof RpcError && error.kind === "rpc" && error.method === "sendrawtransaction" &&
      error.rpcCode === -27 && (error.httpStatus === 200 || error.httpStatus === 500)) return signed.txid;
    if (await observed().catch(() => false)) return signed.txid;
    throw error;
  }
}
