#!/usr/bin/env python3
"""Archive and verify every input prevout of the CRC activity corpus."""

import argparse
import hashlib
import json
import sqlite3
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from crc_corpus_fixtures import parse_transaction


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARCHIVE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/crc-garden/parent-prevouts.sqlite"
DEFAULT_REPORT = ROOT / "artifacts/crc-garden/parent-prevouts-report.json"
RPC_URL = "https://bitcoin-rpc.publicnode.com"
ESPLORA_URLS = {"blockstream": "https://blockstream.info/api", "mempool": "https://mempool.space/api"}
BATCH_SIZE = 20


def create_tables(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS parents (
            txid TEXT PRIMARY KEY,
            raw_hex TEXT NOT NULL,
            source TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prevouts (
            txid TEXT NOT NULL REFERENCES parents(txid),
            vout INTEGER NOT NULL,
            value_sats INTEGER NOT NULL,
            script_hex TEXT NOT NULL,
            address TEXT,
            PRIMARY KEY (txid, vout)
        );
    """)
    if "source" not in {row[1] for row in db.execute("PRAGMA table_info(parents)")}:
        db.execute("ALTER TABLE parents ADD COLUMN source TEXT NOT NULL DEFAULT 'bitcoin-core-publicnode'")


def event_inputs(archive):
    rows = archive.execute("""
        SELECT e.txid, e.kind, e.from_address, t.raw_json
        FROM events e JOIN transactions t USING (txid) ORDER BY e.event_index
    """).fetchall()
    events = []
    for txid, kind, from_address, raw_json in rows:
        raw = bytes.fromhex(json.loads(raw_json)["hex"])
        parsed = parse_transaction(raw)
        if parsed.txid != txid:
            raise ValueError(f"event txid mismatch {txid}")
        events.append({"txid": txid, "kind": kind, "from_address": from_address, "inputs": parsed.inputs})
    return events


def references(events):
    refs = defaultdict(set)
    for event in events:
        for txid, vout in event["inputs"]:
            refs[txid].add(vout)
    return refs


def sats(value):
    amount = Decimal(str(value)) * Decimal(100_000_000)
    if amount != amount.to_integral_value():
        raise ValueError(f"fractional satoshi: {value}")
    return int(amount)


def _convert_bits(data, from_bits, to_bits):
    accumulator = bits = 0
    result = []
    for value in data:
        accumulator = (accumulator << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            result.append((accumulator >> bits) & ((1 << to_bits) - 1))
    if bits:
        result.append((accumulator << (to_bits - bits)) & ((1 << to_bits) - 1))
    return result


def script_address(script):
    if len(script) in (22, 34) and script[0] == 0 and script[1] == len(script) - 2:
        version = 0
        program = script[2:]
    elif len(script) in (34, 42) and script[0] in range(0x51, 0x61) and script[1] == len(script) - 2:
        version = script[0] - 0x50
        program = script[2:]
    else:
        version = None
    if version is not None:
        data = [version] + _convert_bits(program, 8, 5)
        values = [ord(char) >> 5 for char in "bc"] + [0] + [ord(char) & 31 for char in "bc"] + data
        generator = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
        polymod = 1
        for value in values + [0] * 6:
            top = polymod >> 25
            polymod = ((polymod & 0x1FFFFFF) << 5) ^ value
            for bit in range(5):
                if (top >> bit) & 1:
                    polymod ^= generator[bit]
        polymod ^= 1 if version == 0 else 0x2BC830A3
        checksum = [(polymod >> (5 * (5 - n))) & 31 for n in range(6)]
        alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
        return "bc1" + "".join(alphabet[value] for value in data + checksum)
    if len(script) == 25 and script[:3] == bytes.fromhex("76a914") and script[-2:] == bytes.fromhex("88ac"):
        payload = b"\x00" + script[3:23]
    elif len(script) == 23 and script[:2] == bytes.fromhex("a914") and script[-1:] == bytes.fromhex("87"):
        payload = b"\x05" + script[2:22]
    else:
        return None
    checked = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    number = int.from_bytes(checked, "big")
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = alphabet[remainder] + encoded
    return "1" * (len(checked) - len(checked.lstrip(b"\x00"))) + encoded


def normalize_parent(core, required_vouts, source="bitcoin-core-publicnode"):
    raw_hex = core["hex"]
    parsed = parse_transaction(bytes.fromhex(raw_hex))
    if parsed.txid != core["txid"]:
        raise ValueError(f"parent txid mismatch {core['txid']}")
    outputs = {}
    for vout in required_vouts:
        if vout < 0 or vout >= len(parsed.outputs):
            raise ValueError(f"missing parent outpoint {parsed.txid}:{vout}")
        core_output = core["vout"][vout]
        value_sats, script = parsed.outputs[vout]
        if core_output["n"] != vout or sats(core_output["value"]) != value_sats:
            raise ValueError(f"parent value mismatch {parsed.txid}:{vout}")
        script_hex = script.hex()
        if core_output["scriptPubKey"]["hex"] != script_hex:
            raise ValueError(f"parent script mismatch {parsed.txid}:{vout}")
        derived_address = script_address(script)
        core_address = core_output["scriptPubKey"].get("address")
        if derived_address is not None and core_address is not None and derived_address != core_address:
            raise ValueError(f"parent address mismatch {parsed.txid}:{vout}")
        outputs[vout] = {"value_sats": value_sats, "script_hex": script_hex,
                         "address": derived_address or core_address}
    return {"txid": parsed.txid, "raw_hex": raw_hex, "source": source, "outputs": outputs}


def normalize_raw_parent(txid, raw_hex, required_vouts, source="blockstream-esplora-raw"):
    parsed = parse_transaction(bytes.fromhex(raw_hex))
    if parsed.txid != txid:
        raise ValueError(f"raw parent txid mismatch {txid}")
    outputs = {}
    for vout in required_vouts:
        if vout < 0 or vout >= len(parsed.outputs):
            raise ValueError(f"missing parent outpoint {txid}:{vout}")
        value, script = parsed.outputs[vout]
        outputs[vout] = {"value_sats": value, "script_hex": script.hex(), "address": script_address(script)}
    return {"txid": txid, "raw_hex": raw_hex, "source": source, "outputs": outputs}


def save_parent(db, parent):
    db.execute("INSERT OR REPLACE INTO parents VALUES (?, ?, ?)",
               (parent["txid"], parent["raw_hex"], parent["source"]))
    for vout, output in parent["outputs"].items():
        db.execute("INSERT OR REPLACE INTO prevouts VALUES (?, ?, ?, ?, ?)",
                   (parent["txid"], vout, output["value_sats"], output["script_hex"], output["address"]))


def rpc_batch(txids):
    body = json.dumps([{"jsonrpc": "2.0", "id": n, "method": "getrawtransaction", "params": [txid, True]}
                       for n, txid in enumerate(txids)]).encode()
    for attempt in range(8):
        try:
            request = Request(RPC_URL, body, {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=90) as response:
                replies = json.load(response)
            if not isinstance(replies, list) or len(replies) != len(txids):
                raise ValueError("RPC batch response count mismatch")
            by_id = {item["id"]: item for item in replies}
            if set(by_id) != set(range(len(txids))):
                raise ValueError("RPC batch IDs mismatch")
            results = []
            for n, txid in enumerate(txids):
                reply = by_id[n]
                if reply.get("error"):
                    raise ValueError(f"RPC could not resolve parent {txid}: {reply['error']}")
                core = reply["result"]
                if core["txid"] != txid or core.get("in_active_chain") is False:
                    raise ValueError(f"RPC returned wrong or noncanonical parent {txid}")
                results.append(core)
            return results
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            if attempt == 7:
                raise RuntimeError(f"parent RPC batch failed: {error}") from error
            retry_after = error.headers.get("Retry-After") if isinstance(error, HTTPError) else None
            delay = max(30, int(retry_after) if retry_after and retry_after.isdigit() else 0) if isinstance(error, HTTPError) and error.code == 429 else min(2 ** attempt, 16)
            time.sleep(delay)
    raise AssertionError("unreachable")


def esplora_raw(txid, provider="blockstream"):
    request = Request(f"{ESPLORA_URLS[provider]}/tx/{txid}/hex", headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(8):
        try:
            with urlopen(request, timeout=30) as response:
                raw_hex = response.read().decode("ascii").strip()
            if parse_transaction(bytes.fromhex(raw_hex)).txid != txid:
                raise ValueError(f"Esplora raw parent txid mismatch {txid}")
            return raw_hex
        except (HTTPError, URLError, TimeoutError) as error:
            if attempt == 7:
                raise RuntimeError(f"Esplora parent fetch failed {txid}: {error}") from error
            retry_after = error.headers.get("Retry-After") if isinstance(error, HTTPError) else None
            delay = max(30, int(retry_after) if retry_after and retry_after.isdigit() else 0) if isinstance(error, HTTPError) and error.code == 429 else min(2 ** attempt, 16)
            time.sleep(delay)
    raise AssertionError("unreachable")


def check_coverage(archive, db, require_all=True):
    events = event_inputs(archive)
    refs = references(events)
    raw_parents = db.execute("SELECT txid, raw_hex, source FROM parents").fetchall()
    parsed = {}
    sources = defaultdict(int)
    for txid, raw_hex, source in raw_parents:
        tx = parse_transaction(bytes.fromhex(raw_hex))
        if tx.txid != txid:
            raise ValueError(f"parent txid mismatch {txid}")
        parsed[txid] = tx
        sources[source] += 1
    normalized = {(txid, vout): (value, script_hex, address)
                  for txid, vout, value, script_hex, address in db.execute(
                      "SELECT txid, vout, value_sats, script_hex, address FROM prevouts")}
    expected = {(txid, vout) for txid, vouts in refs.items() for vout in vouts}
    if require_all and (set(parsed) != set(refs) or set(normalized) != expected):
        raise ValueError("missing or unexpected parent transaction/outpoint rows")
    missing = []
    for txid, vouts in refs.items():
        for vout in vouts:
            row = normalized.get((txid, vout))
            parent = parsed.get(txid)
            if row is None or parent is None or vout >= len(parent.outputs):
                missing.append((txid, vout))
                continue
            value, script = parent.outputs[vout]
            if row[:2] != (value, script.hex()):
                raise ValueError(f"parent value or script mismatch {txid}:{vout}")
            derived_address = script_address(script)
            if derived_address is not None and row[2] != derived_address:
                raise ValueError(f"parent address mismatch {txid}:{vout}")
    if missing and require_all:
        raise ValueError(f"missing {len(missing)} parent outpoints; first={missing[0][0]}:{missing[0][1]}")
    matched = mismatched = absent = 0
    examples = []
    for event in events:
        if not event["from_address"]:
            continue
        txid, vout = event["inputs"][0]
        observed = normalized.get((txid, vout))
        if observed is None:
            absent += 1
        elif observed[2] == event["from_address"]:
            matched += 1
        else:
            mismatched += 1
            examples.append({"event_txid": event["txid"], "kind": event["kind"],
                             "api_from": event["from_address"], "first_input_address": observed[2]})
    return {"events": len(events), "inputs": sum(len(event["inputs"]) for event in events),
            "parent_transactions": len(refs), "parent_sources": dict(sorted(sources.items())),
            "missing": len(missing), "wrong": 0,
            "api_from_matches_first_input": matched, "api_from_differs_first_input": mismatched,
            "api_from_first_input_unavailable": absent, "mismatch_examples": examples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--source", choices=("core", "esplora"), default="core")
    parser.add_argument("--esplora-provider", choices=tuple(ESPLORA_URLS), default="blockstream")
    parser.add_argument("--check", action="store_true", help="verify saved artifact entirely offline")
    args = parser.parse_args()
    db_target = f"file:{args.output}?mode=ro" if args.check else args.output
    with sqlite3.connect(f"file:{args.archive}?mode=ro", uri=True) as archive, sqlite3.connect(db_target, uri=args.check) as db:
        db.execute("PRAGMA foreign_keys=ON")
        if not args.check:
            create_tables(db)
            refs = references(event_inputs(archive))
            existing = {row[0] for row in db.execute("SELECT txid FROM parents")}
            archived = {txid: json.loads(raw) for txid, raw in archive.execute("SELECT txid, raw_json FROM transactions")}
            with db:
                db.executemany("UPDATE parents SET source='event-archive-core' WHERE txid=?",
                               ((txid,) for txid in refs.keys() & archived.keys()))
            for txid in sorted(refs.keys() & archived.keys() - existing):
                with db:
                    save_parent(db, normalize_parent(archived[txid], refs[txid], "event-archive-core"))
            remaining = sorted(refs.keys() - set(archived) - existing)
            if args.source == "core":
                for start in range(0, len(remaining), BATCH_SIZE):
                    batch = remaining[start:start + BATCH_SIZE]
                    fetched = rpc_batch(batch)
                    with db:
                        for core in fetched:
                            save_parent(db, normalize_parent(core, refs[core["txid"]]))
                    print(f"fetched {min(start + len(batch), len(remaining))}/{len(remaining)} external parent transactions", flush=True)
                    time.sleep(2)
            else:
                completed = 0
                with ThreadPoolExecutor(max_workers=2) as workers:
                    futures = {workers.submit(esplora_raw, txid, args.esplora_provider): txid for txid in remaining}
                    for future in as_completed(futures):
                        txid = futures[future]
                        with db:
                            save_parent(db, normalize_raw_parent(txid, future.result(), refs[txid],
                                                                 f"{args.esplora_provider}-esplora-raw"))
                        completed += 1
                        if completed % 50 == 0 or completed == len(remaining):
                            print(f"fetched {completed}/{len(remaining)} external parent transactions", flush=True)
        report = check_coverage(archive, db)
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("parent artifact failed SQLite integrity check")
        rendered = json.dumps(report, sort_keys=True, indent=2) + "\n"
        if args.check:
            if not args.report.exists() or args.report.read_text() != rendered:
                raise ValueError("parent provenance report differs from offline recomputation")
        else:
            args.report.write_text(rendered)
        print(json.dumps({key: value for key, value in report.items() if key != "mismatch_examples"}, sort_keys=True))


if __name__ == "__main__":
    main()
