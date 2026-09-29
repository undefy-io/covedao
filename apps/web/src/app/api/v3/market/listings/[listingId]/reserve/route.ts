import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { resolveFundingUtxos } from "@crclaunch/cove-app";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "reserve");
    if (limited) return limited;
    const { app, provider } = assertV3Enabled();
    const { listingId } = await params;
    const body = await readJson(req);
    const buyerTokenScript = strField(body, "buyerTokenScript");
    const buyerChangeScript = strField(body, "buyerChangeScript");
    const reserveNonce = strField(body, "nonceHex");
    const signatureB64 = strField(body, "signatureB64");
    await rpcOperation(() => app.preflightReserveListing({ listingId, buyerTokenScript, reserveNonce, signatureB64 }));
    const candidates = (body.funding ?? body.buyerFundInputs ?? []) as { txid: string; vout: number }[];
    const resolved = await resolveFundingUtxos(provider, candidates);
    const fillId = await rpcOperation(() => app.reserveListing({
      listingId,
      buyerTokenScript,
      buyerChangeScript,
      buyerFundInputs: resolved.map((f) => ({ txid: f.txid, vout: f.vout, script: f.script.toString("hex"), valueSats: f.valueSats })),
      buyerFundPublicKey: strField(body, "buyerFundPublicKey") || undefined,
      reserveNonce,
      signatureB64,
    }));
    return ok({ fillId });
  } catch (e) {
    return handleError(e);
  }
}
