import { walletFundingSnapshot, type Database } from "@crclaunch/db";
import type { FundingInput } from "@crclaunch/crc20-transactions";

export type CrcFundingOutpoint = { txid: string; vout: number };

export async function loadCrcFundingCandidates(
  db: Database,
  network: string,
  walletScriptHex: string,
  outpoints: readonly CrcFundingOutpoint[],
  options: { allowCarrier?: boolean; publicKeyHex?: string } = {},
): Promise<FundingInput[]> {
  if (outpoints.length > 40) throw new Error("too many CRC funding candidates");
  if (!outpoints.length) return [];
  const observed = await walletFundingSnapshot(db, network, walletScriptHex);
  if (!observed) throw new Error("wallet UTXOs have not been observed; refresh the wallet first");
  const byOutpoint = new Map(observed.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
  const seen = new Set<string>();
  return outpoints.map(({ txid, vout }) => {
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new Error("invalid CRC funding outpoint");
    const key = `${txid}:${vout}`;
    if (seen.has(key)) throw new Error("duplicate CRC funding outpoint");
    seen.add(key);
    const coin = byOutpoint.get(key);
    if (!coin) throw new Error("CRC funding outpoint was not observed for this wallet");
    const valueSats = BigInt(coin.valueSats);
    if (valueSats <= (options.allowCarrier ? 0n : 1_000n) || valueSats > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("CRC funding value is unavailable or reserved as a token carrier");
    }
    return {
      txid, vout, valueSats: Number(valueSats), scriptHex: walletScriptHex,
      ...(options.publicKeyHex ? { publicKeyHex: options.publicKeyHex } : {}),
    };
  });
}
