import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { address, networks } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { applyTransaction, createLedger, balanceOf, sealMintSupply } from "../src/index.js";

type Fixture = {
  txid: string;
  height: number;
  index: number;
  blockHash?: string;
  kind: "deploy" | "mint" | "transfer";
  ticker: string;
  from: string | null;
  firstInputAddress?: string | null;
  to: string | null;
  amount: string | null;
  outputs: { valueSats: number; scriptHex: string }[];
};
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/leaf-events.json", import.meta.url)), "utf8"),
) as Fixture[];
type Checkpoint = {
  format: string;
  provenance: string;
  anchor: { height: number; block_hash: string; tx_index: number };
  allocation_sha256: string;
  allocations: {
    txid: string;
    block_hash: string;
    height: number;
    tx_index: number;
    beneficiary: string;
    amount_atoms: string;
  }[];
};
const checkpoint = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../artifacts/crc-garden/leaf-issuance-checkpoint.json", import.meta.url),
    ),
    "utf8",
  ),
) as Checkpoint;
const txid = (byte: string) => byte.repeat(64);
const script = (byte: string) => `5120${byte.repeat(64)}`;
const recipient = (byte: string) =>
  address.toBech32(Buffer.from(byte.repeat(64), "hex"), 1, networks.bitcoin.bech32);
const out = (byte: string) => ({ valueSats: 330, scriptHex: script(byte) });
function marker(value: object) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    valueSats: 0,
    scriptHex: `6a${bytes.length.toString(16).padStart(2, "0")}${bytes.toString("hex")}`,
  };
}
const deploy = (tick: string) => [marker({ p: "crc-20", op: "deploy", tick }), out("a")];
const mint = (tick: string) => [marker({ p: "crc-20", op: "mint", tick }), out("b")];
const transfer = (tick: string, amt: string) => [
  marker({ p: "crc-20", op: "transfer", tick, amt }),
  out("c"),
];

describe("CRC-20 address ledger", () => {
  it("uses Bitcoin block transaction positions rather than activity-page order", () => {
    const first = fixtures.find(
      (item) => item.txid === "4665db447be14309d881211b71221c0e04bde9ab98884fd0bb41245f12236da0",
    );
    const later = fixtures.find(
      (item) => item.txid === "af388187965195d70a6520518db562695708cb9dc4142ee71a693ad2bc4aeac8",
    );
    expect(first?.index).toBe(42);
    expect(later?.index).toBe(357);
    expect(
      fixtures.every(
        (item, index) =>
          index === 0 ||
          item.height > fixtures[index - 1]!.height ||
          (item.height === fixtures[index - 1]!.height && item.index > fixtures[index - 1]!.index),
      ),
    ).toBe(true);
  });
  it("derives the observed sender from the first input prevout rather than the API label", () => {
    expect(fixtures.every((item) => item.firstInputAddress !== undefined)).toBe(true);
    expect(fixtures.filter((item) => item.firstInputAddress === item.from)).toHaveLength(1950);
  });
  it("pins the checkpoint to the archived Bitcoin block and 812 named mints", () => {
    expect(checkpoint.format).toBe("crc20-leaf-external-issuance-v1");
    expect(checkpoint.provenance).toContain("API labels");
    expect(checkpoint.allocations).toHaveLength(812);
    expect(new Set(checkpoint.allocations.map((row) => row.txid)).size).toBe(812);
    expect(checkpoint.allocations.reduce((sum, row) => sum + BigInt(row.amount_atoms), 0n)).toBe(
      100000000000000000n,
    );
    const anchorTx = fixtures.find((item) => item.txid === checkpoint.allocations.at(-1)!.txid);
    expect(anchorTx?.height).toBe(checkpoint.anchor.height);
    expect(anchorTx?.index).toBe(checkpoint.anchor.tx_index);
    expect(anchorTx?.blockHash).toBe(checkpoint.anchor.block_hash);
    const mintTxids = new Set(
      fixtures.filter((item) => item.kind === "mint").map((item) => item.txid),
    );
    expect(new Set(checkpoint.allocations.map((row) => row.txid))).toEqual(mintTxids);
    for (const row of checkpoint.allocations) {
      const event = fixtures.find((item) => item.txid === row.txid)!;
      expect([event.height, event.index, event.blockHash, event.to]).toEqual([
        row.height,
        row.tx_index,
        row.block_hash,
        row.beneficiary,
      ]);
    }
    const canonical = JSON.stringify(
      checkpoint.allocations.map((row) =>
        Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
      ),
    );
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(checkpoint.allocation_sha256);
  });
  it("replays post-mint transfers from the pinned issuance state and fails closed", () => {
    const deployTx = fixtures.find((item) => item.kind === "deploy")!;
    const assetId = `mainnet:${deployTx.txid}`;
    const allocations = new Map(checkpoint.allocations.map((row) => [row.txid, row]));
    const anchor = checkpoint.anchor;
    const afterAnchor = (item: Fixture) =>
      item.height > anchor.height ||
      (item.height === anchor.height && item.index > anchor.tx_index);
    let state = createLedger();
    let preAnchorTransfers = 0;
    let postAnchorTransfers = 0;
    for (const item of fixtures) {
      if (afterAnchor(item) && !state.finalMintAnchors[assetId]) {
        throw new Error("mint supply was not sealed at the anchor");
      }
      const row = allocations.get(item.txid);
      const decision =
        item.kind === "mint"
          ? { assetId, amountAtoms: row?.amount_atoms, recipientAddress: row?.beneficiary }
          : item.kind === "transfer"
            ? {
                assetId,
                senderAddress: item.firstInputAddress!,
                ...(afterAnchor(item) ? { observedFinalMintAnchorHash: anchor.block_hash } : {}),
              }
            : undefined;
      const result = applyTransaction(
        state,
        {
          network: "mainnet",
          txid: item.txid,
          height: item.height,
          index: item.index,
          outputs: item.outputs,
        },
        decision,
      );
      expect(result.status, `${item.txid}: ${result.reason}`).toBe("applied");
      state = result.state;
      if (item.kind === "transfer") {
        if (afterAnchor(item)) postAnchorTransfers++;
        else preAnchorTransfers++;
      }
      if (item.txid === checkpoint.allocations.at(-1)!.txid) {
        expect(() =>
          sealMintSupply(
            state,
            assetId,
            { height: anchor.height, index: anchor.tx_index, blockHash: anchor.block_hash },
            "999",
          ),
        ).toThrow();
        expect(() =>
          sealMintSupply(
            state,
            assetId,
            { height: anchor.height, index: anchor.tx_index + 1, blockHash: anchor.block_hash },
            "100000000000000000",
          ),
        ).toThrow();
        state = sealMintSupply(
          state,
          assetId,
          { height: anchor.height, index: anchor.tx_index, blockHash: anchor.block_hash },
          "100000000000000000",
        );
      }
    }
    expect([preAnchorTransfers, postAnchorTransfers]).toEqual([66, 1071]);
    expect(state.assets[assetId]?.supplyAtoms).toBe("100000000000000000");
    const finalBalances = Object.entries(state.balances[assetId] ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    expect(finalBalances).toHaveLength(1317);
    expect(finalBalances.filter(([, amount]) => BigInt(amount) > 0n)).toHaveLength(958);
    expect(finalBalances.reduce((sum, [, amount]) => sum + BigInt(amount), 0n)).toBe(
      100000000000000000n,
    );
    expect(finalBalances.every(([, amount]) => BigInt(amount) >= 0n)).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(finalBalances)).digest("hex")).toBe(
      "6fd835f4bd580ab02cc5bf49a77fce7e9d3c6202f71fac881308b1b9ea763355",
    );
    const nextHeight = fixtures.at(-1)!.height + 1;
    const newMint = {
      network: "mainnet" as const,
      txid: txid("e"),
      height: nextHeight,
      index: 0,
      outputs: mint("LEAF"),
    };
    expect(
      applyTransaction(state, newMint, {
        assetId,
        amountAtoms: "1",
        recipientAddress: recipient("b"),
        observedFinalMintAnchorHash: anchor.block_hash,
      }).status,
    ).toBe("invalid");
    const transferTx = {
      network: "mainnet" as const,
      txid: txid("f"),
      height: nextHeight,
      index: 0,
      outputs: transfer("LEAF", "1"),
    };
    expect(
      applyTransaction(state, transferTx, { assetId, senderAddress: recipient("b") }).status,
    ).toBe("invalid");
    expect(
      applyTransaction(state, transferTx, {
        assetId,
        senderAddress: recipient("b"),
        observedFinalMintAnchorHash: txid("a"),
      }).status,
    ).toBe("invalid");
  });
  it("requires an explicit mint allocation and transfer sender, then preserves supply", () => {
    let state = createLedger();
    state = applyTransaction(state, {
      network: "mainnet",
      txid: txid("a"),
      height: 1,
      index: 0,
      outputs: deploy("A"),
    }).state;
    expect(
      applyTransaction(state, {
        network: "mainnet",
        txid: txid("b"),
        height: 2,
        index: 0,
        outputs: mint("A"),
      }).status,
    ).toBe("unresolved");
    state = applyTransaction(
      state,
      { network: "mainnet", txid: txid("b"), height: 2, index: 0, outputs: mint("A") },
      { assetId: `mainnet:${txid("a")}`, amountAtoms: "100", recipientAddress: recipient("b") },
    ).state;
    expect(balanceOf(state, `mainnet:${txid("a")}`, recipient("b"))).toBe(100n);
    expect(
      applyTransaction(state, {
        network: "mainnet",
        txid: txid("c"),
        height: 3,
        index: 0,
        outputs: transfer("A", "60"),
      }).status,
    ).toBe("unresolved");
    const result = applyTransaction(
      state,
      { network: "mainnet", txid: txid("c"), height: 3, index: 0, outputs: transfer("A", "60") },
      { assetId: `mainnet:${txid("a")}`, senderAddress: recipient("b") },
    );
    expect(result.status).toBe("applied");
    expect(balanceOf(result.state, `mainnet:${txid("a")}`, recipient("b"))).toBe(40n);
    expect(balanceOf(result.state, `mainnet:${txid("a")}`, recipient("c"))).toBe(60n);
    expect(result.state.assets[`mainnet:${txid("a")}`]?.supplyAtoms).toBe("100");
    expect(balanceOf(state, `mainnet:${txid("a")}`, recipient("b"))).toBe(100n);
  });

  it("rejects overspend, bad recipient, duplicate tx, and duplicate deploy", () => {
    let state = applyTransaction(createLedger(), {
      network: "mainnet",
      txid: txid("a"),
      height: 1,
      index: 0,
      outputs: deploy("A"),
    }).state;
    state = applyTransaction(
      state,
      { network: "mainnet", txid: txid("b"), height: 2, index: 0, outputs: mint("A") },
      { assetId: `mainnet:${txid("a")}`, amountAtoms: "10", recipientAddress: recipient("b") },
    ).state;
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("c"), height: 3, index: 0, outputs: transfer("A", "11") },
        { assetId: `mainnet:${txid("a")}`, senderAddress: recipient("b") },
      ).status,
    ).toBe("invalid");
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("c"), height: 3, index: 0, outputs: transfer("A", "1") },
        { assetId: `mainnet:${txid("a")}`, senderAddress: recipient("c") },
      ).status,
    ).toBe("invalid");
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("b"), height: 3, index: 0, outputs: mint("A") },
        { assetId: `mainnet:${txid("a")}`, amountAtoms: "1", recipientAddress: recipient("b") },
      ).status,
    ).toBe("invalid");
    expect(
      applyTransaction(state, {
        network: "mainnet",
        txid: txid("a"),
        height: 3,
        index: 0,
        outputs: deploy("A"),
      }).status,
    ).toBe("invalid");
  });

  it("keeps same ticker deployments separate and applies transactions in block order", () => {
    let state = createLedger();
    for (const [tx, index] of [
      [txid("a"), 0],
      [txid("d"), 1],
    ] as const) {
      state = applyTransaction(state, {
        network: "mainnet",
        txid: tx,
        height: 1,
        index,
        outputs: deploy("A"),
      }).state;
    }
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("e"), height: 2, index: 0, outputs: mint("A") },
        { amountAtoms: "1", recipientAddress: recipient("b") },
      ).status,
    ).toBe("unresolved");
    state = applyTransaction(
      state,
      { network: "mainnet", txid: txid("e"), height: 2, index: 0, outputs: mint("A") },
      { assetId: `mainnet:${txid("d")}`, amountAtoms: "5", recipientAddress: recipient("b") },
    ).state;
    expect(balanceOf(state, `mainnet:${txid("a")}`, recipient("b"))).toBe(0n);
    expect(balanceOf(state, `mainnet:${txid("d")}`, recipient("b"))).toBe(5n);
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("f"), height: 2, index: 0, outputs: transfer("A", "1") },
        { assetId: `mainnet:${txid("d")}`, senderAddress: recipient("b") },
      ).status,
    ).toBe("invalid");
    expect(
      applyTransaction(
        state,
        { network: "mainnet", txid: txid("f"), height: 2, index: 1, outputs: transfer("B", "1") },
        { assetId: `mainnet:${txid("d")}`, senderAddress: recipient("b") },
      ).status,
    ).toBe("invalid");
    expect(
      applyTransaction(
        state,
        { network: "signet", txid: txid("f"), height: 2, index: 1, outputs: transfer("A", "1") },
        { assetId: `mainnet:${txid("d")}`, senderAddress: recipient("b") },
      ).status,
    ).toBe("invalid");
  });

  it("does not infer a token transfer from an ordinary Bitcoin spend", () => {
    const state = applyTransaction(createLedger(), {
      network: "mainnet",
      txid: txid("a"),
      height: 1,
      index: 0,
      outputs: deploy("A"),
    }).state;
    const ordinary = applyTransaction(state, {
      network: "mainnet",
      txid: txid("b"),
      height: 2,
      index: 0,
      outputs: [out("b")],
    });
    expect(ordinary.status).toBe("ignored");
    expect(ordinary.state).toBe(state);
  });

  it("replays all archived transactions in verified order with provisional mint allocations", () => {
    expect(fixtures).toHaveLength(1950);
    let state = createLedger();
    const counts = { deploy: 0, mint: 0, transfer: 0 };
    const deployed = fixtures.find((item) => item.kind === "deploy");
    expect(deployed).toBeDefined();
    const assetId = `mainnet:${deployed!.txid}`;
    const firstMint = fixtures.find((item) => item.kind === "mint")!;
    const firstTransfer = fixtures.find((item) => item.kind === "transfer")!;
    expect(
      applyTransaction(createLedger(), {
        network: "mainnet",
        txid: firstMint.txid,
        height: firstMint.height,
        index: firstMint.index,
        outputs: firstMint.outputs,
      }).status,
    ).toBe("unresolved");
    expect(
      applyTransaction(createLedger(), {
        network: "mainnet",
        txid: firstTransfer.txid,
        height: firstTransfer.height,
        index: firstTransfer.index,
        outputs: firstTransfer.outputs,
      }).status,
    ).toBe("unresolved");
    for (const item of fixtures) {
      const transaction = {
        network: "mainnet" as const,
        txid: item.txid,
        height: item.height,
        index: item.index,
        outputs: item.outputs,
      };
      const decision =
        item.kind === "mint"
          ? { assetId, amountAtoms: item.amount!, recipientAddress: item.to! }
          : item.kind === "transfer"
            ? { assetId, senderAddress: item.firstInputAddress! }
            : undefined;
      const result = applyTransaction(state, transaction, decision);
      expect(result.status, `${item.kind} ${item.txid}: ${result.reason}`).toBe("applied");
      state = result.state;
      counts[item.kind]++;
      if (item.kind === "transfer") {
        expect(balanceOf(state, assetId, item.firstInputAddress!)).toBeGreaterThanOrEqual(0n);
      }
    }
    expect(counts).toEqual({ deploy: 1, mint: 812, transfer: 1137 });
    const totalBalances = Object.values(state.balances[assetId] ?? {}).reduce(
      (sum, amount) => sum + BigInt(amount),
      0n,
    );
    expect(totalBalances.toString()).toBe(state.assets[assetId]?.supplyAtoms);
  });
});
