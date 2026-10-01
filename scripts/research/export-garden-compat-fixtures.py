#!/usr/bin/env python3
"""Export focused compatibility observations from the archived Garden SQLite database."""

import argparse
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
FIXTURES = ROOT / "packages/crc20-transactions/test/fixtures"


def rows(connection):
    btc = [
        {"txid": txid, "recipient": recipient, "paymentSats": int(payment)}
        for txid, recipient, payment in connection.execute(
            """SELECT txid, to_address, mint_payment_amount_atoms
               FROM events WHERE kind='mint' AND mint_payment_asset='BTC'
               ORDER BY txid"""
        )
    ]
    transfers = [
        {
            "txid": txid,
            "sender": sender,
            "recipient": recipient,
            "amountAtoms": amount,
            "paymentSats": sats,
        }
        for txid, sender, recipient, amount, sats in connection.execute(
            """SELECT e.txid, e.from_address, e.to_address, e.amount_atoms,
                      payout.value_sats
               FROM events e
               JOIN outputs marker ON marker.txid=e.txid AND marker.vout=1
               JOIN outputs payout ON payout.txid=e.txid AND payout.vout=0
               WHERE e.kind='transfer'
                 AND json_extract(marker.op_return_json, '$.op')='transfer'
                 AND payout.address=e.from_address AND payout.value_sats>0
               ORDER BY e.txid"""
        )
    ]
    assert len(btc) == 159, len(btc)
    assert len(transfers) == 743, len(transfers)
    return {
        "garden-btc-mints.json": btc,
        "garden-payment-transfers.json": transfers,
    }


def check_raw_transactions(connection):
    path = ROOT / "packages/crc20-base/test/fixtures/leaf-mainnet.json"
    fixture = json.loads(path.read_text())
    database = {
        txid: (kind, recipient, amount, json.loads(raw)["hex"])
        for txid, kind, recipient, amount, raw in connection.execute(
            """SELECT e.txid, e.kind, e.to_address, e.amount_atoms, t.raw_json
               FROM events e JOIN transactions t USING (txid)"""
        )
    }
    if len(fixture) != 1950 or len(database) != 1950:
        raise SystemExit("Garden raw transaction corpus is incomplete")
    for item in fixture:
        expected = database.pop(item["txid"], None)
        actual = (item["kind"], item["toAddress"], item["amountAtoms"], item["hex"])
        if expected != actual:
            raise SystemExit(f"Garden raw fixture differs from SQLite: {item['txid']}")
    if database:
        raise SystemExit("Garden raw fixture is missing SQLite transactions")
    print("leaf-mainnet.json: 1950 raw transactions match SQLite")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with sqlite3.connect(DATABASE) as connection:
        fixtures = rows(connection)
        if args.check:
            check_raw_transactions(connection)
    for name, data in fixtures.items():
        path = FIXTURES / name
        if args.check:
            if json.loads(path.read_text()) != data:
                raise SystemExit(f"outdated Garden fixture: {path}")
        else:
            path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        print(f"{name}: {len(data)} observations")


if __name__ == "__main__":
    main()
