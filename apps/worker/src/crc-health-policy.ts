import { createHash } from "node:crypto";

export function crcHealthPath(databaseUrl: string, network: string): string {
  return `/tmp/cove-crc-worker-health-${network}-${createHash("sha256").update(databaseUrl).digest("hex").slice(0, 32)}.json`;
}

/** Readiness of the running worker's latest successful Core/database sync. */
export function crcWorkerHealthy(value: unknown, network: string, now: number, alive: (pid: number) => boolean): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.network === network && row.healthy === true &&
    Number.isSafeInteger(row.pid) && Number(row.pid) > 0 &&
    Number.isSafeInteger(row.pollMs) && Number(row.pollMs) >= 1000 && Number(row.pollMs) <= 60_000 &&
    Number.isSafeInteger(row.observedAt) && Number(row.observedAt) <= now &&
    now - Number(row.observedAt) <= Number(row.pollMs) * 3 && alive(Number(row.pid));
}
