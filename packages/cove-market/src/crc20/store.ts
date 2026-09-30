import * as bitcoin from "bitcoinjs-lib";
import { sql } from "drizzle-orm";
import { broadcastRecordedTransaction, checkSpendSignature } from "@crclaunch/bitcoin";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database, DbTransaction } from "@crclaunch/db";
import type { CoveV2Input } from "@crclaunch/crc20-transactions";
import {
  createCrcFill,
  crcMarketFee,
  validateCrcListing,
  verifyCrcFillSignatures,
  verifyCrcCancellation,
  verifyCrcListingAuthorization,
  verifyCurrentCrcFunding,
  type CrcFillOptions,
  type CrcListing,
  type CrcNetwork,
  type IndexedCrcAsset,
} from "./market.js";
import { parsePsbt } from "../psbt.js";

type CoreUtxo = Pick<CoreRpcProvider, "getTxout">;
type ListingRow = {
  id: string; network: CrcNetwork; deploy_txid: string; ticker: string;
  seller_script_hex: string; seller_payout_script_hex: string;
  seller_anchor_txid: string; seller_anchor_vout: number; seller_anchor_sats: string;
  amount_atoms: string; price_sats: string; protocol_fee_sats: string;
  expires_at_height: string; status: string;
};

function rowListing(row: ListingRow): CrcListing {
  return {
    id: row.id, network: row.network, deployTxid: row.deploy_txid, ticker: row.ticker,
    sellerScriptHex: row.seller_script_hex, sellerPayoutScriptHex: row.seller_payout_script_hex,
    sellerAnchorTxid: row.seller_anchor_txid, sellerAnchorVout: row.seller_anchor_vout,
    sellerAnchorSats: Number(row.seller_anchor_sats), amountAtoms: BigInt(row.amount_atoms),
    priceSats: Number(row.price_sats), protocolFeeSats: Number(row.protocol_fee_sats),
    expiresAtHeight: BigInt(row.expires_at_height),
  };
}

async function indexedAsset(tx: DbTransaction, listing: CrcListing): Promise<{ asset: IndexedCrcAsset; height: bigint; protocolScriptHex: string }> {
  const result = await tx.execute(sql`
    SELECT a.ticker, a.protocol_version, a.protocol_script_hex, v.script_hex AS vault_script_hex,
      u.txid AS token_txid, u.vout AS token_vout, u.script_hex AS token_script_hex,
      u.atoms AS token_atoms,
      COALESCE(c.height, a.deploy_height) AS height
    FROM cove_crc_assets a
    JOIN cove_crc_vaults v ON v.network = a.network AND v.deploy_txid = a.deploy_txid
    LEFT JOIN cove_crc_token_utxos u ON u.network = a.network AND u.deploy_txid = a.deploy_txid
      AND u.txid = ${listing.sellerAnchorTxid} AND u.vout = ${listing.sellerAnchorVout}
    LEFT JOIN cove_crc_cursor c ON c.network = a.network
    WHERE a.network = ${listing.network} AND a.deploy_txid = ${listing.deployTxid}
  `);
  const row = result.rows[0] as { ticker: string; protocol_version: number; protocol_script_hex: string;
    vault_script_hex: string;
    token_txid: string | null; token_vout: number | null; token_script_hex: string | null;
    token_atoms: string | null; height: string } | undefined;
  if (!row) throw new Error("deployment is not a registered Cove asset on this network");
  return {
    asset: { network: listing.network, deployTxid: listing.deployTxid, ticker: row.ticker,
      protocolVersion: row.protocol_version,
      tokenOutpoint: row.token_txid === null ? null : `${row.token_txid}:${row.token_vout}`,
      tokenScriptHex: row.token_script_hex, tokenAtoms: BigInt(row.token_atoms ?? 0),
      protocolScriptHex: row.protocol_script_hex, vaultScriptHex: row.vault_script_hex },
    height: BigInt(row.height), protocolScriptHex: row.protocol_script_hex,
  };
}

async function lockCrcProjection(tx: DbTransaction, network: CrcNetwork): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cove-crc:${network}`}))`);
}

async function checkAnchor(core: CoreUtxo, listing: CrcListing): Promise<void> {
  const output = await core.getTxout(listing.sellerAnchorTxid, listing.sellerAnchorVout, true);
  if (!output || output.scriptPubKeyHex.toLowerCase() !== listing.sellerScriptHex.toLowerCase() ||
    output.valueSats !== BigInt(listing.sellerAnchorSats)) {
    throw new Error("seller anchor is spent or differs from Core");
  }
}

async function assertTokenFreeBuyerFunding(tx: DbTransaction, network: CrcNetwork,
  funding: readonly CoveV2Input[]): Promise<void> {
  for (const input of funding) {
    const txid = input.txid.toLowerCase();
    const result = await tx.execute(sql`SELECT 1 FROM cove_crc_token_utxos
      WHERE network = ${network} AND txid = ${txid} AND vout = ${input.vout} LIMIT 1`);
    if (result.rows.length > 0) throw new Error("buyer funding carries a Cove token allocation");
  }
}

async function assertTokenFreePsbtBuyerFunding(tx: DbTransaction, network: CrcNetwork,
  psbt: bitcoin.Psbt): Promise<void> {
  const unsigned = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  for (const input of unsigned.ins.slice(1)) {
    const txid = Buffer.from(input.hash).reverse().toString("hex");
    const result = await tx.execute(sql`SELECT 1 FROM cove_crc_token_utxos
      WHERE network = ${network} AND txid = ${txid} AND vout = ${input.index} LIMIT 1`);
    if (result.rows.length > 0) throw new Error("buyer funding carries a Cove token allocation");
  }
}

export async function createCrcListing(
  db: Database,
  listing: CrcListing,
  sellerAuthorizationB64: string,
  core: CoreUtxo,
  feeBps: bigint,
): Promise<void> {
  verifyCrcListingAuthorization(listing, sellerAuthorizationB64);
  if (listing.protocolFeeSats !== crcMarketFee(listing.priceSats, feeBps)) {
    throw new Error("listing protocol fee does not match market policy");
  }
  await checkAnchor(core, listing);
  await db.transaction(async (tx) => {
    await lockCrcProjection(tx, listing.network);
    const { asset, height } = await indexedAsset(tx, listing);
    validateCrcListing(listing, asset, height);
    await tx.execute(sql`
      INSERT INTO cove_crc_market_listings
        (id, network, deploy_txid, ticker, seller_script_hex, seller_payout_script_hex,
         seller_anchor_txid, seller_anchor_vout, seller_anchor_sats, amount_atoms,
         price_sats, protocol_fee_sats, expires_at_height)
      VALUES (${listing.id}, ${listing.network}, ${listing.deployTxid}, ${listing.ticker},
        ${listing.sellerScriptHex}, ${listing.sellerPayoutScriptHex}, ${listing.sellerAnchorTxid},
        ${listing.sellerAnchorVout}, ${listing.sellerAnchorSats}, ${listing.amountAtoms.toString()},
        ${listing.priceSats}, ${listing.protocolFeeSats}, ${listing.expiresAtHeight.toString()})
    `);
  });
}

export async function cancelCrcListing(db: Database, network: CrcNetwork, listingId: string,
  sellerAuthorizationB64: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const result = await tx.execute(sql`SELECT * FROM cove_crc_market_listings
      WHERE id = ${listingId} AND network = ${network} FOR UPDATE`);
    const row = result.rows[0] as ListingRow | undefined;
    if (!row) throw new Error("Cove listing not found on this network");
    const listing = rowListing(row);
    verifyCrcCancellation(listing, sellerAuthorizationB64);
    if (row.status === "CANCELED") return;
    if (row.status !== "OPEN" && row.status !== "RESERVED") {
      throw new Error("listing can no longer be canceled");
    }
    const pending = await tx.execute(sql`SELECT id, status FROM cove_crc_market_fills
      WHERE listing_id = ${listingId} AND network = ${network} FOR UPDATE`);
    if (pending.rows.some((fill) => !["RESERVED", "FAILED"].includes((fill as { status: string }).status))) {
      throw new Error("buyer-signed fill can no longer be canceled");
    }
    await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'FAILED', updated_at = now()
      WHERE listing_id = ${listingId} AND network = ${network} AND status = 'RESERVED'`);
    await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'CANCELED', updated_at = now()
      WHERE id = ${listingId} AND network = ${network}`);
  });
}

export async function releaseExpiredCrcReservations(db: Database, network: CrcNetwork): Promise<number> {
  return db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const expired = await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'FAILED', updated_at = now()
      WHERE network = ${network} AND status = 'RESERVED' AND expires_at <= now()
      RETURNING listing_id`);
    for (const fill of expired.rows) {
      const listingId = (fill as { listing_id: string }).listing_id;
      await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'OPEN', updated_at = now()
        WHERE id = ${listingId} AND network = ${network} AND status = 'RESERVED'`);
    }
    return expired.rows.length;
  });
}

export type CrcFillReservation = Readonly<{
  fillId: string;
  listingId: string;
  network: CrcNetwork;
  buyerScriptHex: string;
  protocolScriptHex: string;
  recipientSats: number;
  minerFeeSats: number;
  sellerFunding: CoveV2Input;
  buyerFunding: readonly CoveV2Input[];
}>;

export async function reserveCrcFill(
  db: Database,
  request: CrcFillReservation,
  core: CoreUtxo,
): Promise<{ psbtBase64: string; unsignedTxDigest: string }> {
  return db.transaction(async (tx) => {
    await lockCrcProjection(tx, request.network);
    const expired = await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'FAILED', updated_at = now()
      WHERE listing_id = ${request.listingId} AND network = ${request.network}
        AND status = 'RESERVED' AND expires_at <= now() RETURNING listing_id`);
    if (expired.rows.length > 0) {
      await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'OPEN', updated_at = now()
        WHERE id = ${request.listingId} AND network = ${request.network} AND status = 'RESERVED'`);
    }
    const selected = await tx.execute(sql`SELECT * FROM cove_crc_market_listings
      WHERE id = ${request.listingId} AND network = ${request.network} FOR UPDATE`);
    const row = selected.rows[0] as ListingRow | undefined;
    if (!row) throw new Error("Cove listing not found on this network");
    if (row.status !== "OPEN") throw new Error("listing is already reserved or closed");
    const listing = rowListing(row);
    const { asset, height, protocolScriptHex } = await indexedAsset(tx, listing);
    await assertTokenFreeBuyerFunding(tx, request.network, request.buyerFunding);
    if (request.protocolScriptHex.toLowerCase() !== protocolScriptHex.toLowerCase()) {
      throw new Error("protocol fee recipient differs from registered Cove deployment");
    }
    const options: CrcFillOptions = { listing, asset, sellerFunding: request.sellerFunding,
      buyerFunding: request.buyerFunding, buyerScriptHex: request.buyerScriptHex,
      protocolScriptHex: request.protocolScriptHex, recipientSats: request.recipientSats,
      minerFeeSats: request.minerFeeSats, currentHeight: height };
    const { psbt } = createCrcFill(options);
    await verifyCurrentCrcFunding(core, options);
    const unsignedTxDigest = bitcoin.crypto.sha256(psbt.data.globalMap.unsignedTx.toBuffer()).toString("hex");
    await tx.execute(sql`INSERT INTO cove_crc_market_fills
      (id, network, listing_id, buyer_script_hex, unsigned_tx_digest, psbt_base64)
      VALUES (${request.fillId}, ${request.network}, ${request.listingId}, ${request.buyerScriptHex},
        ${unsignedTxDigest}, ${psbt.toBase64()})`);
    await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'RESERVED', updated_at = now()
      WHERE id = ${request.listingId} AND status = 'OPEN'`);
    return { psbtBase64: psbt.toBase64(), unsignedTxDigest };
  });
}

function assertSameTrustedPsbt(original: bitcoin.Psbt, signed: bitcoin.Psbt): void {
  if (!signed.data.globalMap.unsignedTx.toBuffer().equals(original.data.globalMap.unsignedTx.toBuffer()) ||
    signed.data.inputs.length !== original.data.inputs.length) throw new Error("signed fill changed transaction");
  for (let i = 0; i < original.data.inputs.length; i++) {
    const a = signed.data.inputs[i]!.witnessUtxo;
    const b = original.data.inputs[i]!.witnessUtxo;
    if (!a || !b || a.value !== b.value || !a.script.equals(b.script) ||
      signed.data.inputs[i]!.sighashType !== bitcoin.Transaction.SIGHASH_ALL) {
      throw new Error("signed fill changed trusted funding");
    }
  }
}

function bitcoinNetwork(network: CrcNetwork): bitcoin.networks.Network {
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  if (network === "regtest") return bitcoin.networks.regtest;
  return bitcoin.networks.testnet;
}

export async function submitBuyerSignedCrcFill(
  db: Database,
  network: CrcNetwork,
  fillId: string,
  buyerSignedPsbtBase64: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const selected = await tx.execute(sql`SELECT f.status AS fill_status, f.psbt_base64, f.expires_at,
      l.*, l.status AS listing_status FROM cove_crc_market_fills f JOIN cove_crc_market_listings l ON l.id = f.listing_id
      WHERE f.id = ${fillId} AND f.network = ${network} FOR UPDATE OF f, l`);
    const row = selected.rows[0] as (ListingRow & { fill_status: string; listing_status: string; psbt_base64: string; expires_at: string | Date }) | undefined;
    if (!row || row.fill_status !== "RESERVED" || row.listing_status !== "RESERVED" ||
      new Date(row.expires_at).getTime() <= Date.now()) {
      throw new Error("fill reservation is no longer available");
    }
    const listing = rowListing(row);
    const { asset, height } = await indexedAsset(tx, listing);
    validateCrcListing(listing, asset, height);
    const original = parsePsbt(row.psbt_base64, bitcoinNetwork(network));
    await assertTokenFreePsbtBuyerFunding(tx, network, original);
    const signed = parsePsbt(buyerSignedPsbtBase64, bitcoinNetwork(network));
    assertSameTrustedPsbt(original, signed);
    if (signed.data.inputs.length < 2) throw new Error("buyer input is missing");
    for (let i = 1; i < signed.data.inputs.length; i++) {
      const result = checkSpendSignature(signed, i);
      if (!result.ok) throw new Error(`buyer signature invalid: ${result.detail}`);
    }
    await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'BUYER_SIGNED',
      buyer_signed_psbt_base64 = ${signed.toBase64()}, updated_at = now()
      WHERE id = ${fillId} AND status = 'RESERVED'`);
  });
}

export async function listCrcSellerFillRequests(
  db: Database,
  network: CrcNetwork,
  sellerScriptHex: string,
): Promise<{ fillId: string; listingId: string; buyerSignedPsbtBase64: string;
  amountAtoms: string; priceSats: string; expiresAt: string }[]> {
  const rows = await db.execute(sql`SELECT f.id AS fill_id, f.listing_id,
    f.buyer_signed_psbt_base64, f.expires_at, l.amount_atoms, l.price_sats
    FROM cove_crc_market_fills f JOIN cove_crc_market_listings l ON l.id = f.listing_id
    WHERE f.network = ${network} AND l.seller_script_hex = ${sellerScriptHex}
      AND f.status = 'BUYER_SIGNED' AND l.status = 'RESERVED' AND f.expires_at > now()
    ORDER BY f.created_at ASC LIMIT 50`);
  return rows.rows.map((value) => {
    const row = value as { fill_id: string; listing_id: string; buyer_signed_psbt_base64: string;
      amount_atoms: string; price_sats: string; expires_at: string | Date };
    return { fillId: row.fill_id, listingId: row.listing_id,
      buyerSignedPsbtBase64: row.buyer_signed_psbt_base64,
      amountAtoms: row.amount_atoms, priceSats: row.price_sats, expiresAt: new Date(row.expires_at).toISOString() };
  });
}

export async function acceptSignedCrcFill(
  db: Database,
  network: CrcNetwork,
  fillId: string,
  signedPsbtBase64: string,
  core: CoreUtxo,
): Promise<{ txid: string; rawHex: string }> {
  return db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const result = await tx.execute(sql`SELECT f.*, l.*,
      f.id AS fill_id, f.status AS fill_status, f.psbt_base64 AS original_psbt,
      l.status AS listing_status
      FROM cove_crc_market_fills f JOIN cove_crc_market_listings l ON l.id = f.listing_id
      WHERE f.id = ${fillId} AND f.network = ${network} FOR UPDATE OF f, l`);
    const row = result.rows[0] as (ListingRow & { fill_status: string; listing_status: string; original_psbt: string }) | undefined;
    if (!row || row.fill_status !== "BUYER_SIGNED" || row.listing_status !== "RESERVED") {
      throw new Error("buyer-signed fill is not waiting for seller");
    }
    const listing = rowListing(row);
    const { asset, height } = await indexedAsset(tx, listing);
    validateCrcListing(listing, asset, height);
    const original = parsePsbt(row.original_psbt, bitcoinNetwork(network));
    await assertTokenFreePsbtBuyerFunding(tx, network, original);
    const signed = parsePsbt(signedPsbtBase64, bitcoinNetwork(network));
    assertSameTrustedPsbt(original, signed);
    verifyCrcFillSignatures(signed, signed.data.inputs.length - 1);
    const unsigned = bitcoin.Transaction.fromBuffer(original.data.globalMap.unsignedTx.toBuffer());
    for (let i = 0; i < unsigned.ins.length; i++) {
      const funding = original.data.inputs[i]!.witnessUtxo!;
      const outpoint = Buffer.from(unsigned.ins[i]!.hash).reverse().toString("hex");
      const current = await core.getTxout(outpoint, unsigned.ins[i]!.index, true);
      if (!current || current.valueSats !== BigInt(funding.value) ||
        current.scriptPubKeyHex.toLowerCase() !== funding.script.toString("hex")) {
        throw new Error("fill funding is spent or changed");
      }
    }
    signed.finalizeAllInputs();
    const transaction = signed.extractTransaction();
    const txid = transaction.getId();
    const rawHex = transaction.toHex();
    await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'SIGNED',
      signed_psbt_base64 = ${signedPsbtBase64}, txid = ${txid}, updated_at = now()
      WHERE id = ${fillId} AND status = 'BUYER_SIGNED'`);
    return { txid, rawHex };
  });
}

export async function markCrcFillBroadcast(db: Database, network: CrcNetwork, fillId: string, txid: string): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'BROADCAST', updated_at = now()
      WHERE id = ${fillId} AND network = ${network} AND txid = ${txid} AND status = 'SIGNED' RETURNING id, listing_id`);
    const row = changed.rows[0] as { listing_id: string } | undefined;
    if (!row) {
      const existing = await tx.execute(sql`SELECT id FROM cove_crc_market_fills WHERE id = ${fillId}
        AND network = ${network} AND txid = ${txid} AND status = 'BROADCAST'`);
      if (existing.rows.length === 1) return;
      throw new Error("signed fill not found or already broadcast");
    }
    const listing = await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'BROADCAST', updated_at = now()
      WHERE id = ${row.listing_id} AND status = 'RESERVED' RETURNING id`);
    if (listing.rows.length !== 1) throw new Error("listing reservation changed");
  });
}

export async function broadcastCrcFill(
  db: Database,
  network: CrcNetwork,
  fillId: string,
  core: CoreRpcProvider,
): Promise<string> {
  const loaded = await db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const result = await tx.execute(sql`SELECT f.status AS fill_status, f.txid, f.signed_psbt_base64,
      l.* FROM cove_crc_market_fills f JOIN cove_crc_market_listings l ON l.id = f.listing_id
      WHERE f.id = ${fillId} AND f.network = ${network}`);
    const row = result.rows[0] as (ListingRow & { fill_status: string; txid: string | null; signed_psbt_base64: string | null }) | undefined;
    if (!row || !row.txid || !row.signed_psbt_base64 ||
      (row.fill_status !== "SIGNED" && row.fill_status !== "BROADCAST")) {
      throw new Error("signed Cove fill not found");
    }
    if (row.fill_status === "BROADCAST") return { txid: row.txid, signed: row.signed_psbt_base64, alreadyBroadcast: true };
    const listing = rowListing(row);
    const { asset, height } = await indexedAsset(tx, listing);
    validateCrcListing(listing, asset, height);
    await assertTokenFreePsbtBuyerFunding(tx, network, parsePsbt(row.signed_psbt_base64, bitcoinNetwork(network)));
    return { txid: row.txid, signed: row.signed_psbt_base64, alreadyBroadcast: false };
  });
  if (loaded.alreadyBroadcast) return loaded.txid;
  const psbt = parsePsbt(loaded.signed, bitcoinNetwork(network));
  psbt.finalizeAllInputs();
  const transaction = psbt.extractTransaction();
  if (transaction.getId() !== loaded.txid) throw new Error("recorded fill identity mismatch");
  await broadcastRecordedTransaction(core, { rawTxHex: transaction.toHex(), txid: loaded.txid }, network);
  await markCrcFillBroadcast(db, network, fillId, loaded.txid);
  return loaded.txid;
}

export async function reconcileCrcFill(db: Database, network: CrcNetwork, fillId: string): Promise<"confirmed" | "pending" | "reorged" | "invalid"> {
  return db.transaction(async (tx) => {
    await lockCrcProjection(tx, network);
    const result = await tx.execute(sql`SELECT f.id, f.listing_id, f.txid, f.status,
      e.status AS chain_status, e.valid AS chain_valid, e.operation AS chain_operation,
      e.deploy_txid AS chain_deploy_txid, e.amount_atoms AS chain_amount_atoms,
      l.deploy_txid AS listing_deploy_txid, l.amount_atoms AS listing_amount_atoms
      FROM cove_crc_market_fills f JOIN cove_crc_market_listings l ON l.id = f.listing_id
      LEFT JOIN cove_crc_events e ON e.network = f.network AND e.txid = f.txid
      WHERE f.id = ${fillId} AND f.network = ${network} FOR UPDATE OF f`);
    const row = result.rows[0] as { listing_id: string; status: string; chain_status: string | null; chain_valid: boolean | null;
      chain_operation: string | null; chain_deploy_txid: string | null; chain_amount_atoms: string | null;
      listing_deploy_txid: string; listing_amount_atoms: string } | undefined;
    if (!row) throw new Error("fill not found");
    if (row.chain_status === "applied" && row.chain_valid && row.chain_operation === "transfer" &&
      row.chain_deploy_txid === row.listing_deploy_txid &&
      row.chain_amount_atoms === row.listing_amount_atoms) {
      await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'CONFIRMED', updated_at = now() WHERE id = ${fillId}`);
      await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'FILLED', updated_at = now() WHERE id = ${row.listing_id}`);
      return "confirmed";
    }
    if (row.chain_status !== null) {
      await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'FAILED', updated_at = now() WHERE id = ${fillId}`);
      await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'STALE', updated_at = now() WHERE id = ${row.listing_id}`);
      return "invalid";
    }
    if (row.status === "CONFIRMED") {
      await tx.execute(sql`UPDATE cove_crc_market_fills SET status = 'REORGED', updated_at = now() WHERE id = ${fillId}`);
      await tx.execute(sql`UPDATE cove_crc_market_listings SET status = 'STALE', updated_at = now() WHERE id = ${row.listing_id}`);
      return "reorged";
    }
    return "pending";
  });
}
