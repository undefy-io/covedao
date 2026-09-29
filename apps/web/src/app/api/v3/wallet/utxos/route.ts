import { PostgresRpcBudget, providerAccount, saveWalletFundingSnapshot } from "@crclaunch/db";
import { serverEnv } from "@/lib/server-env";
import { sql } from "drizzle-orm";
import { addressToScript } from "@/lib/address";
import { AddressUtxoCache, AddressLookupBusy, type ChainUtxo } from "@crclaunch/bitcoin";
import * as Sentry from "@sentry/nextjs";
import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { regtestScans, type ScanRpcCaller } from "@/lib/regtest-scan";

export const dynamic = "force-dynamic";

/**
 * The spendable BTC behind an address.
 *
 * Cove resolves these itself rather than asking the wallet. A wallet's idea of
 * your unspent outputs comes from whatever indexer it happens to use, and
 * disagreeing with the node that will actually validate the transaction is how
 * a build fails for reasons the user cannot see. Unsigned buy builds use this server-observed snapshot.
 * The Guardian rechecks each funding prevout live before signing.
 *
 * Token carriers are excluded: they are exactly 1,000 sats and hold someone's
 * tokens. Spending one as fee change would destroy the tokens riding on it.
 */
const TOKEN_CARRIER_SATS = 1_000;
const addressCache = new AddressUtxoCache();
async function addressGeneration(): Promise<string> {
  const { db, config } = getV3Services();
  const result =
    await db.execute(sql`select c.block_hash, c.height, c.rebuilding, e.chain_generation::text, e.pending_revision::text,
    (select max(accepted_at) from cove_v3_submissions where network = ${config.network}) as broadcast_at
    from cove_v3_cursor c join cove_observation_epochs e on e.network = c.network where c.network = ${config.network}`);
  return JSON.stringify(result.rows[0] ?? {});
}

type Unspent = { txid: string; vout: number; amount: number };
export async function GET(req: Request) {
  try {
    const limited = await checkRateLimit(req, "read-utxos");
    if (limited) return limited;

    const address = new URL(req.url).searchParams.get("address")?.trim();
    if (!address) return fail("BAD_REQUEST", "address is required", 400);
    // Checksum and network first, so a typo or a wrong-network address reads
    // as exactly that instead of an internal error from the index.
    const walletScript = addressToScript(address, getV3Services().config.network);

    const { provider, config, db } = getV3Services();

    if (config.network === "regtest") {
      // A regtest chain is small enough to scan outright, and there is no
      // Esplora for it.
      const unspents = await regtestScans.scan<Unspent>(provider as unknown as ScanRpcCaller, [address], req.signal);
      const utxos = unspents
        .filter((u) => Math.round(u.amount * 1e8) > TOKEN_CARRIER_SATS)
        .map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueSats: String(Math.round(u.amount * 1e8)),
          confirmations: 1,
        }));
      await saveWalletFundingSnapshot(db, config.network, walletScript, utxos);
      return ok({ address, utxos, source: "core" });
    }

    // Committed per network (@crclaunch/config); regtest has none.
    const esplora = config.settings.esploraUrl;
    if (!esplora) {
      return fail(
        "ESPLORA_NOT_CONFIGURED",
        `No address index is configured for ${config.network}, so the wallet's spendable coins cannot be listed.`,
        503,
      );
    }
    let found: ChainUtxo[];
    try {
      found = await addressCache.read(
        esplora,
        config.network,
        address,
        await addressGeneration(),
        addressGeneration,
        new PostgresRpcBudget(
          db,
          providerAccount({ url: esplora }),
          "public",
          serverEnv.COVE_RPC_REQUESTS_PER_SECOND,
        ),
      );
    } catch (e) {
      if (
        e instanceof AddressLookupBusy ||
        (e instanceof Error && e.name === "CapacityUnavailable")
      )
        return fail("ADDRESS_INDEX_BUSY", "Please retry shortly.", 503, true);
      console.error("[wallet/utxos] address index unavailable:", e);
      Sentry.captureException(e);
      return fail(
        "ADDRESS_INDEX_UNAVAILABLE",
        "The wallet address index is unavailable. Please try again shortly.",
        503,
        true,
      );
    }
    const utxos = found
      .filter((u) => u.valueSats > BigInt(TOKEN_CARRIER_SATS))
      .map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueSats: u.valueSats.toString(),
        confirmations: u.confirmations,
      }));
    await saveWalletFundingSnapshot(db, config.network, walletScript, utxos);
    return ok({ address, utxos, source: "esplora" });
  } catch (e) {
    return handleError(e);
  }
}
