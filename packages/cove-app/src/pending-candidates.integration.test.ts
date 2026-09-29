import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@crclaunch/db";
import { listSubmittedSpendsOfBacking } from "./tx-session.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const address = url ? new URL(url) : undefined;
const isolated =
  address?.hostname === "127.0.0.1" &&
  address.port === "5435" &&
  address.pathname === "/submissions_test";

describe.skipIf(!isolated)("accepted branch selection before SQL limit", () => {
  it.each([65, 100, 2000])(
    "finds the accepted winner after %i losing historical competitors",
    async (losers) => {
      const db = createDb(url!);
      const network = "candidate-limit-" + randomUUID();
      const backing = "aa".repeat(32),
        token = "bb".repeat(32),
        winner = "ff".repeat(32);
      try {
        await db.insert(schema.coveV3AppTransactions).values(
          Array.from({ length: losers }, (_, i) => ({
            network,
            tokenId: token,
            walletScript: "51",
            operation: "BACKING_BUY",
            backingTxid: backing,
            backingVout: 1,
            txid: i.toString(16).padStart(64, "0"),
            idempotencyKey: "loser-" + i,
            status: ["BROADCAST", "WALLET_SIGNED", "REORGED", "CONFIRMED"][i % 4]!,
          })),
        );
        await db.insert(schema.coveV3AppTransactions).values({
          network,
          tokenId: token,
          walletScript: "51",
          operation: "BACKING_BUY",
          backingTxid: backing,
          backingVout: 1,
          txid: winner,
          idempotencyKey: "winner",
          status: "BROADCAST",
        });
        expect(
          await listSubmittedSpendsOfBacking(db, network, token, backing, 1, new Set([winner])),
        ).toEqual([{ txid: winner, operation: "BACKING_BUY" }]);
        expect(
          await listSubmittedSpendsOfBacking(db, network, token, backing, 1, new Set()),
        ).toEqual([]);
        expect(
          await listSubmittedSpendsOfBacking(
            db,
            network,
            token,
            backing,
            1,
            new Set(["cc".repeat(32)]),
          ),
        ).toEqual([]);
      } finally {
        await db
          .delete(schema.coveV3AppTransactions)
          .where(eq(schema.coveV3AppTransactions.network, network));
      }
    },
  );
});
