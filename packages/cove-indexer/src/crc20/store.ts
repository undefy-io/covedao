import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database, type DbTransaction } from "@crclaunch/db";
import { applyCrcBlock, type CrcProjection, type CrcUndo } from "./persistence.js";

export type CrcBlock = { height: number; hash: string; parentHash: string };
export type CrcEvent = {
  txid: string;
  txIndex: number;
  operation: "deploy" | "mint" | "transfer" | null;
  status: "applied" | "ignored" | "invalid" | "broken";
  valid: boolean;
  reason?: string | null;
  deployTxid?: string | null;
  amountAtoms?: string | null;
  tradeSide?: "buy" | "sell" | null;
  tradeAtoms?: string | null;
  tradeGrossSats?: string | null;
  confirmedTime?: number | null;
};

const txidPattern = /^[0-9a-f]{64}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export function crcProjectionRoot(state: CrcProjection): string {
  return createHash("sha256").update(JSON.stringify(stable(state))).digest("hex");
}

function txidOf(assetKey: string, network: string): string {
  if (!assetKey.startsWith(`${network}:`)) throw new Error(`CRC asset belongs to another network: ${assetKey}`);
  const txid = assetKey.slice(network.length + 1);
  if (!txidPattern.test(txid)) throw new Error(`invalid CRC deployment identity ${assetKey}`);
  return txid;
}

function pointOf(value: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(value);
  const vout = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(vout)) throw new Error(`invalid CRC token outpoint ${value}`);
  return { txid: match[1]!, vout };
}

async function writeDelta(tx: DbTransaction, network: string, state: CrcProjection, undo: CrcUndo): Promise<void> {
  for (const key of Object.keys(undo.balances)) {
    const deployTxid = txidOf(key, network);
    for (const scriptHex of Object.keys(undo.balances[key]!)) {
      const atoms = state.balances[key]?.[scriptHex];
      if (atoms === undefined) {
        await tx.delete(schema.coveCrcBalances).where(and(eq(schema.coveCrcBalances.network, network), eq(schema.coveCrcBalances.deployTxid, deployTxid), eq(schema.coveCrcBalances.scriptHex, scriptHex)));
      } else {
        await tx.insert(schema.coveCrcBalances).values({ network, deployTxid, scriptHex, atoms: BigInt(atoms) }).onConflictDoUpdate({ target: [schema.coveCrcBalances.network, schema.coveCrcBalances.deployTxid, schema.coveCrcBalances.scriptHex], set: { atoms: BigInt(atoms) } });
      }
    }
  }
  for (const [key, coins] of Object.entries(undo.tokenUtxos ?? {})) {
    const deployTxid = txidOf(key, network);
    for (const point of Object.keys(coins)) {
      const { txid, vout } = pointOf(point);
      const coin = state.tokenUtxos?.[key]?.[point];
      if (!coin) {
        await tx.delete(schema.coveCrcTokenUtxos).where(and(
          eq(schema.coveCrcTokenUtxos.network, network), eq(schema.coveCrcTokenUtxos.deployTxid, deployTxid),
          eq(schema.coveCrcTokenUtxos.txid, txid), eq(schema.coveCrcTokenUtxos.vout, vout),
        ));
      } else {
        const row = { network, deployTxid, txid, vout, scriptHex: coin.scriptHex,
          atoms: BigInt(coin.atoms), createdHeight: BigInt(coin.createdHeight), createdBlockHash: coin.createdBlockHash };
        await tx.insert(schema.coveCrcTokenUtxos).values(row).onConflictDoUpdate({
          target: [schema.coveCrcTokenUtxos.network, schema.coveCrcTokenUtxos.deployTxid,
            schema.coveCrcTokenUtxos.txid, schema.coveCrcTokenUtxos.vout], set: row,
        });
      }
    }
  }
  for (const key of Object.keys(undo.vaults)) {
    const deployTxid = txidOf(key, network);
    const vault = state.vaults[key];
    if (!vault) {
      await tx.delete(schema.coveCrcVaults).where(and(eq(schema.coveCrcVaults.network, network), eq(schema.coveCrcVaults.deployTxid, deployTxid)));
    } else {
      const row = { network, deployTxid, txid: vault.txid, vout: vault.vout, scriptHex: vault.scriptHex, btcSats: BigInt(vault.btcSats), mintedAtoms: BigInt(vault.mintedAtoms), inventoryAtoms: BigInt(vault.inventoryAtoms), availability: vault.availability };
      await tx.insert(schema.coveCrcVaults).values(row).onConflictDoUpdate({ target: [schema.coveCrcVaults.network, schema.coveCrcVaults.deployTxid], set: row });
    }
  }
  for (const key of Object.keys(undo.assets)) {
    const deployTxid = txidOf(key, network);
    const asset = state.assets[key];
    if (!asset) {
      await tx.delete(schema.coveCrcAssets).where(and(eq(schema.coveCrcAssets.network, network), eq(schema.coveCrcAssets.deployTxid, deployTxid)));
    } else {
      const row = { network, deployTxid, ticker: asset.ticker, deployHeight: BigInt(asset.deployHeight), deployBlockHash: asset.deployBlockHash, launchSaltHex: asset.launchSaltHex, creatorScriptHex: asset.creatorScriptHex, protocolScriptHex: asset.protocolScriptHex,
        protocolVersion: asset.protocolVersion, burnedAtoms: BigInt(asset.burnedAtoms!) };
      await tx.insert(schema.coveCrcAssets).values(row).onConflictDoUpdate({ target: [schema.coveCrcAssets.network, schema.coveCrcAssets.deployTxid], set: row });
    }
  }
}

export async function readCrcProjectionInTransaction(db: DbTransaction, network: string): Promise<{ state: CrcProjection; cursor: CrcBlock | null; stateRoot: string }> {
  const [assets, vaults, balances, tokenUtxos, cursors] = await Promise.all([
    db.select().from(schema.coveCrcAssets).where(eq(schema.coveCrcAssets.network, network)),
    db.select().from(schema.coveCrcVaults).where(eq(schema.coveCrcVaults.network, network)),
    db.select().from(schema.coveCrcBalances).where(eq(schema.coveCrcBalances.network, network)),
    db.select().from(schema.coveCrcTokenUtxos).where(eq(schema.coveCrcTokenUtxos.network, network)),
    db.select().from(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network)),
  ]);
  const state: CrcProjection = { assets: {}, vaults: {}, balances: {} };
  for (const row of assets) {
    const height = Number(row.deployHeight);
    if (!Number.isSafeInteger(height)) throw new Error("CRC deployment height exceeds safe integer");
    const key = `${network}:${row.deployTxid}`;
    if (row.protocolVersion !== 3) throw new Error(`invalid CRC asset protocol version ${row.protocolVersion}`);
    state.assets[key] = { ticker: row.ticker, deployTxid: row.deployTxid, deployHeight: height, deployBlockHash: row.deployBlockHash, launchSaltHex: row.launchSaltHex, creatorScriptHex: row.creatorScriptHex, protocolScriptHex: row.protocolScriptHex,
      protocolVersion: 3, burnedAtoms: row.burnedAtoms?.toString() ?? "" };
    (state.tokenUtxos ??= {})[key] = {};
  }
  for (const row of vaults) {
    if (row.availability !== "active" && row.availability !== "unavailable") throw new Error(`invalid CRC vault availability ${row.availability}`);
    state.vaults[`${network}:${row.deployTxid}`] = { txid: row.txid, vout: row.vout, scriptHex: row.scriptHex, btcSats: row.btcSats.toString(), mintedAtoms: row.mintedAtoms.toString(), inventoryAtoms: row.inventoryAtoms.toString(), availability: row.availability };
  }
  for (const row of balances) {
    const key = `${network}:${row.deployTxid}`;
    (state.balances[key] ??= {})[row.scriptHex] = row.atoms.toString();
  }
  for (const row of tokenUtxos) {
    const key = `${network}:${row.deployTxid}`;
    const height = Number(row.createdHeight);
    if (!Number.isSafeInteger(height)) throw new Error("CRC token creation height exceeds safe integer");
    (state.tokenUtxos ??= {})[key] ??= {};
    state.tokenUtxos[key]![`${row.txid}:${row.vout}`] = {
      scriptHex: row.scriptHex, atoms: row.atoms.toString(), createdHeight: height,
      createdBlockHash: row.createdBlockHash,
    };
  }
  applyCrcBlock(state, state, network);
  const root = crcProjectionRoot(state);
  const cursor = cursors[0];
  if (cursor && cursor.stateRoot !== root) throw new Error(`CRC projection root mismatch for ${network}`);
  if (!cursor && (assets.length || vaults.length || balances.length || tokenUtxos.length)) throw new Error(`CRC projection exists without cursor for ${network}`);
  const height = cursor ? Number(cursor.height) : null;
  if (height !== null && !Number.isSafeInteger(height)) throw new Error("CRC cursor height exceeds safe integer");
  return { state, cursor: cursor ? { height: height!, hash: cursor.blockHash, parentHash: "" } : null, stateRoot: root };
}

export async function hydrateCrcProjection(db: Database, network: string): Promise<{ state: CrcProjection; cursor: CrcBlock | null; stateRoot: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    return readCrcProjectionInTransaction(tx, network);
  });
}

export async function persistCrcBlock(db: Database, network: string, block: CrcBlock, before: CrcProjection, after: CrcProjection, events: readonly CrcEvent[]): Promise<boolean> {
  if (!Number.isSafeInteger(block.height) || block.height < 0 || !txidPattern.test(block.hash) || !txidPattern.test(block.parentHash)) throw new Error("invalid CRC block cursor");
  const { undo } = applyCrcBlock(before, after, network);
  const beforeRoot = crcProjectionRoot(before);
  const afterRoot = crcProjectionRoot(after);
  for (const event of events) {
    if (!txidPattern.test(event.txid) || !Number.isSafeInteger(event.txIndex) || event.txIndex < 0 || (event.deployTxid && !txidPattern.test(event.deployTxid)) || (event.amountAtoms && !/^[1-9][0-9]*$/.test(event.amountAtoms)) ||
      (event.tradeSide && !["buy", "sell"].includes(event.tradeSide)) ||
      (event.tradeAtoms && !/^[1-9][0-9]*$/.test(event.tradeAtoms)) ||
      (event.tradeGrossSats && !/^[1-9][0-9]*$/.test(event.tradeGrossSats)) ||
      (event.confirmedTime !== undefined && event.confirmedTime !== null && (!Number.isSafeInteger(event.confirmedTime) || event.confirmedTime < 0))) throw new Error("invalid CRC event");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cove-crc:${network}`}))`);
    const [cursor] = await tx.select().from(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network));
    if (cursor?.height === BigInt(block.height) && cursor.blockHash === block.hash) return false;
    if (cursor) {
      if (cursor.stateRoot !== beforeRoot || cursor.height + 1n !== BigInt(block.height) || cursor.blockHash !== block.parentHash) throw new Error("CRC block does not extend canonical cursor");
    } else if (beforeRoot !== crcProjectionRoot({ assets: {}, vaults: {}, balances: {} })) {
      throw new Error("CRC first block must start from empty projection");
    }
    await writeDelta(tx, network, after, undo);
    await tx.insert(schema.coveCrcBlocks).values({ network, height: BigInt(block.height), hash: block.hash, parentHash: block.parentHash, stateRoot: afterRoot });
    if (events.length) await tx.insert(schema.coveCrcEvents).values(events.map((event) => ({ network, txid: event.txid, blockHeight: BigInt(block.height), blockHash: block.hash, txIndex: event.txIndex, operation: event.operation, status: event.status, valid: event.valid, reason: event.reason ?? null, deployTxid: event.deployTxid ?? null, amountAtoms: event.amountAtoms ? BigInt(event.amountAtoms) : null, tradeSide: event.tradeSide ?? null, tradeAtoms: event.tradeAtoms ? BigInt(event.tradeAtoms) : null, tradeGrossSats: event.tradeGrossSats ? BigInt(event.tradeGrossSats) : null, confirmedTime: event.confirmedTime ? BigInt(event.confirmedTime) : null })));
    await tx.insert(schema.coveCrcUndo).values({ network, height: BigInt(block.height), blockHash: block.hash, priorHeight: cursor?.height ?? null, priorHash: cursor?.blockHash ?? null, priorRoot: beforeRoot, undoJson: undo });
    await tx.insert(schema.coveCrcCursor).values({ network, height: BigInt(block.height), blockHash: block.hash, stateRoot: afterRoot }).onConflictDoUpdate({ target: schema.coveCrcCursor.network, set: { height: BigInt(block.height), blockHash: block.hash, stateRoot: afterRoot } });
    return true;
  });
}

export async function rollbackCrcTip(db: Database, network: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cove-crc:${network}`}))`);
    const [cursor] = await tx.select().from(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network));
    if (!cursor) return false;
    const [record] = await tx.select().from(schema.coveCrcUndo).where(and(eq(schema.coveCrcUndo.network, network), eq(schema.coveCrcUndo.height, cursor.height)));
    if (!record || record.blockHash !== cursor.blockHash) throw new Error("CRC undo journal missing for canonical tip");
    const undo = record.undoJson as CrcUndo;
    const prior: CrcProjection = { assets: {}, vaults: {}, balances: {} };
    for (const [key, value] of Object.entries(undo.assets)) if (value) prior.assets[key] = value;
    for (const [key, value] of Object.entries(undo.vaults)) if (value) prior.vaults[key] = value;
    for (const [key, holders] of Object.entries(undo.balances)) {
      for (const [script, atoms] of Object.entries(holders)) if (atoms !== null) (prior.balances[key] ??= {})[script] = atoms;
    }
    for (const [key, coins] of Object.entries(undo.tokenUtxos ?? {})) {
      for (const [point, coin] of Object.entries(coins)) {
        if (coin !== null) ((prior.tokenUtxos ??= {})[key] ??= {})[point] = coin;
      }
    }
    await writeDelta(tx, network, prior, undo);
    await tx.delete(schema.coveCrcEvents).where(and(eq(schema.coveCrcEvents.network, network), eq(schema.coveCrcEvents.blockHash, cursor.blockHash)));
    await tx.delete(schema.coveCrcBlocks).where(and(eq(schema.coveCrcBlocks.network, network), eq(schema.coveCrcBlocks.height, cursor.height)));
    await tx.delete(schema.coveCrcUndo).where(and(eq(schema.coveCrcUndo.network, network), eq(schema.coveCrcUndo.height, cursor.height)));
    if (record.priorHeight === null || record.priorHash === null) await tx.delete(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network));
    else await tx.update(schema.coveCrcCursor).set({ height: record.priorHeight, blockHash: record.priorHash, stateRoot: record.priorRoot }).where(eq(schema.coveCrcCursor.network, network));
    return true;
  });
}
