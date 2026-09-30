import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { checkSpendSignature, unfinalizeKeyInputs } from "@crclaunch/bitcoin";
import type { BitcoinNetwork } from "@crclaunch/crc20-base";
import { tapBranchHash, tapleafHash, tweakKey } from "@crclaunch/cove-vault";

function networkFor(network: BitcoinNetwork): bitcoin.networks.Network {
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  if (network === "regtest") return bitcoin.networks.regtest;
  return bitcoin.networks.testnet;
}

function parse(base64: string, network: BitcoinNetwork): bitcoin.Psbt {
  try { return bitcoin.Psbt.fromBase64(base64, { network: networkFor(network) }); }
  catch { throw new Error("invalid CRC PSBT"); }
}

function digest(psbt: bitcoin.Psbt): string {
  return createHash("sha256").update(psbt.data.globalMap.unsignedTx.toBuffer()).digest("hex");
}

function samePrevouts(expected: bitcoin.Psbt, actual: bitcoin.Psbt): void {
  if (expected.data.inputs.length !== actual.data.inputs.length) throw new Error("CRC PSBT prevout count changed");
  for (let index = 0; index < expected.data.inputs.length; index++) {
    const left = expected.data.inputs[index]!.witnessUtxo;
    const right = actual.data.inputs[index]!.witnessUtxo;
    if (!left || !right || left.value !== right.value || !left.script.equals(right.script)) {
      throw new Error(`CRC PSBT prevout metadata changed at input ${index}`);
    }
    const redeem = expected.data.inputs[index]!.redeemScript;
    if (redeem && !redeem.equals(actual.data.inputs[index]!.redeemScript ?? Buffer.alloc(0))) {
      throw new Error(`CRC PSBT prevout redeem script changed at input ${index}`);
    }
  }
}

function witnessItems(raw: Buffer): Buffer[] {
  let offset = 0;
  const compact = (): number => {
    if (offset >= raw.length) throw new Error("truncated Guardian witness");
    const first = raw[offset++]!;
    if (first < 0xfd) return first;
    if (first === 0xfd && offset + 2 <= raw.length) {
      const value = raw.readUInt16LE(offset); offset += 2; return value;
    }
    if (first === 0xfe && offset + 4 <= raw.length) {
      const value = raw.readUInt32LE(offset); offset += 4; return value;
    }
    throw new Error("invalid Guardian witness length");
  };
  const count = compact();
  if (count !== 4) throw new Error("Guardian CRC witness must have four stack items");
  const items: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const size = compact();
    if (size > raw.length - offset) throw new Error("truncated Guardian witness item");
    items.push(raw.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== raw.length) throw new Error("Guardian witness has trailing bytes");
  return items;
}

export function verifyCrcWalletSignedPsbt(
  expectedBase64: string,
  signedBase64: string,
  network: BitcoinNetwork,
  vaultInputIndex?: number,
): { psbt: bitcoin.Psbt; unsignedTxDigest: string } {
  const expected = parse(expectedBase64, network);
  const signed = parse(signedBase64, network);
  unfinalizeKeyInputs(signed);
  const unsignedTxDigest = digest(expected);
  if (digest(signed) !== unsignedTxDigest) throw new Error("CRC PSBT unsigned transaction changed");
  samePrevouts(expected, signed);
  if (vaultInputIndex !== undefined &&
    (!Number.isSafeInteger(vaultInputIndex) || vaultInputIndex < 0 || vaultInputIndex >= signed.data.inputs.length)) {
    throw new Error("invalid CRC vault input index");
  }
  for (let index = 0; index < signed.data.inputs.length; index++) {
    if (index === vaultInputIndex) {
      const vault = signed.data.inputs[index]!;
      if (vault.tapKeySig || vault.tapScriptSig?.length || vault.finalScriptWitness) {
        throw new Error("wallet PSBT must leave vault input unsigned for Guardian");
      }
      continue;
    }
    const verified = checkSpendSignature(signed, index);
    if (!verified.ok) throw new Error(`CRC wallet signature invalid at input ${index}: ${verified.detail}`);
  }
  return { psbt: signed, unsignedTxDigest };
}

export function verifyCrcGuardianSignedPsbt(
  walletSignedBase64: string,
  guardianSignedBase64: string,
  network: BitcoinNetwork,
  vaultInputIndex = 0,
): { psbt: bitcoin.Psbt; unsignedTxDigest: string } {
  const wallet = parse(walletSignedBase64, network);
  const guardian = parse(guardianSignedBase64, network);
  const unsignedTxDigest = digest(wallet);
  if (digest(guardian) !== unsignedTxDigest) throw new Error("Guardian changed CRC unsigned transaction");
  samePrevouts(wallet, guardian);
  if (!Number.isSafeInteger(vaultInputIndex) || vaultInputIndex < 0 || vaultInputIndex >= guardian.data.inputs.length) {
    throw new Error("invalid CRC vault input index");
  }
  const input = guardian.data.inputs[vaultInputIndex]!;
  if (!input.finalScriptWitness || input.tapKeySig) throw new Error("Guardian CRC script-path signature is missing");
  let valid = false;
  try {
    const [signature, reveal, leaf, control] = witnessItems(Buffer.from(input.finalScriptWitness));
    if (!signature || signature.length !== 65 || signature[64] !== bitcoin.Transaction.SIGHASH_ALL) {
      throw new Error("Guardian CRC signature must use SIGHASH_ALL");
    }
    if (!leaf || !reveal || !control || control.length !== 65 || (control[0]! & 0xfe) !== 0xc0) {
      throw new Error("Guardian CRC execution control block is invalid");
    }
    const chunks = bitcoin.script.decompile(leaf);
    if (!chunks || chunks.length !== 4 || !Buffer.isBuffer(chunks[0]) || chunks[0].length !== 32 ||
      chunks[1] !== bitcoin.opcodes.OP_EQUALVERIFY || !Buffer.isBuffer(chunks[2]) ||
      chunks[2].length !== 32 || chunks[3] !== bitcoin.opcodes.OP_CHECKSIG ||
      !reveal.equals(chunks[0]) || !ecc.isXOnlyPoint(chunks[2])) {
      throw new Error("Guardian CRC execution leaf is invalid");
    }
    const leafHash = tapleafHash(leaf, 0xc0);
    const root = tapBranchHash(leafHash, control.subarray(33));
    const tweaked = tweakKey(control.subarray(1, 33), root);
    const vaultScript = input.witnessUtxo?.script;
    if (!vaultScript || vaultScript.length !== 34 || vaultScript[0] !== 0x51 || vaultScript[1] !== 0x20 ||
      !vaultScript.subarray(2).equals(tweaked.outputKey) || (control[0]! & 1) !== tweaked.parity) {
      throw new Error("Guardian CRC execution leaf does not commit to vault input");
    }
    const tx = bitcoin.Transaction.fromBuffer(guardian.data.globalMap.unsignedTx.toBuffer());
    const scripts = guardian.data.inputs.map((item) => item.witnessUtxo!.script);
    const values = guardian.data.inputs.map((item) => item.witnessUtxo!.value);
    const hash = tx.hashForWitnessV1(vaultInputIndex, scripts, values, bitcoin.Transaction.SIGHASH_ALL, leafHash);
    valid = ecc.verifySchnorr(hash, chunks[2], signature.subarray(0, 64));
  } catch { valid = false; }
  if (!valid) throw new Error("Guardian CRC script-path signature is invalid");
  for (let index = 0; index < wallet.data.inputs.length; index++) {
    if (index === vaultInputIndex) continue;
    const verified = checkSpendSignature(guardian, index);
    if (!verified.ok) throw new Error(`CRC wallet signature invalid after Guardian at input ${index}: ${verified.detail}`);
  }
  return { psbt: guardian, unsignedTxDigest };
}
