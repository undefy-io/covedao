import { addressToScript } from "@/lib/address";
import { EsploraUtxoProvider } from "@crclaunch/bitcoin";
import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The spendable BTC behind an address.
 *
 * Cove resolves these itself rather than asking the wallet. A wallet's idea of
 * your unspent outputs comes from whatever indexer it happens to use, and
 * disagreeing with the node that will actually validate the transaction is how
 * a build fails for reasons the user cannot see. The server re-resolves every
 * outpoint against Core at build time regardless, so this list is a
 * convenience, never an authority.
 *
 * Token carriers are excluded: they are exactly 1,000 sats and hold someone's
 * tokens. Spending one as fee change would destroy the tokens riding on it.
 */
const TOKEN_CARRIER_SATS = 1_000;

type Unspent = { txid: string; vout: number; amount: number };
type RpcCaller = { call<T>(m: string, p: unknown[]): Promise<T> };

/**
 * Bitcoin Core runs one `scantxoutset` at a time and refuses a second with
 * "Scan already in progress". Pages refresh on every block, so two lookups
 * overlap easily: queue this process's scans, and retry briefly when another
 * client holds the scanner.
 */
let scanQueue: Promise<unknown> = Promise.resolve();
function scanAddress(rpc: RpcCaller, address: string): Promise<Unspent[]> {
  const run = async (): Promise<Unspent[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await rpc.call<{ unspents?: Unspent[] }>("scantxoutset", ["start", [{ desc: `addr(${address})` }]]);
        return res.unspents ?? [];
      } catch (e) {
        if (attempt >= 40 || !/scan already in progress/i.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  const next = scanQueue.then(run, run);
  scanQueue = next.catch(() => undefined);
  return next;
}

export async function GET(req: Request) {
  try {
    const limited = checkRateLimit(req, "read-utxos");
    if (limited) return limited;

    const address = new URL(req.url).searchParams.get("address")?.trim();
    if (!address) return fail("BAD_REQUEST", "address is required", 400);
    // Checksum and network first, so a typo or a wrong-network address reads
    // as exactly that instead of an internal error from the index.
    addressToScript(address, getV3Services().config.network);

    const { provider, config } = getV3Services();

    if (config.network === "regtest") {
      // A regtest chain is small enough to scan outright, and there is no
      // Esplora for it.
      const unspents = await scanAddress(provider as unknown as RpcCaller, address);
      const utxos = unspents
        .filter((u) => Math.round(u.amount * 1e8) > TOKEN_CARRIER_SATS)
        .map((u) => ({ txid: u.txid, vout: u.vout, valueSats: String(Math.round(u.amount * 1e8)), confirmations: 1 }));
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
    const height = await provider.getBestHeight();
    const found = await new EsploraUtxoProvider(esplora, config.network).getUtxos(address, height);
    const utxos = found
      .filter((u) => u.valueSats > BigInt(TOKEN_CARRIER_SATS))
      .map((u) => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats.toString(), confirmations: u.confirmations }));
    return ok({ address, utxos, source: "esplora" });
  } catch (e) {
    return handleError(e);
  }
}
