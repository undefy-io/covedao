import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** BigInt monetary/supply/height columns (no float). */
const atoms = (name: string) => bigint(name, { mode: "bigint" });

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentTxid: text("deployment_txid").notNull(),
    ticker: text("ticker").notNull(),
    tickerNormalized: text("ticker_normalized").notNull(),
    name: text("name").notNull(),
    creatorAddress: text("creator_address").notNull(),
    network: text("network").notNull(),
    status: text("status").notNull().default("DRAFT"),
    totalSupplyAtoms: atoms("total_supply_atoms").notNull(),
    publicSupplyAtoms: atoms("public_supply_atoms").notNull(),
    reserveSupplyAtoms: atoms("reserve_supply_atoms").notNull(),
    confirmedMintedAtoms: atoms("confirmed_minted_atoms")
      .notNull()
      .$defaultFn(() => 0n),
    pendingMintedAtoms: atoms("pending_minted_atoms")
      .notNull()
      .$defaultFn(() => 0n),
    reserveSats: atoms("reserve_sats")
      .notNull()
      .$defaultFn(() => 0n),
    lastTradePricePerMillion: atoms("last_trade_price_per_million"),
    currentStage: integer("current_stage").notNull().default(1),
    deployHeight: atoms("deploy_height"),
    deployBlockHash: text("deploy_block_hash"),
    protocolStateHash: text("protocol_state_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tokens_deployment_network_uq").on(t.network, t.deploymentTxid),
    index("tokens_ticker_idx").on(t.network, t.tickerNormalized),
    index("tokens_status_created_idx").on(t.status, t.createdAt),
    index("tokens_status_minted_idx").on(t.status, t.confirmedMintedAtoms),
  ],
);

export const tokenMetadata = pgTable(
  "token_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Immutable deployment txid — survives projection rebuilds (tokens get new UUIDs). */
    deploymentTxid: text("deployment_txid").notNull(),
    description: text("description").notNull().default(""),
    websiteUrl: text("website_url"),
    xUrl: text("x_url"),
    imageHash: text("image_hash"),
    imageUrl: text("image_url"),
    thumbUrl: text("thumb_url"),
    termsVersion: text("terms_version"),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    termsWalletAddress: text("terms_wallet_address"),
    isVerified: boolean("is_verified").notNull().default(false),
    isHidden: boolean("is_hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("token_metadata_deployment_uq").on(t.deploymentTxid)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }),
    txid: text("txid"),
    creatorAddress: text("creator_address").notNull(),
    network: text("network").notNull(),
    status: text("status").notNull().default("CREATED"),
    launchFeeSats: atoms("launch_fee_sats").notNull(),
    minerFeeSats: atoms("miner_fee_sats").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("deployments_txid_uq").on(t.network, t.txid)],
);

export const chainTransactions = pgTable(
  "chain_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    txid: text("txid"),
    operation: text("operation").notNull(),
    walletAddress: text("wallet_address").notNull(),
    status: text("status").notNull().default("CREATED"),
    idempotencyKey: text("idempotency_key"),
    deploymentId: text("deployment_id"),
    errorCode: text("error_code"),
    payloadJson: jsonb("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chain_tx_network_txid_uq").on(t.network, t.txid),
    uniqueIndex("chain_tx_idempotency_uq").on(t.walletAddress, t.operation, t.idempotencyKey),
    index("chain_tx_wallet_idx").on(t.walletAddress, t.createdAt),
  ],
);

export const chainEvents = pgTable(
  "chain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    blockHeight: atoms("block_height").notNull(),
    blockHash: text("block_hash").notNull(),
    txid: text("txid").notNull(),
    eventIndex: integer("event_index").notNull(),
    eventType: text("event_type").notNull(),
    deploymentId: text("deployment_id"),
    walletFrom: text("wallet_from"),
    walletTo: text("wallet_to"),
    tokenAmountAtoms: atoms("token_amount_atoms"),
    btcAmountSats: atoms("btc_amount_sats"),
    payloadJson: jsonb("payload_json"),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chain_events_network_txid_idx_uq").on(t.network, t.txid, t.eventIndex),
    index("chain_events_block_idx").on(t.network, t.blockHeight),
    index("chain_events_deployment_idx").on(t.deploymentId, t.blockHeight),
    index("chain_events_wallet_idx").on(t.walletFrom, t.blockHeight),
  ],
);

export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("blocks_network_height_uq").on(t.network, t.height)],
);

export const indexerCursors = pgTable("indexer_cursors", {
  id: text("id").primaryKey(),
  network: text("network").notNull(),
  lastHeight: atoms("last_height")
    .notNull()
    .$defaultFn(() => 0n),
  lastBlockHash: text("last_block_hash"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reorgEvents = pgTable("reorg_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  network: text("network").notNull(),
  fromHeight: atoms("from_height").notNull(),
  toHeight: atoms("to_height").notNull(),
  orphanedBlockHash: text("orphaned_block_hash"),
  details: jsonb("details"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const walletTokenBalances = pgTable(
  "wallet_token_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    walletAddress: text("wallet_address").notNull(),
    deploymentId: text("deployment_id").notNull(),
    balanceAtoms: atoms("balance_atoms")
      .notNull()
      .$defaultFn(() => 0n),
    pendingAtoms: atoms("pending_atoms")
      .notNull()
      .$defaultFn(() => 0n),
    lockedAtoms: atoms("locked_atoms")
      .notNull()
      .$defaultFn(() => 0n),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("balances_wallet_deployment_uq").on(t.network, t.walletAddress, t.deploymentId),
    index("balances_wallet_idx").on(t.walletAddress),
  ],
);

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: text("listing_id").notNull(),
    network: text("network").notNull(),
    deploymentId: text("deployment_id").notNull(),
    sellerAddress: text("seller_address").notNull(),
    tokenAmountAtoms: atoms("token_amount_atoms").notNull(),
    askingPriceSats: atoms("asking_price_sats").notNull(),
    creationHeight: atoms("creation_height").notNull(),
    expiryHeight: atoms("expiry_height").notNull(),
    status: text("status").notNull().default("BUILDING"),
    txid: text("txid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listings_listing_id_uq").on(t.listingId),
    index("listings_deployment_status_idx").on(t.deploymentId, t.status),
    index("listings_status_created_idx").on(t.status, t.createdAt),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    deploymentId: text("deployment_id").notNull(),
    listingId: text("listing_id").notNull(),
    buyerAddress: text("buyer_address").notNull(),
    sellerAddress: text("seller_address").notNull(),
    tokenAmountAtoms: atoms("token_amount_atoms").notNull(),
    priceSats: atoms("price_sats").notNull(),
    pricePerMillionSats: atoms("price_per_million_sats").notNull(),
    protocolFeeSats: atoms("protocol_fee_sats")
      .notNull()
      .$defaultFn(() => 0n),
    platformFeeSats: atoms("platform_fee_sats")
      .notNull()
      .$defaultFn(() => 0n),
    txid: text("txid").notNull(),
    blockHeight: atoms("block_height").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trades_txid_uq").on(t.network, t.txid),
    index("trades_deployment_idx").on(t.deploymentId, t.createdAt),
    index("trades_block_idx").on(t.blockHeight),
  ],
);

export const mints = pgTable(
  "mints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    deploymentId: text("deployment_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    tokenAmountAtoms: atoms("token_amount_atoms").notNull(),
    curveContributionSats: atoms("curve_contribution_sats").notNull(),
    platformFeeSats: atoms("platform_fee_sats").notNull(),
    minerFeeSats: atoms("miner_fee_sats").notNull(),
    txid: text("txid"),
    status: text("status").notNull().default("CREATED"),
    blockHeight: atoms("block_height"),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mints_txid_uq").on(t.network, t.txid),
    index("mints_deployment_idx").on(t.deploymentId, t.createdAt),
  ],
);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    deploymentId: text("deployment_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    mode: text("mode").notNull(),
    tokensAtoms: atoms("tokens_atoms").notNull(),
    curveContributionSats: atoms("curve_contribution_sats").notNull(),
    platformFeeSats: atoms("platform_fee_sats").notNull(),
    estimatedMinerFeeSats: atoms("estimated_miner_fee_sats").notNull(),
    totalEstimatedSpendSats: atoms("total_estimated_spend_sats").notNull(),
    startingStage: integer("starting_stage").notNull(),
    endingStage: integer("ending_stage").notNull(),
    supplyBeforeAtoms: atoms("supply_before_atoms").notNull(),
    supplyAfterAtoms: atoms("supply_after_atoms").notNull(),
    stateHash: text("state_hash").notNull(),
    expiresAtHeight: atoms("expires_at_height").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quotes_deployment_idx").on(t.deploymentId, t.createdAt)],
);

export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull(),
    termsVersion: text("terms_version").notNull(),
    network: text("network").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("terms_wallet_version_uq").on(t.walletAddress, t.termsVersion)],
);

export const featureFlags = pgTable("feature_flags", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    variant: text("variant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("media_hash_variant_uq").on(t.contentHash, t.variant)],
);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterAddress: text("reporter_address"),
  targetType: text("target_type").notNull(),
  deploymentId: text("deployment_id"),
  reason: text("reason").notNull(),
  details: text("details"),
  status: text("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminId: text("admin_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const feeLedger = pgTable(
  "fee_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    eventIndex: integer("event_index").notNull(),
    operation: text("operation").notNull(),
    expectedSats: atoms("expected_sats").notNull(),
    observedSats: atoms("observed_sats").notNull(),
    confirmationStatus: text("confirmation_status").notNull().default("PENDING"),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("fee_ledger_txid_idx_uq").on(t.network, t.txid, t.eventIndex)],
);

export const protocolSnapshots = pgTable("protocol_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  network: text("network").notNull(),
  stateHash: text("state_hash").notNull(),
  height: atoms("height").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Cove V1 (Bitcoin signet) persistent indexer state ───────────────────────

export const coveBlocks = pgTable(
  "cove_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_blocks_height_uq").on(t.network, t.height),
    index("cove_blocks_hash_idx").on(t.network, t.hash),
  ],
);

export const coveOperations = pgTable(
  "cove_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    blockHeight: atoms("block_height").notNull(),
    txIndex: integer("tx_index").notNull(),
    operation: text("operation"),
    classification: text("classification").notNull(),
    valid: boolean("valid").notNull(),
    reason: text("reason"),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_ops_txid_uq").on(t.network, t.txid),
    index("cove_ops_block_height_idx").on(t.network, t.blockHeight),
  ],
);

export const coveTokens = pgTable(
  "cove_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    deploymentId: text("deployment_id").notNull(),
    ticker: text("ticker").notNull(),
    creator: text("creator").notNull(),
    confirmedSupplyAtoms: atoms("confirmed_supply_atoms").notNull(),
    currentStage: integer("current_stage").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_tokens_deployment_uq").on(t.network, t.deploymentId)],
);

export const coveBalances = pgTable(
  "cove_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    ownerScript: text("owner_script").notNull(),
    deploymentId: text("deployment_id").notNull(),
    availableAtoms: atoms("available_atoms").notNull(),
    lockedAtoms: atoms("locked_atoms").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_balances_owner_uq").on(t.network, t.ownerScript, t.deploymentId)],
);

export const coveCheckpoints = pgTable(
  "cove_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    blockHash: text("block_hash").notNull(),
    stateRoot: text("state_root").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_checkpoints_height_uq").on(t.network, t.height)],
);

export const coveCursor = pgTable(
  "cove_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    blockHash: text("block_hash").notNull(),
    /** True while a reorg rebuild is in progress (clearCove → reindex). */
    rebuilding: boolean("rebuilding").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_cursor_network_uq").on(t.network)],
);

// ── Cove V3 (production) persistent indexer projection ─────────────────────
// Versioned tables; the legacy `cove_*` V1 tables above remain historical only.
// BigInt columns for sats/atoms/heights. Balances are DERIVED from token UTXOs
// and never stored as authority.

export const coveV3Blocks = pgTable(
  "cove_v3_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_blocks_height_uq").on(t.network, t.height),
    index("cove_v3_blocks_hash_idx").on(t.network, t.hash),
  ],
);

export const coveV3Runtime = pgTable("cove_v3_runtime", {
  network: text("network").primaryKey(),
  coreHeight: atoms("core_height")
    .notNull()
    .default(sql`0`),
  coreTip: text("core_tip").notNull().default(""),
  coreReachable: boolean("core_reachable").notNull().default(false),
  chainObservedAt: timestamp("chain_observed_at", { withTimezone: true }),
  feeRates: jsonb("fee_rates").$type<{
    floorSatPerVb: string;
    ceilingSatPerVb: string;
    estimated: boolean;
    tiers: {
      key: "eco" | "standard" | "priority";
      label: string;
      blocks: number;
      satPerVb: string;
    }[];
  }>(),
  pendingObservedAt: timestamp("pending_observed_at", { withTimezone: true }),
  feesObservedAt: timestamp("fees_observed_at", { withTimezone: true }),
});

export const coveV3Tokens = pgTable(
  "cove_v3_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    ticker: text("ticker").notNull(),
    policyVersion: integer("policy_version").notNull(),
    nonce: text("nonce").notNull(),
    deployTxid: text("deploy_txid").notNull(),
    deployHeight: atoms("deploy_height").notNull(),
    deployBlockHash: text("deploy_block_hash").notNull(),
    /** Where the creator's share of every mint is paid (DEPLOY output 2). */
    creatorScript: text("creator_script").notNull().default(""),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_v3_tokens_id_uq").on(t.network, t.tokenId)],
);

export const coveV3BackingStates = pgTable(
  "cove_v3_backing_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    stateHash: text("state_hash").notNull(),
    stateVersion: integer("state_version").notNull(),
    policyVersion: integer("policy_version").notNull(),
    issuedSupplyAtoms: atoms("issued_supply_atoms").notNull(),
    backingSats: atoms("backing_sats").notNull(),
    curveStage: integer("curve_stage").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    scriptPubKey: text("script_pub_key").notNull(),
    btcValue: atoms("btc_value").notNull(),
    blockHeight: atoms("block_height").notNull(),
    blockHash: text("block_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_backing_token_uq").on(t.network, t.tokenId),
    index("cove_v3_backing_outpoint_idx").on(t.network, t.txid, t.vout),
  ],
);

export const coveV3TokenUtxos = pgTable(
  "cove_v3_token_utxos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    tokenId: text("token_id").notNull(),
    amountAtoms: atoms("amount_atoms").notNull(),
    scriptPubKey: text("script_pub_key").notNull(),
    createdHeight: atoms("created_height").notNull(),
    createdBlockHash: text("created_block_hash").notNull(),
    spentByTxid: text("spent_by_txid"),
    spentHeight: atoms("spent_height"),
    spentBlockHash: text("spent_block_hash"),
    /** Spent outside the protocol: the tokens it held no longer exist. */
    burned: boolean("burned").notNull().default(false),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_utxo_outpoint_uq").on(t.network, t.txid, t.vout),
    index("cove_v3_utxo_token_idx").on(t.network, t.tokenId),
    index("cove_v3_utxo_script_idx").on(t.network, t.scriptPubKey),
    index("cove_v3_utxo_live_script_idx")
      .on(t.network, t.scriptPubKey, t.txid, t.vout)
      .where(sql`${t.canonical} and ${t.spentByTxid} is null`),
  ],
);

export const coveV3Events = pgTable(
  "cove_v3_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    blockHeight: atoms("block_height").notNull(),
    blockHash: text("block_hash").notNull(),
    txIndex: integer("tx_index").notNull(),
    operation: text("operation"),
    valid: boolean("valid").notNull(),
    reason: text("reason"),
    tokenId: text("token_id"),
    canonical: boolean("canonical").notNull().default(true),
    // Curve-trade detail, present only on a valid MINT or REDEEM. A buy or a
    // sell against the vault IS a trade at a real price; without these the
    // chart could only ever plot peer-to-peer fills, so a token that had only
    // minted showed nothing at all.
    amountAtoms: atoms("amount_atoms"),
    grossSats: atoms("gross_sats"),
    feeSats: atoms("fee_sats"),
    supplyAfterAtoms: atoms("supply_after_atoms"),
    backingAfterSats: atoms("backing_after_sats"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_events_txid_uq").on(t.network, t.txid),
    index("cove_v3_events_block_idx").on(t.network, t.blockHeight),
    index("cove_v3_events_token_idx").on(t.network, t.tokenId),
    index("cove_v3_events_price_time_idx")
      .on(t.network, t.tokenId, t.createdAt.desc(), t.blockHeight.desc(), t.txid.desc())
      .where(
        sql`${t.canonical} and ${t.valid} and ${t.operation} in ('MINT','REDEEM') and ${t.grossSats} is not null`,
      ),
    index("cove_v3_events_positive_price_time_idx")
      .on(t.network, t.tokenId, t.createdAt.desc(), t.blockHeight.desc(), t.txid.desc())
      .where(
        sql`${t.canonical} and ${t.valid} and ${t.operation} in ('MINT','REDEEM') and ${t.amountAtoms} > 0 and ${t.grossSats}::numeric * 10000000000000 >= ${t.amountAtoms}`,
      ),
  ],
);

export const coveV3Cursor = pgTable(
  "cove_v3_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    blockHash: text("block_hash").notNull(),
    stateRoot: text("state_root").notNull(),
    rebuilding: boolean("rebuilding").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_v3_cursor_network_uq").on(t.network)],
);

export const coveV3Undo = pgTable(
  "cove_v3_undo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    height: atoms("height").notNull(),
    blockHash: text("block_hash").notNull(),
    /** JSON-encoded inverse ops sufficient to reverse this block exactly. */
    undoJson: text("undo_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_v3_undo_height_uq").on(t.network, t.height)],
);

// ── Cove V3 P2P marketplace (OFF-CHAIN application state) ──────────────────
// These tables are NOT part of the Cove/IndexerState/v3 state root. They are
// application-layer order/coordination state that MUST survive an indexer
// reindex (the indexer truncates + rebuilds only the cove_v3_* canonical tables
// above, never these). Inventory is ALWAYS resolved from cove_v3_token_utxos +
// Core; these rows never become token authority.

/** A canonical signed fixed-price listing (V1: exactly one source token UTXO). */
export const coveV3MarketListings = pgTable(
  "cove_v3_market_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: text("listing_id").notNull(),
    network: text("network").notNull(),
    chainIdentity: text("chain_identity").notNull(),
    tokenId: text("token_id").notNull(),
    orderVersion: integer("order_version").notNull(),
    sellerTokenScript: text("seller_token_script").notNull(),
    sellerPayoutScript: text("seller_payout_script").notNull(),
    sellerTokenChangeScript: text("seller_token_change_script").notNull(),
    sourceTxid: text("source_txid").notNull(),
    sourceVout: integer("source_vout").notNull(),
    sourceAmountAtoms: atoms("source_amount_atoms").notNull(),
    amountAtoms: atoms("amount_atoms").notNull(),
    totalPriceSats: atoms("total_price_sats").notNull(),
    creationHeight: atoms("creation_height").notNull(),
    expiryHeight: atoms("expiry_height").notNull(),
    nonce: text("nonce").notNull(),
    signatureB64: text("signature_b64").notNull(),
    /**
     * The public key behind sellerTokenScript. Not part of the signed order —
     * a Taproot or nested-segwit carrier cannot be put in a signable PSBT
     * without it, and the scriptPubKey alone does not reveal it.
     */
    sellerTokenPublicKey: text("seller_token_public_key"),
    /**
     * The seller's presigned listing PSBT: one input (the whole carrier) signed
     * SIGHASH_SINGLE|ANYONECANPAY over one output (their payout). A buyer's
     * fill is completed with it, so the seller never signs at sale time.
     * SECRET until broadcast: whoever holds it can settle the sale without the
     * market fee, so no read model or API ever returns this column.
     */
    sellerPresignedPsbt: text("seller_presigned_psbt"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull()
      .default(new Date(0)),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cove_v3_listing_observation_idx").on(t.network, t.status, t.lastObservedAt),
    uniqueIndex("cove_v3_market_listings_id_uq").on(t.listingId),
    index("cove_v3_market_listings_token_status_idx").on(t.network, t.tokenId, t.status),
    index("cove_v3_market_listings_route_idx")
      .on(t.network, t.tokenId, t.amountAtoms, t.totalPriceSats, t.listingId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index("cove_v3_market_listings_seller_token_idx").on(
      t.network,
      t.sellerTokenScript,
      t.createdAt.desc(),
      t.listingId.desc(),
    ),
    index("cove_v3_market_listings_seller_payout_idx").on(
      t.network,
      t.sellerPayoutScript,
      t.createdAt.desc(),
      t.listingId.desc(),
    ),
    index("cove_v3_market_listings_status_created_idx").on(t.network, t.status, t.createdAt),
    // One PENDING/ACTIVE/RESERVED/BROADCAST listing per source outpoint (double-list guard).
    // Literal IN-list: CREATE INDEX is DDL and cannot use bind parameters, so the
    // status constants are inlined here (they are fixed protocol values).
    uniqueIndex("cove_v3_market_listings_source_active_uq")
      .on(t.network, t.sourceTxid, t.sourceVout)
      .where(sql`${t.status} in ('PENDING', 'ACTIVE', 'RESERVED', 'BROADCAST')`),
  ],
);

/** Source token input rows for a listing (V1: exactly one). */
export const coveV3MarketListingInputs = pgTable(
  "cove_v3_market_listing_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: text("listing_id").notNull(),
    sourceTxid: text("source_txid").notNull(),
    sourceVout: integer("source_vout").notNull(),
    amountAtoms: atoms("amount_atoms").notNull(),
    scriptPubKey: text("script_pub_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cove_v3_market_listing_inputs_listing_idx").on(t.listingId),
    uniqueIndex("cove_v3_market_listing_inputs_outpoint_uq").on(
      t.listingId,
      t.sourceTxid,
      t.sourceVout,
    ),
  ],
);

/** A buyer reservation + atomic P2P fill lifecycle. */
export const coveV3MarketFills = pgTable(
  "cove_v3_market_fills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: text("listing_id").notNull(),
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    buyerTokenScript: text("buyer_token_script").notNull(),
    buyerChangeScript: text("buyer_change_script").notNull(),
    /** Buyer BTC inputs (jsonb): [{txid, vout, script, valueSats}] captured at reserve. */
    buyerFundInputs: jsonb("buyer_fund_inputs").notNull(),
    /** Public key behind the buyer's funding script (needed for nested segwit / Taproot). */
    buyerFundPublicKey: text("buyer_fund_public_key"),
    amountAtoms: atoms("amount_atoms").notNull(),
    totalPriceSats: atoms("total_price_sats").notNull(),
    marketFeeSats: atoms("market_fee_sats").notNull(),
    extraCarrierSats: atoms("extra_carrier_sats").notNull(),
    minerFeeSats: atoms("miner_fee_sats").notNull(),
    /** sha256 of the unsigned tx bytes — must be identical across signing stages. */
    unsignedTxDigest: text("unsigned_tx_digest"),
    /** Base64 PSBT for crash/restart resume across signing stages. */
    psbtBase64: text("psbt_base64"),
    status: text("status").notNull().default("RESERVED"),
    txid: text("txid"),
    blockHeight: atoms("block_height"),
    blockHash: text("block_hash"),
    canonical: boolean("canonical").notNull().default(true),
    failureReason: text("failure_reason"),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cove_v3_market_fills_listing_idx").on(t.listingId),
    index("cove_v3_market_fills_status_idx").on(t.network, t.status),
    index("cove_v3_market_fills_buyer_token_idx").on(
      t.network,
      t.buyerTokenScript,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("cove_v3_market_fills_buyer_change_idx").on(
      t.network,
      t.buyerChangeScript,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqueIndex("cove_v3_market_fills_txid_uq")
      .on(t.network, t.txid)
      .where(sql`${t.txid} IS NOT NULL`),
  ],
);

/** Signed listing cancellations (BIP-322 over the cancel hash). */
export const coveV3MarketCancellations = pgTable(
  "cove_v3_market_cancellations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: text("listing_id").notNull(),
    cancelHash: text("cancel_hash").notNull(),
    cancelNonce: text("cancel_nonce").notNull(),
    signatureB64: text("signature_b64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_v3_market_cancellations_hash_uq").on(t.listingId, t.cancelHash)],
);

/** Indexer-CONFIRMED trades (never marked at broadcast). */
export const coveV3MarketTrades = pgTable(
  "cove_v3_market_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    listingId: text("listing_id").notNull(),
    fillId: text("fill_id").notNull(),
    sellerTokenScript: text("seller_token_script").notNull(),
    buyerTokenScript: text("buyer_token_script").notNull(),
    amountAtoms: atoms("amount_atoms").notNull(),
    totalPriceSats: atoms("total_price_sats").notNull(),
    marketFeeSats: atoms("market_fee_sats").notNull(),
    minerFeeSats: atoms("miner_fee_sats").notNull(),
    txid: text("txid").notNull(),
    blockHeight: atoms("block_height").notNull(),
    blockHash: text("block_hash"),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_market_trades_txid_uq").on(t.network, t.txid),
    index("cove_v3_market_trades_token_idx").on(t.network, t.tokenId, t.blockHeight),
    index("cove_v3_market_trades_price_time_idx")
      .on(t.network, t.tokenId, t.createdAt.desc(), t.blockHeight.desc(), t.txid.desc())
      .where(sql`${t.canonical}`),
    index("cove_v3_market_trades_positive_price_time_idx")
      .on(t.network, t.tokenId, t.createdAt.desc(), t.blockHeight.desc(), t.txid.desc())
      .where(
        sql`${t.canonical} and ${t.amountAtoms} > 0 and ${t.totalPriceSats}::numeric * 10000000000000 >= ${t.amountAtoms}`,
      ),
  ],
);

/** Immutable market audit/event log (reconciliation trail). */
export const coveV3MarketEvents = pgTable(
  "cove_v3_market_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    listingId: text("listing_id"),
    fillId: text("fill_id"),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cove_v3_market_events_listing_idx").on(t.listingId, t.createdAt)],
);

// ── Cove V3 application metadata (off-chain, keyed by tokenId) ─────────────
// Application-layer display metadata. NOT chain truth, NOT in the indexer state
// root, and it survives a V3 reindex. The on-chain ticker comes from the V3
// DEPLOY; this table can never change tokenId/ticker/supply/backing/version.

export const coveV3TokenMetadata = pgTable(
  "cove_v3_token_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    websiteUrl: text("website_url"),
    xUrl: text("x_url"),
    imageUrl: text("image_url"),
    submittedByScript: text("submitted_by_script").notNull(),
    deployTxid: text("deploy_txid"),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cove_v3_token_metadata_deploy_uq").on(t.network, t.tokenId, t.deployTxid)],
);

// ── Cove V3 application transaction sessions (coordination state only) ─────
// Off-chain PSBT/session bookkeeping for the interactive flows. NEVER chain
// ownership authority; never stores wallet keys/seeds/WIF/Guardian keys.

export const coveV3AppTransactions = pgTable(
  "cove_v3_app_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    operation: text("operation").notNull(), // DEPLOY | BACKING_BUY | REDEEM | TRANSFER | P2P
    tokenId: text("token_id"),
    walletScript: text("wallet_script").notNull(),
    walletAddress: text("wallet_address"),
    stateHash: text("state_hash"),
    backingTxid: text("backing_txid"),
    backingVout: integer("backing_vout"),
    unsignedTxDigest: text("unsigned_tx_digest"),
    psbtBase64: text("psbt_base64"),
    metadataJson: jsonb("metadata_json").$type<{
      displayName: string;
      description: string;
      websiteUrl?: string | null;
      xUrl?: string | null;
      imageUrl?: string | null;
    }>(),
    txid: text("txid"),
    status: text("status").notNull().default("BUILT"), // BUILT | WALLET_SIGNED | BROADCAST | CONFIRMED | REORGED | FAILED | EXPIRED
    expiresAtHeight: atoms("expires_at_height"),
    errorCode: text("error_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_app_tx_idempotency_uq").on(
      t.network,
      t.walletScript,
      t.operation,
      t.idempotencyKey,
    ),
    index("cove_v3_app_tx_txid_idx")
      .on(t.network, t.txid)
      .where(sql`${t.txid} IS NOT NULL`),
    index("cove_v3_app_tx_status_idx").on(t.network, t.status),
    index("cove_v3_app_tx_wallet_idx").on(t.network, t.walletScript, t.createdAt),
  ],
);

// ── Cove V3 Guardian durable audit + signing journal (Phase 8) ─────────────
// Tamper-evident Guardian audit history and the per-backing-outpoint signing
// journal (double-sign protection). Off-chain operational state; no secrets.

export const coveV3GuardianAudit = pgTable(
  "cove_v3_guardian_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    requestId: text("request_id").notNull(),
    operation: text("operation").notNull(),
    tokenId: text("token_id").notNull(),
    backingTxid: text("backing_txid").notNull(),
    backingVout: integer("backing_vout").notNull(),
    prevStateHash: text("prev_state_hash").notNull(),
    nextStateHash: text("next_state_hash").notNull(),
    amountAtoms: atoms("amount_atoms").notNull(),
    grossSats: atoms("gross_sats").notNull(),
    protocolFeeSats: atoms("protocol_fee_sats").notNull(),
    minerFeeSats: atoms("miner_fee_sats").notNull(),
    policyVersion: integer("policy_version").notNull(),
    vaultProfileVersion: text("vault_profile_version").notNull(),
    expectedCmr: text("expected_cmr").notNull(),
    actualCmr: text("actual_cmr").notNull(),
    simplicityResult: text("simplicity_result").notNull(),
    referencePolicyResult: text("reference_policy_result").notNull(),
    unsignedTxDigest: text("unsigned_tx_digest").notNull(),
    decision: text("decision").notNull(),
    rejectionReason: text("rejection_reason"),
    beforeSignPersistedAt: timestamp("before_sign_persisted_at", { withTimezone: true }).notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    previousAuditHash: text("previous_audit_hash").notNull(),
    auditHash: text("audit_hash").notNull(),
  },
  (t) => [
    uniqueIndex("cove_v3_guardian_audit_hash_uq").on(t.network, t.auditHash),
    uniqueIndex("cove_v3_guardian_audit_predecessor_uq").on(t.network, t.previousAuditHash),
    index("cove_v3_guardian_audit_outpoint_idx").on(t.network, t.backingTxid, t.backingVout),
  ],
);

export const coveV3Submissions = pgTable(
  "cove_v3_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    sourceKind: text("source_kind").$type<"APP" | "FILL">().notNull(),
    sourceId: uuid("source_id").notNull(),
    operation: text("operation").notNull(),
    tokenId: text("token_id"),
    backingTxid: text("backing_txid"),
    backingVout: integer("backing_vout"),
    unsignedTxDigest: text("unsigned_tx_digest").notNull(),
    walletPsbtBase64: text("wallet_psbt_base64").notNull(),
    rawTxHex: text("raw_tx_hex"),
    txid: text("txid"),
    phase: text("phase")
      .$type<"SIGNING" | "READY" | "BROADCAST" | "RECOVERY_REQUIRED">()
      .notNull()
      .default("SIGNING"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    conflictGeneration: bigint("conflict_generation", { mode: "bigint" }),
    conflicted: boolean("conflicted").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cove_v3_submission_source_uq").on(t.network, t.sourceKind, t.sourceId),
    index("cove_v3_submissions_accepted_idx")
      .on(t.network, t.acceptedAt)
      .where(sql`${t.acceptedAt} is not null`),
    index("cove_v3_submission_txid_idx")
      .on(t.network, t.txid)
      .where(sql`${t.txid} is not null`),
    index("cove_v3_submission_due_idx")
      .on(t.network, t.nextAttemptAt, t.id)
      .where(sql`${t.phase} <> 'BROADCAST'`),
  ],
);

export const coveV3SigningJournal = pgTable(
  "cove_v3_signing_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    backingTxid: text("backing_txid").notNull(),
    backingVout: integer("backing_vout").notNull(),
    unsignedTxDigest: text("unsigned_tx_digest").notNull(),
    signatureHash: text("signature_hash"),
    signingResult: jsonb("signing_result").$type<{
      psbtBase64: string;
      resultJson: string;
      auditHash: string;
    }>(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Unsigned reservations expire; signed rows remain committed. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("cove_v3_signing_journal_accepted_idx")
      .on(t.network, sql`coalesce(${t.signingResult}->>'txid',${t.unsignedTxDigest})`)
      .where(sql`${t.signedAt} is not null`),
    uniqueIndex("cove_v3_signing_journal_candidate_uq").on(
      t.network,
      t.backingTxid,
      t.backingVout,
      t.unsignedTxDigest,
    ),
  ],
);

export const coveApiQuotas = pgTable(
  "cove_api_quotas",
  {
    key: text("key").primaryKey(),
    windowStart: atoms("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [index("cove_api_quotas_window_idx").on(t.windowStart)],
);
export const coveRpcBudgets = pgTable("cove_rpc_budgets", {
  account: text("account").primaryKey(),
  state: jsonb("state")
    .notNull()
    .default({ rate: 3, concurrency: 6, next: 0, lanes: {}, leases: [] }),
});

export const coveObservationEpochs = pgTable("cove_observation_epochs", {
  network: text("network").primaryKey(),
  chainGeneration: atoms("chain_generation").notNull().default(0n),
  tradeRevision: atoms("trade_revision").notNull().default(0n),
  pendingRevision: atoms("pending_revision").notNull().default(0n),
  marketRevision: atoms("market_revision").notNull().default(0n),
  metadataRevision: atoms("metadata_revision").notNull().default(0n),
  workerEpoch: uuid("worker_epoch"),
});
export const covePendingBacking = pgTable(
  "cove_pending_backing",
  {
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    requestedRevision: atoms("requested_revision").notNull().default(0n),
    observedRevision: atoms("observed_revision"),
    chainGeneration: atoms("chain_generation"),
    baseTxid: text("base_txid"),
    baseVout: integer("base_vout"),
    payload: jsonb("payload"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true })
      .notNull()
      .default(new Date(0)),
  },
  (t) => [
    primaryKey({ columns: [t.network, t.tokenId] }),
    index("cove_pending_backing_refresh_idx").on(t.network, t.lastCheckedAt, t.tokenId),
  ],
);
export const coveTransactionObservations = pgTable(
  "cove_transaction_observations",
  {
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    chainGeneration: atoms("chain_generation").notNull(),
    state: text("state").notNull(),
    blockHash: text("block_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.network, t.txid] })],
);

export const coveWatchedInputs = pgTable(
  "cove_watched_inputs",
  {
    network: text("network").notNull(),
    sourceId: text("source_id").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.network, t.sourceId, t.txid, t.vout] }),
    index("cove_watched_inputs_outpoint_idx").on(t.network, t.txid, t.vout),
  ],
);
export const coveIndexedSpends = pgTable(
  "cove_indexed_spends",
  {
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    spenderTxid: text("spender_txid").notNull(),
    blockHash: text("block_hash").notNull(),
    blockHeight: atoms("block_height").notNull(),
  },
  (t) => [primaryKey({ columns: [t.network, t.txid, t.vout, t.blockHash] })],
);
export const coveBackingProofs = pgTable(
  "cove_backing_proofs",
  {
    network: text("network").notNull(),
    tokenId: text("token_id").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    blockHash: text("block_hash").notNull(),
    blockHeight: atoms("block_height").notNull(),
  },
  (t) => [primaryKey({ columns: [t.network, t.tokenId] })],
);

export const coveWalletFunding = pgTable(
  "cove_wallet_funding",
  {
    network: text("network").notNull(),
    walletScript: text("wallet_script").notNull(),
    payload: jsonb("payload")
      .$type<
        {
          txid: string;
          vout: number;
          valueSats: string;
          confirmations: number;
        }[]
      >()
      .notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.network, t.walletScript] }),
    index("cove_wallet_funding_observed_idx").on(t.observedAt),
  ],
);
