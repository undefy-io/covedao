"use client";

import Link from "next/link";
import { useState } from "react";
import { useCrcRead } from "../lib/use-crc-read";
import { formatAtoms } from "./CrcHome";
import { crcActivityLabel } from "../lib/crc-activity-label";

type Event = {
  txid: string;
  blockHeight: string;
  operation: string | null;
  tradeSide: string | null;
  valid: boolean;
  deployTxid: string | null;
  amountAtoms: string | null;
};

export function CrcActivity() {
  const { data, error } = useCrcRead<{ rows: Event[]; network: string }>("/api/crc/v1/activity", "Could not load activity");
  const events = data?.rows ?? [];
  const network = data?.network ?? "";
  const loading = data === null && !error;
  const [shown, setShown] = useState(20);

  return <div className="space-y-6 py-8">
    <div><h1 className="text-2xl text-bone">Activity</h1><p className="text-sm text-bone-dim">Recent confirmed Cove CRC-20 transactions.</p></div>
    {loading && <p className="text-sm text-bone-dim">Reading indexed activity…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!loading && !error && events.length === 0 && <p className="text-sm text-bone-dim">No confirmed activity yet.</p>}
    <div className="space-y-2">{events.slice(0, shown).map((event) => <div key={event.txid} className="flex flex-wrap items-center justify-between gap-3 border border-rule bg-ink-2 p-3 text-sm">
      <div className="min-w-0">
        <span className={event.valid ? "text-bone" : "text-rejected"}>{crcActivityLabel(event)}</span>
        {event.deployTxid && <Link href={`/token/${encodeURIComponent(`${network}:${event.deployTxid}`)}`} className="hex ml-2 hover:text-signal">{event.deployTxid.slice(0, 12)}…</Link>}
        {event.amountAtoms && <span className="ml-2 text-xs tabular-nums text-bone-dim">{formatAtoms(event.amountAtoms)} tokens</span>}
      </div>
      <div className="text-right text-xs text-bone-dim"><div>Block {Number(event.blockHeight).toLocaleString()}</div><div className="hex">{event.txid.slice(0, 16)}…</div></div>
    </div>)}</div>
    {events.length > shown && <button type="button" onClick={() => setShown((value) => value + 20)} className="btn-ghost w-full">Show more</button>}
  </div>;
}
