import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { describe, expect, it } from "vitest";
import { buildCrc20AssetVault, crc20DeploymentTag, randomCrc20LaunchSalt } from "./crc20-vault.js";
import { dev1RecoveryProfile } from "./vaultProfile.js";

const key = (byte: number) => Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, byte), true)!).subarray(1);
const guardianXOnly = key(0x41);
const ownerXOnly = key(0x42);
const recoveryProfile = dev1RecoveryProfile(ownerXOnly);
const asset = {
  deploymentTag: Buffer.alloc(32, 0x43),
  launchSalt: Buffer.alloc(32, 0x45),
};

describe("Cove CRC-20 vault commitment", () => {
  it("matches the cross-repository deploy vault golden vector", () => {
    const marker = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","lim":"2100000000000000","leaf":"0","ordi":"0","btc":"1"}');
    const vault = buildCrc20AssetVault({
      asset: { deploymentTag: crc20DeploymentTag(marker), launchSalt: Buffer.alloc(32, 0x45) },
      guardianXOnly: Buffer.from("eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619", "hex"),
      recoveryProfile: dev1RecoveryProfile(Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex")),
      network: bitcoin.networks.regtest,
    });
    expect(vault.scriptPubKey.toString("hex")).toBe("5120d2077e5d3c767afc901f52343eba1076b3bd3b8a0ecaf736bf14c0417b5d8e5c");
  });
  it("derives an initial asset tag from the deploy marker without a circular txid dependency", () => {
    const marker = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE"}');
    expect(crc20DeploymentTag(marker).equals(crc20DeploymentTag(marker))).toBe(true);
    expect(crc20DeploymentTag(marker).equals(crc20DeploymentTag(Buffer.from('{"p":"crc-20","op":"deploy","tick":"OTHER"}')))).toBe(false);
    expect(crc20DeploymentTag(marker)).toHaveLength(32);
  });
  it("derives a stable address and a Guardian execution leaf from canonical state", () => {
    const a = buildCrc20AssetVault({ asset, guardianXOnly, recoveryProfile, network: bitcoin.networks.regtest });
    const b = buildCrc20AssetVault({ asset, guardianXOnly, recoveryProfile, network: bitcoin.networks.regtest });
    expect(a.scriptPubKey.equals(b.scriptPubKey)).toBe(true);
    expect(a.executionLeaf.script.includes(guardianXOnly)).toBe(true);
    expect(a.executionControlBlock.length).toBe(65);
    expect(a.address.startsWith("bcrt1p")).toBe(true);
  });

  it("changes the vault script when immutable asset identity changes", () => {
    const base = buildCrc20AssetVault({ asset, guardianXOnly, recoveryProfile });
    for (const changed of [
      { ...asset, deploymentTag: Buffer.alloc(32, 0x44) },
      { ...asset, launchSalt: Buffer.alloc(32, 0x46) },
    ]) {
      expect(buildCrc20AssetVault({ asset: changed, guardianXOnly, recoveryProfile }).scriptPubKey.equals(base.scriptPubKey)).toBe(false);
    }
  });

  it("separates two launches with identical deploy marker bytes", () => {
    const marker = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE"}');
    const deploymentTag = crc20DeploymentTag(marker);
    const a = buildCrc20AssetVault({ asset: { ...asset, deploymentTag, launchSalt: Buffer.alloc(32, 0x45) }, guardianXOnly, recoveryProfile });
    const b = buildCrc20AssetVault({ asset: { ...asset, deploymentTag, launchSalt: Buffer.alloc(32, 0x46) }, guardianXOnly, recoveryProfile });
    expect(a.scriptPubKey.equals(b.scriptPubKey)).toBe(false);
    expect(randomCrc20LaunchSalt()).toHaveLength(32);
    expect(randomCrc20LaunchSalt().equals(randomCrc20LaunchSalt())).toBe(false);
  });

  it("requires distinct valid keys and nonzero launch salt", () => {
    expect(() => buildCrc20AssetVault({ asset, guardianXOnly, recoveryProfile: dev1RecoveryProfile(guardianXOnly) })).toThrow(/distinct/i);
    expect(() => buildCrc20AssetVault({ asset: { ...asset, launchSalt: Buffer.alloc(32) }, guardianXOnly, recoveryProfile })).toThrow(/salt/i);
  });
});
