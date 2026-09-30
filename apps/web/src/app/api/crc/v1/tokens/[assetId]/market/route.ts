import { fail, handleError, ok } from "@/lib/api";
import { parseCrcAssetId, readCrcAsset, readCrcCursor } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { db, network } = getCrcReadServices();
    const id = parseCrcAssetId((await params).assetId, network);
    if (!id) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const token = await readCrcAsset(db, network, id.deployTxid);
    if (!token) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    return ok({
      assetId: token.assetId,
      indexedTip,
      availability: token.availability,
      mintedAtoms: token.mintedAtoms,
      inventoryAtoms: token.inventoryAtoms,
      circulatingAtoms: token.circulatingAtoms,
      vault: token.vault,
    });
  } catch (error) {
    return handleError(error);
  }
}
