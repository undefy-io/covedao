#!/usr/bin/env python3
"""Archive canonical Bitcoin transaction positions for CRC activity events."""

import argparse
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARCHIVE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/crc-garden/block-order-proofs.sqlite"
DEFAULT_RPC_URL = "https://bitcoin-rpc.publicnode.com"
BATCH_SIZE = 8


def create_tables(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS blocks (
            block_hash TEXT PRIMARY KEY,
            height INTEGER NOT NULL,
            header_hex TEXT NOT NULL,
            tx_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_positions (
            txid TEXT PRIMARY KEY,
            block_hash TEXT NOT NULL REFERENCES blocks(block_hash),
            block_height INTEGER NOT NULL,
            tx_index INTEGER NOT NULL,
            merkle_branch BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS event_positions_order
            ON event_positions(block_height, tx_index);
    """)


def expected_events(archive):
    rows = archive.execute("""
        SELECT e.txid, e.block_hash, e.block_height,
               t.block_hash, t.block_height
        FROM events e LEFT JOIN transactions t ON t.txid=e.txid
        ORDER BY e.event_index
    """).fetchall()
    if not rows:
        raise ValueError("missing archived events")
    events = {}
    blocks = {}
    for txid, block_hash, height, tx_block_hash, tx_height in rows:
        if txid in events:
            raise ValueError(f"duplicate archived event txid {txid}")
        if (tx_block_hash, tx_height) != (block_hash, height):
            raise ValueError(f"event/transaction block mismatch for {txid}")
        if block_hash in blocks and blocks[block_hash] != height:
            raise ValueError(f"block height mismatch for {block_hash}")
        events[txid] = (block_hash, height)
        blocks[block_hash] = height
    return events, blocks


def sha256d(value):
    return hashlib.sha256(hashlib.sha256(value).digest()).digest()


def block_header_root(header_hex, expected_hash):
    try:
        header = bytes.fromhex(header_hex)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid block header hex") from error
    if len(header) != 80:
        raise ValueError("invalid block header length")
    if sha256d(header)[::-1].hex() != expected_hash:
        raise ValueError(f"block header hash mismatch for {expected_hash}")
    return header[36:68][::-1].hex()


def merkle_levels(txids):
    levels = [[bytes.fromhex(txid)[::-1] for txid in txids]]
    while len(levels[-1]) > 1:
        nodes = levels[-1]
        if len(nodes) & 1:
            nodes = nodes + [nodes[-1]]
        levels.append([sha256d(nodes[offset] + nodes[offset + 1])
                       for offset in range(0, len(nodes), 2)])
    return levels


def proof_for(levels, tx_index):
    branch = []
    index = tx_index
    for nodes in levels[:-1]:
        sibling = index ^ 1
        branch.append(nodes[sibling] if sibling < len(nodes) else nodes[index])
        index //= 2
    return b"".join(branch)


def verify_proof(txid, tx_index, tx_count, branch, root):
    if tx_count <= 0 or tx_index < 0 or tx_index >= tx_count or len(branch) % 32:
        raise ValueError(f"invalid event position for {txid}")
    index = tx_index
    width = tx_count
    value = bytes.fromhex(txid)[::-1]
    for offset in range(0, len(branch), 32):
        if width <= 1:
            raise ValueError(f"event proof too long for {txid}")
        sibling = branch[offset:offset + 32]
        if index == width - 1 and width & 1 and sibling != value:
            raise ValueError(f"invalid duplicate leaf in event proof for {txid}")
        value = sha256d(sibling + value) if index & 1 else sha256d(value + sibling)
        index //= 2
        width = (width + 1) // 2
    if width != 1 or value[::-1].hex() != root:
        raise ValueError(f"event position proof mismatch for {txid}")


def normalize_block(core, expected_hash, expected_height, header_hex, event_txids=()):
    if not isinstance(core, dict):
        raise ValueError(f"invalid block response for {expected_hash}")
    if core.get("hash") != expected_hash:
        raise ValueError(f"block hash mismatch for {expected_hash}")
    if core.get("height") != expected_height:
        raise ValueError(f"block height mismatch for {expected_hash}")
    if not isinstance(core.get("confirmations"), int) or core["confirmations"] <= 0:
        raise ValueError(f"block is not active: {expected_hash}")
    txids = core.get("tx")
    if not isinstance(txids, list) or not txids:
        raise ValueError(f"block has no txid list: {expected_hash}")
    if len(txids) != len(set(txids)):
        raise ValueError(f"duplicate txid in block {expected_hash}")
    if any(not isinstance(txid, str) or len(txid) != 64 for txid in txids):
        raise ValueError(f"invalid txid in block {expected_hash}")
    try:
        bytes.fromhex("".join(txids))
    except ValueError as error:
        raise ValueError(f"invalid txid in block {expected_hash}") from error
    missing = set(event_txids) - set(txids)
    if missing:
        raise ValueError(f"missing {len(missing)} event txids in block {expected_hash}")
    root = block_header_root(header_hex, expected_hash)
    levels = merkle_levels(txids)
    if levels[-1][0][::-1].hex() != root or core.get("merkleroot") != root:
        raise ValueError(f"block merkle root mismatch for {expected_hash}")
    return {"hash": expected_hash, "height": expected_height, "txids": txids,
            "header_hex": header_hex, "levels": levels}


def save_block(db, block, events):
    positions = {txid: index for index, txid in enumerate(block["txids"])}
    if len(events) != len({txid for txid, _ in events}):
        raise ValueError(f"duplicate event txid for block {block['hash']}")
    missing = {txid for txid, _ in events} - positions.keys()
    if missing:
        raise ValueError(f"missing {len(missing)} event txids in block {block['hash']}")
    if any(hash_ != block["hash"] for _, hash_ in events):
        raise ValueError("event block hash mismatch")
    with db:
        db.execute("INSERT INTO blocks VALUES (?, ?, ?, ?)",
                   (block["hash"], block["height"], block["header_hex"], len(block["txids"])))
        db.executemany("INSERT INTO event_positions VALUES (?, ?, ?, ?, ?)",
                       [(txid, block["hash"], block["height"], positions[txid],
                         proof_for(block["levels"], positions[txid])) for txid, _ in events])


def check_coverage(archive, db):
    events, expected_blocks = expected_events(archive)
    block_rows = db.execute("SELECT block_hash, height, header_hex, tx_count FROM blocks").fetchall()
    if {row[0] for row in block_rows} != set(expected_blocks):
        raise ValueError("missing or unexpected blocks")
    roots = {}
    for block_hash, height, header_hex, tx_count in block_rows:
        if height != expected_blocks[block_hash]:
            raise ValueError(f"block height mismatch for {block_hash}")
        roots[block_hash] = (block_header_root(header_hex, block_hash), tx_count)
    rows = db.execute("SELECT txid, block_hash, block_height, tx_index, merkle_branch FROM event_positions").fetchall()
    if {row[0] for row in rows} != set(events) or len(rows) != len(events):
        raise ValueError("missing or unexpected event positions")
    for txid, block_hash, height, index, branch in rows:
        if (block_hash, height) != events[txid]:
            raise ValueError(f"event block mismatch for {txid}")
        root, tx_count = roots[block_hash]
        verify_proof(txid, index, tx_count, branch, root)
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("SQLite integrity check failed")
    return {"events": len(events), "blocks": len(expected_blocks)}


def rpc_batch(url, blocks):
    calls = []
    for index, (block_hash, _) in enumerate(blocks):
        calls.append({"jsonrpc": "2.0", "id": 2 * index, "method": "getblock",
                      "params": [block_hash, 1]})
        calls.append({"jsonrpc": "2.0", "id": 2 * index + 1, "method": "getblockheader",
                      "params": [block_hash, False]})
    body = json.dumps(calls).encode()
    for attempt in range(6):
        try:
            request = Request(url, data=body, headers={"Content-Type": "application/json",
                                                       "User-Agent": "crc-block-order/1"})
            with urlopen(request, timeout=90) as response:
                replies = json.load(response)
            if not isinstance(replies, list) or len(replies) != len(calls):
                raise ValueError("RPC response count mismatch")
            by_id = {item["id"]: item for item in replies}
            if set(by_id) != set(range(len(calls))):
                raise ValueError("RPC response IDs mismatch")
            results = []
            for index, (block_hash, height) in enumerate(blocks):
                block_reply, header_reply = by_id[2 * index], by_id[2 * index + 1]
                if block_reply.get("error") or header_reply.get("error"):
                    raise ValueError(f"RPC could not load block/header {block_hash}")
                results.append(normalize_block(block_reply["result"], block_hash, height,
                                               header_reply["result"]))
            return results
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            if attempt == 5:
                description = f"HTTP {error.code}" if isinstance(error, HTTPError) else type(error).__name__
                raise RuntimeError(f"block RPC failed after retries: {description}") from None
            time.sleep(min(2 ** attempt, 16))
    raise AssertionError("unreachable")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--rpc-url", default=os.environ.get("CRC_MAINNET_RPC_URL", DEFAULT_RPC_URL))
    parser.add_argument("--check", action="store_true", help="verify existing archive without network")
    args = parser.parse_args(argv)
    if args.check and not args.output.exists():
        raise ValueError(f"missing block-order archive: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.archive) as archive, sqlite3.connect(args.output) as db:
        if not args.check:
            db.execute("PRAGMA foreign_keys=ON")
            create_tables(db)
            events, blocks = expected_events(archive)
            by_block = {}
            for txid, (block_hash, _) in events.items():
                by_block.setdefault(block_hash, []).append((txid, block_hash))
            existing = {row[0] for row in db.execute("SELECT block_hash FROM blocks")}
            missing = sorted(((block_hash, height) for block_hash, height in blocks.items()
                              if block_hash not in existing), key=lambda row: (row[1], row[0]))
            for offset in range(0, len(missing), BATCH_SIZE):
                batch = missing[offset:offset + BATCH_SIZE]
                for block in rpc_batch(args.rpc_url, batch):
                    save_block(db, block, by_block[block["hash"]])
                print(f"Archived {min(offset + BATCH_SIZE, len(missing))}/{len(missing)} missing blocks", flush=True)
                time.sleep(0.25)
        report = check_coverage(archive, db)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
