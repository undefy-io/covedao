import Link from "next/link";

export default function CrcMarketPage() {
  return <main className="mx-auto max-w-2xl space-y-5 py-10">
    <p className="eyebrow">Cove CRC-20</p>
    <h1 className="text-2xl text-bone">Marketplace</h1>
    <p className="text-sm leading-relaxed text-bone-dim">
      Peer to peer token sales are paused while v2 token settlement is being tested.
      You can still use the Cove bonding curve to buy and sell Cove tokens.
    </p>
    <Link href="/" className="btn-ghost inline-block">Browse tokens</Link>
  </main>;
}
