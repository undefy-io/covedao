#!/usr/bin/env python3
"""Extract offline CRC-20 transaction fixtures from the archived mainnet corpus."""

import argparse
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/crc-garden/golden-transactions.json"


class Reader:
    def __init__(self, raw: bytes):
        self.raw = raw
        self.offset = 0

    def take(self, size: int) -> bytes:
        end = self.offset + size
        if end > len(self.raw):
            raise ValueError("truncated Bitcoin transaction")
        value = self.raw[self.offset:end]
        self.offset = end
        return value

    def compact_size(self) -> int:
        prefix = self.take(1)[0]
        if prefix < 253:
            return prefix
        size = {253: 2, 254: 4, 255: 8}[prefix]
        value = int.from_bytes(self.take(size), "little")
        if value < {253: 253, 254: 65536, 255: 4294967296}[prefix]:
            raise ValueError("noncanonical CompactSize")
        return value


@dataclass(frozen=True)
class ParsedTransaction:
    txid: str
    inputs: tuple[tuple[str, int], ...]
    outputs: tuple[tuple[int, bytes], ...]
    witness_counts: tuple[int, ...]
    witnesses: tuple[tuple[bytes, ...], ...]


def parse_transaction(raw: bytes) -> ParsedTransaction:
    reader = Reader(raw)
    version = reader.take(4)
    segwit = raw[reader.offset:reader.offset + 2] == b"\x00\x01"
    if segwit:
        reader.take(2)
    body_start = reader.offset
    inputs = []
    for _ in range(reader.compact_size()):
        previous = reader.take(32)[::-1].hex()
        vout = int.from_bytes(reader.take(4), "little")
        reader.take(reader.compact_size())
        reader.take(4)
        inputs.append((previous, vout))
    outputs = []
    for _ in range(reader.compact_size()):
        sats = int.from_bytes(reader.take(8), "little")
        script = reader.take(reader.compact_size())
        outputs.append((sats, script))
    body_end = reader.offset
    witnesses = []
    if segwit:
        for _ in inputs:
            count = reader.compact_size()
            witnesses.append(tuple(reader.take(reader.compact_size()) for _ in range(count)))
    else:
        witnesses = [()] * len(inputs)
    locktime = reader.take(4)
    if reader.offset != len(raw):
        raise ValueError("trailing Bitcoin transaction bytes")
    if not inputs or not outputs:
        raise ValueError("empty Bitcoin transaction")
    stripped = version + raw[body_start:body_end] + locktime
    txid = hashlib.sha256(hashlib.sha256(stripped).digest()).digest()[::-1].hex()
    return ParsedTransaction(txid, tuple(inputs), tuple(outputs),
                             tuple(len(items) for items in witnesses), tuple(witnesses))


def marker(script: bytes) -> dict | None:
    if not script or script[0] != 0x6A or len(script) < 2:
        return None
    prefix = script[1]
    if prefix <= 75:
        offset, size = 2, prefix
    elif prefix == 76 and len(script) >= 3:
        offset, size = 3, script[2]
    elif prefix == 77 and len(script) >= 4:
        offset, size = 4, int.from_bytes(script[2:4], "little")
    elif prefix == 78 and len(script) >= 6:
        offset, size = 6, int.from_bytes(script[2:6], "little")
    else:
        return None
    if len(script) != offset + size:
        return None
    try:
        value = json.loads(script[offset:].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def build_fixtures(db: sqlite3.Connection) -> dict:
    db.row_factory = sqlite3.Row
    rows = db.execute("""
        SELECT e.*, t.raw_json AS transaction_json, t.output_count FROM events e
        JOIN transactions t USING (txid) ORDER BY e.event_index
    """).fetchall()
    selected = {}
    for row in rows:
        core = json.loads(row["transaction_json"])
        raw = bytes.fromhex(core["hex"])
        tx = parse_transaction(raw)
        crc = [(index, value) for index, (_, script) in enumerate(tx.outputs)
               if (value := marker(script)) is not None and value.get("p") == "crc-20"]
        if tx.txid != row["txid"] or len(crc) != 1:
            raise ValueError(f"bad archived transaction {row['txid']}")
        marker_vout, _ = crc[0]
        if row["kind"] == "mint":
            category = f"mint_{row['mint_payment_asset'].lower()}"
        elif row["kind"] == "transfer":
            category = f"transfer_marker_{marker_vout}_outputs_{len(tx.outputs)}"
            if len(tx.outputs) == 6 and tx.inputs[0][0] != tx.inputs[1][0]:
                category = "transfer_market_distinct_prevtx"
        else:
            category = row["kind"]
        if category in selected:
            continue
        chain_outputs = []
        for index, (sats, script) in enumerate(tx.outputs):
            normalized = db.execute("SELECT address FROM outputs WHERE txid=? AND vout=?", (row["txid"], index)).fetchone()
            if normalized is None:
                raise ValueError(f"missing Core output for {row['txid']}:{index}")
            chain_outputs.append({"vout": index, "sats": sats, "script_hex": script.hex(), "core_address": normalized["address"]})
        selected[category] = {
            "category": category,
            "txid": tx.txid,
            "raw_transaction_hex": core["hex"],
            "chain_transaction": {
                "block_hash": core["blockhash"],
                "block_height": row["block_height"],
                "inputs": [{"txid": prev, "vout": vout, "witness_items": witness}
                           for (prev, vout), witness in zip(tx.inputs, tx.witness_counts)],
                "outputs": chain_outputs,
                "crc_marker_vout": marker_vout,
                "crc_marker": crc[0][1],
            },
            "api_event": {
                "txid": row["txid"], "kind": row["kind"], "tick": row["tick"],
                "from_address": row["from_address"], "to_address": row["to_address"],
                "amount_atoms": row["amount_atoms"], "mint_status": row["mint_status"],
                "mint_beneficiary": row["mint_beneficiary"], "mint_csv_blocks": row["mint_csv_blocks"],
                "mint_payment_asset": row["mint_payment_asset"],
                "mint_payment_amount_atoms": row["mint_payment_amount_atoms"],
            },
        }
    return {
        "source": "activity-2026-09-30.sqlite; confirmed Bitcoin Core raw bytes and separately archived crc.garden API labels",
        "cases": [selected[key] for key in sorted(selected)],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with sqlite3.connect(f"file:{args.database}?mode=ro", uri=True) as db:
        content = json.dumps(build_fixtures(db), sort_keys=True, indent=2) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != content:
            raise SystemExit("golden fixture differs; rerun without --check to regenerate")
        print(f"Verified {args.output}")
    else:
        args.output.write_text(content)
        print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
