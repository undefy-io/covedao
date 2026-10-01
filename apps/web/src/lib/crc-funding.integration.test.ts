import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, saveWalletFundingSnapshot } from "@crclaunch/db";
import { loadCrcFundingCandidates } from "./crc-funding";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = !!url && (() => { const u = new URL(url); return u.hostname === "127.0.0.1" && u.port === "5435" && u.pathname === "/crc_test"; })();
const db = isolated ? createDb(url!) : undefined;
const network = "signet";
const scriptHex = "0014" + randomUUID().replaceAll("-", "").slice(0, 40).padEnd(40, "0");
const txid = randomUUID().replaceAll("-", "").padEnd(64, "a");
const ordinaryTxid = randomUUID().replaceAll("-", "").padEnd(64, "c");
const deployTxid = randomUUID().replaceAll("-", "").padEnd(64, "b");

describe.skipIf(!isolated)("CRC wallet funding from server observation", () => {
  afterAll(async () => {
    await db!.execute(sql`delete from cove_crc_token_utxos where network = ${network} and deploy_txid = ${deployTxid}`);
    await db!.execute(sql`delete from cove_crc_assets where network = ${network} and deploy_txid = ${deployTxid}`);
    await db!.execute(sql`delete from cove_wallet_funding where network = ${network} and wallet_script = ${scriptHex}`);
  });

  it("accepts only observed outpoints and uses stored values rather than client values", async () => {
    await saveWalletFundingSnapshot(db!, network, scriptHex, [{ txid, vout: 1, valueSats: "10000", confirmations: 2 }]);
    expect(await loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 1 }])).toEqual([{
      txid, vout: 1, valueSats: 10000, scriptHex,
    }]);
    await expect(loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 2 }])).rejects.toThrow(/observed/i);
    await expect(loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 1 }, { txid, vout: 1 }])).rejects.toThrow(/duplicate/i);
  });

  it("does not select a live token-bearing output as ordinary BTC funding", async () => {
    await saveWalletFundingSnapshot(db!, network, scriptHex, [
      { txid, vout: 1, valueSats: "10000", confirmations: 2 },
      { txid: ordinaryTxid, vout: 0, valueSats: "20000", confirmations: 2 },
    ]);
    await db!.execute(sql`insert into cove_crc_assets
      (network,deploy_txid,ticker,deploy_height,deploy_block_hash,launch_salt_hex,creator_script_hex,protocol_script_hex,protocol_version,burned_atoms)
      values (${network},${deployTxid},'TEST',100,${deployTxid},${deployTxid},${scriptHex},${scriptHex},3,0)`);
    await db!.execute(sql`insert into cove_crc_token_utxos
      (network,deploy_txid,txid,vout,script_hex,atoms,created_height,created_block_hash)
      values (${network},${deployTxid},${txid},1,${scriptHex},100000000000,101,${deployTxid})`);
    expect(await loadCrcFundingCandidates(db!, network, scriptHex,
      [{ txid, vout: 1 }, { txid: ordinaryTxid, vout: 0 }])).toEqual([
      { txid: ordinaryTxid, vout: 0, valueSats: 20000, scriptHex },
    ]);
  });
});
