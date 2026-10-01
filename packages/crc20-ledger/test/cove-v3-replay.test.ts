import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { applyCoveConfirmed, createCoveLedger, type CoveObservation } from "../src/cove-replay.js";
import { applyRegisteredCoveDeploy, validateCoveOperation } from "../src/cove.js";

const script = (digit: string) => `5120${digit.repeat(64)}`;
const vault = script("1"), creator = script("2"), protocol = script("3"), seller = script("4"), buyer = script("5");
const zero = "00".repeat(32);
type Output = { valueSats: number; scriptHex: string };
const marker = (payload: object): Output => ({ valueSats: 0, scriptHex: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload))]).toString("hex") });
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
  return { network: "signet", rawHex: transaction.rawHex, parentRawHexes: parents.map((p) => p.rawHex),
    blockHash: "ab".repeat(32), blockTxids: [...Array(index).fill(zero), transaction.txid], height: 100, index };
}
function setup() {
  const funding = fund(10_000);
  const deploy = tx([{ rawHex: funding.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", lim: "2100000000000000", leaf: "0", ordi: "0", btc: "1" }),
    { valueSats: 330, scriptHex: vault }, { valueSats: 1_000, scriptHex: creator }, { valueSats: 7_000, scriptHex: protocol },
    { valueSats: 1_670, scriptHex: seller },
  ]);
  const registration = { network: "signet" as const, txid: deploy.txid, vaultScriptHex: vault,
    creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330 };
  const deployed = applyCoveConfirmed(createCoveLedger(), observe(deploy, [funding], 0), [registration]);
  const payment = fund(10_000);
  const mint = tx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: "mint", tick: "COVE" }), { valueSats: 330, scriptHex: seller },
    { valueSats: 357, scriptHex: vault }, { valueSats: 5_013, scriptHex: protocol },
    { valueSats: 546, scriptHex: creator }, { valueSats: 3_084, scriptHex: seller },
  ]);
  const minted = applyCoveConfirmed(deployed.state, observe(mint, [deploy, payment], 1), [registration]);
  return { deploy, mint, deployed, minted, registration };
}

describe("Garden-shaped Cove v3 ledger replay", () => {
  it("accepts an exact amountless mint and infers its allocation from the reserve delta", () => {
    const { deploy, mint, deployed, minted } = setup();
    expect(deployed.status, deployed.reason).toBe("applied");
    expect(minted.status, minted.reason).toBe("applied");
    expect(minted.state.assets[`signet:${deploy.txid}`]).toMatchObject({ protocolVersion: 3,
      tokenUtxos: { [`${mint.txid}:1`]: { scriptHex: seller, atoms: "100000000000" } },
      balances: { [seller]: "100000000000" } });
  });

  it("rejects a mint reserve delta with no exact legal quote", () => {
    const { deploy, deployed, registration } = setup();
    const payment = fund(10_000);
    const forged = tx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "mint", tick: "COVE" }), { valueSats: 330, scriptHex: seller },
      { valueSats: 358, scriptHex: vault }, { valueSats: 5_013, scriptHex: protocol },
      { valueSats: 546, scriptHex: creator }, { valueSats: 3_083, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(deployed.state, observe(forged, [deploy, payment], 1), [registration]);
    expect(result.status).toBe("broken");
  });

  it("rejects a ticker-only theft from unrelated ordinary UTXO", () => {
    const { deploy, minted, registration } = setup();
    const unrelated = fund(1_000, seller);
    const theft = tx([{ rawHex: unrelated.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 500, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(theft, [unrelated], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]?.balances[seller]).toBe("100000000000");
  });

  it("routes duplicate tickers by the spent token outpoint", () => {
    const { deploy, mint, minted, registration } = setup();
    const other = fund(330, script("6"));
    const first = minted.state.assets[`signet:${deploy.txid}`]!;
    const duplicateId = `signet:${"ee".repeat(32)}`;
    const duplicate = { ...first, vaultScriptHex: script("6"), tokenUtxos: {}, burnedAtoms: "0",
      curve: { ...first.curve, mintedAtoms: 0n, circulatingAtoms: 0n, vaultAtoms: 0n,
        vaultAnchorSats: 330n, vaultSats: 330n, vaultOutpoint: `${other.txid}:0` },
      balances: { [script("6")]: "0" } };
    const state = { ...minted.state, assets: { ...minted.state.assets, [duplicateId]: duplicate } };
    const transfer = tx([{ rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(state, observe(transfer, [mint], 2), [registration]);
    expect(result.status, result.reason).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${transfer.txid}:1`]?.atoms).toBe("100000000000");
    expect(result.state.assets[duplicateId]).toEqual(duplicate);
  });

  it("accepts ordinary funding inputs but rejects a mixed token asset", () => {
    const { deploy, mint, minted, registration } = setup();
    const extra = fund(1_000, buyer);
    const transfer = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: extra.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 900, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(transfer, [mint, extra], 2), [registration]);
    expect(result.status, result.reason).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${transfer.txid}:1`]?.atoms).toBe("100000000000");
  });

  it("rejects forged mint fees despite an exact backing delta", () => {
    const { deploy, deployed, registration } = setup();
    const payment = fund(10_000);
    const forged = tx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "mint", tick: "COVE" }), { valueSats: 330, scriptHex: seller },
      { valueSats: 357, scriptHex: vault }, { valueSats: 5_014, scriptHex: protocol },
      { valueSats: 546, scriptHex: creator }, { valueSats: 3_083, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(deployed.state, observe(forged, [deploy, payment], 1), [registration]);
    expect(result.status).toBe("broken");
  });

  it("requires a transfer rather than an amountless mint when vault inventory exists", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(10_000);
    const sell = tx([{ rawHex: mint.rawHex, vout: 2 }, { rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: vault }, { valueSats: 660, scriptHex: seller },
      { valueSats: 1_000, scriptHex: protocol }, { valueSats: 8_697, scriptHex: seller },
    ]);
    const sold = applyCoveConfirmed(minted.state, observe(sell, [mint, mint, payment], 2), [registration]);
    expect(sold.status, sold.reason).toBe("applied");
    const newPayment = fund(10_000);
    const wrongMint = tx([{ rawHex: sell.rawHex, vout: 1 }, { rawHex: newPayment.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "mint", tick: "COVE" }), { valueSats: 330, scriptHex: buyer },
      { valueSats: 357, scriptHex: vault }, { valueSats: 5_013, scriptHex: protocol },
      { valueSats: 546, scriptHex: creator }, { valueSats: 3_084, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(sold.state, observe(wrongMint, [sell, newPayment], 3), [registration]);
    expect(result.status).toBe("broken");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${wrongMint.txid}:1`]).toBeUndefined();
  });

  it("rejects a transaction that combines token outputs from two assets", () => {
    const { deploy, mint, minted, registration } = setup();
    const otherVault = fund(357, script("6"));
    const otherToken = fund(330, seller);
    const secondId = `signet:${"ee".repeat(32)}`;
    const original = minted.state.assets[`signet:${deploy.txid}`]!;
    const second = { ...original, vaultScriptHex: script("6"),
      curve: { ...original.curve, vaultOutpoint: `${otherVault.txid}:0` },
      tokenUtxos: { [`${otherToken.txid}:0`]: { scriptHex: seller, atoms: "100000000000" } },
      balances: { [seller]: "100000000000", [script("6")]: "0" } };
    const state = { ...minted.state, assets: { ...minted.state.assets, [secondId]: second } };
    const mixed = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: otherToken.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 330, scriptHex: seller },
    ]);
    const result = applyCoveConfirmed(state, observe(mixed, [mint, otherToken], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]?.burnedAtoms).toBe("100000000000");
    expect(result.state.assets[secondId]?.burnedAtoms).toBe("100000000000");
  });

  it("rejects a ticker mismatch even when the correct token outpoint is spent", () => {
    const { deploy, mint, minted, registration } = setup();
    const wrong = tx([{ rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "OTHER", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(wrong, [mint], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state.assets[`signet:${deploy.txid}`]?.burnedAtoms).toBe("100000000000");
  });

  it("replays an alternate confirmed branch from the prior snapshot without retaining orphan allocations", () => {
    const { deploy, mint, minted, registration } = setup();
    const first = tx([{ rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer },
    ]);
    const second = tx([{ rawHex: mint.rawHex, vout: 1 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: script("6") },
    ]);
    const orphan = applyCoveConfirmed(minted.state, observe(first, [mint], 2), [registration]);
    const canonical = applyCoveConfirmed(minted.state, observe(second, [mint], 2), [registration]);
    expect(orphan.status).toBe("applied");
    expect(canonical.status).toBe("applied");
    expect(canonical.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${first.txid}:1`]).toBeUndefined();
    expect(canonical.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${second.txid}:1`]?.atoms).toBe("100000000000");
    expect(applyCoveConfirmed(canonical.state, observe(first, [mint], 3), [registration]).status).toBe("invalid");
  });

  it("credits a Garden-layout sale only when the listed token input is spent", () => {
    const { deploy, mint, minted, registration } = setup();
    const payment = fund(10_000, buyer);
    const sale = tx([{ rawHex: mint.rawHex, vout: 1 }, { rawHex: payment.rawHex, vout: 0 }], [
      { valueSats: 5_000, scriptHex: seller }, marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }),
      { valueSats: 330, scriptHex: buyer }, { valueSats: 1_000, scriptHex: protocol },
      { valueSats: 2_000, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observe(sale, [mint, payment], 2), [registration]);
    expect(result.status, result.reason).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]?.tokenUtxos?.[`${sale.txid}:2`]).toEqual({ scriptHex: buyer, atoms: "100000000000" });
  });

  it("accepts only three mint fields and four transfer fields", () => {
    const asset = { txid: "aa".repeat(32), ticker: "COVE" };
    expect(validateCoveOperation([marker({ p: "crc-20", op: "mint", tick: "COVE" }), { valueSats: 330, scriptHex: buyer }], asset)).toMatchObject({ status: "valid", kind: "mint", inferredAmount: true });
    expect(validateCoveOperation([marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000" }), { valueSats: 330, scriptHex: buyer }], asset).status).toBe("invalid");
    expect(validateCoveOperation([marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" }), { valueSats: 330, scriptHex: buyer }], asset)).toMatchObject({ status: "valid", kind: "transfer" });
    expect(validateCoveOperation([marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: asset.txid, v: 2 }), { valueSats: 330, scriptHex: buyer }], asset).status).toBe("invalid");
  });

  it("rejects a deploy marker with different payment fields", () => {
    const { deploy, registration } = setup();
    const old = [
      marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", lim: "2100000000000000", leaf: "0", ordi: "0", btc: "2" }),
      { valueSats: 330, scriptHex: vault }, { valueSats: 1_000, scriptHex: creator }, { valueSats: 7_000, scriptHex: protocol },
    ];
    expect(applyRegisteredCoveDeploy({ network: "signet", txid: deploy.txid, outputs: old }, [registration]).status).toBe("invalid");
  });
});
