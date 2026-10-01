import { walletFundingSnapshot, schema, type Database } from "@crclaunch/db";
import type { FundingInput } from "@crclaunch/crc20-transactions";
import { AppError } from "@crclaunch/cove-app";
import { and, eq, inArray } from "drizzle-orm";

export type CrcFundingOutpoint = { txid: string; vout: number };

export async function loadCrcFundingCandidates(
  db: Database,
  network: string,
  walletScriptHex: string,
  outpoints: readonly CrcFundingOutpoint[],
  options: { allowCarrier?: boolean; publicKeyHex?: string } = {},
): Promise<FundingInput[]> {
  if (outpoints.length > 40) throw new AppError("FUNDING_INPUT_INVALID", "too many CRC funding candidates");
  if (!outpoints.length) return [];
  const observed = await walletFundingSnapshot(db, network, walletScriptHex);
  if (!observed) throw new AppError("FUNDING_INPUT_INVALID", "wallet UTXOs have not been observed; refresh the wallet first");
  const tokenRows = await db.select({ txid: schema.coveCrcTokenUtxos.txid, vout: schema.coveCrcTokenUtxos.vout })
    .from(schema.coveCrcTokenUtxos)
    .where(and(eq(schema.coveCrcTokenUtxos.network, network),
      inArray(schema.coveCrcTokenUtxos.txid, [...new Set(outpoints.map((coin) => coin.txid))])));
  const tokenOutpoints = new Set(tokenRows.map((row) => `${row.txid}:${row.vout}`));
  const byOutpoint = new Map(observed.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
  const seen = new Set<string>();
  return outpoints.map(({ txid, vout }): FundingInput | null => {
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new AppError("FUNDING_INPUT_INVALID", "invalid CRC funding outpoint");
    const key = `${txid}:${vout}`;
    if (seen.has(key)) throw new AppError("FUNDING_INPUT_INVALID", "duplicate CRC funding outpoint");
    seen.add(key);
    if (tokenOutpoints.has(key)) return null;
    const coin = byOutpoint.get(key);
    if (!coin) throw new AppError("FUNDING_INPUT_INVALID", "CRC funding outpoint was not observed for this wallet");
    const valueSats = BigInt(coin.valueSats);
    if (valueSats <= (options.allowCarrier ? 0n : 1_000n)) return null;
    if (valueSats > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError("FUNDING_INPUT_INVALID", "CRC funding value exceeds the safe integer limit");
    return {
      txid, vout, valueSats: Number(valueSats), scriptHex: walletScriptHex,
      ...(options.publicKeyHex ? { publicKeyHex: options.publicKeyHex } : {}),
    };
  }).filter((input): input is FundingInput => input !== null);
}
