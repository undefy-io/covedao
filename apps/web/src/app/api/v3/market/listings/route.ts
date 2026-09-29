import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField } from "@/lib/api";
import { getV3Services, assertV3Enabled } from "@/lib/v3-server";
import type { ListingV1 } from "@crclaunch/cove-market";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = await checkRateLimit(req, "read-listings");
    if (limited) return limited;
    const { app } = getV3Services();
    const url = new URL(req.url);
    const tokenId = url.searchParams.get("tokenId") ?? undefined;
    return ok(await rpcOperation(() => app.listListings({ tokenId, limit: 100 })));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "create-listing");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const body = await readJson(req);
    const listing = body.listing as ListingV1;
    const listingId = await rpcOperation(() => app.createListing(
      {
        ...listing,
        sourceAmountAtoms: BigInt(listing.sourceAmountAtoms),
        amountAtoms: BigInt(listing.amountAtoms),
        totalPriceSats: BigInt(listing.totalPriceSats),
        creationHeight: BigInt(listing.creationHeight),
        expiryHeight: BigInt(listing.expiryHeight),
      },
      // The seller's presigned listing PSBT (SIGHASH_SINGLE|ANYONECANPAY).
      strField(body, "presignedPsbtBase64"),
      strField(body, "sellerTokenPublicKey") || undefined,
    ));
    return ok({ listingId });
  } catch (e) {
    return handleError(e);
  }
}
