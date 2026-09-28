import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@crclaunch/db";

vi.mock("@crclaunch/cove-indexer/v3", () => ({
  getTokenUtxosByScriptDb: async () => [],
  getBalanceByScriptDb: async () => 0n,
}));

import { getWalletPortfolio } from "./wallet-read.js";

function mockDb(fillRows: unknown[] = []): Database {
  return {
    select: () => ({
      from: (table: unknown) => {
        const query = { where: () => query, groupBy: () => query, orderBy: () => query, limit: () => query, offset: async () => table === schema.coveV3MarketFills ? fillRows : [] };
        return query;
      },
    }),
  } as unknown as Database;
}

describe("getWalletPortfolio public projection (§M7)", () => {
  it("does not leak off-chain tx sessions for any address", async () => {
    const portfolio = await getWalletPortfolio(mockDb(), "regtest", "0014" + "11".repeat(20));
    expect(portfolio).not.toHaveProperty("sessions");
    expect(Object.keys(portfolio).sort()).toEqual(["fills", "holdings", "listings", "pagination", "tokenUtxos", "walletScript"]);
  });
  it("excludes signing and private coordination fields from wallet fills", async () => {
    const portfolio = await getWalletPortfolio(mockDb([{ id: "fill", status: "BROADCAST", psbtBase64: "secret", buyerFundInputs: [{ txid: "private" }], buyerTokenScript: "private", failureReason: "internal", unsignedTxDigest: "private" }]), "regtest", "script");
    expect(portfolio.fills[0]).toMatchObject({ id: "fill", status: "BROADCAST" });
    for (const key of ["psbtBase64", "buyerFundInputs", "buyerTokenScript", "failureReason", "unsignedTxDigest"]) expect(portfolio.fills[0]).not.toHaveProperty(key);
  });

});
