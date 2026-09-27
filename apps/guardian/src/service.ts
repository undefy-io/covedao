import * as bitcoin from "bitcoinjs-lib";
import { createDb } from "@crclaunch/db";
import type { MainnetProfile, ResolvedMainnetProfile } from "@crclaunch/cove-mainnet";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  LocalGuardianTransitionSigner,
  custodySigningBackend,
  InProcessGuardianTransport,
  chainFundingChecker,
  ordAssetLookup,
  type GuardianCustodyBackend,
  type GuardianSigningBackend,
  type GuardianRiskPolicy,
  type GuardianTransport,
} from "@crclaunch/cove-guardian/v3";
import { loadCanonicalViewSnapshotFromDb, getLiveTokenUtxosAtDb } from "@crclaunch/cove-indexer/v3";
import { PostgresSigningJournal, PostgresGuardianAudit } from "@crclaunch/cove-app";
import type { Database } from "@crclaunch/db";

/**
 * Guardian SERVICE bootstrap (Phase 8.1 §18-§20). Loads the canonical public
 * profile, builds the custody signing backend + durable audit/journal + risk
 * policy, and wraps them in an in-process transport that reconstructs the
 * canonical view from the Guardian's OWN Postgres DB (never trusting the app).
 */

export interface GuardianServiceConfig {
  /** The committed profile (or, in regtest CI, a test-only one); see boot.ts. */
  profile: ResolvedMainnetProfile;
  /** Reported by /health (e.g. the deployed commit). */
  releaseId: string;
  databaseUrl: string;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  /** Mainnet signer pause switch; false until the operator arms the canary. */
  signingArmed?: boolean;
  custodyBackend: GuardianCustodyBackend;
  /**
   * The Guardian's OWN Bitcoin Core, used to refuse unconfirmed funding
   * inputs. Never the app's: a compromised app could lie about confirmations.
   */
  coreRpc: { url: string; user?: string; password?: string };
  /** ord server (with --index-runes) for inscriptions and runes. Required on mainnet. */
  ordUrl?: string;
}

/** Fixed miner-fee cap (operational; not profile-driven — there is no canary fee cap). */
const MAX_MINER_FEE_SATS = 20_000n;

export interface BuiltGuardianService {
  transport: GuardianTransport;
  profile: MainnetProfile;
  profileHash: string;
  guardianXOnly: string;
  /** The Guardian's own node, for the startup chain check. */
  core: CoreRpcProvider;
}

export function guardMainnetSigning(transport: GuardianTransport, network: string, armed: boolean): GuardianTransport {
  if (network !== "mainnet" || armed) return transport;
  return {
    health: async () => ({ ...await transport.health(), signingEnabled: false }),
    sign: async () => ({ ok: false, reason: "MAINNET_DISABLED", detail: "mainnet signing is not armed" }),
  };
}

export function recoveryProfileFromMainnet(profile: MainnetProfile): VaultRecoveryProfile {
  const n = profile.recovery.pubkeys.length;
  const shapeOk = (profile.recovery.threshold === 2 && n === 3) || (profile.recovery.threshold === 1 && n === 1);
  if (!shapeOk || profile.recovery.csvBlocks == null) {
    throw new Error("mainnet profile recovery is incomplete");
  }
  return {
    profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
    recoveryCsvBlocks: profile.recovery.csvBlocks,
    recoveryThreshold: profile.recovery.threshold,
    recoveryPubkeys: profile.recovery.pubkeys.map((k) => Buffer.from(k, "hex")),
  };
}

/**
 * Build the risk policy from the COMMITTED profile (never env). Non-null caps
 * are guaranteed by validateMainnetProfile.
 *
 * The per-mint bounds used to be hardcoded here while every other cap came
 * from the profile. That made them invisible to the profile hash the operator
 * signs off and to the operator themselves: changing the profile changed
 * nothing, and the committed hash said nothing about the limit that decides
 * how much a compromised API could mint in one transaction.
 */
export function riskPolicyFromProfile(profile: MainnetProfile): GuardianRiskPolicy {
  return {
    maxGrossSats: profile.canary.maxSingleBuySats!,
    maxMintAtoms: profile.canary.maxMintAtoms!,
    minMintGrossSats: profile.canary.minMintGrossSats!,
    maxRedeemPayoutSats: profile.canary.maxSingleRedeemPayoutSats!,
    maxBackingSats: profile.canary.maxBackingSats!,
    maxMinerFeeSats: MAX_MINER_FEE_SATS,
    allowedTokenIds: profile.canary.allowedTokenIds,
    enforceTokenAllowlist: true,
  };
}

export function buildGuardianService(config: GuardianServiceConfig): BuiltGuardianService {
  if (config.network === "mainnet" && !config.ordUrl) {
    throw new Error("mainnet needs an ord server (committed network settings): funding inputs must be checked for inscriptions and runes");
  }
  const { profile, validation, profileHash } = config.profile;
  if (!validation.ok) {
    throw new Error(`invalid mainnet profile: ${validation.errors.join("; ")}`);
  }
  if (profile.guardianXOnly == null || profile.feeScript == null) {
    throw new Error("mainnet profile is missing guardianXOnly/feeScript");
  }
  const guardianXOnly = profile.guardianXOnly;
  const recoveryProfile = recoveryProfileFromMainnet(profile);
  const recoveryKeyXOnly = recoveryProfile.recoveryPubkeys[0]!; // unused for MAINNET1
  const feeScript = Buffer.from(profile.feeScript, "hex");
  const riskPolicy = riskPolicyFromProfile(profile);

  const db: Database = createDb(config.databaseUrl);
  const core = new CoreRpcProvider(config.coreRpc);
  const fundingChecker = chainFundingChecker({
    chain: core,
    isCoveCarrier: async (o) => (await getLiveTokenUtxosAtDb(db, config.network, [o])).length > 0,
    assets: config.ordUrl ? ordAssetLookup(config.ordUrl) : undefined,
  });
  const signingBackend: GuardianSigningBackend = custodySigningBackend(config.custodyBackend);
  const journal = new PostgresSigningJournal(db);
  const audit = new PostgresGuardianAudit(db, "COVE_V3_VAULT_PROFILE_MAINNET1");
  const signer = new LocalGuardianTransitionSigner(signingBackend, journal, audit, riskPolicy);

  // /health reports what a signature actually needs, probed live — not the
  // in-process fixture's hard-coded "all green".
  const healthProbe = async () => {
    let custodyBackendReady = false;
    try {
      custodyBackendReady = (await config.custodyBackend.xOnlyPubkey()).toString("hex") === guardianXOnly.toLowerCase();
    } catch {
      custodyBackendReady = false; // unconfigured backend throws
    }
    let auditHeadHash = "";
    let auditHealthy = false;
    try {
      auditHeadHash = await audit.verifiedHeadHash(config.network);
      auditHealthy = true;
    } catch {
      auditHealthy = false;
    }
    let signingJournalHealthy = false;
    try {
      await journal.probe(config.network);
      signingJournalHealthy = true;
    } catch {
      signingJournalHealthy = false;
    }
    return { releaseId: config.releaseId, auditHeadHash, auditHealthy, signingJournalHealthy, custodyBackendReady };
  };

  const innerTransport = new InProcessGuardianTransport({
    signer,
    profileHash,
    guardianXOnly,
    network: config.network,
    decode: (psbtBase64) => ({ psbt: bitcoin.Psbt.fromBase64(psbtBase64) }),
    loadView: async (tokenId) => {
      const view = await loadCanonicalViewSnapshotFromDb({ db, network: config.network, tokenId });
      if (view.rebuilding) throw new Error("Guardian indexer view is rebuilding");
      const tip = await core.getBlockchainInfo();
      if (view.cursorHeight > BigInt(tip.blocks)) throw new Error("Guardian indexer cursor is ahead of Core");
      if (view.cursorHeight > 0n && await core.getBlockHash(Number(view.cursorHeight)) !== view.cursorBlockHash) {
        throw new Error("Guardian indexer cursor diverged from Core");
      }
      return view;
    },
    recoveryKeyXOnly,
    recoveryProfile,
    feeScript,
    maxMinerFeeSats: MAX_MINER_FEE_SATS,
    // §P1-4: the fee schedule is the COMMITTED profile's, not the dev defaults.
    buyFeeBps: BigInt(profile.buyFeeBps!),
    redeemFeeBps: BigInt(profile.redeemFeeBps!),
    fundingChecker,
    healthProbe,
  });

  const transport = guardMainnetSigning(innerTransport, config.network, config.signingArmed === true);

  return { transport, profile, profileHash, guardianXOnly, core };
}
