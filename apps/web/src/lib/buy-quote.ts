type QuoteResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error?: { code?: string; message?: string; detail?: string; retryable?: boolean } };

function wait(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchBuyQuote<T>(
  tokenId: string,
  amountAtoms: string,
  signal: AbortSignal,
  /** "plan" prices a mint over the per-mint limit as several mints. */
  endpoint: "quote" | "plan" = "quote",
): Promise<QuoteResponse<T>> {
  const retryDelays = [1_000, 2_000, 4_000, 8_000, 8_000];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(`/api/v3/backing/buy/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenId, amountAtoms }),
      signal,
    });
    const result = await response.json() as QuoteResponse<T>;
    signal.throwIfAborted();
    if (result.ok || response.status !== 503 || result.error?.retryable !== true || attempt >= retryDelays.length)
      return result;
    await wait(retryDelays[attempt]!, signal);
  }
}
