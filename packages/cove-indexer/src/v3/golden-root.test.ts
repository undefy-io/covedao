import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { s0StateV2, applyMintV2, applyRedeemV2 } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { CHAIN_BITCOIN_REGTEST, computeTokenId, encodeDeployV2, encodeMintV2, encodeRedeemV2, encodeTransferV2 } from "@crclaunch/cove-wire";
import { COVE_FEE_CONFIG, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, creatorFeeSats, mintFeeSats, redeemFeeSats } from "@crclaunch/cove-economics";
import { V3IndexerState } from "./state.js";
import { RESERVE_ANCHOR_SATS } from "./constants.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

/**
 * Deterministic state-root golden (§18), INDEPENDENT of Bitcoin Core wallet
 * randomness: fixed txids/outpoints/scripts through the full 6-op lifecycle.
 * The same logical state always produces the same root regardless of insertion
 * order; any amount/outpoint/script mutation changes it.
 */
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
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
const aliceScript = Buffer.from("0014" + "a".repeat(40), "hex");
const bobScript = Buffer.from("0014" + "b".repeat(40), "hex");
const carolScript = Buffer.from("0014" + "c".repeat(40), "hex");

/** Run the full 6-op deterministic lifecycle and return the state. */
function fullLifecycleState(): V3IndexerState {
  const state = new V3IndexerState(config());
  const tokenId = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT });
  const tokenIdHex = tokenId.toString("hex");
  const s0 = s0StateV2({ tokenId: tokenIdHex });
  const minted = applyMintV2(s0, MINT_AMOUNT);
  const mintFee = mintFeeSats(minted.grossSats, MINT_AMOUNT, COVE_FEE_CONFIG.buyFeeBps, COVE_FEE_CONFIG.buyFeeFlatSats);

  // DEPLOY
  const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
  const deployHex = tx([{ txid: "d0".repeat(32), vout: 0 }], [{ script: opReturn(deployWire), value: 0n }, { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS }]);
  const deployTxid = bitcoin.Transaction.fromHex(deployHex).getId();
  state.applyBlock(block(1, [deployHex]));

  // MINT
  const mintWire = encodeMintV2({ tokenId, amount: MINT_AMOUNT, recipientVout: 2 });
  const mintHex = tx([{ txid: deployTxid, vout: 1 }], [
    { script: opReturn(mintWire), value: 0n },
    { script: vaultScript(minted.nextState), value: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
    { script: aliceScript, value: 1_000n },
    { script: feeScript, value: mintFee },
  { script: CREATOR_SCRIPT, value: creatorFeeSats(minted.grossSats) },
  ]);
  const mintTxid = bitcoin.Transaction.fromHex(mintHex).getId();
  state.applyBlock(block(2, [mintHex]));

  // TRANSFER Alice→Bob full
  const transferWire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: MINT_AMOUNT }] });
  const transferHex = tx([{ txid: mintTxid, vout: 2 }], [{ script: opReturn(transferWire), value: 0n }, { script: bobScript, value: 1_000n }]);
  const transferTxid = bitcoin.Transaction.fromHex(transferHex).getId();
  state.applyBlock(block(3, [transferHex]));

  // REDEEM full
  const redeemed = applyRedeemV2(minted.nextState, MINT_AMOUNT);
  const redeemFee = redeemFeeSats(redeemed.grossSats);
  const redeemWire = encodeRedeemV2({ tokenId, redeemAmount: MINT_AMOUNT, changeAllocations: [] });
  const redeemHex = tx([{ txid: mintTxid, vout: 1 }, { txid: transferTxid, vout: 1 }], [
    { script: opReturn(redeemWire), value: 0n },
    { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS },
    { script: bobScript, value: redeemed.grossSats - redeemFee },
    { script: feeScript, value: redeemFee },
  ]);
  const redeemTxid = bitcoin.Transaction.fromHex(redeemHex).getId();
  state.applyBlock(block(4, [redeemHex]));

  // RE-BUY (Alice again)
  const rebuyWire = encodeMintV2({ tokenId, amount: MINT_AMOUNT, recipientVout: 2 });
  const rebuyHex = tx([{ txid: redeemTxid, vout: 1 }], [
    { script: opReturn(rebuyWire), value: 0n },
    { script: vaultScript(minted.nextState), value: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
    { script: aliceScript, value: 1_000n },
    { script: feeScript, value: mintFee },
  { script: CREATOR_SCRIPT, value: creatorFeeSats(minted.grossSats) },
  ]);
  const rebuyTxid = bitcoin.Transaction.fromHex(rebuyHex).getId();
  state.applyBlock(block(5, [rebuyHex]));

  // P2P Alice→Carol half (42M)
  const half = MINT_AMOUNT / 2n;
  const p2pWire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: half }, { vout: 2, amount: half }] });
  const p2pHex = tx([{ txid: rebuyTxid, vout: 2 }], [
    { script: opReturn(p2pWire), value: 0n },
    { script: carolScript, value: 1_000n },
    { script: aliceScript, value: 1_000n },
  ]);
  state.applyBlock(block(6, [p2pHex]));
  // Every step must be valid, or the golden silently freezes a broken fixture.
  const invalid = state.events.filter((e) => !e.valid);
  if (invalid.length > 0) throw new Error(`fixture has invalid ops: ${invalid.map((e) => `${e.operation}:${e.reason}`).join(", ")}`);

  return state;
}

/** Frozen deterministic state-root golden for the full 6-op lifecycle fixture. */
export const V3_STATE_ROOT_GOLDEN = "1e6e2946331983a44e54801805924a3806233cf6e414ee7a9bd092c9000a4508";

describe("deterministic V3 state-root golden (§18)", () => {
  it("matches the frozen golden root", () => {
    expect(fullLifecycleState().stateRoot()).toBe(V3_STATE_ROOT_GOLDEN);
  });

  it("is deterministic across runs and insertion order", () => {
    const a = fullLifecycleState();
    const b = fullLifecycleState();
    expect(a.stateRoot()).toBe(b.stateRoot());
    expect(a.stateRoot()).toHaveLength(64);
    // insertion order must not matter
    const shuffled = new V3IndexerState(config());
    for (const [k, v] of [...b.tokens].reverse()) shuffled.tokens.set(k, { ...v });
    for (const [k, v] of [...b.backing].reverse()) shuffled.backing.set(k, { ...v, state: { ...v.state }, outpoint: { ...v.outpoint } });
    for (const [k, v] of [...b.tokenUtxos].reverse()) shuffled.tokenUtxos.set(k, { ...v });
    expect(computeRoot(shuffled)).toBe(a.stateRoot());
  });

  it("amount mutation changes the root", () => {
    const a = fullLifecycleState();
    const utxo = a.tokenUtxos.values().next().value!;
    utxo.amountAtoms += 1n;
    expect(a.stateRoot()).not.toBe(fullLifecycleState().stateRoot());
  });

  it("backing outpoint mutation changes the root", () => {
    const a = fullLifecycleState();
    const b = a.backing.values().next().value!;
    b.outpoint.txid = "ff".repeat(32);
    expect(a.stateRoot()).not.toBe(fullLifecycleState().stateRoot());
  });

  it("script mutation changes the root", () => {
    const a = fullLifecycleState();
    const u = a.tokenUtxos.values().next().value!;
    u.scriptPubKey = "0014" + "d".repeat(40);
    expect(a.stateRoot()).not.toBe(fullLifecycleState().stateRoot());
  });
});

function computeRoot(state: V3IndexerState): string {
  return state.stateRoot();
}
