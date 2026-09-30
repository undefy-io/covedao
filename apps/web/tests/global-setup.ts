import { fund, mine, rpc, IDENTITIES } from "./v3-rpc";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";

/**
 * E2E global setup: mine 101 blocks into the test wallet (coinbase maturity),
 * fund deterministic Alice/Bob/Carol regtest wallets with real BTC, confirm the
 * funding, then wait for the V3 worker to catch up (HEALTHY) before tests run.
 * Token creation happens through real Cove transactions — never seeded rows.
 */
export default async function globalSetup() {
  await mine(101);
  await fund(IDENTITIES.alice.address, 5);
  await fund(IDENTITIES.bob.address, 5);
  // Carol mints out a whole curve: about ten BTC of curve price plus fees.
  await fund(IDENTITIES.carol.address, 15);
  await mine(1);
  // Wait for the worker to index everything. Compare against Core's own height:
  // the status health flag can still describe the chain before the blocks
  // mined above, and a trade started while the indexer lags is refused.
  const target = BigInt(await rpc<number>("getblockcount", []));
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(`${BASE}/api/v3/status`);
      const j = (await r.json()) as { ok?: boolean; data?: { indexer?: { indexedHeight?: string } } };
      if (j.ok && j.data?.indexer?.indexedHeight && BigInt(j.data.indexer.indexedHeight) >= target) return;
    } catch {
      // web app may still be starting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("indexer did not become HEALTHY after global setup");
}
