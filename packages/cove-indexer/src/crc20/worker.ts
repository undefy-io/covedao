import * as CRC from "@crclaunch/crc20-protocol";
import type { Ledger, Config, Block, ChainTransaction, Input } from "@crclaunch/crc20-protocol";
const txidPattern = /^[0-9a-f]{64}$/;
type ParentProvider = { getRawTransaction(txid: string): Promise<string> };
export interface ObservedCrcRawBlock {
  network: string;
  height: number;
  hash: string;
  parentHash: string;
  rawTxs: readonly string[];
  txids?: readonly string[];
  timestamp: number;
}
/** Conservative dependency observation, never a protocol acceptance decision. */
export async function observeCrcBlock(
  initial: Ledger,
  block: ObservedCrcRawBlock,
  registrations: Record<string, Config>,
  provider: ParentProvider,
): Promise<Block> {
  if (
    CRC.protocolNetwork(block.network) !== initial.config.network ||
    !Number.isSafeInteger(block.height) ||
    block.height < 1 ||
    !txidPattern.test(block.hash) ||
    !txidPattern.test(block.parentHash) ||
    !Number.isSafeInteger(block.timestamp) ||
    block.timestamp < 1
  )
    throw new Error("invalid confirmed CRC block metadata");
  const parsed = block.rawTxs.map((raw) => CRC.parseRawTransaction(raw));
  if (
    block.txids &&
    (block.txids.length !== parsed.length ||
      parsed.some((tx, index) => tx.txid !== block.txids![index]))
  )
    throw new Error("Core transaction id list mismatch");
  const allIds = new Set(parsed.map((tx) => tx.txid));
  if (allIds.size !== parsed.length) throw new Error("duplicate Core block transaction");
  const potential = new Set([
    ...Object.keys(initial.allocations),
    ...Object.values(initial.assets).map((a) => CRC.outpoint(a.vault)),
  ]);
  const earlier = new Map<string, string>();
  const parents = new Map<string, Promise<string>>();
  const transactions: ChainTransaction[] = [];
  for (const [index, tx] of parsed.entries()) {
    const rawHex = block.rawTxs[index]!;
    if (registrations[tx.txid] || tx.inputs.some((input) => potential.has(CRC.outpoint(input)))) {
      const parentRawTransactions: Record<string, string> = {};
      const prevouts: Input[] = [];
      for (const input of tx.inputs) {
        if (allIds.has(input.txid) && !earlier.has(input.txid))
          throw new Error("forward intra-block parent transaction");
        let promise = parents.get(input.txid);
        if (!promise) {
          promise = Promise.resolve(
            earlier.get(input.txid) ?? provider.getRawTransaction(input.txid),
          );
          parents.set(input.txid, promise);
        }
        const rawParent = await promise,
          parent = CRC.parseRawTransaction(rawParent),
          output = parent.outputs[input.vout];
        if (parent.txid !== input.txid || !output)
          throw new CRC.UnavailableParentError("Core returned wrong parent transaction or output");
        parentRawTransactions[input.txid] = rawParent;
        prevouts.push({
          txid: input.txid,
          vout: input.vout,
          sats: output.sats,
          scriptHex: output.scriptHex,
        });
      }
      transactions.push({ rawHex, prevouts, parentRawTransactions });
      // Over-approximate descendants inside this block, including ordinary outputs.
      // The shared core alone decides whether any of them carry protocol state.
      tx.outputs.forEach((_, vout) => potential.add(`${tx.txid}:${vout}`));
    } else transactions.push({ rawHex, prevouts: [] });
    earlier.set(tx.txid, rawHex);
  }
  return { hash: block.hash, parentHash: block.parentHash, height: block.height, transactions };
}
