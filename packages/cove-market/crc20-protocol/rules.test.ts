import { test, expect } from "vitest";
const api = () => import("./index.ts");
const alice = "0014" + "11".repeat(20);
const bob = "0014" + "22".repeat(20);
const vault = "0014" + "33".repeat(20);
const fee = "0014" + "44".repeat(20);
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: vault,
  creatorScriptHex: alice,
  protocolScriptHex: fee,
};
const funding = [{ txid: "c".repeat(64), vout: 0, sats: 100000n, scriptHex: alice }];
const token = {
  txid: "b".repeat(64),
  vout: 1,
  atoms: 200000000000n,
  sats: 1000n,
  scriptHex: alice,
};
const state = {
  config,
  deployTxid: "a".repeat(64),
  issuedAtoms: 200000000000n,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: { txid: "d".repeat(64), vout: 2, sats: 1054n, scriptHex: vault },
};

test.each(["0", "-1", "1.5", "1e3", "01", "+1", "", " 1", "1 ", "0x10"])(
  "reject noncanonical positive atom input %j",
  async (value) => {
    const { parseAtoms } = await api();
    expect(() => parseAtoms(value)).toThrow();
  },
);

test.each(["1", "123456789", "200000000000", "9007199254740993"])(
  "preserve exact atom input %s",
  async (value) => {
    const { parseAtoms } = await api();
    expect(parseAtoms(value)).toBe(BigInt(value));
  },
);

test("independent curve and fee vectors, boundaries, and economic top-up", async () => {
  const { backingSats, quoteBuy, quoteSell, marketFee, launchFeeSats } = await api();
  expect(launchFeeSats).toBe(7000n);
  expect(backingSats(0n)).toBe(0n);
  expect(backingSats(200000000000n)).toBe(54n);
  expect(backingSats(10000000000000n)).toBe(2700n);
  expect(backingSats(10100000000000n)).toBe(2754n);
  expect(backingSats(2100000000000000n)).toBe(59818500n);
  expect(quoteBuy({ ...state, issuedAtoms: 0n }, 200000000000n)).toMatchObject({
    grossSats: 54n,
    protocolFeeSats: 5025n,
    creatorFeeSats: 546n,
  });
  expect(quoteSell(state, 100000000000n)).toMatchObject({
    grossSats: 27n,
    protocolFeeSats: 1000n,
    creatorFeeSats: 0n,
    economicSats: -973n,
  });
  expect(marketFee(12347n)).toBe(1000n);
  expect(marketFee(20001n)).toBe(1501n);
  for (const amount of [0n, -1n, 1n, 5000000000n]) {
    expect(() => quoteBuy(state, amount)).toThrow();
    expect(() => quoteSell(state, amount)).toThrow();
  }
  expect(() => backingSats(-1n)).toThrow();
  expect(() => quoteBuy({ ...state, issuedAtoms: 2100000000000000n }, 100000000000n)).toThrow();
  expect(() => quoteSell(state, 300000000000n)).toThrow();
  expect(() => quoteBuy({ ...state, inventoryAtoms: 100000000000n }, 200000000000n)).toThrow(
    /split|inventory/i,
  );
});

test.each([1n, 123456789n, 50000000000n, 200000000000n])(
  "transfer/listing arbitrary amount %s with exact separate change",
  async (amountAtoms) => {
    const { buildTransfer, buildListing } = await api();
    for (const build of [buildTransfer, buildListing]) {
      const plan = build({
        network: "regtest",
        deployTxid: state.deployTxid,
        ticker: "TEST",
        input: token,
        funding,
        amountAtoms,
        priceSats: 12347n,
        sellerScriptHex: alice,
        recipientScriptHex: bob,
        changeScriptHex: alice,
        minerFeeSats: 1000n,
      });
      expect(plan.transactions).toHaveLength(1);
      expect(plan.changeAtoms).toBe(token.atoms - amountAtoms);
      expect(plan.outputs[plan.recipientVout]).toMatchObject({ sats: 1000n, atoms: amountAtoms });
      expect(plan.outputs.filter((o: any) => o.role === "tokenChange")).toHaveLength(
        amountAtoms === token.atoms ? 0 : 1,
      );
      expect(plan.outputs.filter((o: any) => o.role === "btcChange")).toHaveLength(1);
      expect(plan.protocolFeeSats).toBe(0n);
      expect(plan.creatorFeeSats).toBe(0n);
      expect(plan.minerFeeSats).toBe(1000n);
    }
  },
);

test("multiple token inputs and invalid ownership/amount/recipient/funding", async () => {
  const { buildTransfer } = await api();
  const args = {
    network: "regtest",
    deployTxid: state.deployTxid,
    ticker: "TEST",
    inputs: [token, { ...token, txid: "e".repeat(64) }],
    funding,
    amountAtoms: 300000000000n,
    recipientScriptHex: bob,
    changeScriptHex: alice,
    minerFeeSats: 1000n,
  };
  expect(buildTransfer(args).changeAtoms).toBe(100000000000n);
  for (const extra of [
    { amountAtoms: 0n },
    { amountAtoms: -1n },
    { amountAtoms: 400000000001n },
    { recipientScriptHex: "" },
    { recipientScriptHex: "6a00" },
    { funding: [], minerFeeSats: 20000n },
    { minerFeeSats: 20001n },
    { inputs: [] },
    { inputs: [token, token] },
  ]) {
    expect(() => buildTransfer({ ...args, ...extra })).toThrow();
  }
});

test("deploy/mint/sell/inventory outputs pin every satoshi and fee destination", async () => {
  const { buildDeploy, buildMint, buildSell, buildInventoryBuy } = await api();
  const deploy = buildDeploy({ config, funding, changeScriptHex: alice, minerFeeSats: 1000n });
  expect(deploy.markerJson).toBe(
    '{"p":"crc-20","op":"deploy","tick":"TEST","type":"bonding","max":"21000000","lim":"21000000","leaf":"0","ordi":"0","btc":"1"}',
  );
  expect(deploy.outputs.map((o: any) => o.sats)).toEqual([0n, 1000n, 1000n, 7000n, 90000n]);
  const mint = buildMint({
    state: { ...state, issuedAtoms: 0n, vault: { ...state.vault, sats: 1000n } },
    funding,
    recipientScriptHex: bob,
    changeScriptHex: alice,
    amountAtoms: 200000000000n,
    minerFeeSats: 1000n,
  });
  expect(mint.markerJson).toBe('{"p":"crc-20","op":"mint","tick":"TEST"}');
  expect(mint.outputs.map((o: any) => o.sats)).toEqual([0n, 1000n, 1054n, 5025n, 546n, 92375n]);
  expect(mint.outputs[3].scriptHex).toBe(fee);
  expect(mint.outputs[4].scriptHex).toBe(alice);
  const sell = buildSell({
    state,
    inputs: [token],
    funding,
    recipientScriptHex: alice,
    changeScriptHex: alice,
    amountAtoms: 100000000000n,
    minerFeeSats: 1000n,
  });
  expect(sell.outputs[1]).toMatchObject({ scriptHex: vault, sats: 1027n, atoms: 100000000000n });
  expect(sell.outputs[2]).toMatchObject({ scriptHex: alice, sats: 1000n });
  expect(sell.outputs.find((o: any) => o.role === "tokenChange")!.atoms).toBe(100000000000n);
  expect(sell.outputs.find((o: any) => o.role === "protocolFee")!.sats).toBe(1000n);
  expect(sell.walletTopUpSats).toBeGreaterThan(0n);
  expect(() =>
    buildSell({
      state: { ...state, vault: { ...state.vault, sats: 1000n } },
      inputs: [token],
      funding,
      recipientScriptHex: alice,
      changeScriptHex: alice,
      amountAtoms: 100000000000n,
    }),
  ).toThrow();
  const buy = buildInventoryBuy({
    state: { ...state, inventoryAtoms: 100000000000n, vault: { ...state.vault, sats: 1027n } },
    funding,
    recipientScriptHex: bob,
    changeScriptHex: alice,
    amountAtoms: 100000000000n,
    minerFeeSats: 1000n,
  });
  expect(buy.markerJson).toBe('{"p":"crc-20","op":"transfer","tick":"TEST","amt":"100000000000"}');
  expect(buy.outputs.map((o: any) => o.sats)).toEqual([0n, 1000n, 1054n, 5013n, 546n, 92414n]);
  expect(() =>
    buildMint({
      state: { ...state, inventoryAtoms: 100000000000n },
      funding,
      recipientScriptHex: bob,
      amountAtoms: 100000000000n,
    }),
  ).toThrow();
});

test("wire rejects duplicate markers, malformed amount, extra fields, nonzero marker, and missing/unspendable recipient", async () => {
  const { decodeTransaction, markerScript } = await api();
  const marker = '{"p":"crc-20","op":"transfer","tick":"TEST","amt":"1"}';
  const out = { vout: 0, value_sats: 0, script_hex: markerScript(marker) };
  const next = { vout: 1, value_sats: 1000, script_hex: bob };
  expect(decodeTransaction([out, next]).amountAtoms).toBe(1n);
  for (const outputs of [
    [out],
    [out, { ...next, script_hex: "6a00" }],
    [out, next, { ...out, vout: 2 }],
    [{ ...out, value_sats: 1 }, next],
    [{ ...out, script_hex: markerScript(marker.replace('"1"', '"1e3"')) }, next],
    [{ ...out, script_hex: markerScript(marker.replace('"amt":"1"', '"amt":"1","cv":3')) }, next],
  ]) {
    expect(() => decodeTransaction(outputs)).toThrow();
  }
});
