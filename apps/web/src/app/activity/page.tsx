"use client";
import { DEMO_EVENTS } from "@/lib/demo-tokens";

import { useSearchParams } from "next/navigation";

import { Suspense, useEffect, useState } from "react";
import { useIndexedBlock } from "@/lib/use-indexed-block";

/** Rows shown at first, and per "Show more". */
const PAGE = 20;

interface Event {
  txid: string;
  blockHeight: string;
  operation: string;
  tokenId: string | null;
  valid: boolean;
}

function ActivityContent() {
  const searchParams = useSearchParams();
  // Client-side design-preview path: no API calls, no writes.
  const demo = searchParams.get("demo") === "1";
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The newest few by default; the rest one click away.
  const [shown, setShown] = useState(PAGE);
  // Refetch when a new block is indexed.
  const block = useIndexedBlock();

  useEffect(() => {
    if (demo) {
      setEvents(DEMO_EVENTS);
      setLoaded(true);
      return;
    }
    void fetch("/api/v3/activity")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setEvents(j.data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [block]);

  const label = (op: string | null) =>
    op === "DEPLOY" ? "Launch" : op === "MINT" ? "Backing buy" : op === "REDEEM" ? "Backing redeem" : op === "TRANSFER" ? "Transfer" : op ?? "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl text-bone">Activity</h1>
        <p className="text-sm text-bone-dim">Canonical confirmed covs events (never broadcast-as-confirmed).</p>
      </div>
      {!loaded ? (
        <p className="text-bone-dim">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-bone-dim">No confirmed events yet.</p>
      ) : (
        <div className="space-y-2">
          {events.slice(0, shown).map((e) => (
            <div key={e.txid} className="flex items-center justify-between border border-rule bg-ink-2 p-3 text-sm">
              <div>
                <span className="text-bone">{label(e.operation)}</span>
                {e.tokenId && <span className="ml-2 font-mono text-xs text-bone-dim">{e.tokenId.slice(0, 12)}…</span>}
              </div>
              <div className="text-right">
                <div className="text-xs text-bone-dim">height {e.blockHeight}</div>
                <div className="font-mono text-xs text-bone-dim">{e.txid.slice(0, 16)}…</div>
              </div>
            </div>
          ))}
          {events.length > shown ? (
            <button onClick={() => setShown((n) => n + PAGE)} className="btn-ghost w-full">
              Show more ({events.length - shown} older)
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * useSearchParams opts this route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary.
 */
export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="panel px-6 py-16 text-center text-sm text-bone-dim">Loading…</div>}>
      <ActivityContent />
    </Suspense>
  );
}
