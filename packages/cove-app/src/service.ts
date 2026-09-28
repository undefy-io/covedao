import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { schema, getSubmission, prepareSubmission, claimSubmission, saveSignedSubmission, publishSubmission, deferSubmission, dueSubmissions, haltSubmission, resumeSubmission, SubmissionError, type Submission, type Database } from "@crclaunch/db";
import { isRpcNotFound, broadcastRecordedTransaction, type CoreRpcProvider } from "@crclaunch/bitcoin";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { TOKEN_CARRIER_SATS, applyMintV2, applyRedeemV2, stateHashV2, type CoveStateV2, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  RESERVE_ANCHOR_SATS,
  decodeCoveOpReturnTx,
  type ValidatedCoveTransaction,
  type ResolvedInput,
  type GuardianTransitionSigner,
  type TransitionSignRequest,
  validateMintTransitionV3,
  validateRedeemTransitionV3,
  chainFundingChecker,
  ordAssetLookup,
  type AssetLookup,
  type FundingInputChecker,
} from "@crclaunch/cove-guardian/v3";
import { loadCanonicalViewSnapshotFromDb, computeHealth, getTokenUtxosByScriptDb, getLiveTokenUtxosAtDb } from "@crclaunch/cove-indexer/v3";
import { grossBuy, grossRedeem, mintFeeSats, redeemFeeSats, creatorFeeSats, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, checkRedeemPayout } from "@crclaunch/cove-economics";
import { ATOMS_PER_TOKEN, LOT_TOKENS, PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";
import { canonicalTicker, computeTokenId, OP_MINT, OP_REDEEM, type ParsedEnvelopeV2 } from "@crclaunch/cove-wire";
import {
  MarketService,
  publicListing,
  defaultMarketConfig,
  mainnetMarketConfig,
  listingIdOf,
  cancellationHashOf,
  cancellationMessageToSign,
  getBuyRoutes,
  getSellOptions,
  type ListingV1,
} from "@crclaunch/cove-market";
import { indexedBackingConflict } from "./backing-conflict.js";
import { AppError } from "./errors.js";
import { DEV_RISK_POLICY } from "./transition-signer.js";
import type { V3AppConfig, V3Network } from "./config.js";
import { checkCoreAgreement, verifyMainnetGenesis } from "./readiness.js";
import { unsignedTxDigest, parsePsbt, btcNetwork, validateInputSignature, walletDeltaSats } from "./psbt.js";
import { resolveFundingUtxos, type FundingCandidate, type ResolvedFunding } from "./funding.js";
import {
  resolveWalletIdentity,
  walletIdentityFrom,
  type ResolvedWalletIdentity,
} from "./wallet-identity.js";
import {
  estimateOperationVsize,
  resolveMinerFee,
  FeeError,
  type CoveOperation,
  type FeeRates,
} from "./fees.js";
import {
  createTxSession,
  requireTxSession,
  updateTxSession,
  listSubmittedSpendsOfBacking,
  type TxSessionRow,
} from "./tx-session.js";
import { upsertTokenMetadata, validateMetadata, type TokenMetadataInput } from "./metadata.js";
import { listV3Tokens, getV3TokenDetail, getTokenHolders, getTokenActivity } from "./token-read.js";
import { getWalletPortfolio } from "./wallet-read.js";
import { getV3Status } from "./health.js";
import { readFeeObservation } from "./runtime-snapshot.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export interface LaunchPrepareInput {
  ticker: string;
  displayName: string;
  description: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  imageUrl?: string | null;
  nonceHex?: string;
  /** The creator's payout script (hex). The tokenId commits to it. */
  creatorScript?: string;
}

export interface LaunchPrepareResult {
  /** Null until the creator script is known (see LaunchPrepareInput). */
  tokenId: string | null;
  ticker: string;
  nonceHex: string;
  policyVersion: number;
  chainIdentity: string;
  publicCapAtoms: bigint;
  /**
   * The only supply that exists. applyMintV2 caps issuance at PUBLIC_SUPPLY_ATOMS
   * and there is no code path that mints beyond it, so this IS the total — there
   * is no separate protocol reserve to report.
   */
  publicSupplyAtoms: bigint;
  curve: string;
  vaultAnchorSats: bigint;
  /** Paid to the protocol by every launch (DEPLOY output 3). */
  launchFeeSats: bigint;
}

export interface BackingQuote {
  tokenId: string;
  amountAtoms: bigint;
  stateHash: string;
  backingOutpoint: { txid: string; vout: number };
  supplyBeforeAtoms: bigint;
  supplyAfterAtoms: bigint;
  backingBeforeSats: bigint;
  backingAfterSats: bigint;
  grossSats: bigint;
  feeSats: bigint;
  /** The creator's share, paid on top of the curve price. */
  creatorFeeSats: bigint;
  feeBps: bigint;
  indexedHeight: bigint;
  indexedBlockHash: string;
  expiresAtHeight: bigint;
}

export interface RedeemQuote {
  tokenId: string;
  amountAtoms: bigint;
  stateHash: string;
  backingOutpoint: { txid: string; vout: number };
  supplyBeforeAtoms: bigint;
  supplyAfterAtoms: bigint;
  backingBeforeSats: bigint;
  backingAfterSats: bigint;
  grossSats: bigint;
  feeSats: bigint;
  netSats: bigint;
}

export interface IntentV3 {
  operation: "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER";
  tokenId: string | null;
  tokenAmountAtoms: bigint | null;
  grossSats: bigint | null;
  protocolFeeSats: bigint | null;
  /** Mint only: the creator's share and where it is paid. */
  creatorFeeSats?: bigint;
  creatorScript?: string;
  minerFeeSats: bigint;
  netSats: bigint | null;
  /** The payments scriptPubKey: where BTC comes from and change returns. */
  walletScript: string;
  /** The ordinals scriptPubKey: where token carriers live. */
  ordinalsScript: string;
  stateHash: string | null;
  unsignedTxDigest: string;
  /**
   * Net satoshis this transaction adds to (+) or takes from (−) the wallet,
   * across BOTH of its addresses, measured from the PSBT itself. The browser
   * re-derives the same figure from the price it displayed and refuses to sign
   * if the two disagree.
   */
  walletDeltaSats: bigint;
}

interface BackingRow {
  state: CoveStateV2;
  stateHash: string;
  input: ResolvedInput;
}

/**
 * Token carriers a single REDEEM may consume. Bounds transaction size; a holder
 * whose balance is spread wider consolidates first with a self-transfer.
 */
const MAX_REDEEM_TOKEN_INPUTS = 4;

/** Wire-v2 TRANSFER allows at most four allocations, so at most four carriers. */
const MAX_TRANSFER_TOKEN_INPUTS = 4;

/** Default life of a P2P ask: roughly one week at ten-minute blocks. */
const DEFAULT_LISTING_BLOCKS = 1_008n;

/**
 * How far to chain unconfirmed vault transitions.
 *
 * Bitcoin Core's default mempool policy allows a package of 25 transactions, so
 * a 26th would be rejected as `too-long-mempool-chain`. Stopping one short of
 * the limit leaves room for the buyer's own funding transaction if it is itself
 * unconfirmed.
 */
const MAX_PENDING_BACKING_CHAIN = 24;

/** The successor vault is always output 1 of a MINT or REDEEM. */
const BACKING_SUCCESSOR_VOUT = 1;

/**
 * Refuse a redemption that cannot pay out.
 *
 * The exit fee is FLAT, so a small enough sale is worth less than the fee and
 * the payout goes negative. That used to reach the PSBT builder and fail deep
 * down with nothing the user could act on.
 */
function assertRedeemPayoutIsPayable(params: {
  grossSats: bigint;
  feeSats: bigint;
  payoutScript: Buffer;
}): void {
  const check = checkRedeemPayout(params.grossSats, params.feeSats, params.payoutScript);
  if (check.isPayable) return;
  throw new AppError(
    "ECONOMIC_DUST",
    `this sale is worth ${check.grossSats} sats and the exit fee is ${check.feeSats} sats, ` +
      `so it would pay out ${check.netSats} sats. A sale has to be worth at least ` +
      `${check.minimumGrossSats} sats to be worth making. Sell a larger amount.`,
  );
}

export class V3AppService {
  readonly market: MarketService;
  /**
   * Funding inputs must be confirmed and hold no tokens of any kind: Core for
   * confirmation, the Cove index for carriers of every token, and ord (when
   * configured; required on mainnet) for inscriptions and runes.
   */
  readonly fundingChecker: FundingInputChecker;
  private readonly assets: AssetLookup | null;

  constructor(
    readonly db: Database,
    readonly provider: CoreRpcProvider,
    readonly config: V3AppConfig,
    readonly transitionSigner: GuardianTransitionSigner,
    readonly secondaryProvider: CoreRpcProvider | null = null,
  ) {
    this.assets = config.ordUrl ? ordAssetLookup(config.ordUrl) : null;
    this.fundingChecker = chainFundingChecker({
      chain: provider,
      expectedChain: config.network === "mainnet" ? "main" : config.network === "testnet" ? "test" : config.network,
      isCoveCarrier: async (o) => (await getLiveTokenUtxosAtDb(db, config.network, [o])).length > 0,
      assets: this.assets ?? undefined,
    });
    this.market = new MarketService(
      db,
      provider,
      config.network === "mainnet"
        ? mainnetMarketConfig({ p2pFeeBps: config.p2pFeeBps ?? 50, feeScript: config.feeScript, maxP2pSettlementSats: config.maxP2pSettlementSats ?? 0n, chainIdentity: config.chainIdentity })
        : defaultMarketConfig(config.network, config.feeScript, config.chainIdentity),
    );
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.config.enabled) throw new AppError("APP_DISABLED", "covs is disabled on this server");
    if (this.config.network === "mainnet" && this.config.mainnetMutationsArmed !== true) {
      throw new AppError("MAINNET_DISABLED", "mainnet mutations are not armed");
    }
  }

  private assertNetwork(): V3Network {
    // §P0-5: the network comes from the server-side config, never from
    // request-body input. Mainnet is decided at boot: loadV3AppConfig refuses
    // to start it without a valid committed profile, with any local private
    // key, or without an ord server; signing goes only to the remote Guardian,
    // which checks the same profile hash and key; and the profile's canary
    // allowlists and caps still apply to every mutation.
    if (this.config.network === "mainnet" && this.config.mainnetProfileValid !== true) {
      throw new AppError("MAINNET_DISABLED", "mainnet mutations need the committed profile to validate");
    }
    return this.config.network;
  }

  private assertMutating(): V3Network {
    this.assertEnabled();
    return this.assertNetwork();
  }

  /** Canary wallet/token allowlist enforcement (§45/§46) — fail closed when set. */
  private assertCanaryAllowed(params: { tokenId?: string; walletScript?: string }): void {
    if (this.config.canaryAllowedTokenIds && params.tokenId && !this.config.canaryAllowedTokenIds.includes(params.tokenId)) {
      throw new AppError("CANARY_TOKEN_NOT_ALLOWED", `token ${params.tokenId} is not in the canary allowlist`);
    }
    if (this.config.canaryAllowedWalletScripts && params.walletScript && !this.config.canaryAllowedWalletScripts.includes(params.walletScript.toLowerCase())) {
      throw new AppError("CANARY_WALLET_NOT_ALLOWED", "wallet script is not in the canary allowlist");
    }
  }

  private async requireHealthy(): Promise<void> {
    const health = await computeHealth({ db: this.db, network: this.config.network, provider: this.provider });
    if (health.health === "REBUILDING") throw new AppError("INDEXER_REBUILDING", "indexer is rebuilding");
    if (health.health === "DIVERGED") throw new AppError("INDEXER_DIVERGED", "indexer diverged from Core tip");
    if (health.health === "CORE_UNREACHABLE") throw new AppError("CORE_UNAVAILABLE", "Bitcoin Core unreachable");
    if (health.health === "BEHIND") throw new AppError("INDEXER_UNHEALTHY", "indexer behind by " + health.lag);
    // Two-Core quorum (§29/§38): if a secondary Core is configured, mutations
    // fail closed unless the two nodes agree.
    if (this.secondaryProvider) {
      const agreement = await checkCoreAgreement(this.provider, this.secondaryProvider);
      if (!agreement.agreed) throw new AppError("CORE_UNAVAILABLE", `Core disagreement: ${agreement.detail ?? "unknown"}`);
    }
    // §P1-2: verify each node by mainnet genesis hash (not the chain string,
    // which cannot distinguish networks). Fail closed on any mismatch.
    if (this.config.network === "mainnet") {
      if (!(await verifyMainnetGenesis(this.provider))) {
        throw new AppError("CORE_UNAVAILABLE", "primary Core is not on Bitcoin mainnet (genesis hash mismatch)");
      }
      if (this.secondaryProvider && !(await verifyMainnetGenesis(this.secondaryProvider))) {
        throw new AppError("CORE_UNAVAILABLE", "secondary Core is not on Bitcoin mainnet (genesis hash mismatch)");
      }
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  status() {
    return getV3Status({ db: this.db, config: this.config });
  }
  listTokens(opts?: { ticker?: string; search?: string; limit?: number }) {
    return listV3Tokens(this.db, this.config.network, opts);
  }
  tokenDetail(tokenId: string) {
    return getV3TokenDetail(this.db, this.config.network, tokenId);
  }
  tokenHolders(tokenId: string, limit?: number, offset = 0) {
    return getTokenHolders(this.db, this.config.network, tokenId, limit, offset);
  }
  tokenActivity(tokenId: string, limit?: number) {
    return getTokenActivity(this.db, this.config.network, tokenId, limit);
  }
  walletPortfolio(walletScript: string, opts?: { limit?: number; offset?: number }) {
    return getWalletPortfolio(this.db, this.config.network, walletScript, opts);
  }

  // ── backing state loader ──────────────────────────────────────────────────

  private async loadBacking(tokenId: string): Promise<BackingRow> {
    return this.followPendingBacking(tokenId, await this.loadConfirmedBacking(tokenId));
  }

  private async loadConfirmedBacking(tokenId: string): Promise<BackingRow> {
    const rows = await this.db
      .select()
      .from(schema.coveV3BackingStates)
      .where(and(eq(schema.coveV3BackingStates.network, this.config.network), eq(schema.coveV3BackingStates.tokenId, tokenId), eq(schema.coveV3BackingStates.canonical, true)));
    const b = rows[0];
    if (!b) throw new AppError("TOKEN_NOT_FOUND", "token not found");
    const state: CoveStateV2 = {
      stateVersion: b.stateVersion as 2,
      policyVersion: b.policyVersion,
      tokenId: b.tokenId,
      issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
      backingSats: b.backingSats,
      curveStage: b.curveStage,
    };
    const confirmed: BackingRow = {
      state,
      stateHash: b.stateHash,
      input: { txid: b.txid, vout: b.vout, script: Buffer.from(b.scriptPubKey, "hex"), valueSats: b.btcValue },
    };
    return confirmed;
  }

  /**
   * The backing state at a specific outpoint, following the unconfirmed chain
   * if that outpoint has not been mined yet. Used when revalidating a
   * transaction against the exact state it was built on.
   */
  private async loadBackingAt(
    tokenId: string,
    txid: string | null,
    vout: number | null,
  ): Promise<BackingRow> {
    const confirmed = await this.loadConfirmedBacking(tokenId);
    if (!txid || vout === null) return this.followPendingBacking(tokenId, confirmed);
    return this.followPendingBacking(tokenId, confirmed, { txid, vout });
  }

  /** Follow the accepted mempool branch, re-deriving each successor. */
  private async followPendingBacking(
    tokenId: string,
    confirmed: BackingRow,
    stopAt?: { txid: string; vout: number },
  ): Promise<BackingRow> {
    let tip = confirmed;
    const visited: string[] = [];

    for (let depth = 0; depth < MAX_PENDING_BACKING_CHAIN; depth++) {
      // Submitting a transaction revalidates it against the outpoint it was
      // BUILT on, which may be behind the current tip if others have queued
      // since. Stopping there keeps the check exact.
      if (stopAt && tip.input.txid === stopAt.txid && tip.input.vout === stopAt.vout) return tip;
      let spendingTxid: string | null | undefined;
      try { spendingTxid = await this.provider.getMempoolSpender(tip.input.txid, tip.input.vout, { retry: false, signal: AbortSignal.timeout(5_000) }); }
      catch { throw new AppError("CORE_UNAVAILABLE", "the pending branch cannot currently be observed"); }
      let next: { txid: string } | null = spendingTxid ? { txid: spendingTxid } : null;
      if (spendingTxid === undefined) {
        const candidates = await listSubmittedSpendsOfBacking(this.db, this.config.network, tokenId, tip.input.txid, tip.input.vout);
        if (candidates.length > 64) throw new AppError("STATE_CHANGED", "too many pending competitors; retry after reconciliation");
        for (const candidate of candidates) {
          if (!candidate.txid) continue;
          let accepted: boolean;
          try { accepted = await this.provider.isTransactionInMempool(candidate.txid, { retry: false, signal: AbortSignal.timeout(5_000) }); }
          catch { throw new AppError("CORE_UNAVAILABLE", "the pending branch cannot currently be observed"); }
          if (!accepted) continue;
          if (next) throw new AppError("STATE_CHANGED", "the accepted branch changed during observation");
          next = { txid: candidate.txid };
        }
      }
      if (!next) {
        if (stopAt) throw new AppError("STATE_CHANGED", "the requested backing is no longer on the accepted branch; request a fresh quote");
        let unspent;
        try { unspent = await this.provider.getTxout(tip.input.txid, tip.input.vout); }
        catch { throw new AppError("CORE_UNAVAILABLE", "the backing output cannot currently be observed"); }
        if (!unspent || unspent.scriptPubKeyHex !== tip.input.script.toString("hex") || unspent.valueSats !== tip.input.valueSats) {
          throw new AppError("STATE_CHANGED", "the backing output has changed; request a fresh quote");
        }
        for (const txid of visited) {
          let present: boolean;
          try { present = await this.provider.isTransactionInMempool(txid, { retry: false, signal: AbortSignal.timeout(5_000) }); }
          catch { throw new AppError("CORE_UNAVAILABLE", "the pending branch cannot currently be verified"); }
          if (!present) throw new AppError("STATE_CHANGED", "the pending branch changed during observation");
        }
        return tip;
      }
      visited.push(next.txid);

      let raw: string;
      try {
        raw = await this.provider.getRawTransaction(next.txid);
      } catch (error) {
        throw new AppError(isRpcNotFound(error, "getrawtransaction") ? "STATE_CHANGED" : "CORE_UNAVAILABLE",
          "the pending backing transaction cannot currently be verified");
      }

      const tx = bitcoin.Transaction.fromHex(raw);
      if (tx.getId() !== next.txid || !tx.ins[0] || Buffer.from(tx.ins[0].hash).reverse().toString("hex") !== tip.input.txid || tx.ins[0].index !== tip.input.vout) {
        throw new AppError("STATE_CHANGED", "the pending transaction does not spend the expected backing");
      }
      let envelope: ParsedEnvelopeV2;
      try {
        envelope = decodeCoveOpReturnTx(tx);
      } catch {
        throw new AppError("STATE_CHANGED", "the pending backing transaction is invalid");
      }

      if (!("tokenId" in envelope) || !envelope.tokenId.equals(Buffer.from(tokenId, "hex"))) throw new AppError("STATE_CHANGED", "the pending transaction belongs to another token");
      let nextState: CoveStateV2;
      if (envelope.op === OP_MINT) {
        nextState = applyMintV2(tip.state, envelope.amount).nextState;
      } else if (envelope.op === OP_REDEEM) {
        nextState = applyRedeemV2(tip.state, envelope.redeemAmount).nextState;
      } else {
        throw new AppError("STATE_CHANGED", "the pending transaction does not move the backing vault");
      }

      const vaultOut = tx.outs[BACKING_SUCCESSOR_VOUT];
      const expectedValue = RESERVE_ANCHOR_SATS + nextState.backingSats;
      const nextVault = buildBackingVaultV3({ state: nextState, guardianXOnly: this.config.guardianXOnly, recoveryKeyXOnly: this.config.recoveryKeyXOnly, recoveryProfile: this.config.recoveryProfile, network: btcNetwork(this.config.network) });
      if (!vaultOut || !vaultOut.script.equals(nextVault.scriptPubKey) || BigInt(vaultOut.value) !== expectedValue) throw new AppError("STATE_CHANGED", "the pending backing output cannot be verified");

      tip = {
        state: nextState,
        stateHash: stateHashV2(nextState),
        input: {
          txid: tx.getId(),
          vout: BACKING_SUCCESSOR_VOUT,
          script: Buffer.from(vaultOut.script),
          valueSats: expectedValue,
        },
      };
    }
    throw new AppError("STATE_CHANGED", "the pending backing chain exceeds the verification limit");
  }

  /**
   * Present an unconfirmed vault tip to the Guardian as the current backing.
   *
   * The canonical view is built from the indexer, which only sees confirmed
   * blocks. When a transition is already broadcast the builder correctly spends
   * its successor, but the Guardian would then compare that input against the
   * older confirmed outpoint and reject with BACKING_VOUT_MISMATCH. Overlaying
   * the tip keeps the two in agreement.
   *
   * Only the backing is overlaid. Token UTXOs and every other lookup still come
   * from confirmed data, so nothing else is treated as settled before it is.
   */
  private overlayPendingBacking(
    view: CoveCanonicalView,
    tokenIdHex: string,
    tip: BackingRow,
  ): CoveCanonicalView {
    const tipOutpoint = { txid: tip.input.txid, vout: tip.input.vout };
    const matches = (tokenId: Buffer) => tokenId.toString("hex") === tokenIdHex;
    return {
      cursorHeight: view.cursorHeight,
      getBackingOutpoint: (tokenId) =>
        matches(tokenId) ? tipOutpoint : view.getBackingOutpoint(tokenId),
      getCurrentBackingState: (tokenId) =>
        matches(tokenId) ? tip.state : view.getCurrentBackingState(tokenId),
      getBackingStateByOutpoint: (outpoint) =>
        outpoint.txid === tipOutpoint.txid && outpoint.vout === tipOutpoint.vout
          ? tip.state
          : view.getBackingStateByOutpoint(outpoint),
      getTokenUtxo: (outpoint) => view.getTokenUtxo(outpoint),
      getTokenCreatorScript: (tokenId) => view.getTokenCreatorScript?.(tokenId) ?? null,
    };
  }

  /** The creator payout script recorded when the token was launched. */
  private async creatorScriptOf(tokenId: string): Promise<Buffer> {
    const rows = await this.db
      .select({ creatorScript: schema.coveV3Tokens.creatorScript })
      .from(schema.coveV3Tokens)
      .where(and(eq(schema.coveV3Tokens.network, this.config.network), eq(schema.coveV3Tokens.tokenId, tokenId), eq(schema.coveV3Tokens.canonical, true)));
    const c = rows[0]?.creatorScript;
    if (!c) throw new AppError("TOKEN_NOT_FOUND", "token has no recorded creator");
    return Buffer.from(c, "hex");
  }

  private async loadView(tokenId: string, relevantOutpoints: { txid: string; vout: number }[] = []): Promise<CoveCanonicalView> {
    return loadCanonicalViewSnapshotFromDb({ db: this.db, network: this.config.network, tokenId, relevantOutpoints });
  }

  // ── miner fees ────────────────────────────────────────────────────────────

  /** Read the worker's successfully collected fee observation. */
  async feeRates(): Promise<FeeRates> {
    return readFeeObservation(this.db, this.config.network);
  }

  /**
   * Pick the funding inputs this transaction needs, and size the miner fee to
   * the transaction it will actually produce.
   *
   * Two problems are fixed here at once. Every build used to spend EVERY UTXO
   * in the wallet, so a wallet with fifty of them paid for a ~3,400-vbyte
   * transaction to buy a few dollars of tokens. And the fee was a flat 1,000
   * sats regardless of size, which is under the relay floor for anything but a
   * quiet mempool. Now the smallest sufficient set of inputs is chosen, and
   * the fee follows the size of that exact set.
   *
   * `targetSats` is everything the funding inputs must cover EXCLUDING the
   * miner fee. It may be negative when other inputs (token carriers) already
   * bring in more sats than the outputs consume.
   */
  /** What a coin holds besides BTC, per ord; null when nothing or no ord is configured. */
  private async assetsAt(o: { txid: string; vout: number }): Promise<string | null> {
    if (!this.assets) return null;
    try {
      return await this.assets.describeAssets(o);
    } catch (e) {
      throw new AppError("FUNDING_CHECK_UNAVAILABLE", `could not check ${o.txid}:${o.vout} for inscriptions and runes: ${(e as Error).message}`);
    }
  }

  private async resolveFundingAndFee(params: {
    op: CoveOperation;
    wallet: ResolvedWalletIdentity;
    candidates: FundingCandidate[];
    targetSats: bigint;
    tokenInputs?: number;
    recipientCarriers?: number;
    discovery?: boolean;
    feeRateSatPerVb?: bigint;
    explicitMinerFeeSats?: bigint;
  }): Promise<{ inputs: ResolvedInput[]; minerFeeSats: bigint; vsize: number; satPerVb: bigint }> {
    const resolved = await resolveFundingUtxos(this.provider, params.candidates);
    for (const f of resolved) {
      if (f.script.toString("hex") !== params.wallet.payments.script) {
        throw new AppError("FUNDING_INPUT_INVALID", "funding input script does not match wallet");
      }
    }
    // A token carrier spent as plain BTC burns the tokens on it. Single-address
    // wallets keep carriers and coins at the same script, so the script check
    // above cannot catch this.
    const carriers = await getLiveTokenUtxosAtDb(this.db, this.config.network, params.candidates);
    if (carriers.length > 0) {
      throw new AppError(
        "FUNDING_INPUT_IS_TOKEN",
        `funding input ${carriers[0]!.txid}:${carriers[0]!.vout} holds tokens and cannot pay for a trade`,
      );
    }
    const rates = await this.feeRates();
    // Neither a rate nor an amount supplied: use the Standard tier. The old
    // default was a flat 1,000 sats regardless of size, which is what made a
    // busy-mempool transaction unconfirmable in the first place.
    const standard = rates.tiers.find((t) => t.key === "standard") ?? rates.tiers[0]!;
    const feeRateSatPerVb =
      params.feeRateSatPerVb ??
      (params.explicitMinerFeeSats === undefined ? standard.satPerVb : undefined);
    const shape = {
      tokenInputs: params.tokenInputs,
      // Priced per address kind: a nested-segwit input is 91 vbytes against a
      // native one's 68, so assuming native under-prices a Xverse wallet by a
      // third.
      fundingKind: params.wallet.payments.kind,
      tokenKind: params.wallet.ordinals.kind,
      walletScriptBytes: params.wallet.payments.script.length / 2,
      ordinalsScriptBytes: params.wallet.ordinals.script.length / 2,
      feeScriptBytes: this.config.feeScript.length,
      recipientCarriers: params.recipientCarriers,
      discovery: params.discovery,
    };
    const priceAt = (fundingInputs: number) => {
      const vsize = estimateOperationVsize(params.op, { ...shape, fundingInputs });
      let fee;
      try {
        fee = resolveMinerFee({
          rateSatPerVb: feeRateSatPerVb,
          explicitSats: params.explicitMinerFeeSats,
          vsize,
          floorSatPerVb: rates.floorSatPerVb,
          ceilingSatPerVb: rates.ceilingSatPerVb,
          maxMinerFeeSats: this.config.maxMinerFeeSats,
        });
      } catch (e) {
        // The fee module is shared with the market and speaks its own error
        // type. Translate rather than let it fall through as INTERNAL_ERROR:
        // "an unexpected error occurred" is useless advice when the fix is
        // "raise your fee".
        if (e instanceof FeeError) throw new AppError(e.code, e.message.replace(/^\[[A-Z_]+\]\s*/, ""));
        throw e;
      }
      return { vsize: fee.vsize, minerFeeSats: fee.minerFeeSats, satPerVb: fee.effectiveSatPerVb };
    };

    // A vault transition (mint, redeem) may not be funded by an unconfirmed
    // coin: its owner could double-spend it and drop every transition chained
    // after it. The Guardian refuses such an input; skip it here so the user
    // gets a build instead of a refusal.
    const vaultOp = params.op === "BACKING_BUY" || params.op === "REDEEM";
    const pending = vaultOp ? resolved.filter((f) => f.confirmations < 1) : [];
    const usable = vaultOp ? resolved.filter((f) => f.confirmations >= 1) : resolved;

    // Largest-first: reaches the target in the fewest inputs, which is also the
    // cheapest transaction. Ties break on txid/vout so the choice is
    // deterministic and a rebuild produces the same PSBT.
    let sorted = [...usable].sort((a, b) => {
      if (a.valueSats !== b.valueSats) return a.valueSats > b.valueSats ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    });

    // The public key rides along so the builder can attach the redeemScript or
    // the Taproot internal key that a wallet needs in order to sign at all.
    const toInput = (f: ResolvedFunding): ResolvedInput => ({
      txid: f.txid,
      vout: f.vout,
      script: f.script,
      valueSats: f.valueSats,
      publicKey: params.wallet.payments.publicKeyBuffer,
    });

    // Zero funding inputs is legitimate when other inputs already cover the
    // outputs and the fee (a redeem whose token carriers pay for themselves).
    const noFunding = priceAt(0);
    if (params.targetSats + noFunding.minerFeeSats <= 0n) {
      return { inputs: [], ...noFunding };
    }

    // Coins holding inscriptions or runes are skipped, never spent: spent as
    // plain BTC, what they hold is destroyed. Only the coins actually picked
    // are asked about, and a skipped coin means picking again without it.
    const skippedAssets: string[] = [];
    let chosen: ResolvedFunding[] = [];
    let sum = 0n;
    pick: for (;;) {
      chosen = [];
      sum = 0n;
      for (const utxo of sorted) {
        chosen.push(utxo);
        sum += utxo.valueSats;
        const priced = priceAt(chosen.length);
        if (sum >= params.targetSats + priced.minerFeeSats) {
          for (const f of chosen) {
            const held = await this.assetsAt(f);
            if (held) {
              skippedAssets.push(`${f.txid}:${f.vout} (${held})`);
              sorted = sorted.filter((u) => u !== f);
              continue pick;
            }
          }
          return { inputs: chosen.map(toInput), ...priced };
        }
      }
      break;
    }
    const shortfall = priceAt(Math.max(1, chosen.length));
    const need = params.targetSats + shortfall.minerFeeSats;
    // Two-address wallets are the usual way to land here: coins sent to the
    // token (taproot) address are never spent for trades.
    const twoAddress = params.wallet.payments.script !== params.wallet.ordinals.script;
    const pendingSats = pending.reduce((a, f) => a + f.valueSats, 0n);
    throw new AppError(
      "INSUFFICIENT_BTC",
      `Your payment address has ${sum} usable sats; this needs ${need} ` +
        `(${params.targetSats} for the trade, ${shortfall.minerFeeSats} network fee at ` +
        `${shortfall.satPerVb} sat/vB).` +
        (pending.length > 0
          ? ` Another ${pendingSats} sats are still unconfirmed; mints and sales use only confirmed BTC, so wait for your last transaction to confirm.`
          : "") +
        (skippedAssets.length > 0 ? ` Skipped coins holding inscriptions or runes: ${skippedAssets.join(", ")}.` : "") +
        (twoAddress
          ? " covs pays only from your wallet's payment (BTC) address, not its token (taproot) address — send BTC there first."
          : ""),
    );
  }

  // ── launch ────────────────────────────────────────────────────────────────

  prepareLaunch(input: LaunchPrepareInput): LaunchPrepareResult {
    this.assertEnabled();
    const ticker = canonicalTicker(input.ticker);
    const nonce = input.nonceHex ? Buffer.from(input.nonceHex, "hex") : randomBytes(32);
    if (nonce.length !== 32) throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");
    // The tokenId commits to the creator's payout script, which is known only
    // once a wallet is connected; without one the id is left to the build.
    const creatorScript = input.creatorScript ? Buffer.from(input.creatorScript, "hex") : null;
    const tokenId = creatorScript
      ? computeTokenId({ chainIdentity: this.config.chainIdentity, policyVersion: 3, ticker, tokenNonce: nonce, creatorScript }).toString("hex")
      : null;
    validateMetadata({ displayName: input.displayName, description: input.description, websiteUrl: input.websiteUrl, xUrl: input.xUrl, imageUrl: input.imageUrl });
    return {
      tokenId,
      ticker,
      nonceHex: nonce.toString("hex"),
      policyVersion: 3,
      chainIdentity: this.config.chainIdentity,
      publicCapAtoms: PUBLIC_SUPPLY_ATOMS,
      publicSupplyAtoms: PUBLIC_SUPPLY_ATOMS,
      curve: "stairs210",
      vaultAnchorSats: RESERVE_ANCHOR_SATS,
      launchFeeSats: LAUNCH_FEE_SATS,
    };
  }

  async buildLaunch(params: {
    ticker: string;
    nonceHex: string;
    walletScript: string;
    /** Optional second address for token carriers; defaults to walletScript. */
    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];
    /** Preferred: the fee rate the user picked; the server sizes the fee. */
    feeRateSatPerVb?: bigint;
    /** Explicit fee, for callers that size the transaction themselves. */
    minerFeeSats?: bigint;
    metadata: TokenMetadataInput;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3; tokenId: string }> {
    this.assertMutating();
    await this.requireHealthy();
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    // The creator is paid at their payment address, where BTC belongs.
    const creatorScript = wallet.payments.scriptBuffer;
    const tokenId = computeTokenId({ chainIdentity: this.config.chainIdentity, policyVersion: 3, ticker: canonicalTicker(params.ticker), tokenNonce: Buffer.from(params.nonceHex, "hex"), creatorScript }).toString("hex");
    this.assertCanaryAllowed({ tokenId, walletScript: params.walletScript });
    // The deploy funds the vault anchor, the creator record (which comes back
    // to the creator's own address) and the miner fee.
    const { inputs: deployerInputs, minerFeeSats } = await this.resolveFundingAndFee({
      op: "DEPLOY",
      wallet,
      candidates: params.funding,
      targetSats: RESERVE_ANCHOR_SATS + CREATOR_RECORD_SATS + LAUNCH_FEE_SATS,
      feeRateSatPerVb: params.feeRateSatPerVb,
      explicitMinerFeeSats: params.minerFeeSats,
    });
    const result = buildDeployPsbtV3({
      network: btcNetwork(this.config.network),
      identity: { chainIdentity: this.config.chainIdentity, policyVersion: 3, ticker: canonicalTicker(params.ticker), tokenNonce: Buffer.from(params.nonceHex, "hex") },
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      deployerInputs,
      deployerChangeScript: wallet.payments.scriptBuffer,
      creatorScript,
      feeScript: this.config.feeScript,
      minerFeeSats,
    });
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const metadataJson = validateMetadata(params.metadata);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "DEPLOY",
      tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: null,
      backingTxid: null,
      backingVout: null,
      unsignedTxDigest: digest,
      psbtBase64,
      metadataJson,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      tokenId,
      intent: {
        operation: "DEPLOY",
        tokenId,
        tokenAmountAtoms: 0n,
        grossSats: null,
        // The launch fee, paid at output 3 to the protocol fee address.
        protocolFeeSats: LAUNCH_FEE_SATS,
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: null,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitLaunch(params: { sessionId: string; signedPsbtBase64: string }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network) throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({ tokenId: session.tokenId ?? undefined, walletScript: session.walletScript });
    if (session.operation !== "DEPLOY") throw new AppError("SESSION_STATE_INVALID", "session is not DEPLOY");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED") {
      if (session.metadataJson && session.tokenId && session.txid) {
        await upsertTokenMetadata({ db: this.db, network: this.config.network, tokenId: session.tokenId,
          submittedByScript: session.walletScript, deployTxid: session.txid, metadata: session.metadataJson });
      }
      return { txid: session.txid! };
    }
    const started = await this.beginSessionSubmission(session, params.signedPsbtBase64);
    if ("txid" in started) {
      if (session.metadataJson && session.tokenId) await upsertTokenMetadata({ db: this.db, network: this.config.network,
        tokenId: session.tokenId, submittedByScript: session.walletScript, deployTxid: started.txid, metadata: session.metadataJson });
      return started;
    }
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest) throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 0; i < psbt.data.inputs.length; i++) validateInputSignature(psbt, i);
      psbt.finalizeAllInputs();
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = validateFinalizedDeployTransaction({
        rawTxHex,
        network: this.config.network,
        chainIdentity: this.config.chainIdentity,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
      });
      if (!("rawTxHex" in validated)) throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      const txid = receipt.txid;
      if (session.metadataJson && session.tokenId) {
        await upsertTokenMetadata({ db: this.db, network: this.config.network, tokenId: session.tokenId,
          submittedByScript: session.walletScript, deployTxid: txid, metadata: session.metadataJson });
      }
      return receipt;
    } catch (error) {
      if (error instanceof AppError && ["GUARDIAN_REJECTED", "STATE_CHANGED", "PSBT_MUTATED", "WALLET_SIGNATURE_INVALID"].includes(error.code)) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  // ── backing buy ───────────────────────────────────────────────────────────

  /**
   * The most whole tokens `budgetSats` buys from the curve right now: curve
   * price + protocol fee + the 1,000-sat token carrier. The network fee is
   * separate, because it depends on the wallet's coins and the fee rate.
   *
   * People think in sats, not token counts; the mint form asks for sats and
   * shows what they buy.
   */
  /** The per-mint limits the Guardian will enforce on this network. */
  mintLimits(): { maxMintAtoms: bigint; maxGrossSats: bigint | null; minGrossSats: bigint } {
    return (
      this.config.mintLimits ?? {
        maxMintAtoms: DEV_RISK_POLICY.maxMintAtoms,
        maxGrossSats: DEV_RISK_POLICY.maxGrossSats,
        minGrossSats: DEV_RISK_POLICY.minMintGrossSats,
      }
    );
  }

  async quoteBuyForSats(tokenId: string, budgetSats: bigint): Promise<{
    amountAtoms: bigint;
    grossSats: bigint;
    feeSats: bigint;
    /** The creator's share, paid on top of the curve price. */
    creatorFeeSats: bigint;
    carrierSats: bigint;
    totalSats: bigint;
    /** Why it stopped where it did — the budget, the per-mint limit, or the curve running out. */
    limitedBy: "budget" | "per-mint limit" | "supply";
    minGrossSats: bigint;
    maxGrossSats: bigint | null;
    /**
     * The smallest budget that mints anything right now: one lot (or the few
     * lots the minimum mint needs) with every fee and the token carrier.
     * Null when the curve is sold out.
     */
    minSpendSats: bigint | null;
  }> {
    const backing = await this.loadBacking(tokenId);
    const supplyTokens = backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN;
    const remaining = (PUBLIC_SUPPLY_ATOMS - backing.state.issuedPublicSupplyAtoms) / ATOMS_PER_TOKEN;
    const costOf = (n: bigint) => {
      const gross = grossBuy(supplyTokens, n);
      const fee = mintFeeSats(gross, n * ATOMS_PER_TOKEN, this.config.buyFeeBps, this.config.buyFeeFlatSats);
      const creator = creatorFeeSats(gross);
      return { gross, fee, creator, total: gross + fee + creator + TOKEN_CARRIER_SATS };
    };
    const limits = this.mintLimits();
    // Search in whole lots: nothing smaller can be minted.
    const perMintLots = limits.maxMintAtoms / ATOMS_PER_TOKEN / LOT_TOKENS;
    const remainingLots = remaining / LOT_TOKENS;
    const fits = (lots: bigint) => {
      const c = costOf(lots * LOT_TOKENS);
      return c.total <= budgetSats && (limits.maxGrossSats === null || c.gross <= limits.maxGrossSats);
    };
    // The curve only ever gets more expensive, so cost is monotonic in lots.
    let loLots = 0n;
    let hiLots = remainingLots < perMintLots ? remainingLots : perMintLots;
    while (loLots < hiLots) {
      const mid = (loLots + hiLots + 1n) / 2n;
      if (fits(mid)) loLots = mid;
      else hiLots = mid - 1n;
    }
    const lo = loLots * LOT_TOKENS;
    const perMintTokens = perMintLots * LOT_TOKENS;
    // Smallest mint: the fewest lots whose curve price meets the minimum, with
    // every fee and the carrier. Tells the buyer what "too little" means.
    let minSpendSats: bigint | null = null;
    if (remainingLots > 0n) {
      let a = 1n;
      let b = remainingLots;
      while (a < b) {
        const m = (a + b) / 2n;
        if (costOf(m * LOT_TOKENS).gross >= limits.minGrossSats) b = m;
        else a = m + 1n;
      }
      if (costOf(a * LOT_TOKENS).gross >= limits.minGrossSats) minSpendSats = costOf(a * LOT_TOKENS).total;
    }
    const base = { carrierSats: TOKEN_CARRIER_SATS, minGrossSats: limits.minGrossSats, maxGrossSats: limits.maxGrossSats, minSpendSats } as const;
    const nothing = { ...base, amountAtoms: 0n, grossSats: 0n, feeSats: 0n, creatorFeeSats: 0n, totalSats: 0n, limitedBy: "budget" } as const;
    // The budget does not cover one lot (or the curve is minted out): there is
    // nothing to price, and grossBuy rejects a zero amount.
    if (lo === 0n) return nothing;
    const c = costOf(lo);
    if (c.gross < limits.minGrossSats) return nothing;
    const next = lo < remaining ? costOf(lo + LOT_TOKENS) : null;
    const limitedBy =
      lo === remaining ? "supply"
        : lo === perMintTokens || (next !== null && next.total <= budgetSats) ? "per-mint limit"
          : "budget";
    return { ...base, limitedBy, amountAtoms: lo * ATOMS_PER_TOKEN, grossSats: c.gross, feeSats: c.fee, creatorFeeSats: c.creator, totalSats: c.total };
  }

  async quoteBackingBuy(tokenId: string, amountAtoms: bigint): Promise<BackingQuote> {
    if (amountAtoms <= 0n || amountAtoms % (LOT_TOKENS * ATOMS_PER_TOKEN) !== 0n) throw new AppError("TOKEN_AMOUNT_INVALID", "backing buy requires whole 1,000-token lots");
    const backing = await this.loadBacking(tokenId);
    const supply = backing.state.issuedPublicSupplyAtoms;
    if (supply + amountAtoms > PUBLIC_SUPPLY_ATOMS) throw new AppError("TOKEN_AMOUNT_INVALID", "exceeds public cap");
    const gross = grossBuy(supply / ATOMS_PER_TOKEN, amountAtoms / ATOMS_PER_TOKEN);
    const limits = this.mintLimits();
    if (amountAtoms > limits.maxMintAtoms) throw new AppError("TOKEN_AMOUNT_INVALID", "exceeds the per-mint token limit");
    if (limits.maxGrossSats !== null && gross > limits.maxGrossSats) throw new AppError("TOKEN_AMOUNT_INVALID", "exceeds the per-mint curve price limit");
    if (gross < limits.minGrossSats) throw new AppError("TOKEN_AMOUNT_INVALID", "below the minimum mint curve price");
    const fee = mintFeeSats(gross, amountAtoms, this.config.buyFeeBps, this.config.buyFeeFlatSats);
    const next = applyMintV2(backing.state, amountAtoms).nextState;
    const cursor = await this.db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, this.config.network));
    const c = cursor[0];
    return {
      tokenId,
      amountAtoms,
      stateHash: backing.stateHash,
      backingOutpoint: { txid: backing.input.txid, vout: backing.input.vout },
      supplyBeforeAtoms: supply,
      supplyAfterAtoms: next.issuedPublicSupplyAtoms,
      backingBeforeSats: backing.state.backingSats,
      backingAfterSats: next.backingSats,
      grossSats: gross,
      feeSats: fee,
      creatorFeeSats: creatorFeeSats(gross),
      feeBps: this.config.buyFeeBps,
      indexedHeight: c?.height ?? 0n,
      indexedBlockHash: c?.blockHash ?? "",
      expiresAtHeight: (c?.height ?? 0n) + 2n,
    };
  }

  async buildBackingBuy(params: {
    tokenId: string;
    amountAtoms: bigint;
    quoteBinding: { stateHash: string; backingOutpoint: { txid: string; vout: number }; expiresAtHeight: bigint | null };
    walletScript: string;
    /** Optional second address for token carriers; defaults to walletScript. */
    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];
    /** Preferred: the fee rate the user picked; the server sizes the fee. */
    feeRateSatPerVb?: bigint;
    /** Explicit fee, for callers that size the transaction themselves. */
    minerFeeSats?: bigint;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    await this.requireHealthy();
    this.assertCanaryAllowed({ tokenId: params.tokenId, walletScript: params.walletScript });
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    const backing = await this.loadBacking(params.tokenId);
    if (backing.stateHash !== params.quoteBinding.stateHash || backing.input.txid !== params.quoteBinding.backingOutpoint.txid || backing.input.vout !== params.quoteBinding.backingOutpoint.vout) {
      throw new AppError("QUOTE_STALE", "backing state changed since quote");
    }
    // The advisory crc-20 envelope is ticker-keyed; the canonical view resolves
    // tokens by tokenId, so look the ticker up only when the envelope is on.
    const discoveryTicker = this.config.discoveryEnvelope
      ? (await getV3TokenDetail(this.db, this.config.network, params.tokenId))?.ticker
      : undefined;
    // What the buyer's own BTC must cover: the curve price, the protocol fee,
    // and the sats that ride on their new token carrier. The vault input
    // supplies the existing backing and the successor consumes it, so neither
    // appears here.
    const { grossSats: quotedGrossSats } = applyMintV2(backing.state, params.amountAtoms);
    const quotedBuyFeeSats = mintFeeSats(quotedGrossSats, params.amountAtoms, this.config.buyFeeBps, this.config.buyFeeFlatSats);
    const creatorScript = await this.creatorScriptOf(params.tokenId);
    const quotedCreatorFeeSats = creatorFeeSats(quotedGrossSats);
    const { inputs: buyerInputs, minerFeeSats } = await this.resolveFundingAndFee({
      op: "BACKING_BUY",
      wallet,
      candidates: params.funding,
      targetSats: quotedGrossSats + quotedBuyFeeSats + quotedCreatorFeeSats + TOKEN_CARRIER_SATS,
      discovery: discoveryTicker !== undefined,
      feeRateSatPerVb: params.feeRateSatPerVb,
      explicitMinerFeeSats: params.minerFeeSats,
    });
    const result = buildMintPsbtV3({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      prevState: backing.state,
      prevBacking: backing.input,
      mintAmountAtoms: params.amountAtoms,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      buyerInputs,
      // The tokens land on the ordinals address; the BTC change returns to
      // the payment address. Sending a carrier to a nested-segwit payment
      // address would be rejected by the protocol as a non-standard carrier.
      buyerCarrierScript: wallet.ordinals.scriptBuffer,
      buyerChangeScript: wallet.payments.scriptBuffer,
      feeScript: this.config.feeScript,
      creatorScript,
      minerFeeSats,
      buyFeeBps: this.config.buyFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      discoveryEnvelope: discoveryTicker ? { ticker: discoveryTicker } : undefined,
    });
    const view = this.overlayPendingBacking(
      await this.loadView(params.tokenId),
      params.tokenId,
      backing,
    );
    const req: TransitionSignRequest = { psbt: result.psbt, view, network: this.config.network, recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile, feeScript: this.config.feeScript, maxMinerFeeSats: this.config.maxMinerFeeSats, buyFeeBps: this.config.buyFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      discoveryTicker, fundingChecker: this.fundingChecker };
    // Validate now so a bad build fails before the wallet is asked, but do NOT
    // sign: a Guardian signature reserves the vault outpoint, and reserving it
    // for a build that is never submitted let anyone freeze a token's trading
    // by building and walking away. The Guardian signs at submit, once the
    // buyer's own inputs are signed.
    const checked = await validateMintTransitionV3({ ...req, guardianXOnly: this.config.guardianXOnly });
    if (!checked.ok) throw new AppError("GUARDIAN_REJECTED", `${checked.reason}: ${checked.detail}`);
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "BACKING_BUY",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: backing.stateHash,
      backingTxid: backing.input.txid,
      backingVout: backing.input.vout,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: params.quoteBinding.expiresAtHeight,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "BACKING_BUY",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: result.grossSats,
        protocolFeeSats: result.buyFeeSats,
        creatorFeeSats: result.creatorFeeSats,
        creatorScript: creatorScript.toString("hex"),
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: backing.stateHash,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitBackingBuy(params: { sessionId: string; signedPsbtBase64: string }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network) throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({ tokenId: session.tokenId ?? undefined, walletScript: session.walletScript });
    if (session.operation !== "BACKING_BUY") throw new AppError("SESSION_STATE_INVALID", "session is not BACKING_BUY");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED") return { txid: session.txid! };
    const started = await this.beginSessionSubmission(session, params.signedPsbtBase64);
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest) throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 1; i < psbt.data.inputs.length; i++) {
        validateInputSignature(psbt, i);
        psbt.finalizeInput(i);
      }
      const view = this.overlayPendingBacking(
        await this.loadView(session.tokenId!),
        session.tokenId!,
        await this.loadBackingAt(session.tokenId!, session.backingTxid, session.backingVout),
      );
      // Only now, with the buyer committed, does the Guardian sign (and reserve)
      // the vault input.
      const discoveryTicker = this.config.discoveryEnvelope
        ? (await getV3TokenDetail(this.db, this.config.network, session.tokenId!))?.ticker
        : undefined;
      const signed = await this.transitionSigner.signMint({ psbt, view, network: this.config.network, recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile, feeScript: this.config.feeScript, maxMinerFeeSats: this.config.maxMinerFeeSats, buyFeeBps: this.config.buyFeeBps,
        buyFeeFlatSats: this.config.buyFeeFlatSats,
        discoveryTicker, fundingChecker: this.fundingChecker });
      if (!signed.ok) {
        const transient = ["GUARDIAN_TIMEOUT", "REMOTE_GUARDIAN_UNAVAILABLE", "FUNDING_CHECK_UNAVAILABLE", "AUDIT_PERSISTENCE_FAILED", "SIGNING_FAILED"].includes(signed.reason);
        throw new AppError(transient ? "CORE_UNAVAILABLE" : "GUARDIAN_REJECTED", `${signed.reason}: ${signed.detail}`);
      }
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = await validateFinalizedMintTransaction({
        rawTxHex,
        view,
        network: this.config.network,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        buyFeeBps: this.config.buyFeeBps,
        buyFeeFlatSats: this.config.buyFeeFlatSats,
      });
      if (!("rawTxHex" in validated)) throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (error instanceof AppError && ["GUARDIAN_REJECTED", "STATE_CHANGED", "PSBT_MUTATED", "WALLET_SIGNATURE_INVALID"].includes(error.code)) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  // ── redeem ────────────────────────────────────────────────────────────────

  async quoteRedeem(tokenId: string, amountAtoms: bigint): Promise<RedeemQuote> {
    if (amountAtoms <= 0n || amountAtoms % ATOMS_PER_TOKEN !== 0n) throw new AppError("TOKEN_AMOUNT_INVALID", "redeem requires whole display tokens");
    const backing = await this.loadBacking(tokenId);
    const gross = grossRedeem(backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN, amountAtoms / ATOMS_PER_TOKEN);
    const fee = redeemFeeSats(gross, this.config.redeemFeeBps, this.config.redeemFeeFlatSats);
    // Quote the refusal here rather than letting it surface from the builder:
    // the user asked what this is worth, and "less than nothing" is the answer.
    assertRedeemPayoutIsPayable({ grossSats: gross, feeSats: fee, payoutScript: this.config.feeScript });
    const next = applyRedeemV2(backing.state, amountAtoms).nextState;
    return {
      tokenId,
      amountAtoms,
      stateHash: backing.stateHash,
      backingOutpoint: { txid: backing.input.txid, vout: backing.input.vout },
      supplyBeforeAtoms: backing.state.issuedPublicSupplyAtoms,
      supplyAfterAtoms: next.issuedPublicSupplyAtoms,
      backingBeforeSats: backing.state.backingSats,
      backingAfterSats: next.backingSats,
      grossSats: gross,
      feeSats: fee,
      netSats: gross - fee,
    };
  }

  async buildRedeem(params: {
    tokenId: string;
    amountAtoms: bigint;
    walletScript: string;
    /** Optional second address for token carriers; defaults to walletScript. */
    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    /** Preferred: the fee rate the user picked; the server sizes the fee. */
    feeRateSatPerVb?: bigint;
    /** Explicit fee, for callers that size the transaction themselves. */
    minerFeeSats?: bigint;
    idempotencyKey: string;
    /** Ordinary BTC utxos the seller offers to pay the miner fee. */
    funding?: FundingCandidate[];
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    await this.requireHealthy();
    this.assertCanaryAllowed({ tokenId: params.tokenId, walletScript: params.walletScript });
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    const backing = await this.loadBacking(params.tokenId);
    // Token carriers live on the ORDINALS address, not the one holding BTC.
    const tokenUtxos = await getTokenUtxosByScriptDb(this.db, this.config.network, wallet.ordinals.script);
    const mine = tokenUtxos.filter((u) => u.tokenId === params.tokenId);
    const total = mine.reduce((s, u) => s + u.amountAtoms, 0n);
    if (total < params.amountAtoms) throw new AppError("TOKEN_AMOUNT_INVALID", "insufficient token balance");
    // Deterministic token input selection: LARGEST first, taking only as many
    // as the amount needs.
    //
    // This previously sorted ascending and then took the first four
    // unconditionally, so the balance check above (which sums EVERY utxo)
    // could pass while the four smallest carriers held less than the amount —
    // the build then failed with "redeem exceeds token input". Largest-first
    // reaches any redeemable amount in the fewest inputs.
    const sorted = [...mine].sort((a, b) =>
      a.amountAtoms !== b.amountAtoms ? (a.amountAtoms > b.amountAtoms ? -1 : 1) : a.txid < b.txid ? -1 : 1,
    );
    const selected: typeof sorted = [];
    let running = 0n;
    for (const u of sorted) {
      if (running >= params.amountAtoms) break;
      if (selected.length >= MAX_REDEEM_TOKEN_INPUTS) break;
      selected.push(u);
      running += u.amountAtoms;
    }
    if (running < params.amountAtoms) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        `balance is spread across too many outputs: the ${MAX_REDEEM_TOKEN_INPUTS} largest hold ` +
          `${running} atoms, short of ${params.amountAtoms}. Consolidate with a transfer to yourself, ` +
          `or redeem a smaller amount.`,
      );
    }
    // A carrier on a Taproot ordinals address cannot be signed without its
    // internal key, so the public key travels with every token input.
    const tokenInputs: ResolvedInput[] = selected.map((u) => ({ txid: u.txid, vout: u.vout, script: Buffer.from(u.scriptPubKey, "hex"), valueSats: TOKEN_CARRIER_SATS, publicKey: wallet.ordinals.publicKeyBuffer }));
    const tokenInputTotalAtoms = selected.reduce((s, u) => s + u.amountAtoms, 0n);
    // The vault covers the R-delta payout; the seller funds the miner fee from
    // ordinary BTC so the backing never pays it and a single-carrier partial
    // redeem is possible.
    //
    // The vault pays the seller's BTC out of backing, so the seller's own BTC
    // only has to cover the miner fee and the token-change carrier, less the
    // sats the spent carriers already bring in. That figure is usually
    // negative, which is why zero funding inputs is a legitimate answer.
    // Same check the quote makes, against the seller's own payout script. The
    // build path is reachable without a quote, so it re-checks rather than
    // trusting that one happened.
    assertRedeemPayoutIsPayable({
      grossSats: grossRedeem(
        backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN,
        params.amountAtoms / ATOMS_PER_TOKEN,
      ),
      // redeemFeeSats, not a bare percentage: it carries the fee's floor, as
      // the Guardian, the builder and the indexer all do.
      feeSats: redeemFeeSats(
        grossRedeem(
          backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN,
          params.amountAtoms / ATOMS_PER_TOKEN,
        ),
        this.config.redeemFeeBps,
        this.config.redeemFeeFlatSats,
      ),
      payoutScript: wallet.payments.scriptBuffer,
    });
    const changeCarrierSats = tokenInputTotalAtoms > params.amountAtoms ? TOKEN_CARRIER_SATS : 0n;
    const carrierSatsIn = BigInt(tokenInputs.length) * TOKEN_CARRIER_SATS;
    const { inputs: funderInputs, minerFeeSats } = await this.resolveFundingAndFee({
      op: "REDEEM",
      wallet,
      candidates: params.funding ?? [],
      targetSats: changeCarrierSats - carrierSatsIn,
      tokenInputs: tokenInputs.length,
      feeRateSatPerVb: params.feeRateSatPerVb,
      explicitMinerFeeSats: params.minerFeeSats,
    });
    const result = buildRedeemPsbtV3({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      prevState: backing.state,
      prevBacking: backing.input,
      redeemAmountAtoms: params.amountAtoms,
      tokenInputs,
      tokenInputTotalAtoms,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      sellerPayoutScript: wallet.payments.scriptBuffer,
      // Token change is a carrier, so it goes back to the ordinals address.
      sellerChangeScript: wallet.ordinals.scriptBuffer,
      feeScript: this.config.feeScript,
      minerFeeSats,
      funderInputs,
      funderChangeScript: wallet.payments.scriptBuffer,
      redeemFeeBps: this.config.redeemFeeBps,
      redeemFeeFlatSats: this.config.redeemFeeFlatSats,
    });
    const view = this.overlayPendingBacking(
      await this.loadView(params.tokenId, selected.map((u) => ({ txid: u.txid, vout: u.vout }))),
      params.tokenId,
      backing,
    );
    const req: TransitionSignRequest = { psbt: result.psbt, view, network: this.config.network, recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile, feeScript: this.config.feeScript, maxMinerFeeSats: this.config.maxMinerFeeSats, redeemFeeBps: this.config.redeemFeeBps,
      redeemFeeFlatSats: this.config.redeemFeeFlatSats, fundingChecker: this.fundingChecker };
    // Validate only; the Guardian signs at submit (see buildBackingBuy).
    const checked = await validateRedeemTransitionV3({ ...req, guardianXOnly: this.config.guardianXOnly });
    if (!checked.ok) throw new AppError("GUARDIAN_REJECTED", `${checked.reason}: ${checked.detail}`);
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "REDEEM",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: backing.stateHash,
      backingTxid: backing.input.txid,
      backingVout: backing.input.vout,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "REDEEM",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: result.grossSats,
        protocolFeeSats: result.redeemFeeSats,
        minerFeeSats: result.minerFeeSats,
        netSats: result.netSats,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: backing.stateHash,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitRedeem(params: { sessionId: string; signedPsbtBase64: string }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network) throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({ tokenId: session.tokenId ?? undefined, walletScript: session.walletScript });
    if (session.operation !== "REDEEM") throw new AppError("SESSION_STATE_INVALID", "session is not REDEEM");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED") return { txid: session.txid! };
    const started = await this.beginSessionSubmission(session, params.signedPsbtBase64);
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest) throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 1; i < psbt.data.inputs.length; i++) {
        validateInputSignature(psbt, i);
        psbt.finalizeInput(i);
      }
      // The view must include the token carriers being redeemed.
      const spent = psbt.txInputs.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString("hex"), vout: i.index }));
      const view = this.overlayPendingBacking(
        await this.loadView(session.tokenId!, spent),
        session.tokenId!,
        await this.loadBackingAt(session.tokenId!, session.backingTxid, session.backingVout),
      );
      const signed = await this.transitionSigner.signRedeem({ psbt, view, network: this.config.network, recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile, feeScript: this.config.feeScript, maxMinerFeeSats: this.config.maxMinerFeeSats, redeemFeeBps: this.config.redeemFeeBps,
        redeemFeeFlatSats: this.config.redeemFeeFlatSats, fundingChecker: this.fundingChecker });
      if (!signed.ok) {
        const transient = ["GUARDIAN_TIMEOUT", "REMOTE_GUARDIAN_UNAVAILABLE", "FUNDING_CHECK_UNAVAILABLE", "AUDIT_PERSISTENCE_FAILED", "SIGNING_FAILED"].includes(signed.reason);
        throw new AppError(transient ? "CORE_UNAVAILABLE" : "GUARDIAN_REJECTED", `${signed.reason}: ${signed.detail}`);
      }
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = await validateFinalizedRedeemTransaction({
        rawTxHex,
        view,
        network: this.config.network,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        redeemFeeBps: this.config.redeemFeeBps,
        redeemFeeFlatSats: this.config.redeemFeeFlatSats,
      });
      if (!("rawTxHex" in validated)) throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (error instanceof AppError && ["GUARDIAN_REJECTED", "STATE_CHANGED", "PSBT_MUTATED", "WALLET_SIGNATURE_INVALID"].includes(error.code)) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  // ── transfer ──────────────────────────────────────────────────────────────

  async buildTransfer(params: {
    tokenId: string;
    amountAtoms: bigint;
    recipientScript: string;
    walletScript: string;
    /** Optional second address for token carriers; defaults to walletScript. */
    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];
    /** Preferred: the fee rate the user picked; the server sizes the fee. */
    feeRateSatPerVb?: bigint;
    /** Explicit fee, for callers that size the transaction themselves. */
    minerFeeSats?: bigint;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    await this.requireHealthy();
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    const tokenUtxos = await getTokenUtxosByScriptDb(this.db, this.config.network, wallet.ordinals.script);
    const mine = tokenUtxos.filter((u) => u.tokenId === params.tokenId);
    const total = mine.reduce((s, u) => s + u.amountAtoms, 0n);
    if (total < params.amountAtoms) throw new AppError("TOKEN_AMOUNT_INVALID", "insufficient token balance");
    // Largest-first, taking only what the amount needs. This previously sorted
    // ASCENDING and took the four smallest unconditionally, so the balance
    // check above could pass on a wallet whose four smallest carriers held less
    // than the amount — the transfer then went on to build a negative token
    // change and failed far downstream. Same defect that was fixed in redeem.
    const sorted = [...mine].sort((a, b) =>
      a.amountAtoms !== b.amountAtoms ? (a.amountAtoms > b.amountAtoms ? -1 : 1) : a.txid < b.txid ? -1 : 1,
    );
    const selected: typeof sorted = [];
    let runningAtoms = 0n;
    for (const u of sorted) {
      if (runningAtoms >= params.amountAtoms) break;
      if (selected.length >= MAX_TRANSFER_TOKEN_INPUTS) break;
      selected.push(u);
      runningAtoms += u.amountAtoms;
    }
    if (runningAtoms < params.amountAtoms) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        `balance is spread across too many outputs: the ${MAX_TRANSFER_TOKEN_INPUTS} largest hold ` +
          `${runningAtoms} atoms, short of ${params.amountAtoms}. Consolidate with a transfer to ` +
          `yourself, or send a smaller amount.`,
      );
    }
    // A carrier on a Taproot ordinals address cannot be signed without its
    // internal key, so the public key travels with every token input.
    const tokenInputs: ResolvedInput[] = selected.map((u) => ({ txid: u.txid, vout: u.vout, script: Buffer.from(u.scriptPubKey, "hex"), valueSats: TOKEN_CARRIER_SATS, publicKey: wallet.ordinals.publicKeyBuffer }));
    const tokenInputTotalAtoms = selected.reduce((s, u) => s + u.amountAtoms, 0n);
    const changeAtoms = tokenInputTotalAtoms - params.amountAtoms;
    const tokenOutputs: { script: Buffer; amountAtoms: bigint }[] = [
      { script: Buffer.from(params.recipientScript, "hex"), amountAtoms: params.amountAtoms },
    ];
    if (changeAtoms > 0n) tokenOutputs.push({ script: wallet.ordinals.scriptBuffer, amountAtoms: changeAtoms });
    // Carrier outputs cost 1,000 sats each; the carriers being spent bring the
    // same back in. The wallet's own BTC covers the difference and the fee.
    const carrierSatsOut = BigInt(tokenOutputs.length) * TOKEN_CARRIER_SATS;
    const carrierSatsIn = BigInt(tokenInputs.length) * TOKEN_CARRIER_SATS;
    const { inputs: funderInputs, minerFeeSats } = await this.resolveFundingAndFee({
      op: "TRANSFER",
      wallet,
      candidates: params.funding,
      targetSats: carrierSatsOut - carrierSatsIn,
      tokenInputs: tokenInputs.length,
      recipientCarriers: tokenOutputs.length,
      feeRateSatPerVb: params.feeRateSatPerVb,
      explicitMinerFeeSats: params.minerFeeSats,
    });
    const result = buildTransferPsbtV2({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      tokenInputs,
      tokenInputTotalAtoms,
      tokenOutputs,
      funderInputs,
      funderChangeScript: wallet.payments.scriptBuffer,
      btcOutputs: [],
      minerFeeSats,
    });
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "TRANSFER",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: null,
      backingTxid: null,
      backingVout: null,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "TRANSFER",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: null,
        protocolFeeSats: null,
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: null,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitTransfer(params: { sessionId: string; signedPsbtBase64: string }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network) throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({ tokenId: session.tokenId ?? undefined, walletScript: session.walletScript });
    if (session.operation !== "TRANSFER") throw new AppError("SESSION_STATE_INVALID", "session is not TRANSFER");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED") return { txid: session.txid! };
    const started = await this.beginSessionSubmission(session, params.signedPsbtBase64);
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest) throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 0; i < psbt.data.inputs.length; i++) validateInputSignature(psbt, i);
      psbt.finalizeAllInputs();
      const rawTxHex = psbt.extractTransaction().toHex();
      const view = this.overlayPendingBacking(
        await this.loadView(session.tokenId!),
        session.tokenId!,
        await this.loadBackingAt(session.tokenId!, session.backingTxid, session.backingVout),
      );
      const validated = validateFinalizedTransferTransaction({ rawTxHex, view, maxMinerFeeSats: this.config.maxMinerFeeSats });
      if (!("rawTxHex" in validated)) throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (error instanceof AppError && ["GUARDIAN_REJECTED", "STATE_CHANGED", "PSBT_MUTATED", "WALLET_SIGNATURE_INVALID"].includes(error.code)) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  // ── tx status ─────────────────────────────────────────────────────────────

  async txStatus(txid: string) {
    const rows = await this.db.select().from(schema.coveV3AppTransactions).where(and(eq(schema.coveV3AppTransactions.network, this.config.network), eq(schema.coveV3AppTransactions.txid, txid)));
    const session = rows[0] ?? null;
    const evRows = await this.db.select().from(schema.coveV3Events).where(and(eq(schema.coveV3Events.network, this.config.network), eq(schema.coveV3Events.txid, txid), eq(schema.coveV3Events.canonical, true)));
    const confirmedHeight = evRows[0]?.blockHeight ?? null;
    const publicSession = session ? { status: session.status === "CONFIRMED" && confirmedHeight === null ? "REORGED" : session.status } : null;
    if (confirmedHeight !== null) return {
      txid, session: publicSession, state: "confirmed" as const, mempool: false,
      confirmedHeight, confirmedBlockHash: evRows[0]?.blockHash ?? null,
      observedAt: evRows[0]?.createdAt?.toISOString() ?? null, stale: false,
    };
    const unknown = {
      txid, session: publicSession, state: "unknown" as const, mempool: null,
      confirmedHeight: null, confirmedBlockHash: null, observedAt: null, stale: true,
    };
    if (session?.backingVout === 1 && await indexedBackingConflict(this.db, this.config.network, txid)) {
      return { ...unknown, session: { status: "CONFLICTED" }, state: "conflicted" as const, mempool: false, observedAt: new Date().toISOString(), stale: false };
    }
    if (!session) {
      const fills = await this.db.select({ id: schema.coveV3MarketFills.id }).from(schema.coveV3MarketFills)
        .where(and(eq(schema.coveV3MarketFills.network, this.config.network), eq(schema.coveV3MarketFills.txid, txid))).limit(1);
      if (fills.length === 0) return unknown;
    }
    try {
      const observation = await this.provider.observeTransaction(txid, { signal: AbortSignal.timeout(5_000), retry: false });
      if (observation.state === "unknown") return unknown;
      return {
        ...unknown, state: observation.state === "mempool" ? "pending" as const : "mined" as const,
        mempool: observation.state === "mempool", observedAt: new Date().toISOString(), stale: false,
      };
    } catch {
      return unknown;
    }
  }

  // ── reconcile app sessions (worker) ───────────────────────────────────────

  async reconcileAppSessions(): Promise<{ confirmed: number }> {
    let confirmed = 0;
    const pending = await this.db
      .select()
      .from(schema.coveV3AppTransactions)
      .where(and(eq(schema.coveV3AppTransactions.network, this.config.network), eq(schema.coveV3AppTransactions.status, "BROADCAST")));
    for (const s of pending) {
      if (!s.txid) continue;
      const ev = await this.db
        .select()
        .from(schema.coveV3Events)
        .where(and(eq(schema.coveV3Events.network, this.config.network), eq(schema.coveV3Events.txid, s.txid), eq(schema.coveV3Events.canonical, true)));
      if (ev.length > 0) {
        await updateTxSession(this.db, s.id, { status: "CONFIRMED" });
        confirmed++;
      }
    }
    return { confirmed };
  }

  // ── market (P2P) ──────────────────────────────────────────────────────────

  async prepareListing(params: {
    tokenId: string;
    sourceTxid: string;
    sourceVout: number;
    amountAtoms: bigint;
    totalPriceSats: bigint;
    /**
     * How long the ask stays fillable, in blocks. Preferred over an absolute
     * height: the browser does not know the chain tip, and an ask that outlives
     * the price it was written at is a gift to whoever notices it later.
     */
    expiryBlocks?: bigint;
    /** Absolute height, for callers that compute it themselves. */
    expiryHeight?: bigint;
    walletScript: string;
    /** Optional second address for token carriers; defaults to walletScript. */
    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    nonceHex: string;
  }): Promise<{ listing: ListingV1; listingId: string; listingPsbtBase64: string; expiryHeight: bigint }> {
    this.assertEnabled();
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    const utxoRows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          eq(schema.coveV3TokenUtxos.txid, params.sourceTxid),
          eq(schema.coveV3TokenUtxos.vout, params.sourceVout),
          eq(schema.coveV3TokenUtxos.tokenId, params.tokenId),
          eq(schema.coveV3TokenUtxos.scriptPubKey, wallet.ordinals.script),
          eq(schema.coveV3TokenUtxos.canonical, true),
          isNull(schema.coveV3TokenUtxos.spentByTxid),
        ),
      );
    // A listing sells one whole carrier. It is either indexed already, or the
    // exact-amount output of a split the seller just broadcast (the market
    // checks that transaction's own envelope; the listing waits as PENDING).
    const u = utxoRows[0];
    if (u && u.amountAtoms !== params.amountAtoms) {
      throw new AppError("TOKEN_AMOUNT_INVALID", "a listing sells a whole token carrier; split off the amount first");
    }
    const sourceAmountAtoms = u ? u.amountAtoms : params.amountAtoms;
    const cursor = await this.db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, this.config.network));
    const tip = cursor[0]?.height ?? 0n;
    const nonce = Buffer.from(params.nonceHex, "hex");
    if (nonce.length !== 32) throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");
    // Resolve the expiry against the tip the server just read, and refuse a
    // window longer than the market allows rather than letting the signature
    // be wasted on an order that createListing will reject.
    const expiryHeight =
      params.expiryBlocks !== undefined && params.expiryBlocks > 0n
        ? tip + params.expiryBlocks
        : (params.expiryHeight ?? tip + DEFAULT_LISTING_BLOCKS);
    if (expiryHeight <= tip) {
      throw new AppError("TOKEN_AMOUNT_INVALID", "listing would already be expired");
    }
    if (expiryHeight - tip > this.config.maxListingBlocks) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        `a listing may stay open for at most ${this.config.maxListingBlocks} blocks ` +
          `(about ${this.config.maxListingBlocks / 144n} days)`,
      );
    }
    const listing: ListingV1 = {
      orderVersion: 1,
      chainIdentity: this.config.chainIdentity,
      tokenId: params.tokenId,
      // The carrier being sold and any token change belong to the ordinals
      // address; the BTC the seller is paid goes to the payment address.
      sellerTokenScript: wallet.ordinals.script,
      sellerPayoutScript: wallet.payments.script,
      sellerTokenChangeScript: wallet.ordinals.script,
      sourceTxid: params.sourceTxid,
      sourceVout: params.sourceVout,
      sourceAmountAtoms,
      amountAtoms: sourceAmountAtoms,
      totalPriceSats: params.totalPriceSats,
      creationHeight: tip,
      expiryHeight,
      nonce: nonce.toString("hex"),
    };
    const listingId = listingIdOf(listing);
    // The one thing the seller signs: their carrier, SIGHASH_SINGLE|ANYONECANPAY,
    // over their payout. Nothing more is asked of them when it sells.
    const listingPsbtBase64 = await this.market.buildListingPsbtFor(listing, wallet.ordinals.publicKey || undefined);
    return { listing, listingId, listingPsbtBase64, expiryHeight };
  }

  createListing(listing: ListingV1, presignedPsbtBase64: string, sellerTokenPublicKey?: string) {
    this.assertMutating();
    this.assertCanaryAllowed({ tokenId: listing.tokenId, walletScript: listing.sellerPayoutScript });
    return this.market.createListing({ ...listing, presignedPsbtBase64, sellerTokenPublicKey });
  }

  prepareCancellation(listingId: string, nonceHex: string) {
    const cancelNonce = Buffer.from(nonceHex, "hex");
    if (cancelNonce.length !== 32) throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");
    const c = { version: 1 as const, listingId, cancelNonce: cancelNonce.toString("hex") };
    return { cancelNonce: c.cancelNonce, cancelHash: cancellationHashOf(c), message: cancellationMessageToSign(c) };
  }

  cancelListing(listingId: string, nonceHex: string, signatureB64: string) {
    this.assertMutating();
    return this.market.cancelListing(listingId, Buffer.from(nonceHex, "hex").toString("hex"), signatureB64);
  }

  reserveListing(input: Parameters<MarketService["reserveListing"]>[0]) {
    this.assertMutating();
    return this.market.reserveListing(input);
  }

  preflightReserveListing(input: Parameters<MarketService["preflightReserveListing"]>[0]) {
    this.assertMutating();
    return this.market.preflightReserveListing(input);
  }
  buildFillPsbt(fillId: string, fee: { feeRateSatPerVb?: bigint; minerFeeSats?: bigint }) {
    this.assertMutating();
    return this.market.buildFillPsbt(fillId, fee);
  }
  /**
   * The buyer's signed fill, then the sale is completed at once: the stored
   * seller presignature is attached and the transaction broadcast. The seller
   * is not involved.
   */
  async submitBuyerSignature(fillId: string, psbtB64: string): Promise<{ txid: string }> {
    this.assertMutating();
    await this.market.submitBuyerSignedPsbt(fillId, psbtB64);
    return this.finalizeAndBroadcastFill(fillId);
  }
  finalizeFill(fillId: string) {
    this.assertMutating();
    return this.market.finalizeP2PFill(fillId);
  }
  broadcastFill(validated: Parameters<MarketService["broadcastP2PFill"]>[0]) {
    this.assertMutating();
    return this.market.broadcastP2PFill(validated);
  }
  getFill(fillId: string) {
    return this.db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fillId));
  }
  async publicFillStatus(fillId: string) {
    const rows = await this.db.select({
      id: schema.coveV3MarketFills.id,
      tokenId: schema.coveV3MarketFills.tokenId,
      status: schema.coveV3MarketFills.status,
      txid: schema.coveV3MarketFills.txid,
      blockHeight: schema.coveV3MarketFills.blockHeight,
      blockHash: schema.coveV3MarketFills.blockHash,
      canonical: schema.coveV3MarketFills.canonical,
      updatedAt: schema.coveV3MarketFills.updatedAt,
    }).from(schema.coveV3MarketFills)
      .where(and(eq(schema.coveV3MarketFills.network, this.config.network), eq(schema.coveV3MarketFills.id, fillId))).limit(1);
    return rows[0] ?? null;
  }
  async finalizeAndBroadcastFill(fillId: string): Promise<{ txid: string }> {
    // §P0-6: this was the only mutation with no server-side guard. Gate on
    // enabled + network (config-driven), health/quorum, and the canary
    // allowlist before finalizing or broadcasting anything.
    this.assertMutating();
    await this.requireHealthy();
    const fills = await this.getFill(fillId);
    const fill = fills[0];
    if (!fill) throw new AppError("STATE_CHANGED", "fill not found");
    this.assertCanaryAllowed({ tokenId: fill.tokenId, walletScript: fill.buyerTokenScript });
    return this.market.completeFill(fillId);
  }
  getBuyRoutes(tokenId: string, amountAtoms: bigint) {
    return getBuyRoutes(this.db, this.config.network, tokenId, amountAtoms, {
      buyFeeBps: this.config.buyFeeBps,
      p2pFeeBps: this.market.config.p2pFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      p2pFeeMinSats: this.market.config.p2pFeeMinSats,
    });
  }
  getSellOptions(tokenId: string, walletScript: string) {
    return getSellOptions(this.db, this.config.network, tokenId, walletScript, this.config.redeemFeeBps);
  }
  /**
   * Active listings, each carrying the ticker of the token it sells.
   *
   * The ticker comes from a left join rather than a second round trip: a market
   * row that shows only a 64-character token id tells a buyer nothing about
   * what they are buying. The join is left, not inner, so a listing whose token
   * row is missing still appears — with a null ticker — instead of silently
   * vanishing from the book.
   */
  async listListings(opts: { tokenId?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 200);
    const base = [
      eq(schema.coveV3MarketListings.network, this.config.network),
      eq(schema.coveV3MarketListings.status, "ACTIVE"),
    ];
    const cond = opts.tokenId
      ? and(...base, eq(schema.coveV3MarketListings.tokenId, opts.tokenId))
      : and(...base);

    const rows = await this.db
      .select({ listing: schema.coveV3MarketListings, ticker: schema.coveV3Tokens.ticker })
      .from(schema.coveV3MarketListings)
      .leftJoin(
        schema.coveV3Tokens,
        and(
          eq(schema.coveV3Tokens.network, schema.coveV3MarketListings.network),
          eq(schema.coveV3Tokens.tokenId, schema.coveV3MarketListings.tokenId),
          // A token row orphaned by a reorg must not supply a ticker.
          eq(schema.coveV3Tokens.canonical, true),
        ),
      )
      .where(cond)
      .limit(limit);

    // The seller's presignature never leaves the server.
    return rows.map((r) => ({ ...publicListing(r.listing), ticker: r.ticker }));
  }

  // ── broadcast boundary ────────────────────────────────────────────────────

  private submissionError(error: unknown): Error {
    if (error instanceof SubmissionError) return new AppError(error.code === "CONFLICT" ? "PSBT_MUTATED" : "CORE_UNAVAILABLE", error.message);
    return error instanceof Error ? error : new Error("submission failed");
  }

  private async beginSessionSubmission(session: TxSessionRow, signedPsbtBase64: string): Promise<{ job: Submission; psbt: bitcoin.Psbt } | { txid: string; submissionState: "saved" | "broadcast" }> {
    const incoming = parsePsbt(signedPsbtBase64, btcNetwork(this.config.network));
    if (unsignedTxDigest(incoming) !== session.unsignedTxDigest) throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
    const first = session.operation === "BACKING_BUY" || session.operation === "REDEEM" ? 1 : 0;
    for (let i = first; i < incoming.data.inputs.length; i++) validateInputSignature(incoming, i);
    let job: Submission | undefined;
    try {
      const prepared = await prepareSubmission(this.db, { network: session.network, sourceKind: "APP", sourceId: session.id,
        operation: session.operation, tokenId: session.tokenId, backingTxid: session.backingTxid, backingVout: session.backingVout,
        unsignedTxDigest: session.unsignedTxDigest!, walletPsbtBase64: signedPsbtBase64 });
      if (prepared.phase === "BROADCAST") return { txid: prepared.txid!, submissionState: "broadcast" };
      if (prepared.phase === "RECOVERY_REQUIRED") await resumeSubmission(this.db, prepared.id);
      job = await claimSubmission(this.db, prepared.id);
      if (job.phase === "READY") {
        try { return await this.broadcastSubmission(job); }
        finally { await deferSubmission(this.db, job).catch(() => {}); }
      }
      return { job, psbt: parsePsbt(job.walletPsbtBase64, btcNetwork(this.config.network)) };
    } catch (error) {
      if (job) await deferSubmission(this.db, job).catch(() => {});
      throw this.submissionError(error);
    }
  }

  private async broadcastSubmission(job: Submission, validated?: ValidatedCoveTransaction): Promise<{ txid: string; submissionState: "saved" | "broadcast" }> {
    if (job.phase === "SIGNING") {
      if (!validated) throw new AppError("STATE_CHANGED", "submission has not been validated");
      job = await saveSignedSubmission(this.db, job, { rawTxHex: validated.rawTxHex, txid: validated.txid });
    }
    if (!job.rawTxHex || !job.txid) throw new AppError("STATE_CHANGED", "submission has no signed bytes");
    const confirmed = await this.db.select({ txid: schema.coveV3Events.txid }).from(schema.coveV3Events)
      .where(and(eq(schema.coveV3Events.network, job.network), eq(schema.coveV3Events.txid, job.txid), eq(schema.coveV3Events.canonical, true))).limit(1);
    try {
      if (!confirmed.length) {
        await this.requireHealthy();
        await broadcastRecordedTransaction(this.provider, { rawTxHex: job.rawTxHex, txid: job.txid }, this.config.network);
      }
      await publishSubmission(this.db, job);
      return { txid: job.txid, submissionState: "broadcast" };
    } catch {
      return { txid: job.txid, submissionState: "saved" };
    }
  }

  async recoverSubmissions(limit = 2): Promise<{ recovered: number }> {
    this.assertMutating();
    let recovered = 0;
    for (const job of await dueSubmissions(this.db, this.config.network, limit)) {
      try {
        if (job.sourceKind === "FILL") {
          const receipt = await this.market.recoverSubmission(job);
          if (receipt.submissionState === "broadcast") recovered++;
          continue;
        } else {
          const owner = await requireTxSession(this.db, job.sourceId);
          this.assertCanaryAllowed({ tokenId: owner.tokenId ?? undefined, walletScript: owner.walletScript });
          if (job.phase === "READY") {
            const claimed = await claimSubmission(this.db, job.id);
            try {
              const receipt = await this.broadcastSubmission(claimed);
              if (receipt.submissionState === "broadcast") recovered++;
            } finally { await deferSubmission(this.db, claimed).catch(() => {}); }
            continue;
          }
          const input = { sessionId: job.sourceId, signedPsbtBase64: job.walletPsbtBase64 };
          if (job.operation === "DEPLOY") await this.submitLaunch(input);
          else if (job.operation === "BACKING_BUY") await this.submitBackingBuy(input);
          else if (job.operation === "REDEEM") await this.submitRedeem(input);
          else if (job.operation === "TRANSFER") await this.submitTransfer(input);
          else throw new AppError("SESSION_STATE_INVALID", "unknown saved operation");
        }
        if ((await getSubmission(this.db, job.network, job.sourceKind, job.sourceId))?.phase === "BROADCAST") recovered++;
      } catch (error) {
        console.warn("submission recovery deferred:", job.id, error instanceof AppError ? error.code : "UNAVAILABLE");
      }
    }
    return { recovered };
  }
}
