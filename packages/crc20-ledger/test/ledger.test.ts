import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, networks } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { applyTransaction, createLedger, balanceOf } from "../src/index.js";

type Fixture = {
  txid: string;
  height: number;
  index: number;
  kind: "deploy" | "mint" | "transfer";
  ticker: string;
  from: string | null;
  to: string | null;
  amount: string | null;
  outputs: { valueSats: number; scriptHex: string }[];
};
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/leaf-events.json", import.meta.url)), "utf8"),
) as Fixture[];
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

  it("replays all archived labels as provisional decisions, without claiming chain provenance", () => {
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
            ? { assetId, senderAddress: item.from! }
            : undefined;
      const result = applyTransaction(state, transaction, decision);
      expect(result.status, `${item.kind} ${item.txid}: ${result.reason}`).toBe("applied");
      state = result.state;
      counts[item.kind]++;
      if (item.kind === "transfer") {
        expect(balanceOf(state, assetId, item.from!)).toBeGreaterThanOrEqual(0n);
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
