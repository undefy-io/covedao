import { afterAll, beforeAll, expect, test } from "vitest";
import * as p from "./index.ts";
import type { Ledger, Offer, Plan } from "./types.js";
import { checkGardenCompliance } from "./test-support/compliance.ts";
import {
  Core,
  aliceAddress,
  aliceKey,
  aliceScript,
  bobScript,
  protocolScript,
} from "./test-support/core.ts";

const core = new Core();
const atoms = 100000000000n;
const config = {
  network: "regtest",
  ticker: "SAFE",
  vaultScriptHex: aliceScript,
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
};
beforeAll(() => core.start());
afterAll(() => core.stop());

function mine(ledger: Ledger, count = 1): Ledger {
  for (const hash of core.mine(count)) ledger = p.applyBlock(ledger, core.block(hash));
  return ledger;
}
function confirm(ledger: Ledger, plan: Plan, wallets: ("alice" | "bob")[] = ["alice"]) {
  const rawHex = core.sign(plan, wallets);
  expect(p.validateFinalTransaction(plan, { rawHex, prevouts: plan.inputs })).toBeTruthy();
  expect(core.accepted(rawHex).allowed).toBe(true);
  const txid = core.broadcast(rawHex);
  const next = mine(ledger);
  const transaction = core.transaction(txid);
  const action = plan.markerJson.includes('"op":"deploy"')
    ? "deploy"
    : plan.markerJson.includes('"op":"mint"')
      ? "mint"
      : plan.markerVout === 1
        ? "marketBuy"
        : plan.outputs[1]?.role === "vault"
          ? "curveSell"
          : "transfer";
  expect(checkGardenCompliance(plan, transaction, action).sharedWirePassed).toBe(true);
  return { ledger: next, txid };
}
function setup() {
  let ledger = p.emptyLedger(config);
  const deployed = confirm(
    ledger,
    p.buildDeploy({ config, funding: [core.funding("alice")], changeScriptHex: aliceScript }),
  );
  ledger = deployed.ledger;
  ledger = confirm(
    ledger,
    p.buildMint({
      state: ledger.assets[deployed.txid]!,
      amountAtoms: atoms,
      funding: [core.funding("alice")],
      recipientScriptHex: aliceScript,
    }),
  ).ledger;
  return { ledger, deployTxid: deployed.txid };
}
function token(ledger: Ledger, owner = aliceScript) {
  const [point, allocation] = Object.entries(ledger.allocations).find(
    ([, value]) => value.scriptHex === owner,
  )!;
  const [txid, vout] = point.split(":");
  return { txid: txid!, vout: Number(vout), ...allocation };
}
async function register(
  ledger: Ledger,
  input = token(ledger),
  expiryHeight = ledger.tip!.height + 1,
) {
  const offer = await p.authorizeOffer(
    {
      network: "regtest",
      deployTxid: input.deployTxid,
      ticker: "SAFE",
      listedInput: input,
      sellerScriptHex: aliceScript,
      priceSats: 12347n,
      expiryHeight,
    },
    aliceKey.privateKey!,
  );
  return { ledger: await p.registerOffer(ledger, offer), offer };
}
function purchase(offer: Offer, currentHeight: number) {
  return {
    offer,
    currentHeight,
    buyerFunding: [core.funding("bob")],
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
  };
}

test.each([0, 2])(
  "purchase confirmed %i blocks after expiry still pays and allocates tokens",
  async (delay) => {
    const start = setup();
    const registered = await register(start.ledger);
    const { offer } = registered;
    let { ledger } = registered;
    const plan = p.buildPurchase(purchase(offer, ledger.tip!.height));
    const signed = core.sign(plan, ["bob"]);
    expect(
      p.validateFinalTransaction(plan, { rawHex: signed, prevouts: plan.inputs }),
    ).toBeTruthy();
    expect(core.accepted(signed).allowed).toBe(true);
    const txid = core.broadcast(signed);
    // Explicitly mine empty blocks while the signed purchase remains in the mempool.
    if (delay) {
      ledger = p.markOfferUnavailable(ledger, p.offerId(offer));
      for (let n = 0; n < delay; n++) {
        const { hash } = core.rpc("generateblock", [aliceAddress, []]);
        ledger = p.applyBlock(ledger, core.block(hash));
        expect(core.rpc("getrawmempool")).toContain(txid);
      }
    }
    ledger = mine(ledger);
    expect(ledger.tip!.height).toBe(offer.expiryHeight + delay);
    const actual = core.transaction(txid);
    expect(checkGardenCompliance(plan, actual, "marketBuy").sharedWirePassed).toBe(true);
    expect(p.parseRawTransaction(actual.rawHex).outputs[0]).toEqual({
      sats: 13347n,
      scriptHex: aliceScript,
    });
    expect(token(ledger, bobScript).atoms).toBe(atoms);
    expect(ledger.offers[p.offerId(offer)]!.status).toBe("filled");
  },
);

test("new signed-offer purchases require height and reject expired or unavailable offers", async () => {
  const { ledger, offer } = await register(setup().ledger);
  const args = purchase(offer, ledger.tip!.height);
  expect(() => p.buildPurchase(args)).not.toThrow();
  for (const currentHeight of [offer.expiryHeight, offer.expiryHeight + 1, -1, 1.5, NaN])
    expect(() => p.buildPurchase({ ...args, currentHeight })).toThrow();
  expect(() => p.buildPurchase({ ...args, currentHeight: undefined })).toThrow();
  for (const status of ["cancelPending", "cancelled", "filled"] as const)
    expect(() => p.buildPurchase({ ...args, offer: { ...offer, status } })).toThrow();
});

test.each([
  { amount: atoms, recipient: bobScript, expired: false },
  { amount: atoms / 2n, recipient: bobScript, expired: false },
  { amount: 1n, recipient: aliceScript, expired: true },
])(
  "owner transfer $amount, expired=$expired preserves allocation and retires listing",
  async ({ amount, recipient, expired }) => {
    const start = setup();
    const unlisted = start.ledger;
    const registered = await register(unlisted);
    const { offer } = registered;
    let { ledger } = registered;
    if (expired) ledger = mine(ledger, 1);
    const before = ledger;
    const plan = p.buildTransfer({
      ...config,
      deployTxid: start.deployTxid,
      input: token(ledger),
      amountAtoms: amount,
      recipientScriptHex: recipient,
      funding: [core.funding("alice")],
    });
    const oldFill = core.sign(p.buildPurchase(purchase(offer, unlisted.tip!.height)), ["bob"]);
    const result = confirm(ledger, plan);
    ledger = result.ledger;
    const block = core.block(ledger.tip!.hash);
    const withoutOffer = p.applyBlock({ ...before, offers: {} }, block);
    expect(ledger.allocations).toEqual(withoutOffer.allocations);
    expect(ledger.offers[p.offerId(offer)]!.status).toBe("cancelled");
    expect(ledger.allocations[`${result.txid}:1`]!.atoms).toBe(amount);
    if (amount < atoms) expect(ledger.allocations[`${result.txid}:2`]!.atoms).toBe(atoms - amount);
    expect(core.accepted(oldFill).allowed).toBe(false);
    const restored = p.rollbackBlock(ledger, ledger.tip!.hash);
    expect(restored).toEqual(before);
    expect(p.applyBlock(restored, block)).toEqual(ledger);
  },
);

test("one owner transfer can consume multiple registered token outputs", async () => {
  const start = setup();
  let ledger = confirm(
    start.ledger,
    p.buildTransfer({
      ...config,
      deployTxid: start.deployTxid,
      input: token(start.ledger),
      amountAtoms: atoms / 2n,
      recipientScriptHex: aliceScript,
      funding: [core.funding("alice")],
    }),
  ).ledger;
  const inputs = Object.entries(ledger.allocations).map(([point, allocation]) => {
    const [txid, vout] = point.split(":");
    return { txid: txid!, vout: Number(vout), ...allocation };
  });
  const offers: Offer[] = [];
  for (const input of inputs) {
    const registered = await register(ledger, input);
    ledger = registered.ledger;
    offers.push(registered.offer);
  }
  ledger = mine(ledger);
  const result = confirm(
    ledger,
    p.buildTransfer({
      ...config,
      deployTxid: start.deployTxid,
      inputs,
      amountAtoms: 60000000000n,
      recipientScriptHex: bobScript,
      funding: [core.funding("alice")],
    }),
  );
  expect(token(result.ledger, bobScript).atoms).toBe(60000000000n);
  expect(token(result.ledger).atoms).toBe(40000000000n);
  for (const offer of offers)
    expect(result.ledger.offers[p.offerId(offer)]!.status).toBe("cancelled");
});

test("curve sale of a listed carrier retires its offer", async () => {
  const start = setup();
  const { ledger, offer } = await register(start.ledger);
  const result = confirm(
    ledger,
    p.buildSell({
      state: ledger.assets[start.deployTxid]!,
      inputs: [token(ledger)],
      amountAtoms: atoms,
      recipientScriptHex: aliceScript,
      funding: [core.funding("alice")],
    }),
  );
  expect(result.ledger.offers[p.offerId(offer)]!.status).toBe("cancelled");
  expect(result.ledger.assets[start.deployTxid]!.inventoryAtoms).toBe(atoms);
});
