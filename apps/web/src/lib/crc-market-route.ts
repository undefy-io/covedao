import * as bitcoin from "bitcoinjs-lib";
import { sql } from "drizzle-orm";
import { z } from "zod";
import * as core from "@crclaunch/crc20-protocol";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import { fail, handleError, ok } from "./api";
import { checkCrcRateLimit } from "./crc-rate-limit";
import type { CrcNetwork } from "./crc-read";
import { activateCrcCoreOffer } from "./crc-market-core";
import { buildCrcTokenSession, buildCrcOfferSession } from "./crc-build";
import { prepareCrcSession, submitCrcSession } from "./crc-submit";
const txid = z.string().regex(/^[0-9a-f]{64}$/);
const script = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/)
  .max(20000);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const outpoint = z.object({ txid, vout: z.number().int().min(0).max(0xffffffff) }).strict();
const common = z.object({
  walletScriptHex: script,
  tokenScriptHex: script,
  walletPublicKeyHex: z.string().max(66).optional(),
  tokenPublicKeyHex: z.string().max(66).optional(),
  paymentFunding: z.array(outpoint).max(40),
  fundingEvidence: z.unknown().optional(),
  minerFeeSats: z.number().int().positive().max(Number(core.maxMinerFeeSats)),
  idempotencyKey: z.string().min(1).max(128),
});
const signed = z
  .object({ sessionId: z.string().uuid(), signedPsbtBase64: z.string().min(1).max(250000), broadcast: z.literal("client").optional() })
  .strict();
export type CrcMarketServices = {
  db: Database;
  provider: CoreRpcProvider;
  network: CrcNetwork;
  feeScriptHex?: string;
  guardianEndpoint?: string;
  guardianAuthToken?: string;
};
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
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

class RequestTooLargeError extends Error {}

export async function readCrcMarketListings(
  db: Database,
  network: CrcNetwork,
  deployTxid?: string,
  sellerScriptHex?: string,
) {
  const rows = await db.execute(sql`
    SELECT o.key, o.value_json FROM crc_records o
    JOIN crc_records a ON a.network=o.network AND a.kind='assets' AND a.key=o.deploy_txid
    JOIN crc_records u ON u.network=o.network AND u.kind='allocations'
      AND u.key=(o.value_json->'listedInput'->>'txid') || ':' || (o.value_json->'listedInput'->>'vout')
      AND u.deploy_txid=o.deploy_txid AND u.script_hex=o.script_hex AND u.atoms=o.atoms
    JOIN crc_cursors c ON c.network=o.network
    WHERE o.network=${core.protocolNetwork(network)} AND o.kind='offers' AND ${sellerScriptHex ? sql`o.status IN ('open', 'cancelPending')` : sql`o.status='open'`}
      AND (o.value_json->>'expiryHeight')::bigint > c.height
      AND ${deployTxid ? sql`o.deploy_txid=${deployTxid}` : sql`true`}
      AND ${sellerScriptHex ? sql`o.script_hex=${sellerScriptHex}` : sql`true`}
    ORDER BY o.key LIMIT 101
  `);
  return rows.rows.map((row) => {
    const offer = core.decodeProtocolDto<core.Offer>(row.value_json);
    return {
      id: row.key,
      network,
      deployTxid: offer.deployTxid,
      ticker: offer.ticker,
      sellerScriptHex: offer.sellerScriptHex,
      sellerPayoutScriptHex: offer.sellerScriptHex,
      sellerAnchorTxid: offer.listedInput.txid,
      sellerAnchorVout: offer.listedInput.vout,
      sellerAnchorSats: Number(core.sats(offer.listedInput.sats)),
      amountAtoms: offer.listedInput.atoms.toString(),
      priceSats: Number(offer.priceSats),
      protocolFeeSats: Number(core.marketFee(offer.priceSats)),
      expiresAtHeight: String(offer.expiryHeight),
      status: offer.status === "cancelPending" ? "CANCEL_PENDING" : "OPEN",
      coreOffer: core.encodeProtocolDto(offer),
    };
  });
}
export async function crcMarketGet(
  req: Request,
  operation: string,
  enabled: boolean,
  read: () => { db: Database; network: CrcNetwork },
): Promise<Response> {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    if (operation !== "listings") return fail("NOT_FOUND", "Market operation not found", 404);
    if (!enabled) return ok({ active: false, listings: [] });
    const deployTxid = new URL(req.url).searchParams.get("deployTxid") ?? undefined;
    if (deployTxid && !txid.safeParse(deployTxid).success)
      return fail("BAD_REQUEST", "Invalid deployment", 400);
    const sellerScriptHex = new URL(req.url).searchParams.get("sellerScriptHex") ?? undefined;
    if (sellerScriptHex && !script.safeParse(sellerScriptHex).success)
      return fail("BAD_REQUEST", "Invalid seller script", 400);
    const { db, network } = read();
    const rows = await readCrcMarketListings(db, network, deployTxid, sellerScriptHex);
    return ok({ active: true, listings: rows.slice(0, 100), truncated: rows.length > 100,
      ...(sellerScriptHex ? { unavailableOutpoints: rows.slice(0, 100).map(row => ({txid: row.sellerAnchorTxid, vout: row.sellerAnchorVout})) } : {}) });
  } catch (error) {
    return handleError(error);
  }
}
export async function crcMarketPost(
  req: Request,
  operation: string,
  enabled: boolean,
  services: () => CrcMarketServices,
): Promise<Response> {
  // Funding exclusion is a read-only observation shared by launch and curve
  // signing; marketplace release controls only marketplace mutations.
  if (!enabled && operation !== "funding-check") return fail("CRC_MARKET_DISABLED", "Cove marketplace trading is paused", 503, true);
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const raw = await bodyJson(req);
    const service = services(),
      { db, provider, network } = service;
    if (operation === "listings") {
      const parsed = z
        .object({ offer: z.record(z.unknown()) })
        .strict()
        .parse(raw);
      return ok({
        listingId: await activateCrcCoreOffer({
          db,
          provider,
          network,
          offer: parsed.offer as core.ProtocolDto<core.Offer>,
        }),
      });
    }
    if (operation === "seller-requests") {
      z.object({ sellerScriptHex: script }).strict().parse(raw);
      return ok({ requests: [] });
    }
    if (operation === "funding-check") {
      const parsed = z
        .object({ outpoints: z.array(outpoint).min(1).max(40) })
        .strict()
        .parse(raw);
      const keys = parsed.outpoints.map(core.outpoint),
        txids = [...new Set(parsed.outpoints.map((coin) => coin.txid))];
      const rows =
        await db.execute(sql`SELECT key FROM crc_records WHERE network=${core.protocolNetwork(network)}
        AND kind='allocations' AND key IN (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})
        UNION ALL SELECT (value_json->'vault'->>'txid') || ':' || (value_json->'vault'->>'vout') AS key
        FROM crc_records WHERE network=${core.protocolNetwork(network)} AND kind='assets'
        AND value_json->'vault'->>'txid' IN (${sql.join(
          txids.map((id) => sql`${id}`),
          sql`, `,
        )})`);
      const excluded = new Set(rows.rows.map((row) => row.key));
      return ok({
        tokenFreeOutpoints: parsed.outpoints.filter((coin) => !excluded.has(core.outpoint(coin))),
      });
    }
    const bitcoinNetwork =
      network === "mainnet"
        ? bitcoin.networks.bitcoin
        : network === "regtest"
          ? bitcoin.networks.regtest
          : bitcoin.networks.testnet;
    if (operation === "reserve" || operation === "cancel-build") {
      const parsed = common
        .extend({ offerId: z.string().min(1).max(250) })
        .strict()
        .parse(raw);
      if (!service.feeScriptHex) throw new Error("CRC market fee authority is unavailable");
      const built = await buildCrcOfferSession({
        ...parsed,
        db,
        network,
        bitcoinNetwork,
        operation: operation === "reserve" ? "purchase" : "cancel",
        feeScriptHex: service.feeScriptHex,
      });
      return ok({ ...built, fillId: built.sessionId });
    }
    if (operation === "transfer-build" || operation === "listing-build") {
      const parsed = common
        .extend({
          minerFeeSats: common.shape.minerFeeSats.optional(),
          feeRateSatPerVb: z.number().int().min(1).max(500).optional(),
          deployTxid: txid,
          tokenFunding: z.array(outpoint).min(1).max(32),
          amountAtoms: decimal,
          recipientScriptHex: script,
          priceSats: decimal.optional(),
        })
        .strict()
        .refine(value => (value.minerFeeSats === undefined) !== (value.feeRateSatPerVb === undefined), "Choose one network fee method")
        .parse(raw);
      if (!service.feeScriptHex) throw new Error("CRC market fee authority is unavailable");
      return ok(
        await buildCrcTokenSession({
          ...parsed,
          db,
          network,
          bitcoinNetwork,
          operation: operation === "listing-build" ? "listing" : "transfer",
          amountAtoms: BigInt(parsed.amountAtoms),
          priceSats: parsed.priceSats === undefined ? undefined : BigInt(parsed.priceSats),
          feeScriptHex: service.feeScriptHex,
        }),
      );
    }
    const operations = {
      "buyer-sign": "purchase",
      cancel: "cancel",
      "transfer-submit": "transfer",
      "listing-submit": "listing",
    } as const;
    if (Object.hasOwn(operations, operation)) {
      const parsed = signed.parse(raw);
      if (network !== "regtest" && parsed.broadcast !== "client")
        return fail("CLIENT_UPDATE_REQUIRED", "Refresh this page before submitting the transaction.", 409);
      const result = await (parsed.broadcast === "client" ? prepareCrcSession : submitCrcSession)({
        ...parsed,
        db,
        network,
        provider,
        guardianEndpoint: service.guardianEndpoint ?? "",
        guardianAuthToken: service.guardianAuthToken ?? "",
        expectedOperation: operations[operation as keyof typeof operations],
      });
      return ok({ ...result, fillId: parsed.sessionId });
    }
    return fail("NOT_FOUND", "Market operation not found", 404);
  } catch (error) {
    if (error instanceof RequestTooLargeError)
      return fail("REQUEST_TOO_LARGE", "Market request is too large", 413);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return fail("BAD_REQUEST", "Invalid market request", 400);
    return handleError(error);
  }
}
