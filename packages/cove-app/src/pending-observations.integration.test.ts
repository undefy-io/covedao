import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  schema,
  claimObservationWorker,
  effectiveBackingObservation,
} from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { getV3Status } from "./health.js";
import { PendingObservationWorker } from "./pending-observations.js";
import { loadV3AppConfig, type V3Network } from "./config.js";
const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const address = url ? new URL(url) : undefined;
const isolated =
  address?.hostname === "127.0.0.1" &&
  address.port === "5435" &&
  address.pathname === "/submissions_test";
describe.skipIf(!isolated)("bounded pending producer on isolated PostgreSQL", () => {
  it("warms cold tokens progressively and rotates beyond the first thousand tracked transactions", async () => {
    const db = createDb(url!);
    const network = "pending-load-" + randomUUID(),
      hash = "aa".repeat(32),
      parent = "bb".repeat(32);
    await db
      .insert(schema.coveV3Cursor)
      .values({ network, height: 101n, blockHash: hash, stateRoot: "root" });
    await db
      .insert(schema.coveV3Blocks)
      .values({ network, height: 101n, hash, parentHash: "cc".repeat(32) });
    await db.insert(schema.coveV3Runtime).values({
      network,
      coreHeight: 101n,
      coreTip: hash,
      coreReachable: true,
      chainObservedAt: new Date(),
    });
    for (let i = 0; i < 5; i++) {
      const tokenId = i.toString(16).padStart(64, "0");
      await db.insert(schema.coveV3Tokens).values({
        network,
        tokenId,
        ticker: "WARM",
        nonce: "nonce",
        policyVersion: 3,
        deployTxid: parent,
        deployHeight: 101n,
        deployBlockHash: hash,
      });
      await db.insert(schema.coveV3BackingStates).values({
        network,
        tokenId,
        stateHash: "state",
        stateVersion: 2,
        policyVersion: 3,
        issuedSupplyAtoms: 0n,
        backingSats: 0n,
        curveStage: 0,
        txid: parent,
        vout: i,
        scriptPubKey: "51",
        btcValue: 10000n,
        blockHeight: 101n,
        blockHash: hash,
      });
    }
    await db.insert(schema.coveV3AppTransactions).values(
      Array.from({ length: 1005 }, (_, i) => ({
        network,
        operation: "DEPLOY",
        tokenId: "00".repeat(32),
        walletScript: "51",
        txid: i.toString(16).padStart(64, "0"),
        status: "BROADCAST",
        idempotencyKey: randomUUID(),
      })),
    );
    await db
      .insert(schema.coveV3SigningJournal)
      .values(
        Array.from({ length: 1005 }, (_, i) => ({
          network,
          backingTxid: parent,
          backingVout: 0,
          unsignedTxDigest: i.toString(16).padStart(64, "0"),
          expiresAt: new Date(0),
          signedAt: new Date(),
          signingResult: { psbtBase64: "abandoned", resultJson: "{}", auditHash: "fixture" },
        })),
      );
    const provider = {
      getMempoolSnapshot: vi.fn().mockResolvedValue(new Set<string>()),
      getMempoolSpenders: vi.fn().mockResolvedValue(undefined),
      getBlockchainInfo: vi.fn().mockResolvedValue({ bestBlockHash: hash, blocks: 101 }),
      getTxout: vi
        .fn()
        .mockResolvedValue({ bestBlockHash: hash, scriptPubKeyHex: "51", valueSats: 10000n }),
    };
    const worker = new PendingObservationWorker(
      db,
      provider as unknown as CoreRpcProvider,
      { ...loadV3AppConfig({ COVE_NETWORK: "regtest" }), network: network as V3Network },
      await claimObservationWorker(db, network),
    );
    for (let i = 0; i < 6; i++) {
      provider.getTxout.mockClear();
      await worker.refresh();
      expect(provider.getTxout.mock.calls.length).toBeLessThanOrEqual(2);
    }
    const warm = await db.execute(
      sql`select count(*)::int as count from cove_pending_backing where network=${network} and payload is not null and observed_revision=requested_revision`,
    );
    expect(warm.rows[0]?.count).toBe(5);
    const statuses = await db.execute(
      sql`select count(*)::int as count from cove_transaction_observations where network=${network}`,
    );
    expect(statuses.rows[0]?.count).toBe(1005);
    const status = await getV3Status({
      db,
      config: { ...loadV3AppConfig({ COVE_NETWORK: "regtest" }), network: network as V3Network },
    });
    expect(status.indexer.health).toBe("HEALTHY");
    expect(status.observations.pendingObservedAt).not.toBeNull();
    const observation = await effectiveBackingObservation(db, network, "00".repeat(32));
    expect(observation?.observedAt).toBeInstanceOf(Date);
    expect(observation?.fresh).toBe(true);
  });
});
