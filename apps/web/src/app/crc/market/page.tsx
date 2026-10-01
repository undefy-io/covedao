import Link from "next/link";
import { CrcMarketBuyer } from "@/components/CrcMarketBuyer";
import { CrcMarketSeller } from "@/components/CrcMarketSeller";

export default function CrcMarketPage() {
  return <div className="space-y-px">
    <section className="panel px-6 py-10 sm:px-10 sm:py-14">
      <p className="eyebrow">Cove CRC-20 · Bitcoin L1</p>
      <h1 className="mt-4 text-display text-bone">Marketplace.</h1>
      <p className="mt-5 max-w-xl text-sm leading-relaxed text-bone-dim">Peer to peer sales require signatures from both wallets.</p>
    </section>
    <section className="panel space-y-5 px-6 py-8 sm:px-10">
    <p className="eyebrow">Open orders</p>
    <CrcMarketBuyer />
    <CrcMarketSeller />
    <Link href="/" className="btn-ghost inline-block">Browse tokens</Link>
    </section>
  </div>;
}
