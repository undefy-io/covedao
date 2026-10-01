import type { BitcoinChainProvider } from "@crclaunch/bitcoin";
import type { BitcoinNetwork } from "@crclaunch/crc20-base";
import type { CoveLedgerState } from "@crclaunch/crc20-ledger/cove-replay";
import type { Database } from "@crclaunch/db";
import { hasAuthorizedCrcLaunchIntent, loadAuthorizedCrcRegistrations } from "./intents.js";
import type { CrcProjection } from "./persistence.js";
import { rollbackCrcTip, type CrcBlock } from "./store.js";
import { hydrateCrcLedger, persistConfirmedCrcBlock, projectionFromCoveLedger } from "./worker.js";

export type CrcWorkerSnapshot = { state: CoveLedgerState; projection: CrcProjection; cursor: CrcBlock | null };

export function assertCrcChainIdentity(network: BitcoinNetwork, coreChain: string): void {
  const expected = { mainnet: "main", testnet: "test", signet: "signet", regtest: "regtest" }[network];
  if (coreChain !== expected) throw new Error(`CRC worker expected ${network}, Core reports ${coreChain}`);
}

export function firstCrcHeight(cursorHeight: number | null, activationHeight: number): number {
  if (!Number.isSafeInteger(activationHeight) || activationHeight < 0) throw new Error("invalid CRC activation height");
  if (cursorHeight === null) return Math.max(1, activationHeight);
  if (!Number.isSafeInteger(cursorHeight) || cursorHeight < activationHeight) throw new Error("CRC cursor predates configured activation");
  return cursorHeight + 1;
}

export async function syncCrcTip(params: {
  db: Database;
  provider: Pick<BitcoinChainProvider, "getBlockchainInfo" | "getBlockHash" | "getBlock" | "getRawTransaction">;
  network: BitcoinNetwork;
  activationHeight: number;
  protocolScriptHex: string;
  snapshot?: CrcWorkerSnapshot;
}): Promise<{ snapshot: CrcWorkerSnapshot; indexed: number; rolledBack: number; paused: boolean }> {
  const { db, provider, network } = params;
  const info = await provider.getBlockchainInfo();
  assertCrcChainIdentity(network, info.chain);
  if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) throw new Error("invalid Core height");
  let snapshot = params.snapshot ?? await hydrateCrcLedger(db, network);
  if (snapshot.cursor?.height === info.blocks && snapshot.cursor.hash === info.bestBlockHash) {
    return { snapshot, indexed: 0, rolledBack: 0, paused: false };
  }
  if (!(await hasAuthorizedCrcLaunchIntent(db, network))) {
    if (Object.keys(snapshot.state.assets).length) throw new Error("CRC worker has assets but no authorized launch intents");
    return { snapshot, indexed: 0, rolledBack: 0, paused: true };
  }
  let rolledBack = 0;
  while (snapshot.cursor) {
    const atOrBelowTip = snapshot.cursor.height <= info.blocks;
    const canonicalHash = atOrBelowTip ? await provider.getBlockHash(snapshot.cursor.height) : null;
    if (canonicalHash === snapshot.cursor.hash) break;
    await rollbackCrcTip(db, network);
    snapshot = await hydrateCrcLedger(db, network);
    rolledBack++;
  }
  let indexed = 0;
  for (let height = firstCrcHeight(snapshot.cursor?.height ?? null, params.activationHeight); height <= info.blocks; height++) {
    const hash = await provider.getBlockHash(height);
    const block = await provider.getBlock(hash);
    if (block.hash !== hash || block.height !== height || block.txids.length !== block.rawTxs.length ||
      !Number.isSafeInteger(block.timestamp) || !block.timestamp || block.timestamp < 1) throw new Error("Core CRC block metadata mismatch");
    const expectedParent = snapshot.cursor?.hash ?? await provider.getBlockHash(height - 1);
    if (block.previousBlockHash !== expectedParent) throw new Error("Core changed branches during CRC replay");
    const registrations = await loadAuthorizedCrcRegistrations(db, network, params.protocolScriptHex, block.txids);
    const rawBlock = { network, height, hash, parentHash: expectedParent, rawTxs: block.rawTxs, timestamp: block.timestamp };
    const nextState = await persistConfirmedCrcBlock(db, snapshot.state, snapshot.projection, rawBlock, registrations, provider);
    const nextProjection = projectionFromCoveLedger(nextState, snapshot.projection, rawBlock, registrations);
    snapshot = { state: nextState, projection: nextProjection, cursor: { height, hash, parentHash: expectedParent } };
    indexed++;
  }
  return { snapshot, indexed, rolledBack, paused: false };
}
