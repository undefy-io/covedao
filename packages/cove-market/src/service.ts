import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { eq, and, isNull, inArray, lte, desc } from "drizzle-orm";
import { schema, type Database, type DbTransaction } from "@crclaunch/db";
import {
  estimateVsize,
  loadFeeRates,
  resolveMinerFee,
  FeeError,
  type CoreRpcProvider,
} from "@crclaunch/bitcoin";
import { TOKEN_CARRIER_SATS, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import { loadCanonicalViewSnapshotFromDb, parseCoveTx } from "@crclaunch/cove-indexer/v3";
import { deterministicFee, dustThreshold } from "@crclaunch/cove-economics";
import { OP_TRANSFER as OP_TRANSFER_CODE } from "@crclaunch/cove-wire";
import { scriptForKind, spendKindOf } from "@crclaunch/bitcoin";
import { MarketError } from "./errors.js";
import type { MarketConfig } from "./config.js";
import type { ListingV1, CancellationV1 } from "./types.js";
import { listingIdOf, cancellationHashOf } from "./order/hash.js";
import { verifyCancellationAuthorization, verifyReservationAuthorization } from "./order/signature.js";
import { validateListingShape } from "./order/validate.js";
import { unsignedTxDigest, parsePsbt, validateP2wpkhPartialSig, partialSigOfInput } from "./psbt.js";
import {
  buildListingPsbt,
  verifyListingPsbt,
  presigOf,
  buildPresignedFillPsbt,
  attachSellerPresig,
  FILL_SELLER_INPUT,
} from "./presign.js";
import {
  validateFinalizedP2PFill,
  broadcastValidatedP2PFill,
  assertSettlementCap,
  type ValidatedP2PFill,
  type P2PFillTerms,
} from "./finalize.js";
import { assertMarketReady } from "./health.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export interface BuyerFundInput {
  txid: string;
  vout: number;
  script: string; // hex
  valueSats: bigint;
}

export interface CreateListingInput extends ListingV1 {
  /**
   * The seller-signed listing PSBT (see presign.ts): the whole carrier signed
   * SIGHASH_SINGLE|ANYONECANPAY over their payout. It is the seller's
   * authorisation AND what completes every future sale, so the seller never
   * signs again. Stored server-side and never returned.
   */
  presignedPsbtBase64: string;
  /** Public key of sellerTokenScript (hex); required unless it is native segwit. */
  sellerTokenPublicKey?: string;
}

/**
 * How long a listing may wait for its carrier to be indexed. A listing made
 * right after a split points at an output still in the mempool; it goes live
 * once a block confirms it, and is dropped if that never happens.
 */
export const PENDING_LISTING_MAX_BLOCKS = 6n;

/** Listing statuses a buyer may see or act on; PENDING is hidden until its carrier confirms. */
export const LISTING_SECRET_COLUMNS = ["sellerPresignedPsbt"] as const;

/** A listing row without the columns that must never leave the server. */
export function publicListing<T extends { sellerPresignedPsbt?: string | null }>(row: T): Omit<T, "sellerPresignedPsbt"> {
  const { sellerPresignedPsbt: _secret, ...rest } = row;
  void _secret;
  return rest;
}

export interface ReserveListingInput {
  listingId: string;
  buyerTokenScript: string; // hex
  buyerChangeScript: string; // hex
  buyerFundInputs: BuyerFundInput[];
  /** Public key of the buyer's funding script (hex); required unless it is native segwit. */
  buyerFundPublicKey?: string;
  /** 32-byte hex nonce the buyer signed (§M4). */
  reserveNonce: string;
  /** BIP-322 signature over the reservation message (§M4). */
  signatureB64: string;
}

type ListingSelect = typeof schema.coveV3MarketListings.$inferSelect;
type FillSelect = typeof schema.coveV3MarketFills.$inferSelect;

interface SourceResolution {
  scriptPubKey: Buffer;
  amountAtoms: bigint;
  valueSats: bigint;
}

function btcNetwork(network: MarketConfig["network"]): bitcoin.networks.Network {
  // Mainnet must not fall through to testnet parameters (signet and testnet
  // legitimately share them; mainnet does not).
  if (network === "regtest") return bitcoin.networks.regtest;
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  return bitcoin.networks.testnet;
}

function asBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function listingToV1(row: ListingSelect): ListingV1 {
  return {
    orderVersion: row.orderVersion as 1,
    chainIdentity: row.chainIdentity,
    tokenId: row.tokenId,
    sellerTokenScript: row.sellerTokenScript,
    sellerPayoutScript: row.sellerPayoutScript,
    sellerTokenChangeScript: row.sellerTokenChangeScript,
    sourceTxid: row.sourceTxid,
    sourceVout: row.sourceVout,
    sourceAmountAtoms: row.sourceAmountAtoms,
    amountAtoms: row.amountAtoms,
    totalPriceSats: row.totalPriceSats,
    creationHeight: row.creationHeight,
    expiryHeight: row.expiryHeight,
    nonce: row.nonce,
  };
}

/**
 * A P2P fill's OP_RETURN: a wire-v2 TRANSFER with at most two allocations
 * (the buyer's tokens and the seller's change), plus OP_RETURN and its push
 * length.
 */
const P2P_OP_RETURN_SCRIPT_BYTES = 57;

/**
 * Check that `publicKeyHex` controls `scriptHex`, and that one is supplied when
 * the script needs it. A native-segwit script carries its own key hash; any
 * other kind cannot be put in a signable PSBT without the key.
 */
function assertKeyControls(scriptHex: string, publicKeyHex: string | undefined, network: bitcoin.networks.Network, who: string): void {
  const script = Buffer.from(scriptHex, "hex");
  const kind = spendKindOf(script);
  if (kind === null) throw new MarketError("UNSUPPORTED_ADDRESS", `${who} address type is not supported`);
  if (!publicKeyHex) {
    if (kind === "p2wpkh") return;
    throw new MarketError("PUBLIC_KEY_REQUIRED", `${who} public key is required for a ${kind} address`);
  }
  let derived: Buffer;
  try {
    derived = scriptForKind(kind, Buffer.from(publicKeyHex, "hex"), network);
  } catch {
    throw new MarketError("PUBLIC_KEY_REQUIRED", `${who} public key is invalid`);
  }
  if (!derived.equals(script)) throw new MarketError("PUBLIC_KEY_REQUIRED", `${who} public key does not control that address`);
}

function fillFundInputs(fill: FillSelect): BuyerFundInput[] {
  const raw = fill.buyerFundInputs as unknown as { txid: string; vout: number; script: string; valueSats: string }[];
  return raw.map((f) => ({ txid: f.txid, vout: f.vout, script: f.script, valueSats: BigInt(f.valueSats) }));
}

/**
 * V3-native fixed-price marketplace service (§15-§30). No custody, no private
 * keys server-side, no "send first", no DB-only settlement. Inventory is always
 * re-resolved from the canonical V3 DB + Core at every critical step.
 */
export class MarketService {
  constructor(
    readonly db: Database,
    readonly provider: CoreRpcProvider,
    readonly config: MarketConfig,
  ) {}

  /** The market fee on a fill: a percentage, floored so it is never dust. */
  marketFeeFor(totalPriceSats: bigint): bigint {
    return deterministicFee(totalPriceSats, this.config.p2pFeeBps, 0n, this.config.p2pFeeMinSats);
  }

  /** Resolve the seller's source token UTXO from the canonical V3 DB + Core. */
  private async resolveSource(listing: ListingV1): Promise<SourceResolution> {
    const rows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          eq(schema.coveV3TokenUtxos.txid, listing.sourceTxid),
          eq(schema.coveV3TokenUtxos.vout, listing.sourceVout),
          eq(schema.coveV3TokenUtxos.tokenId, listing.tokenId),
          eq(schema.coveV3TokenUtxos.scriptPubKey, listing.sellerTokenScript),
          eq(schema.coveV3TokenUtxos.canonical, true),
          isNull(schema.coveV3TokenUtxos.spentByTxid),
        ),
      );
    if (rows.length !== 1) throw new MarketError("LISTING_BAD_SOURCE", "source token UTXO not canonical/unspent");
    const row = rows[0]!;
    if (row.amountAtoms !== listing.sourceAmountAtoms) {
      throw new MarketError("LISTING_SOURCE_MISMATCH", "source amount mismatch vs indexer");
    }

    // Core gettxout — authoritative unspent + script check (catches mempool spends).
    const txout = await this.provider.getTxout(listing.sourceTxid, listing.sourceVout);
    if (!txout) throw new MarketError("LISTING_SOURCE_SPENT", "source outpoint already spent");
    if (txout.scriptPubKeyHex !== listing.sellerTokenScript) {
      throw new MarketError("LISTING_SOURCE_MISMATCH", "source script mismatch vs Core");
    }
    return { scriptPubKey: asBuffer(listing.sellerTokenScript), amountAtoms: row.amountAtoms, valueSats: txout.valueSats };
  }

  /**
   * A carrier that is not indexed yet: the output of a Cove TRANSFER still in
   * the mempool (the seller just split off the amount they are listing). Core
   * must hold it unspent at the seller's script with 1,000 sats, and the
   * transaction's own Cove envelope must allocate exactly the listed amount
   * of this token to it. The indexer has the last word when it confirms.
   */
  private async resolvePendingSource(listing: ListingV1): Promise<SourceResolution> {
    const txout = await this.provider.getTxout(listing.sourceTxid, listing.sourceVout);
    if (!txout) throw new MarketError("LISTING_BAD_SOURCE", "source outpoint is not an unspent output");
    if (txout.scriptPubKeyHex !== listing.sellerTokenScript || txout.valueSats !== TOKEN_CARRIER_SATS) {
      throw new MarketError("LISTING_SOURCE_MISMATCH", "source output is not a token carrier at the seller's address");
    }
    let raw: string;
    try {
      raw = await this.provider.getRawTransaction(listing.sourceTxid);
    } catch {
      throw new MarketError("LISTING_BAD_SOURCE", "source transaction not found");
    }
    const parsed = parseCoveTx(raw);
    if (parsed.kind !== "TRANSFER" || parsed.envelope.op !== OP_TRANSFER_CODE) {
      throw new MarketError("LISTING_BAD_SOURCE", "source is not the output of a covs transfer");
    }
    if (parsed.envelope.tokenId.toString("hex") !== listing.tokenId) {
      throw new MarketError("LISTING_SOURCE_MISMATCH", "source transfer moves another token");
    }
    const alloc = parsed.envelope.allocations.find((a) => a.vout === listing.sourceVout);
    if (!alloc || alloc.amount !== listing.sourceAmountAtoms) {
      throw new MarketError("LISTING_SOURCE_MISMATCH", "source transfer does not put the listed amount on that output");
    }
    return { scriptPubKey: asBuffer(listing.sellerTokenScript), amountAtoms: alloc.amount, valueSats: txout.valueSats };
  }

  private async loadListing(listingId: string): Promise<ListingSelect | null> {
    const rows = await this.db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
    return rows[0] ?? null;
  }

  private async loadFill(fillId: string): Promise<FillSelect | null> {
    const rows = await this.db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fillId));
    return rows[0] ?? null;
  }

  async createListing(input: CreateListingInput): Promise<string> {
    // §M5: a listing must commit to THIS market's chain identity, not another
    // network's (which would let a foreign-chain signature/state pass through).
    if (input.chainIdentity !== this.config.chainIdentity) {
      throw new MarketError("CHAIN_IDENTITY_MISMATCH", `listing chainIdentity ${input.chainIdentity} != server ${this.config.chainIdentity}`);
    }
    await assertMarketReady({ db: this.db, config: this.config, provider: this.provider });
    validateListingShape(input);

    // A listing must actually expire. `maxListingBlocks` was configured but
    // never enforced, so a seller could sign an ask that stayed fillable
    // forever — and an ask priced months ago is a gift to whoever notices it
    // after the market moves. The window is checked here, at the point the
    // signed order is accepted.
    const listingWindow = input.expiryHeight - input.creationHeight;
    if (listingWindow > this.config.maxListingBlocks) {
      throw new MarketError(
        "LISTING_EXPIRY_TOO_FAR",
        `listing would stay open for ${listingWindow} blocks; the limit is ` +
          `${this.config.maxListingBlocks} (about ${this.config.maxListingBlocks / 144n} days)`,
      );
    }

    assertKeyControls(input.sellerTokenScript, input.sellerTokenPublicKey, btcNetwork(this.config.network), "seller token");
    // A presigned listing sells its whole carrier: a SIGHASH_SINGLE signature
    // cannot protect token change, so there is none.
    if (input.amountAtoms !== input.sourceAmountAtoms) {
      throw new MarketError("LISTING_AMOUNT_INVALID", "a listing sells a whole token carrier; split off the amount first");
    }
    // Live if the carrier is indexed; PENDING if it is a fresh split still in
    // the mempool (checked against the transaction itself).
    let pending = false;
    let source: SourceResolution;
    try {
      source = await this.resolveSource(input);
    } catch (e) {
      if (!(e instanceof MarketError) || e.code !== "LISTING_BAD_SOURCE") throw e;
      source = await this.resolvePendingSource(input);
      pending = true;
    }
    // The presignature IS the authorisation: only the carrier's owner can make it.
    verifyListingPsbt(input.presignedPsbtBase64, {
      network: btcNetwork(this.config.network),
      source: {
        txid: input.sourceTxid,
        vout: input.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: input.sellerTokenPublicKey ? asBuffer(input.sellerTokenPublicKey) : undefined,
      },
      payoutScript: asBuffer(input.sellerPayoutScript),
      priceSats: input.totalPriceSats,
    });

    if (input.totalPriceSats < dustThreshold(asBuffer(input.sellerPayoutScript))) {
      throw new MarketError("SELLER_PAYOUT_DUST", "seller payout below relay dust");
    }
    assertSettlementCap(input.totalPriceSats, this.config.maxP2pSettlementSats);
    const marketFee = this.marketFeeFor(input.totalPriceSats);
    if (marketFee < dustThreshold(this.config.feeScript)) {
      throw new MarketError("MARKET_FEE_DUST", "p2p fee below relay dust");
    }

    const listingId = listingIdOf(input);
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      if (existing.length > 0) throw new MarketError("STATE_CHANGED", "listingId already exists");

      await tx.insert(schema.coveV3MarketListings).values({
        listingId,
        network: this.config.network,
        chainIdentity: input.chainIdentity,
        tokenId: input.tokenId,
        orderVersion: input.orderVersion,
        sellerTokenScript: input.sellerTokenScript,
        sellerPayoutScript: input.sellerPayoutScript,
        sellerTokenChangeScript: input.sellerTokenChangeScript,
        sourceTxid: input.sourceTxid,
        sourceVout: input.sourceVout,
        sourceAmountAtoms: input.sourceAmountAtoms,
        amountAtoms: input.amountAtoms,
        totalPriceSats: input.totalPriceSats,
        creationHeight: input.creationHeight,
        expiryHeight: input.expiryHeight,
        nonce: input.nonce,
        // The BIP-322 order signature is superseded by the presignature.
        signatureB64: "",
        sellerTokenPublicKey: input.sellerTokenPublicKey ?? null,
        sellerPresignedPsbt: input.presignedPsbtBase64,
        status: pending ? "PENDING" : "ACTIVE",
      });
      await tx.insert(schema.coveV3MarketListingInputs).values({
        listingId,
        sourceTxid: input.sourceTxid,
        sourceVout: input.sourceVout,
        amountAtoms: input.sourceAmountAtoms,
        scriptPubKey: input.sellerTokenScript,
      });
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId,
        eventType: "LISTING_CREATED",
        payloadJson: { amountAtoms: input.amountAtoms.toString(), totalPriceSats: input.totalPriceSats.toString(), pending },
      });
    });
    return listingId;
  }

  /**
   * The unsigned listing PSBT a seller signs for these terms (whole carrier,
   * SIGHASH_SINGLE|ANYONECANPAY over their payout). The carrier may be indexed
   * or a fresh split still in the mempool.
   */
  async buildListingPsbtFor(listing: ListingV1, sellerTokenPublicKey?: string): Promise<string> {
    validateListingShape(listing);
    if (listing.amountAtoms !== listing.sourceAmountAtoms) {
      throw new MarketError("LISTING_AMOUNT_INVALID", "a listing sells a whole token carrier; split off the amount first");
    }
    assertKeyControls(listing.sellerTokenScript, sellerTokenPublicKey, btcNetwork(this.config.network), "seller token");
    let source: SourceResolution;
    try {
      source = await this.resolveSource(listing);
    } catch (e) {
      if (!(e instanceof MarketError) || e.code !== "LISTING_BAD_SOURCE") throw e;
      source = await this.resolvePendingSource(listing);
    }
    return buildListingPsbt({
      network: btcNetwork(this.config.network),
      source: {
        txid: listing.sourceTxid,
        vout: listing.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: sellerTokenPublicKey ? asBuffer(sellerTokenPublicKey) : undefined,
      },
      payoutScript: asBuffer(listing.sellerPayoutScript),
      priceSats: listing.totalPriceSats,
    }).toBase64();
  }

  async cancelListing(listingId: string, cancelNonce: string, signatureB64: string): Promise<void> {
    const listing = await this.loadListing(listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    const cancellation: CancellationV1 = { version: 1, listingId, cancelNonce };
    if (!verifyCancellationAuthorization(listingToV1(listing), cancellation, signatureB64)) {
      throw new MarketError("LISTING_BAD_SIGNATURE", "cancellation BIP-322 signature invalid");
    }
    const cancelHash = cancellationHashOf(cancellation);

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, listingId))
        .for("update");
      const row = rows[0];
      if (!row) throw new MarketError("STATE_CHANGED", "listing not found");
      // A cancelled listing NEVER resurrects (even across reorg).
      if (row.status === "FILLED" || row.status === "CANCELLED") {
        throw new MarketError("LISTING_CANCELLED", `cannot cancel ${row.status} listing`);
      }
      await tx.insert(schema.coveV3MarketCancellations).values({ listingId, cancelHash, cancelNonce, signatureB64 });
      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            inArray(schema.coveV3MarketFills.status, ["RESERVED", "PSBT_BUILT", "BUYER_SIGNED"]),
          ),
        );
      // The presignature goes with the listing: nobody can complete a sale now.
      await tx
        .update(schema.coveV3MarketListings)
        .set({ sellerPresignedPsbt: null })
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId,
        eventType: "LISTING_CANCELLED",
        payloadJson: { cancelHash },
      });
    });
  }

  async reserveListing(input: ReserveListingInput): Promise<string> {
    // §M4: require a signed nonce — an unsigned reserve lets anyone lock every
    // listing for free (denial-of-service).
    if (!verifyReservationAuthorization({ version: 1, listingId: input.listingId, reserveNonce: input.reserveNonce, buyerTokenScript: input.buyerTokenScript }, input.signatureB64)) {
      throw new MarketError("LISTING_BAD_SIGNATURE", "reservation BIP-322 signature invalid");
    }
    await assertMarketReady({ db: this.db, config: this.config, provider: this.provider });
    for (const f of input.buyerFundInputs) {
      if (f.script !== input.buyerChangeScript) {
        throw new MarketError("BUYER_FUNDS_INSUFFICIENT", "every funding coin must belong to the buyer's payment address");
      }
    }
    assertKeyControls(input.buyerChangeScript, input.buyerFundPublicKey, btcNetwork(this.config.network), "buyer payment");
    // A token carrier spent as BTC burns its tokens.
    const carriers = await this.db
      .select({ txid: schema.coveV3TokenUtxos.txid, vout: schema.coveV3TokenUtxos.vout })
      .from(schema.coveV3TokenUtxos)
      .where(and(
        eq(schema.coveV3TokenUtxos.network, this.config.network),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
        eq(schema.coveV3TokenUtxos.scriptPubKey, input.buyerChangeScript),
      ));
    const carrierKeys = new Set(carriers.map((c) => `${c.txid}:${c.vout}`));
    if (input.buyerFundInputs.some((f) => carrierKeys.has(`${f.txid}:${f.vout}`))) {
      throw new MarketError("BUYER_FUNDS_INSUFFICIENT", "a funding coin holds tokens and cannot pay for a purchase");
    }
    const tip = BigInt(await this.provider.getBestHeight());

    const fillId = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, input.listingId))
        .for("update");
      const row = rows[0];
      if (!row) throw new MarketError("STATE_CHANGED", "listing not found");
      if (row.status !== "ACTIVE") throw new MarketError("LISTING_RESERVED", `listing is ${row.status}`);
      if (row.expiryHeight <= tip) {
        await tx.update(schema.coveV3MarketListings).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, input.listingId));
        throw new MarketError("LISTING_EXPIRED", "listing expired");
      }

      await this.resolveSource(listingToV1(row));

      const marketFee = this.marketFeeFor(row.totalPriceSats);
      const [inserted] = await tx
        .insert(schema.coveV3MarketFills)
        .values({
          listingId: input.listingId,
          network: this.config.network,
          tokenId: row.tokenId,
          buyerTokenScript: input.buyerTokenScript,
          buyerChangeScript: input.buyerChangeScript,
          buyerFundInputs: input.buyerFundInputs.map((f) => ({ txid: f.txid, vout: f.vout, script: f.script, valueSats: f.valueSats.toString() })),
          buyerFundPublicKey: input.buyerFundPublicKey ?? null,
          amountAtoms: row.amountAtoms,
          totalPriceSats: row.totalPriceSats,
          marketFeeSats: marketFee,
          extraCarrierSats: 0n,
          minerFeeSats: 0n,
          status: "RESERVED",
          reservationExpiresAt: new Date(Date.now() + this.config.reservationTtlSeconds * 1000),
        })
        .returning({ id: schema.coveV3MarketFills.id });

      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "RESERVED", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, input.listingId));
      return inserted!.id;
    });

    return fillId;
  }

  /**
   * Build the atomic fill PSBT.
   *
   * `fee` is a RATE by preference: only this method knows how many inputs the
   * buyer reserved and therefore how large the transaction will be. A flat sat
   * amount is still accepted for callers that size their own transaction.
   */
  async buildFillPsbt(
    fillId: string,
    fee: bigint | { feeRateSatPerVb?: bigint; minerFeeSats?: bigint },
  ): Promise<string> {
    const feeInput = typeof fee === "bigint" ? { minerFeeSats: fee } : fee;
    await assertMarketReady({ db: this.db, config: this.config, provider: this.provider });

    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (fill.status !== "RESERVED" && fill.status !== "PSBT_BUILT") throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);
    const listing = await this.loadListing(fill.listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");

    const source = await this.resolveSource(listingToV1(listing));
    const marketFee = this.marketFeeFor(listing.totalPriceSats);
    const funderInputs = fillFundInputs(fill).map((f) => ({
      txid: f.txid,
      vout: f.vout,
      script: asBuffer(f.script),
      valueSats: f.valueSats,
      publicKey: fill.buyerFundPublicKey ? asBuffer(fill.buyerFundPublicKey) : undefined,
    }));

    // Size the fee against the transaction that is actually about to exist:
    // the seller's carrier plus however many coins the buyer reserved, and
    // every output of the presigned layout.
    const rates = await loadFeeRates(this.provider);
    const standard = rates.tiers.find((t) => t.key === "standard") ?? rates.tiers[0]!;
    const vsize = estimateVsize({
      vaultInputs: 0,
      p2wpkhInputs: 1 + funderInputs.length,
      outputScriptBytes: [
        P2P_OP_RETURN_SCRIPT_BYTES,
        listing.sellerPayoutScript.length / 2,
        fill.buyerTokenScript.length / 2,
        this.config.feeScript.length,
        fill.buyerChangeScript.length / 2,
      ],
    });
    let minerFeeSats: bigint;
    try {
      minerFeeSats = resolveMinerFee({
        rateSatPerVb:
          feeInput.feeRateSatPerVb ??
          (feeInput.minerFeeSats === undefined ? standard.satPerVb : undefined),
        explicitSats: feeInput.minerFeeSats,
        vsize,
        floorSatPerVb: rates.floorSatPerVb,
        ceilingSatPerVb: rates.ceilingSatPerVb,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
      }).minerFeeSats;
    } catch (e) {
      if (e instanceof FeeError) throw new MarketError("BUYER_FUNDS_INSUFFICIENT", e.message);
      throw e;
    }

    const result = buildPresignedFillPsbt({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(listing.tokenId, "hex"),
      seller: {
        txid: listing.sourceTxid,
        vout: listing.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: listing.sellerTokenPublicKey ? asBuffer(listing.sellerTokenPublicKey) : undefined,
        amountAtoms: listing.sourceAmountAtoms,
      },
      payoutScript: asBuffer(listing.sellerPayoutScript),
      priceSats: listing.totalPriceSats,
      buyerTokenScript: asBuffer(fill.buyerTokenScript),
      fundInputs: funderInputs,
      buyerChangeScript: asBuffer(fill.buyerChangeScript),
      feeScript: this.config.feeScript,
      marketFeeSats: marketFee,
      minerFeeSats,
    });
    // The seller's carrier brings its own 1,000 sats for the buyer's new one.
    const extraCarrierSats = 0n;
    // Change below dust goes to the miner; record the fee actually paid, which
    // finalize and the buyer's browser both re-derive.
    const settledMinerFeeSats = result.minerFeeSats;

    const psbtB64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    await this.db
      .update(schema.coveV3MarketFills)
      .set({ psbtBase64: psbtB64, unsignedTxDigest: digest, minerFeeSats: settledMinerFeeSats, extraCarrierSats, marketFeeSats: marketFee, status: "PSBT_BUILT", updatedAt: new Date() })
      .where(eq(schema.coveV3MarketFills.id, fillId));
    return psbtB64;
  }

  /**
   * The buyer's signed fill. Their coins must be signed SIGHASH_ALL and the
   * seller's carrier must NOT be signed by them — the server attaches the
   * seller's stored presignature when it completes the sale.
   */
  async submitBuyerSignedPsbt(fillId: string, psbtB64: string): Promise<void> {
    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (fill.status !== "PSBT_BUILT") throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);

    const psbt = parsePsbt(psbtB64, btcNetwork(this.config.network));
    if (fill.unsignedTxDigest && unsignedTxDigest(psbt) !== fill.unsignedTxDigest) {
      throw new MarketError("PSBT_MUTATED", "unsigned tx digest mismatch");
    }

    if (partialSigOfInput(psbt, FILL_SELLER_INPUT) !== null) {
      throw new MarketError("PSBT_MUTATED", "the seller's carrier must not be signed by the buyer");
    }
    psbt.data.inputs.forEach((_, i) => {
      if (i !== FILL_SELLER_INPUT) validateP2wpkhPartialSig(psbt, i);
    });

    await this.db
      .update(schema.coveV3MarketFills)
      .set({ psbtBase64: psbtB64, status: "BUYER_SIGNED", updatedAt: new Date() })
      .where(eq(schema.coveV3MarketFills.id, fillId));
  }

  /**
   * Complete a buyer-signed fill: attach the seller's presignature, finalize,
   * validate every market rule and broadcast. No seller step.
   */
  async completeFill(fillId: string): Promise<{ txid: string }> {
    const validated = await this.finalizeP2PFill(fillId);
    return this.broadcastP2PFill(validated);
  }

  async finalizeP2PFill(fillId: string): Promise<ValidatedP2PFill> {
    await assertMarketReady({ db: this.db, config: this.config, provider: this.provider });
    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (fill.status !== "BUYER_SIGNED" && fill.status !== "BROADCAST") throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);
    if (!fill.psbtBase64) throw new MarketError("STATE_CHANGED", "fill has no PSBT");
    const listing = await this.loadListing(fill.listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    if (!listing.sellerPresignedPsbt) throw new MarketError("LISTING_CANCELLED", "the listing's signature is gone (cancelled)");
    // Re-check the canary cap at fill time (§P0-6), not just at listing creation.
    assertSettlementCap(listing.totalPriceSats, this.config.maxP2pSettlementSats);

    const network = btcNetwork(this.config.network);
    const psbt = parsePsbt(fill.psbtBase64, network);
    attachSellerPresig(psbt, presigOf(listing.sellerPresignedPsbt, network));
    psbt.finalizeAllInputs();
    const rawTxHex = psbt.extractTransaction().toHex();

    const terms = this.buildTerms(listing, fill);
    const view = await this.loadView(listing.tokenId, listing.sourceTxid, listing.sourceVout);
    const validated = validateFinalizedP2PFill({ rawTxHex, terms, view, network: this.config.network });

    await this.db
      .update(schema.coveV3MarketFills)
      .set({ txid: validated.txid, updatedAt: new Date() })
      .where(eq(schema.coveV3MarketFills.id, fillId));
    return validated;
  }

  async broadcastP2PFill(validated: ValidatedP2PFill): Promise<{ txid: string }> {
    const res = await broadcastValidatedP2PFill({ validated, network: this.config.network, provider: this.provider });
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "BROADCAST", txid: res.txid, updatedAt: new Date() })
        .where(eq(schema.coveV3MarketFills.id, validated.fillId));
      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "BROADCAST", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, validated.listingId));
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId: validated.listingId,
        fillId: validated.fillId,
        eventType: "FILL_BROADCAST",
        payloadJson: { txid: res.txid },
      });
    });
    return res;
  }

  /**
   * Idempotent reconciliation: expiry, external/mempool source-spend
   * invalidation, indexer-confirmed fill promotion, and reorg handling.
   */
  async reconcileMarket(): Promise<{ expired: number; invalidated: number; confirmed: number; reorged: number }> {
    const tip = BigInt(await this.provider.getBestHeight());
    const now = new Date();
    let expired = 0;
    let invalidated = 0;
    let confirmed = 0;
    let reorged = 0;

    // (P) PENDING listings (a fresh split): live once the indexer holds the
    // carrier exactly as listed; dropped if it is spent, rejected, or never
    // confirms within PENDING_LISTING_MAX_BLOCKS.
    const pendingListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(and(eq(schema.coveV3MarketListings.network, this.config.network), eq(schema.coveV3MarketListings.status, "PENDING")));
    for (const listing of pendingListings) {
      const utxo = await this.sourceUtxoRow(listing.sourceTxid, listing.sourceVout);
      if (utxo && utxo.canonical && !utxo.spentByTxid) {
        const matches =
          utxo.tokenId === listing.tokenId &&
          utxo.amountAtoms === listing.sourceAmountAtoms &&
          utxo.scriptPubKey === listing.sellerTokenScript;
        if (matches) {
          await this.db.update(schema.coveV3MarketListings).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
          await this.db.insert(schema.coveV3MarketEvents).values({ network: this.config.network, listingId: listing.listingId, eventType: "LISTING_ACTIVE", payloadJson: {} });
        } else {
          await this.invalidateListing(listing.listingId, "indexed carrier differs from the listing");
          invalidated++;
        }
        continue;
      }
      const gone = utxo?.spentByTxid ? true : !(await this.provider.getTxout(listing.sourceTxid, listing.sourceVout));
      if (gone || tip > listing.creationHeight + PENDING_LISTING_MAX_BLOCKS) {
        await this.invalidateListing(listing.listingId, gone ? "carrier spent before it confirmed" : "carrier never confirmed");
        invalidated++;
      }
    }

    // (A) Promote BROADCAST fills that the indexer has confirmed.
    const broadcastFills = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(and(eq(schema.coveV3MarketFills.network, this.config.network), eq(schema.coveV3MarketFills.status, "BROADCAST")));
    for (const fill of broadcastFills) {
      const listing = await this.loadListing(fill.listingId);
      if (!listing) continue;
      const utxo = await this.sourceUtxoRow(listing.sourceTxid, listing.sourceVout);
      if (utxo && utxo.spentByTxid === fill.txid && utxo.canonical) {
        await this.db.transaction(async (tx) => {
          await tx.update(schema.coveV3MarketFills).set({ status: "CONFIRMED", blockHeight: utxo.spentHeight ?? tip, blockHash: utxo.spentBlockHash, updatedAt: new Date() }).where(eq(schema.coveV3MarketFills.id, fill.id));
          await tx.update(schema.coveV3MarketListings).set({ status: "FILLED", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
          await this.ensureTrade(tx, fill, listing, utxo.spentHeight ?? tip, utxo.spentBlockHash);
          await tx.insert(schema.coveV3MarketEvents).values({ network: this.config.network, listingId: listing.listingId, fillId: fill.id, eventType: "FILL_CONFIRMED", payloadJson: { txid: fill.txid } });
        });
        confirmed++;
      }
    }

    // (B) Reorg: CONFIRMED fills whose source is no longer spent by their tx.
    const confirmedFills = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(and(eq(schema.coveV3MarketFills.network, this.config.network), eq(schema.coveV3MarketFills.status, "CONFIRMED")));
    for (const fill of confirmedFills) {
      const listing = await this.loadListing(fill.listingId);
      if (!listing) continue;
      const utxo = await this.sourceUtxoRow(listing.sourceTxid, listing.sourceVout);
      if (utxo && utxo.spentByTxid === fill.txid && utxo.canonical) continue; // still confirmed
      await this.db.transaction(async (tx) => {
        await tx.update(schema.coveV3MarketTrades).set({ canonical: false }).where(and(eq(schema.coveV3MarketTrades.network, this.config.network), eq(schema.coveV3MarketTrades.txid, fill.txid!)));
        await tx.update(schema.coveV3MarketFills).set({ status: "REORGED", canonical: false, updatedAt: new Date() }).where(eq(schema.coveV3MarketFills.id, fill.id));
        await tx.update(schema.coveV3MarketListings).set({ status: "REORGED", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
        await tx.insert(schema.coveV3MarketEvents).values({ network: this.config.network, listingId: listing.listingId, fillId: fill.id, eventType: "FILL_REORGED", payloadJson: { txid: fill.txid } });
      });
      reorged++;
    }

    // (C) Reconcile open listings (ACTIVE/RESERVED/BROADCAST) and reorged
    // listings (REORGED): detect external spends and restore post-reorg state.
    const openListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(
        and(
          eq(schema.coveV3MarketListings.network, this.config.network),
          inArray(schema.coveV3MarketListings.status, ["ACTIVE", "RESERVED", "BROADCAST", "REORGED"]),
        ),
      );
    for (const listing of openListings) {
      const utxo = await this.sourceUtxoRow(listing.sourceTxid, listing.sourceVout);
      if (utxo && utxo.spentByTxid) {
        // Indexer says the source is confirmed-spent by some tx.
        const ourTx = await this.listingFillTxid(listing.listingId, utxo.spentByTxid);
        if (!ourTx) {
          await this.invalidateListing(listing.listingId, `spent by ${utxo.spentByTxid}`);
          invalidated++;
        }
        continue;
      }
      // No confirmed spend in the indexer view.
      const txout = await this.provider.getTxout(listing.sourceTxid, listing.sourceVout);
      if (txout) {
        // Source is unspent. A reorged listing whose fill tx is gone → ACTIVE.
        if (listing.status === "REORGED") {
          await this.db.update(schema.coveV3MarketListings).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
        }
        continue;
      }
      // Source is spent in the mempool (unconfirmed). Determine the spender.
      const ourTxid = await this.latestFillTxid(listing.listingId);
      const isOurs = ourTxid !== null && (await this.inMempool(ourTxid));
      if (isOurs) {
        if (listing.status === "REORGED") {
          // Our fill is back in the mempool after a reorg: re-pend it.
          await this.db.transaction(async (tx) => {
            await tx
              .update(schema.coveV3MarketFills)
              .set({ status: "BROADCAST", canonical: true, updatedAt: new Date() })
              .where(and(eq(schema.coveV3MarketFills.listingId, listing.listingId), eq(schema.coveV3MarketFills.txid, ourTxid)));
            await tx.update(schema.coveV3MarketListings).set({ status: "BROADCAST", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
            await tx.insert(schema.coveV3MarketEvents).values({ network: this.config.network, listingId: listing.listingId, eventType: "FILL_REPENDING", payloadJson: { txid: ourTxid } });
          });
        }
        continue;
      }
      await this.invalidateListing(listing.listingId, "source spent in mempool by an external tx");
      invalidated++;
    }

    // (D) Expire listings + reservations.
    const expListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(and(eq(schema.coveV3MarketListings.network, this.config.network), eq(schema.coveV3MarketListings.status, "ACTIVE"), lte(schema.coveV3MarketListings.expiryHeight, tip)));
    for (const listing of expListings) {
      await this.db.update(schema.coveV3MarketListings).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
      expired++;
    }
    const expFills = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(
        and(
          eq(schema.coveV3MarketFills.network, this.config.network),
          // §M4: reclaim stuck fills at ANY non-terminal stage — a BUYER_SIGNED
          // fill that never finalizes must not lock the listing forever.
          inArray(schema.coveV3MarketFills.status, ["RESERVED", "PSBT_BUILT", "BUYER_SIGNED"]),
          lte(schema.coveV3MarketFills.reservationExpiresAt, now),
        ),
      );
    for (const fill of expFills) {
      await this.db.transaction(async (tx) => {
        await tx.update(schema.coveV3MarketFills).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(schema.coveV3MarketFills.id, fill.id));
        // Release the listing back to ACTIVE if it is still RESERVED for this fill.
        await tx
          .update(schema.coveV3MarketListings)
          .set({ status: "ACTIVE", updatedAt: new Date() })
          .where(and(eq(schema.coveV3MarketListings.listingId, fill.listingId), eq(schema.coveV3MarketListings.status, "RESERVED")));
      });
      expired++;
    }

    return { expired, invalidated, confirmed, reorged };
  }

  // ── reconcile helpers ─────────────────────────────────────────────────────

  private async sourceUtxoRow(txid: string, vout: number) {
    const rows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(and(eq(schema.coveV3TokenUtxos.network, this.config.network), eq(schema.coveV3TokenUtxos.txid, txid), eq(schema.coveV3TokenUtxos.vout, vout)));
    return rows[0] ?? null;
  }

  private async listingFillTxid(listingId: string, spentByTxid: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(and(eq(schema.coveV3MarketFills.listingId, listingId), eq(schema.coveV3MarketFills.txid, spentByTxid)));
    return rows.length > 0;
  }

  private async latestFillTxid(listingId: string): Promise<string | null> {
    const rows = await this.db
      .select({ txid: schema.coveV3MarketFills.txid })
      .from(schema.coveV3MarketFills)
      .where(eq(schema.coveV3MarketFills.listingId, listingId))
      .orderBy(desc(schema.coveV3MarketFills.createdAt))
      .limit(1);
    return rows[0]?.txid ?? null;
  }

  private async inMempool(txid: string): Promise<boolean> {
    try {
      await this.provider.getRawTransaction(txid);
      return true;
    } catch {
      return false;
    }
  }

  private async invalidateListing(listingId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(schema.coveV3MarketListings).set({ status: "INVALIDATED", sellerPresignedPsbt: null, updatedAt: new Date() }).where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "FAILED", failureReason: reason, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            inArray(schema.coveV3MarketFills.status, ["RESERVED", "PSBT_BUILT", "BUYER_SIGNED", "BROADCAST"]),
          ),
        );
      await tx.insert(schema.coveV3MarketEvents).values({ network: this.config.network, listingId, eventType: "LISTING_INVALIDATED", payloadJson: { reason } });
    });
  }

  private async ensureTrade(tx: DbTransaction, fill: FillSelect, listing: ListingSelect, blockHeight: bigint, blockHash: string | null): Promise<void> {
    const existing = await tx
      .select()
      .from(schema.coveV3MarketTrades)
      .where(and(eq(schema.coveV3MarketTrades.network, this.config.network), eq(schema.coveV3MarketTrades.txid, fill.txid!)));
    if (existing.length > 0) {
      // Re-confirmation after a reorg: restore canonicity + new height.
      await tx
        .update(schema.coveV3MarketTrades)
        .set({ canonical: true, blockHeight, blockHash, createdAt: new Date() })
        .where(and(eq(schema.coveV3MarketTrades.network, this.config.network), eq(schema.coveV3MarketTrades.txid, fill.txid!)));
      return;
    }
    await tx.insert(schema.coveV3MarketTrades).values({
      network: this.config.network,
      tokenId: listing.tokenId,
      listingId: listing.listingId,
      fillId: fill.id,
      sellerTokenScript: listing.sellerTokenScript,
      buyerTokenScript: fill.buyerTokenScript,
      amountAtoms: fill.amountAtoms,
      totalPriceSats: fill.totalPriceSats,
      marketFeeSats: fill.marketFeeSats,
      minerFeeSats: fill.minerFeeSats,
      txid: fill.txid!,
      blockHeight,
      blockHash,
      canonical: true,
    });
  }

  // ── build terms / view helpers ────────────────────────────────────────────

  private buildTerms(listing: ListingSelect, fill: FillSelect): P2PFillTerms {
    return {
      listingId: listing.listingId,
      fillId: fill.id,
      tokenId: listing.tokenId,
      sourceTxid: listing.sourceTxid,
      sourceVout: listing.sourceVout,
      sourceAmountAtoms: listing.sourceAmountAtoms,
      sellerTokenScript: asBuffer(listing.sellerTokenScript),
      sellerTokenChangeScript: asBuffer(listing.sellerTokenChangeScript),
      sellerPayoutScript: asBuffer(listing.sellerPayoutScript),
      amountAtoms: listing.amountAtoms,
      totalPriceSats: listing.totalPriceSats,
      marketFeeSats: fill.marketFeeSats,
      minerFeeSats: fill.minerFeeSats,
      buyerTokenScript: asBuffer(fill.buyerTokenScript),
      buyerChangeScript: asBuffer(fill.buyerChangeScript),
      feeScript: this.config.feeScript,
      buyerFundInputs: fillFundInputs(fill).map((f) => ({ txid: f.txid, vout: f.vout, script: asBuffer(f.script), valueSats: f.valueSats })),
    };
  }

  private async loadView(tokenId: string, sourceTxid: string, sourceVout: number): Promise<CoveCanonicalView> {
    return loadCanonicalViewSnapshotFromDb({
      db: this.db,
      network: this.config.network,
      tokenId,
      relevantOutpoints: [{ txid: sourceTxid, vout: sourceVout }],
    });
  }
}
