/** One read at a time; background tabs stop requesting indexed state. */
export function startCrcPolling(read: (signal: AbortSignal) => Promise<void>, pollMs = 5_000): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  async function refresh() {
    if (controller.signal.aborted || pending) return;
    clearTimeout(timer);
    if (document.visibilityState === "hidden") return;
    pending = true;
    try {
      await read(controller.signal);
    } catch {
      // The reader owns error presentation; retry on the next interval.
    } finally {
      pending = false;
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), pollMs);
    }
  }
  const resume = () => { void refresh(); };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  void refresh();
  return () => {
    controller.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("focus", resume);
  };
}
