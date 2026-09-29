"use client";

import { useSyncExternalStore } from "react";
import {
  ChainStatusStore,
  indexedRefreshKey,
  pendingRefreshKey,
  type ChainStatus,
  type StatusSnapshot,
} from "./chain-status-store";
export type { ChainStatus } from "./chain-status-store";

const empty: StatusSnapshot = {
  status: null,
  available: false,
  pendingAvailable: false,
  localRevision: 0,
  resumeRevision: 0,
};
const store = new ChainStatusStore(
  async (signal) => {
    const response = await fetch("/api/v3/status", { signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("Status unavailable");
    return body.data as ChainStatus;
  },
  () => typeof document !== "undefined" && document.visibilityState !== "hidden",
);
let subscriptions = 0;
const resume = () => {
  if (document.visibilityState !== "hidden") store.resume();
  else store.pause();
};
function subscribe(listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  if (++subscriptions === 1) {
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
  }
  return () => {
    unsubscribe();
    if (--subscriptions === 0) {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    }
  };
}
export function useStatusSnapshot(): StatusSnapshot {
  return useSyncExternalStore(subscribe, store.getSnapshot, () => empty);
}
export function useChainStatus(): ChainStatus | null {
  const snapshot = useStatusSnapshot();
  if (!snapshot.status || snapshot.available) return snapshot.status;
  return {
    ...snapshot.status,
    core: { ...snapshot.status.core, reachable: false, stale: true },
    indexer: { ...snapshot.status.indexer, health: "STALE" },
  };
}
export function useIndexedBlock(): string {
  return indexedRefreshKey(useStatusSnapshot());
}
export function usePendingRevision(): string {
  return pendingRefreshKey(useStatusSnapshot());
}
export function useMarketRevision(): string {
  const snapshot = useStatusSnapshot();
  return `${indexedRefreshKey(snapshot)}:${snapshot.status?.observations?.marketRevision ?? "0"}:${snapshot.resumeRevision}:${snapshot.localRevision}`;
}
export function notifyLocalBroadcast(): void {
  store.broadcast();
}

export function useTradeRevision(): string {
  const snapshot = useStatusSnapshot();
  return `${indexedRefreshKey(snapshot)}:${snapshot.status?.observations?.tradeRevision ?? "0"}`;
}
