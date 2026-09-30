import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { applyCoveConfirmed, createCoveLedger, type CoveObservation } from "../src/cove-replay.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const vault = script("1");
const creator = script("2");
const protocol = script("3");
const buyer = script("4");
const otherBuyer = script("5");
const ZERO = "00".repeat(32);
type Output = { valueSats: number; scriptHex: string };

function marker(payload: object): Output {
  return { valueSats: 0, scriptHex: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload))]).toString("hex") };
}
function makeTx(parents: readonly { rawHex: string; vout: number }[], outputs: readonly Output[]) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  if (!parents.length) tx.addInput(Buffer.from(ZERO, "hex"), 0xffffffff);
  for (const parent of parents) {
    tx.addInput(Buffer.from(bitcoin.Transaction.fromHex(parent.rawHex).getId(), "hex").reverse(), parent.vout);
  }
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return { rawHex: tx.toHex(), txid: tx.getId(), outputs };
}
function fund(valueSats: number, owner: string) {
  return makeTx([], [{ valueSats, scriptHex: owner }]);
}
function observation(tx: ReturnType<typeof makeTx>, parents: readonly { rawHex: string }[], index: number): CoveObservation {
  return { network: "signet", rawHex: tx.rawHex, parentRawHexes: parents.map((p) => p.rawHex), blockHash: "ab".repeat(32), blockTxids: [...Array(index).fill(ZERO), tx.txid], height: 100, index };
}
function launch() {
  const funding = fund(10_000, buyer);
  const tx = makeTx([{ rawHex: funding.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }),
    { valueSats: 330, scriptHex: vault },
    { valueSats: 1_000, scriptHex: creator },
    { valueSats: 7_000, scriptHex: protocol },
    { valueSats: 1_670, scriptHex: buyer },
  ]);
  const registration = { network: "signet" as const, txid: tx.txid, vaultScriptHex: vault, creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330 };
  return { tx, funding, registration };
}
function buy(parentVault: ReturnType<typeof makeTx>, vaultVout: number, id: string, owner = buyer, operation: "mint" | "transfer" = "mint") {
  const funding = fund(10_000, owner);
  const tx = makeTx([{ rawHex: parentVault.rawHex, vout: vaultVout }, { rawHex: funding.rawHex, vout: 0 }], [
    marker({ p: "crc-20", op: operation, tick: "COVE", amt: "100000000000", id }),
    { valueSats: 330, scriptHex: owner },
    { valueSats: 357, scriptHex: vault },
    { valueSats: 5_013, scriptHex: protocol },
    { valueSats: 546, scriptHex: creator },
    { valueSats: 3_084, scriptHex: owner },
  ]);
  return { tx, funding };
}

describe("confirmed Cove replay from raw transactions", () => {
  it("ignores unregistered deployments, then activates only the exact registered raw tx", () => {
    const { tx, funding, registration } = launch();
    const initial = createCoveLedger();
    expect(applyCoveConfirmed(initial, observation(tx, [funding], 0), []).status).toBe("ignored");
    const result = applyCoveConfirmed(initial, observation(tx, [funding], 0), [registration]);
    expect(result.status).toBe("applied");
    expect(result.state.assets[`signet:${tx.txid}`]).toMatchObject({ ticker: "COVE", status: "live", balances: { [vault]: "0" } });
  });

  it("mints the exact amount with full backing and fees, then rejects a competing vault spend", () => {
    const { tx: deploy, funding, registration } = launch();
    const deployed = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const { tx, funding: buyerFund } = buy(deploy, 1, deploy.txid);
    const result = applyCoveConfirmed(deployed.state, observation(tx, [deploy, buyerFund], 1), [registration]);
    expect(result.status).toBe("applied");
    expect(result.state.assets[`signet:${deploy.txid}`]).toMatchObject({ balances: { [buyer]: "100000000000" }, curve: { mintedAtoms: 100000000000n, vaultSats: 357n, vaultOutpoint: `${tx.txid}:2` } });
    expect(applyCoveConfirmed(result.state, observation(tx, [deploy, buyerFund], 2), [registration]).status).toBe("invalid");
  });

  it("marks an asset unavailable when a confirmed vault spend redirects a fee", () => {
    const { tx: deploy, funding, registration } = launch();
    const deployed = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const { tx, funding: buyerFund } = buy(deploy, 1, deploy.txid);
    const badOutputs = tx.outputs.map((output, index) => index === 3 ? { ...output, valueSats: 5_012 } : output);
    const bad = makeTx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: buyerFund.rawHex, vout: 0 }], badOutputs);
    const result = applyCoveConfirmed(deployed.state, observation(bad, [deploy, buyerFund], 1), [registration]);
    expect(result.status).toBe("broken");
    expect(result.state.assets[`signet:${deploy.txid}`]?.status).toBe("broken");
    expect(result.state.assets[`signet:${deploy.txid}`]?.balances[buyer]).toBeUndefined();
  });

  it("rejects a spoofed parent raw transaction instead of trusting a claimed sender", () => {
    const { tx: deploy, funding, registration } = launch();
    const deployed = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const { tx } = buy(deploy, 1, deploy.txid);
    const forgedParent = fund(10_000, otherBuyer);
    const result = applyCoveConfirmed(deployed.state, observation(tx, [deploy, forgedParent], 1), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state).toBe(deployed.state);
  });

  it("rejects a transaction whose raw txid is absent from its claimed block position", () => {
    const { tx, funding, registration } = launch();
    const forged = { ...observation(tx, [funding], 0), blockTxids: ["ff".repeat(32)] };
    expect(applyCoveConfirmed(createCoveLedger(), forged, [registration])).toMatchObject({ status: "invalid", state: createCoveLedger() });
  });

  it("sells to vault inventory, then transfers that inventory to another buyer", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const firstBuy = buy(deploy, 1, deploy.txid);
    const minted = applyCoveConfirmed(registered.state, observation(firstBuy.tx, [deploy, firstBuy.funding], 1), [registration]);
    const sellerFund = fund(10_000, buyer);
    const sale = makeTx([{ rawHex: firstBuy.tx.rawHex, vout: 2 }, { rawHex: sellerFund.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid }),
      { valueSats: 330, scriptHex: vault },
      { valueSats: 330, scriptHex: buyer },
      { valueSats: 1_000, scriptHex: protocol },
      { valueSats: 7_697, scriptHex: buyer },
    ]);
    const sold = applyCoveConfirmed(minted.state, observation(sale, [firstBuy.tx, sellerFund], 2), [registration]);
    expect(sold.status).toBe("applied");
    expect(sold.state.assets[`signet:${deploy.txid}`]).toMatchObject({ balances: { [buyer]: "0", [vault]: "100000000000" }, curve: { mintedAtoms: 100000000000n, vaultAtoms: 100000000000n, circulatingAtoms: 0n } });
    const secondBuy = buy(sale, 1, deploy.txid, otherBuyer, "transfer");
    const resold = applyCoveConfirmed(sold.state, observation(secondBuy.tx, [sale, secondBuy.funding], 3), [registration]);
    expect(resold.status).toBe("applied");
    expect(resold.state.assets[`signet:${deploy.txid}`]).toMatchObject({ balances: { [otherBuyer]: "100000000000", [vault]: "0" }, curve: { mintedAtoms: 100000000000n, vaultAtoms: 0n } });
  });

  it("replays a two-address wallet sale with token input separate from BTC payout and change", () => {
    const payment = script("6");
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const buyerFund = fund(10_000, payment);
    const buy = makeTx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: buyerFund.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000", id: deploy.txid }),
      { valueSats: 330, scriptHex: buyer },
      { valueSats: 357, scriptHex: vault },
      { valueSats: 5_013, scriptHex: protocol },
      { valueSats: 546, scriptHex: creator },
      { valueSats: 3_084, scriptHex: payment },
    ]);
    const minted = applyCoveConfirmed(registered.state, observation(buy, [deploy, buyerFund], 1), [registration]);
    expect(minted.status).toBe("applied");
    const ordinalFund = fund(10_000, buyer);
    const paymentFund = fund(10_001, payment);
    const sell = makeTx([{ rawHex: buy.rawHex, vout: 2 }, { rawHex: ordinalFund.rawHex, vout: 0 }, { rawHex: paymentFund.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid }),
      { valueSats: 330, scriptHex: vault },
      { valueSats: 330, scriptHex: payment },
      { valueSats: 1_000, scriptHex: protocol },
      { valueSats: 17_698, scriptHex: payment },
    ]);
    const sold = applyCoveConfirmed(minted.state, observation(sell, [buy, ordinalFund, paymentFund], 2), [registration]);
    expect(sold.status).toBe("applied");
    expect(sold.state.assets[`signet:${deploy.txid}`]).toMatchObject({ balances: { [buyer]: "0", [vault]: "100000000000" } });
  });

  it("derives peer-transfer sender from input zero and rejects token overspend", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const firstBuy = buy(deploy, 1, deploy.txid);
    const minted = applyCoveConfirmed(registered.state, observation(firstBuy.tx, [deploy, firstBuy.funding], 1), [registration]);
    const senderFund = fund(10_000, buyer);
    const transfer = makeTx([{ rawHex: senderFund.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid }),
      { valueSats: 330, scriptHex: otherBuyer },
      { valueSats: 8_670, scriptHex: buyer },
    ]);
    const sent = applyCoveConfirmed(minted.state, observation(transfer, [senderFund], 2), [registration]);
    expect(sent.status).toBe("applied");
    expect(sent.state.assets[`signet:${deploy.txid}`]?.balances).toMatchObject({ [buyer]: "0", [otherBuyer]: "100000000000" });
    const nextFund = fund(10_001, buyer);
    const overspend = makeTx([{ rawHex: nextFund.rawHex, vout: 0 }], transfer.outputs);
    const rejected = applyCoveConfirmed(sent.state, observation(overspend, [nextFund], 3), [registration]);
    expect(rejected.status).toBe("invalid");
    expect(rejected.state).toBe(sent.state);
  });

  it("rejects a peer transfer into the vault that would bypass reserve accounting", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const firstBuy = buy(deploy, 1, deploy.txid);
    const minted = applyCoveConfirmed(registered.state, observation(firstBuy.tx, [deploy, firstBuy.funding], 1), [registration]);
    const senderFund = fund(10_001, buyer);
    const transfer = makeTx([{ rawHex: senderFund.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid }),
      { valueSats: 330, scriptHex: vault },
      { valueSats: 8_671, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(minted.state, observation(transfer, [senderFund], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state).toBe(minted.state);
  });

  it("breaks the asset on a vault spend with no CRC marker or a forged mint amount", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const escape = makeTx([{ rawHex: deploy.rawHex, vout: 1 }], [{ valueSats: 330, scriptHex: buyer }]);
    expect(applyCoveConfirmed(registered.state, observation(escape, [deploy], 1), [registration])).toMatchObject({ status: "broken", state: { assets: { [`signet:${deploy.txid}`]: { status: "broken" } } } });
    const firstBuy = buy(deploy, 1, deploy.txid);
    const forgedOutputs = firstBuy.tx.outputs.map((output, index) => index === 0
      ? marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "200000000000", id: deploy.txid })
      : output);
    const forged = makeTx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: firstBuy.funding.rawHex, vout: 0 }], forgedOutputs);
    expect(applyCoveConfirmed(registered.state, observation(forged, [deploy, firstBuy.funding], 1), [registration]).status).toBe("broken");
  });

  it("marks every affected asset unavailable when one transaction spends two live vaults", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const otherVault = fund(330, otherBuyer);
    const firstKey = `signet:${deploy.txid}`;
    const secondKey = `signet:${otherVault.txid}`;
    const first = registered.state.assets[firstKey]!;
    const twoAssets = {
      ...registered.state,
      assets: {
        ...registered.state.assets,
        [secondKey]: { ...first, ticker: "OTHER", vaultScriptHex: otherBuyer, curve: { ...first.curve, vaultOutpoint: `${otherVault.txid}:0` } },
      },
    };
    const escape = makeTx([{ rawHex: deploy.rawHex, vout: 1 }, { rawHex: otherVault.rawHex, vout: 0 }], [{ valueSats: 330, scriptHex: buyer }]);
    const result = applyCoveConfirmed(twoAssets, observation(escape, [deploy, otherVault], 1), [registration]);
    expect(result.status).toBe("broken");
    expect(result.state.assets[firstKey]?.status).toBe("broken");
    expect(result.state.assets[secondKey]?.status).toBe("broken");
  });

  it("replays three buys and three sells without losing tokens or backing", () => {
    const { tx: deploy, funding, registration } = launch();
    const assetId = `signet:${deploy.txid}`;
    let state = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]).state;
    let vaultParent = deploy;
    let vaultVout = 1;
    let index = 1;
    for (let n = 0; n < 3; n++) {
      const curve = state.assets[assetId]!.curve;
      const quote = quoteBuy(curve, 1_000n);
      const wallet = fund(10_000 + n, buyer);
      const nextVaultSats = Number(curve.vaultSats + quote.grossSats);
      const changeSats = Number(curve.vaultSats) + 10_000 + n -
        (330 + nextVaultSats + Number(quote.protocolFeeSats) + Number(quote.creatorFeeSats)) - 1_000;
      const tx = makeTx([{ rawHex: vaultParent.rawHex, vout: vaultVout }, { rawHex: wallet.rawHex, vout: 0 }], [
        marker({ p: "crc-20", op: "mint", tick: "COVE", amt: "100000000000", id: deploy.txid }),
        { valueSats: 330, scriptHex: buyer },
        { valueSats: nextVaultSats, scriptHex: vault },
        { valueSats: Number(quote.protocolFeeSats), scriptHex: protocol },
        { valueSats: Number(quote.creatorFeeSats), scriptHex: creator },
        { valueSats: changeSats, scriptHex: buyer },
      ]);
      const result = applyCoveConfirmed(state, observation(tx, [vaultParent, wallet], index++), [registration]);
      expect(result.status).toBe("applied");
      state = result.state;
      vaultParent = tx;
      vaultVout = 2;
    }
    for (let n = 0; n < 3; n++) {
      const curve = state.assets[assetId]!.curve;
      const quote = quoteSell(curve, 1_000n);
      const wallet = fund(10_100 + n, buyer);
      const nextVaultSats = Number(curve.vaultSats - quote.grossSats);
      const changeSats = Number(curve.vaultSats) + 10_100 + n -
        (nextVaultSats + Number(quote.sellerPayoutSats) + Number(quote.protocolFeeSats)) - 1_000;
      const tx = makeTx([{ rawHex: vaultParent.rawHex, vout: vaultVout }, { rawHex: wallet.rawHex, vout: 0 }], [
        marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: deploy.txid }),
        { valueSats: nextVaultSats, scriptHex: vault },
        { valueSats: Number(quote.sellerPayoutSats), scriptHex: buyer },
        { valueSats: Number(quote.protocolFeeSats), scriptHex: protocol },
        { valueSats: changeSats, scriptHex: buyer },
      ]);
      const result = applyCoveConfirmed(state, observation(tx, [vaultParent, wallet], index++), [registration]);
      expect(result.status).toBe("applied");
      state = result.state;
      vaultParent = tx;
      vaultVout = 1;
    }
    expect(state.assets[assetId]).toMatchObject({
      balances: { [buyer]: "0", [vault]: "300000000000" },
      curve: { mintedAtoms: 300000000000n, vaultAtoms: 300000000000n, circulatingAtoms: 0n, vaultSats: 330n },
    });
  });

  it("refuses a loaded ledger whose script balances exceed lifetime minted supply", () => {
    const { tx: deploy, funding, registration } = launch();
    const registered = applyCoveConfirmed(createCoveLedger(), observation(deploy, [funding], 0), [registration]);
    const firstBuy = buy(deploy, 1, deploy.txid);
    const minted = applyCoveConfirmed(registered.state, observation(firstBuy.tx, [deploy, firstBuy.funding], 1), [registration]);
    const id = `signet:${deploy.txid}`;
    const asset = minted.state.assets[id]!;
    const corrupted = { ...minted.state, assets: { ...minted.state.assets, [id]: { ...asset, balances: { ...asset.balances, [buyer]: "100000000001" } } } };
    const wallet = fund(10_000, buyer);
    const transfer = makeTx([{ rawHex: wallet.rawHex, vout: 0 }], [
      marker({ p: "crc-20", op: "transfer", tick: "COVE", amt: "1", id: deploy.txid }),
      { valueSats: 330, scriptHex: otherBuyer },
      { valueSats: 8_670, scriptHex: buyer },
    ]);
    const result = applyCoveConfirmed(corrupted, observation(transfer, [wallet], 2), [registration]);
    expect(result.status).toBe("invalid");
    expect(result.state).toBe(corrupted);
  });
});
