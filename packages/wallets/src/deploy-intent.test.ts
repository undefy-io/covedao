import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { encodeDeployV2 } from "@crclaunch/cove-wire/codec-v2";
import { LAUNCH_FEE_SATS as PROTOCOL_LAUNCH_FEE } from "@crclaunch/cove-economics";
import { RESERVE_ANCHOR_SATS } from "@crclaunch/cove-covenant";
import { verifyClientIntent, unsignedTxDigestHex, LAUNCH_FEE_SATS, VAULT_ANCHOR_SATS, type ClientIntent } from "./cove-intent.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function scriptFor(byte: number): Buffer {
  const k = ECPair.fromPrivateKey(Buffer.alloc(32, byte));
  return bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: bitcoin.networks.regtest }).output!;
}

const walletScript = scriptFor(0x49);
const attackerScript = scriptFor(0x59);
const feeScript = scriptFor(0x69);
const vaultScript = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0x11)]);
const MINER_FEE = 1_000n;

/** A launch: 100,000 in; vault 10,000, creator record 1,000 (own), launch fee, change. */
function deployPsbt(opts: { fee?: bigint; feeTo?: Buffer; skim?: bigint } = {}): bitcoin.Psbt {
  const fee = opts.fee ?? 7_000n;
  const skim = opts.skim ?? 0n;
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: "22".repeat(32), index: 0, witnessUtxo: { script: walletScript, value: 100_000 } });
  const wire = encodeDeployV2({ policyVersion: 3, ticker: "FROG", tokenNonce: Buffer.alloc(32, 0xab) });
  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  psbt.addOutput({ script: vaultScript, value: 10_000 });
  psbt.addOutput({ script: walletScript, value: 1_000 });
  psbt.addOutput({ script: opts.feeTo ?? feeScript, value: Number(fee) });
  if (skim > 0n) psbt.addOutput({ script: attackerScript, value: Number(skim) });
  psbt.addOutput({ script: walletScript, value: Number(100_000n - 10_000n - 1_000n - fee - skim - MINER_FEE) });
  return psbt;
}

function intent(psbt: bitcoin.Psbt, overrides: Partial<ClientIntent> = {}): ClientIntent {
  return {
    operation: "DEPLOY",
    tokenId: "ab".repeat(32),
    tokenAmountAtoms: "0",
    grossSats: null,
    protocolFeeSats: "7000",
    minerFeeSats: MINER_FEE.toString(),
    netSats: null,
    walletScript: walletScript.toString("hex"),
    stateHash: null,
    unsignedTxDigest: unsignedTxDigestHex(psbt),
    ...overrides,
  };
}

describe("client check of a launch (DEPLOY)", () => {
  it("the browser's launch constants match the protocol's", () => {
    expect(LAUNCH_FEE_SATS).toBe(PROTOCOL_LAUNCH_FEE);
    expect(VAULT_ANCHOR_SATS).toBe(RESERVE_ANCHOR_SATS);
  });

  it("accepts a launch that pays exactly the launch fee", () => {
    const p = deployPsbt();
    expect(verifyClientIntent(p.toBase64(), intent(p)).ok).toBe(true);
  });

  it("refuses a launch fee other than the protocol's, even if the server states it", () => {
    const p = deployPsbt({ fee: 9_000n });
    expect(() => verifyClientIntent(p.toBase64(), intent(p, { protocolFeeSats: "9000" }))).toThrow(/launch fee/);
  });

  it("refuses a launch that pays anyone else more than it said", () => {
    const p = deployPsbt({ skim: 5_000n });
    expect(() => verifyClientIntent(p.toBase64(), intent(p))).toThrow(/launching costs/);
  });

  it("refuses a launch that states no fee", () => {
    const p = deployPsbt();
    expect(() => verifyClientIntent(p.toBase64(), intent(p, { protocolFeeSats: null }))).toThrow(/launch fee/);
  });
});
