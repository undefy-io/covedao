export function crcActivityLabel(row: { operation: string | null; tradeSide: string | null; valid: boolean }): string {
  if (row.valid && row.operation === "transfer") {
    if (row.tradeSide === "sell") return "SELL";
    if (row.tradeSide === "buy") return "BUY";
  }
  return row.operation?.toUpperCase() ?? "—";
}
