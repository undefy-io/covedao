import Link from "next/link";
import { CrcMarketBuyer } from "@/components/CrcMarketBuyer";
import { CrcMarketSeller } from "@/components/CrcMarketSeller";

export default function CrcMarketPage() {
  return <div className="space-y-px">
    <section className="panel px-6 py-8 sm:px-10">
      <p className="eyebrow">Cove CRC-20 marketplace</p>
      <h1 className="mt-3 text-4xl text-bone">Market</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone-dim">Browse holder asks across Cove tokens. A sale broadcasts after both wallets sign the same transaction.</p>
    </section>
    <section className="panel px-6 py-8 sm:px-10">
    <CrcMarketBuyer />
    </section>
    <section className="panel space-y-5 px-6 py-8 sm:px-10">
    <CrcMarketSeller />
    <Link href="/" className="text-sm text-signal hover:underline">Browse tokens →</Link>
    </section>
  </div>;
}
