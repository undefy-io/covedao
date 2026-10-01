import { AddressLookupBusy, AddressUtxoCache, type ChainUtxo } from "@crclaunch/bitcoin";
import { PostgresRpcBudget, providerAccount, saveWalletFundingSnapshot } from "@crclaunch/db";
import { addressToScript } from "@/lib/address";
import { fail, handleError, ok } from "@/lib/api";
import { getCrcMutationServices } from "@/lib/crc-mutation";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";
import { regtestScans, type ScanRpcCaller } from "@/lib/regtest-scan";
import { serverEnv } from "@/lib/server-env";

export const dynamic = "force-dynamic";

const cache = new AddressUtxoCache();

export async function GET(req: Request) {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const address = new URL(req.url).searchParams.get("address")?.trim();
    if (!address) return fail("BAD_REQUEST", "address is required", 400);
    const { db, provider, config } = getCrcMutationServices();
    const walletScript = addressToScript(address, config.network);
    if (config.network === "regtest") {
      const coins = await regtestScans.scan<{ txid: string; vout: number; amount: number }>(provider as unknown as ScanRpcCaller, [address], req.signal);
      const utxos = coins.map((coin) => ({
        txid: coin.txid, vout: coin.vout, valueSats: String(Math.round(coin.amount * 1e8)), confirmations: 1,
      }));
      await saveWalletFundingSnapshot(db, config.network, walletScript, utxos);
      return ok({ address, utxos, source: "core" });
    }
    const esplora = config.settings.esploraUrl;
    if (!esplora) return fail("ADDRESS_INDEX_UNAVAILABLE", "Wallet address index is unavailable", 503, true);
    let found: ChainUtxo[];
    try {
      found = await cache.read(
        esplora, config.network, address, "", async () => "",
        new PostgresRpcBudget(db, providerAccount({ url: esplora }), "public", serverEnv.COVE_RPC_REQUESTS_PER_SECOND),
      );
    } catch (error) {
      if (error instanceof AddressLookupBusy) return fail("ADDRESS_INDEX_BUSY", "Please retry shortly", 503, true);
      throw error;
    }
    const utxos = found.map((coin) => ({
      txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats.toString(), confirmations: coin.confirmations,
    }));
    await saveWalletFundingSnapshot(db, config.network, walletScript, utxos);
    return ok({ address, utxos, source: "esplora" });
  } catch (error) {
    return handleError(error);
  }
}
