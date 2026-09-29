import { saveWalletFundingSnapshot } from "@crclaunch/db";
import { ok, fail, handleError, readJson, strField } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { regtestScans, type ScanRpcCaller } from "@/lib/regtest-scan";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { signPsbtWithKey, signBip322WithKey } from "@crclaunch/wallets/e2e";

export const dynamic = "force-dynamic";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

/**
 * Local development wallet — regtest ONLY.
 *
 * There is no browser wallet adapter yet, so without this there is no way to
 * click through the product by hand: `WalletProvider` reads
 * `window.__COVE_TEST_WALLET__` and nothing else, and the only thing that ever
 * set it was the Playwright harness.
 *
 * This signs with the deterministic regtest fixture keys (0x46/0x47/0x48
 * repeated) that the E2E suite already funds. Those keys are PUBLIC and in the
 * repository. They must never hold value.
 *
 * Three independent conditions must all hold or every request is refused:
 *   1. NODE_ENV is not "production"
 *   2. the configured Cove network is regtest
 *   3. COVE_DEV_WALLET=true is set in the environment
 *
 * The route is therefore inert in any real deployment even if it is shipped.
 */

/** The deterministic identities the E2E global setup funds with 5 BTC each. */
const IDENTITIES: Record<string, string> = {
  alice: "46".repeat(32),
  bob: "47".repeat(32),
  carol: "48".repeat(32),
};

function assertDevWalletAllowed(): { ok: true } | { ok: false; reason: string } {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, reason: "dev wallet is disabled in production builds" };
  }
  if ((process.env.COVE_DEV_WALLET ?? "").toLowerCase() !== "true") {
    return { ok: false, reason: "dev wallet is off; set COVE_DEV_WALLET=true to enable it" };
  }
  const { config } = getV3Services();
  if (config.network !== "regtest") {
    return { ok: false, reason: `dev wallet is regtest-only; network is ${config.network}` };
  }
  return { ok: true };
}

function identity(name: string) {
  const privHex = IDENTITIES[name];
  if (!privHex) throw new Error(`unknown dev identity "${name}"`);
  const key = ECPair.fromPrivateKey(Buffer.from(privHex, "hex"), {
    network: bitcoin.networks.regtest,
  });
  const payment = bitcoin.payments.p2wpkh({
    pubkey: key.publicKey,
    network: bitcoin.networks.regtest,
  });
  return { privHex, address: payment.address!, script: payment.output!.toString("hex") };
}

/**
 * Plain-BTC UTXOs of fixture identities, in one scan. scantxoutset sees the
 * whole UTXO set; listunspent only sees the node's own wallet, which does not
 * track these identities. Core runs one scan at a time, so never call it in
 * parallel. Token carriers are exactly 1000 sats and must not be spent as fee
 * input.
 */
async function spendableUtxos(
  ids: { address: string; script: string }[],
  signal: AbortSignal,
): Promise<{ txid: string; vout: number; sats: number; script: string }[]> {
  const { provider } = getV3Services();
  const unspents = await regtestScans.scan<{
    txid: string; vout: number; amount: number; scriptPubKey: string;
  }>(provider as unknown as ScanRpcCaller, ids.map((id) => id.address), signal);
  return unspents
    .map((u) => ({ txid: u.txid, vout: u.vout, sats: Math.round(u.amount * 1e8), script: u.scriptPubKey }))
    .filter((u) => u.sats > 1000);
}

export async function GET(req: Request) {
  try {
    const limited = await checkRateLimit(req, "dev-wallet");
    if (limited) return limited;
    const allowed = assertDevWalletAllowed();
    if (!allowed.ok) return fail("DEV_WALLET_DISABLED", allowed.reason, 403);

    const name = new URL(req.url).searchParams.get("identity");
    if (name === null) {
      // Every identity with its spendable BTC, for the wallet picker.
      const ids = Object.keys(IDENTITIES).map((n) => ({ name: n, ...identity(n) }));
      const utxos = await spendableUtxos(ids, req.signal);
      const identities = ids.map((id) => ({
        identity: id.name,
        address: id.address,
        script: id.script,
        balanceSats: utxos.filter((u) => u.script === id.script).reduce((sum, u) => sum + u.sats, 0),
      }));
      return ok({ identities, network: "regtest" });
    }
    if (!IDENTITIES[name]) return fail("UNKNOWN_IDENTITY", `unknown identity "${name}"`, 400);
    const id = identity(name);
    return ok({ identity: name, address: id.address, script: id.script, network: "regtest" });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "dev-wallet");
    if (limited) return limited;
    const allowed = assertDevWalletAllowed();
    if (!allowed.ok) return fail("DEV_WALLET_DISABLED", allowed.reason, 403);

    const body = await readJson(req);
    const name = strField(body, "identity");
    if (!IDENTITIES[name]) return fail("UNKNOWN_IDENTITY", `unknown identity "${name}"`, 400);
    const id = identity(name);
    const action = strField(body, "action");

    if (action === "signPsbt") {
      return ok({ signedPsbtBase64: signPsbtWithKey(strField(body, "psbtBase64"), id.privHex) });
    }
    if (action === "signBip322") {
      return ok({ signatureB64: signBip322WithKey(strField(body, "message"), id.privHex) });
    }
    if (action === "getUtxos") {
      const utxos = (await spendableUtxos([id], req.signal)).map((u) => ({ txid: u.txid, vout: u.vout, valueSats: String(u.sats), confirmations: 1 }));
      const { db, config } = getV3Services();
      await saveWalletFundingSnapshot(db, config.network, id.script, utxos);
      return ok({ utxos });
    }
    return fail("UNKNOWN_ACTION", `unknown action "${action}"`, 400);
  } catch (e) {
    return handleError(e);
  }
}
