import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Guardian service auth + request hardening (P0-1). The Guardian must refuse to
 * boot without a non-empty bearer token, compare the token in constant time,
 * rate-limit requests, and bound the request body size.
 */

/** Refuse to boot unless a non-empty bearer token is configured. */
export function requireAuthToken(token: string | undefined): string {
  if (!token || token.length === 0) {
    throw new Error("GUARDIAN_AUTH_TOKEN is required (refusing to boot without a non-empty token)");
  }
  return token;
}

/** Constant-time string comparison (SHA-256 both, then timingSafeEqual). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Fixed-window per-key rate limiter. */
export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  constructor(windowMs = 60_000, maxRequests = 120) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    b.count += 1;
    return b.count <= this.maxRequests;
  }
}

/** Read the JSON body, rejecting it if it exceeds maxBytes. */
export function readJsonWithLimit(req: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", fail);
      req.removeListener("aborted", aborted);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(signal?.reason);
    const aborted = () => fail(new Error("request aborted"));
    const data = (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        fail(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    };
    const end = () => {
      cleanup();
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    };
    req.on("data", data);
    req.on("end", end);
    req.on("error", fail);
    req.once("aborted", aborted);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
