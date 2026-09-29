import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import type { BlockchainInfo, CoreRpcProvider, RpcReadOptions } from "@crclaunch/bitcoin";

/**
 * Indexer health gate (§5). The future Guardian/API must be able to require
 * HEALTHY before building/signing state transitions.
 */

export type IndexerHealth = "HEALTHY" | "BEHIND" | "REBUILDING" | "DIVERGED" | "CORE_UNREACHABLE";

export interface HealthReport {
  health: IndexerHealth;
  cursorHeight: bigint;
  cursorBlockHash: string;
  coreHeight: bigint;
  coreTip?: string;
  coreBlockHashAtCursor: string | null;
  lag: bigint;
  stateRoot: string;
  rebuilding: boolean;
}

const observations = new WeakMap<HealthReport, { provider: CoreRpcProvider; network: string; generation: string | null; at: number; info: BlockchainInfo }>();

export function healthChainObservation(report: HealthReport, provider: CoreRpcProvider): BlockchainInfo | undefined {
  const observed = observations.get(report);
  return observed?.provider === provider && performance.now() - observed.at < 500
    ? { ...observed.info } : undefined;
}

export async function computeHealth(params: {
  db: Database;
  network: string;
  provider: CoreRpcProvider;
  rpcOptions?: RpcReadOptions;
  observation?: HealthReport;
}): Promise<HealthReport> {
  const cursor = await params.db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, params.network));
  const c = cursor[0];
  if (!c) {
    return { health: "REBUILDING", cursorHeight: 0n, cursorBlockHash: "", coreHeight: 0n, coreBlockHashAtCursor: null, lag: 0n, stateRoot: "", rebuilding: true };
  }
  const epochs = await params.db.execute(sql`select chain_generation::text as generation
    from cove_observation_epochs where network = ${params.network}`);
  const generation = epochs.rows[0]?.generation == null ? null : String(epochs.rows[0].generation);
  const prior = params.observation;
  const observed = prior ? observations.get(prior) : undefined;
  if (prior && observed && observed.provider === params.provider && observed.network === params.network &&
    generation !== null && generation === observed.generation &&
    performance.now() - observed.at < 500 && prior.health === "HEALTHY" &&
    c.height === prior.cursorHeight && c.blockHash === prior.cursorBlockHash &&
    c.stateRoot === prior.stateRoot && c.rebuilding === prior.rebuilding)
    return prior;

  let coreHeight: bigint;
  let coreTip: string;
  let coreBlockHashAtCursor: string | null = null;
  let info: BlockchainInfo;
  const observationStartedAt = performance.now();
  try {
    info = await params.provider.getBlockchainInfo(params.rpcOptions);
    coreHeight = BigInt(info.blocks);
    coreTip = info.bestBlockHash;
    if (c.height === coreHeight) coreBlockHashAtCursor = coreTip;
    else if (c.height > 0n && c.height < coreHeight) coreBlockHashAtCursor = await params.provider.getBlockHash(Number(c.height), params.rpcOptions);
  } catch {
    return { health: "CORE_UNREACHABLE", cursorHeight: c.height, cursorBlockHash: c.blockHash, coreHeight: 0n, coreBlockHashAtCursor: null, lag: 0n, stateRoot: c.stateRoot, rebuilding: c.rebuilding };
  }

  const lag = coreHeight - c.height;
  let health: IndexerHealth;
  if (c.rebuilding) health = "REBUILDING";
  else if (c.height > coreHeight) health = "DIVERGED";
  else if (coreBlockHashAtCursor !== null && coreBlockHashAtCursor !== c.blockHash) health = "DIVERGED";
  else if (lag > 2n) health = "BEHIND";
  else health = "HEALTHY";

  const report: HealthReport = Object.freeze({
    health,
    cursorHeight: c.height,
    cursorBlockHash: c.blockHash,
    coreHeight,
    coreTip,
    coreBlockHashAtCursor,
    lag,
    stateRoot: c.stateRoot,
    rebuilding: c.rebuilding,
  });
  if (health === "HEALTHY") observations.set(report, {
    provider: params.provider, network: params.network, generation, at: observationStartedAt, info: { ...info },
  });
  return report;
}
