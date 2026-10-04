import { CrcMarketSeller } from "@/components/CrcMarketSeller";
import { CrcMarketBuyer } from "@/components/CrcMarketBuyer";

export function CrcMarketPageContent() {
  return <div className="space-y-px">
    <section className="panel px-6 py-8 sm:px-10">
      <p className="eyebrow">Cove CRC-20 marketplace</p>
      <h1 className="mt-3 text-4xl text-bone">Market</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone-dim">Browse holder asks across Cove tokens. Choose an amount to list, or buy a published offer with your wallet.</p>
    </section>
    <section className="panel px-6 py-8 sm:px-10">
    <CrcMarketBuyer />
    </section>
    <section className="panel px-6 py-8 sm:px-10">
    <CrcMarketSeller />
    </section>
  </div>;
}
