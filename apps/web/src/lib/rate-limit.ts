import { isIP } from "node:net";
import { FixedWindowRateLimiter } from "@crclaunch/cove-app";
import { sharedQuota } from "@crclaunch/db";
import { fail } from "./api";
import { getV3Services } from "./v3-server";
import { serverEnv } from "./server-env";

export function clientIp(req: Request, trustedHeader = "none"): string {
  if (trustedHeader === "none") return "local";
  const value = req.headers.get(trustedHeader)?.trim() ?? "";
  return isIP(value) ? value : "local";
}

export function createRateLimiter(): FixedWindowRateLimiter { return new FixedWindowRateLimiter(); }

export function createStatusRateLimiter(
  now: () => number = () => performance.now(),
  limits = { total: 120_000, perIp: 1_200, subjects: 10_000 },
) {
  let window = -1, total = 0;
  const counts = new Map<string, number>();
  return (ip: string): boolean => {
    const current = Math.floor(now() / 60_000);
    if (current !== window) {
      window = current;
      total = 0;
      counts.clear();
    }
    if (total >= limits.total) return false;
    if (ip !== "local") {
      const count = counts.get(ip) ?? 0;
      if (count >= limits.perIp || (!counts.has(ip) && counts.size >= limits.subjects)) return false;
      counts.set(ip, count + 1);
    }
    total++;
    return true;
  };
}

const allowStatus = createStatusRateLimiter();
const allowPublicRead = createStatusRateLimiter(() => performance.now(), {
  total: 20_000,
  perIp: 1_200,
  subjects: 10_000,
});

let checking = 0;

export async function checkRateLimit(req: Request, operation: string, limiter?: FixedWindowRateLimiter): Promise<Response | null> {
  const denied = () => {
    const response = fail("RATE_LIMITED", "Too many requests. Please wait and retry.", 429, true);
    response.headers.set("retry-after", "60");
    return response;
  };
  if (limiter) return limiter.check({ scope: "ip", subject: clientIp(req), operation }, { limit: 120, windowMs: 60_000 }).allowed ? null : denied();
  if (operation === "read-status")
    return allowStatus(clientIp(req, serverEnv.COVE_TRUSTED_CLIENT_IP_HEADER)) ? null : denied();
  const expensive = /^(build-|prepare-|create-|submit-|finalize-|buyer-|reserve|cancel-)/.test(operation);
  const group = expensive ? "mutation" : operation === "read-utxos" ? "address" : "read";
  if (group === "read")
    return allowPublicRead(clientIp(req, serverEnv.COVE_TRUSTED_CLIENT_IP_HEADER)) ? null : denied();
  const unavailable = () => {
    const response = fail("CAPACITY_UNAVAILABLE", "Please retry shortly.", 503, true);
    response.headers.set("retry-after", "2");
    return response;
  };
  if (checking >= 64) return unavailable();
  const { db, config } = getV3Services();
  const globalLimit = expensive ? 60 : group === "address" ? 240 : 20_000;
  checking++;
  try {
    if (!await sharedQuota(db, `${config.network}:global:${group}`, globalLimit, 60_000)) return denied();
    const ip = clientIp(req, serverEnv.COVE_TRUSTED_CLIENT_IP_HEADER);
    if (ip !== "local" && !await sharedQuota(db, `${config.network}:ip:${ip}:${group}`, expensive ? 20 : group === "address" ? 60 : 1_200, 60_000)) return denied();
    return null;
  } catch { return unavailable(); }
  finally { checking--; }
}
