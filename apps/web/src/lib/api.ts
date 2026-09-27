import { AppError } from "@crclaunch/cove-app";
import { MarketError } from "@crclaunch/cove-market";
import { BackingError } from "@crclaunch/cove-economics";
import * as Sentry from "@sentry/nextjs";

/** Serialize bigint as strings for the JSON API (no JS floating point). */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, bigintToString), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function ok(data: unknown): Response {
  return json({ ok: true, data });
}

export function fail(
  code: string,
  message: string,
  status = 400,
  retryable = false,
  detail?: string,
): Response {
  return json({ ok: false, error: { code, message, retryable, detail } }, status);
}

/**
 * The error's own words, when we wrote them ourselves.
 *
 * `humanCopy` below is deliberately short, but short copy hides the one thing
 * the user needs: how much BTC is missing, which fee rate would actually
 * relay, how many carriers to consolidate. Those details come from our own
 * error classes, never from a stack or a node, so they are safe to show. An
 * unrecognised error contributes nothing.
 */
function detailOf(e: unknown): string | undefined {
  if (!(isAppError(e) || e instanceof MarketError || e instanceof BackingError))
    return undefined;
  return e.message.replace(/^\[[A-Z_]+\]\s*/, "");
}

function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (
    e instanceof Error && e.name === "AppError" &&
    typeof (e as AppError).code === "string"
  );
}

function codeOf(e: unknown): string {
  if (isAppError(e)) return e.code;
  if (e instanceof MarketError) return e.code;
  if (e instanceof BackingError) return e.code;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("CLIENT_INTENT_MISMATCH")) return "CLIENT_INTENT_MISMATCH";
  return "INTERNAL_ERROR";
}

/** Map V3 errors to stable client codes + human copy (§71/§72). Never expose stacks. */
export function handleError(e: unknown): Response {
  console.error("[api] error:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  const code = codeOf(e);
  if (code === "INTERNAL_ERROR") {
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)));
  }
  const human = humanCopy(code);
  const retryable = [
    "CORE_UNAVAILABLE",
    "INDEXER_UNHEALTHY",
    "INDEXER_REBUILDING",
    "QUOTE_STALE",
    "STATE_CHANGED",
    "MEMPOOL_REJECTED",
    "BROADCAST_FAILED",
  ].includes(code);
  const status =
    code === "INTERNAL_ERROR"
      ? 500
      : code === "REQUEST_TOO_LARGE"
        ? 413
        : code === "WRONG_NETWORK" || code === "MAINNET_DISABLED"
          ? 403
          : 400;
  return fail(code, human, status, retryable, detailOf(e));
}

function humanCopy(code: string): string {
  switch (code) {
    case "QUOTE_STALE":
      return "The backing state changed while you were reviewing. We refreshed the quote.";
    case "STATE_CHANGED":
      return "The chain state changed. Please review the latest values.";
    case "LISTING_RESERVED":
      return "Another buyer is currently filling this listing.";
    case "LISTING_SOURCE_SPENT":
      return "The seller's token output is no longer available.";
    case "PROTOCOL_FEE_DUST":
      return "This trade is too small to create a standard Bitcoin fee output.";
    case "ECONOMIC_DUST":
      return "This trade is too small to be worth making.";
    case "INDEXER_REBUILDING":
      return "covs is rebuilding chain state. Trading is temporarily paused.";
    case "INDEXER_UNHEALTHY":
      return "The covs indexer is catching up. Trading is temporarily paused.";
    case "CORE_UNAVAILABLE":
      return "Bitcoin Core is unreachable. Trading is temporarily paused.";
    case "WALLET_REQUIRED":
      return "Connect a wallet to continue.";
    case "WALLET_UNSUPPORTED":
      return "Your wallet does not support this action.";
    case "WRONG_NETWORK":
      return "Your wallet is connected to the wrong network.";
    case "MAINNET_DISABLED":
      return "Mainnet is not enabled yet.";
    case "INSUFFICIENT_BTC":
      return "Not enough BTC to cover this transaction.";
    case "FUNDING_INPUT_INVALID":
      return "The selected payment coins are invalid.";
    case "MINER_FEE_TOO_LOW":
      return "That miner fee is too low — Bitcoin would not relay this transaction.";
    case "MINER_FEE_TOO_HIGH":
      return "That miner fee is far above the going rate. Pick a lower speed.";
    case "PSBT_MUTATED":
      return "The transaction changed after it was built. Please retry.";
    case "MEMPOOL_REJECTED":
      return "Bitcoin rejected this transaction. Please retry.";
    case "BROADCAST_FAILED":
      return "The transaction could not be broadcast. Please retry.";
    case "GUARDIAN_UNAVAILABLE":
      return "The backing transition service is unavailable.";
    case "GUARDIAN_REJECTED":
      return "The backing transition was rejected by validation.";
    case "TOKEN_NOT_FOUND":
      return "Token not found.";
    case "TOKEN_AMOUNT_INVALID":
      return "Invalid token amount.";
    case "CLIENT_INTENT_MISMATCH":
      return "The transaction did not match what you reviewed.";
    default:
      return "An unexpected error occurred.";
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const maxBytes = 1_000_000;
    const reader = req.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("REQUEST_TOO_LARGE", "request body exceeds 1 MB");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof AppError) throw e;
    return {};
  }
}

export function strField(body: Record<string, unknown>, key: string, fallback = ""): string {
  const v = body[key];
  return typeof v === "string" ? v : fallback;
}

export function bigintField(body: Record<string, unknown>, key: string, fallback = 0n): bigint {
  const v = body[key];
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "bigint") return v;
  return fallback;
}
