import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@crclaunch/db";
import { loadSparklines, sparklineQuery } from "./sparklines-db";
import { bucketTrades, unitPriceSats, type Trade } from "./ohlc";
import { getWalletPortfolio } from "../../../../packages/cove-app/src/wallet-read";
import { getTokenHoldersDb, getBalanceByScriptDb } from "../../../../packages/cove-indexer/src/v3/read-models-db";
import { getBuyRoutes } from "../../../../packages/cove-market/src/best-execution";

const url = process.env.BOUNDED_READ_TEST_DATABASE_URL;
const isolated = url && new URL(url).pathname === "/bounded_reads_test" && new URL(url).port === "5434" && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
const db = isolated ? createDb(url!) : undefined;
const network = "bounded-fixture";
const token = "fixture-token";
const hours = [0, 1, 2, 39, 40, 42];
const trades: Trade[] = hours.map((hour, i) => ({ timestamp: Date.UTC(2026, 0, 1) + hour * 3600000, amountAtoms: 100000000000n, totalPriceSats: BigInt(100 + i) }));

describe.skipIf(!isolated)("bounded reads on isolated PostgreSQL", () => {
  beforeAll(async () => {
    await db!.execute(sql`delete from cove_v3_market_trades where network = ${network}`);
    await db!.execute(sql`delete from cove_v3_events where network = ${network}`);
    await db!.execute(sql`delete from cove_v3_token_utxos where network = ${network}`);
    await db!.execute(sql`delete from cove_v3_market_listings where network = ${network}`);
    await db!.execute(sql`delete from cove_v3_market_fills where network = ${network}`);
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i]!;
      if (i % 2 === 0) await db!.execute(sql`insert into cove_v3_market_trades
        (network,token_id,listing_id,fill_id,seller_token_script,buyer_token_script,amount_atoms,total_price_sats,market_fee_sats,miner_fee_sats,txid,block_height,created_at)
        values (${network},${token},'listing','fill','seller','buyer',${t.amountAtoms.toString()},${t.totalPriceSats.toString()},0,0,${`trade-${i}`},${i},${new Date(t.timestamp).toISOString()})`);
      else await db!.execute(sql`insert into cove_v3_events
        (network,token_id,txid,block_height,block_hash,tx_index,operation,valid,amount_atoms,gross_sats,created_at)
        values (${network},${token},${`trade-${i}`},${i},'hash',0,'MINT',true,${t.amountAtoms.toString()},${t.totalPriceSats.toString()},${new Date(t.timestamp).toISOString()})`);
    }
    await db!.execute(sql`insert into cove_v3_market_trades
      (network,token_id,listing_id,fill_id,seller_token_script,buyer_token_script,amount_atoms,total_price_sats,market_fee_sats,miner_fee_sats,txid,block_height,created_at)
      select ${network},'large','listing','fill','seller','buyer',100000000000,100000000+i,0,0,'large-'||i,i,
        timestamptz '2020-01-01' + i * interval '1 minute' from generate_series(1,100000) i`);
    await db!.execute(sql`insert into cove_v3_token_utxos
      (network,txid,vout,token_id,amount_atoms,script_pub_key,created_height,created_block_hash)
      select ${network},'utxo-'||lpad(i::text,5,'0'),0,case when i <= 250 then 'holding-a' else 'holding-b' end,i,'wallet',i,'hash' from generate_series(1,600) i`);
    await db!.execute(sql`insert into cove_v3_events
      (network,token_id,txid,block_height,block_hash,tx_index,operation,valid,amount_atoms,gross_sats,created_at)
      values (${network},'single','single',1,'hash',0,'MINT',true,100000000000,250,'2026-01-01T00:00:00Z')`);
    await db!.execute(sql`analyze cove_v3_market_trades`);
  }, 30000);

  it("preserves all-history closing prices and filled gaps with at most 32 points", async () => {
    const result = await loadSparklines(db!, network, [token, "missing"]);
    expect(result.series[token]).toEqual(bucketTrades(trades, "1h").slice(-32).map((c) => c.close));
    expect(result.lastPrice[token]).toBe(unitPriceSats(trades.at(-1)!.amountAtoms, trades.at(-1)!.totalPriceSats));
    expect(result.series.missing).toEqual([]);
    expect(result.lastPrice.missing).toBeNull();
  });

  it("does not invent earlier buckets for a new token", async () => {
    const result = await loadSparklines(db!, network, [token]);
    expect(result.series[token]).toHaveLength(32);
    const single = await loadSparklines(db!, network, ["single"]);
    expect(single.series.single).toEqual([250]);
  });

  it("uses indexed bounded seeks over 100,000 historical trades", async () => {
    const result = await loadSparklines(db!, network, ["large"]);
    expect(result.series.large).toHaveLength(32);
    const plan = await db!.execute(sql`explain (analyze, buffers, format json) ${sparklineQuery(network, ["large"])}`);
    const text = JSON.stringify(plan.rows);
    expect(text).toContain("cove_v3_market_trades_positive_price_time_idx");
    expect(text).not.toContain('"Node Type":"Seq Scan"');
    console.log("Sparkline 100k-row plan:", JSON.stringify((plan.rows[0]!["QUERY PLAN"] as { "Execution Time": number }[])[0]!["Execution Time"]), "ms");
  });

  it("pages output rows while balances aggregate every live output", async () => {
    const first = await getWalletPortfolio(db!, network, "wallet", { limit: 100 });
    expect(first.tokenUtxos).toHaveLength(100);
    expect(first.pagination.hasMore.tokenUtxos).toBe(true);
    expect(first.holdings).toEqual([
      { tokenId: "holding-a", amountAtoms: 31375n, utxoCount: 250 },
      { tokenId: "holding-b", amountAtoms: 148925n, utxoCount: 350 },
    ]);
    const second = await getWalletPortfolio(db!, network, "wallet", { limit: 100, offset: 100 });
    expect(second.tokenUtxos[0]!.txid).not.toBe(first.tokenUtxos[0]!.txid);
    expect(await getBalanceByScriptDb(db!, network, "holding-a", "wallet")).toBe(31375n);
    expect(await getTokenHoldersDb(db!, network, "holding-a", 1)).toEqual([{ scriptPubKey: "wallet", amountAtoms: 31375n }]);
    expect(await getTokenHoldersDb(db!, network, "holding-a", 1, 1)).toEqual([]);
  });

  it("returns cheapest candidates in SQL with a deterministic cap", async () => {
    await db!.execute(sql`insert into cove_v3_market_listings
      (listing_id,network,chain_identity,token_id,order_version,seller_token_script,seller_payout_script,seller_token_change_script,source_txid,source_vout,source_amount_atoms,amount_atoms,total_price_sats,creation_height,expiry_height,nonce,signature_b64)
      select 'candidate-'||lpad(i::text,5,'0'),${network},'chain','routes',1,'seller','seller','seller','source-'||i,0,100,100,1000-i,0,999,'nonce','signature' from generate_series(1,150) i`);
    const routes = await getBuyRoutes(db!, network, "routes", 100n);
    expect(routes).toHaveLength(100);
    expect(routes[0]!.kind).toBe("p2p");
    expect(routes[0]!.breakdown).toMatchObject({ listingId: "candidate-00150", sellerPriceSats: 850n });
  });
  it("finds seller fills even when their listings fall outside the listing page", async () => {
    await db!.execute(sql`insert into cove_v3_market_listings
      (listing_id,network,chain_identity,token_id,order_version,seller_token_script,seller_payout_script,seller_token_change_script,source_txid,source_vout,source_amount_atoms,amount_atoms,total_price_sats,creation_height,expiry_height,nonce,signature_b64,created_at)
      select 'wallet-listing-'||i,${network},'chain','routes',1,'wallet','wallet','wallet','wallet-source-'||i,0,100,100,100,0,999,'nonce','signature',timestamptz '2026-01-01' + i * interval '1 hour' from generate_series(1,3) i`);
    await db!.execute(sql`insert into cove_v3_market_fills
      (listing_id,network,token_id,buyer_token_script,buyer_change_script,buyer_fund_inputs,amount_atoms,total_price_sats,market_fee_sats,extra_carrier_sats,miner_fee_sats,psbt_base64)
      values ('wallet-listing-1',${network},'routes','other-buyer','other-buyer','[]',100,100,0,0,0,'private')`);
    const result = await getWalletPortfolio(db!, network, 'wallet', { limit: 1 });
    expect(result.listings[0]!.listingId).toBe('wallet-listing-3');
    expect(result.fills[0]!.listingId).toBe('wallet-listing-1');
    expect(result.fills[0]).not.toHaveProperty('psbtBase64');
    expect(result.fills[0]).not.toHaveProperty('buyerFundInputs');
  });

  it("keeps newest raw price separate when a zero-price trade creates no candle", async () => {
    const prior = await loadSparklines(db!, network, ['single']);
    await db!.execute(sql`insert into cove_v3_events
      (network,token_id,txid,block_height,block_hash,tx_index,operation,valid,amount_atoms,gross_sats,created_at)
      values (${network},'single','single-zero',2,'hash',0,'REDEEM',true,100000000000,0,'2026-01-10T00:00:00Z')`);
    const result = await loadSparklines(db!, network, ['single']);
    expect(result.series.single).toEqual(prior.series.single);
    expect(result.lastPrice.single).toBe(0);
  });

  it("indexes and reads high BTC prices without bigint multiplication overflow", async () => {
    const start = Date.UTC(2026, 0, 2);
    const prices: Trade[] = [
      { timestamp: start, amountAtoms: 100000000000n, totalPriceSats: 201234567n },
      { timestamp: start + 3600000, amountAtoms: 100000000000n, totalPriceSats: 312345678n },
    ];
    await db!.execute(sql`insert into cove_v3_market_trades
      (network,token_id,listing_id,fill_id,seller_token_script,buyer_token_script,amount_atoms,total_price_sats,market_fee_sats,miner_fee_sats,txid,block_height,created_at)
      values (${network},'high-btc','listing','fill','seller','buyer',100000000000,201234567,0,0,'high-p2p',1,${new Date(start).toISOString()})`);
    await db!.execute(sql`insert into cove_v3_events
      (network,token_id,txid,block_height,block_hash,tx_index,operation,valid,amount_atoms,gross_sats,created_at)
      values (${network},'high-btc','high-curve',2,'hash',0,'MINT',true,100000000000,312345678,${new Date(start + 3600000).toISOString()})`);
    // Index builds must also tolerate existing high-price history during deployment.
    await db!.execute(sql`drop index cove_v3_events_positive_price_time_idx, cove_v3_market_trades_positive_price_time_idx`);
    const migration = readFileSync(new URL("../../../../packages/db/drizzle/0013_bounded_public_reads.sql", import.meta.url), "utf8");
    await db!.execute(sql.raw(migration));
    const result = await loadSparklines(db!, network, ['high-btc']);
    expect(result.series['high-btc']).toEqual(bucketTrades(prices, '1h').map((c) => c.close));
    expect(result.lastPrice['high-btc']).toBe(312345678);
  });

});
