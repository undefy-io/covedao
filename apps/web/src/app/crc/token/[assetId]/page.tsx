import { redirect } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ assetId: string }> }) {
  redirect(`/token/${encodeURIComponent(decodeURIComponent((await params).assetId))}`);
}
