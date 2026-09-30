import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@crclaunch/db";
import { listCrcAssets, readCrcAsset, readCrcBalance, readCrcQuoteAsset, readCrcWalletBalances } from "./crc-read";
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

describe.skipIf(!isolated)("Cove CRC database reads", () => {
  beforeAll(async () => {
    for (const network of ["signet", "regtest"]) {
      await db!.execute(sql`delete from cove_crc_balances where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_vaults where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_assets where network = ${network} and deploy_txid in (${first}, ${second})`);
      await db!.execute(sql`delete from cove_crc_launch_intents where network = ${network} and txid in (${first}, ${second})`);
    }
    for (const [network, deployTxid, height] of [
      ["signet", first, 11], ["signet", second, 12], ["regtest", first, 13],
    ] as const) {
      const vaultScript = `0014${deployTxid.slice(0, 40)}`;
      await db!.execute(sql`insert into cove_crc_assets
        (network,deploy_txid,ticker,deploy_height,deploy_block_hash,launch_salt_hex,creator_script_hex,protocol_script_hex)
        values (${network},${deployTxid},'SAME',${height},'block',${deployTxid},${owner},${owner})`);
      await db!.execute(sql`insert into cove_crc_vaults
        (network,deploy_txid,txid,vout,script_hex,btc_sats,minted_atoms,inventory_atoms,availability)
        values (${network},${deployTxid},${deployTxid},1,${vaultScript},1000,200000000000,100000000000,'active')`);
      await db!.execute(sql`insert into cove_crc_launch_intents
        (network,txid,ticker,signed_raw_hex,raw_sha256,launch_salt_hex,vault_script_hex,creator_script_hex,protocol_script_hex,vault_anchor_sats)
        values (${network},${deployTxid},'SAME','00','hash',${deployTxid},${vaultScript},${owner},${owner},973)`);
    }
    await db!.execute(sql`insert into cove_crc_balances (network,deploy_txid,script_hex,atoms)
      values ('signet',${first},${owner},100000000000),('signet',${second},${owner},50000000000),('regtest',${first},${owner},200000000000)`);
  });

  afterAll(async () => {
    for (const network of ["signet", "regtest"]) {
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
    expect(await readCrcAsset(db!, "regtest", second)).toBeNull();
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
