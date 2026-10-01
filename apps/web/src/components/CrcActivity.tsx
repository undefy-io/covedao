"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  const [events, setEvents] = useState<Event[]>([]);
  const [network, setNetwork] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(20);

  useEffect(() => {
    let live = true;
    void fetch("/api/crc/v1/activity", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (!live) return;
        if (!body.ok) throw new Error(body.error?.message ?? "Could not load activity");
        setEvents(body.data.rows as Event[]);
        setNetwork(body.data.network as string);
      })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load activity"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

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
