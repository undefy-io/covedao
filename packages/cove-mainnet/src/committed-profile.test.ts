import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { s0StateV2 } from "@crclaunch/cove-covenant";
import { committedMainnetProfile, MAINNET_PROFILES_PATH, resolveMainnetProfile } from "./committed-profile.js";
import { loadMainnetProfile, parseMainnetProfileJson, validateMainnetProfile, type MainnetProfile } from "./profile.js";
import { KNOWN_TEST_KEY_BYTES, isKnownTestPrivateKeyHex, isKnownTestScript, isKnownTestXOnly } from "./test-keys.js";

const ROOT = resolve(process.cwd(), "../..");
const FIXTURE = resolve(ROOT, "test/fixtures/mainnet-profile.json");
const xOnlyOf = (b: number) => Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, b), true)!.subarray(1)).toString("hex");

describe("committed mainnet profile", () => {
  it("parses, hashes, and FAILS validation until the owner decisions are filled in", () => {
    const c = committedMainnetProfile();
    expect(c.profile.chainIdentity).toBe("bitcoin-mainnet");
    expect(c.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.validation.ok).toBe(false);
    for (const d of ["activationHeight", "guardianXOnly", "recovery.pubkeys", "recovery.csvBlocks", "feeScript", "buyFeeBps"]) {
      expect(c.validation.errors).toContain(`OWNER_DECISION_REQUIRED: ${d}`);
    }
    // No frozen-protocol drift: the only failures are owner decisions.
    expect(c.validation.errors.filter((e) => !e.startsWith("OWNER_DECISION_REQUIRED"))).toEqual([]);
  });

  it("is plain TOML with no private key material", () => {
    expect(() => readFileSync(MAINNET_PROFILES_PATH, "utf8")).not.toThrow();
    expect(readFileSync(MAINNET_PROFILES_PATH, "utf8")).not.toMatch(/priv|secret|wif/i);
  });
});

describe("known test keys are refused on mainnet (§8)", () => {
  it("the fixture profile, built from test keys, no longer validates as mainnet", () => {
    const { validation } = loadMainnetProfile(FIXTURE);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.startsWith("TEST_KEY_IN_PROFILE"))).toBe(true);
  });

  it("…but does with the explicit test-only bypass", () => {
    expect(loadMainnetProfile(FIXTURE, { allowTestKeys: true }).validation).toEqual({ ok: true, errors: [] });
  });

  it("recognises test x-only keys and every standard script they control", () => {
    for (const b of KNOWN_TEST_KEY_BYTES) {
      expect(isKnownTestXOnly(xOnlyOf(b))).toBe(true);
      expect(isKnownTestPrivateKeyHex(b.toString(16).repeat(32))).toBe(true);
      const pubkey = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, b), true)!);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey });
      expect(isKnownTestScript(p2wpkh.output!.toString("hex"))).toBe(true);
      expect(isKnownTestScript(bitcoin.payments.p2pkh({ pubkey }).output!.toString("hex"))).toBe(true);
      expect(isKnownTestScript(bitcoin.payments.p2sh({ redeem: p2wpkh }).output!.toString("hex"))).toBe(true);
    }
    expect(isKnownTestXOnly("12".repeat(32))).toBe(false);
    expect(isKnownTestPrivateKeyHex("12".repeat(32))).toBe(false);
  });

  it("stays in sync with scripts/check-secrets.mjs", () => {
    const src = readFileSync(resolve(ROOT, "scripts/check-secrets.mjs"), "utf8");
    const list = /TEST_KEY_HEXES = \[([^\]]*)\]/.exec(src)![1]!.match(/[0-9a-f]{2}/gi)!.map((h) => parseInt(h, 16));
    expect([...list].sort()).toEqual([...KNOWN_TEST_KEY_BYTES].sort());
  });
});

describe("recovery 1-of-1 (§7)", () => {
  function withRecovery(threshold: number, pubkeys: string[]): MainnetProfile {
    const p = parseMainnetProfileJson(readFileSync(FIXTURE, "utf8"));
    return { ...p, recovery: { threshold, pubkeys, csvBlocks: 2016 } };
  }
  const R1 = "12".repeat(32);

  it("accepts 1-of-1 and 2-of-3; refuses other shapes", () => {
    const three = parseMainnetProfileJson(readFileSync(FIXTURE, "utf8")).recovery.pubkeys;
    expect(validateMainnetProfile(withRecovery(1, [R1]), { allowTestKeys: true }).ok).toBe(true);
    expect(validateMainnetProfile(withRecovery(2, three), { allowTestKeys: true }).ok).toBe(true);
    expect(validateMainnetProfile(withRecovery(1, three), { allowTestKeys: true }).errors.join()).toMatch(/INVALID_RECOVERY_KEYS/);
    expect(validateMainnetProfile(withRecovery(2, [R1]), { allowTestKeys: true }).errors.join()).toMatch(/INVALID_RECOVERY_KEYS/);
    expect(validateMainnetProfile(withRecovery(3, three), { allowTestKeys: true }).errors.join()).toMatch(/INVALID_RECOVERY_THRESHOLD/);
  });

  it("still refuses the Guardian key as the single recovery key, and test keys", () => {
    const p = withRecovery(1, [R1]);
    expect(validateMainnetProfile({ ...p, recovery: { ...p.recovery, pubkeys: [p.guardianXOnly!] } }, { allowTestKeys: true }).errors).toContain("GUARDIAN_KEY_IN_RECOVERY_SET");
    expect(validateMainnetProfile({ ...p, recovery: { ...p.recovery, pubkeys: [xOnlyOf(0x43)] } }).errors.join()).toMatch(/TEST_KEY_IN_PROFILE: recovery key/);
  });

  it("builds a 1-of-1 MAINNET1 vault whose recovery leaf is <csv> CSV DROP <K> CHECKSIG 1 NUMEQUAL", () => {
    const vault = buildBackingVaultV3({
      state: s0StateV2({ tokenId: "ab".repeat(32) }),
      guardianXOnly: Buffer.from(xOnlyOf(0x42), "hex"),
      recoveryKeyXOnly: Buffer.from(R1, "hex"),
      recoveryProfile: {
        profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
        recoveryCsvBlocks: 2016,
        recoveryThreshold: 1,
        recoveryPubkeys: [Buffer.from(R1, "hex")],
      },
      network: bitcoin.networks.bitcoin,
    });
    expect(vault.scriptPubKey.subarray(0, 2).toString("hex")).toBe("5120");
    const asm = bitcoin.script.toASM(vault.recoveryLeaf.script);
    expect(asm).toBe(`e007 OP_CHECKSEQUENCEVERIFY OP_DROP ${R1} OP_CHECKSIG OP_1 OP_NUMEQUAL`);
  });
});

describe("resolveMainnetProfile", () => {
  it("uses the committed profile by default", () => {
    expect(resolveMainnetProfile({ network: "mainnet" }).source).toBe("committed");
  });
  it("uses a test-only profile off mainnet, with the test-key bypass", () => {
    const r = resolveMainnetProfile({ network: "regtest", testOnlyPath: resolve(ROOT, "packages/cove-mainnet/profiles.toml") });
    expect(r.source).toBe("test-only");
    expect(r.validation.ok).toBe(true);
  });
  it("refuses a test-only profile on mainnet", () => {
    expect(() => resolveMainnetProfile({ network: "mainnet", testOnlyPath: resolve(ROOT, "packages/cove-mainnet/profiles.toml") })).toThrow(/refused on mainnet/);
  });
});

describe("fee address from COVE_FEE_ADDRESS", () => {
  const feeAddress = bitcoin.address.fromOutputScript(Buffer.from(`0014${"11".repeat(20)}`, "hex"), bitcoin.networks.bitcoin);

  it("fills feeScript, and a different address gives a different profile hash", () => {
    const withFee = committedMainnetProfile({ feeAddress });
    expect(withFee.profile.feeScript).toBe(`0014${"11".repeat(20)}`);
    expect(withFee.validation.errors).not.toContain("OWNER_DECISION_REQUIRED: feeScript");
    expect(withFee.profileHash).not.toBe(committedMainnetProfile().profileHash);
    const other = bitcoin.address.fromOutputScript(Buffer.from(`0014${"22".repeat(20)}`, "hex"), bitcoin.networks.bitcoin);
    expect(committedMainnetProfile({ feeAddress: other }).profileHash).not.toBe(withFee.profileHash);
    expect(resolveMainnetProfile({ network: "mainnet", feeAddress }).profileHash).toBe(withFee.profileHash);
  });

  it("refuses an address from another network", () => {
    const testnet = bitcoin.address.fromOutputScript(Buffer.from(`0014${"11".repeat(20)}`, "hex"), bitcoin.networks.testnet);
    expect(() => committedMainnetProfile({ feeAddress: testnet })).toThrow(/COVE_FEE_ADDRESS/);
    expect(() => committedMainnetProfile({ feeAddress: "not-an-address" })).toThrow(/COVE_FEE_ADDRESS/);
  });

  it("refuses the address of a public test key", () => {
    const pub = ecc.pointFromScalar(Buffer.alloc(32, 0x44), true)!;
    const testKeyAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub), network: bitcoin.networks.bitcoin }).address!;
    const { validation } = committedMainnetProfile({ feeAddress: testKeyAddress });
    expect(validation.errors).toContain("TEST_KEY_IN_PROFILE: feeScript");
  });
});
