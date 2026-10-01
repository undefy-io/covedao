import Link from "next/link";
import { CrcMarketBuyer } from "@/components/CrcMarketBuyer";
import { CrcMarketSeller } from "@/components/CrcMarketSeller";

export default function CrcMarketPage() {
  return <main className="mx-auto max-w-3xl space-y-5 py-10">
    <p className="eyebrow">Cove CRC-20</p>
    <h1 className="text-2xl text-bone">Marketplace</h1>
    <p className="text-sm leading-relaxed text-bone-dim">
      Peer to peer sales require signatures from both wallets.
    </p>
    <CrcMarketBuyer />
    <CrcMarketSeller />
    <Link href="/" className="btn-ghost inline-block">Browse tokens</Link>
  </main>;
}
