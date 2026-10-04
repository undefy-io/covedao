"use client";

import { COVE_NETWORK_SETTINGS, type CoveNetworkName } from "@crclaunch/config";
import { useState } from "react";
import { useCrcRead } from "../lib/use-crc-read";
import { formatAtoms } from "./CrcHome";
import { crcActivityLabel } from "../lib/crc-activity-label";

type Row = {
  txid: string;
  blockHeight: string;
  operation: string | null;
  tradeSide: string | null;
  valid: boolean;
  reason: string | null;
  amountAtoms: string | null;
};

export function CrcTokenActivity({ assetId, network }: { assetId: string; network: string }) {
  const { data, error } = useCrcRead<{ rows: Row[] }>(`/api/crc/v1/tokens/${encodeURIComponent(assetId)}/activity`, "Could not load token history");
  const rows = data?.rows ?? null;
  const [shown, setShown] = useState(10);

  const explorer = COVE_NETWORK_SETTINGS[network as CoveNetworkName]?.explorerUrl;
  return <section className="panel px-6 py-8 sm:px-10">
    <div className="flex items-baseline justify-between gap-3">
      <p className="eyebrow">History</p>
      <span className="text-label uppercase tracking-label text-bone-dim">Confirmed on Bitcoin</span>
    </div>
    {error && <p role="alert" className="mt-5 text-sm text-danger">{error}</p>}
    {!error && rows === null && <p className="mt-5 text-sm text-bone-dim">Reading confirmed activity…</p>}
    {!error && rows?.length === 0 && <p className="mt-5 border border-dashed border-rule px-6 py-10 text-center text-sm text-bone-dim">No confirmed activity yet.</p>}
    {rows && rows.length > 0 && <div className="mt-5 overflow-x-auto">
      <table className="ledger-table min-w-[36rem]">
        <thead><tr>
          <th className="text-right">Block</th><th>Action</th><th className="text-right">Tokens</th><th className="text-right">Transaction</th>
        </tr></thead>
        <tbody>{rows.slice(0, shown).map((row) => <tr key={row.txid}>
          <td className="text-right text-bone-dim">{Number(row.blockHeight).toLocaleString()}</td>
          <td className={row.valid ? "text-bone" : "text-rejected"}>{crcActivityLabel(row)}{!row.valid && <span className="ml-2 text-label">Rejected</span>}</td>
          <td className="text-right tabular-nums">{row.amountAtoms ? formatAtoms(row.amountAtoms) : "—"}</td>
          <td className="text-right">{explorer ? <a href={`${explorer}/tx/${row.txid}`} target="_blank" rel="noreferrer noopener" className="hex hover:text-signal">{row.txid.slice(0, 12)}…</a> : <span className="hex">{row.txid.slice(0, 12)}…</span>}</td>
        </tr>)}</tbody>
      </table>
      {rows.length > shown && <button type="button" className="btn-ghost mt-4 w-full" onClick={() => setShown((value) => value + 10)}>Show more</button>}
    </div>}
  </section>;
}
