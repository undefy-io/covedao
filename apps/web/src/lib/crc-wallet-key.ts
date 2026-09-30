export function normalizeCrcWalletPublicKey(scriptHex: string, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const normalized = key.toLowerCase();
  if (scriptHex.startsWith("5120") && scriptHex.length === 68) {
    if (/^(02|03)[0-9a-f]{64}$/.test(normalized)) return normalized.slice(2);
    if (/^[0-9a-f]{64}$/.test(normalized)) return normalized;
    throw new Error("invalid Taproot wallet public key");
  }
  if (/^a914[0-9a-f]{40}87$/.test(scriptHex)) {
    if (!/^(02|03)[0-9a-f]{64}$/.test(normalized)) throw new Error("nested SegWit wallet needs a compressed public key");
    return normalized;
  }
  if (!/^(02|03)[0-9a-f]{64}$/.test(normalized) && !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("invalid wallet public key");
  }
  return normalized;
}
