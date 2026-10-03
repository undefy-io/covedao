#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

from crc_prevouts import script_address


ROOT = Path(__file__).resolve().parents[2]
ACTIVITY = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
POSITIONS = ROOT / "artifacts/crc-garden/block-order-proofs.sqlite"
PREVOUTS = ROOT / "artifacts/crc-garden/parent-prevouts.sqlite"
TARGET = ROOT / "artifacts/crc-garden/derived-fixtures/leaf-events.json"


def main() -> None:
    activity = sqlite3.connect(ACTIVITY)
    activity.row_factory = sqlite3.Row
    positions = sqlite3.connect(POSITIONS)
    prevouts = sqlite3.connect(PREVOUTS)
    position_by_txid = {
        txid: (block_hash, height, index)
        for txid, block_hash, height, index in positions.execute(
            "SELECT txid, block_hash, block_height, tx_index FROM event_positions"
        )
    }
    events = list(
        activity.execute(
            "SELECT e.txid, e.block_height, e.kind, e.tick, e.from_address, e.to_address, e.amount_atoms, t.raw_json FROM events e JOIN transactions t USING (txid)"
        )
    )
    if len(events) != 1950 or len(position_by_txid) != len(events):
        raise ValueError("archive and verified block positions are incomplete")
    fixture = []
    for event in events:
        txid = event["txid"]
        if txid not in position_by_txid:
            raise ValueError(f"missing verified position for {txid}")
        block_hash, height, index = position_by_txid[txid]
        if height != event["block_height"]:
            raise ValueError(f"height mismatch for {txid}")
        first_input = json.loads(event["raw_json"])["vin"][0]
        source = prevouts.execute(
            "SELECT script_hex, address FROM prevouts WHERE txid = ? AND vout = ?",
            (first_input["txid"], first_input["vout"]),
        ).fetchone()
        if source is None:
            raise ValueError(f"missing first input prevout for {txid}")
        first_input_address = script_address(bytes.fromhex(source[0]))
        if not first_input_address or first_input_address != source[1]:
            raise ValueError(f"unverified first input address for {txid}")
        outputs = [
            {"valueSats": value, "scriptHex": script}
            for value, script in activity.execute(
                "SELECT value_sats, script_hex FROM outputs WHERE txid = ? ORDER BY vout", (txid,)
            )
        ]
        fixture.append(
            {
                "txid": txid,
                "height": height,
                "index": index,
                "blockHash": block_hash,
                "kind": event["kind"],
                "ticker": event["tick"],
                "from": event["from_address"],
                "firstInputAddress": first_input_address,
                "to": event["to_address"],
                "amount": event["amount_atoms"],
                "outputs": outputs,
            }
        )
    fixture.sort(key=lambda item: (item["height"], item["index"]))
    if len(set((item["height"], item["index"]) for item in fixture)) != len(fixture):
        raise ValueError("duplicate block transaction position")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
    print(f"wrote {len(fixture)} events in verified block order to {TARGET}")


if __name__ == "__main__":
    main()
