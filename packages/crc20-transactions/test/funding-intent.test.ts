import * as bitcoin from "bitcoinjs-lib";
import { readFileSync } from "node:fs";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it } from "vitest";
import { createCurveState } from "@crclaunch/crc20-curve";
import { buildCrc20AssetVault, dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { buildCurveBuy, buildCurveDeploy, buildUnsignedPsbt, selectCrcFunding, verifyCrcGuardianSignedPsbt, verifyCrcWalletSignedPsbt } from "../src/index.js";

const ECPair = ECPairFactory(ecc);
const owner = ECPair.fromPrivateKey(Buffer.alloc(32, 0x31));
const wallet = bitcoin.payments.p2wpkh({ pubkey: owner.publicKey }).output!.toString("hex");
const vault = `5120${"22".repeat(32)}`;
const protocol = `5120${"33".repeat(32)}`;
const creator = `5120${"44".repeat(32)}`;
const coin = (byte: string, valueSats: number, scriptHex = wallet) => ({ txid: byte.repeat(64), vout: 0, valueSats, scriptHex });

describe("CRC wallet funding selection", () => {
  it("preserves mandatory vault/seller order and returns dust-safe explicit change", () => {
    const selected = selectCrcFunding({
      mandatoryInputs: [coin("a", 330, vault), coin("b", 1_000, wallet)],
      candidates: [coin("c", 5_000), coin("d", 5_000)],
      outputsSats: 10_000, minerFeeSats: 1_000, changeScriptHex: wallet,
    });
    expect(selected.inputs.map((input) => input.txid[0])).toEqual(["a", "b", "c", "d"]);
    expect(selected.changeSats).toBe(330);
    expect(selected.minerFeeSats).toBe(1_000);
  });

  it("folds sub-dust remainder into miner fee and rejects unsafe funding", () => {
    const base = { mandatoryInputs: [coin("a", 330, vault)], outputsSats: 9_000, minerFeeSats: 1_000, changeScriptHex: wallet };
    expect(selectCrcFunding({ ...base, candidates: [coin("b", 9_671)] })).toMatchObject({ changeSats: 0, minerFeeSats: 1_001 });
    expect(() => selectCrcFunding({ ...base, candidates: [coin("b", 1_000)] })).toThrow(/insufficient/i);
    expect(() => selectCrcFunding({ ...base, candidates: [coin("b", 20_000)], minerFeeSats: 20_001 })).toThrow(/fee cap/i);
    expect(() => selectCrcFunding({ ...base, candidates: [coin("b", 9_671), coin("b", 9_671)] })).toThrow(/duplicate/i);
    expect(() => selectCrcFunding({ ...base, candidates: [coin("b", 20_000, vault)] })).toThrow(/payment script/i);
  });
});

describe("CRC wallet-signed PSBT intent", () => {
  it("agrees with the standalone Guardian signed-PSBT golden fixture", () => {
    const vector = JSON.parse(readFileSync(new URL("./fixtures/crc20-guardian-signed-psbt.json", import.meta.url), "utf8")) as {
      network: "regtest";
      walletSignedPsbtBase64: string;
      guardianSignedPsbtBase64: string;
      vaultInputIndex: number;
      unsignedTxDigest: string;
    };
    const result = verifyCrcGuardianSignedPsbt(vector.walletSignedPsbtBase64, vector.guardianSignedPsbtBase64, vector.network, vector.vaultInputIndex);
    expect(result.unsignedTxDigest).toBe(vector.unsignedTxDigest);
  });

  it("accepts a signed launch and refuses changed unsigned tx, prevout metadata or missing signature", () => {
    const deploy = buildCurveDeploy({
      ticker: "COVE", maxAtoms: "2100000000000000", scripts: { vault, protocol, creator }, vaultAnchorSats: 330,
    });
    const unsigned = buildUnsignedPsbt(deploy, [coin("a", 9_330)], 1_000);
    const signed = bitcoin.Psbt.fromBase64(unsigned.toBase64());
    signed.signInput(0, owner);
    expect(verifyCrcWalletSignedPsbt(unsigned.toBase64(), signed.toBase64(), "regtest").unsignedTxDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyCrcWalletSignedPsbt(unsigned.toBase64(), unsigned.toBase64(), "regtest")).toThrow(/signature/i);
    const altered = bitcoin.Psbt.fromBase64(signed.toBase64());
    altered.data.inputs[0]!.witnessUtxo!.value = 9_331;
    expect(() => verifyCrcWalletSignedPsbt(unsigned.toBase64(), altered.toBase64(), "regtest")).toThrow(/prevout/i);
    const other = buildCurveDeploy({
      ticker: "OTHER", maxAtoms: "2100000000000000", scripts: { vault, protocol, creator }, vaultAnchorSats: 330,
    });
    const otherUnsigned = buildUnsignedPsbt(other, [coin("a", 9_330)], 1_000);
    expect(() => verifyCrcWalletSignedPsbt(otherUnsigned.toBase64(), signed.toBase64(), "regtest")).toThrow(/unsigned transaction/i);
  });

  it("requires wallet signature but reserves unsigned vault input for Guardian", () => {
    const state = createCurveState(`${"aa".repeat(32)}:1`, 330n);
    const buy = buildCurveBuy({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state, amountTokens: 1_000n,
      scripts: { buyer: wallet, seller: wallet, vault, protocol, creator }, recipientSats: 330,
    });
    const unsigned = buildUnsignedPsbt(buy, [{ ...coin("a", 330, vault), vout: 1 }, coin("b", buy.requiredFundingSats + 1_000)], 1_000);
    const signed = bitcoin.Psbt.fromBase64(unsigned.toBase64());
    signed.signInput(1, owner);
    expect(verifyCrcWalletSignedPsbt(unsigned.toBase64(), signed.toBase64(), "regtest", 0).psbt.data.inputs[0]!.tapKeySig).toBeUndefined();
    expect(() => verifyCrcWalletSignedPsbt(unsigned.toBase64(), unsigned.toBase64(), "regtest", 0)).toThrow(/signature/i);
  });

  it("independently verifies Guardian's finalized script-path ALL signature and vault commitment", () => {
    const guardianKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x41));
    const recoveryKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x43));
    const assetVault = buildCrc20AssetVault({
      asset: { deploymentTag: Buffer.alloc(32, 0x44), launchSalt: Buffer.alloc(32, 0x45) },
      guardianXOnly: guardianKey.publicKey.subarray(1),
      recoveryProfile: dev1RecoveryProfile(recoveryKey.publicKey.subarray(1)),
    });
    const state = createCurveState(`${"aa".repeat(32)}:1`, 330n);
    const buy = buildCurveBuy({
      ticker: "COVE", deploymentTxid: "99".repeat(32), state, amountTokens: 1_000n,
      scripts: { buyer: wallet, seller: wallet, vault: assetVault.scriptPubKey.toString("hex"), protocol, creator }, recipientSats: 330,
    });
    const unsigned = buildUnsignedPsbt(buy, [
      { ...coin("a", 330, assetVault.scriptPubKey.toString("hex")), vout: 1 },
      coin("b", buy.requiredFundingSats + 1_000),
    ], 1_000);
    const walletSigned = bitcoin.Psbt.fromBase64(unsigned.toBase64());
    walletSigned.signInput(1, owner);
    const guardian = bitcoin.Psbt.fromBase64(walletSigned.toBase64());
    guardian.updateInput(0, {
      tapInternalKey: assetVault.numsKey,
      tapMerkleRoot: assetVault.merkleRoot,
      tapLeafScript: [{ leafVersion: 0xc0, script: assetVault.executionLeaf.script, controlBlock: assetVault.executionControlBlock }],
    });
    guardian.signTaprootInput(0, guardianKey, assetVault.executionLeaf.tapleafHash, [bitcoin.Transaction.SIGHASH_ALL]);
    const signature = guardian.data.inputs[0]!.tapScriptSig![0]!.signature;
    const leaf = assetVault.executionLeaf.script;
    const control = assetVault.executionControlBlock;
    const reveal = leaf.subarray(1, 33);
    const items = [signature, reveal, leaf, control];
    guardian.updateInput(0, { finalScriptWitness: Buffer.concat([Buffer.from([4]), ...items.flatMap((item) => [Buffer.from([item.length]), item])]) });
    expect(verifyCrcGuardianSignedPsbt(walletSigned.toBase64(), guardian.toBase64(), "regtest").unsignedTxDigest).toMatch(/^[0-9a-f]{64}$/);
    const forged = bitcoin.Psbt.fromBase64(guardian.toBase64());
    forged.data.inputs[0]!.finalScriptWitness![2] = forged.data.inputs[0]!.finalScriptWitness![2]! ^ 1;
    expect(() => verifyCrcGuardianSignedPsbt(walletSigned.toBase64(), forged.toBase64(), "regtest")).toThrow(/Guardian CRC script-path signature is invalid/i);
  });
});
