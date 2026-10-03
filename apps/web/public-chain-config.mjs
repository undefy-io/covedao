/** Only explicit credential-free public endpoints may enter a browser bundle. */
export function publicChainUrl(value) {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Public chain URL must be HTTP(S) without credentials, query or fragment');
  return parsed.toString().replace(/\/+$/, '');
}
