"use client";
import { useEffect, useState } from "react";
import { CRC_PENDING_CHANGED, dismissCrcBroadcast, pendingCrcBroadcasts, retryCrcBroadcast, type PendingCrcBroadcast } from "@/lib/crc-client-broadcast";
export function CrcPendingBroadcasts({network, address}: {network: string; address: string}) {
  const [records, setRecords] = useState<PendingCrcBroadcast[]>([]);
  const [busy, setBusy] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => {
    setMessage("");
    const read = () => { try { setRecords(address && network !== "regtest" ? pendingCrcBroadcasts(network, address) : []); } catch { setRecords([]); } };
    read(); window.addEventListener(CRC_PENDING_CHANGED, read); window.addEventListener("storage", read);
    return () => {window.removeEventListener(CRC_PENDING_CHANGED, read); window.removeEventListener("storage", read);};
  }, [network,address]);
  async function retry(record: PendingCrcBroadcast) {
    setBusy(record.sessionId); setMessage("");
    try { const result = await retryCrcBroadcast(record); setMessage(`Transaction submitted: ${result.txid}`); }
    catch(error) { setMessage(error instanceof Error ? error.message : "Broadcast failed. Retry shortly."); }
    finally {setBusy("");}
  }
  const current = records.filter(record => record.network === network && record.address === address);
  if (!current.length && !message) return null;
  return <aside className="mx-auto max-w-5xl border border-rule bg-ink-2 p-4" aria-label="Pending transactions">
    {current.length > 0 && <p className="text-sm text-bone">Your signed transaction is saved. Retry without signing again.</p>}
    {current.map(record => <div key={record.sessionId} className="mt-2 flex flex-wrap items-center gap-3">
      <span className="break-all text-xs text-bone-dim">{record.receipt?.txid || "Prepared wallet transaction"}</span>
      <button type="button" className="btn" disabled={!!busy} onClick={() => void retry(record)}>{busy === record.sessionId ? "Submitting…" : "Retry broadcast"}</button>
      <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => dismissCrcBroadcast(network,address,record.sessionId)}>Dismiss</button>
    </div>)}
    {message && <p role="status" className="mt-2 break-all text-sm text-bone">{message}</p>}
  </aside>;
}
