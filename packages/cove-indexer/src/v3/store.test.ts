import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { createDb, schema } from "@crclaunch/db";
import { eq, and, isNull } from "drizzle-orm";
import { CHAIN_BITCOIN_REGTEST, computeTokenId, encodeDeployV2, encodeMintV2, encodeRedeemV2, encodeTransferV2 } from "@crclaunch/cove-wire";
import { applyMintV2, applyRedeemV2, s0StateV2 } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { COVE_FEE_CONFIG, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, creatorFeeSats, mintFeeSats, redeemFeeSats } from "@crclaunch/cove-economics";
import { V3IndexerState } from "./state.js";
import { V3Store } from "./store.js";
import { RESERVE_ANCHOR_SATS } from "./constants.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

const URL = process.env.COVE_TEST_DATABASE_URL;
const guardianXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x42), true)!.subarray(1));
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const NONCE = Buffer.alloc(32, 0xab);
const feeScript = Buffer.from("0014" + "f".repeat(40), "hex");
const ATOMS = 100_000_000n;
const MINT_AMOUNT = 1_000_000n * ATOMS;

function config() {
  return { network: "regtest" as const, chainIdentity: CHAIN_BITCOIN_REGTEST, guardianXOnly, recoveryKeyXOnly: recoveryXOnly, feeScript, genesisHeight: 0n };
}
function opReturn(wire: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x6a, wire.length]), wire]);
}
function tx(ins: { txid: string; vout: number }[], outs: { script: Buffer; value: bigint }[]): string {
  const t = new bitcoin.Transaction();
  t.version = 2;
  for (const i of ins) t.addInput(Buffer.from(i.txid, "hex").reverse(), i.vout);
  for (const o of outs) t.addOutput(o.script, Number(o.value));
  return t.toHex();
}
function vaultScript(state: ReturnType<typeof s0StateV2>): Buffer {
  return buildBackingVaultV3({ state, guardianXOnly, recoveryKeyXOnly: recoveryXOnly, network: bitcoin.networks.regtest }).scriptPubKey;
}
function block(height: number, txs: string[]) {
  return { height: BigInt(height), hash: `b${height}`.padEnd(64, "0"), parentHash: "0".repeat(64), txs };
}
const carrierScript = Buffer.from("0014" + "a".repeat(40), "hex");
const bobScript = Buffer.from("0014" + "b".repeat(40), "hex");

describe.skipIf(!URL)("V3Store persistence — DEPLOY/MINT/TRANSFER/REDEEM + reverse rollback (§9)", () => {
  it("persists exact spent markers and backing block hashes, then rolls back in reverse", async () => {
    const db = createDb(URL!);
    const store = new V3Store("regtest");
    const state = new V3IndexerState(config());
    const tokenId = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT });
    const tokenIdHex = tokenId.toString("hex");
    const s0 = s0StateV2({ tokenId: tokenIdHex });

    // ── DEPLOY (height 1) ──
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const deployHex = tx([{ txid: "d0".repeat(32), vout: 0 }], [
      { script: opReturn(deployWire), value: 0n },
      { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS },
    ]);
    const deployTxid = bitcoin.Transaction.fromHex(deployHex).getId();
    const b1 = block(1, [deployHex]);
    state.applyBlock(b1);
    await db.transaction(async (t) => store.persistBlock(t, state, b1, state.events, state.undoByHeight.get(1n)!));

    // ── MINT (height 2) ──
    const minted = applyMintV2(s0, MINT_AMOUNT);
    const gross = minted.grossSats;
    const mintFee = mintFeeSats(gross, MINT_AMOUNT, COVE_FEE_CONFIG.buyFeeBps, COVE_FEE_CONFIG.buyFeeFlatSats);
    const mintWire = encodeMintV2({ tokenId, amount: MINT_AMOUNT, recipientVout: 2 });
    const mintHex = tx([{ txid: deployTxid, vout: 1 }], [
      { script: opReturn(mintWire), value: 0n },
      { script: vaultScript(minted.nextState), value: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
      { script: carrierScript, value: 1_000n },
      { script: feeScript, value: mintFee },
    { script: CREATOR_SCRIPT, value: creatorFeeSats(minted.grossSats) },
    ]);
    const mintTxid = bitcoin.Transaction.fromHex(mintHex).getId();
    const b2 = block(2, [mintHex]);
    state.applyBlock(b2);
    await db.transaction(async (t) => store.persistBlock(t, state, b2, state.events.filter((e) => e.blockHeight === 2n), state.undoByHeight.get(2n)!));

    // assert MINT backing blockHash == mint block hash
    let backing = await db.select().from(schema.coveV3BackingStates).where(and(eq(schema.coveV3BackingStates.network, "regtest"), eq(schema.coveV3BackingStates.tokenId, tokenIdHex)));
    expect(backing[0]!.blockHash).toBe(b2.hash);
    expect(backing[0]!.issuedSupplyAtoms).toBe(MINT_AMOUNT);
    const mintUtxo = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), eq(schema.coveV3TokenUtxos.txid, mintTxid), eq(schema.coveV3TokenUtxos.vout, 2)));
    expect(mintUtxo[0]!.spentByTxid).toBeNull();

    // ── TRANSFER full 84M (height 3) ──
    const transferWire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: MINT_AMOUNT }] });
    const transferHex = tx([{ txid: mintTxid, vout: 2 }], [
      { script: opReturn(transferWire), value: 0n },
      { script: bobScript, value: 1_000n },
    ]);
    const transferTxid = bitcoin.Transaction.fromHex(transferHex).getId();
    const b3 = block(3, [transferHex]);
    state.applyBlock(b3);
    await db.transaction(async (t) => store.persistBlock(t, state, b3, state.events.filter((e) => e.blockHeight === 3n), state.undoByHeight.get(3n)!));

    // assert original mint UTXO spent by transfer txid
    const spentMint = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), eq(schema.coveV3TokenUtxos.txid, mintTxid), eq(schema.coveV3TokenUtxos.vout, 2)));
    expect(spentMint[0]!.spentByTxid).toBe(transferTxid);
    expect(spentMint[0]!.spentHeight).toBe(3n);
    expect(spentMint[0]!.spentBlockHash).toBe(b3.hash);
    const bobUtxo = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), eq(schema.coveV3TokenUtxos.txid, transferTxid), eq(schema.coveV3TokenUtxos.vout, 1)));
    expect(bobUtxo[0]!.spentByTxid).toBeNull();

    // ── REDEEM full 84M (height 4) ──
    const redeemed = applyRedeemV2(minted.nextState, MINT_AMOUNT);
    const redeemFee = redeemFeeSats(redeemed.grossSats);
    const redeemWire = encodeRedeemV2({ tokenId, redeemAmount: MINT_AMOUNT, changeAllocations: [] });
    const redeemHex = tx(
      [{ txid: mintTxid, vout: 1 }, { txid: transferTxid, vout: 1 }],
      [
        { script: opReturn(redeemWire), value: 0n },
        { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS },
        { script: carrierScript, value: redeemed.grossSats - redeemFee },
        { script: feeScript, value: redeemFee },
      ],
    );
    const redeemTxid = bitcoin.Transaction.fromHex(redeemHex).getId();
    const b4 = block(4, [redeemHex]);
    state.applyBlock(b4);
    await db.transaction(async (t) => store.persistBlock(t, state, b4, state.events.filter((e) => e.blockHeight === 4n), state.undoByHeight.get(4n)!));

    // assert redeemed input spent by redeem txid + successor backing
    const spentBob = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), eq(schema.coveV3TokenUtxos.txid, transferTxid), eq(schema.coveV3TokenUtxos.vout, 1)));
    expect(spentBob[0]!.spentByTxid).toBe(redeemTxid);
    backing = await db.select().from(schema.coveV3BackingStates).where(and(eq(schema.coveV3BackingStates.network, "regtest"), eq(schema.coveV3BackingStates.tokenId, tokenIdHex)));
    expect(backing[0]!.backingSats).toBe(0n);
    expect(backing[0]!.blockHash).toBe(b4.hash);

    // ── reverse rollback ──
    for (const h of [4n, 3n, 2n, 1n]) {
      const undo = state.undoByHeight.get(h)!;
      const staged = state.clone();
      staged.undoBlock(h);
      await db.transaction(async (t) => store.rollback(t, undo, staged.cursor));
      state.adopt(staged);
    }

    const tokens = await db.select().from(schema.coveV3Tokens).where(eq(schema.coveV3Tokens.network, "regtest"));
    const backings = await db.select().from(schema.coveV3BackingStates).where(eq(schema.coveV3BackingStates.network, "regtest"));
    const utxos = await db.select().from(schema.coveV3TokenUtxos).where(and(eq(schema.coveV3TokenUtxos.network, "regtest"), isNull(schema.coveV3TokenUtxos.spentByTxid)));
    expect(tokens.length).toBe(0);
    expect(backings.length).toBe(0);
    expect(utxos.length).toBe(0);
    const cursor = await db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, "regtest"));
    expect(cursor[0]!.height).toBe(0n);
  });
});
