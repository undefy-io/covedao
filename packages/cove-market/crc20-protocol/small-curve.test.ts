import { afterAll, beforeAll, expect, test } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import { writeFileSync } from "node:fs";
import * as p from "./index.ts";
import type { Input, Plan, Ledger } from "./types.js";
import { Core, aliceScript, bobScript, protocolScript } from "./test-support/core.ts";
import {
  checkGardenCompliance,
  type CoveAction,
  type ComplianceReport,
} from "./test-support/compliance.ts";

const core = new Core();
const compliance: ComplianceReport[] = [];
const fees: Record<string, unknown>[] = [];
beforeAll(() => core.start());
afterAll(() => {
  try {
    writeFileSync(
      new URL("./small-curve-fees.json", import.meta.url),
      JSON.stringify(fees, null, 2) + "\n",
    );
    writeFileSync(
      new URL("./small-curve-compliance.json", import.meta.url),
      JSON.stringify(compliance, null, 2) + "\n",
    );
  } finally {
    core.stop();
  }
});
const atoms = (tokens: number) => BigInt(tokens) * 100000000n;
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
};

test("500 + 500 quotes pin proportional platform fees and integer backing rounding before implementation", () => {
  const empty = { issuedAtoms: 0n, inventoryAtoms: 0n };
  expect(p.quoteBuy(empty, atoms(500))).toEqual({
    grossSats: 14n,
    protocolFeeSats: 5007n,
    creatorFeeSats: 546n,
  });
  expect(p.quoteBuy({ issuedAtoms: atoms(500), inventoryAtoms: 0n }, atoms(500))).toEqual({
    grossSats: 13n,
    protocolFeeSats: 5006n,
    creatorFeeSats: 546n,
  });
  expect(p.quoteSell({ issuedAtoms: atoms(1000), inventoryAtoms: 0n }, atoms(400))).toMatchObject({
    grossSats: 10n,
    protocolFeeSats: 1000n,
    creatorFeeSats: 0n,
    economicSats: -990n,
  });
  expect(
    p.quoteSell({ issuedAtoms: atoms(1000), inventoryAtoms: atoms(400) }, atoms(600)),
  ).toMatchObject({
    grossSats: 17n,
    protocolFeeSats: 1000n,
    creatorFeeSats: 0n,
    economicSats: -983n,
  });
  expect(p.quoteSell({ issuedAtoms: atoms(1000), inventoryAtoms: 0n }, atoms(1000))).toMatchObject({
    grossSats: 27n,
    protocolFeeSats: 1000n,
    creatorFeeSats: 0n,
    economicSats: -973n,
  });
  expect(p.backingSats(atoms(500))).toBe(14n);
  expect(p.backingSats(atoms(600))).toBe(17n);
  expect(p.backingSats(atoms(99500))).toBe(2687n);
  expect(p.backingSats(atoms(100500))).toBe(2727n);
  expect(p.quoteBuy({ issuedAtoms: atoms(99800), inventoryAtoms: 0n }, atoms(500))).toEqual({
    grossSats: 22n,
    protocolFeeSats: 5007n,
    creatorFeeSats: 546n,
  });
  for (const amount of [0n, -1n, 1n, atoms(50), atoms(101)])
    expect(() => p.quoteBuy(empty, amount)).toThrow();
});

test.each([{ sells: [400, 600] }, { sells: [1000] }])(
  "confirmed 500 + 500 buys followed by sells $sells check creator/platform fees and every input/output",
  async ({ sells }) => {
    let ledger: Ledger = p.emptyLedger(config),
      deployTxid = "";
    let confirmed = 0;
    const state = () => ledger.assets[deployTxid]!;
    const balance = (script: string) =>
      Object.values(ledger.allocations).reduce(
        (sum, a) => sum + (a.deployTxid === deployTxid && a.scriptHex === script ? a.atoms : 0n),
        0n,
      );
    const funding = (wallet: "alice" | "bob") => [
      core.funding(
        wallet,
        new Set(
          Object.keys(ledger.allocations).concat(deployTxid ? [p.outpoint(state().vault)] : []),
        ),
      ),
    ];
    const owned = () =>
      Object.entries(ledger.allocations)
        .filter(([, a]) => a.deployTxid === deployTxid && a.scriptHex === aliceScript)
        .map(([point, a]) => {
          const [txid, vout] = point.split(":");
          return { ...a, txid: txid!, vout: Number(vout) };
        });
    async function confirm(
      plan: Plan,
      wallets: ("alice" | "bob")[],
      action: CoveAction,
      expected: { gross: number; platform: number; creator: number; prefix: bigint[] },
    ) {
      expect(plan.protocolFeeSats).toBe(BigInt(expected.platform));
      expect(plan.creatorFeeSats).toBe(BigInt(expected.creator));
      const rawHex = core.sign(plan, wallets);
      expect(
        p.validateFinalTransaction(plan, { rawHex, prevouts: plan.inputs }, ledger),
      ).toBeTruthy();
      expect(core.accepted(rawHex).allowed).toBe(true);
      const txid = core.broadcast(rawHex),
        [hash] = core.mine(),
        block = core.block(hash);
      expect(block.transactions).toHaveLength(1);
      const transaction = block.transactions[0],
        tx = Transaction.fromHex(transaction.rawHex);
      expect(p.validateFinalTransaction(plan, transaction)).toBe(txid);
      expect(tx.outs.map((o) => BigInt(o.value))).toEqual(plan.outputs.map((o) => o.sats));
      expect(tx.outs.map((o) => o.script.toString("hex"))).toEqual(
        plan.outputs.map((o) => o.scriptHex),
      );
      expect(tx.outs.slice(0, expected.prefix.length).map((o) => BigInt(o.value))).toEqual(
        expected.prefix,
      );
      const inputSats = transaction.prevouts.reduce(
        (sum: bigint, i: Input) => sum + BigInt(i.sats),
        0n,
      );
      expect(inputSats - tx.outs.reduce((sum, o) => sum + BigInt(o.value), 0n)).toBe(1000n);
      const platform = plan.outputs.findIndex((o) => o.role === "protocolFee"),
        creator = plan.outputs.findIndex((o) => o.role === "creatorFee");
      if (expected.platform) {
        expect(tx.outs[platform]!.script.toString("hex")).toBe(protocolScript);
        expect(tx.outs[platform]!.value).toBe(expected.platform);
      } else expect(platform).toBe(-1);
      if (expected.creator) {
        expect(tx.outs[creator]!.script.toString("hex")).toBe(aliceScript);
        expect(tx.outs[creator]!.value).toBe(expected.creator);
      } else expect(creator).toBe(-1);
      compliance.push(checkGardenCompliance(plan, transaction, action));
      fees.push({
        scenario: sells.join("+"),
        action,
        txid,
        grossSats: expected.gross,
        platformFeeSats: expected.platform,
        creatorFeeSats: expected.creator,
        minerFeeSats: 1000,
        inputs: plan.inputs.map((i) => ({ outpoint: p.outpoint(i), sats: String(i.sats) })),
        outputs: plan.outputs.map((o, vout) => ({
          vout,
          role: o.role,
          sats: String(o.sats),
          scriptHex: o.scriptHex,
        })),
        walletTopUpSats: String(plan.walletTopUpSats ?? 0n),
      });
      ledger = p.applyBlock(ledger, block);
      confirmed++;
      if (deployTxid)
        expect(
          balance(aliceScript) + balance(bobScript) + state().inventoryAtoms + state().burnedAtoms,
        ).toBe(state().issuedAtoms);
      return txid;
    }
    deployTxid = await confirm(
      p.buildDeploy({ config, funding: funding("alice"), changeScriptHex: aliceScript }),
      ["alice"],
      "deploy",
      { gross: 0, platform: 7000, creator: 0, prefix: [0n, 1000n, 1000n, 7000n] },
    );
    for (const [index, expected] of [
      { gross: 14, platform: 5007, creator: 546, prefix: [0n, 1000n, 1014n, 5007n, 546n] },
      { gross: 13, platform: 5006, creator: 546, prefix: [0n, 1000n, 1027n, 5006n, 546n] },
    ].entries()) {
      await confirm(
        p.buildMint({
          state: state(),
          funding: funding("alice"),
          recipientScriptHex: aliceScript,
          changeScriptHex: aliceScript,
          amountAtoms: atoms(500),
        }),
        ["alice"],
        "mint",
        expected,
      );
      expect(balance(aliceScript)).toBe(atoms((index + 1) * 500));
      expect(balance(bobScript)).toBe(0n);
      expect(state().issuedAtoms).toBe(atoms((index + 1) * 500));
      expect(state().inventoryAtoms).toBe(0n);
    }
    let sold = 0;
    for (const amount of sells) {
      const inputs: Input[] = [];
      let collected = 0n;
      for (const input of owned()) {
        inputs.push(input);
        collected += input.atoms;
        if (collected >= atoms(amount)) break;
      }
      const gross = amount === 400 ? 10 : amount === 600 ? 17 : 27;
      const successor = amount === 400 ? 1017n : 1000n;
      const plan = p.buildSell({
        state: state(),
        inputs,
        funding: funding("alice"),
        recipientScriptHex: aliceScript,
        changeScriptHex: aliceScript,
        amountAtoms: atoms(amount),
      });
      expect(plan.walletTopUpSats).toBe(amount === 400 ? 2990n : amount === 600 ? 983n : 973n);
      await confirm(plan, ["alice"], "curveSell", {
        gross,
        platform: 1000,
        creator: 0,
        prefix: [0n, successor, 1000n],
      });
      sold += amount;
      expect(balance(aliceScript)).toBe(atoms(1000 - sold));
      expect(balance(bobScript)).toBe(0n);
      expect(state().issuedAtoms).toBe(atoms(1000));
      expect(state().inventoryAtoms).toBe(atoms(sold));
      expect(state().vault.sats).toBe(successor);
    }
    // Bob independently buys that inventory in two 500-token steps, with the same pinned fees.
    for (const [index, expected] of [
      { gross: 14, platform: 5007, creator: 546, prefix: [0n, 1000n, 1014n, 5007n, 546n] },
      { gross: 13, platform: 5006, creator: 546, prefix: [0n, 1000n, 1027n, 5006n, 546n] },
    ].entries()) {
      await confirm(
        p.buildInventoryBuy({
          state: state(),
          funding: funding("bob"),
          recipientScriptHex: bobScript,
          changeScriptHex: bobScript,
          amountAtoms: atoms(500),
        }),
        ["alice", "bob"],
        "inventoryBuy",
        expected,
      );
      expect(balance(aliceScript)).toBe(0n);
      expect(balance(bobScript)).toBe(atoms((index + 1) * 500));
      expect(state().issuedAtoms).toBe(atoms(1000));
      expect(state().inventoryAtoms).toBe(atoms((1 - index) * 500));
    }
    expect(confirmed).toBe(5 + sells.length);
  },
  120000,
);
