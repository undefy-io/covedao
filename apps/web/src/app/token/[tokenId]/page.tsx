import { CrcTokenDetail } from "@/components/CrcTokenDetail";
import LegacyTokenPage from "@/components/legacy-pages/TokenPage";
import { protocolSurface } from "@/lib/protocol-surface";

export default async function TokenPage({ params }: { params: Promise<{ tokenId: string }> }) {
  if (protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only") {
    return <CrcTokenDetail assetId={decodeURIComponent((await params).tokenId)} />;
  }
  return <LegacyTokenPage />;
}
