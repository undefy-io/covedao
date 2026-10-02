import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";

const native = `0014${"11".repeat(20)}`;
const nested = bitcoin.payments
  .p2sh({ redeem: { output: Buffer.from(native, "hex") } })
  .output!.toString("hex");
const taproot = `5120${"ab".repeat(32)}`;

test("API network normalization has one core identity, without merging Bitcoin chains", () => {
  expect(core.protocolNetwork("mainnet")).toBe("bitcoin");
  for (const network of ["bitcoin", "signet", "testnet", "regtest"] as const)
    expect(core.protocolNetwork(network)).toBe(network);
  for (const network of ["", "testnet4", "Signet", "mutinynet", " bitcoin", "legacy"])
    expect(() => core.protocolNetwork(network)).toThrow(/network/i);
});

test("registration identity binds the chain and canonical deployment txid, never just ticker", () => {
  const txid = "ab".repeat(32);
  expect(core.deploymentIdentity("mainnet", txid)).toBe(`bitcoin:${txid}`);
  expect(core.deploymentIdentity("signet", txid)).not.toBe(
    core.deploymentIdentity("testnet", txid),
  );
  for (const invalid of ["", "TEST", "a".repeat(63), txid.toUpperCase(), `${txid}:1`])
    expect(() => core.deploymentIdentity("signet", invalid)).toThrow(/deployment/i);
});

test("single target economics retain small curve trades and arbitrary market atoms", () => {
  expect(core.curveStepAtoms).toBe(10000000000n);
  expect(core.carrierSats).toBe(1000n);
  expect(core.launchFeeSats).toBe(7000n);
  expect(core.maxMinerFeeSats).toBe(20000n);
  expect(core.quoteBuy({ issuedAtoms: 0n, inventoryAtoms: 0n }, 50000000000n)).toEqual({
    grossSats: 14n,
    protocolFeeSats: 5007n,
    creatorFeeSats: 546n,
  });
  expect(core.marketFee(12347n)).toBe(1000n);
  expect(
    core.buildListing({
      network: "regtest",
      ticker: "TEST",
      deployTxid: "a".repeat(64),
      input: { txid: "b".repeat(64), vout: 0, sats: 1000n, scriptHex: native, atoms: 2n },
      funding: [{ txid: "c".repeat(64), vout: 0, sats: 5000n, scriptHex: native }],
      amountAtoms: 1n,
      priceSats: 12347n,
      sellerScriptHex: native,
      changeScriptHex: native,
    }).listedAtoms,
  ).toBe(1n);
});

test("identify required frontend scripts without treating Taproot as native custody", () => {
  expect(core.walletScriptKind(native)).toBe("p2wpkh");
  expect(core.walletScriptKind(nested, native)).toBe("p2sh-p2wpkh");
  expect(core.walletScriptKind(taproot)).toBe("p2tr");
  for (const script of ["6a", "51", "76a914" + "11".repeat(20) + "88ac", taproot.toUpperCase()])
    expect(() => core.walletScriptKind(script)).toThrow(/script/i);
});

test("builders reject unsupported funding before returning a plan for a wallet prompt", () => {
  for (const scriptHex of [nested, "51"])
    expect(() =>
      core.buildDeploy({
        config: {
          network: "regtest",
          ticker: "TEST",
          vaultScriptHex: native,
          creatorScriptHex: native,
          protocolScriptHex: native,
        },
        funding: [{ txid: "b".repeat(64), vout: 0, sats: 30000n, scriptHex }],
        changeScriptHex: native,
      }),
    ).toThrow(/unsupported input script/i);
});

test("P2SH classification requires proof of the nested witness program", () => {
  for (const redeem of [undefined, "51", `0014${"22".repeat(20)}`, `0020${"33".repeat(32)}`])
    expect(() => core.walletScriptKind(nested, redeem)).toThrow(/redeem script/i);
});

test("supported native, proven nested, and Taproot funding return exact deploy plans", () => {
  for (const input of [
    { scriptHex: native },
    { scriptHex: nested, redeemScriptHex: native },
    { scriptHex: taproot },
  ]) {
    const plan = core.buildDeploy({
      config: {
        network: "regtest",
        ticker: "TEST",
        vaultScriptHex: native,
        creatorScriptHex: native,
        protocolScriptHex: native,
      },
      funding: [{ txid: "b".repeat(64), vout: 0, sats: 30000n, ...input }],
      changeScriptHex: native,
    });
    expect(plan.minerFeeSats).toBe(1000n);
    expect(plan.outputs.reduce((sum, output) => sum + output.sats, 0n)).toBe(29000n);
  }
});

test("listing preparation refuses sellers without reusable-offer signing support", () => {
  for (const input of [{ scriptHex: taproot }, { scriptHex: nested, redeemScriptHex: native }])
    expect(() =>
      core.buildListing({
        network: "regtest",
        ticker: "TEST",
        deployTxid: "a".repeat(64),
        input: { txid: "b".repeat(64), vout: 0, sats: 1000n, atoms: 2n, ...input },
        funding: [{ txid: "c".repeat(64), vout: 0, sats: 5000n, scriptHex: native }],
        amountAtoms: 1n,
        priceSats: 12347n,
        sellerScriptHex: input.scriptHex,
        changeScriptHex: native,
      }),
    ).toThrow(/unsupported seller signing script/i);
});
