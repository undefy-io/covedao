import { sql } from "drizzle-orm";
import { z } from "zod";
import { COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import {
  crcMarketFee, createCrcListing, cancelCrcListing, reserveCrcFill,
  submitBuyerSignedCrcFill, listCrcSellerFillRequests, acceptSignedCrcFill,
  broadcastCrcFill, type CrcListing, type CrcNetwork,
} from "@crclaunch/cove-market";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import { fail, handleError, ok } from "./api";
import { checkCrcRateLimit } from "./crc-rate-limit";

const txid = z.string().regex(/^[0-9a-f]{64}$/);
const script = z.string().regex(/^(?:[0-9a-f]{2})+$/).max(20000);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const sats = z.number().int().safe().nonnegative();
const uuid = z.string().uuid();
const input = z.object({ txid, vout: sats, valueSats: sats.positive(), scriptHex: script,
  publicKeyHex: z.string().regex(/^(?:(?:02|03)[0-9a-f]{64}|[0-9a-f]{64})$/i).optional(),
  tokenAtoms: decimal, tokenDeploymentTxid: txid.optional() }).strict();
const listing = z.object({
  id: uuid, network: z.enum(["regtest", "signet", "testnet", "mainnet"]), deployTxid: txid,
  ticker: z.string().min(1).max(12), sellerScriptHex: script, sellerPayoutScriptHex: script,
  sellerAnchorTxid: txid, sellerAnchorVout: sats, sellerAnchorSats: sats.positive(),
  amountAtoms: decimal, priceSats: sats.positive(), protocolFeeSats: sats,
  expiresAtHeight: decimal,
}).strict();
const reserve = z.object({ fillId: uuid, listingId: uuid, buyerScriptHex: script,
  buyerFundingScriptHex: script.optional(),
  protocolScriptHex: script, recipientSats: sats.positive(), minerFeeSats: sats,
  sellerFunding: input, buyerFunding: z.array(input).min(1).max(20) }).strict();
const signed = z.object({ fillId: uuid, signedPsbtBase64: z.string().min(1).max(250_000) }).strict();
const identifier = z.object({ fillId: uuid }).strict();
const cancel = z.object({ listingId: uuid, sellerAuthorizationB64: z.string().min(1).max(10_000) }).strict();
const fundingCheck = z.object({ outpoints: z.array(z.object({ txid, vout: sats }).strict()).min(1).max(256) }).strict();

export type CrcMarketServices = { db: Database; provider: CoreRpcProvider; network: CrcNetwork };

function parseInput(value: z.infer<typeof input>) {
  return { ...value, tokenAtoms: BigInt(value.tokenAtoms) };
}

async function bodyJson(req: Request): Promise<unknown> {
  const maxBytes = 300_000;
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw new RequestTooLargeError();
  if (!req.body) throw new SyntaxError("market request has no body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new RequestTooLargeError();
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

class RequestTooLargeError extends Error {}

export async function readCrcMarketListings(db: Database, network: CrcNetwork, deployTxid?: string) {
  const rows = await db.execute(sql`SELECT l.* FROM cove_crc_market_listings l
    JOIN cove_crc_assets a ON a.network = l.network AND a.deploy_txid = l.deploy_txid
    JOIN cove_crc_token_utxos u ON u.network = l.network AND u.deploy_txid = l.deploy_txid
      AND u.txid = l.seller_anchor_txid AND u.vout = l.seller_anchor_vout
    WHERE l.network = ${network} AND l.status IN ('OPEN', 'RESERVED') AND a.protocol_version = 2
      AND u.script_hex = l.seller_script_hex AND u.atoms = l.amount_atoms
      AND ${deployTxid ? sql`l.deploy_txid = ${deployTxid}` : sql`true`}
      AND l.expires_at_height > COALESCE((SELECT height FROM cove_crc_cursor WHERE network = ${network}), 0)
    ORDER BY l.created_at DESC LIMIT 100`);
  return rows.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: row.id, network: row.network, deployTxid: row.deploy_txid, ticker: row.ticker,
      sellerScriptHex: row.seller_script_hex, sellerPayoutScriptHex: row.seller_payout_script_hex,
      sellerAnchorTxid: row.seller_anchor_txid, sellerAnchorVout: row.seller_anchor_vout,
      sellerAnchorSats: Number(row.seller_anchor_sats), amountAtoms: String(row.amount_atoms),
      priceSats: Number(row.price_sats), protocolFeeSats: Number(row.protocol_fee_sats),
      expiresAtHeight: String(row.expires_at_height), status: row.status,
    };
  });
}

export async function crcMarketGet(
  req: Request, operation: string, enabled: boolean,
  read: () => { db: Database; network: CrcNetwork },
): Promise<Response> {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    if (operation !== "listings") return fail("NOT_FOUND", "Market operation not found", 404);
    if (!enabled) return ok({ active: false, listings: [] });
    const { db, network } = read();
    const query = new URL(req.url).searchParams;
    const deployTxid = query.get("deployTxid") ?? undefined;
    if (deployTxid && !txid.safeParse(deployTxid).success) return fail("BAD_REQUEST", "Invalid deployment", 400);
    return ok({ active: enabled, listings: await readCrcMarketListings(db, network, deployTxid) });
  } catch (error) { return handleError(error); }
}

export async function crcMarketPost(
  req: Request, operation: string, enabled: boolean,
  services: () => CrcMarketServices,
): Promise<Response> {
  if (!enabled) return fail("CRC_MARKET_DISABLED", "Cove marketplace trading is paused until v2 token outpoint release tests pass.", 503, true);
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const raw = await bodyJson(req);
    const { db, provider, network } = services();
    switch (operation) {
      case "funding-check": {
        const parsed = fundingCheck.parse(raw);
        const txids = [...new Set(parsed.outpoints.map((coin) => coin.txid))];
        const result = await db.execute(sql`SELECT txid, vout FROM cove_crc_token_utxos
          WHERE network = ${network} AND txid IN (${sql.join(txids.map((value) => sql`${value}`), sql`, `)})`);
        const carrying = new Set(result.rows.map((row) => `${row.txid}:${row.vout}`));
        return ok({ tokenFreeOutpoints: parsed.outpoints.filter((coin) => !carrying.has(`${coin.txid}:${coin.vout}`)) });
      }
      case "listings": {
        const parsed = z.object({ listing, sellerAuthorizationB64: z.string().min(1).max(10_000) }).strict().parse(raw);
        if (parsed.listing.network !== network) return fail("WRONG_NETWORK", "Listing network differs from server", 400);
        const proposed: CrcListing = { ...parsed.listing,
          amountAtoms: BigInt(parsed.listing.amountAtoms), expiresAtHeight: BigInt(parsed.listing.expiresAtHeight) };
        if (proposed.protocolFeeSats !== crcMarketFee(proposed.priceSats, COVE_FEE_CONFIG.p2pFeeBps,
          COVE_FEE_CONFIG.p2pFeeMinSats)) return fail("BAD_REQUEST", "Listing fee differs from policy", 400);
        await createCrcListing(db, proposed, parsed.sellerAuthorizationB64, provider,
          COVE_FEE_CONFIG.p2pFeeBps);
        return ok({ listingId: proposed.id });
      }
      case "reserve": {
        const parsed = reserve.parse(raw);
        const result = await reserveCrcFill(db, { ...parsed, network,
          sellerFunding: parseInput(parsed.sellerFunding), buyerFunding: parsed.buyerFunding.map(parseInput) }, provider);
        return ok({ fillId: parsed.fillId, ...result });
      }
      case "buyer-sign": {
        const parsed = signed.parse(raw);
        await submitBuyerSignedCrcFill(db, network, parsed.fillId, parsed.signedPsbtBase64);
        return ok({ fillId: parsed.fillId, status: "BUYER_SIGNED" });
      }
      case "seller-requests": {
        const parsed = z.object({ sellerScriptHex: script }).strict().parse(raw);
        return ok({ requests: await listCrcSellerFillRequests(db, network, parsed.sellerScriptHex) });
      }
      case "seller-sign": {
        const parsed = signed.parse(raw);
        const result = await acceptSignedCrcFill(db, network, parsed.fillId, parsed.signedPsbtBase64, provider);
        return ok({ fillId: parsed.fillId, txid: result.txid, status: "SIGNED" });
      }
      case "broadcast": {
        const parsed = identifier.parse(raw);
        return ok({ fillId: parsed.fillId, txid: await broadcastCrcFill(db, network, parsed.fillId, provider) });
      }
      case "cancel": {
        const parsed = cancel.parse(raw);
        await cancelCrcListing(db, network, parsed.listingId, parsed.sellerAuthorizationB64);
        return ok({ listingId: parsed.listingId, status: "CANCELED" });
      }
      default: return fail("NOT_FOUND", "Market operation not found", 404);
    }
  } catch (error) {
    if (error instanceof RequestTooLargeError) return fail("REQUEST_TOO_LARGE", "Market request is too large", 413);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return fail("BAD_REQUEST", "Invalid market request", 400);
    return handleError(error);
  }
}
