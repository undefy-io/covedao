import { Transaction } from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import { requiredBackingV1 } from "@crclaunch/crc20-curve";
import { applyCoveConfirmed, type CoveAsset, type CoveLedgerState } from "@crclaunch/crc20-ledger/cove-replay";
import type { BitcoinNetwork } from "@crclaunch/crc20-base";
import type { Database } from "@crclaunch/db";
import { schema } from "@crclaunch/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { persistCrcBlock, readCrcProjectionInTransaction, type CrcBlock, type CrcEvent } from "./store.js";
import type { CrcProjection } from "./persistence.js";
import { prepareCrcLaunchIntent } from "./intents.js";

export type CrcRawBlock = CrcBlock & { network: BitcoinNetwork; rawTxs: readonly string[] };
export type CrcReplayEvent = CrcEvent & { blockHeight: number };
export type ParentProvider = Pick<{ getRawTransaction(txid: string): Promise<string> }, "getRawTransaction">;
export type RegisteredCoveDeployment = Readonly<{ network: BitcoinNetwork; txid: string; vaultScriptHex: string; creatorScriptHex: string; protocolScriptHex: string; vaultAnchorSats: number; launchSaltHex: string; rawSha256: string }>;

const txidPattern = /^[0-9a-f]{64}$/;
const emptyProjection = (): CrcProjection => ({ assets: {}, vaults: {}, balances: {} });

function outpoint(input: Transaction["ins"][number]): string {
  return `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`;
}

function relevant(tx: Transaction, txid: string, network: BitcoinNetwork, state: CoveLedgerState, registeredTxids: ReadonlySet<string>, liveVaults: ReadonlyMap<string, string>): boolean {
  if (tx.ins.length === 1 && tx.ins[0]!.index === 0xffffffff && tx.ins[0]!.hash.equals(Buffer.alloc(32))) return false;
  if (tx.ins.some((input) => liveVaults.has(outpoint(input)))) return true;
  const parsed = parseCrc20Transaction(tx.outs.map((output) => ({ scriptHex: output.script.toString("hex"), valueSats: output.value })));
  if (parsed.status !== "valid") return false;
  if (parsed.envelope.kind === "deploy") return registeredTxids.has(txid);
  const id = parsed.envelope.payload.id;
  return typeof id === "string" && !!state.assets[`${network}:${id}`];
}

export async function replayCrcBlock(
  initial: CoveLedgerState,
  block: CrcRawBlock,
  registrations: readonly RegisteredCoveDeployment[],
  provider: ParentProvider,
): Promise<{ state: CoveLedgerState; events: CrcReplayEvent[] }> {
  if (!Number.isSafeInteger(block.height) || block.height < 0 || !txidPattern.test(block.hash) || !txidPattern.test(block.parentHash)) throw new Error("invalid confirmed CRC block");
  const txs = block.rawTxs.map((raw) => Transaction.fromHex(raw));
  const txids = txs.map((tx) => tx.getId());
  const seen = new Map<string, string>();
  const parentCache = new Map<string, Promise<string>>();
  const registeredTxids = new Set(registrations.filter((entry) => entry.network === block.network).map((entry) => entry.txid));
  const liveVaults = new Map<string, string>();
  for (const [assetId, asset] of Object.entries(initial.assets)) if (asset.status === "live") liveVaults.set(asset.curve.vaultOutpoint, assetId);
  const events: CrcReplayEvent[] = [];
  let state = initial;
  for (let index = 0; index < txs.length; index++) {
    const tx = txs[index]!;
    const txid = txids[index]!;
    const rawHex = block.rawTxs[index]!;
    if (relevant(tx, txid, block.network, state, registeredTxids, liveVaults)) {
      const spentVaults = tx.ins.map((input) => ({ point: outpoint(input), assetId: liveVaults.get(outpoint(input)) })).filter((item): item is { point: string; assetId: string } => !!item.assetId);
      const marker = parseCrc20Transaction(tx.outs.map((output) => ({ scriptHex: output.script.toString("hex"), valueSats: output.value })));
      if (marker.status === "valid" && marker.envelope.kind === "deploy" && spentVaults.length === 0) {
        const registration = registrations.find((entry) => entry.network === block.network && entry.txid === txid);
        const rawHash = createHash("sha256").update(Buffer.from(rawHex, "hex")).digest("hex");
        if (!registration || registration.rawSha256 !== rawHash) {
          events.push({ txid, blockHeight: block.height, txIndex: index, operation: "deploy", status: "invalid", valid: false, reason: "confirmed raw deployment differs from authorized launch intent", deployTxid: txid });
          seen.set(txid, rawHex);
          continue;
        }
      }
      const parents: string[] = [];
      for (const input of tx.ins) {
        const parentTxid = Buffer.from(input.hash).reverse().toString("hex");
        let parent = parentCache.get(parentTxid);
        if (!parent) {
          parent = Promise.resolve(seen.get(parentTxid) ?? provider.getRawTransaction(parentTxid));
          parentCache.set(parentTxid, parent);
        }
        const rawParent = await parent;
        if (Transaction.fromHex(rawParent).getId() !== parentTxid) throw new Error(`Core returned wrong CRC parent transaction ${parentTxid}`);
        parents.push(rawParent);
      }
      const outputs = tx.outs.map((output) => ({ scriptHex: output.script.toString("hex"), valueSats: output.value }));
      const parsed = parseCrc20Transaction(outputs);
      const result = applyCoveConfirmed(state, {
        network: block.network, rawHex, parentRawHexes: parents, blockHash: block.hash,
        blockTxids: txids, height: block.height, index,
      }, registrations);
      if (result.status === "invalid" && result.reason === "parent transaction does not match raw input outpoint") throw new Error(result.reason);
      state = result.state;
      for (const { point, assetId } of spentVaults) {
        liveVaults.delete(point);
        const updated = state.assets[assetId];
        if (updated?.status === "live") liveVaults.set(updated.curve.vaultOutpoint, assetId);
      }
      if (result.status === "applied" && parsed.status === "valid" && parsed.envelope.kind === "deploy") {
        const deployed = state.assets[`${block.network}:${txid}`];
        if (deployed?.status === "live") liveVaults.set(deployed.curve.vaultOutpoint, `${block.network}:${txid}`);
      }
      const markerId = parsed.status === "valid" && parsed.envelope.kind !== "deploy" ? parsed.envelope.payload.id : null;
      const brokenId = result.status === "broken" ? Object.entries(state.assets).find(([, asset]) => asset.status === "broken" && tx.ins.some((input) => asset.curve.vaultOutpoint === outpoint(input)))?.[0]?.split(":")[1] : undefined;
      events.push({
        txid, blockHeight: block.height, txIndex: index,
        operation: parsed.status === "valid" ? parsed.envelope.kind : null,
        status: result.status, valid: result.status === "applied", reason: result.reason,
        deployTxid: parsed.status === "valid" && parsed.envelope.kind === "deploy" ? txid : typeof markerId === "string" && txidPattern.test(markerId) ? markerId : brokenId ?? null,
        amountAtoms: parsed.status === "valid" && parsed.envelope.kind !== "deploy" && typeof parsed.envelope.payload.amt === "string" && /^[1-9][0-9]*$/.test(parsed.envelope.payload.amt) ? parsed.envelope.payload.amt : null,
      });
    }
    seen.set(txid, rawHex);
  }
  return { state, events };
}

export function projectionFromCoveLedger(state: CoveLedgerState, before: CrcProjection, block: CrcBlock, registrations: readonly RegisteredCoveDeployment[]): CrcProjection {
  const projection = emptyProjection();
  for (const [key, asset] of Object.entries(state.assets)) {
    const deployTxid = key.slice(key.indexOf(":") + 1);
    const prior = before.assets[key];
    const registration = registrations.find((entry) => entry.txid === deployTxid && key.startsWith(`${entry.network}:`));
    if (!prior && !registration) throw new Error(`missing trusted Cove launch intent for ${key}`);
    projection.assets[key] = prior ?? {
      ticker: asset.ticker, deployTxid, deployHeight: block.height, deployBlockHash: block.hash,
      launchSaltHex: registration!.launchSaltHex,
      creatorScriptHex: asset.creatorScriptHex, protocolScriptHex: asset.protocolScriptHex,
    };
    const split = asset.curve.vaultOutpoint.lastIndexOf(":");
    const vaultTxid = asset.curve.vaultOutpoint.slice(0, split);
    const vaultVout = Number(asset.curve.vaultOutpoint.slice(split + 1));
    projection.vaults[key] = {
      txid: vaultTxid, vout: vaultVout, scriptHex: asset.vaultScriptHex,
      btcSats: asset.curve.vaultSats.toString(), mintedAtoms: asset.curve.mintedAtoms.toString(),
      inventoryAtoms: asset.curve.vaultAtoms.toString(), availability: asset.status === "live" ? "active" : "unavailable",
    };
    for (const [script, atoms] of Object.entries(asset.balances)) {
      if (atoms !== "0") (projection.balances[key] ??= {})[script] = atoms;
    }
  }
  return projection;
}

export function coveLedgerFromProjection(projection: CrcProjection, events: readonly CrcReplayEvent[], network: BitcoinNetwork, trustedAnchors: Readonly<Record<string, bigint>>): CoveLedgerState {
  const assets: Record<string, CoveAsset> = {};
  for (const [key, meta] of Object.entries(projection.assets)) {
    if (!key.startsWith(`${network}:`)) throw new Error("CRC projection network mismatch");
    const vault = projection.vaults[key];
    if (!vault) throw new Error("CRC asset missing vault");
    const mintedAtoms = BigInt(vault.mintedAtoms), vaultAtoms = BigInt(vault.inventoryAtoms);
    const circulatingAtoms = mintedAtoms - vaultAtoms;
    if (circulatingAtoms < 0n || circulatingAtoms % 100_000_000n !== 0n) throw new Error("invalid CRC circulating supply");
    const vaultSats = BigInt(vault.btcSats);
    const vaultAnchorSats = trustedAnchors[key];
    if (vaultAnchorSats === undefined || vaultAnchorSats < 0n || vaultSats !== vaultAnchorSats + requiredBackingV1(circulatingAtoms / 100_000_000n)) throw new Error("CRC vault backing does not match trusted launch anchor");
    assets[key] = {
      ticker: meta.ticker, status: vault.availability === "active" ? "live" : "broken",
      vaultScriptHex: vault.scriptHex, creatorScriptHex: meta.creatorScriptHex, protocolScriptHex: meta.protocolScriptHex,
      curve: { version: "cove-curve-v1", mintedAtoms, vaultAtoms, circulatingAtoms, vaultSats, vaultAnchorSats, vaultOutpoint: `${vault.txid}:${vault.vout}` },
      balances: { ...projection.balances[key] },
    };
  }
  const appliedTxids: CoveLedgerState["appliedTxids"] = {};
  let latest: { height: number; index: number } | undefined;
  for (const event of events) {
    if (event.status !== "applied" && event.status !== "broken") continue;
    appliedTxids[`${network}:${event.txid}`] = true;
    const position = { height: event.blockHeight, index: event.txIndex };
    if (!latest || position.height > latest.height || (position.height === latest.height && position.index > latest.index)) latest = position;
  }
  return { assets, appliedTxids, lastPosition: latest ? { [network]: latest } : {} };
}

export async function hydrateCrcLedger(db: Database, network: BitcoinNetwork): Promise<{ state: CoveLedgerState; projection: CrcProjection; cursor: CrcBlock | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const hydrated = await readCrcProjectionInTransaction(tx, network);
    const deployTxids = Object.keys(hydrated.state.assets).map((key) => key.slice(network.length + 1));
    const intents = deployTxids.length ? await tx.select().from(schema.coveCrcLaunchIntents).where(and(eq(schema.coveCrcLaunchIntents.network, network), inArray(schema.coveCrcLaunchIntents.txid, deployTxids))) : [];
    const trustedAnchors: Record<string, bigint> = {};
    for (const intent of intents) {
      if (intent.network !== network || !Number.isSafeInteger(Number(intent.vaultAnchorSats))) throw new Error("CRC trusted launch intent network or anchor mismatch");
      const key = `${network}:${intent.txid}`;
      const asset = hydrated.state.assets[key];
      const vault = hydrated.state.vaults[key];
      if (!asset || !vault) continue;
      const verified = prepareCrcLaunchIntent(network, intent.signedRawHex, {
        launchSaltHex: intent.launchSaltHex, vaultScriptHex: intent.vaultScriptHex,
        creatorScriptHex: intent.creatorScriptHex, protocolScriptHex: intent.protocolScriptHex,
        vaultAnchorSats: Number(intent.vaultAnchorSats),
      });
      if (verified.txid !== intent.txid || verified.rawSha256 !== intent.rawSha256 ||
        verified.ticker !== asset.ticker || intent.launchSaltHex !== asset.launchSaltHex ||
        intent.vaultScriptHex !== vault.scriptHex || intent.creatorScriptHex !== asset.creatorScriptHex ||
        intent.protocolScriptHex !== asset.protocolScriptHex) throw new Error("CRC canonical asset does not match trusted launch intent");
      trustedAnchors[key] = intent.vaultAnchorSats;
    }
    const rows = await tx.select().from(schema.coveCrcEvents).where(eq(schema.coveCrcEvents.network, network));
    const events: CrcReplayEvent[] = rows.map((row) => {
    const blockHeight = Number(row.blockHeight);
    if (!Number.isSafeInteger(blockHeight)) throw new Error("CRC event height exceeds safe integer");
    if (row.status !== "applied" && row.status !== "ignored" && row.status !== "invalid" && row.status !== "broken") throw new Error("invalid CRC event status");
    return {
      txid: row.txid, blockHeight, txIndex: row.txIndex,
      operation: row.operation === "deploy" || row.operation === "mint" || row.operation === "transfer" ? row.operation : null,
      status: row.status, valid: row.valid, reason: row.reason,
      deployTxid: row.deployTxid, amountAtoms: row.amountAtoms?.toString() ?? null,
    };
    });
    return { state: coveLedgerFromProjection(hydrated.state, events, network, trustedAnchors), projection: hydrated.state, cursor: hydrated.cursor };
  });
}

export async function persistConfirmedCrcBlock(
  db: Database,
  initial: CoveLedgerState,
  before: CrcProjection,
  block: CrcRawBlock,
  registrations: readonly RegisteredCoveDeployment[],
  provider: ParentProvider,
): Promise<CoveLedgerState> {
  const replayed = await replayCrcBlock(initial, block, registrations, provider);
  const after = projectionFromCoveLedger(replayed.state, before, block, registrations);
  const committed = await persistCrcBlock(db, block.network, block, before, after, replayed.events);
  return committed ? replayed.state : initial;
}
