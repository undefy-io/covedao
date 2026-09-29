import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export interface CachedWalletCoin {
  txid: string;
  vout: number;
  valueSats: string;
  confirmations: number;
}

export async function saveWalletFundingSnapshot(
  db: Database,
  network: string,
  walletScript: string,
  coins: CachedWalletCoin[],
): Promise<void> {
  const ordered = [...coins]
    .sort((a, b) => {
      const confirmed = Number(b.confirmations > 0) - Number(a.confirmations > 0);
      if (confirmed) return confirmed;
      const av = BigInt(a.valueSats),
        bv = BigInt(b.valueSats);
      if (av !== bv) return av > bv ? -1 : 1;
      return a.txid.localeCompare(b.txid) || a.vout - b.vout;
    })
    .slice(0, 256);
  await db.execute(sql`insert into cove_wallet_funding (network, wallet_script, payload)
    values (${network}, ${walletScript}, ${JSON.stringify(ordered)}::jsonb)
    on conflict (network, wallet_script) do update set payload = excluded.payload, observed_at = clock_timestamp()`);
}

export async function walletFundingSnapshot(db: Database, network: string, walletScript: string) {
  const result = await db.execute(sql`select payload from cove_wallet_funding
    where network = ${network} and wallet_script = ${walletScript}`);
  return result.rows[0]?.payload as CachedWalletCoin[] | undefined;
}
