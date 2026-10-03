"use client";

import { useEffect, useState } from "react";
import { crcIndexedRefresh } from "./crc-indexed-refresh";

export function useCrcRead<T>(url: string, fallbackError: string) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string }>({ url, data: null, error: "" });
  useEffect(() => {
    setState({ url, data: null, error: "" });
    return crcIndexedRefresh.subscribe(async (signal) => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error?.message ?? fallbackError);
        if (!signal.aborted) setState({ url, data: body.data as T, error: "" });
      } catch (cause) {
        if (!signal.aborted) setState((previous) => ({ ...previous, error: cause instanceof Error ? cause.message : fallbackError }));
        throw cause;
      }
    }, (cause) => {
      setState((previous) => previous.data ? previous : ({ ...previous, error: cause instanceof Error ? cause.message : fallbackError }));
    });
  }, [url, fallbackError]);
  return state.url === url ? state : { data: null, error: "" };
}
