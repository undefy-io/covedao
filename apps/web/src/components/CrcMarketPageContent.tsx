import Link from "next/link";
import { CrcMarketBuyer } from "@/components/CrcMarketBuyer";

export function CrcMarketPageContent() {
  return <div className="space-y-px">
    <section className="panel px-6 py-8 sm:px-10">
      <p className="eyebrow">Cove CRC-20 marketplace</p>
      <h1 className="mt-3 text-4xl text-bone">Market</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone-dim">Browse holder asks across Cove tokens. A sale broadcasts after both wallets sign the same transaction.</p>
    </section>
    <section className="panel px-6 py-8 sm:px-10">
    <CrcMarketBuyer />
    </section>
    <section className="panel px-6 py-8 sm:px-10">
    <p className="text-sm text-bone-dim">Want to sell a token output? <Link href="/wallet" className="text-signal hover:underline">Open your wallet →</Link></p>
    </section>
  </div>;
}
