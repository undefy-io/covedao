import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { createCurveState, requiredBackingV1 } from "@crclaunch/crc20-curve";
import { applyCoveConfirmed, createCoveLedger, type CoveLedgerState, type CoveObservation } from "../src/cove-replay.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const seller = script("1");
const buyer = script("2");
const thief = script("3");
const escrow = script("4");
const vault = script("5");
const protocol = script("6");
const deployTxid = "a".repeat(64);
const assetId = `regtest:${deployTxid}`;
const atoms = 100_000_000_000n;
type Output = { scriptHex: string; valueSats: number };

function fund(scriptHex: string, valueSats: number): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32), 0xffffffff);
  tx.addOutput(Buffer.from(scriptHex, "hex"), valueSats);
  return tx;
}

function transfer(parents: readonly { tx: bitcoin.Transaction; vout: number }[], recipient: string, outputs: readonly Output[], amountAtoms = atoms): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const parent of parents) tx.addInput(Buffer.from(parent.tx.getId(), "hex").reverse(), parent.vout);
  const marker = Buffer.from(JSON.stringify({ p: "crc-20", op: "transfer", tick: "COVE", amt: amountAtoms.toString(), id: deployTxid }));
  tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, marker]), 0);
  tx.addOutput(Buffer.from(recipient, "hex"), 330);
  for (const output of outputs) tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return tx;
}

function confirmed(state: CoveLedgerState, tx: bitcoin.Transaction, parents: readonly bitcoin.Transaction[], index: number) {
  const observation: CoveObservation = {
    network: "regtest", rawHex: tx.toHex(), parentRawHexes: parents.map((parent) => parent.toHex()),
    blockHash: "b".repeat(64), blockTxids: [...Array(index).fill("0".repeat(64)), tx.getId()],
    height: 100, index,
  };
  return applyCoveConfirmed(state, observation, []);
}

function seeded(extraHolderAtoms = 0n): CoveLedgerState {
  const curve = createCurveState(`${"c".repeat(64)}:0`, 330n);
  return {
    ...createCoveLedger(),
    assets: {
      [assetId]: {
        ticker: "COVE", status: "live", vaultScriptHex: vault,
        creatorScriptHex: script("7"), protocolScriptHex: protocol,
        curve: { ...curve, mintedAtoms: atoms + extraHolderAtoms, circulatingAtoms: atoms + extraHolderAtoms,
          vaultSats: 330n + requiredBackingV1((atoms + extraHolderAtoms) / 100_000_000n) },
        balances: { [vault]: "0", [seller]: atoms.toString(), ...(extraHolderAtoms ? { [thief]: extraHolderAtoms.toString() } : {}) },
      },
    },
  };
}

describe("CRC marketplace authority threat model", () => {
  it("demonstrates the unsafe independent seller anchor: buyer BTC can pay while token replay rejects", () => {
    const listingAnchor = fund(seller, 10_000);
    const alternateSellerCoin = fund(seller, 10_001);
    const buyerFunding = fund(buyer, 10_000);
    const sellerMovesTokens = transfer([{ tx: alternateSellerCoin, vout: 0 }], thief,
      [{ scriptHex: seller, valueSats: 8_671 }]);
    const moved = confirmed(seeded(), sellerMovesTokens, [alternateSellerCoin], 0);
    expect(moved.status).toBe("applied");
    const marketFill = transfer([{ tx: listingAnchor, vout: 0 }, { tx: buyerFunding, vout: 0 }], buyer, [
      { scriptHex: seller, valueSats: 15_000 },
      { scriptHex: protocol, valueSats: 1_000 },
      { scriptHex: buyer, valueSats: 2_670 },
    ]);
    expect(marketFill.ins[0]!.hash.equals(sellerMovesTokens.ins[0]!.hash)).toBe(false);
    const afterFill = confirmed(moved.state, marketFill, [listingAnchor, buyerFunding], 1);
    expect(afterFill.status).toBe("invalid");
    expect(afterFill.state.assets[assetId]!.balances[seller]).toBe("0");
    expect(marketFill.outs[2]!.script.toString("hex")).toBe(seller);
    expect(marketFill.outs[2]!.value).toBe(15_000);
  });

  it("shows confirmed unique-script escrow removes the seller's independent spend authority", () => {
    const sellerFunding = fund(seller, 10_000);
    const deposit = transfer([{ tx: sellerFunding, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const deposited = confirmed(seeded(), deposit, [sellerFunding], 0);
    expect(deposited.status).toBe("applied");
    expect(deposited.state.assets[assetId]!.balances).toMatchObject({ [seller]: "0", [escrow]: atoms.toString() });

    const buyerFunding = fund(buyer, 10_000);
    const fill = transfer([{ tx: deposit, vout: 1 }, { tx: buyerFunding, vout: 0 }], buyer, [
      { scriptHex: seller, valueSats: 5_330 },
      { scriptHex: protocol, valueSats: 1_000 },
      { scriptHex: buyer, valueSats: 2_670 },
    ]);
    const filled = confirmed(deposited.state, fill, [deposit, buyerFunding], 1);
    expect(filled.status).toBe("applied");
    expect(filled.state.assets[assetId]!.balances).toMatchObject({ [escrow]: "0", [buyer]: atoms.toString() });

    const withdrawalFeeFunding = fund(protocol, 2_000);
    const withdrawal = transfer([{ tx: deposit, vout: 1 }, { tx: withdrawalFeeFunding, vout: 0 }], seller,
      [{ scriptHex: protocol, valueSats: 1_000 }]);
    const withdrawn = confirmed(deposited.state, withdrawal, [deposit, withdrawalFeeFunding], 1);
    expect(withdrawn.status).toBe("applied");
    expect(withdrawn.state.assets[assetId]!.balances).toMatchObject({ [escrow]: "0", [seller]: atoms.toString() });
    expect(fill.ins[0]!.hash.equals(withdrawal.ins[0]!.hash)).toBe(true);
    expect(fill.ins[0]!.index).toBe(withdrawal.ins[0]!.index);
    expect(confirmed(filled.state, withdrawal, [deposit, withdrawalFeeFunding], 2).status).toBe("invalid");
    expect(confirmed(withdrawn.state, fill, [deposit, buyerFunding], 2).status).toBe("invalid");
  });

  it("freezes eligibility when a third party pollutes the escrow script balance", () => {
    const sellerFunding = fund(seller, 10_000);
    const deposit = transfer([{ tx: sellerFunding, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const deposited = confirmed(seeded(atoms), deposit, [sellerFunding], 0);
    const escrowBalance = BigInt(deposited.state.assets[assetId]!.balances[escrow]!);
    expect(escrowBalance).toBe(atoms);
    const donorFunding = fund(thief, 10_000);
    const donation = transfer([{ tx: donorFunding, vout: 0 }], escrow,
      [{ scriptHex: thief, valueSats: 8_670 }], 1n);
    const polluted = confirmed(deposited.state, donation, [donorFunding], 1);
    expect(polluted.status).toBe("applied");
    expect(BigInt(polluted.state.assets[assetId]!.balances[escrow]!)).toBe(atoms + 1n);
    // Activation requires exact indexed balance, not merely the listed amount or an unspent BTC output.
  });

  it("demonstrates that an unmarked escrow outpoint spend is currently invisible to token accounting", () => {
    const sellerFunding = fund(seller, 10_000);
    const deposit = transfer([{ tx: sellerFunding, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const deposited = confirmed(seeded(), deposit, [sellerFunding], 0);
    expect(deposited.status).toBe("applied");
    const escape = new bitcoin.Transaction();
    escape.version = 2;
    escape.addInput(Buffer.from(deposit.getId(), "hex").reverse(), 1);
    escape.addOutput(Buffer.from(thief, "hex"), 330);
    const escaped = confirmed(deposited.state, escape, [deposit], 1);
    expect(escaped.status).toBe("ignored");
    expect(escaped.state.assets[assetId]!.balances[escrow]).toBe(atoms.toString());
    // The escrow indexer must separately watch the registered outpoint and freeze this listing.
  });

  it("allows a recovery signer to drain script-account tokens through another escrow UTXO", () => {
    const sellerFunding = fund(seller, 10_000);
    const deposit = transfer([{ tx: sellerFunding, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const deposited = confirmed(seeded(), deposit, [sellerFunding], 0);
    expect(deposited.status).toBe("applied");
    const alternateEscrowCoin = fund(escrow, 10_000);
    const recoverySpend = transfer([{ tx: alternateEscrowCoin, vout: 0 }], thief,
      [{ scriptHex: escrow, valueSats: 8_670 }]);
    const drained = confirmed(deposited.state, recoverySpend, [alternateEscrowCoin], 1);
    expect(drained.status).toBe("applied");
    expect(drained.state.assets[assetId]!.balances[escrow]).toBe("0");
    expect(recoverySpend.ins[0]!.hash.equals(Buffer.from(deposit.getId(), "hex").reverse())).toBe(false);
    // Bitcoin accepts both distinct outpoints if the recovery signer can sign the alternate output.
  });

  it("an unrelated invalid vault spend disables escrow fill while its Bitcoin inputs remain available", () => {
    const vaultCoin = fund(vault, 357);
    const state = seeded();
    const base = state.assets[assetId]!;
    const withRealVault = { ...state, assets: {
      [assetId]: { ...base, curve: { ...base.curve, vaultOutpoint: `${vaultCoin.getId()}:0` } },
    } };
    const sellerFunding = fund(seller, 10_000);
    const deposit = transfer([{ tx: sellerFunding, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const deposited = confirmed(withRealVault, deposit, [sellerFunding], 0);
    expect(deposited.status).toBe("applied");
    const escape = new bitcoin.Transaction();
    escape.version = 2;
    escape.addInput(Buffer.from(vaultCoin.getId(), "hex").reverse(), 0);
    escape.addOutput(Buffer.from(thief, "hex"), 357);
    const broken = confirmed(deposited.state, escape, [vaultCoin], 1);
    expect(broken.status).toBe("broken");
    const buyerFunding = fund(buyer, 10_000);
    const fill = transfer([{ tx: deposit, vout: 1 }, { tx: buyerFunding, vout: 0 }], buyer, [
      { scriptHex: seller, valueSats: 5_330 },
      { scriptHex: protocol, valueSats: 1_000 },
      { scriptHex: buyer, valueSats: 2_670 },
    ]);
    expect(fill.ins[0]!.hash.equals(escape.ins[0]!.hash)).toBe(false);
    expect(confirmed(broken.state, fill, [deposit, buyerFunding], 2).status).toBe("invalid");
  });

  it("a reorg can validate a competing seller transfer before the deposit and its Bitcoin-valid child fill", () => {
    const sellerDepositCoin = fund(seller, 10_000);
    const sellerAlternateCoin = fund(seller, 10_001);
    const buyerFunding = fund(buyer, 10_000);
    const deposit = transfer([{ tx: sellerDepositCoin, vout: 0 }], escrow,
      [{ scriptHex: seller, valueSats: 8_670 }]);
    const fill = transfer([{ tx: deposit, vout: 1 }, { tx: buyerFunding, vout: 0 }], buyer, [
      { scriptHex: seller, valueSats: 5_330 },
      { scriptHex: protocol, valueSats: 1_000 },
      { scriptHex: buyer, valueSats: 2_670 },
    ]);
    const oldDeposit = confirmed(seeded(), deposit, [sellerDepositCoin], 0);
    expect(oldDeposit.status).toBe("applied");
    expect(confirmed(oldDeposit.state, fill, [deposit, buyerFunding], 1).status).toBe("applied");

    const competing = transfer([{ tx: sellerAlternateCoin, vout: 0 }], thief,
      [{ scriptHex: seller, valueSats: 8_671 }]);
    const reordered = confirmed(seeded(), competing, [sellerAlternateCoin], 0);
    expect(reordered.status).toBe("applied");
    expect(competing.ins[0]!.hash.equals(deposit.ins[0]!.hash)).toBe(false);
    const invalidDeposit = confirmed(reordered.state, deposit, [sellerDepositCoin], 1);
    expect(invalidDeposit.status).toBe("invalid");
    expect(confirmed(invalidDeposit.state, fill, [deposit, buyerFunding], 2).status).toBe("invalid");
    expect(fill.outs[2]!.script.toString("hex")).toBe(seller);
  });
});
