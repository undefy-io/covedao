#!/usr/bin/env python3
"""Check address debits and recipient-output spends in the archived Garden ledger."""

import json
import sqlite3
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
connection = sqlite3.connect(ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite")
connection.execute(
    "ATTACH DATABASE ? AS proof",
    (str(ROOT / "artifacts/crc-garden/block-order-proofs.sqlite"),),
)
connection.execute(
    "ATTACH DATABASE ? AS parents",
    (str(ROOT / "artifacts/crc-garden/parent-prevouts.sqlite"),),
)

events = connection.execute(
    """SELECT e.txid,e.kind,e.from_address,e.to_address,e.amount_atoms,
              e.mint_payment_asset,t.raw_json
       FROM events e JOIN transactions t USING (txid)
       JOIN proof.event_positions p USING (txid)
       ORDER BY e.block_height,p.tx_index"""
).fetchall()
assert len(events) == 1950

balances = defaultdict(int)
recipient_outputs = set()
transfers = 0
without_prior_recipient_output = 0
for txid, kind, sender, recipient, amount, payment_asset, raw in events:
    if kind == "deploy":
        continue
    atoms = int(amount)
    transaction = json.loads(raw)
    first_input = transaction["vin"][0]
    first_address = connection.execute(
        "SELECT address FROM parents.prevouts WHERE txid=? AND vout=?",
        (first_input["txid"], first_input["vout"]),
    ).fetchone()
    assert first_address and first_address[0] == sender, txid
    if kind == "mint":
        balances[recipient] += atoms
        vout = 3 if payment_asset == "LEAF" else 2 if payment_asset == "ORDI" else 1
        recipient_outputs.add((txid, vout))
        continue
    assert kind == "transfer", txid
    transfers += 1
    assert balances[sender] >= atoms, txid
    if not any((item["txid"], item["vout"]) in recipient_outputs for item in transaction["vin"]):
        without_prior_recipient_output += 1
    balances[sender] -= atoms
    balances[recipient] += atoms
    marker = connection.execute(
        """SELECT vout FROM outputs WHERE txid=? AND op_return_json IS NOT NULL
           AND json_extract(op_return_json, '$.p')='crc-20'""",
        (txid,),
    ).fetchone()
    assert marker, txid
    recipient_outputs.add((txid, marker[0] + 1))

assert transfers == 1137, transfers
assert without_prior_recipient_output == 788, without_prior_recipient_output
assert all(amount >= 0 for amount in balances.values())
print(
    "Garden address replay: 1137 transfers; "
    "788 spend no previously recorded recipient output"
)
