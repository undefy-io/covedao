import { createStatusRateLimiter, clientIp } from "./rate-limit";
import { fail } from "./api";
import { serverEnv } from "./server-env";

const allowRead = createStatusRateLimiter(() => performance.now(), { total: 60_000, perIp: 1_200, subjects: 10_000 });
const allowWallet = createStatusRateLimiter(() => performance.now(), { total: 6_000, perIp: 60, subjects: 10_000 });

export function checkCrcRateLimit(req: Request, wallet = false): Response | null {
  const ip = clientIp(req, serverEnv.COVE_TRUSTED_CLIENT_IP_HEADER);
  if ((wallet ? allowWallet : allowRead)(ip)) return null;
  const response = fail("RATE_LIMITED", "Too many requests. Please wait and retry.", 429, true);
  response.headers.set("retry-after", "60");
  return response;
}
