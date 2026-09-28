export type PortfolioPage = {
  walletScript: string;
  holdings: { tokenId: string; amountAtoms: string; utxoCount: number }[];
  tokenUtxos: { txid: string; vout: number; tokenId: string; amountAtoms: string; scriptPubKey: string }[];
  listings: Record<string, unknown>[];
  fills: Record<string, unknown>[];
  pagination?: { limit: number; offset: number; hasMore: Record<string, boolean> };
};

/** Fetch every bounded page before using balances or selecting token inputs. */
export async function fetchPortfolio(address: string, opts: { onlyTokenUtxos?: boolean } = {}): Promise<PortfolioPage> {
  let result: PortfolioPage | undefined;
  const keys = ["holdings", "tokenUtxos", "listings", "fills"] as const;
  const seen = Object.fromEntries(keys.map((key) => [key, new Set<string>()])) as Record<typeof keys[number], Set<string>>;
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`/api/v3/wallet/${encodeURIComponent(address)}/portfolio?limit=500&offset=${page * 500}`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "Wallet portfolio is unavailable");
    const data = body.data as PortfolioPage;
    if (!result) result = { ...data, holdings: [], tokenUtxos: [], listings: [], fills: [] };
    for (const key of keys) {
      for (const record of data[key]) {
        const row = record as unknown as Record<string, unknown>;
        const identity = key === "tokenUtxos" ? `${row.txid}:${row.vout}` : String(row[key === "holdings" ? "tokenId" : key === "listings" ? "listingId" : "id"]);
        if (seen[key].has(identity)) continue;
        seen[key].add(identity);
        (result[key] as unknown[]).push(record);
      }
    }
    const hasMore = opts.onlyTokenUtxos ? data.pagination?.hasMore.tokenUtxos : Object.values(data.pagination?.hasMore ?? {}).some(Boolean);
    if (!hasMore) { delete result.pagination; return result; }
  }
  throw new Error("Wallet has too many records to load safely");
}
