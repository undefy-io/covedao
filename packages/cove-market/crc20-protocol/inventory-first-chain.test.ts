import { afterAll, beforeAll, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import * as core from "./index.js";
import { Core, aliceKey, aliceScript, bobScript, protocolScript } from "./test-support/core.js";
import { authorizeOffer } from "./test-support/signing.js";
import { checkGardenCompliance } from "./test-support/compliance.js";
const chain = new Core();
const atoms = (n: number) => BigInt(n) * core.atomsPerToken;
const config: core.Config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
};
const evidence: unknown[] = [];
beforeAll(() => chain.start());
afterAll(() => {
  try {
    writeFileSync(
      new URL("./inventory-first-chain-evidence.json", import.meta.url),
      JSON.stringify(
        evidence,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ) + "\n",
    );
  } finally {
    chain.stop();
  }
});
function journey() {
  let ledger = core.emptyLedger(config),
    deployTxid = "";
  const blocks: { block: core.Block; options: core.ConfirmedBlockOptions }[] = [];
  const state = () => ledger.assets[deployTxid]!;
  const balance = (script: string) =>
    Object.values(ledger.allocations)
      .filter((a) => a.scriptHex === script)
      .reduce((n, a) => n + a.atoms, 0n);
  const funding = (wallet: "alice" | "bob") => [
    chain.funding(
      wallet,
      new Set([
        ...Object.keys(ledger.allocations),
        ...(deployTxid ? [core.outpoint(state().vault)] : []),
      ]),
    ),
  ];
  const owned = (script: string) =>
    Object.entries(ledger.allocations)
      .filter(([, a]) => a.scriptHex === script)
      .map(([point, a]) => {
        const [txid, vout] = point.split(":");
        return { ...a, txid: txid!, vout: Number(vout) };
      });
  async function confirm(
    plan: core.Plan,
    wallets: ("alice" | "bob")[],
    options: core.ConfirmedBlockOptions = {},
  ) {
    const rawHex = chain.sign(plan, wallets),
      transaction = { rawHex, prevouts: plan.inputs };
    expect(core.validateFinalTransaction(plan, transaction, ledger)).toBe(
      core.parseRawTransaction(rawHex).txid,
    );
    expect(chain.accepted(rawHex).allowed).toBe(true);
    const txid = chain.broadcast(rawHex),
      [hash] = chain.mine(),
      block = chain.block(hash);
    expect(block.transactions).toHaveLength(1);
    expect(core.validateFinalTransaction(plan, block.transactions[0]!, ledger)).toBe(txid);
    expect(core.parseRawTransaction(rawHex).outputs.map((o) => o.sats)).toEqual(
      plan.outputs.map((o) => o.sats),
    );
    expect(
      plan.inputs.reduce((n, i) => n + core.sats(i.sats), 0n) -
        plan.outputs.reduce((n, o) => n + o.sats, 0n),
    ).toBe(1000n);
    const marker = JSON.parse(plan.markerJson);
    const report = checkGardenCompliance(
      plan,
      block.transactions[0]!,
      plan.markerVout === 1
        ? "marketBuy"
        : marker.op === "deploy"
          ? "deploy"
          : marker.op === "mint"
            ? "mint"
            : plan.outputs[1]!.role === "vault"
              ? "curveSell"
              : marker.op === "transfer" &&
                  plan.inputs[0]!.scriptHex === aliceScript &&
                  deployTxid &&
                  core.outpoint(plan.inputs[0]!) === core.outpoint(state().vault)
                ? "inventoryBuy"
                : "transfer",
    );
    const selected = { registeredDeployments: { [txid]: config }, ...options };
    const detailed = core.applyConfirmedBlockDetailed(ledger, block, selected);
    ledger = detailed.ledger;
    if (!deployTxid) deployTxid = txid;
    blocks.push({ block, options: selected });
    expect(
      balance(aliceScript) + balance(bobScript) + state().inventoryAtoms + state().burnedAtoms,
    ).toBe(state().issuedAtoms);
    expect(state().vault.sats).toBe(
      1000n + core.backingSats(state().issuedAtoms - state().inventoryAtoms),
    );
    evidence.push({
      txid,
      marker,
      events: detailed.events,
      state: state(),
      allocations: ledger.allocations,
      report,
    });
    return { txid, block, events: detailed.events };
  }
  const deploy = () =>
    confirm(core.buildDeploy({ config, funding: funding("alice"), changeScriptHex: aliceScript }), [
      "alice",
    ]);
  const buy = (amount: number, wallet: "alice" | "bob") =>
    confirm(
      core.buildBuy({
        state: state(),
        funding: funding(wallet),
        amountAtoms: atoms(amount),
        recipientScriptHex: wallet === "alice" ? aliceScript : bobScript,
      }),
      wallet === "alice" ? ["alice"] : ["alice", "bob"],
    );
  const sell = (amount: number, wallet: "alice" | "bob") =>
    confirm(
      core.buildSell({
        state: state(),
        inputs: owned(wallet === "alice" ? aliceScript : bobScript),
        funding: funding(wallet),
        amountAtoms: atoms(amount),
        recipientScriptHex: wallet === "alice" ? aliceScript : bobScript,
      }),
      wallet === "alice" ? ["alice"] : ["alice", "bob"],
    );
  return {
    state,
    balance,
    funding,
    owned,
    confirm,
    deploy,
    buy,
    sell,
    blocks,
    get ledger() {
      return ledger;
    },
    set ledger(next: core.Ledger) {
      ledger = next;
    },
  };
}

test("buy400 -> sell400 -> buy1000 settles one full purchase, then repeat and partial trades remain seamless", async () => {
  const j = journey();
  await j.deploy();
  await j.buy(400, "alice");
  await j.sell(400, "alice");
  expect(j.state()).toMatchObject({ issuedAtoms: atoms(400), inventoryAtoms: atoms(400) });
  const before = structuredClone(j.ledger),
    mixed = await j.buy(1000, "bob");
  expect(j.balance(bobScript)).toBe(atoms(1000));
  expect(j.balance(aliceScript)).toBe(0n);
  expect(j.state()).toMatchObject({
    issuedAtoms: atoms(1000),
    inventoryAtoms: 0n,
    vault: { sats: 1027n },
  });
  expect(mixed.events[0]).toMatchObject({
    valid: true,
    amountAtoms: atoms(1000),
    inventoryBuyAtoms: atoms(400),
    newlyMintedAtoms: atoms(600),
  });
  expect(core.rollbackBlock(j.ledger, mixed.block.hash)).toEqual(before);
  await j.buy(100, "bob");
  expect(j.balance(bobScript)).toBe(atoms(1100));
  await j.sell(100, "bob");
  await j.buy(500, "bob");
  expect(j.state()).toMatchObject({ issuedAtoms: atoms(1500), inventoryAtoms: 0n });
  expect(j.balance(bobScript)).toBe(atoms(1500));
  await j.sell(1500, "bob");
  for (const amount of [100, 400, 1000]) await j.buy(amount, "alice");
  expect(j.state()).toMatchObject({ issuedAtoms: atoms(1500), inventoryAtoms: 0n });
  expect(j.balance(aliceScript)).toBe(atoms(1500));
  expect(j.balance(bobScript)).toBe(0n);
  let replay = core.emptyLedger(config);
  for (const { block, options } of j.blocks)
    replay = core.applyConfirmedBlock(replay, block, options);
  expect(replay).toEqual(j.ledger);
});

test("buy400 -> list300 -> buyer-only purchase retains100 and transfers exactly300", async () => {
  const j = journey();
  await j.deploy();
  await j.buy(400, "alice");
  const listed = await j.confirm(
    core.buildListing({
      network: "regtest",
      deployTxid: j.state().deployTxid,
      ticker: "TEST",
      input: j.owned(aliceScript)[0]!,
      funding: j.funding("alice"),
      amountAtoms: atoms(300),
      sellerScriptHex: aliceScript,
      recipientScriptHex: aliceScript,
      changeScriptHex: aliceScript,
      priceSats: 5000n,
    }),
    ["alice"],
  );
  expect(j.balance(aliceScript)).toBe(atoms(400));
  expect(j.ledger.allocations[`${listed.txid}:1`]!.atoms).toBe(atoms(300));
  expect(j.ledger.allocations[`${listed.txid}:2`]!.atoms).toBe(atoms(100));
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: j.state().deployTxid,
      ticker: "TEST",
      listedInput: { ...j.ledger.allocations[`${listed.txid}:1`]!, txid: listed.txid, vout: 1 },
      sellerScriptHex: aliceScript,
      priceSats: 5000n,
      expiryHeight: j.ledger.tip!.height + 10,
    },
    aliceKey.privateKey!,
  );
  j.ledger = await core.registerOffer(j.ledger, offer);
  const purchase = core.buildPurchase({
    offer,
    currentHeight: j.ledger.tip!.height,
    buyerFunding: j.funding("bob"),
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
    minerFeeSats: 1000n,
  });
  const before = structuredClone(j.ledger),
    filled = await j.confirm(purchase, ["bob"], { authorizations: [offer] });
  expect(j.balance(aliceScript)).toBe(atoms(100));
  expect(j.balance(bobScript)).toBe(atoms(300));
  expect(j.state()).toMatchObject({ issuedAtoms: atoms(400), inventoryAtoms: 0n });
  expect(j.ledger.offers[core.offerId(offer)]!.status).toBe("filled");
  expect(core.rollbackBlock(j.ledger, filled.block.hash)).toEqual(before);
});

test("competing mixed purchases have one confirmed winner and rollback permits a replacement at the same height", async () => {
  const j = journey();
  await j.deploy();
  await j.buy(400, "alice");
  await j.sell(400, "alice");
  const before = structuredClone(j.ledger);
  const first = core.buildBuy({
    state: j.state(),
    funding: j.funding("alice"),
    amountAtoms: atoms(1000),
    recipientScriptHex: aliceScript,
  });
  const second = core.buildBuy({
    state: j.state(),
    funding: j.funding("bob"),
    amountAtoms: atoms(500),
    recipientScriptHex: bobScript,
  });
  const losing = chain.sign(second, ["alice", "bob"]);
  const winner = await j.confirm(first, ["alice"]);
  expect(chain.accepted(losing).allowed).toBe(false);
  expect(() =>
    core.validateFinalTransaction(second, { rawHex: losing, prevouts: second.inputs }, j.ledger),
  ).toThrow();
  chain.rpc("invalidateblock", [winner.block.hash]);
  chain.clearOrphanMempool();
  j.ledger = core.rollbackBlock(j.ledger, winner.block.hash);
  expect(j.ledger).toEqual(before);
  expect(chain.accepted(losing).allowed).toBe(true);
  const replacement = await j.confirm(second, ["alice", "bob"]);
  expect(replacement.block.height).toBe(winner.block.height);
  expect(replacement.block.hash).not.toBe(winner.block.hash);
  expect(j.balance(aliceScript)).toBe(0n);
  expect(j.balance(bobScript)).toBe(atoms(500));
  expect(j.state()).toMatchObject({ issuedAtoms: atoms(500), inventoryAtoms: 0n });
});
