import { describe, expect, it } from "vitest";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import { blockExtendsCursor, persistentWorker, reorgPersistentToTip } from "./persistent.js";
import { V3IndexerState } from "./state.js";
import type { V3Store } from "./store.js";

describe("persistent block continuity", () => {
  it("accepts the activation block and a direct successor", () => {
    expect(
      blockExtendsCursor(
        { height: 0n, blockHash: "" },
        { height: 100n, parentHash: "prior" },
        100n,
      ),
    ).toBe(true);
    expect(
      blockExtendsCursor({ height: 100n, blockHash: "a" }, { height: 101n, parentHash: "a" }, 100n),
    ).toBe(true);
  });

  it("rejects a successor from a competing branch or a skipped height", () => {
    expect(
      blockExtendsCursor({ height: 100n, blockHash: "a" }, { height: 101n, parentHash: "b" }, 100n),
    ).toBe(false);
    expect(
      blockExtendsCursor({ height: 100n, blockHash: "a" }, { height: 102n, parentHash: "a" }, 100n),
    ).toBe(false);
  });

  it("rolls back an orphaned tip before persisting a fetched successor", async () => {
    const config = {
      network: "regtest" as const,
      chainIdentity: "bitcoin-regtest",
      guardianXOnly: Buffer.alloc(32),
      recoveryKeyXOnly: Buffer.alloc(32),
      feeScript: Buffer.alloc(22),
      genesisHeight: 99n,
    };
    const P = "p".repeat(64);
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const C = "c".repeat(64);
    const state = new V3IndexerState(config);
    state.applyBlock({ height: 99n, hash: P, parentHash: "0".repeat(64), txs: [] });
    state.applyBlock({ height: 100n, hash: A, parentHash: P, txs: [] });
    const canonical = new Map([
      [99, P],
      [100, B],
      [101, C],
    ]);
    const parent = new Map([
      [B, P],
      [C, B],
    ]);
    const provider = {
      getBlockchainInfo: async () => ({ blocks: 101 }),
      getBlockHash: async (height: number) => canonical.get(height)!,
      getBlock: async (hash: string) => ({
        hash,
        previousBlockHash: parent.get(hash)!,
        rawTxs: [],
      }),
    } as unknown as CoreRpcProvider;
    const persisted: string[] = [];
    const rolledBack: bigint[] = [];
    const store = {
      persistBlock: async (_tx: unknown, _state: unknown, block: { hash: string }) => {
        persisted.push(block.hash);
      },
      rollback: async (_tx: unknown, undo: { height: bigint }) => {
        rolledBack.push(undo.height);
      },
    } as unknown as V3Store;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    } as unknown as Database;

    await persistentWorker({ db, store, state, provider, config });

    expect(rolledBack).toEqual([100n]);
    expect(persisted).toEqual([B, C]);
    expect(state.undoByHeight.get(100n)?.blockHash).toBe(B);
    expect(state.cursor.blockHash).toBe(C);
  });

  it("rolls back when Core's tip is shorter than the indexed cursor", async () => {
    const config = {
      network: "regtest" as const,
      chainIdentity: "bitcoin-regtest",
      guardianXOnly: Buffer.alloc(32),
      recoveryKeyXOnly: Buffer.alloc(32),
      feeScript: Buffer.alloc(22),
      genesisHeight: 99n,
    };
    const P = "p".repeat(64);
    const A = "a".repeat(64);
    const C = "c".repeat(64);
    const state = new V3IndexerState(config);
    state.applyBlock({ height: 99n, hash: P, parentHash: "0".repeat(64), txs: [] });
    state.applyBlock({ height: 100n, hash: A, parentHash: P, txs: [] });
    state.applyBlock({ height: 101n, hash: C, parentHash: A, txs: [] });
    const rolledBack: bigint[] = [];
    const provider = {
      getBlockchainInfo: async () => ({ blocks: 100 }),
      getBlockHash: async (height: number) => height === 100 ? A : P,
    } as unknown as CoreRpcProvider;
    const store = {
      rollback: async (_tx: unknown, undo: { height: bigint }) => {
        rolledBack.push(undo.height);
      },
    } as unknown as V3Store;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    } as unknown as Database;

    await reorgPersistentToTip({ db, store, state, provider, config });

    expect(rolledBack).toEqual([101n]);
    expect(state.cursor).toMatchObject({ height: 100n, blockHash: A });
  });
});
