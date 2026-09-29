import { withRpcDeadline } from "@crclaunch/bitcoin";
import { createServer, type ServerResponse } from "node:http";
import type { GuardianTransport } from "@crclaunch/cove-guardian/v3";
import { safeEqual, FixedWindowRateLimiter, readJsonWithLimit } from "./auth.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createGuardianHttpServer(config: { transport: GuardianTransport; authToken: string }) {
  if (!config.authToken) throw new Error("Guardian HTTP authentication is required");
  const limiter = new FixedWindowRateLimiter();
  let signing = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = (req.url ?? "/").split("?")[0]!;
      if (!safeEqual(req.headers.authorization ?? "", `Bearer ${config.authToken}`)) return json(res, 401, { error: "unauthorized" });
      if (!limiter.allow(req.socket.remoteAddress ?? "unknown")) return json(res, 429, { error: "rate limited" });
      if (req.method === "GET" && url === "/health") return json(res, 200, await config.transport.health());
      if (req.method === "POST" && url === "/sign") {
        if (signing >= 2) { res.setHeader("retry-after", "2"); return json(res, 503, { error: "signing capacity unavailable" }); }
        signing++;
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Guardian client disconnected"));
        const closed = () => { if (!res.writableFinished) abort(); };
        req.once("aborted", abort);
        res.once("close", closed);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
        try {
          const body = await readJsonWithLimit(req, 1_000_000, signal);
          signal.throwIfAborted();
          const result = await withRpcDeadline(signal, () => config.transport.sign(body as never));
          return json(res, 200, result);
        } finally {
          signing--;
          req.removeListener("aborted", abort);
          res.removeListener("close", closed);
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      console.error("guardian request failed:", error instanceof Error ? error.message : "unavailable");
      return json(res, 500, { error: "internal error" });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  return server;
}
