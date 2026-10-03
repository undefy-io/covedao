import { crcWalletData } from "./crc-wallet-data";
import { crcBrowserData, type CrcBrowserBuild, type CrcRequest } from "./crc-browser-session";
import { readyTransactionId } from "./crc-ready-transaction";

export const CRC_PENDING_CHANGED = "crc-pending-broadcast-changed";
export type PendingCrcBroadcast = {
  network: string; address: string; sessionId: string; endpoint: string;
  psbtBase64: string; signedPsbtBase64: string; createdAt: number;
  receipt?: { network: string; status: "READY" | "BROADCAST"; txid: string; rawTxHex: string; fillId?: string };
};
const MAX_CHARACTERS = 4_000_000;
const inflight = new Map<string, Promise<{txid: string; fillId?: string}>>();
function key(network: string, address: string) { return `crc-pending-v1:${network}:${address}`; }
function storage() {
  if (typeof window === "undefined") throw new Error("Broadcast recovery requires a browser");
  return window.localStorage;
}
export function pendingCrcBroadcasts(network: string, address: string): PendingCrcBroadcast[] {
  const raw = storage().getItem(key(network, address));
  if (!raw) return [];
  if (raw.length > MAX_CHARACTERS) throw new Error("Saved transactions exceed recovery capacity");
  const rows = JSON.parse(raw) as PendingCrcBroadcast[];
  if (!Array.isArray(rows) || rows.length > 10 || rows.some(row => !row || row.network !== network || row.address !== address ||
    typeof row.sessionId !== "string" || row.sessionId.length > 128 || !/^\/api\/crc\/v1\//.test(row.endpoint) ||
    typeof row.psbtBase64 !== "string" || row.psbtBase64.length > 750000 || typeof row.signedPsbtBase64 !== "string" || row.signedPsbtBase64.length > 750000))
    throw new Error("Saved transaction recovery data is invalid");
  return rows;
}
function write(network: string, address: string, rows: PendingCrcBroadcast[]) {
  const serialized = JSON.stringify(rows);
  if (rows.length > 10 || serialized.length > MAX_CHARACTERS) throw new Error("Too many pending transactions. Retry an earlier transaction first.");
  try { storage().setItem(key(network, address), serialized); }
  catch { throw new Error("Allow browser storage to safely save and retry this transaction."); }
  window.dispatchEvent(new Event(CRC_PENDING_CHANGED));
}
export function dismissCrcBroadcast(network: string, address: string, sessionId: string) {
  write(network, address, pendingCrcBroadcasts(network, address).filter(row => row.sessionId !== sessionId));
}
function save(record: PendingCrcBroadcast) {
  const rows = pendingCrcBroadcasts(record.network, record.address).filter(row => row.sessionId !== record.sessionId);
  write(record.network, record.address, [...rows, record]);
}
function verify(record: PendingCrcBroadcast) {
  const receipt = record.receipt;
  if (!receipt || receipt.network !== record.network || !["READY", "BROADCAST"].includes(receipt.status) ||
    readyTransactionId(receipt.rawTxHex, record.psbtBase64) !== receipt.txid || (receipt.fillId !== undefined && receipt.fillId !== record.sessionId))
    throw new Error("Prepared transaction differs from the reviewed transaction");
  return receipt;
}
export async function retryCrcBroadcast(record: PendingCrcBroadcast, request: CrcRequest = fetch): Promise<{txid: string; fillId?: string}> {
  const identity = key(record.network, record.address) + ":" + record.sessionId;
  const pending = inflight.get(identity); if (pending) return pending;
  const run = (async () => {
    const data = crcWalletData(record.network, request);
    if (!data.canBroadcast) throw new Error("Public broadcast is unavailable. Refresh this page and retry.");
    if (!record.receipt) {
      record = {...record, receipt: await crcBrowserData(request, record.endpoint, {
        sessionId: record.sessionId, signedPsbtBase64: record.signedPsbtBase64, broadcast: "client",
      })};
      verify(record); save(record);
    }
    const receipt = verify(record);
    // Save before sending: response loss and reload can never require another signature.
    save(record);
    const txid = await data.broadcast(receipt.rawTxHex, receipt.txid);
    write(record.network, record.address, pendingCrcBroadcasts(record.network, record.address).filter(row => row.sessionId !== record.sessionId));
    return {txid, ...(receipt.fillId === undefined ? {} : {fillId: receipt.fillId})};
  })();
  inflight.set(identity, run);
  try { return await run; } finally { inflight.delete(identity); }
}
export async function submitCrcFromBrowser(
  built: Pick<CrcBrowserBuild, "sessionId" | "psbtBase64">,
  wallet: {network: string; address: string}, endpoint: string, sign: () => Promise<string>, request: CrcRequest = fetch,
): Promise<{txid: string; fillId?: string}> {
  if (wallet.network === "regtest") return crcBrowserData(request, endpoint, {sessionId: built.sessionId, signedPsbtBase64: await sign()});
  if (!crcWalletData(wallet.network, request).canBroadcast) throw new Error("Public broadcast is unavailable. Refresh this page and retry.");
  const rows = pendingCrcBroadcasts(wallet.network, wallet.address);
  const saved = rows.find(row => row.sessionId === built.sessionId);
  if (saved) {
    if (saved.psbtBase64 !== built.psbtBase64 || saved.endpoint !== endpoint) throw new Error("Saved transaction review changed");
    return retryCrcBroadcast(saved, request);
  }
  // Ensure recovery storage works before opening a wallet or requesting custody signing.
  write(wallet.network, wallet.address, rows);
  if (rows.length >= 10) throw new Error("Retry an earlier pending transaction first.");
  const record: PendingCrcBroadcast = {...wallet, sessionId: built.sessionId, endpoint, psbtBase64: built.psbtBase64,
    signedPsbtBase64: await sign(), createdAt: Date.now()};
  save(record);
  return retryCrcBroadcast(record, request);
}
