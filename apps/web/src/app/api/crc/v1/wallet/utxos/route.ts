import { saveWalletFundingSnapshot } from "@crclaunch/db";
import { addressToScript } from "@/lib/address";
import { fail, handleError, ok } from "@/lib/api";
import { getCrcMutationServices } from "@/lib/crc-mutation";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";
import { regtestScans, type ScanRpcCaller } from "@/lib/regtest-scan";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const address = new URL(req.url).searchParams.get("address")?.trim();
    if (!address) return fail("BAD_REQUEST", "address is required", 400);
    const { db, provider, config } = getCrcMutationServices();
    if (config.network !== "regtest") return fail("BROWSER_DISCOVERY_REQUIRED", "Wallet discovery runs directly in the browser. Refresh this page to continue.", 410);
    const walletScript = addressToScript(address, config.network);
    const coins = await regtestScans.scan<{ txid: string; vout: number; amount: number }>(provider as unknown as ScanRpcCaller, [address], req.signal);
    const utxos = coins.map((coin) => ({
      txid: coin.txid, vout: coin.vout, valueSats: String(Math.round(coin.amount * 1e8)), confirmations: 1,
    }));
    await saveWalletFundingSnapshot(db, config.network, walletScript, utxos);
    return ok({ address, utxos, source: "core" });
  } catch (error) {
    return handleError(error);
  }
}
