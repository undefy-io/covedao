import type { BitcoinChainProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import * as core from "@crclaunch/crc20-protocol";
import {
  loadCrcCoreLedger,
  loadCrcActivationHeight,
  loadCrcRegistrations,
  listCrcCheckpoints,
  persistCrcCoreBlock,
  rollbackCrcCoreTip,
  restoreCrcCheckpoint,
  type CrcPersistenceOptions,
} from "./core-store.js";
import { observeCrcBlock } from "./worker.js";
export type CrcWorkerSnapshot = {
  state: core.Ledger | null;
  cursor: { height: number; hash: string } | null;
};
function snapshot(state: core.Ledger | null): CrcWorkerSnapshot {
  return { state, cursor: state?.tip ? { height: state.tip.height, hash: state.tip.hash } : null };
}
export function assertCrcChainIdentity(network: string, chain: string): void {
  const expected = { bitcoin: "main", testnet: "test", signet: "signet", regtest: "regtest" }[
    core.protocolNetwork(network)
  ];
  if (chain !== expected) throw new Error(`CRC worker expected ${network}, Core reports ${chain}`);
}
export function firstCrcHeight(cursorHeight: number | null, activationHeight: number): number {
  if (!Number.isSafeInteger(activationHeight) || activationHeight < 0)
    throw new Error("invalid CRC activation height");
  if (cursorHeight === null) return Math.max(1, activationHeight);
  if (!Number.isSafeInteger(cursorHeight) || cursorHeight < activationHeight)
    throw new Error("CRC cursor predates configured activation");
  return cursorHeight + 1;
}
export async function syncCrcTip(params: {
  db: Database;
  provider: Pick<
    BitcoinChainProvider,
    "getBlockchainInfo" | "getBlockHash" | "getBlock" | "getRawTransaction"
  >;
  network: string;
  activationHeight: number;
  protocolScriptHex: string;
  snapshot?: CrcWorkerSnapshot;
  persistence?: CrcPersistenceOptions;
}): Promise<{ snapshot: CrcWorkerSnapshot; indexed: number; rolledBack: number; paused: boolean }> {
  const { db, provider, network } = params;
  const info = await provider.getBlockchainInfo();
  assertCrcChainIdentity(network, info.chain);
  if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) throw new Error("invalid Core height");
  firstCrcHeight(null, params.activationHeight);
  // Publication can change offers between ticks; always reload the authoritative database.
  let state = await loadCrcCoreLedger(db, network);
  if (!state) return { snapshot: snapshot(null), indexed: 0, rolledBack: 0, paused: true };
  if ((await loadCrcActivationHeight(db, network)) !== Math.max(1, params.activationHeight))
    throw new Error("CRC activation differs from initialized ledger");
  let rolledBack = 0;
  while (state.tip) {
    const canonicalHash =
      state.tip.height <= info.blocks ? await provider.getBlockHash(state.tip.height) : null;
    if (canonicalHash === state.tip.hash) break;
    if (state.history[state.tip.hash]) {
      await rollbackCrcCoreTip(db, network);
      rolledBack++;
    } else {
      // RPC stays outside the restore transaction. Select only a checkpoint on the observed chain.
      const checkpoints = await listCrcCheckpoints(db, network);
      let restored = false;
      for (const checkpoint of checkpoints) {
        if (
          !checkpoint.baseline &&
          (checkpoint.height > BigInt(info.blocks) ||
            (await provider.getBlockHash(Number(checkpoint.height))) !== checkpoint.blockHash)
        )
          continue;
        const previousHeight = state.tip.height;
        if (!(await restoreCrcCheckpoint(db, network, Number(checkpoint.height))))
          throw new Error("CRC checkpoint disappeared");
        rolledBack += previousHeight - Number(checkpoint.height);
        restored = true;
        break;
      }
      if (!restored) throw new Error("CRC canonical checkpoint unavailable");
    }
    state = (await loadCrcCoreLedger(db, network))!;
  }
  let indexed = 0;
  for (
    let height = firstCrcHeight(state.tip?.height ?? null, params.activationHeight);
    height <= info.blocks;
    height++
  ) {
    const hash = await provider.getBlockHash(height),
      block = await provider.getBlock(hash);
    if (block.hash !== hash || block.height !== height)
      throw new Error("Core CRC block metadata mismatch");
    const parentHash = state.tip?.hash ?? (await provider.getBlockHash(height - 1));
    if (block.previousBlockHash !== parentHash)
      throw new Error("Core changed branches during CRC replay");
    const registrations = await loadCrcRegistrations(db, network);
    if (
      Object.values(registrations).some(
        (config) => config.protocolScriptHex !== params.protocolScriptHex,
      )
    )
      throw new Error("CRC registered protocol script differs from configured authority");
    const observed = await observeCrcBlock(
      state,
      {
        network,
        height,
        hash,
        parentHash,
        rawTxs: block.rawTxs,
        txids: block.txids,
        timestamp: block.timestamp ?? 0,
      },
      registrations,
      provider,
    );
    // Catch a branch change while observing parents before entering the database write.
    if ((await provider.getBlockHash(height)) !== hash)
      throw new Error("Core changed branches during CRC observation");
    state = (await persistCrcCoreBlock(db, network, observed, registrations, params.persistence))
      .state;
    indexed++;
  }
  return { snapshot: snapshot(state), indexed, rolledBack, paused: false };
}
