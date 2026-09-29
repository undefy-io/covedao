/**
 * Production Cove V3 indexer (§5). Deterministic parser/validator → canonical
 * state machine → PostgreSQL projection. The V1 indexer remains frozen/reference
 * under `@crclaunch/cove-indexer` (legacy); production consumers import this
 * module via `@crclaunch/cove-indexer/v3`.
 */
export { V3IndexerState } from "./state.js";
export { parseCoveTx, txidOf, type ParsedCoveTx } from "./parser.js";
export { computeStateRoot, V3_STATE_ROOT_DOMAIN } from "./root.js";
export { V3Store } from "./store.js";
export { loadCanonicalViewSnapshot, type CanonicalViewSnapshot } from "./canonical-view.js";
export { encodeUndo, decodeUndo } from "./undo.js";
export { hydrateState, computeStateRootFromDb } from "./hydrate.js";
export { loadCanonicalViewSnapshotFromDb, type DbCanonicalViewSnapshot } from "./snapshot.js";
export { computeHealth, healthChainObservation, type IndexerHealth, type HealthReport } from "./health.js";
export { persistentWorker, reorgPersistentToTip } from "./persistent.js";
export { reindexDb } from "./reindex.js";

export {
  getTokenUtxosByScriptDb,
  getLiveTokenUtxosAtDb,
  getBalanceByScriptDb,
  getTokenHoldersDb,
  getCurrentBackingDb,
  getTokenDetailDb,
  getTokenActivityDb,
} from "./read-models-db.js";
export {
  balanceByScript,
  tokenHolders,
  tokenUtxosByScript,
  currentBacking,
  tokenActivity,
} from "./read-models.js";
export { quickVerify, fullVerify, type VerifyResult } from "./verify.js";
export { reorgToTip, type ReorgReport } from "./reorg.js";
export { indexBlocks, type IndexProgress } from "./worker.js";
export { runCli } from "./cli.js";
export { RESERVE_ANCHOR_SATS } from "./constants.js";
export type {
  V3TokenMeta,
  V3Backing,
  V3TokenUtxo,
  V3Event,
  V3Cursor,
  V3BlockInput,
  V3IndexerConfig,
  V3Operation,
  BlockUndo,
  UndoOp,
} from "./types.js";
