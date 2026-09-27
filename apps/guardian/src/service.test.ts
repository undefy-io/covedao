import { describe, expect, it } from "vitest";
import type { MainnetProfile } from "@crclaunch/cove-mainnet";
import { guardMainnetSigning, riskPolicyFromProfile } from "./service.js";
import type { GuardianTransport } from "@crclaunch/cove-guardian/v3";

const profile: MainnetProfile = {
  profileVersion: 1,
  chainIdentity: "bitcoin-mainnet",
  activationHeight: 900_000n,
  policyVersion: 3,
  vaultProfileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
  guardianXOnly: "11".repeat(32),
  recovery: { threshold: 2, pubkeys: ["21".repeat(32), "31".repeat(32), "41".repeat(32)], csvBlocks: 2016 },
  feeScript: "0014" + "55".repeat(20),
  buyFeeBps: 100,
  redeemFeeBps: 100,
  p2pFeeBps: 50,
  carrierSats: 1000n,
  anchorSats: 10_000n,
  maxProtocolSupplyAtoms: 21_000_000n * 100_000_000n,
  reserveAllocationAtoms: 0n,
  mintCmr: "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
  redeemCmr: "37e681b3e70a34acc3b38680c06fbe4f1b2799bede2607c6c9ed7fcac8c95d56",
  canary: {
    allowedWalletScripts: ["0014" + "66".repeat(20)],
    allowedTokenIds: ["ab".repeat(32)],
    maxBackingSats: 1_000_000n,
    maxSingleBuySats: 200_000n,
    maxSingleRedeemPayoutSats: 200_000n,
    maxP2pSettlementSats: 200_000n,
    maxMintAtoms: 2_100_000n * 100_000_000n,
    minMintGrossSats: 5_000n,
  },
};

describe("riskPolicyFromProfile (P0-2/P0-4)", () => {
  it("builds the policy from the committed profile caps, not env", () => {
    const p = riskPolicyFromProfile(profile);
    expect(p.maxGrossSats).toBe(200_000n); // maxSingleBuySats
    expect(p.maxRedeemPayoutSats).toBe(200_000n); // maxSingleRedeemPayoutSats
    expect(p.maxBackingSats).toBe(1_000_000n); // maxBackingSats
    expect(p.allowedTokenIds).toEqual(["ab".repeat(32)]);
    expect(p.enforceTokenAllowlist).toBe(true);
    expect(p.maxMinerFeeSats).toBe(20_000n); // fixed operational cap
  });

  it("fails closed: an empty allowlist yields a policy that rejects every token", () => {
    const p = riskPolicyFromProfile({ ...profile, canary: { ...profile.canary, allowedTokenIds: [] } });
    expect(p.enforceTokenAllowlist).toBe(true);
    expect(p.allowedTokenIds).toEqual([]);
  });
});

describe("mainnet signing switch", () => {
  it("blocks direct sign calls and reports signing disabled while disarmed", async () => {
    let signs = 0;
    const transport = {
      health: async () => ({ reachable: true, releaseId: "test", profileHash: "aa".repeat(32),
        guardianXOnly: "bb".repeat(32), auditHeadHash: "0".repeat(64), auditHealthy: true,
        signingJournalHealthy: true, custodyBackendReady: true, signingEnabled: true }),
      sign: async () => { signs++; return { ok: false, reason: "fake", detail: "fake" }; },
    } satisfies GuardianTransport;
    const paused = guardMainnetSigning(transport, "mainnet", false);
    expect((await paused.health()).signingEnabled).toBe(false);
    expect(await paused.sign({} as never)).toMatchObject({ ok: false, reason: "MAINNET_DISABLED" });
    expect(signs).toBe(0);
    await guardMainnetSigning(transport, "mainnet", true).sign({} as never);
    expect(signs).toBe(1);
  });
});

describe("per-mint risk limits come from the profile", () => {
  it("uses the committed numbers rather than a constant in the code", () => {
    const raised = { ...profile, canary: { ...profile.canary, maxMintAtoms: 4_200_000n * 100_000_000n, minMintGrossSats: 9_000n } };
    const policy = riskPolicyFromProfile(raised);
    expect(policy.maxMintAtoms).toBe(4_200_000n * 100_000_000n);
    expect(policy.minMintGrossSats).toBe(9_000n);
  });
});
