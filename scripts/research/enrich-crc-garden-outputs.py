#!/usr/bin/env python3
"""Fetch the Bitcoin transactions behind an archived crc.garden ledger."""

import argparse
import json
import sqlite3
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


RPC_URL = "https://bitcoin-rpc.publicnode.com"
BATCH_SIZE = 50


def rpc_batch(rows: list[tuple[str, str]]) -> list[dict]:
    body = json.dumps([
        {"jsonrpc": "2.0", "id": index, "method": "getrawtransaction", "params": [txid, True, block_hash]}
        for index, (txid, block_hash) in enumerate(rows)
    ]).encode()
    for attempt in range(5):
        try:
            request = Request(RPC_URL, data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=90) as response:
                replies = json.load(response)
            if not isinstance(replies, list) or len(replies) != len(rows):
                raise RuntimeError(f"expected {len(rows)} batch replies, received {len(replies) if isinstance(replies, list) else type(replies).__name__}")
            by_id = {reply["id"]: reply for reply in replies}
            if set(by_id) != set(range(len(rows))):
                raise RuntimeError("batch reply IDs do not match requests")
            results = []
            for index, (txid, block_hash) in enumerate(rows):
                reply = by_id[index]
                if reply.get("error"):
                    raise RuntimeError(f"{txid}: {reply['error']}")
                tx = reply["result"]
                if tx["txid"] != txid or tx["blockhash"] != block_hash or tx.get("in_active_chain") is False:
                    raise RuntimeError(f"transaction or block mismatch for {txid}")
                results.append(tx)
            return results
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            if attempt == 4:
                raise RuntimeError(f"RPC batch failed after 5 attempts: {error}") from error
            time.sleep(min(2**attempt, 16))
    raise RuntimeError("unreachable")


def op_return_payload(script_hex: str) -> bytes | None:
    script = bytes.fromhex(script_hex)
    if len(script) < 2 or script[0] != 0x6A:
        return None
    opcode = script[1]
    if opcode <= 75:
        offset, length = 2, opcode
    elif opcode == 0x4C and len(script) >= 3:
        offset, length = 3, script[2]
    elif opcode == 0x4D and len(script) >= 4:
        offset, length = 4, int.from_bytes(script[2:4], "little")
    elif opcode == 0x4E and len(script) >= 6:
        offset, length = 6, int.from_bytes(script[2:6], "little")
    else:
        return None
    return script[offset:] if len(script) == offset + length else None


def sats(value: float | int) -> int:
    exact = Decimal(str(value)) * Decimal(100_000_000)
    if exact != exact.to_integral_value():
        raise ValueError(f"non-integer satoshi output {value}")
    return int(exact)


def create_tables(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS transactions (
            txid TEXT PRIMARY KEY,
            block_hash TEXT NOT NULL,
            block_height INTEGER NOT NULL,
            block_time INTEGER NOT NULL,
            version INTEGER NOT NULL,
            locktime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            vsize INTEGER NOT NULL,
            weight INTEGER NOT NULL,
            input_count INTEGER NOT NULL,
            output_count INTEGER NOT NULL,
            raw_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outputs (
            txid TEXT NOT NULL REFERENCES transactions(txid),
            vout INTEGER NOT NULL,
            value_sats INTEGER NOT NULL,
            script_hex TEXT NOT NULL,
            script_type TEXT NOT NULL,
            address TEXT,
            op_return_payload_hex TEXT,
            op_return_text TEXT,
            op_return_json TEXT,
            PRIMARY KEY (txid, vout)
        );
        CREATE INDEX IF NOT EXISTS outputs_address ON outputs(address);
        CREATE INDEX IF NOT EXISTS outputs_script_type ON outputs(script_type);
    """)


def save_batch(db: sqlite3.Connection, rows: list[tuple[str, str]], txs: list[dict]) -> None:
    heights = dict(db.execute(
        f"SELECT txid, block_height FROM events WHERE txid IN ({','.join('?' for _ in rows)})",
        [txid for txid, _ in rows],
    ))
    with db:
        for tx in txs:
            txid = tx["txid"]
            outputs = tx["vout"]
            db.execute(
                "INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    txid, tx["blockhash"], heights[txid], tx["blocktime"], tx["version"], tx["locktime"],
                    tx["size"], tx["vsize"], tx["weight"], len(tx["vin"]), len(outputs),
                    json.dumps(tx, sort_keys=True, separators=(",", ":")),
                ),
            )
            for output in outputs:
                script = output["scriptPubKey"]
                payload = op_return_payload(script["hex"])
                decoded = None
                parsed = None
                if payload is not None:
                    try:
                        decoded = payload.decode("utf-8")
                        parsed = json.loads(decoded)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        pass
                db.execute(
                    "INSERT INTO outputs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        txid, output["n"], sats(output["value"]), script["hex"], script["type"],
                        script.get("address"), payload.hex() if payload is not None else None,
                        decoded, json.dumps(parsed, sort_keys=True) if parsed is not None else None,
                    ),
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="SQLite activity database to enrich")
    args = parser.parse_args()
    db = sqlite3.connect(args.database)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        create_tables(db)
        rows = db.execute("""
            SELECT e.txid, e.block_hash FROM events e
            LEFT JOIN transactions t ON t.txid = e.txid
            WHERE t.txid IS NULL ORDER BY e.event_index
        """).fetchall()
        total = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        for offset in range(0, len(rows), BATCH_SIZE):
            batch = rows[offset:offset + BATCH_SIZE]
            save_batch(db, batch, rpc_batch(batch))
            print(f"Downloaded {min(offset + len(batch), len(rows))}/{len(rows)} missing transactions", flush=True)
            time.sleep(0.25)
        tx_count = db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        output_count = db.execute("SELECT COUNT(*) FROM outputs").fetchone()[0]
        declared_outputs = db.execute("SELECT SUM(output_count) FROM transactions").fetchone()[0]
        if tx_count != total or output_count != declared_outputs:
            raise RuntimeError(f"incomplete archive: {tx_count}/{total} tx, {output_count}/{declared_outputs} outputs")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity check failed")
        with db:
            db.execute("INSERT OR REPLACE INTO capture VALUES (?, ?)", ("output_rpc_url", RPC_URL))
            db.execute("INSERT OR REPLACE INTO capture VALUES (?, ?)", ("outputs_captured_at", datetime.now(timezone.utc).isoformat()))
            db.execute("INSERT OR REPLACE INTO capture VALUES (?, ?)", ("outputs_total", str(output_count)))
        print(f"Complete: {tx_count} transactions and {output_count} outputs in {args.database}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
