import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createGuardianHttpServer } from "./http.js";
import { buildGuardianService } from "./service.js";
import { resolveGuardianBoot } from "./boot.js";

/**
 * Guardian HTTP SERVICE (Phase 8.1 §18-§20). A standalone process — NOT a
 * Next.js route. Only two endpoints: GET /health and POST /sign (MINT/REDEEM).
 * Authenticated with a bearer token; no generic sign endpoint.
 *
 * Environment: see boot.ts. Everything else is committed.
 */

// The repo-root .env for local runs; a deploy sets real env vars and has none.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

/** What Bitcoin Core calls each network in `getblockchaininfo`. */
const CORE_CHAIN = { mainnet: "main", testnet: "test", signet: "signet", regtest: "regtest" } as const;

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
    rpcRequestsPerSecond: boot.rpcRequestsPerSecond,
    rpcBudgetDatabaseUrl: boot.rpcBudgetDatabaseUrl,
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
  const server = createGuardianHttpServer({ transport: built.transport, authToken: boot.authToken });

  // No host: listens on all interfaces, IPv6 included (Railway private networking is IPv6).
  server.listen(boot.port, () => {
    console.log(`Guardian service listening on :${boot.port} (network=${boot.network}, custody=${boot.custody}, profile=${boot.profile.source})`);
  });
}

main().catch((e) => {
  console.error("guardian service failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
