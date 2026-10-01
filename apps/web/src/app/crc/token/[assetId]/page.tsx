import React from "react";
import { CrcTokenDetail } from "@/components/CrcTokenDetail";

export default async function CrcTokenPage({ params }: { params: Promise<{ assetId: string }> }) {
  return <CrcTokenDetail assetId={decodeURIComponent((await params).assetId)} />;
}
