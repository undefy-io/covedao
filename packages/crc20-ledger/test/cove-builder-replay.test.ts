import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { buildCurveBuy, buildCurveDeploy, buildCurveSell, buildUnsignedPsbt, type TxTemplate } from "@crclaunch/crc20-transactions";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { applyCoveConfirmed, createCoveLedger, type CoveObservation } from "../src/cove-replay.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const wallet = `0014${"11".repeat(20)}`;
const vault = script("2");
const creator = script("3");
const protocol = script("4");
const scripts = { buyer: wallet, seller: wallet, vault, creator, protocol };

function funding(valueSats: number): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32), 0xffffffff);
  tx.addOutput(Buffer.from(wallet, "hex"), valueSats);
  return tx;
}

function funded(template: TxTemplate, inputs: readonly { tx: bitcoin.Transaction; vout: number }[]): bitcoin.Transaction {
  const tx = template.tx.clone();
  for (const { tx: parent, vout } of inputs) tx.addInput(Buffer.from(parent.getId(), "hex").reverse(), vout);
  return tx;
}

function observed(tx: bitcoin.Transaction, parents: readonly bitcoin.Transaction[], txids: readonly string[], index: number): CoveObservation {
  return {
    network: "regtest", rawHex: tx.toHex(), parentRawHexes: parents.map((parent) => parent.toHex()),
    blockHash: "ab".repeat(32), blockTxids: txids, height: 100, index,
  };
}

describe("canonical builders replay as confirmed Cove transactions", () => {
  it("deploys, buys, and sells one lot with exact fees, change, balances and backing", () => {
    const deployFund = funding(10_000);
    const deployTemplate = buildCurveDeploy({
      ticker: "COVE", maxAtoms: "2100000000000000", scripts,
      vaultAnchorSats: 330, changeSats: 670, changeScriptHex: wallet,
    });
    buildUnsignedPsbt(deployTemplate, [{ txid: deployFund.getId(), vout: 0, valueSats: 10_000, scriptHex: wallet }], 1_000);
    const deploy = funded(deployTemplate, [{ tx: deployFund, vout: 0 }]);
    const registration = {
      network: "regtest" as const, txid: deploy.getId(), vaultScriptHex: vault,
      creatorScriptHex: creator, protocolScriptHex: protocol, vaultAnchorSats: 330,
    };
    const deployed = applyCoveConfirmed(createCoveLedger(), observed(deploy, [deployFund], [deploy.getId()], 0), [registration]);
    expect(deployed.status).toBe("applied");
    const assetId = `regtest:${deploy.getId()}`;
    const initial = deployed.state.assets[assetId]!.curve;

    const buyerFund = funding(10_001);
    const buyQuote = quoteBuy(initial, 1_000n);
    const buyChange = 330 + 10_001 - Number(initial.vaultSats + buyQuote.buyerTotalSats + 294n) - 1_000;
    const buyTemplate = buildCurveBuy({
      ticker: "COVE", deploymentTxid: deploy.getId(), state: initial,
      amountTokens: 1_000n, scripts, recipientSats: 294, changeSats: buyChange,
    });
    buildUnsignedPsbt(buyTemplate, [
      { txid: deploy.getId(), vout: 1, valueSats: 330, scriptHex: vault },
      { txid: buyerFund.getId(), vout: 0, valueSats: 10_001, scriptHex: wallet },
    ], 1_000);
    const buy = funded(buyTemplate, [{ tx: deploy, vout: 1 }, { tx: buyerFund, vout: 0 }]);
    const bought = applyCoveConfirmed(deployed.state, observed(buy, [deploy, buyerFund], [deploy.getId(), buy.getId()], 1), [registration]);
    expect(bought.status).toBe("applied");
    expect(bought.state.assets[assetId]!.balances[wallet]).toBe("100000000000");
    expect(bought.state.assets[assetId]!.curve.vaultSats).toBe(357n);

    const sellerFund = funding(10_002);
    const current = bought.state.assets[assetId]!.curve;
    const sellQuote = quoteSell(current, 1_000n, 294n);
    const sellChange = Number(current.vaultSats + 10_002n -
      (current.vaultSats - sellQuote.grossSats + sellQuote.sellerPayoutSats + sellQuote.protocolFeeSats) - 1_000n);
    const sellTemplate = buildCurveSell({
      ticker: "COVE", deploymentTxid: deploy.getId(), state: current,
      amountTokens: 1_000n, scripts, changeSats: sellChange,
    });
    buildUnsignedPsbt(sellTemplate, [
      { txid: buy.getId(), vout: 2, valueSats: 357, scriptHex: vault },
      { txid: sellerFund.getId(), vout: 0, valueSats: 10_002, scriptHex: wallet },
    ], 1_000);
    const sell = funded(sellTemplate, [{ tx: buy, vout: 2 }, { tx: sellerFund, vout: 0 }]);
    const sold = applyCoveConfirmed(bought.state, observed(sell, [buy, sellerFund], [deploy.getId(), buy.getId(), sell.getId()], 2), [registration]);
    expect(sold.status).toBe("applied");
    expect(sold.state.assets[assetId]).toMatchObject({
      balances: { [wallet]: "0", [vault]: "100000000000" },
      curve: { mintedAtoms: 100000000000n, vaultAtoms: 100000000000n, circulatingAtoms: 0n, vaultSats: 330n },
    });
  });
});
