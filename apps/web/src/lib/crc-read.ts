import { sql } from "drizzle-orm";
import * as core from "@crclaunch/crc20-protocol";
import { type Database } from "@crclaunch/db";

export type CrcNetwork = "regtest" | "signet" | "testnet" | "mainnet";
const networks = new Set<string>(["regtest", "signet", "testnet", "mainnet"]);
const txidPattern = /^[0-9a-f]{64}$/;

export function formatCrcAssetId(network: string, deployTxid: string): string {
  if (!networks.has(network) || !txidPattern.test(deployTxid))
    throw new Error("invalid Cove CRC asset identity");
  return `${network}:${deployTxid}`;
}

export function parseCrcAssetId(
  value: string,
  expectedNetwork: CrcNetwork,
): { network: CrcNetwork; deployTxid: string } | null {
  const [network, deployTxid, extra] = value.split(":");
  if (
    extra !== undefined ||
    network !== expectedNetwork ||
    !deployTxid ||
    !txidPattern.test(deployTxid)
  )
    return null;
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
  valueJson: unknown;
  deployHeight: string;
  deployBlockHash: string;
  displayName: string | null;
  description: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  imageUrl: string | null;
};

export function projectCrcAsset(row: AssetRow, network: CrcNetwork) {
  const asset = core.decodeProtocolDto<core.Asset>(row.valueJson);
  core.validateConfig(asset.config);
  if (asset.config.network !== core.protocolNetwork(network))
    throw new Error("CRC projection network mismatch");
  return {
    assetId: formatCrcAssetId(network, asset.deployTxid),
    network,
    deployTxid: asset.deployTxid,
    ticker: asset.config.ticker,
    metadata: {
      displayName: row.displayName ?? asset.config.ticker,
      description: row.description ?? "",
      websiteUrl: row.websiteUrl,
      xUrl: row.xUrl,
      imageUrl: row.imageUrl,
    },
    deployHeight: row.deployHeight,
    deployBlockHash: row.deployBlockHash,
    creatorScriptHex: asset.config.creatorScriptHex,
    protocolScriptHex: asset.config.protocolScriptHex,
    protocolVersion: 3 as const,
    burnedAtoms: asset.burnedAtoms.toString(),
    mintedAtoms: asset.issuedAtoms.toString(),
    inventoryAtoms: asset.inventoryAtoms.toString(),
    circulatingAtoms: (asset.issuedAtoms - asset.inventoryAtoms).toString(),
    availability: asset.vaultAvailable === false ? ("unavailable" as const) : ("active" as const),
    vault: {
      txid: asset.vault.txid,
      vout: asset.vault.vout,
      scriptHex: asset.vault.scriptHex,
      btcSats: core.sats(asset.vault.sats).toString(),
    },
    coreState: core.encodeProtocolDto(asset),
  };
}
const assetSelect = sql`select a.value_json as "valueJson", e.block_height::text as "deployHeight",
  e.block_hash as "deployBlockHash", m.display_name as "displayName", m.description,
  m.website_url as "websiteUrl", m.x_url as "xUrl", m.image_url as "imageUrl"
  from crc_records a join crc_events e on e.network=a.network and e.deploy_txid=a.key
    and e.txid=a.key and e.event_json->>'kind'='deploy'
  left join crc_metadata m on m.network=a.network and m.deploy_txid=a.key`;
export async function readCrcCursor(db: Database, network: CrcNetwork) {
  const result = await db.execute(
    sql`select height::text, block_hash as "blockHash" from crc_cursors where network=${core.protocolNetwork(network)} limit 1`,
  );
  const row = result.rows[0] as { height: string | null; blockHash: string | null } | undefined;
  return row?.height && row.blockHash ? { height: row.height, blockHash: row.blockHash } : null;
}
export async function hasCrcLaunchIntent(db: Database, network: CrcNetwork) {
  const rows = await db.execute(
    sql`select deploy_txid from crc_registrations where network=${core.protocolNetwork(network)} limit 1`,
  );
  return rows.rows.length > 0;
}
export async function listCrcAssets(
  db: Database,
  network: CrcNetwork,
  limit: number,
  before?: { height: bigint; deployTxid: string },
  search?: string,
) {
  const result =
    await db.execute(sql`${assetSelect} where a.network=${core.protocolNetwork(network)} and a.kind='assets'
    and ${before ? sql`(e.block_height, a.key) < (${before.height}, ${before.deployTxid})` : sql`true`}
    and ${search ? sql`(a.value_json->'config'->>'ticker' ilike ${search + "%"} or a.key like ${search.toLowerCase() + "%"} or m.display_name ilike ${search + "%"})` : sql`true`}
    order by e.block_height desc, a.key desc limit ${limit}`);
  return result.rows.map((row) => projectCrcAsset(row as AssetRow, network));
}
export async function readCrcAsset(db: Database, network: CrcNetwork, deployTxid: string) {
  const result = await db.execute(
    sql`${assetSelect} where a.network=${core.protocolNetwork(network)} and a.kind='assets' and a.key=${deployTxid} limit 1`,
  );
  return result.rows[0] ? projectCrcAsset(result.rows[0] as AssetRow, network) : null;
}
export async function readCrcQuoteAsset(db: Database, network: CrcNetwork, deployTxid: string) {
  const asset = await readCrcAsset(db, network, deployTxid);
  return asset
    ? {
        ...asset,
        registeredVaultScriptHex: asset.vault.scriptHex,
        vaultAnchorSats: core.carrierSats.toString(),
      }
    : null;
}
function activity(row: Record<string, unknown>) {
  const event = core.decodeProtocolDto<core.ConfirmedEvent>(row.event_json);
  const tradeSide =
    event.kind === "mint" || event.kind === "inventoryBuy"
      ? "buy"
      : event.kind === "sell"
        ? "sell"
        : event.kind === "fill"
          ? "market"
          : null;
  return {
    txid: event.txid,
    deployTxid: event.deployTxid,
    blockHeight: String(row.block_height),
    txIndex: event.txIndex,
    operation:
      event.kind === "inventoryBuy" || event.kind === "sell" || event.kind === "fill"
        ? "transfer"
        : event.kind,
    kind: event.kind,
    tradeSide,
    valid: event.valid,
    reason: event.valid ? null : "Tracked non-protocol spend destroyed its allocations",
    amountAtoms: event.amountAtoms?.toString() ?? null,
  };
}
export async function readCrcActivity(
  db: Database,
  network: CrcNetwork,
  deployTxid: string,
  limit = 50,
) {
  const result = await db.execute(
    sql`select * from crc_events where network=${core.protocolNetwork(network)} and deploy_txid=${deployTxid} order by block_height desc, tx_index desc limit ${limit}`,
  );
  return result.rows.map(activity);
}
export async function readCrcRecentActivity(db: Database, network: CrcNetwork, limit = 100) {
  const result = await db.execute(
    sql`select * from crc_events where network=${core.protocolNetwork(network)} order by block_height desc, tx_index desc limit ${limit}`,
  );
  return result.rows.map(activity);
}
export async function readCrcTrades(
  db: Database,
  network: CrcNetwork,
  deployTxid: string,
  limit = 500,
) {
  const result =
    await db.execute(sql`select * from crc_events where network=${core.protocolNetwork(network)} and deploy_txid=${deployTxid}
    and confirmed_time is not null and event_json->>'grossSats' is not null
    order by block_height desc, tx_index desc limit ${limit}`);
  return result.rows
    .map((row) => {
      const event = core.decodeProtocolDto<core.ConfirmedEvent>(row.event_json);
      return {
        txid: event.txid,
        blockHeight: String(row.block_height),
        side:
          event.kind === "sell"
            ? ("sell" as const)
            : event.kind === "fill"
              ? ("market" as const)
              : ("buy" as const),
        amountAtoms: event.amountAtoms!.toString(),
        totalPriceSats: event.grossSats!.toString(),
        timestamp: Number(row.confirmed_time) * 1000,
      };
    })
    .reverse();
}
export async function readCrcBalance(
  db: Database,
  network: CrcNetwork,
  deployTxid: string,
  scriptHex: string,
): Promise<bigint> {
  const result = await db.execute(sql`select coalesce(sum(atoms),0)::text as atoms from crc_records
    where network=${core.protocolNetwork(network)} and kind='allocations' and deploy_txid=${deployTxid} and script_hex=${scriptHex}`);
  return BigInt(String(result.rows[0]!.atoms));
}
export async function readCrcTokenUtxos(
  db: Database,
  network: CrcNetwork,
  deployTxid: string,
  scriptHex: string,
  limit = 101,
) {
  const result = await db.execute(sql`select a.key, a.value_json, e.block_height::text, e.block_hash
    from crc_records a join crc_events e on e.network=a.network and e.txid=split_part(a.key, ':', 1) and e.deploy_txid=a.deploy_txid
    where a.network=${core.protocolNetwork(network)} and a.kind='allocations' and a.deploy_txid=${deployTxid} and a.script_hex=${scriptHex}
    order by a.atoms desc, a.key asc limit ${limit}`);
  return result.rows.map((row) => {
    const allocation = core.decodeProtocolDto<core.Allocation>(row.value_json);
    const [txid, vout] = String(row.key).split(":");
    return {
      txid: txid!,
      vout: Number(vout),
      scriptHex: allocation.scriptHex,
      atoms: allocation.atoms.toString(),
      btcSats: allocation.sats.toString(),
      createdHeight: String(row.block_height),
      createdBlockHash: String(row.block_hash),
    };
  });
}
export async function readCrcTokenUtxo(
  db: Database,
  network: CrcNetwork,
  deployTxid: string,
  txid: string,
  vout: number,
) {
  const rows =
    await db.execute(sql`select value_json from crc_records where network=${core.protocolNetwork(network)}
    and kind='allocations' and key=${`${txid}:${vout}`} and deploy_txid=${deployTxid} limit 1`);
  if (!rows.rows[0]) return null;
  const allocation = core.decodeProtocolDto<core.Allocation>(rows.rows[0].value_json);
  return { scriptHex: allocation.scriptHex, atoms: allocation.atoms, sats: allocation.sats };
}
export async function readCrcWalletBalances(
  db: Database,
  network: CrcNetwork,
  scriptHex: string,
  limit: number,
  before?: { atoms: bigint; deployTxid: string },
) {
  const result =
    await db.execute(sql`with owned as (select deploy_txid, sum(atoms) as atoms from crc_records
    where network=${core.protocolNetwork(network)} and kind='allocations' and script_hex=${scriptHex} group by deploy_txid)
    select o.deploy_txid, o.atoms::text, a.value_json->'config'->>'ticker' as ticker from owned o
    join crc_records a on a.network=${core.protocolNetwork(network)} and a.kind='assets' and a.key=o.deploy_txid
    where ${before ? sql`(o.atoms, o.deploy_txid) < (${before.atoms}, ${before.deployTxid})` : sql`true`}
    order by o.atoms desc, o.deploy_txid desc limit ${limit}`);
  return result.rows.map((row) => ({
    assetId: formatCrcAssetId(network, String(row.deploy_txid)),
    ticker: String(row.ticker),
    atoms: String(row.atoms),
  }));
}
