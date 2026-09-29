import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, bigintField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ fillId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "build-fill");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const { fillId } = await params;
    const body = await readJson(req);
    const rate = bigintField(body, "feeRateSatPerVb", 0n);
    const explicit = bigintField(body, "minerFeeSats", 0n);
    const psbtBase64 = await rpcOperation(() => app.buildFillPsbt(fillId, {
      feeRateSatPerVb: rate > 0n ? rate : undefined,
      minerFeeSats: rate > 0n || explicit === 0n ? undefined : explicit,
    }));
    // §M3: return a client-verifiable intent so the buyer can re-derive the P2P
    // outputs before signing (the digest alone is server-supplied and circular).
    const fill = (await rpcOperation(() => app.getFill(fillId)))[0];
    const intent = fill
      ? {
          operation: "P2P_BUY",
          tokenId: fill.tokenId,
          tokenAmountAtoms: fill.amountAtoms.toString(),
          grossSats: fill.totalPriceSats.toString(),
          protocolFeeSats: fill.marketFeeSats.toString(),
          minerFeeSats: fill.minerFeeSats.toString(),
          netSats: null,
          walletScript: fill.buyerChangeScript,
          ordinalsScript: fill.buyerTokenScript,
          stateHash: null,
          unsignedTxDigest: fill.unsignedTxDigest ?? "",
        }
      : null;
    return ok({ fillId, psbtBase64, intent });
  } catch (e) {
    return handleError(e);
  }
}
