import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import { buildDeployPsbtV3, buildMintPsbtV3, RESERVE_ANCHOR_SATS } from "./builder.js";
import { computeVaultExecutionSighash, verifyVaultExecutionSignature, type VaultLeafRef } from "./signer.js";
import {
  TestGuardianCustodyBackend,
  UnconfiguredGuardianCustodyBackend,
  signVaultExecutionLeafWithCustody,
  type GuardianCustodyBackend,
} from "./custody.js";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function xonly(byte: number): Buffer {
  return Buffer.from(ECPair.fromPrivateKey(Buffer.alloc(32, byte)).publicKey.subarray(1));
}

const guardianXOnly = xonly(0x42);
const recoveryKeyXOnly = xonly(0x43);
const MAINNET1: VaultRecoveryProfile = {
  profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
  recoveryCsvBlocks: 2016,
  recoveryThreshold: 2,
  recoveryPubkeys: [xonly(0x51), xonly(0x52), xonly(0x53)],
};

function mintPsbt(): { psbt: bitcoin.Psbt; mintLeaf: VaultLeafRef; controlBlock: Buffer } {
  const tokenId = Buffer.from("ab".repeat(32), "hex");
  const deploy = buildDeployPsbtV3({ feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: Buffer.alloc(32, 0xab) },
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1,
    deployerInputs: [{ txid: "a".repeat(64), vout: 0, script: Buffer.from("0014" + "c".repeat(40), "hex"), valueSats: 1_000_000n }],
    deployerChangeScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  const mint = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId,
    prevState: deploy.s0,
    prevBacking: { txid: "a".repeat(64), vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: 1_000_000n * 100_000_000n,
    guardianXOnly,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1,
    buyerInputs: [{ txid: "b".repeat(64), vout: 0, script: Buffer.from("0014" + "d".repeat(40), "hex"), valueSats: 1_000_000n }],
    buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
    buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
    feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
    minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  return { psbt: mint.psbt, mintLeaf: mint.prevVault.mintLeaf, controlBlock: mint.prevVault.mintControlBlock };
}

describe("Guardian custody backend (§21-§23)", () => {
  it("reports the correct x-only pubkey", async () => {
    const backend = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42));
    expect((await backend.xOnlyPubkey()).equals(guardianXOnly)).toBe(true);
  });

  it("signs a vault execution leaf and commits a verifiable witness", async () => {
    const { psbt, mintLeaf, controlBlock } = mintPsbt();
    const backend = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42));
    const sig = await signVaultExecutionLeafWithCustody(psbt, 0, mintLeaf, controlBlock, backend);
    expect(sig.length).toBe(64);
    // independent verify over the committed witness
    verifyVaultExecutionSignature(psbt, 0, mintLeaf, sig, guardianXOnly);
    expect(psbt.data.inputs[0]!.finalScriptWitness).toBeDefined();
  });

  it("produces a signature identical to the local signer for the same sighash (deterministic BIP340)", async () => {
    const { psbt, mintLeaf } = mintPsbt();
    const backend = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42));
    const sighash = computeVaultExecutionSighash(psbt, 0, mintLeaf);
    const sig = await backend.signTaprootScriptPath({ sighash, leafTapleafHash: mintLeaf.tapleafHash });
    expect(ecc.verifySchnorr(sighash, guardianXOnly, sig)).toBe(true);
  });

  it("unconfigured backend fails closed with CUSTODY_BACKEND_NOT_CONFIGURED", async () => {
    const backend = new UnconfiguredGuardianCustodyBackend();
    await expect(backend.xOnlyPubkey()).rejects.toThrow("CUSTODY_BACKEND_NOT_CONFIGURED");
    await expect(backend.signTaprootScriptPath({ sighash: Buffer.alloc(32), leafTapleafHash: Buffer.alloc(32) })).rejects.toThrow("CUSTODY_BACKEND_NOT_CONFIGURED");
  });

  it("rejects a spoofed (wrong-signature) backend before committing", async () => {
    const { psbt, mintLeaf, controlBlock } = mintPsbt();
    const honest = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42));
    const xOnly = await honest.xOnlyPubkey();
    const spoof: GuardianCustodyBackend = {
      xOnlyPubkey: async () => xOnly,
      // signs a DIFFERENT sighash (a spoof), so independent verification must fail
      signTaprootScriptPath: async ({ sighash }) => Buffer.from(ecc.signSchnorr(Buffer.from(sighash).reverse(), Buffer.alloc(32, 0x42))),
    };
    await expect(signVaultExecutionLeafWithCustody(psbt, 0, mintLeaf, controlBlock, spoof)).rejects.toThrow("SCHNORR_VERIFY_FAILED");
  });
});
