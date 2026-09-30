import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "node:crypto";
import { numsInternalKey } from "./nums.js";
import { buildExecutionLeaf } from "./leaves.js";
import { buildRecoveryLeafForProfile, sortRecoveryPubkeys, type VaultRecoveryProfile } from "./vaultProfile.js";
import { LEAF_VERSION_TAPSCRIPT, taggedHash, tapBranchHash, tapleafHash, tweakKey } from "./taproot.js";
import type { CoveVault } from "./vault.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export interface Crc20AssetIdentity {
  deploymentTag: Buffer;
  launchSalt: Buffer;
}

export function randomCrc20LaunchSalt(): Buffer {
  return randomBytes(32);
}

export function crc20DeploymentTag(markerBytes: Buffer): Buffer {
  if (markerBytes.length === 0 || markerBytes.length > 256)
    throw new Error("invalid CRC deployment marker length");
  return taggedHash("CoveCRC20Deployment/v1", markerBytes);
}

export function crc20AssetCommitment(asset: Crc20AssetIdentity): Buffer {
  if (asset.deploymentTag.length !== 32)
    throw new Error("CRC deployment tag must be 32 bytes");
  if (asset.launchSalt.length !== 32 || asset.launchSalt.every((byte) => byte === 0))
    throw new Error("CRC launch salt must be a nonzero 32-byte value");
  return taggedHash("CoveCRC20AssetVault/v1", Buffer.concat([
    asset.deploymentTag,
    asset.launchSalt,
  ]));
}

export function buildCrc20AssetVault(params: {
  asset: Crc20AssetIdentity;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
  network?: bitcoin.networks.Network;
}): CoveVault {
  if (params.guardianXOnly.length !== 32 || !ecc.isXOnlyPoint(params.guardianXOnly))
    throw new Error("invalid CRC Guardian key");
  const recoveryKeys = sortRecoveryPubkeys(params.recoveryProfile.recoveryPubkeys);
  if (recoveryKeys.some((key) => key.equals(params.guardianXOnly)))
    throw new Error("CRC Guardian and recovery keys must be distinct");
  const commitment = crc20AssetCommitment(params.asset);
  const executionScript = buildExecutionLeaf(commitment, params.guardianXOnly);
  const recoveryScript = buildRecoveryLeafForProfile(params.recoveryProfile);
  const executionHash = tapleafHash(executionScript, LEAF_VERSION_TAPSCRIPT);
  const recoveryHash = tapleafHash(recoveryScript, LEAF_VERSION_TAPSCRIPT);
  const merkleRoot = tapBranchHash(executionHash, recoveryHash);
  const numsKey = numsInternalKey();
  const { outputKey, parity } = tweakKey(numsKey, merkleRoot);
  const versionByte = LEAF_VERSION_TAPSCRIPT | parity;
  const scriptPubKey = Buffer.concat([Buffer.from([0x51, 0x20]), outputKey]);
  const network = params.network ?? bitcoin.networks.regtest;
  return {
    numsKey,
    executionLeaf: { script: executionScript, tapleafHash: executionHash },
    recoveryLeaf: { script: recoveryScript, tapleafHash: recoveryHash },
    merkleRoot,
    outputKey,
    outputParity: parity,
    scriptPubKey,
    address: bitcoin.address.toBech32(outputKey, 1, network.bech32),
    executionControlBlock: Buffer.concat([Buffer.from([versionByte]), numsKey, recoveryHash]),
    recoveryControlBlock: Buffer.concat([Buffer.from([versionByte]), numsKey, executionHash]),
  };
}
