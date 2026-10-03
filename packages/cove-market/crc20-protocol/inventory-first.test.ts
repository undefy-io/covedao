import { expect, test } from "vitest";
import * as core from "./index.js";
import type { Asset } from "./types.js";
const atoms = (tokens: number) => BigInt(tokens) * core.atomsPerToken;
const script = "0014" + "11".repeat(20),
  recipient = "0014" + "22".repeat(20);
const funding = [{ txid: "cc".repeat(32), vout: 0, sats: 100000n, scriptHex: script }];
function state(issued: number, inventory: number): Asset {
  return {
    config: {
      network: "regtest",
      ticker: "TEST",
      vaultScriptHex: script,
      creatorScriptHex: script,
      protocolScriptHex: script,
    },
    deployTxid: "aa".repeat(32),
    issuedAtoms: atoms(issued),
    inventoryAtoms: atoms(inventory),
    burnedAtoms: 0n,
    vault: {
      txid: "bb".repeat(32),
      vout: 2,
      scriptHex: script,
      sats: 1000n + core.backingSats(atoms(issued - inventory)),
    },
  };
}

for (const [issued, inventory, requested, reused, minted, gross, platform] of [
  [0, 0, 400, 0, 400, 11, 5005],
  [400, 0, 100, 0, 100, 3, 5002],
  [400, 400, 100, 100, 0, 3, 5002],
  [400, 400, 400, 400, 0, 11, 5005],
  [400, 400, 500, 400, 100, 14, 5007],
  [400, 400, 1000, 400, 600, 27, 5013],
  [1000, 400, 1000, 400, 600, 27, 5013],
  [1000, 1000, 400, 400, 0, 11, 5005],
  [99500, 400, 1500, 400, 1100, 57, 5020],
] as const) {
  test(`one ${requested}-token buy with ${inventory} inventory and ${issued} issued delivers the entire amount`, () => {
    const asset = state(issued, inventory),
      before = structuredClone(asset);
    expect(core.curveBuyAmounts(asset, atoms(requested))).toEqual({
      inventoryBuyAtoms: atoms(reused),
      newlyMintedAtoms: atoms(minted),
    });
    expect(core.quoteBuy(asset, atoms(requested))).toEqual({
      grossSats: BigInt(gross),
      protocolFeeSats: BigInt(platform),
      creatorFeeSats: 546n,
    });
    const plan = core.buildBuy({
      state: asset,
      funding,
      amountAtoms: atoms(requested),
      recipientScriptHex: recipient,
    });
    expect(plan.transactions).toHaveLength(1);
    expect(
      core.decodeProtocolDto<core.Plan>(JSON.parse(JSON.stringify(core.encodeProtocolDto(plan)))),
    ).toEqual(plan);
    expect(plan.outputs[1]).toMatchObject({
      atoms: atoms(requested),
      sats: 1000n,
      scriptHex: recipient,
    });
    expect(plan.outputs[2]!.sats).toBe(core.sats(asset.vault.sats) + BigInt(gross));
    expect(plan.protocolFeeSats).toBe(BigInt(platform));
    expect(plan.creatorFeeSats).toBe(546n);
    expect(plan.outputs.filter((o) => o.role === "protocolFee")).toHaveLength(1);
    expect(plan.outputs.filter((o) => o.role === "creatorFee")).toHaveLength(1);
    expect(plan.outputs.filter((o) => o.atoms !== undefined)).toHaveLength(1);
    expect(plan.markerJson).toBe(
      minted
        ? '{"p":"crc-20","op":"mint","tick":"TEST"}'
        : core.transferMarker("TEST", atoms(requested)),
    );
    expect(plan.inputs.reduce((n, i) => n + core.sats(i.sats), 0n)).toBe(
      plan.outputs.reduce((n, o) => n + o.sats, plan.minerFeeSats),
    );
    expect(asset).toEqual(before);
    if (reused && minted)
      expect(plan).toMatchObject({
        inventoryBuyAtoms: atoms(reused),
        newlyMintedAtoms: atoms(minted),
      });
  });
}

test("mixed purchases reach the issuance cap exactly; existing inventory remains buyable at the cap", () => {
  const cap = 21000000;
  const exact = state(cap - 100, 400);
  expect(core.curveBuyAmounts(exact, atoms(500))).toEqual({
    inventoryBuyAtoms: atoms(400),
    newlyMintedAtoms: atoms(100),
  });
  expect(() =>
    core.buildBuy({
      state: exact,
      funding: [{ ...funding[0]!, sats: 1000000000n }],
      amountAtoms: atoms(500),
      recipientScriptHex: recipient,
    }),
  ).not.toThrow();
  expect(() => core.quoteBuy(exact, atoms(600))).toThrow(/cap|supply/i);
  const full = state(cap, 400);
  expect(core.curveBuyAmounts(full, atoms(400))).toEqual({
    inventoryBuyAtoms: atoms(400),
    newlyMintedAtoms: 0n,
  });
  expect(() => core.quoteBuy(full, atoms(500))).toThrow(/cap|supply/i);
});

test("unified buys reject invalid increments, funding and vault state before signing", () => {
  for (const amount of [0n, -1n, 1n, atoms(50), atoms(150)]) {
    expect(() =>
      core.buildBuy({
        state: state(400, 400),
        funding,
        amountAtoms: amount,
        recipientScriptHex: recipient,
      }),
    ).toThrow();
  }
  const args = {
    state: state(400, 400),
    funding,
    amountAtoms: atoms(1000),
    recipientScriptHex: recipient,
  };
  expect(() => core.buildBuy({ ...args, funding: [] })).toThrow(/funding|insufficient/i);
  expect(() =>
    core.buildBuy({ ...args, funding: [{ ...funding[0]!, atoms: atoms(100) }] }),
  ).toThrow(/token/i);
  expect(() => core.buildBuy({ ...args, minerFeeSats: 20001n })).toThrow(/fee/i);
  expect(() =>
    core.buildBuy({
      ...args,
      state: { ...args.state, vault: { ...args.state.vault, sats: 1001n } },
    }),
  ).toThrow(/backing/i);
  expect(() =>
    core.curveBuyAmounts({ issuedAtoms: atoms(400), inventoryAtoms: atoms(500) }, atoms(100)),
  ).toThrow(/inventory|state/i);
});
