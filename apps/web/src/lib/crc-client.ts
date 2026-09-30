export type CrcWalletBalance = { assetId: string; ticker: string; atoms: string };

export function parseCrcTokenQuantity(value: string): string {
  if (!/^[1-9]\d{0,7}$/.test(value)) throw new Error("Enter a whole token amount");
  const tokens = BigInt(value);
  if (tokens % 1_000n !== 0n || tokens > 21_000_000n) {
    throw new Error("Use 1,000-token lots up to 21,000,000 tokens");
  }
  return (tokens * 100_000_000n).toString();
}

export async function fetchAllCrcWalletBalances(
  address: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CrcWalletBalance[]> {
  const balances: CrcWalletBalance[] = [];
  const seen = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const response = await fetcher(`/api/crc/v1/wallet/${encodeURIComponent(address)}/balances?${query}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "Could not load Cove balances");
    balances.push(...(body.data.balances as CrcWalletBalance[]));
    const next = body.data.nextCursor as string | null;
    if (!next) return balances;
    if (seen.has(next)) throw new Error("Cove balance API returned a repeated cursor");
    seen.add(next);
    before = next;
  }
  throw new Error("Too many Cove balance pages to display");
}
