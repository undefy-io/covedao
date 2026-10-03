import { CrcTokenDetail } from "@/components/CrcTokenDetail";

export default async function TokenPage({ params }: { params: Promise<{ tokenId: string }> }) {
  return <CrcTokenDetail assetId={decodeURIComponent((await params).tokenId)} />;
}
