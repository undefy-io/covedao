import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lte, desc, sql } from "drizzle-orm";
import { schema, type Database, type DbTransaction } from "@crclaunch/db";
import * as core from "@crclaunch/crc20-protocol";
import type {
  Block,
  BlockUndo,
  Config,
  Ledger,
  LedgerState,
  ProtocolNetwork,
} from "@crclaunch/crc20-protocol";
const kinds = ["assets", "allocations", "offers", "spent", "seen"] as const;
type Kind = (typeof kinds)[number];
type Reader = Database | DbTransaction;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
export function crcCoreStateRoot(state: Ledger | LedgerState): string {
  const snapshot = "history" in state ? core.snapshotLedger(state) : state;
  return createHash("sha256")
    .update(JSON.stringify(stable(core.encodeProtocolDto(snapshot))))
    .digest("hex");
}
async function lock(tx: DbTransaction, network: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`crc:${network}`}))`);
}
async function readLedger(db: Reader, network: ProtocolNetwork): Promise<Ledger | null> {
  const [settings] = await db
    .select()
    .from(schema.crcNetworks)
    .where(eq(schema.crcNetworks.network, network));
  if (!settings) return null;
  const [cursor] = await db
    .select()
    .from(schema.crcCursors)
    .where(eq(schema.crcCursors.network, network));
  if (!cursor) throw new Error("CRC cursor record missing");
  const state = core.emptyLedger(core.decodeProtocolDto<Config>(settings.configJson));
  const rows = await db
    .select()
    .from(schema.crcRecords)
    .where(eq(schema.crcRecords.network, network));
  for (const row of rows) {
    if (!kinds.includes(row.kind as Kind)) throw new Error("unknown CRC record kind");
    (state[row.kind as Kind] as Record<string, unknown>)[row.key] = core.decodeProtocolDto(
      row.valueJson,
    );
  }
  if (cursor.height !== null) {
    if (!cursor.blockHash || !cursor.fingerprint) throw new Error("incomplete CRC cursor");
    state.tip = {
      hash: cursor.blockHash,
      height: Number(cursor.height),
      fingerprint: cursor.fingerprint,
    };
  }
  const undos = await db
    .select()
    .from(schema.crcUndo)
    .where(eq(schema.crcUndo.network, network))
    .orderBy(schema.crcUndo.height);
  for (const undo of undos)
    state.history[undo.blockHash] = core.decodeProtocolDto<BlockUndo>(undo.undoJson);
  const restored = core.restoreLedger(core.snapshotLedger(state), state.history);
  if (crcCoreStateRoot(restored) !== cursor.stateRoot)
    throw new Error("CRC persisted state root mismatch");
  return restored;
}
export async function loadCrcCoreLedger(db: Database, network: string): Promise<Ledger | null> {
  const selected = core.protocolNetwork(network);
  return db.transaction(async (tx) => {
    await lock(tx, selected);
    return readLedger(tx, selected);
  });
}
export async function initializeCrcLedger(
  db: Database,
  config: Config,
  options: { activationHeight?: number } = {},
): Promise<void> {
  const state = core.emptyLedger(config),
    network = core.protocolNetwork(config.network),
    activationHeight = options.activationHeight ?? 1;
  if (!Number.isSafeInteger(activationHeight) || activationHeight < 1)
    throw new Error("invalid CRC activation height");
  await db.transaction(async (tx) => {
    await lock(tx, network);
    const [settings] = await tx
      .select()
      .from(schema.crcNetworks)
      .where(eq(schema.crcNetworks.network, network));
    if (settings) {
      if (
        settings.activationHeight !== BigInt(activationHeight) ||
        JSON.stringify(stable(settings.configJson)) !==
          JSON.stringify(stable(core.encodeProtocolDto(config)))
      )
        throw new Error("CRC network initialization conflict");
      return;
    }
    const stateRoot = crcCoreStateRoot(state);
    await tx.insert(schema.crcNetworks).values({
      network,
      configJson: core.encodeProtocolDto(config),
      activationHeight: BigInt(activationHeight),
    });
    await tx.insert(schema.crcCursors).values({ network, stateRoot });
    await tx.insert(schema.crcCheckpoints).values({
      network,
      height: BigInt(activationHeight - 1),
      baseline: true,
      stateJson: core.encodeProtocolDto(core.snapshotLedger(state)),
      stateRoot,
    });
  });
}
function record(
  state: Ledger,
  network: string,
  kind: Kind,
  key: string,
): typeof schema.crcRecords.$inferInsert {
  const value = state[kind][key];
  if (value === undefined) throw new Error("missing CRC record");
  const base = {
    network,
    kind,
    key,
    valueJson: core.encodeProtocolDto(value),
    deployTxid: null as string | null,
    scriptHex: null as string | null,
    atoms: null as bigint | null,
    sats: null as bigint | null,
    status: null as string | null,
  };
  if (kind === "allocations") {
    const allocation = state.allocations[key]!;
    return {
      ...base,
      deployTxid: allocation.deployTxid,
      scriptHex: allocation.scriptHex,
      atoms: allocation.atoms,
      sats: allocation.sats,
    };
  }
  if (kind === "assets") {
    const asset = state.assets[key]!;
    return {
      ...base,
      deployTxid: asset.deployTxid,
      scriptHex: asset.vault.scriptHex,
      atoms: asset.issuedAtoms,
      sats: core.sats(asset.vault.sats),
      status: asset.vaultAvailable === false ? "unavailable" : "active",
    };
  }
  if (kind === "offers") {
    const offer = state.offers[key]!;
    return {
      ...base,
      deployTxid: offer.deployTxid,
      scriptHex: offer.sellerScriptHex,
      atoms: offer.listedInput.atoms,
      sats: offer.priceSats,
      status: offer.status ?? "open",
    };
  }
  return base;
}
async function writeRecords(
  tx: DbTransaction,
  network: string,
  state: Ledger,
  changes?: BlockUndo,
): Promise<void> {
  for (const kind of kinds) {
    const keys = Object.keys(changes ? changes[kind] : state[kind]);
    const removed = keys.filter((key) => state[kind][key] === undefined);
    for (let i = 0; i < removed.length; i += 1000)
      await tx
        .delete(schema.crcRecords)
        .where(
          and(
            eq(schema.crcRecords.network, network),
            eq(schema.crcRecords.kind, kind),
            inArray(schema.crcRecords.key, removed.slice(i, i + 1000)),
          ),
        );
    const rows = keys
      .filter((key) => state[kind][key] !== undefined)
      .map((key) => record(state, network, kind, key));
    for (let i = 0; i < rows.length; i += 1000)
      await tx
        .insert(schema.crcRecords)
        .values(rows.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: [schema.crcRecords.network, schema.crcRecords.kind, schema.crcRecords.key],
          set: {
            valueJson: sql`excluded.value_json`,
            deployTxid: sql`excluded.deploy_txid`,
            scriptHex: sql`excluded.script_hex`,
            atoms: sql`excluded.atoms`,
            sats: sql`excluded.sats`,
            status: sql`excluded.status`,
          },
        });
  }
}
async function writeCursor(tx: DbTransaction, network: string, state: Ledger): Promise<void> {
  await tx
    .update(schema.crcCursors)
    .set({
      height: state.tip ? BigInt(state.tip.height) : null,
      blockHash: state.tip?.hash ?? null,
      fingerprint: state.tip?.fingerprint ?? null,
      stateRoot: crcCoreStateRoot(state),
    })
    .where(eq(schema.crcCursors.network, network));
}
export interface CrcPersistenceOptions {
  undoLimit?: number;
  checkpointInterval?: number;
  checkpointLimit?: number;
}
export async function persistCrcCoreBlock(
  db: Database,
  network: string,
  block: Block,
  registeredDeployments: Record<string, Config>,
  options: CrcPersistenceOptions = {},
): Promise<{ state: Ledger; changed: boolean }> {
  const selected = core.protocolNetwork(network),
    undoLimit = options.undoLimit ?? 32,
    interval = options.checkpointInterval ?? 1000,
    limit = options.checkpointLimit ?? 4;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("invalid checkpoint retention");
  return db.transaction(async (tx) => {
    await lock(tx, selected);
    const before = await readLedger(tx, selected);
    if (!before) throw new Error("CRC network not initialized");
    const [settings] = await tx
      .select()
      .from(schema.crcNetworks)
      .where(eq(schema.crcNetworks.network, selected));
    if (!before.tip && BigInt(block.height) !== settings!.activationHeight)
      throw new Error("first CRC block must match activation height");
    const currentRegistrations = await loadCrcRegistrations(tx, selected);
    if (
      JSON.stringify(stable(core.encodeProtocolDto(currentRegistrations))) !==
      JSON.stringify(stable(core.encodeProtocolDto(registeredDeployments)))
    )
      throw new Error("CRC registrations changed during observation; retry");
    const accepted = core.applyConfirmedBlockDetailed(before, block, {
      registeredDeployments: currentRegistrations,
      undoLimit,
      authorizations: await authorizations(tx, selected),
    });
    const next = accepted.ledger;
    if (next === before) return { state: before, changed: false };
    const undo = next.history[block.hash]!;
    await writeRecords(tx, selected, next, undo);
    if (accepted.events.length)
      await tx.insert(schema.crcEvents).values(
        accepted.events.map((event) => ({
          network: selected,
          txid: event.txid,
          deployTxid: event.deployTxid,
          blockHeight: BigInt(block.height),
          blockHash: block.hash,
          txIndex: event.txIndex,
          confirmedTime: block.timestamp ?? null,
          eventJson: core.encodeProtocolDto(event),
        })),
      );
    await tx.insert(schema.crcUndo).values({
      network: selected,
      height: BigInt(block.height),
      blockHash: block.hash,
      undoJson: core.encodeProtocolDto(undo),
    });
    const retained = Object.keys(next.history);
    const existing = await tx
      .select({ height: schema.crcUndo.height, blockHash: schema.crcUndo.blockHash })
      .from(schema.crcUndo)
      .where(eq(schema.crcUndo.network, selected));
    const removed = existing
      .filter((row) => !retained.includes(row.blockHash))
      .map((row) => row.height);
    if (removed.length)
      await tx
        .delete(schema.crcUndo)
        .where(and(eq(schema.crcUndo.network, selected), inArray(schema.crcUndo.height, removed)));
    await tx.insert(schema.crcIndexedBlocks).values({
      network: selected,
      height: BigInt(block.height),
      hash: block.hash,
      parentHash: block.parentHash,
      fingerprint: next.tip!.fingerprint,
    });
    if (block.height % interval === 0) {
      await tx.insert(schema.crcCheckpoints).values({
        network: selected,
        height: BigInt(block.height),
        blockHash: block.hash,
        stateJson: core.encodeProtocolDto(core.snapshotLedger(next)),
        stateRoot: crcCoreStateRoot(next),
      });
      const checkpoints = await tx
        .select({ height: schema.crcCheckpoints.height })
        .from(schema.crcCheckpoints)
        .where(
          and(
            eq(schema.crcCheckpoints.network, selected),
            eq(schema.crcCheckpoints.baseline, false),
          ),
        )
        .orderBy(desc(schema.crcCheckpoints.height));
      const expired = checkpoints.slice(limit).map((row) => row.height);
      if (expired.length)
        await tx
          .delete(schema.crcCheckpoints)
          .where(
            and(
              eq(schema.crcCheckpoints.network, selected),
              inArray(schema.crcCheckpoints.height, expired),
            ),
          );
    }
    await writeCursor(tx, selected, next);
    return { state: next, changed: true };
  });
}
export async function rollbackCrcCoreTip(db: Database, network: string): Promise<boolean> {
  const selected = core.protocolNetwork(network);
  return db.transaction(async (tx) => {
    await lock(tx, selected);
    const state = await readLedger(tx, selected);
    if (!state?.tip) return false;
    const undo = state.history[state.tip.hash];
    if (!undo) throw new Error("CRC undo unavailable; checkpoint replay required");
    const before = core.rehydrateOfferAuthorizations(
      core.rollbackBlock(state, state.tip.hash),
      await authorizations(tx, selected),
    );
    await writeRecords(tx, selected, before, {
      ...undo,
      offers: Object.fromEntries(
        [...new Set([...Object.keys(state.offers), ...Object.keys(before.offers)])].map((key) => [
          key,
          null,
        ]),
      ),
    });
    // Later actionable offers pruned by the core are not necessarily in the block delta.
    const orphaned = Object.keys(state.offers).filter((key) => before.offers[key] === undefined);
    if (orphaned.length)
      await tx
        .delete(schema.crcRecords)
        .where(
          and(
            eq(schema.crcRecords.network, selected),
            eq(schema.crcRecords.kind, "offers"),
            inArray(schema.crcRecords.key, orphaned),
          ),
        );
    await tx
      .delete(schema.crcUndo)
      .where(
        and(eq(schema.crcUndo.network, selected), eq(schema.crcUndo.blockHash, state.tip.hash)),
      );
    await tx
      .delete(schema.crcEvents)
      .where(
        and(eq(schema.crcEvents.network, selected), eq(schema.crcEvents.blockHash, state.tip.hash)),
      );
    await tx
      .delete(schema.crcIndexedBlocks)
      .where(
        and(
          eq(schema.crcIndexedBlocks.network, selected),
          eq(schema.crcIndexedBlocks.hash, state.tip.hash),
        ),
      );
    await tx
      .delete(schema.crcCheckpoints)
      .where(
        and(
          eq(schema.crcCheckpoints.network, selected),
          eq(schema.crcCheckpoints.blockHash, state.tip.hash),
        ),
      );
    await writeCursor(tx, selected, before);
    return true;
  });
}
export async function restoreCrcCheckpoint(
  db: Database,
  network: string,
  maxHeight: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(maxHeight) || maxHeight < 0)
    throw new Error("invalid checkpoint height");
  const selected = core.protocolNetwork(network);
  return db.transaction(async (tx) => {
    await lock(tx, selected);
    const [checkpoint] = await tx
      .select()
      .from(schema.crcCheckpoints)
      .where(
        and(
          eq(schema.crcCheckpoints.network, selected),
          lte(schema.crcCheckpoints.height, BigInt(maxHeight)),
        ),
      )
      .orderBy(desc(schema.crcCheckpoints.height))
      .limit(1);
    if (!checkpoint) return false;
    let state = core.restoreLedger(core.decodeProtocolDto<LedgerState>(checkpoint.stateJson));
    if (crcCoreStateRoot(state) !== checkpoint.stateRoot)
      throw new Error("CRC checkpoint root mismatch");
    state = core.rehydrateOfferAuthorizations(state, await authorizations(tx, selected));
    await tx.delete(schema.crcRecords).where(eq(schema.crcRecords.network, selected));
    await writeRecords(tx, selected, state);
    await tx.delete(schema.crcUndo).where(eq(schema.crcUndo.network, selected));
    await tx
      .delete(schema.crcEvents)
      .where(
        and(
          eq(schema.crcEvents.network, selected),
          gt(schema.crcEvents.blockHeight, checkpoint.height),
        ),
      );
    await tx
      .delete(schema.crcIndexedBlocks)
      .where(
        and(
          eq(schema.crcIndexedBlocks.network, selected),
          gt(schema.crcIndexedBlocks.height, checkpoint.height),
        ),
      );
    await tx
      .delete(schema.crcCheckpoints)
      .where(
        and(
          eq(schema.crcCheckpoints.network, selected),
          gt(schema.crcCheckpoints.height, checkpoint.height),
        ),
      );
    await writeCursor(tx, selected, state);
    return true;
  });
}
/** Called only by the trusted deployment admission boundary, never discovered from a marker. */
export async function saveCrcRegistration(
  db: Database,
  config: Config,
  transaction: core.ChainTransaction,
): Promise<string> {
  const network = core.protocolNetwork(config.network);
  const checked = core.applyBlock(core.emptyLedger(config), {
    height: 1,
    hash: "1".repeat(64),
    parentHash: "0".repeat(64),
    transactions: [transaction],
  });
  const txid = core.parseRawTransaction(transaction.rawHex).txid;
  if (!checked.assets[txid]) throw new Error("registration must be a valid signed deployment");
  await db.transaction(async (tx) => {
    await lock(tx, network);
    const state = await readLedger(tx, network);
    if (!state) throw new Error("CRC network not initialized");
    const [existing] = await tx
      .select()
      .from(schema.crcRegistrations)
      .where(
        and(
          eq(schema.crcRegistrations.network, network),
          eq(schema.crcRegistrations.deployTxid, txid),
        ),
      );
    if (existing) {
      if (
        JSON.stringify(stable(existing.configJson)) !==
        JSON.stringify(stable(core.encodeProtocolDto(config)))
      )
        throw new Error("conflicting deployment registration");
      return;
    }
    await tx.insert(schema.crcRegistrations).values({
      network,
      deployTxid: txid,
      configJson: core.encodeProtocolDto(config),
      signedRawHex: transaction.rawHex,
    });
  });
  return txid;
}
export async function loadCrcRegistrations(
  db: Reader,
  network: string,
): Promise<Record<string, Config>> {
  const rows = await db
    .select()
    .from(schema.crcRegistrations)
    .where(eq(schema.crcRegistrations.network, core.protocolNetwork(network)));
  return Object.fromEntries(
    rows.map((row) => [row.deployTxid, core.decodeProtocolDto<Config>(row.configJson)]),
  );
}
async function authorizations(db: Reader, network: string): Promise<core.Offer[]> {
  const rows = await db
    .select()
    .from(schema.crcAuthorizations)
    .where(eq(schema.crcAuthorizations.network, network));
  return rows.map((row) => ({
    ...core.decodeProtocolDto<core.Offer>(row.offerJson),
    status: row.cancelRequested ? "cancelPending" : "open",
  }));
}
export async function saveCrcOfferAuthorization(db: Database, offer: core.Offer): Promise<string> {
  const network = core.protocolNetwork(offer.network),
    id = core.offerId(offer);
  await db.transaction(async (tx) => {
    await lock(tx, network);
    const before = await readLedger(tx, network);
    if (!before) throw new Error("CRC network not initialized");
    const [existing] = await tx
      .select()
      .from(schema.crcAuthorizations)
      .where(
        and(
          eq(schema.crcAuthorizations.network, network),
          eq(schema.crcAuthorizations.offerId, id),
        ),
      );
    if (existing) {
      core.verifyOffer(offer);
      if (
        core.offerMessage(core.decodeProtocolDto<core.Offer>(existing.offerJson)) !==
        core.offerMessage(offer)
      )
        throw new Error("conflicting authorization for listed outpoint");
      return;
    }
    const next = await core.registerOffer(before, offer);
    await tx.insert(schema.crcAuthorizations).values({
      network,
      offerId: id,
      listedOutpoint: core.outpoint(offer.listedInput),
      offerJson: core.encodeProtocolDto(offer),
    });
    await tx.insert(schema.crcRecords).values(record(next, network, "offers", id));
    await writeCursor(tx, network, next);
  });
  return id;
}
export async function requestCrcOfferCancellation(
  db: Database,
  network: string,
  id: string,
): Promise<void> {
  const selected = core.protocolNetwork(network);
  await db.transaction(async (tx) => {
    await lock(tx, selected);
    const before = await readLedger(tx, selected);
    if (!before) throw new Error("CRC network not initialized");
    const next = core.markOfferUnavailable(before, id);
    const changed = await tx
      .update(schema.crcAuthorizations)
      .set({ cancelRequested: true })
      .where(
        and(
          eq(schema.crcAuthorizations.network, selected),
          eq(schema.crcAuthorizations.offerId, id),
        ),
      )
      .returning();
    if (!changed.length) throw new Error("durable offer authorization missing");
    await tx
      .update(schema.crcRecords)
      .set(record(next, selected, "offers", id))
      .where(
        and(
          eq(schema.crcRecords.network, selected),
          eq(schema.crcRecords.kind, "offers"),
          eq(schema.crcRecords.key, id),
        ),
      );
    await writeCursor(tx, selected, next);
  });
}
export async function listCrcCheckpoints(db: Database, network: string) {
  return db
    .select({
      height: schema.crcCheckpoints.height,
      blockHash: schema.crcCheckpoints.blockHash,
      baseline: schema.crcCheckpoints.baseline,
    })
    .from(schema.crcCheckpoints)
    .where(eq(schema.crcCheckpoints.network, core.protocolNetwork(network)))
    .orderBy(desc(schema.crcCheckpoints.height));
}

export async function loadCrcActivationHeight(
  db: Database,
  network: string,
): Promise<number | null> {
  const [row] = await db
    .select({ height: schema.crcNetworks.activationHeight })
    .from(schema.crcNetworks)
    .where(eq(schema.crcNetworks.network, core.protocolNetwork(network)));
  return row ? Number(row.height) : null;
}
export interface CrcSigningContext {
  network: string;
  deployTxid: string;
  unsignedDigest: string;
  stateRoot: string;
}
async function signingState(tx: DbTransaction, context: CrcSigningContext) {
  const state = await readLedger(tx, core.protocolNetwork(context.network));
  const asset = state?.assets[context.deployTxid];
  if (
    !state?.tip ||
    !asset ||
    asset.vaultAvailable === false ||
    crcCoreStateRoot(state) !== context.stateRoot
  )
    throw new Error("CRC canonical signing state changed or unavailable");
  if (!/^[0-9a-f]{64}$/.test(context.unsignedDigest))
    throw new Error("invalid unsigned transaction digest");
  return { state, asset };
}
export async function claimCrcSignature(
  db: Database,
  context: CrcSigningContext,
): Promise<{ claimId: string; signedPsbtBase64?: string }> {
  const network = core.protocolNetwork(context.network);
  return db.transaction(async (tx) => {
    await lock(tx, network);
    const { asset } = await signingState(tx, context);
    const backingOutpoint = core.outpoint(asset.vault);
    const where = and(
      eq(schema.crcSignatures.network, network),
      eq(schema.crcSignatures.backingOutpoint, backingOutpoint),
      eq(schema.crcSignatures.unsignedDigest, context.unsignedDigest),
    );
    const [existing] = await tx.select().from(schema.crcSignatures).where(where);
    if (existing?.status === "signed") {
      if (!existing.signedPsbtBase64) throw new Error("CRC signed journal result missing");
      return { claimId: existing.claimId, signedPsbtBase64: existing.signedPsbtBase64 };
    }
    if (existing?.status === "pending") {
      const result = await tx.execute(
        sql`select ${existing.claimedAt}::timestamptz <= clock_timestamp() - interval '60 seconds' as expired`,
      );
      if (!result.rows[0]?.expired) throw new Error("CRC signature already in progress");
    }
    const claimId = randomUUID();
    const values = {
      network,
      backingOutpoint,
      unsignedDigest: context.unsignedDigest,
      deployTxid: context.deployTxid,
      stateRoot: context.stateRoot,
      claimId,
      status: "pending",
      claimedAt: sql`clock_timestamp()`,
      signedPsbtBase64: null,
    };
    if (existing) await tx.update(schema.crcSignatures).set(values).where(where);
    else await tx.insert(schema.crcSignatures).values(values);
    return { claimId };
  });
}
export async function releaseCrcSignature(db: Database, claimId: string): Promise<void> {
  await db
    .update(schema.crcSignatures)
    .set({ status: "failed" })
    .where(
      and(eq(schema.crcSignatures.claimId, claimId), eq(schema.crcSignatures.status, "pending")),
    );
}
export async function completeCrcSignature(
  db: Database,
  claimId: string,
  context: CrcSigningContext,
  signedPsbtBase64: string,
): Promise<void> {
  const network = core.protocolNetwork(context.network);
  await db.transaction(async (tx) => {
    await lock(tx, network);
    const { asset } = await signingState(tx, context);
    const result = await tx
      .update(schema.crcSignatures)
      .set({ status: "signed", signedPsbtBase64 })
      .where(
        and(
          eq(schema.crcSignatures.network, network),
          eq(schema.crcSignatures.claimId, claimId),
          eq(schema.crcSignatures.backingOutpoint, core.outpoint(asset.vault)),
          eq(schema.crcSignatures.unsignedDigest, context.unsignedDigest),
          eq(schema.crcSignatures.stateRoot, context.stateRoot),
          eq(schema.crcSignatures.status, "pending"),
        ),
      )
      .returning();
    if (result.length !== 1) throw new Error("CRC signature journal claim changed");
  });
}
export async function loadCrcRegistration(
  db: Database,
  network: string,
  deployTxid: string,
): Promise<{ config: Config; signedRawHex: string } | null> {
  const [row] = await db
    .select()
    .from(schema.crcRegistrations)
    .where(
      and(
        eq(schema.crcRegistrations.network, core.protocolNetwork(network)),
        eq(schema.crcRegistrations.deployTxid, deployTxid),
      ),
    );
  return row
    ? { config: core.decodeProtocolDto<Config>(row.configJson), signedRawHex: row.signedRawHex }
    : null;
}
