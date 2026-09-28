import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { getV3TokenDetail } from "./token-read.js";

describe("token detail backing lookup", () => {
  it("queries only the requested token's backing instead of the network", async () => {
    const conditions = new Map<unknown, SQL>();
    const db = { select: () => ({ from: (table: unknown) => {
      const rows = table === schema.coveV3Tokens ? [{ tokenId: "requested", ticker: "TOK", deployTxid: "tx", deployHeight: 1n, policyVersion: 1 }] : [];
      const result = Promise.resolve(rows);
      return { where: (condition: SQL) => { conditions.set(table, condition); return { then: result.then.bind(result), groupBy: () => result }; } };
    } }) } as unknown as Database;
    const detail = await getV3TokenDetail(db, "signet", "requested");
    expect(detail?.tokenId).toBe("requested");
    const query = new PgDialect().sqlToQuery(conditions.get(schema.coveV3BackingStates)!);
    expect(query.sql).toContain('"cove_v3_backing_states"."token_id" in');
    expect(query.params).toContain("requested");
    expect(query.params).toContain("signet");
  });

  it("does not query backing rows for missing tokens", async () => {
    const queried: unknown[] = [];
    const db = { select: () => ({ from: (table: unknown) => { queried.push(table); return { where: async () => [] }; } }) } as unknown as Database;
    expect(await getV3TokenDetail(db, "signet", "missing")).toBeNull();
    expect(queried).not.toContain(schema.coveV3BackingStates);
  });
});
