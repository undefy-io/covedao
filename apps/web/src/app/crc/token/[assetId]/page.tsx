import { CrcTokenDetail } from "@/components/CrcTokenDetail";

export default async function CrcTokenPage({ params }: { params: Promise<{ assetId: string }> }) {
  return <CrcTokenDetail assetId={(await params).assetId} />;
}
