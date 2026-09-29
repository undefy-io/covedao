import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField, bigintField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A wallet is two addresses. Payments holds BTC; ordinals holds token
 * carriers. A wallet with only one address may send just `walletScript`, and
 * both roles resolve to it.
 */
function walletFields(body: Record<string, unknown>) {
  return {
    walletScript: strField(body, "walletScript"),
    walletPublicKey: strField(body, "walletPublicKey") || undefined,
    ordinalsScript: strField(body, "ordinalsScript") || undefined,
    ordinalsPublicKey: strField(body, "ordinalsPublicKey") || undefined,
  };
}

/**
 * The client picks a fee RATE; the server sizes the fee to the transaction it
 * builds. An explicit `minerFeeSats` is still honoured for callers that size
 * their own transaction, but there is no longer a flat default: omitting both
 * makes the server use the live Standard rate.
 */
function feeFields(body: Record<string, unknown>) {
  const rate = bigintField(body, "feeRateSatPerVb", 0n);
  const explicit = bigintField(body, "minerFeeSats", 0n);
  return {
    feeRateSatPerVb: rate > 0n ? rate : undefined,
    minerFeeSats: rate > 0n || explicit === 0n ? undefined : explicit,
  };
}

export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "build-redeem");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const body = await readJson(req);
    const result = await rpcOperation(() => app.buildRedeem({
      tokenId: strField(body, "tokenId"),
      amountAtoms: bigintField(body, "amountAtoms", 0n),
      ...walletFields(body),
      walletAddress: strField(body, "walletAddress") || null,
      ...feeFields(body),
      // Optional: BTC utxos to pay the miner fee. Without them the fee can only
      // come from token carriers, which caps it at ~1,000 sats each.
      funding: Array.isArray(body.funding) ? (body.funding as { txid: string; vout: number }[]) : undefined,
      idempotencyKey: strField(body, "idempotencyKey") || `redeem-${Date.now()}`,
    }));
    return ok(result);
  } catch (e) {
    return handleError(e);
  }
}
