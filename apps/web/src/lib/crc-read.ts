import { and, asc, desc, eq, ilike, like, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";

export type CrcNetwork = "regtest" | "signet" | "testnet" | "mainnet";
const networks = new Set<string>(["regtest", "signet", "testnet", "mainnet"]);
const txidPattern = /^[0-9a-f]{64}$/;

export function formatCrcAssetId(network: string, deployTxid: string): string {
  if (!networks.has(network) || !txidPattern.test(deployTxid)) throw new Error("invalid Cove CRC asset identity");
  return `${network}:${deployTxid}`;
}

export function parseCrcAssetId(value: string, expectedNetwork: CrcNetwork): { network: CrcNetwork; deployTxid: string } | null {
  const [network, deployTxid, extra] = value.split(":");
  if (extra !== undefined || network !== expectedNetwork || !deployTxid || !txidPattern.test(deployTxid)) return null;
  return { network: expectedNetwork, deployTxid };
}

export function parseCrcPageCursor(value: string): { height: bigint; deployTxid: string } | null {
  const match = /^(0|[1-9]\d{0,18}):([0-9a-f]{64})$/.exec(value);
  if (!match) return null;
  const height = BigInt(match[1]!);
  return height <= 9_223_372_036_854_775_807n ? { height, deployTxid: match[2]! } : null;
}

export function parseCrcWalletCursor(value: string): { atoms: bigint; deployTxid: string } | null {
  const cursor = parseCrcPageCursor(value);
  return cursor ? { atoms: cursor.height, deployTxid: cursor.deployTxid } : null;
}

type AssetRow = {
  network: string;
  deployTxid: string;
  ticker: string;
  deployHeight: bigint;
  deployBlockHash: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  protocolVersion: number;
  burnedAtoms: bigint | null;
  txid: string;
  vout: number;
  scriptHex: string;
  btcSats: bigint;
  mintedAtoms: bigint;
  inventoryAtoms: bigint;
  availability: string;
  displayName?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  imageUrl?: string | null;
};

export function projectCrcAsset(row: AssetRow) {
  if (
    row.mintedAtoms < 0n || row.inventoryAtoms < 0n || row.inventoryAtoms > row.mintedAtoms ||
    row.btcSats < 0n || row.deployHeight < 0n || row.vout < 0 ||
    row.protocolVersion !== 3 ||
    row.burnedAtoms === null || row.burnedAtoms < 0n || row.burnedAtoms > row.mintedAtoms ||
    !["active", "unavailable"].includes(row.availability)
  ) throw new Error("inconsistent Cove CRC projection");
  return {
    assetId: formatCrcAssetId(row.network, row.deployTxid),
    network: row.network,
    deployTxid: row.deployTxid,
    ticker: row.ticker,
    metadata: {
      displayName: row.displayName ?? row.ticker,
      description: row.description ?? "",
      websiteUrl: row.websiteUrl ?? null,
      xUrl: row.xUrl ?? null,
      imageUrl: row.imageUrl ?? null,
    },
    deployHeight: row.deployHeight.toString(),
    deployBlockHash: row.deployBlockHash,
    creatorScriptHex: row.creatorScriptHex,
    protocolScriptHex: row.protocolScriptHex,
    protocolVersion: 3 as const,
    burnedAtoms: row.burnedAtoms?.toString() ?? null,
    mintedAtoms: row.mintedAtoms.toString(),
    inventoryAtoms: row.inventoryAtoms.toString(),
    circulatingAtoms: (row.mintedAtoms - row.inventoryAtoms).toString(),
    availability: row.availability as "active" | "unavailable",
    vault: {
      txid: row.txid,
      vout: row.vout,
      scriptHex: row.scriptHex,
      btcSats: row.btcSats.toString(),
    },
  };
}

const assetColumns = {
  network: schema.coveCrcAssets.network,
  deployTxid: schema.coveCrcAssets.deployTxid,
  ticker: schema.coveCrcAssets.ticker,
  deployHeight: schema.coveCrcAssets.deployHeight,
  deployBlockHash: schema.coveCrcAssets.deployBlockHash,
  creatorScriptHex: schema.coveCrcAssets.creatorScriptHex,
  protocolScriptHex: schema.coveCrcAssets.protocolScriptHex,
  protocolVersion: schema.coveCrcAssets.protocolVersion,
  burnedAtoms: schema.coveCrcAssets.burnedAtoms,
  txid: schema.coveCrcVaults.txid,
  vout: schema.coveCrcVaults.vout,
  scriptHex: schema.coveCrcVaults.scriptHex,
  btcSats: schema.coveCrcVaults.btcSats,
  mintedAtoms: schema.coveCrcVaults.mintedAtoms,
  inventoryAtoms: schema.coveCrcVaults.inventoryAtoms,
  availability: schema.coveCrcVaults.availability,
};

const metadataColumns = {
  displayName: schema.coveCrcTokenMetadata.displayName,
  description: schema.coveCrcTokenMetadata.description,
  websiteUrl: schema.coveCrcTokenMetadata.websiteUrl,
  xUrl: schema.coveCrcTokenMetadata.xUrl,
  imageUrl: schema.coveCrcTokenMetadata.imageUrl,
};

export async function readCrcCursor(db: Database, network: CrcNetwork) {
  const [cursor] = await db.select({ height: schema.coveCrcCursor.height, blockHash: schema.coveCrcCursor.blockHash })
    .from(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network)).limit(1);
  return cursor ? { height: cursor.height.toString(), blockHash: cursor.blockHash } : null;
}

export async function hasCrcLaunchIntent(db: Database, network: CrcNetwork): Promise<boolean> {
  const rows = await db.select({ txid: schema.coveCrcLaunchIntents.txid })
    .from(schema.coveCrcLaunchIntents)
    .where(eq(schema.coveCrcLaunchIntents.network, network)).limit(1);
  return rows.length > 0;
}

export async function listCrcAssets(
  db: Database, network: CrcNetwork, limit: number,
  before?: { height: bigint; deployTxid: string },
  search?: string,
) {
  const rows = await db.select({ ...assetColumns, ...metadataColumns }).from(schema.coveCrcAssets)
    .innerJoin(schema.coveCrcVaults, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcVaults.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcVaults.deployTxid),
    ))
    .leftJoin(schema.coveCrcTokenMetadata, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcTokenMetadata.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcTokenMetadata.deployTxid),
    ))
    .where(and(
      eq(schema.coveCrcAssets.network, network),
      search ? or(
        like(schema.coveCrcAssets.ticker, `${search.toUpperCase()}%`),
        like(schema.coveCrcAssets.deployTxid, `${search.toLowerCase()}%`),
        ilike(schema.coveCrcTokenMetadata.displayName, `${search}%`),
      ) : undefined,
      before ? or(
        lt(schema.coveCrcAssets.deployHeight, before.height),
        and(eq(schema.coveCrcAssets.deployHeight, before.height), lt(schema.coveCrcAssets.deployTxid, before.deployTxid)),
      ) : undefined,
    ))
    .orderBy(desc(schema.coveCrcAssets.deployHeight), desc(schema.coveCrcAssets.deployTxid))
    .limit(limit);
  return rows.map(projectCrcAsset);
}

export async function readCrcAsset(db: Database, network: CrcNetwork, deployTxid: string) {
  const [row] = await db.select({ ...assetColumns, ...metadataColumns }).from(schema.coveCrcAssets)
    .innerJoin(schema.coveCrcVaults, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcVaults.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcVaults.deployTxid),
    ))
    .leftJoin(schema.coveCrcTokenMetadata, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcTokenMetadata.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcTokenMetadata.deployTxid),
    ))
    .where(and(eq(schema.coveCrcAssets.network, network), eq(schema.coveCrcAssets.deployTxid, deployTxid)))
    .limit(1);
  return row ? projectCrcAsset(row) : null;
}

export async function readCrcActivity(db: Database, network: CrcNetwork, deployTxid: string, limit = 50) {
  const rows = await db.select({
    txid: schema.coveCrcEvents.txid,
    blockHeight: schema.coveCrcEvents.blockHeight,
    txIndex: schema.coveCrcEvents.txIndex,
    operation: schema.coveCrcEvents.operation,
    tradeSide: schema.coveCrcEvents.tradeSide,
    valid: schema.coveCrcEvents.valid,
    reason: schema.coveCrcEvents.reason,
    amountAtoms: schema.coveCrcEvents.amountAtoms,
  }).from(schema.coveCrcEvents)
    .where(and(eq(schema.coveCrcEvents.network, network), eq(schema.coveCrcEvents.deployTxid, deployTxid)))
    .orderBy(desc(schema.coveCrcEvents.blockHeight), desc(schema.coveCrcEvents.txIndex))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    blockHeight: row.blockHeight.toString(),
    amountAtoms: row.amountAtoms?.toString() ?? null,
  }));
}

export async function readCrcTrades(db: Database, network: CrcNetwork, deployTxid: string, limit = 500) {
  const result = await db.execute(sql`SELECT e.txid, e.block_height, e.tx_index, e.confirmed_time,
      COALESCE(e.trade_side, CASE WHEN l.id IS NOT NULL THEN 'market' END) AS side,
      COALESCE(e.trade_atoms, l.amount_atoms) AS atoms,
      COALESCE(e.trade_gross_sats, l.price_sats + l.protocol_fee_sats) AS gross_sats
    FROM cove_crc_events e
    LEFT JOIN cove_crc_market_fills f ON f.network = e.network AND f.txid = e.txid
    LEFT JOIN cove_crc_market_listings l ON l.id = f.listing_id AND l.network = e.network
      AND l.deploy_txid = e.deploy_txid AND l.amount_atoms = e.amount_atoms
    WHERE e.network = ${network} AND e.deploy_txid = ${deployTxid} AND e.status = 'applied'
      AND e.valid = true AND e.confirmed_time IS NOT NULL
      AND (e.trade_gross_sats IS NOT NULL OR l.id IS NOT NULL)
    ORDER BY e.block_height DESC, e.tx_index DESC LIMIT ${limit}`);
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const side = String(row.side);
    const atoms = BigInt(String(row.atoms));
    const gross = BigInt(String(row.gross_sats));
    const time = Number(row.confirmed_time);
    if (!["buy", "sell", "market"].includes(side) || atoms <= 0n || gross <= 0n || !Number.isSafeInteger(time) || time <= 0) {
      throw new Error("inconsistent confirmed CRC trade projection");
    }
    return { txid: String(row.txid), blockHeight: String(row.block_height), side: side as "buy" | "sell" | "market",
      amountAtoms: atoms.toString(), totalPriceSats: gross.toString(), timestamp: time * 1000 };
  }).reverse();
}

export async function readCrcRecentActivity(db: Database, network: CrcNetwork, limit = 100) {
  const rows = await db.select({
    txid: schema.coveCrcEvents.txid,
    blockHeight: schema.coveCrcEvents.blockHeight,
    txIndex: schema.coveCrcEvents.txIndex,
    operation: schema.coveCrcEvents.operation,
    tradeSide: schema.coveCrcEvents.tradeSide,
    valid: schema.coveCrcEvents.valid,
    deployTxid: schema.coveCrcEvents.deployTxid,
    amountAtoms: schema.coveCrcEvents.amountAtoms,
  }).from(schema.coveCrcEvents)
    .where(eq(schema.coveCrcEvents.network, network))
    .orderBy(desc(schema.coveCrcEvents.blockHeight), desc(schema.coveCrcEvents.txIndex))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    blockHeight: row.blockHeight.toString(),
    amountAtoms: row.amountAtoms?.toString() ?? null,
  }));
}

export async function readCrcQuoteAsset(db: Database, network: CrcNetwork, deployTxid: string) {
  const [row] = await db.select({
    ...assetColumns,
    vaultAnchorSats: schema.coveCrcLaunchIntents.vaultAnchorSats,
    registeredVaultScriptHex: schema.coveCrcLaunchIntents.vaultScriptHex,
    registeredCreatorScriptHex: schema.coveCrcLaunchIntents.creatorScriptHex,
    registeredProtocolScriptHex: schema.coveCrcLaunchIntents.protocolScriptHex,
    registeredTicker: schema.coveCrcLaunchIntents.ticker,
    registeredLaunchSaltHex: schema.coveCrcLaunchIntents.launchSaltHex,
    assetLaunchSaltHex: schema.coveCrcAssets.launchSaltHex,
  }).from(schema.coveCrcAssets)
    .innerJoin(schema.coveCrcVaults, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcVaults.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcVaults.deployTxid),
    ))
    .innerJoin(schema.coveCrcLaunchIntents, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcLaunchIntents.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcLaunchIntents.txid),
    ))
    .where(and(eq(schema.coveCrcAssets.network, network), eq(schema.coveCrcAssets.deployTxid, deployTxid)))
    .limit(1);
  if (!row || row.scriptHex !== row.registeredVaultScriptHex ||
    row.creatorScriptHex !== row.registeredCreatorScriptHex ||
    row.protocolScriptHex !== row.registeredProtocolScriptHex ||
    row.ticker !== row.registeredTicker || row.assetLaunchSaltHex !== row.registeredLaunchSaltHex) return null;
  return { ...projectCrcAsset(row), vaultAnchorSats: row.vaultAnchorSats.toString(), registeredVaultScriptHex: row.registeredVaultScriptHex };
}

export async function readCrcBalance(db: Database, network: CrcNetwork, deployTxid: string, scriptHex: string): Promise<bigint> {
  const result = await db.execute(sql`
    select coalesce(sum(u.atoms), 0) as atoms from cove_crc_token_utxos u
      join cove_crc_assets a on a.network = u.network and a.deploy_txid = u.deploy_txid
      where u.network = ${network} and u.deploy_txid = ${deployTxid}
        and u.script_hex = ${scriptHex} and a.protocol_version = 3`);
  return BigInt((result.rows[0] as { atoms?: string | number | bigint } | undefined)?.atoms ?? 0);
}

export async function readCrcTokenUtxos(db: Database, network: CrcNetwork, deployTxid: string, scriptHex: string, limit = 101) {
  const rows = await db.select({
    txid: schema.coveCrcTokenUtxos.txid,
    vout: schema.coveCrcTokenUtxos.vout,
    scriptHex: schema.coveCrcTokenUtxos.scriptHex,
    atoms: schema.coveCrcTokenUtxos.atoms,
    createdHeight: schema.coveCrcTokenUtxos.createdHeight,
    createdBlockHash: schema.coveCrcTokenUtxos.createdBlockHash,
  }).from(schema.coveCrcTokenUtxos)
    .innerJoin(schema.coveCrcAssets, and(
      eq(schema.coveCrcTokenUtxos.network, schema.coveCrcAssets.network),
      eq(schema.coveCrcTokenUtxos.deployTxid, schema.coveCrcAssets.deployTxid),
    ))
    .where(and(eq(schema.coveCrcTokenUtxos.network, network),
      eq(schema.coveCrcTokenUtxos.deployTxid, deployTxid),
      eq(schema.coveCrcTokenUtxos.scriptHex, scriptHex),
      eq(schema.coveCrcAssets.protocolVersion, 3)))
    .orderBy(desc(schema.coveCrcTokenUtxos.atoms), asc(schema.coveCrcTokenUtxos.txid), asc(schema.coveCrcTokenUtxos.vout))
    .limit(limit);
  return rows.map((row) => ({ ...row, atoms: row.atoms.toString(), createdHeight: row.createdHeight.toString() }));
}

export async function readCrcTokenUtxo(db: Database, network: CrcNetwork, deployTxid: string, txid: string, vout: number) {
  const [row] = await db.select({ scriptHex: schema.coveCrcTokenUtxos.scriptHex,
    atoms: schema.coveCrcTokenUtxos.atoms }).from(schema.coveCrcTokenUtxos)
    .innerJoin(schema.coveCrcAssets, and(
      eq(schema.coveCrcTokenUtxos.network, schema.coveCrcAssets.network),
      eq(schema.coveCrcTokenUtxos.deployTxid, schema.coveCrcAssets.deployTxid),
    ))
    .where(and(eq(schema.coveCrcTokenUtxos.network, network),
      eq(schema.coveCrcTokenUtxos.deployTxid, deployTxid),
      eq(schema.coveCrcTokenUtxos.txid, txid), eq(schema.coveCrcTokenUtxos.vout, vout),
      eq(schema.coveCrcAssets.protocolVersion, 3))).limit(1);
  return row ? { scriptHex: row.scriptHex, atoms: row.atoms } : null;
}

export async function readCrcWalletBalances(
  db: Database, network: CrcNetwork, scriptHex: string, limit: number,
  before?: { atoms: bigint; deployTxid: string },
) {
  const rows = await db.execute(sql`
    with owned as (
      select u.deploy_txid, sum(u.atoms) as atoms from cove_crc_token_utxos u
        join cove_crc_assets a on a.network = u.network and a.deploy_txid = u.deploy_txid
        where u.network = ${network} and u.script_hex = ${scriptHex} and a.protocol_version = 3
        group by u.deploy_txid
    )
    select o.deploy_txid as "deployTxid", a.ticker, o.atoms::text as atoms
    from owned o join cove_crc_assets a on a.network = ${network} and a.deploy_txid = o.deploy_txid
    where ${before ? sql`(o.atoms, o.deploy_txid) < (${before.atoms}, ${before.deployTxid})` : sql`true`}
    order by o.atoms desc, o.deploy_txid desc limit ${limit}`);
  return (rows.rows as { deployTxid: string; ticker: string; atoms: string }[]).map((row) => ({
    assetId: formatCrcAssetId(network, row.deployTxid), ticker: row.ticker, atoms: row.atoms,
  }));
}
