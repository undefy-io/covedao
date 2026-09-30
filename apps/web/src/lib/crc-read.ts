import { and, desc, eq, lt, or } from "drizzle-orm";
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
  txid: string;
  vout: number;
  scriptHex: string;
  btcSats: bigint;
  mintedAtoms: bigint;
  inventoryAtoms: bigint;
  availability: string;
};

export function projectCrcAsset(row: AssetRow) {
  if (
    row.mintedAtoms < 0n || row.inventoryAtoms < 0n || row.inventoryAtoms > row.mintedAtoms ||
    row.btcSats < 0n || row.deployHeight < 0n || row.vout < 0 ||
    !["active", "unavailable"].includes(row.availability)
  ) throw new Error("inconsistent Cove CRC projection");
  return {
    assetId: formatCrcAssetId(row.network, row.deployTxid),
    network: row.network,
    deployTxid: row.deployTxid,
    ticker: row.ticker,
    deployHeight: row.deployHeight.toString(),
    deployBlockHash: row.deployBlockHash,
    creatorScriptHex: row.creatorScriptHex,
    protocolScriptHex: row.protocolScriptHex,
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
  txid: schema.coveCrcVaults.txid,
  vout: schema.coveCrcVaults.vout,
  scriptHex: schema.coveCrcVaults.scriptHex,
  btcSats: schema.coveCrcVaults.btcSats,
  mintedAtoms: schema.coveCrcVaults.mintedAtoms,
  inventoryAtoms: schema.coveCrcVaults.inventoryAtoms,
  availability: schema.coveCrcVaults.availability,
};

export async function readCrcCursor(db: Database, network: CrcNetwork) {
  const [cursor] = await db.select({ height: schema.coveCrcCursor.height, blockHash: schema.coveCrcCursor.blockHash })
    .from(schema.coveCrcCursor).where(eq(schema.coveCrcCursor.network, network)).limit(1);
  return cursor ? { height: cursor.height.toString(), blockHash: cursor.blockHash } : null;
}

export async function listCrcAssets(
  db: Database, network: CrcNetwork, limit: number,
  before?: { height: bigint; deployTxid: string },
) {
  const rows = await db.select(assetColumns).from(schema.coveCrcAssets)
    .innerJoin(schema.coveCrcVaults, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcVaults.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcVaults.deployTxid),
    ))
    .where(and(
      eq(schema.coveCrcAssets.network, network),
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
  const [row] = await db.select(assetColumns).from(schema.coveCrcAssets)
    .innerJoin(schema.coveCrcVaults, and(
      eq(schema.coveCrcAssets.network, schema.coveCrcVaults.network),
      eq(schema.coveCrcAssets.deployTxid, schema.coveCrcVaults.deployTxid),
    ))
    .where(and(eq(schema.coveCrcAssets.network, network), eq(schema.coveCrcAssets.deployTxid, deployTxid)))
    .limit(1);
  return row ? projectCrcAsset(row) : null;
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
  const [row] = await db.select({ atoms: schema.coveCrcBalances.atoms })
    .from(schema.coveCrcBalances)
    .where(and(
      eq(schema.coveCrcBalances.network, network),
      eq(schema.coveCrcBalances.deployTxid, deployTxid),
      eq(schema.coveCrcBalances.scriptHex, scriptHex),
    )).limit(1);
  return row?.atoms ?? 0n;
}

export async function readCrcWalletBalances(
  db: Database, network: CrcNetwork, scriptHex: string, limit: number,
  before?: { atoms: bigint; deployTxid: string },
) {
  const rows = await db.select({
    deployTxid: schema.coveCrcBalances.deployTxid,
    ticker: schema.coveCrcAssets.ticker,
    atoms: schema.coveCrcBalances.atoms,
  }).from(schema.coveCrcBalances)
    .innerJoin(schema.coveCrcAssets, and(
      eq(schema.coveCrcBalances.network, schema.coveCrcAssets.network),
      eq(schema.coveCrcBalances.deployTxid, schema.coveCrcAssets.deployTxid),
    ))
    .where(and(
      eq(schema.coveCrcBalances.network, network),
      eq(schema.coveCrcBalances.scriptHex, scriptHex),
      before ? or(
        lt(schema.coveCrcBalances.atoms, before.atoms),
        and(eq(schema.coveCrcBalances.atoms, before.atoms), lt(schema.coveCrcBalances.deployTxid, before.deployTxid)),
      ) : undefined,
    ))
    .orderBy(desc(schema.coveCrcBalances.atoms), desc(schema.coveCrcBalances.deployTxid))
    .limit(limit);
  return rows.map((row) => ({
    assetId: formatCrcAssetId(network, row.deployTxid),
    ticker: row.ticker,
    atoms: row.atoms.toString(),
  }));
}
