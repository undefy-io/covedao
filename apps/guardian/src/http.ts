import { createServer, type ServerResponse } from "node:http";
import type { GuardianTransport } from "@crclaunch/cove-guardian/v3";
import { safeEqual, FixedWindowRateLimiter, readJsonWithLimit } from "./auth.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createGuardianHttpServer(config: { transport: GuardianTransport; authToken: string }) {
  if (!config.authToken) throw new Error("Guardian HTTP authentication is required");
  const limiter = new FixedWindowRateLimiter();
  return createServer(async (req, res) => {
    try {
      const url = (req.url ?? "/").split("?")[0]!;
      if (!safeEqual(req.headers.authorization ?? "", `Bearer ${config.authToken}`)) return json(res, 401, { error: "unauthorized" });
      if (!limiter.allow(req.socket.remoteAddress ?? "unknown")) return json(res, 429, { error: "rate limited" });
      if (req.method === "GET" && url === "/health") return json(res, 200, await config.transport.health());
      if (req.method === "POST" && url === "/sign") {
        const body = await readJsonWithLimit(req, 1_000_000);
        return json(res, 200, await config.transport.sign(body as never));
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      console.error("guardian request failed:", error instanceof Error ? error.message : "unavailable");
      return json(res, 500, { error: "internal error" });
    }
  });
}
