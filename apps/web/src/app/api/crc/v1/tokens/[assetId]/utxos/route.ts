import { fail, handleError, ok } from "@/lib/api";
import { addressToScript } from "@/lib/address";
import { parseCrcAssetId, readCrcAsset, readCrcCursor, readCrcTokenUtxos } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { db, network } = getCrcReadServices();
    const id = parseCrcAssetId((await params).assetId, network);
    if (!id) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const address = new URL(req.url).searchParams.get("address") ?? "";
    const scriptHex = addressToScript(address, network);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const asset = await readCrcAsset(db, network, id.deployTxid);
    if (!asset) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    if (asset.protocolVersion !== 2) return ok({ assetId: asset.assetId, indexedTip, utxos: [], truncated: false, legacyReadOnly: true });
    const rows = await readCrcTokenUtxos(db, network, id.deployTxid, scriptHex, 101);
    return ok({ assetId: asset.assetId, indexedTip, utxos: rows.slice(0, 100), truncated: rows.length > 100, legacyReadOnly: false });
  } catch (error) {
    return handleError(error);
  }
}
