import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { applyCoveConfirmed, createCoveLedger, type CoveObservation } from "../src/cove-replay.js";
import { validateCoveOperation } from "../src/cove.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1");
const creator = script("2");
const protocol = script("3");
const seller = script("4");
const buyer = script("5");
const zero = "00".repeat(32);
type Output = { valueSats: number; scriptHex: string };

function marker(payload: object): Output {
  return { valueSats: 0, scriptHex: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload))]).toString("hex") };
}
function tx(parents: readonly { rawHex: string; vout: number }[], outputs: readonly Output[]) {
  const transaction = new bitcoin.Transaction();
  transaction.version = 2;
  if (!parents.length) transaction.addInput(Buffer.from(zero, "hex"), 0xffffffff);
  for (const parent of parents) transaction.addInput(Buffer.from(bitcoin.Transaction.fromHex(parent.rawHex).getId(), "hex").reverse(), parent.vout);
  for (const output of outputs) transaction.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { rawHex: transaction.toHex(), txid: transaction.getId() };
}
const fund = (sats: number, owner = seller) => tx([], [{ valueSats: sats, scriptHex: owner }]);
function observe(transaction: ReturnType<typeof tx>, parents: readonly { rawHex: string }[], index: number): CoveObservation {
  return { network: "signet", rawHex: transaction.rawHex, parentRawHexes: parents.map((parent) => parent.rawHex),
    blockHash: "ab".repeat(32), blockTxids: [...Array(index).fill(zero), transaction.txid], height: 100, index };
}
function setup() {
  const funding = fund(10_000);
  const deploy = tx([{ rawHex: funding.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v2" }),
    { valueSats: 330, scriptHex: vault }, { valueSats: 1_000, scriptHex: creator },
    { valueSats: 7_000, scriptHex: protocol }, { valueSats: 1_670, scriptHex: seller },
  ]);
  const registration = { network: "signet" as const, txid: deploy.txid, vaultScriptHex: vault,
    creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330 };
  const deployed = applyCoveConfirmed(createCoveLedger(), observe(deploy, [funding], 0), [registration]);
  const payment = fund(10_000);
  const mint = tx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
    { valueSats: 330, scriptHex: seller }, { valueSats: 357, scriptHex: vault },
    { valueSats: 5_013, scriptHex: protocol }, { valueSats: 546, scriptHex: creator },
    { valueSats: 3_084, scriptHex: seller },
  ]);
  const minted = applyCoveConfirmed(deployed.state, observe(mint, [deploy, payment], 1), [registration]);
  return { deploy, mint, deployed, minted, registration };
}

describe("Cove v2 outpoint authority", () => {
  it("rejects a marker whose encoded payload exceeds 256 bytes", () => {
    const id = "aa".repeat(32);
    const base = { p: "crc-20", op: "transfer", tick: "COVE", amt: "", id, v: 2 };
    const amount = "1".repeat(257 - Buffer.byteLength(JSON.stringify(base)));
    const outputs = [marker({ ...base, amt: amount }), { valueSats: 330, scriptHex: buyer }];
    expect(Buffer.from(outputs[0]!.scriptHex, "hex").length).toBe(261);
    expect(validateCoveOperation(outputs, { txid: id, ticker: "COVE" }, 2)).toMatchObject({
      status: "invalid", reason: "Cove marker exceeds 256-byte payload limit",
    });
  });

  it("mints a token allocation at the exact buyer output", () => {
    const { deploy, mint, deployed, minted } = setup();
    expect(deployed.status).toBe("applied");
    expect(minted.status).toBe("applied");
    expect(minted.state.assets[`signet:${deploy.txid}`]).toMatchObject({
      protocolVersion: 2,
      tokenUtxos: { [`${mint.txid}:1`]: { scriptHex: seller, atoms: "100000000000" } },
      balances: { [seller]: "100000000000" },
    });
  });

  it("does not let an unrelated UTXO at the same script move tokens", () => {
    const { deploy, minted, registration } = setup();
    const unrelated = fund(10_000, seller);
    const theft = tx([{ rawHex: unrelated.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 8_670, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(theft, [unrelated], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]?.balances[seller]).toBe("100000000000");
  });

  it("requires the token-bearing input and places partial remainder at the declared output", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(1_000);
    const split = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "40000000000", id: deploy.txid, v: 2, ch: 2 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 330, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(split, [mint, payment], 2), [registration]);
    expect(result.status).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos).toMatchObject({
      [`${split.txid}:1`]: { scriptHex: buyer, atoms: "40000000000" },
      [`${split.txid}:2`]: { scriptHex: seller, atoms: "60000000000" },
    });
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${mint.txid}:1`]).toBeUndefined();
  });

  it("burns a token allocation when its Bitcoin output is spent without a marker", () => {
    const { deploy, mint, minted, registration } = setup();
    const burn = tx([{ rawHex: mint.rawHex, vout: 1 }], [{ valueSats: 330, scriptHex: seller }]);
    const result = applyCoveConfirmed(minted.state, observe(burn, [mint], 2), [registration]);
    expect(result.state.assets[`signet:${deploy.txid}`]).toMatchObject({
      burnedAtoms: "100000000000", balances: { [seller]: "0" }, tokenUtxos: {},
    });
  });

  it("burns a token input when a malformed v2 marker would otherwise credit a buyer", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(10_000, buyer);
    const malformed = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 1 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 5_000, scriptHex: seller },
      { valueSats: 1_000, scriptHex: protocol }, { valueSats: 2_000, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(malformed, [mint, payment], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]).toMatchObject({
      burnedAtoms: "100000000000", balances: { [seller]: "0" },
    });
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${malformed.txid}:1`]).toBeUndefined();
  });

  it("rejects a hidden token coin after an ordinary BTC funding input", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(1_000);
    const malformed = tx([{ rawHex: payment.rawHex, vout: 0 }, { rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 330, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(malformed, [payment, mint], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]?.burnedAtoms).toBe("100000000000");
  });

  it("breaks another asset vault consumed as funding while burning the listed token coin", () => {
    const { deploy, mint, minted, registration } = setup();
    const otherVaultScript = script("6");
    const otherVault = fund(330, otherVaultScript);
    const first = minted.state.assets[`signet:${deploy.txid}`]!;
    for (const version of [1, 2] as const) {
      const otherId = `signet:${(version === 1 ? "dd" : "ee").repeat(32)}`;
      const other = { ...first, ticker: "OTHER", status: "live" as const,
        vaultScriptHex: otherVaultScript,
        curve: { ...first.curve, vaultOutpoint: `${otherVault.txid}:0`, vaultSats: 330n,
          mintedAtoms: 0n, vaultAtoms: 0n, circulatingAtoms: 0n },
        balances: { [otherVaultScript]: "0" },
        ...(version === 1 ? { protocolVersion: 1 as const, tokenUtxos: undefined, burnedAtoms: undefined }
          : { protocolVersion: 2 as const, tokenUtxos: {}, burnedAtoms: "0" }),
      };
      const state = { ...minted.state, assets: { ...minted.state.assets, [otherId]: other } };
      const spend = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: otherVault.rawHex, vout: 0 }], [
        marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
        { valueSats: 330, scriptHex: buyer },
      ]);
      const result = applyCoveConfirmed(state, observe(spend, [mint, otherVault], 2), [registration]);
      expect(result.status).toBe("broken");
      expect(result.state.assets[otherId]?.status).toBe("broken");
      expect(result.state.assets[`signet:${deploy.txid}`]?.burnedAtoms).toBe("100000000000");
    }
  });

  it("credits an exact market fill that spends the listed token outpoint with its BTC payment", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(10_000, script("6"));
    const sale = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 5_000, scriptHex: seller },
      { valueSats: 1_000, scriptHex: protocol }, { valueSats: 2_000, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(sale, [mint, payment], 2), [registration]);
    expect(result.status).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos).toMatchObject({
      [`${sale.txid}:1`]: { scriptHex: buyer, atoms: "100000000000" },
    });
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${mint.txid}:1`]).toBeUndefined();
  });

  it("sells the exact token outpoint into vault inventory and buys that inventory", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(10_000);
    const sale = tx([{ rawHex: mint.rawHex, vout: 2 }, { rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: vault }, { valueSats: 330, scriptHex: seller },
      { valueSats: 1_000, scriptHex: protocol }, { valueSats: 8_027, scriptHex: seller },
    ]);
    const sold = applyCoveConfirmed(minted.state, observe(sale, [mint, mint, payment], 2), [registration]);
    expect(sold.status).toBe("applied");
    expect(sold.state.assets[`signet:${deploy.txid}`]?.tokenUtxos).toMatchObject({
      [`${sale.txid}:1`]: { scriptHex: vault, atoms: "100000000000" },
    });
    const buyerFunding = fund(10_000, buyer);
    const inventoryBuy = tx([{ rawHex: sale.rawHex, vout: 1 }, { rawHex: buyerFunding.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 357, scriptHex: vault },
      { valueSats: 5_013, scriptHex: protocol }, { valueSats: 546, scriptHex: creator },
      { valueSats: 3_084, scriptHex: buyer },
    ]);
    const bought = applyCoveConfirmed(sold.state, observe(inventoryBuy, [sale, buyerFunding], 3), [registration]);
    expect(bought.status).toBe("applied");
    expect(bought.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${inventoryBuy.txid}:1`]).toEqual({ scriptHex: buyer, atoms: "100000000000" });
    expect(bought.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${sale.txid}:1`]).toBeUndefined();
  });

  it("keeps circulating token transfers valid after an unrelated vault break", () => {
    const { deploy, mint, minted, registration } = setup();
    const vaultBreak = tx([{ rawHex: mint.rawHex, vout: 2 }], [{ valueSats: 357, scriptHex: seller }]);
    const broken = applyCoveConfirmed(minted.state, observe(vaultBreak, [mint], 2), [registration]);
    expect(broken.state.assets[`signet:${deploy.txid}`]?.status).toBe("broken");
    const transfer = tx([{ rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid, v: 2 }),
      { valueSats: 330, scriptHex: buyer },
    ]);
    const moved = applyCoveConfirmed(broken.state, observe(transfer, [mint], 3), [registration]);
    expect(moved.status).toBe("applied");
    expect(moved.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${transfer.txid}:1`]).toEqual({ scriptHex: buyer, atoms: "100000000000" });
  });
});
