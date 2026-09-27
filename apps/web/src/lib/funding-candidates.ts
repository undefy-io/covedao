export interface WalletFundingCoin {
  txid: string;
  vout: number;
  valueSats?: string;
  confirmations?: number;
}

const MAX_FUNDING_INPUTS = 64;

export function selectFundingCandidates(coins: WalletFundingCoin[], confirmedOnly = false): { txid: string; vout: number }[] {
  return coins
    .filter((coin) => !confirmedOnly || coin.confirmations === undefined || coin.confirmations > 0)
    .sort((a, b) => {
      const aValue = a.valueSats === undefined ? 0n : BigInt(a.valueSats);
      const bValue = b.valueSats === undefined ? 0n : BigInt(b.valueSats);
      if (aValue !== bValue) return aValue > bValue ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    })
    .slice(0, MAX_FUNDING_INPUTS)
    .map(({ txid, vout }) => ({ txid, vout }));
}
