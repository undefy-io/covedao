import { CONFIRMED_FUNDING_FOR_TESTS } from "./testFunding.js";
import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CoveChainView } from "@crclaunch/cove-covenant";
import { isSimplicityAvailable } from "@crclaunch/cove-simplicity";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { buildDeployPsbtV3, buildMintPsbtV3, RESERVE_ANCHOR_SATS } from "./builder.js";
import { GuardianV3Signer } from "./signer.js";
import { localSigningBackend } from "./custody.js";
import { LocalGuardianTransitionSigner, RemoteGuardianTransitionSigner, type GuardianRiskPolicy, type DurableAuditSink } from "./transitionSigner.js";
import { InMemorySigningJournal } from "./journal.js";
import { InProcessGuardianTransport, HttpGuardianTransport, type GuardianTransport } from "./guardianApi.js";
import type { AuditRecord } from "./types.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function xonly(byte: number): Buffer {
  return Buffer.from(ECPair.fromPrivateKey(Buffer.alloc(32, byte)).publicKey.subarray(1));
}

const guardianXOnly = xonly(0x42);
const guardianXOnlyHex = guardianXOnly.toString("hex");
const recoveryKeyXOnly = xonly(0x43);
const feeScript = Buffer.from("0014" + "f".repeat(40), "hex");
const MAINNET1: VaultRecoveryProfile = {
  profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
  recoveryCsvBlocks: 2016,
  recoveryThreshold: 2,
  recoveryPubkeys: [xonly(0x51), xonly(0x52), xonly(0x53)],
};
const riskPolicy: GuardianRiskPolicy = { maxGrossSats: 1_000_000n, maxMintAtoms: 1_000_000_000n * 100_000_000n, minMintGrossSats: 0n, maxRedeemPayoutSats: 1_000_000n, maxBackingSats: 100_000_000_000_000n, maxMinerFeeSats: 20_000n, allowedTokenIds: [], enforceTokenAllowlist: false };
const PROFILE_HASH = "ab".repeat(32);

const memoryAudit: DurableAuditSink = {
  async writeBeforeSign(_r: AuditRecord) { return { auditHash: "0".repeat(64) }; },
  async writeAfterSign() {},
};

function mintFixture(): { psbt: bitcoin.Psbt; view: CoveChainView; tokenId: string } {
  const tokenId = Buffer.from("ab".repeat(32), "hex");
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: Buffer.alloc(32, 0xab) },
    guardianXOnly, recoveryKeyXOnly, recoveryProfile: MAINNET1,
    deployerInputs: [{ txid: "a".repeat(64), vout: 0, script: Buffer.from("0014" + "c".repeat(40), "hex"), valueSats: 1_000_000n }],
    deployerChangeScript: Buffer.from("0014" + "c".repeat(40), "hex"),
    minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  const mint = buildMintPsbtV3({
    network: bitcoin.networks.regtest, tokenId, prevState: deploy.s0,
    prevBacking: { txid: "a".repeat(64), vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: 10_000n * 100_000_000n, guardianXOnly, recoveryKeyXOnly, recoveryProfile: MAINNET1,
    buyerInputs: [{ txid: "b".repeat(64), vout: 0, script: Buffer.from("0014" + "d".repeat(40), "hex"), valueSats: 1_000_000n }],
    buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
    buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
    feeScript, minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  const view = new CoveChainView();
  view.deploy({ tokenId, ticker: "FROG", policyVersion: 3, deployTxid: "a".repeat(64), tokenNonce: Buffer.alloc(32, 0xab), creatorScript: CREATOR_SCRIPT }, { txid: "a".repeat(64), vout: 1 }, deploy.s0);
  return { psbt: mint.psbt, view, tokenId: tokenId.toString("hex") };
}

function transportFor(view: CoveChainView): InProcessGuardianTransport {
  const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
  const service = new LocalGuardianTransitionSigner(localSigningBackend(signer), new InMemorySigningJournal(), memoryAudit, riskPolicy);
  return new InProcessGuardianTransport({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
    signer: service,
    profileHash: PROFILE_HASH,
    guardianXOnly: guardianXOnlyHex,
    network: "regtest",
    decode: (psbtBase64) => ({ psbt: bitcoin.Psbt.fromBase64(psbtBase64) }),
    loadView: async () => view,
    recoveryKeyXOnly,
    recoveryProfile: MAINNET1,
    feeScript,
    maxMinerFeeSats: 1_000n,
  });
}

describe("remote Guardian client (§24)", () => {
  it.skipIf(!isSimplicityAvailable())("signs a MINT through the in-process transport and independently verifies", async () => {
    const { psbt, view, tokenId } = mintFixture();
    const remote = new RemoteGuardianTransitionSigner(transportFor(view), PROFILE_HASH, guardianXOnlyHex);
    const out = await remote.signMint({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS, psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile: MAINNET1, feeScript, maxMinerFeeSats: 1_000n });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tokenId).toBe(tokenId);
      expect(out.simplicityResult).toBe("PASS");
    }
    expect(psbt.data.inputs[0]!.finalScriptWitness).toBeDefined();
  });

  it.skipIf(!isSimplicityAvailable())("rejects a spoofed service signature (independent verification)", async () => {
    const { psbt, view } = mintFixture();
    const honest = transportFor(view);
    // A malicious transport that signs a DIFFERENT sighash with a DIFFERENT key.
    const spoof: GuardianTransport = {
      health: () => honest.health(),
      sign: async (req) => {
        const res = await honest.sign(req);
        if (!res.ok) return res;
        // corrupt the signature
        const badSig = Buffer.from(ecc.signSchnorr(Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x99)));
        return { ...res, sigHex: badSig.toString("hex") };
      },
    };
    const remote = new RemoteGuardianTransitionSigner(spoof, PROFILE_HASH, guardianXOnlyHex);
    const out = await remote.signMint({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS, psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile: MAINNET1, feeScript, maxMinerFeeSats: 1_000n });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("propagates a service rejection (typed failure)", async () => {
    const { psbt, view } = mintFixture();
    const rejecting: GuardianTransport = {
      health: () => (async () => ({ reachable: true, releaseId: "x", profileHash: PROFILE_HASH, guardianXOnly: guardianXOnlyHex, auditHeadHash: "0".repeat(64), auditHealthy: true, signingJournalHealthy: true, custodyBackendReady: true, signingEnabled: true }))(),
      sign: async () => ({ ok: false, reason: "RISK_POLICY_REJECTED", detail: "gross exceeds cap" }),
    };
    const remote = new RemoteGuardianTransitionSigner(rejecting, PROFILE_HASH, guardianXOnlyHex);
    const out = await remote.signMint({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS, psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile: MAINNET1, feeScript });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("RISK_POLICY_REJECTED");
  });

  it.skipIf(!isSimplicityAvailable())("post-sign audit failure surfaces SIGNED_BUT_AUDIT_FINALIZATION_FAILED and keeps the journal reserved (§34)", async () => {
    const { psbt, view } = mintFixture();
    const journal = new InMemorySigningJournal();
    const failingAfter: DurableAuditSink = {
      async writeBeforeSign(_r: AuditRecord) { return { auditHash: "0".repeat(64) }; },
      async writeAfterSign() { throw new Error("after-sign store unavailable"); },
    };
    const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
    const local = new LocalGuardianTransitionSigner(localSigningBackend(signer), journal, failingAfter, riskPolicy);
    const out = await local.signMint({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS, psbt, view, network: "regtest", recoveryKeyXOnly, recoveryProfile: MAINNET1, feeScript, maxMinerFeeSats: 1_000n });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.auditFinalizationError).not.toBeNull();
      // A conflicting digest for the SAME backing outpoint must still be refused.
      const conflict = await journal.reserve({
        network: "regtest",
        backingTxid: out.backingOutpoint.txid,
        backingVout: out.backingOutpoint.vout,
        unsignedTxDigest: "ff".repeat(32),
      });
      expect(conflict).toBe("CONFLICT");
    }
  });

  it("uses the service's configured network, not the client's claimed network (§C3)", async () => {
    let receivedNetwork: string | undefined;
    const signer = {
      signMint: async (req: { network: string }) => { receivedNetwork = req.network; return { ok: false as const, reason: "x", detail: "x" }; },
      signRedeem: async () => ({ ok: false as const, reason: "x", detail: "x" }),
    };
    const transport = new InProcessGuardianTransport({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      profileHash: PROFILE_HASH,
      guardianXOnly: guardianXOnlyHex,
      network: "mainnet", // the SERVICE's configured network
      decode: (psbtBase64) => ({ psbt: bitcoin.Psbt.fromBase64(psbtBase64) }),
      loadView: async () => new CoveChainView(),
      recoveryKeyXOnly,
      recoveryProfile: MAINNET1,
      feeScript,
      maxMinerFeeSats: 1_000n,
    });
    const empty = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    await transport.sign({
      requestId: "x",
      operation: "MINT",
      network: "regtest", // the CLIENT's claimed network (must be ignored)
      psbtBase64: empty.toBase64(),
      tokenId: "ab".repeat(32),
    });
    expect(receivedNetwork).toBe("mainnet");
  });

  it("enforces https for the HTTP transport (§C15)", () => {
    expect(() => new HttpGuardianTransport("http://guardian.example.com", "t")).toThrow(/https/);
    expect(() => new HttpGuardianTransport("https://guardian.example.com", "t")).not.toThrow();
    expect(() => new HttpGuardianTransport("http://localhost:4391", "t")).not.toThrow();
  });

  it("allows plain http only on Railway's private network, and always needs a token", () => {
    expect(() => new HttpGuardianTransport("http://guardian.railway.internal:4391", "t")).not.toThrow();
    expect(() => new HttpGuardianTransport("http://guardian.railway.internal.evil.com:4391", "t")).toThrow(/https/);
    expect(() => new HttpGuardianTransport("http://railway.internal.example.com", "t")).toThrow(/https/);
    expect(() => new HttpGuardianTransport("ftp://guardian.railway.internal", "t")).toThrow(/https/);
    expect(() => new HttpGuardianTransport("http://guardian.railway.internal:4391", "")).toThrow(/bearer token/);
    expect(() => new HttpGuardianTransport("https://guardian.example.com", "")).toThrow(/bearer token/);
  });

  it("/health reports the live probe, and signing is enabled only when custody, audit and journal are all ready", async () => {
    const probe = { releaseId: "abc", auditHeadHash: "11".repeat(32), auditHealthy: true, signingJournalHealthy: true, custodyBackendReady: true };
    const mk = (p: typeof probe) => {
      const t = transportFor(new CoveChainView());
      (t as unknown as { opts: { healthProbe: () => Promise<typeof probe> } }).opts.healthProbe = async () => p;
      return t;
    };
    expect(await mk(probe).health()).toMatchObject({ releaseId: "abc", auditHeadHash: "11".repeat(32), custodyBackendReady: true, signingEnabled: true });
    expect((await mk({ ...probe, custodyBackendReady: false }).health()).signingEnabled).toBe(false);
    expect((await mk({ ...probe, auditHealthy: false }).health()).signingEnabled).toBe(false);
    expect((await mk({ ...probe, signingJournalHealthy: false }).health()).signingEnabled).toBe(false);
  });
});
