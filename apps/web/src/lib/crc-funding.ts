import { walletFundingSnapshot, schema, type Database } from "@crclaunch/db";
import * as core from "@crclaunch/crc20-protocol";
import * as bitcoin from "bitcoinjs-lib";
import { AppError } from "@crclaunch/cove-app";
import { and, eq, inArray, or, sql } from "drizzle-orm";
export type CrcFundingOutpoint = { txid: string; vout: number };
export type CrcObservedInput = core.Input & { publicKeyHex?: string };
export function crcWalletMetadata(scriptHex: string, publicKeyHex?: string) {
  const redeemScriptHex =
    /^a914/.test(scriptHex) && publicKeyHex
      ? "0014" + bitcoin.crypto.hash160(Buffer.from(publicKeyHex, "hex")).toString("hex")
      : undefined;
  core.walletScriptKind(scriptHex, redeemScriptHex);
  if (publicKeyHex) core.canonicalOfferPublicKey(publicKeyHex, redeemScriptHex ?? scriptHex);
  return {
    ...(redeemScriptHex ? { redeemScriptHex } : {}),
    ...(publicKeyHex ? { publicKeyHex } : {}),
  };
}
export function parseCrcFundingOutpoints(value: unknown, limit = 40): CrcFundingOutpoint[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new AppError("FUNDING_INPUT_INVALID", "Invalid CRC funding candidates");
  const seen = new Set<string>();
  return value.map((input) => {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.txid !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > 0xffffffff
    )
      throw new AppError("FUNDING_INPUT_INVALID", "Invalid CRC funding outpoint");
    const key = core.outpoint(input);
    if (seen.has(key))
      throw new AppError("FUNDING_INPUT_INVALID", "duplicate CRC funding outpoint");
    seen.add(key);
    return { txid: input.txid, vout: input.vout };
  });
}
export async function loadCrcFundingCandidates(
  db: Database,
  network: string,
  walletScriptHex: string,
  outpoints: readonly CrcFundingOutpoint[],
  options: { allowCarrier?: boolean; publicKeyHex?: string; evidenceInputs?: core.Input[] } = {},
): Promise<CrcObservedInput[]> {
  outpoints = parseCrcFundingOutpoints(outpoints);
  if (!outpoints.length) return [];
  const observed = options.evidenceInputs === undefined
    ? await walletFundingSnapshot(db, network, walletScriptHex)
    : options.evidenceInputs.map(input => ({ ...input, valueSats: core.sats(input.sats).toString(), confirmations: 0 }));
  if (!observed)
    throw new AppError(
      "FUNDING_INPUT_INVALID",
      "wallet UTXOs have not been observed; refresh the wallet first",
    );
  const records = await db
    .select()
    .from(schema.crcRecords)
    .where(
      and(
        eq(schema.crcRecords.network, core.protocolNetwork(network)),
        or(
          and(
            eq(schema.crcRecords.kind, "allocations"),
            inArray(schema.crcRecords.key, outpoints.map(core.outpoint)),
          ),
          and(
            eq(schema.crcRecords.kind, "assets"),
            inArray(sql<string>`${schema.crcRecords.valueJson}->'vault'->>'txid'`, [
              ...new Set(outpoints.map((coin) => coin.txid)),
            ]),
          ),
        ),
      ),
    );
  const excluded = new Set(
    records.map((row) =>
      row.kind === "allocations"
        ? row.key
        : core.outpoint(core.decodeProtocolDto<core.Asset>(row.valueJson).vault),
    ),
  );
  const byOutpoint = new Map(observed.map((coin) => [`${coin.txid}:${coin.vout}`, coin]));
  const metadata = crcWalletMetadata(walletScriptHex, options.publicKeyHex);
  return outpoints
    .map(({ txid, vout }): CrcObservedInput | null => {
      const key = core.outpoint({ txid, vout });
      if (excluded.has(key)) return null;
      const coin = byOutpoint.get(key);
      if (!coin)
        throw new AppError(
          "FUNDING_INPUT_INVALID",
          "CRC funding outpoint was not observed for this wallet",
        );
      const sats = BigInt(coin.valueSats);
      if ((options.evidenceInputs === undefined && coin.confirmations < 1) || sats <= (options.allowCarrier ? 0n : core.carrierSats))
        return null;
      core.sats(sats);
      return { txid, vout, sats, scriptHex: walletScriptHex, ...metadata };
    })
    .filter((input): input is CrcObservedInput => input !== null);
}
