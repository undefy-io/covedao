import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { applyMintV2, s0StateV2 } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import {
  CHAIN_BITCOIN_REGTEST,
  computeTokenId,
  encodeDeployV2,
  encodeMintV2,
  encodeRedeemV2,
  encodeTransferV2,
} from "@crclaunch/cove-wire";
import { COVE_FEE_CONFIG, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, creatorFeeSats, mintFeeSats } from "@crclaunch/cove-economics";
import { RESERVE_ANCHOR_SATS } from "./constants.js";
import { V3IndexerState } from "./state.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

const guardianXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x42), true)!.subarray(1));
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const feeScript = Buffer.from("0014" + "f".repeat(40), "hex");
const NONCE = Buffer.alloc(32, 0xab);
const ATOMS = 100_000_000n;
const MINT_AMOUNT = 1_000_000n * ATOMS;

function config() {
  return {
    network: "regtest" as const,
    chainIdentity: CHAIN_BITCOIN_REGTEST,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    genesisHeight: 0n,
  };
}

function opReturn(wire: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x6a, wire.length]), wire]);
}

/** Build a raw tx hex from inputs (big-endian txids) + outputs. */
function tx(ins: { txid: string; vout: number }[], outs: { script: Buffer; value: bigint }[]): string {
  const t = new bitcoin.Transaction();
  t.version = 2;
  for (const i of ins) t.addInput(Buffer.from(i.txid, "hex").reverse(), i.vout);
  for (const o of outs) t.addOutput(o.script, Number(o.value));
  return t.toHex();
}

function vaultScript(state: ReturnType<typeof s0StateV2>): Buffer {
  return buildBackingVaultV3({
    state,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    network: bitcoin.networks.regtest,
  }).scriptPubKey;
}

function block(height: number, txs: string[]) {
  return { height: BigInt(height), hash: `b${height}`.padEnd(64, "0"), parentHash: "0".repeat(64), txs };
}

describe("V3IndexerState — deterministic lifecycle indexing (§9-§13, §14)", () => {
  it("indexes DEPLOY → MINT → TRANSFER → REDEEM → RE-BUY → P2P and rolls back", () => {
    const state = new V3IndexerState(config());
    const tokenId = computeTokenId({
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      policyVersion: 3,
      ticker: "FROG",
      tokenNonce: NONCE,
      creatorScript: CREATOR_SCRIPT,
    });
    const tokenIdHex = tokenId.toString("hex");
    const s0 = s0StateV2({ tokenId: tokenIdHex });

    // ── DEPLOY ──
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const deployTxid = tx(
      [{ txid: "d0".repeat(32), vout: 0 }],
      [ { script: opReturn(deployWire), value: 0n }, { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS } ],
    );
    const deployHex = deployTxid;
    const deployTxidHex = bitcoin.Transaction.fromHex(deployTxid).getId();
    state.applyBlock(block(1, [deployHex]));
    expect(state.tokens.has(tokenIdHex)).toBe(true);
    expect(state.backing.get(tokenIdHex)!.state.issuedPublicSupplyAtoms).toBe(0n);

    // ── MINT 84M ──
    const minted = applyMintV2(s0, MINT_AMOUNT);
    const gross = minted.grossSats;
    const fee = mintFeeSats(gross, MINT_AMOUNT, COVE_FEE_CONFIG.buyFeeBps, COVE_FEE_CONFIG.buyFeeFlatSats);
    const mintWire = encodeMintV2({ tokenId, amount: MINT_AMOUNT, recipientVout: 2 });
    const carrierScript = Buffer.from("0014" + "a".repeat(40), "hex");
    const mintTxid = tx(
      [{ txid: deployTxidHex, vout: 1 }],
      [
        { script: opReturn(mintWire), value: 0n },
        { script: vaultScript(minted.nextState), value: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
        { script: carrierScript, value: 1_000n },
        { script: feeScript, value: fee },
      { script: CREATOR_SCRIPT, value: creatorFeeSats(minted.grossSats) },
      ],
    );
    const mintTxidHex = bitcoin.Transaction.fromHex(mintTxid).getId();
    state.applyBlock(block(2, [mintTxid]));
    expect(state.backing.get(tokenIdHex)!.state.issuedPublicSupplyAtoms).toBe(MINT_AMOUNT);
    expect(state.backing.get(tokenIdHex)!.state.backingSats).toBe(148_500n);
    expect(state.tokenUtxos.get(`${mintTxidHex}:2`)!.amountAtoms).toBe(MINT_AMOUNT);

    // ── TRANSFER full 84M to Bob ──
    const bobScript = Buffer.from("0014" + "b".repeat(40), "hex");
    const transferWire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: MINT_AMOUNT }] });
    const transferTxid = tx(
      [{ txid: mintTxidHex, vout: 2 }],
      [
        { script: opReturn(transferWire), value: 0n },
        { script: bobScript, value: 1_000n },
      ],
    );
    const transferTxidHex = bitcoin.Transaction.fromHex(transferTxid).getId();
    state.applyBlock(block(3, [transferTxid]));
    expect(state.tokenUtxos.has(`${mintTxidHex}:2`)).toBe(false);
    expect(state.tokenUtxos.get(`${transferTxidHex}:1`)!.amountAtoms).toBe(MINT_AMOUNT);
    // backing/supply unchanged
    expect(state.backing.get(tokenIdHex)!.state.backingSats).toBe(148_500n);

    // ── REDEEM full 84M (backing returns to S0) ──
    const redeemWire = encodeRedeemV2({ tokenId, redeemAmount: MINT_AMOUNT, changeAllocations: [] });
    const payoutScript = Buffer.from("0014" + "c".repeat(40), "hex");
    const redeemTxid = tx(
      [
        { txid: mintTxidHex, vout: 1 },
        { txid: transferTxidHex, vout: 1 },
      ],
      [
        { script: opReturn(redeemWire), value: 0n },
        { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS },
        { script: payoutScript, value: 137_362n },
        { script: feeScript, value: 11_138n },
      ],
    );
    state.applyBlock(block(4, [redeemTxid]));
    expect(state.backing.get(tokenIdHex)!.state.issuedPublicSupplyAtoms).toBe(0n);
    expect(state.backing.get(tokenIdHex)!.state.backingSats).toBe(0n);
    expect(state.tokenUtxos.size).toBe(0);

    // deterministic root is stable
    const root1 = state.stateRoot();
    const root2 = state.stateRoot();
    expect(root1).toBe(root2);
    expect(root1).toHaveLength(64);

    // ── roll back REDEEM, then MINT, and re-apply ──
    state.undoBlock(4n);
    expect(state.backing.get(tokenIdHex)!.state.backingSats).toBe(148_500n);
    expect(state.tokenUtxos.get(`${transferTxidHex}:1`)!.amountAtoms).toBe(MINT_AMOUNT);
    state.applyBlock(block(4, [redeemTxid]));
    expect(state.stateRoot()).toBe(root1);
  });

  it("records INVALID Cove tx without mutating state", () => {
    const state = new V3IndexerState(config());
    // a Cove-magic OP_RETURN that is malformed (truncated)
    const badWire = Buffer.concat([Buffer.from([0x43, 0x56, 0x02, 0x03]), Buffer.alloc(2)]);
    const badTx = tx(
      [{ txid: "e0".repeat(32), vout: 0 }],
      [{ script: opReturn(badWire), value: 0n }],
    );
    const before = state.stateRoot();
    state.applyBlock(block(1, [badTx]));
    expect(state.events.length).toBe(1);
    expect(state.events[0]!.valid).toBe(false);
    expect(state.events[0]!.operation).toBeNull();
    expect(state.stateRoot()).toBe(before);
  });

  it("a copied DEPLOY naming another creator gets its own tokenId (no front-run)", () => {
    const state = new V3IndexerState(config());
    const thief = Buffer.from("0014" + "e".repeat(40), "hex");
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const deployFor = (creator: Buffer, fundTxid: string) => {
      const id = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: creator });
      const s0 = s0StateV2({ tokenId: id.toString("hex") });
      const hex = tx(
        [{ txid: fundTxid, vout: 0 }],
        [{ script: opReturn(deployWire), value: 0n }, { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: creator, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS }],
      );
      return { id: id.toString("hex"), hex };
    };
    // The copy confirms first; the real creator's DEPLOY is still valid.
    const copy = deployFor(thief, "d1".repeat(32));
    const real = deployFor(CREATOR_SCRIPT, "d0".repeat(32));
    state.applyBlock(block(1, [copy.hex, real.hex]));
    expect(copy.id).not.toBe(real.id);
    expect(state.events.map((e) => e.valid)).toEqual([true, true]);
    expect(state.getTokenCreatorScript(Buffer.from(real.id, "hex"))!.equals(CREATOR_SCRIPT)).toBe(true);
    expect(state.getTokenCreatorScript(Buffer.from(copy.id, "hex"))!.equals(thief)).toBe(true);
  });

  it("a DEPLOY must pay the launch fee: exactly LAUNCH_FEE_SATS to the fee address at output 3", () => {
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const id = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT });
    const s0 = s0StateV2({ tokenId: id.toString("hex") });
    const other = Buffer.from("0014" + "e".repeat(40), "hex");
    const deployWith = (fee: { script: Buffer; value: bigint } | null) =>
      tx(
        [{ txid: "d0".repeat(32), vout: 0 }],
        [
          { script: opReturn(deployWire), value: 0n },
          { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS },
          { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS },
          ...(fee ? [fee] : []),
        ],
      );
    const cases: [string, { script: Buffer; value: bigint } | null, boolean][] = [
      ["no fee output", null, false],
      ["one sat short", { script: feeScript, value: LAUNCH_FEE_SATS - 1n }, false],
      ["one sat over", { script: feeScript, value: LAUNCH_FEE_SATS + 1n }, false],
      ["paid to another address", { script: other, value: LAUNCH_FEE_SATS }, false],
      ["exact fee to the fee address", { script: feeScript, value: LAUNCH_FEE_SATS }, true],
    ];
    for (const [label, fee, valid] of cases) {
      const state = new V3IndexerState(config());
      state.applyBlock(block(1, [deployWith(fee)]));
      const ev = state.events[0]!;
      expect({ label, valid: ev.valid }).toEqual({ label, valid });
      if (!valid) expect(ev.reason).toBe("LAUNCH_FEE_MISSING");
      expect(state.tokens.size).toBe(valid ? 1 : 0);
    }
    expect(LAUNCH_FEE_SATS).toBe(7_000n);
  });

  it("rejects a transfer claiming tokens not present", () => {
    const state = new V3IndexerState(config());
    const tokenId = computeTokenId({
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      policyVersion: 3,
      ticker: "FROG",
      tokenNonce: NONCE,
      creatorScript: CREATOR_SCRIPT,
    });
    const tokenIdHex = tokenId.toString("hex");
    // deploy so the token exists, but no token UTXOs
    const s0 = s0StateV2({ tokenId: tokenIdHex });
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const deployTx = tx(
      [{ txid: "d0".repeat(32), vout: 0 }],
      [{ script: opReturn(deployWire), value: 0n }, { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS }],
    );
    state.applyBlock(block(1, [deployTx]));

    // transfer claims 84M but no token UTXO exists
    const transferWire = encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: MINT_AMOUNT }] });
    const transferTx = tx(
      [{ txid: "f0".repeat(32), vout: 0 }],
      [
        { script: opReturn(transferWire), value: 0n },
        { script: Buffer.from("0014" + "b".repeat(40), "hex"), value: 1_000n },
      ],
    );
    state.applyBlock(block(2, [transferTx]));
    const ev = state.events[state.events.length - 1]!;
    expect(ev.operation).toBe("TRANSFER");
    expect(ev.valid).toBe(false);
    expect(ev.reason).toBe("FORGED_TOKEN_INPUT");
    expect(state.tokenUtxos.size).toBe(0);
  });

  it("ignores Cove ops below the activation height, indexes at/above it (§13/§48)", () => {
    const state = new V3IndexerState({ ...config(), genesisHeight: 2n });
    const tokenId = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT });
    const s0 = s0StateV2({ tokenId: tokenId.toString("hex") });
    const deployWire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE });
    const deployHex = tx(
      [{ txid: "d0".repeat(32), vout: 0 }],
      [
        { script: opReturn(deployWire), value: 0n },
        { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS },
      ],
    );
    // Height 1 (< H=2) → ignored.
    expect(state.applyBlock(block(1, [deployHex]))).toHaveLength(0);
    expect(state.tokens.size).toBe(0);
    // Height 2 (>= H) → indexed.
    const events = state.applyBlock(block(2, [deployHex]));
    expect(events.length).toBeGreaterThan(0);
    expect(state.tokens.size).toBe(1);
  });
});

describe("V3IndexerState — carriers spent outside the protocol are burned", () => {
  function deployAndMint(state: V3IndexerState) {
    const tokenId = computeTokenId({ chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE, creatorScript: CREATOR_SCRIPT });
    const s0 = s0StateV2({ tokenId: tokenId.toString("hex") });
    const deployHex = tx(
      [{ txid: "d0".repeat(32), vout: 0 }],
      [
        { script: opReturn(encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: NONCE })), value: 0n },
        { script: vaultScript(s0), value: RESERVE_ANCHOR_SATS }, { script: CREATOR_SCRIPT, value: CREATOR_RECORD_SATS }, { script: feeScript, value: LAUNCH_FEE_SATS },
      ],
    );
    state.applyBlock(block(1, [deployHex]));
    const minted = applyMintV2(s0, MINT_AMOUNT);
    const fee = mintFeeSats(minted.grossSats, MINT_AMOUNT, COVE_FEE_CONFIG.buyFeeBps, COVE_FEE_CONFIG.buyFeeFlatSats);
    const mintHex = tx(
      [{ txid: bitcoin.Transaction.fromHex(deployHex).getId(), vout: 1 }],
      [
        { script: opReturn(encodeMintV2({ tokenId, amount: MINT_AMOUNT, recipientVout: 2 })), value: 0n },
        { script: vaultScript(minted.nextState), value: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
        { script: Buffer.from("0014" + "a".repeat(40), "hex"), value: 1_000n },
        { script: feeScript, value: fee },
      { script: CREATOR_SCRIPT, value: creatorFeeSats(minted.grossSats) },
      ],
    );
    state.applyBlock(block(2, [mintHex]));
    return { tokenId, tokenIdHex: tokenId.toString("hex"), carrier: { txid: bitcoin.Transaction.fromHex(mintHex).getId(), vout: 2 } };
  }

  it("a plain wallet send of a carrier removes its tokens, and undo restores them", () => {
    const state = new V3IndexerState(config());
    const { tokenIdHex, carrier } = deployAndMint(state);
    const rootBefore = state.stateRoot();

    const sweepHex = tx([carrier], [{ script: Buffer.from("0014" + "e".repeat(40), "hex"), value: 900n }]);
    state.applyBlock(block(3, [sweepHex]));

    expect(state.tokenUtxos.has(`${carrier.txid}:${carrier.vout}`)).toBe(false);
    // The tokens were issued and stay issued: supply and backing do not move.
    expect(state.backing.get(tokenIdHex)!.state.issuedPublicSupplyAtoms).toBe(MINT_AMOUNT);
    const undo = state.undoByHeight.get(3n)!;
    expect(undo.ops).toEqual([
      expect.objectContaining({ kind: "BURN", spendingTxid: bitcoin.Transaction.fromHex(sweepHex).getId() }),
    ]);

    state.undoBlock(3n);
    expect(state.tokenUtxos.get(`${carrier.txid}:${carrier.vout}`)!.amountAtoms).toBe(MINT_AMOUNT);
    expect(state.stateRoot()).toBe(rootBefore);
  });

  it("an invalid Cove transaction that spends a carrier burns it too", () => {
    const state = new V3IndexerState(config());
    const { tokenId, carrier } = deployAndMint(state);

    // Allocates more than the input holds: invalid, but Bitcoin still spent the carrier.
    const overHex = tx([carrier], [
      { script: opReturn(encodeTransferV2({ tokenId, allocations: [{ vout: 1, amount: MINT_AMOUNT * 2n }] })), value: 0n },
      { script: Buffer.from("0014" + "b".repeat(40), "hex"), value: 1_000n },
    ]);
    const events = state.applyBlock(block(3, [overHex]));

    expect(events[0]!.valid).toBe(false);
    expect(state.tokenUtxos.size).toBe(0);
  });
});
