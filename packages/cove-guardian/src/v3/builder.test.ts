import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { s0StateV2, applyMintV2, applyRedeemV2, TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { CHAIN_BITCOIN_REGTEST, decodeV2, discoveryAgreesWithBinary } from "@crclaunch/cove-wire";
import { creatorFeeSats, mintFeeSats, redeemFeeSats } from "@crclaunch/cove-economics";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  RESERVE_ANCHOR_SATS,
} from "./builder.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const GUARDIAN = ECPair.fromPrivateKey(Buffer.alloc(32, 0x42), {
  network: bitcoin.networks.regtest,
});
const guardianXOnly = Buffer.from(GUARDIAN.publicKey.subarray(1));
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const NONCE = Buffer.alloc(32, 0xab);

function deploy() {
  return buildDeployPsbtV3({ feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
    network: bitcoin.networks.regtest,
    identity: {
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      policyVersion: 3,
      ticker: "FROG",
      tokenNonce: NONCE,
    },
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [
      {
        txid: "a".repeat(64),
        vout: 0,
        script: Buffer.from("0014" + "c".repeat(40), "hex"),
        valueSats: 1_000_000n,
      },
    ],
    deployerChangeScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    minerFeeSats: 1_000n,
  });
}

describe("V3 builders (offline)", () => {
  it("DEPLOY: tokenId precomputable, S0 vault value = anchor, OP_RETURN wire v2", () => {
    const d = deploy();
    expect(d.tokenId.toString("hex")).toBe(
      "2b831aa045c22a0be1913c268aa30ab182bb3afc0759c5f5e99139e1f593780c",
    );
    expect(d.s0.issuedPublicSupplyAtoms).toBe(0n);
    expect(d.s0.backingSats).toBe(0n);
    const outs = d.psbt.txOutputs;
    expect(outs[0]!.value).toBe(0); // OP_RETURN
    expect(outs[1]!.script.equals(d.vault.scriptPubKey)).toBe(true);
    expect(outs[1]!.value).toBe(Number(RESERVE_ANCHOR_SATS));
    // decode the OP_RETURN wire (skip 6a + push).
    const wire = outs[0]!.script.subarray(2);
    const env = decodeV2(wire);
    expect(env.op).toBe(1); // DEPLOY
    expect((env as { ticker: string }).ticker).toBe("FROG");
  });

  it("MINT: successor backing = R(nextSupply), prev vault committed, wire v2 MINT", () => {
    const d = deploy();
    const mint = buildMintPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: d.s0,
      prevBacking: {
        txid: "a".repeat(64),
        vout: 1,
        script: d.vault.scriptPubKey,
        valueSats: RESERVE_ANCHOR_SATS,
      },
      mintAmountAtoms: 1_000_000n * 100_000_000n,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      buyerInputs: [
        {
          txid: "b".repeat(64),
          vout: 0,
          script: Buffer.from("0014" + "d".repeat(40), "hex"),
          valueSats: 1_000_000n,
        },
      ],
      buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      creatorScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    });
    const expected = applyMintV2(d.s0, 1_000_000n * 100_000_000n);
    expect(mint.nextState.backingSats).toBe(expected.nextState.backingSats);
    expect(mint.grossSats).toBe(148_500n);
    expect(mint.buyFeeSats).toBe(26_138n);
    // State input spends the PREV vault (MINT leaf).
    expect(mint.psbt.data.inputs[0]!.tapMerkleRoot!.equals(mint.prevVault.merkleRoot)).toBe(true);
    // Successor output is the NEXT vault.
    expect(mint.psbt.txOutputs[1]!.script.equals(mint.nextVault.scriptPubKey)).toBe(true);
  });

  it("MINT and REDEEM leaves are distinct in the backing vault", () => {
    const v = buildBackingVaultV3({
      state: s0StateV2({ tokenId: "cd".repeat(32) }),
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
    });
    expect(v.mintLeaf.tapleafHash.equals(v.redeemLeaf.tapleafHash)).toBe(false);
  });

  it("TRANSFER: token conservation enforced, wire v2 allocations keyed by vout", () => {
    const d = deploy();
    const t = buildTransferPsbtV2({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      tokenInputs: [
        {
          txid: "c".repeat(64),
          vout: 2,
          script: Buffer.from("0014" + "a".repeat(40), "hex"),
          valueSats: TOKEN_CARRIER_SATS,
        },
      ],
      tokenInputTotalAtoms: 1_000_000n * 100_000_000n,
      tokenOutputs: [
        { script: Buffer.from("0014" + "b".repeat(40), "hex"), amountAtoms: 500_000n * 100_000_000n },
        { script: Buffer.from("0014" + "c".repeat(40), "hex"), amountAtoms: 500_000n * 100_000_000n },
      ],
      funderInputs: [
        {
          txid: "d".repeat(64),
          vout: 0,
          script: Buffer.from("0014" + "d".repeat(40), "hex"),
          valueSats: 1_000_000n,
        },
      ],
      funderChangeScript: Buffer.from("0014" + "d".repeat(40), "hex"),
      btcOutputs: [],
      minerFeeSats: 1_000n,
    });
    // [0] OP_RETURN, [1] carrier A, [2] carrier B, [3] funder change
    expect(t.psbt.txOutputs.length).toBe(4);
    expect(t.psbt.txOutputs[1]!.value).toBe(Number(TOKEN_CARRIER_SATS));
    expect(t.psbt.txOutputs[2]!.value).toBe(Number(TOKEN_CARRIER_SATS));
    const env = decodeV2(t.psbt.txOutputs[0]!.script.subarray(2));
    expect(env.op).toBe(2); // TRANSFER
    expect((env as { allocations: { vout: number; amount: bigint }[] }).allocations).toEqual([
      { vout: 1, amount: 500_000n * 100_000_000n },
      { vout: 2, amount: 500_000n * 100_000_000n },
    ]);
    // Conservation violation must throw.
    expect(() =>
      buildTransferPsbtV2({
        network: bitcoin.networks.regtest,
        tokenId: d.tokenId,
        tokenInputs: [],
        tokenInputTotalAtoms: 1n,
        tokenOutputs: [{ script: Buffer.from("0014" + "b".repeat(40), "hex"), amountAtoms: 2n }],
        funderInputs: [],
        funderChangeScript: Buffer.from("0014" + "d".repeat(40), "hex"),
        btcOutputs: [],
        minerFeeSats: 1_000n,
      }),
    ).toThrow(/conservation/);
  });

  it("REDEEM: script-path REDEEM leaf, successor backing = R(next), net = gross - fee", () => {
    const d = deploy();
    const mintAmountAtoms = 1_000_000n * 100_000_000n;
    const minted = applyMintV2(d.s0, mintAmountAtoms);
    const r = buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: minted.nextState,
      prevBacking: {
        txid: "e".repeat(64),
        vout: 1,
        script: buildBackingVaultV3({
          state: minted.nextState,
          guardianXOnly,
          recoveryKeyXOnly: recoveryXOnly,
        }).scriptPubKey,
        valueSats: RESERVE_ANCHOR_SATS + minted.nextState.backingSats,
      },
      redeemAmountAtoms: mintAmountAtoms,
      tokenInputs: [
        {
          txid: "f".repeat(64),
          vout: 1,
          script: Buffer.from("0014" + "e".repeat(40), "hex"),
          valueSats: TOKEN_CARRIER_SATS,
        },
      ],
      tokenInputTotalAtoms: mintAmountAtoms,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      sellerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
    });
    const expected = applyRedeemV2(minted.nextState, mintAmountAtoms);
    expect(r.nextState.backingSats).toBe(expected.nextState.backingSats);
    expect(r.nextState.issuedPublicSupplyAtoms).toBe(0n);
    expect(r.grossSats).toBe(148_500n);
    expect(r.redeemFeeSats).toBe(11_138n);
    expect(r.netSats).toBe(137_362n);
    expect(r.changeAtoms).toBe(0n);
    // State input spends the PREV vault via the REDEEM leaf.
    expect(r.psbt.data.inputs[0]!.tapMerkleRoot!.equals(r.prevVault.merkleRoot)).toBe(true);
    expect(
      r.psbt.data.inputs[0]!.tapLeafScript![0]!.script.equals(r.prevVault.redeemLeaf.script),
    ).toBe(true);
    // [0] OP_RETURN, [1] successor vault, [2] payout, [3] fee (no change carrier, no BTC change).
    expect(r.psbt.txOutputs[1]!.script.equals(r.nextVault.scriptPubKey)).toBe(true);
    expect(r.psbt.txOutputs[2]!.value).toBe(137_362);
    const env = decodeV2(r.psbt.txOutputs[0]!.script.subarray(2));
    expect(env.op).toBe(4); // REDEEM
    expect((env as { redeemAmount: bigint }).redeemAmount).toBe(mintAmountAtoms);
  });

  it("MINT: protocol fee schedule is parameterized (profile-driven), not the dev default", () => {
    const d = deploy();
    const mintAmountAtoms = 1_000_000n * 100_000_000n;
    const gross = applyMintV2(d.s0, mintAmountAtoms).grossSats;
    const mint = buildMintPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: d.s0,
      prevBacking: { txid: "a".repeat(64), vout: 1, script: d.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
      mintAmountAtoms,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      buyerInputs: [{ txid: "b".repeat(64), vout: 0, script: Buffer.from("0014" + "d".repeat(40), "hex"), valueSats: 1_000_000n }],
      buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      buyFeeBps: 50n,
      buyFeeFlatSats: 7n,
      creatorScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    });
    expect(mint.buyFeeSats).toBe(mintFeeSats(gross, mintAmountAtoms, 50n, 7n));
    expect(mint.buyFeeSats).not.toBe(26_138n); // the dev default (stage-scaled flat + 750 bps)
  });

  it("REDEEM: protocol fee schedule is parameterized (profile-driven), not the dev default", () => {
    const d = deploy();
    const minted = applyMintV2(d.s0, 1_000_000n * 100_000_000n);
    const gross = applyRedeemV2(minted.nextState, 1_000_000n * 100_000_000n).grossSats;
    const r = buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: minted.nextState,
      prevBacking: { txid: "e".repeat(64), vout: 1, script: buildBackingVaultV3({ state: minted.nextState, guardianXOnly, recoveryKeyXOnly: recoveryXOnly }).scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + minted.nextState.backingSats },
      redeemAmountAtoms: 1_000_000n * 100_000_000n,
      tokenInputs: [{ txid: "f".repeat(64), vout: 1, script: Buffer.from("0014" + "e".repeat(40), "hex"), valueSats: TOKEN_CARRIER_SATS }],
      tokenInputTotalAtoms: 1_000_000n * 100_000_000n,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      sellerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      redeemFeeBps: 50n,
      redeemFeeFlatSats: 7n,
    });
    // 0.5% + 7 is 915 here, under the 1,000-sat floor every sell-back pays.
    expect(r.redeemFeeSats).toBe(redeemFeeSats(gross, 50n, 7n));
    expect(r.redeemFeeSats).not.toBe(11_138n); // the dev default (7.5%)
  });
});

describe("crc-20 discovery envelope in the built PSBT (§D1)", () => {
  function mintWith(discoveryEnvelope?: { ticker: string }) {
    const d = deploy();
    return buildMintPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: d.s0,
      prevBacking: {
        txid: "a".repeat(64),
        vout: 1,
        script: d.vault.scriptPubKey,
        valueSats: RESERVE_ANCHOR_SATS,
      },
      mintAmountAtoms: 1_000_000n * 100_000_000n,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      buyerInputs: [
        {
          txid: "b".repeat(64),
          vout: 0,
          script: Buffer.from("0014" + "d".repeat(40), "hex"),
          valueSats: 1_000_000n,
        },
      ],
      buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      discoveryEnvelope,
      creatorScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    });
  }

  it("is ABSENT by default — the dual envelope is opt-in", () => {
    const outs = mintWith().psbt.txOutputs;
    const nulldata = outs.filter((o) => o.script[0] === 0x6a);
    expect(nulldata).toHaveLength(1);
    expect(outs[0]!.script[0]).toBe(0x6a);
  });

  it("when enabled, appends exactly one extra OP_RETURN as the LAST output", () => {
    const withOut = mintWith().psbt.txOutputs.length;
    const outs = mintWith({ ticker: "FROG" }).psbt.txOutputs;

    expect(outs).toHaveLength(withOut + 1);

    const last = outs[outs.length - 1]!;
    expect(last.script[0]).toBe(0x6a);
    expect(last.value).toBe(0);
    expect(Buffer.from(last.script).subarray(2).toString("utf8")).toBe(
      '{"p":"crc-20","op":"mint","tick":"FROG","amt":"100000000000000"}',
    );
  });

  it("leaves vout 0 and every fixed-index output untouched", () => {
    const plain = mintWith().psbt.txOutputs;
    const dual = mintWith({ ticker: "FROG" }).psbt.txOutputs;
    for (let i = 0; i < plain.length; i++) {
      expect(Buffer.from(dual[i]!.script).equals(Buffer.from(plain[i]!.script)), `vout ${i}`).toBe(true);
      expect(dual[i]!.value, `vout ${i} value`).toBe(plain[i]!.value);
    }
  });

  it("the appended payload is the canonical re-derivation the Guardian will demand", () => {
    const outs = mintWith({ ticker: "FROG" }).psbt.txOutputs;
    const binary = decodeV2(Buffer.from(outs[0]!.script).subarray(2));
    const payload = Buffer.from(outs[outs.length - 1]!.script).subarray(2);
    expect(discoveryAgreesWithBinary(payload, binary, "FROG")).toBe(true);
    expect(discoveryAgreesWithBinary(payload, binary, "DOGE")).toBe(false);
  });
});

/**
 * The miner fee used to come only from the seller's token carriers, which are
 * 1,000 sats each. That made a partial redeem from a single carrier
 * arithmetically impossible and capped the fee for every redeem at roughly
 * `carriers × 1000` — so redemption stopped working above a few sat/vB.
 */
describe("REDEEM miner-fee funding", () => {
  const SELLER = Buffer.from("0014" + "e".repeat(40), "hex");
  const FEE = Buffer.from("0014" + "f".repeat(40), "hex");

  function redeem(opts: {
    redeemAmountAtoms: bigint;
    carriers: number;
    minerFeeSats: bigint;
    funderSats?: bigint;
  }) {
    const d = deploy();
    const mintAmountAtoms = 1_000_000n * 100_000_000n;
    const minted = applyMintV2(d.s0, mintAmountAtoms);
    const per = mintAmountAtoms / BigInt(opts.carriers);
    return buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: minted.nextState,
      prevBacking: {
        txid: "e".repeat(64),
        vout: 1,
        script: buildBackingVaultV3({
          state: minted.nextState,
          guardianXOnly,
          recoveryKeyXOnly: recoveryXOnly,
        }).scriptPubKey,
        valueSats: RESERVE_ANCHOR_SATS + minted.nextState.backingSats,
      },
      redeemAmountAtoms: opts.redeemAmountAtoms,
      tokenInputs: Array.from({ length: opts.carriers }, (_, i) => ({
        txid: String(i).repeat(64).slice(0, 64),
        vout: 1,
        script: SELLER,
        valueSats: TOKEN_CARRIER_SATS,
      })),
      tokenInputTotalAtoms: per * BigInt(opts.carriers),
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: SELLER,
      sellerChangeScript: SELLER,
      feeScript: FEE,
      minerFeeSats: opts.minerFeeSats,
      funderInputs: opts.funderSats
        ? [{ txid: "b".repeat(64), vout: 0, script: SELLER, valueSats: opts.funderSats }]
        : undefined,
      funderChangeScript: SELLER,
    });
  }

  const ALL = 1_000_000n * 100_000_000n;
  const HALF = ALL / 2n;

  it("still refuses a partial redeem from one carrier when nothing funds the fee", () => {
    // 1,000 carrier − 1,000 change carrier − 1,000 fee = −1,000.
    expect(() => redeem({ redeemAmountAtoms: HALF, carriers: 1, minerFeeSats: 1_000n })).toThrow(
      /insufficient redeem funds/,
    );
  });

  it("allows that same partial redeem once a BTC input funds the fee", () => {
    const r = redeem({
      redeemAmountAtoms: HALF,
      carriers: 1,
      minerFeeSats: 1_000n,
      funderSats: 10_000n,
    });
    expect(r.changeAtoms).toBe(HALF);
    expect(r.grossSats).toBeGreaterThan(0n);
  });

  it("names the shortfall instead of failing blankly", () => {
    expect(() => redeem({ redeemAmountAtoms: HALF, carriers: 1, minerFeeSats: 1_000n })).toThrow(
      /add a BTC funding input/,
    );
  });

  it("supports a miner fee far above what carriers alone could pay", () => {
    // ~30 sat/vB on a 400 vB redeem. Four carriers hold only 4,000 sats.
    const r = redeem({
      redeemAmountAtoms: ALL,
      carriers: 4,
      minerFeeSats: 12_000n,
      funderSats: 50_000n,
    });
    expect(r.netSats).toBe(137_362n);
  });

  it("refuses that fee without a funder, as before", () => {
    expect(() => redeem({ redeemAmountAtoms: ALL, carriers: 4, minerFeeSats: 12_000n })).toThrow(
      /insufficient redeem funds/,
    );
  });
});

/**
 * Change too small to be a standard output cannot be paid back to the user —
 * Bitcoin will not relay it. It therefore becomes miner fee whether anyone
 * says so or not. What matters is that the builder REPORTS the fee it really
 * pays: the browser re-derives the fee from inputs minus outputs and refuses
 * to sign when it disagrees with the stated one, so an unreported absorption
 * turned a routine trade into an error the user could do nothing about.
 */
describe("dust change is absorbed into the miner fee, and reported", () => {
  const WALLET = Buffer.from("0014" + "c".repeat(40), "hex");
  // A creator distinct from the wallet, so its 1,000-sat record output is not
  // mistaken for change.
  const CREATOR = Buffer.from("0014" + "9".repeat(40), "hex");
  const DUST_P2WPKH = 294n;

  function deployWithChange(inputSats: bigint, minerFeeSats: bigint) {
    return buildDeployPsbtV3({ feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      network: bitcoin.networks.regtest,
      identity: {
        chainIdentity: CHAIN_BITCOIN_REGTEST,
        policyVersion: 3,
        ticker: "FROG",
        tokenNonce: NONCE,
      },
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      deployerInputs: [{ txid: "a".repeat(64), vout: 0, script: WALLET, valueSats: inputSats }],
      deployerChangeScript: WALLET,
      creatorScript: CREATOR,
      minerFeeSats,
    });
  }

  function actualFee(psbt: bitcoin.Psbt): bigint {
    const inputs = psbt.data.inputs.reduce((sum, i) => sum + BigInt(i.witnessUtxo!.value), 0n);
    const outputs = psbt.txOutputs.reduce((sum, o) => sum + BigInt(o.value), 0n);
    return inputs - outputs;
  }

  it("pays out change that clears the dust threshold", () => {
    // 10,000 anchor + 1,000 creator record + 7,000 launch fee + 1,000 fee + 5,000 change
    const d = deployWithChange(24_000n, 1_000n);
    expect(d.minerFeeSats).toBe(1_000n);
    expect(actualFee(d.psbt)).toBe(1_000n);
    expect(d.psbt.txOutputs.some((o) => o.value === 5_000)).toBe(true);
  });

  it("creates no change output at all when it lands exactly on zero", () => {
    const d = deployWithChange(19_000n, 1_000n);
    expect(d.minerFeeSats).toBe(1_000n);
    expect(actualFee(d.psbt)).toBe(1_000n);
    expect(d.psbt.txOutputs.some((o) => o.script.equals(WALLET))).toBe(false);
  });

  it("absorbs sub-dust change and reports the larger fee", () => {
    // 10,000 anchor + 1,000 creator record + 7,000 launch fee + 1,000 fee +
    // 200 change, and 200 is below the 294 dust threshold for a P2WPKH output.
    const d = deployWithChange(19_200n, 1_000n);
    expect(d.minerFeeSats).toBe(1_200n);
    expect(actualFee(d.psbt)).toBe(d.minerFeeSats);
    expect(d.psbt.txOutputs.some((o) => o.script.equals(WALLET))).toBe(false);
  });

  it("never absorbs more than one dust threshold", () => {
    for (let extra = 1n; extra < DUST_P2WPKH; extra += 37n) {
      const d = deployWithChange(19_000n + extra, 1_000n);
      expect(d.minerFeeSats - 1_000n).toBe(extra);
      expect(d.minerFeeSats - 1_000n).toBeLessThan(DUST_P2WPKH);
      expect(actualFee(d.psbt)).toBe(d.minerFeeSats);
    }
  });

  it("reports the real fee for a mint too", () => {
    const d = deploy();
    const anchorAndFee = RESERVE_ANCHOR_SATS;
    const minted = applyMintV2(d.s0, 1_000_000n * 100_000_000n);
    const gross = minted.grossSats;
    const buyFee = mintFeeSats(gross, 1_000_000n * 100_000_000n, 750n, 5_000n);
    // Fund exactly enough to leave 100 sats of change: below dust.
    const funding = gross + buyFee + creatorFeeSats(gross) + TOKEN_CARRIER_SATS + 1_000n + 100n;
    const m = buildMintPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: d.tokenId,
      prevState: d.s0,
      prevBacking: {
        txid: "e".repeat(64),
        vout: 1,
        script: buildBackingVaultV3({
          state: d.s0,
          guardianXOnly,
          recoveryKeyXOnly: recoveryXOnly,
        }).scriptPubKey,
        valueSats: anchorAndFee,
      },
      mintAmountAtoms: 1_000_000n * 100_000_000n,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      buyerInputs: [{ txid: "b".repeat(64), vout: 0, script: WALLET, valueSats: funding }],
      buyerCarrierScript: WALLET,
      buyerChangeScript: WALLET,
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      creatorScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    });
    expect(m.minerFeeSats).toBe(1_100n);
    expect(actualFee(m.psbt)).toBe(m.minerFeeSats);
  });
});
