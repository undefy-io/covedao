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
const txid = "a".repeat(64);

describe.skipIf(!isolated)("CRC wallet funding from server observation", () => {
  afterAll(async () => { await db!.execute(sql`delete from cove_wallet_funding where network = ${network} and wallet_script = ${scriptHex}`); });

  it("accepts only observed outpoints and uses stored values rather than client values", async () => {
    await saveWalletFundingSnapshot(db!, network, scriptHex, [{ txid, vout: 1, valueSats: "10000", confirmations: 2 }]);
    expect(await loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 1 }])).toEqual([{
      txid, vout: 1, valueSats: 10000, scriptHex,
    }]);
    await expect(loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 2 }])).rejects.toThrow(/observed/i);
    await expect(loadCrcFundingCandidates(db!, network, scriptHex, [{ txid, vout: 1 }, { txid, vout: 1 }])).rejects.toThrow(/duplicate/i);
  });
});
