import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@crclaunch/db";
import { listCrcAssets, readCrcActivity, readCrcAsset, readCrcBalance, readCrcQuoteAsset, readCrcRecentActivity, readCrcTokenUtxo, readCrcTokenUtxos, readCrcTrades, readCrcWalletBalances } from "./crc-read";
import { quoteCrcBuy, quoteCrcSell } from "./crc-quote";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = (() => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";
})();
const db = isolated ? createDb(url!) : undefined;
const first = "e".repeat(64);
const second = "f".repeat(64);
const owner = "0014" + "1".repeat(40);
const marketListingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const marketFillId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe.skipIf(!isolated)("Cove CRC database reads", () => {
  beforeAll(async () => {
    for (const network of ["signet", "regtest"]) {
      await db!.execute(sql`delete from cove_crc_token_metadata where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_market_fills where id = ${marketFillId}`);
      await db!.execute(sql`delete from cove_crc_market_listings where id = ${marketListingId}`);
      await db!.execute(sql`delete from cove_crc_events where network = ${network} and txid in (${"1".repeat(64)}, ${"2".repeat(64)}, ${"3".repeat(64)}, ${"4".repeat(64)})`);
      await db!.execute(sql`delete from cove_crc_token_utxos where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_balances where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_vaults where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_assets where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_launch_intents where network = ${network} and txid in (${first}, ${second})`);
    }
    for (const [network, deployTxid, height] of [
      ["signet", first, 11], ["signet", second, 12], ["regtest", first, 13],
    ] as const) {
      const vaultScript = `0014${deployTxid.slice(0, 40)}`;
      const burnedAtoms = network === "signet" && deployTxid === second ? 50000000000n : 0n;
      const inventoryAtoms = network === "regtest" ? 0n : 100000000000n;
      const backingSats = network === "regtest" ? 1027n : 1000n;
      await db!.execute(sql`insert into cove_crc_assets
        (network,deploy_txid,ticker,deploy_height,deploy_block_hash,launch_salt_hex,creator_script_hex,protocol_script_hex,protocol_version,burned_atoms)
        values (${network},${deployTxid},'SAME',${height},${deployTxid},${deployTxid},${owner},${owner},3,${burnedAtoms})`);
      await db!.execute(sql`insert into cove_crc_vaults
        (network,deploy_txid,txid,vout,script_hex,btc_sats,minted_atoms,inventory_atoms,availability)
        values (${network},${deployTxid},${deployTxid},1,${vaultScript},${backingSats},200000000000,${inventoryAtoms},'active')`);
      await db!.execute(sql`insert into cove_crc_launch_intents
        (network,txid,ticker,signed_raw_hex,raw_sha256,launch_salt_hex,vault_script_hex,creator_script_hex,protocol_script_hex,vault_anchor_sats)
        values (${network},${deployTxid},'SAME','00','hash',${deployTxid},${vaultScript},${owner},${owner},973)`);
    }
    await db!.execute(sql`insert into cove_crc_token_utxos
      (network,deploy_txid,txid,vout,script_hex,atoms,created_height,created_block_hash)
      values ('signet',${first},${"c".repeat(64)},1,${owner},100000000000,11,${"a".repeat(64)}),
        ('regtest',${first},${"d".repeat(64)},1,${owner},200000000000,13,${"a".repeat(64)}),
        ('signet',${second},${"a".repeat(64)},1,${owner},25000000000,12,${"b".repeat(64)}),
        ('signet',${second},${"b".repeat(64)},1,${owner},25000000000,13,${"c".repeat(64)}),
        ('signet',${second},${second},1,${`0014${second.slice(0, 40)}`},100000000000,12,${"b".repeat(64)})`);
    await db!.execute(sql`insert into cove_crc_token_metadata
      (network,deploy_txid,display_name,description,website_url,x_url,image_url,submitted_by_script)
      values ('signet',${first},'First Coin','First description','https://example.com',null,'https://example.com/image.png',${owner})`);
    await db!.execute(sql`insert into cove_crc_events
      (network,txid,block_height,block_hash,tx_index,operation,status,valid,deploy_txid,amount_atoms,trade_side,trade_atoms,trade_gross_sats,confirmed_time)
      values ('signet',${"1".repeat(64)},11,${first},0,'deploy','applied',true,${first},null,null,null,null,null),
        ('signet',${"2".repeat(64)},12,${second},1,'transfer','applied',true,${second},100000000000,null,null,null,null),
        ('regtest',${"3".repeat(64)},13,${first},0,'transfer','applied',true,${first},200000000000,'buy',200000000000,27,1700000000),
        ('regtest',${"4".repeat(64)},14,${first},0,'transfer','applied',true,${first},100000000000,null,null,null,1700000600)`);
    await db!.execute(sql`insert into cove_crc_market_listings
      (id,network,deploy_txid,ticker,seller_script_hex,seller_payout_script_hex,seller_anchor_txid,seller_anchor_vout,seller_anchor_sats,amount_atoms,price_sats,protocol_fee_sats,expires_at_height,status)
      values (${marketListingId},'regtest',${first},'SAME',${owner},${owner},${"d".repeat(64)},1,330,100000000000,1000,100,1000,'FILLED')`);
    await db!.execute(sql`insert into cove_crc_market_fills
      (id,network,listing_id,buyer_script_hex,unsigned_tx_digest,psbt_base64,txid,status)
      values (${marketFillId},'regtest',${marketListingId},${owner},'hash','psbt',${"4".repeat(64)},'CONFIRMED')`);
  });

  afterAll(async () => {
    for (const network of ["signet", "regtest"]) {
      await db!.execute(sql`delete from cove_crc_token_metadata where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_market_fills where id = ${marketFillId}`);
      await db!.execute(sql`delete from cove_crc_market_listings where id = ${marketListingId}`);
      await db!.execute(sql`delete from cove_crc_events where network = ${network} and txid in (${"1".repeat(64)}, ${"2".repeat(64)}, ${"3".repeat(64)}, ${"4".repeat(64)})`);
      await db!.execute(sql`delete from cove_crc_token_utxos where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_balances where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_vaults where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_assets where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_launch_intents where network = ${network} and txid in (${first}, ${second})`);
    }
  });

  it("keeps same-ticker deployments and networks separate", async () => {
    const signet = await listCrcAssets(db!, "signet", 100);
    const matches = signet.filter((asset) => asset.ticker === "SAME" && [first, second].includes(asset.deployTxid));
    expect(matches.map((asset) => asset.assetId).sort()).toEqual([`signet:${first}`, `signet:${second}`]);
    const older = await listCrcAssets(db!, "signet", 100, { height: 12n, deployTxid: second });
    expect(older.some((asset) => asset.deployTxid === first)).toBe(true);
    expect(older.some((asset) => asset.deployTxid === second)).toBe(false);
    expect((await readCrcAsset(db!, "regtest", first))?.assetId).toBe(`regtest:${first}`);
    expect((await readCrcAsset(db!, "regtest", first))?.metadata.displayName).toBe("SAME");
    expect((await readCrcAsset(db!, "signet", first))?.metadata).toMatchObject({ displayName: "First Coin", description: "First description" });
    expect((await listCrcAssets(db!, "signet", 100, undefined, "first"))[0]?.deployTxid).toBe(first);
    expect(await readCrcAsset(db!, "regtest", second)).toBeNull();
    expect((await listCrcAssets(db!, "signet", 100, undefined, "sam")).filter((asset) => [first, second].includes(asset.deployTxid))).toHaveLength(2);
    expect((await listCrcAssets(db!, "signet", 100, undefined, first.slice(0, 12))).some((asset) => asset.deployTxid === first)).toBe(true);
  });

  it("shows only confirmed events for the requested token and network in chain order", async () => {
    expect((await readCrcActivity(db!, "signet", first)).map((event) => event.txid)).toEqual(["1".repeat(64)]);
    expect((await readCrcActivity(db!, "regtest", first)).find((event) => event.txid === "3".repeat(64))?.tradeSide).toBe("buy");
    expect((await readCrcRecentActivity(db!, "signet")).filter((event) => ["1".repeat(64), "2".repeat(64)].includes(event.txid)).map((event) => event.txid)).toEqual(["2".repeat(64), "1".repeat(64)]);
    expect((await readCrcRecentActivity(db!, "regtest")).some((event) => event.txid === "3".repeat(64))).toBe(true);
  });

  it("reads only confirmed priced trades for the requested token and network", async () => {
    expect(await readCrcTrades(db!, "signet", first)).toEqual([]);
    expect(await readCrcTrades(db!, "regtest", second)).toEqual([]);
    expect(await readCrcTrades(db!, "regtest", first)).toEqual([
      { txid: "3".repeat(64), blockHeight: "13", side: "buy", amountAtoms: "200000000000", totalPriceSats: "27", timestamp: 1_700_000_000_000 },
      { txid: "4".repeat(64), blockHeight: "14", side: "market", amountAtoms: "100000000000", totalPriceSats: "1100", timestamp: 1_700_000_600_000 },
    ]);
  });

  it("reads only balances for the requested network and verified script", async () => {
    expect(await readCrcBalance(db!, "signet", first, owner)).toBe(100000000000n);
    expect(await readCrcBalance(db!, "signet", first, "0014" + "2".repeat(40))).toBe(0n);
    expect(await readCrcBalance(db!, "regtest", first, owner)).toBe(200000000000n);
    expect(await readCrcWalletBalances(db!, "signet", owner, 100)).toContainEqual({
      assetId: `signet:${first}`, ticker: "SAME", atoms: "100000000000",
    });
    expect(await readCrcWalletBalances(db!, "signet", "0014" + "2".repeat(40), 100)).toEqual([]);
    expect(await readCrcWalletBalances(db!, "regtest", owner, 100)).toContainEqual({
      assetId: `regtest:${first}`, ticker: "SAME", atoms: "200000000000",
    });
    const firstPage = await readCrcWalletBalances(db!, "signet", owner, 1);
    expect(firstPage[0]?.assetId).toBe(`signet:${first}`);
    const nextPage = await readCrcWalletBalances(db!, "signet", owner, 1, { atoms: 100000000000n, deployTxid: first });
    expect(nextPage[0]?.assetId).toBe(`signet:${second}`);
  });

  it("uses only indexed token outpoints for wallet balances and seller authority", async () => {
    await db!.execute(sql`insert into cove_crc_balances (network,deploy_txid,script_hex,atoms)
      values ('signet',${second},${owner},999000000000)`);
    try {
      expect(await readCrcBalance(db!, "signet", second, owner)).toBe(50000000000n);
      expect(await readCrcWalletBalances(db!, "signet", owner, 100)).toContainEqual({
        assetId: `signet:${second}`, ticker: "SAME", atoms: "50000000000",
      });
      expect(await readCrcTokenUtxos(db!, "signet", second, owner)).toMatchObject([
        { txid: "a".repeat(64), vout: 1, atoms: "25000000000" },
        { txid: "b".repeat(64), vout: 1, atoms: "25000000000" },
      ]);
      expect(await readCrcTokenUtxos(db!, "regtest", second, owner)).toEqual([]);
      expect(await readCrcTokenUtxos(db!, "signet", second, "0014" + "2".repeat(40))).toEqual([]);
      expect(await readCrcTokenUtxo(db!, "signet", second, "a".repeat(64), 1)).toEqual({ scriptHex: owner, atoms: 25000000000n });
      expect(await readCrcTokenUtxo(db!, "regtest", second, "a".repeat(64), 1)).toBeNull();
      expect(await readCrcTokenUtxo(db!, "signet", first, "a".repeat(64), 1)).toBeNull();
    } finally {
      await db!.execute(sql`delete from cove_crc_balances
        where network = 'signet' and deploy_txid = ${second} and script_hex = ${owner}`);
    }
  });

  it("quotes the confirmed vault inventory from Postgres without Core", async () => {
    const asset = await readCrcQuoteAsset(db!, "signet", first);
    expect(asset).not.toBeNull();
    expect(quoteCrcBuy(asset!, 100_000_000_000n)).toMatchObject({ operation: "transfer", grossSats: "27" });
    expect(quoteCrcSell(asset!, 100_000_000_000n, owner)).toMatchObject({ grossSats: "27", walletTopUpSats: "1267" });
    await db!.execute(sql`delete from cove_crc_launch_intents where network = 'signet' and txid = ${second}`);
    expect(await readCrcAsset(db!, "signet", second)).not.toBeNull();
    expect(await readCrcQuoteAsset(db!, "signet", second)).toBeNull();
  });

  it("refuses a projection whose creator differs from the authorized launch", async () => {
    await db!.execute(sql`update cove_crc_launch_intents set creator_script_hex = ${"0014" + "9".repeat(40)} where network = 'signet' and txid = ${first}`);
    try {
      expect(await readCrcQuoteAsset(db!, "signet", first)).toBeNull();
    } finally {
      await db!.execute(sql`update cove_crc_launch_intents set creator_script_hex = ${owner} where network = 'signet' and txid = ${first}`);
    }
  });
});
