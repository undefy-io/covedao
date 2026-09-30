#!/usr/bin/env python3
"""Archive the public crc.garden activity ledger as a SQLite snapshot."""

import argparse
import json
import os
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


SOURCE_URL = "https://crc.garden/activity"
API_URL = "https://crc.garden/api/crc20/events"
PAGE_SIZE = 50


def get_page(cursor: int) -> dict:
    url = f"{API_URL}?{urlencode({'cursor': cursor, 'limit': PAGE_SIZE})}"
    for attempt in range(4):
        try:
            request = Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def download_snapshot() -> tuple[list[dict], dict]:
    for snapshot_attempt in range(3):
        first = get_page(0)
        events = list(first["events"])
        cursor = first["next_cursor"]
        pages = 1
        stable = True
        has_more = first["has_more"]
        while has_more:
            if cursor != len(events):
                raise RuntimeError(f"pagination stalled at cursor {cursor}")
            time.sleep(0.15)
            page = get_page(cursor)
            pages += 1
            if (
                page["total"] != first["total"]
                or page["tip_height"] != first["tip_height"]
                or page["counts"] != first["counts"]
                or page["daily"] != first["daily"]
            ):
                stable = False
                break
            if not page["events"]:
                raise RuntimeError(f"empty page at cursor {cursor}")
            events.extend(page["events"])
            next_cursor = page["next_cursor"]
            if page["has_more"] and (next_cursor is None or next_cursor <= cursor):
                raise RuntimeError(f"pagination stalled at cursor {cursor}")
            cursor = next_cursor
            has_more = page["has_more"]
            if pages > 10000:
                raise RuntimeError("pagination exceeded 10000 pages")
        if not stable:
            print(f"Chain tip or event count changed during capture; retrying snapshot {snapshot_attempt + 1}/3")
            continue
        if len(events) != first["total"]:
            raise RuntimeError(f"downloaded {len(events)} events, API advertised {first['total']}")
        actual_counts = {kind: sum(event["kind"] == kind for event in events) for kind in first["counts"]}
        if actual_counts != first["counts"]:
            raise RuntimeError(f"kind counts mismatch: {actual_counts} != {first['counts']}")
        final = get_page(0)
        if (
            final["tip_height"] != first["tip_height"]
            or final["total"] != first["total"]
            or final["counts"] != first["counts"]
            or final["events"] != first["events"]
        ):
            print(f"Ledger changed during capture; retrying snapshot {snapshot_attempt + 1}/3")
            continue
        first["pages_downloaded"] = pages
        return events, first
    raise RuntimeError("chain tip changed during all snapshot attempts")


def write_database(path: Path, events: list[dict], snapshot: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".crc-garden-", suffix=".sqlite", dir=path.parent, delete=False) as temp:
        temp_path = Path(temp.name)
    try:
        db = sqlite3.connect(temp_path)
        try:
            db.executescript("""
                CREATE TABLE capture (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE events (
                    event_index INTEGER PRIMARY KEY,
                    txid TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    tick TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    block_height INTEGER NOT NULL,
                    block_hash TEXT NOT NULL,
                    from_address TEXT,
                    to_address TEXT,
                    amount_atoms TEXT,
                    mint_status TEXT,
                    mint_beneficiary TEXT,
                    mint_csv_blocks INTEGER,
                    mint_payment_asset TEXT,
                    mint_payment_amount_atoms TEXT,
                    raw_json TEXT NOT NULL
                );
                CREATE INDEX events_txid ON events(txid);
                CREATE INDEX events_kind_time ON events(kind, timestamp);
                CREATE INDEX events_from ON events(from_address);
                CREATE INDEX events_to ON events(to_address);
                CREATE INDEX events_block ON events(block_height);
                CREATE TABLE daily (
                    day TEXT PRIMARY KEY,
                    events INTEGER NOT NULL,
                    mints INTEGER NOT NULL,
                    transfers INTEGER NOT NULL,
                    addresses INTEGER NOT NULL,
                    addresses_cumulative INTEGER NOT NULL,
                    btc_sats TEXT NOT NULL,
                    leaf_minted_atoms TEXT NOT NULL,
                    leaf_moved_atoms TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );
            """)
            metadata = {
                "source_url": SOURCE_URL,
                "api_url": API_URL,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "source_generated_at": snapshot["generated_at"],
                "tip_height": snapshot["tip_height"],
                "advertised_total": snapshot["total"],
                "pages_downloaded": snapshot["pages_downloaded"],
                "counts_json": json.dumps(snapshot["counts"], sort_keys=True),
            }
            db.executemany("INSERT INTO capture VALUES (?, ?)", ((key, str(value)) for key, value in metadata.items()))
            db.executemany(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        index,
                        event["txid"],
                        event["kind"],
                        event["tick"],
                        event["timestamp"],
                        event["block_height"],
                        event["block_hash"],
                        event.get("from"),
                        event.get("to"),
                        event.get("amount_atoms"),
                        (event.get("mint") or {}).get("status"),
                        (event.get("mint") or {}).get("beneficiary"),
                        (event.get("mint") or {}).get("csv_blocks"),
                        (event.get("mint") or {}).get("payment_asset"),
                        (event.get("mint") or {}).get("payment_amount_atoms"),
                        json.dumps(event, sort_keys=True, separators=(",", ":")),
                    )
                    for index, event in enumerate(events)
                ),
            )
            db.executemany(
                "INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        day["day"],
                        day["events"],
                        day["mints"],
                        day["transfers"],
                        day["addresses"],
                        day["addresses_cumulative"],
                        day["btc_sats"],
                        day["leaf_minted_atoms"],
                        day["leaf_moved_atoms"],
                        json.dumps(day, sort_keys=True, separators=(",", ":")),
                    )
                    for day in snapshot["daily"]
                ),
            )
            db.commit()
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite integrity check failed")
        finally:
            db.close()
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="SQLite output path")
    args = parser.parse_args()
    events, snapshot = download_snapshot()
    write_database(args.output, events, snapshot)
    print(f"Saved {len(events)} events from {snapshot['pages_downloaded']} pages at tip {snapshot['tip_height']} to {args.output}")


if __name__ == "__main__":
    main()
