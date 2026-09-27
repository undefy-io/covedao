import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createServer, type ServerResponse } from "node:http";
import { buildGuardianService } from "./service.js";
import { resolveGuardianBoot } from "./boot.js";
import type { GuardianTransport } from "@crclaunch/cove-guardian/v3";
import { safeEqual, FixedWindowRateLimiter, readJsonWithLimit } from "./auth.js";

/**
 * Guardian HTTP SERVICE (Phase 8.1 §18-§20). A standalone process — NOT a
 * Next.js route. Only two endpoints: GET /health and POST /sign (MINT/REDEEM).
 * Authenticated with a bearer token; no generic sign endpoint.
 *
 * Environment: see boot.ts. Everything else is committed.
 */

// The repo-root .env for local runs; a deploy sets real env vars and has none.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const MAX_BODY_BYTES = 1_000_000;
/** What Bitcoin Core calls each network in `getblockchaininfo`. */
const CORE_CHAIN = { mainnet: "main", testnet: "test", signet: "signet", regtest: "regtest" } as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const boot = resolveGuardianBoot(process.env);
  const built = buildGuardianService({
    profile: boot.profile,
    releaseId: process.env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    databaseUrl: boot.databaseUrl,
    network: boot.network,
    signingArmed: boot.canaryActive,
    custodyBackend: boot.custodyBackend,
    coreRpc: boot.coreRpc,
    ordUrl: boot.ordUrl,
  });
  // Refuse to start on the wrong chain, or with a key that is not the profile's.
  const chain = (await built.core.getBlockchainInfo()).chain;
  if (chain !== CORE_CHAIN[boot.network]) {
    throw new Error(`COVE_NETWORK is ${boot.network} but the node is on "${chain}"`);
  }
  if (boot.custody !== "unconfigured") {
    const key = (await boot.custodyBackend.xOnlyPubkey()).toString("hex");
    if (key !== built.guardianXOnly.toLowerCase()) {
      throw new Error("the Guardian key is not the profile's guardianXOnly; refusing to start");
    }
  } else if (boot.mainnetGuard) {
    throw new Error("mainnet requires GUARDIAN_KEY_HEX"); // selectCustodyBackend already refuses; belt and braces
  }
  const transport: GuardianTransport = built.transport;
  const limiter = new FixedWindowRateLimiter();

  const server = createServer(async (req, res) => {
    try {
      const url = (req.url ?? "/").split("?")[0]!;
      const auth = req.headers.authorization ?? "";
      if (!safeEqual(auth, `Bearer ${boot.authToken}`)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const ip = (req.socket.remoteAddress ?? "unknown");
      if (!limiter.allow(ip)) {
        return json(res, 429, { error: "rate limited" });
      }

      if (req.method === "GET" && url === "/health") {
        return json(res, 200, await transport.health());
      }
      if (req.method === "POST" && url === "/sign") {
        const body = await readJsonWithLimit(req, MAX_BODY_BYTES);
        return json(res, 200, await transport.sign(body as never));
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      // §C15: never leak internal error details to the client.
      console.error("guardian request failed:", e instanceof Error ? e.message : String(e));
      return json(res, 500, { error: "internal error" });
    }
  });

  // No host: listens on all interfaces, IPv6 included (Railway private networking is IPv6).
  server.listen(boot.port, () => {
    console.log(`Guardian service listening on :${boot.port} (network=${boot.network}, custody=${boot.custody}, profile=${boot.profile.source})`);
  });
}

main().catch((e) => {
  console.error("guardian service failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
