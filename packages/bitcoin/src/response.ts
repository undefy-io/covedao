export async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    rejectAbort(signal.reason);
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("response body too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
