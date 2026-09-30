#!/usr/bin/env python3
"""Freeze externally labeled LEAF mint amounts with explicit provenance."""

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from crc_block_order import check_coverage
from crc_mint_semantics import inspect_mint


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
ORDER = ROOT / "artifacts/crc-garden/block-order-proofs.sqlite"
CHECKPOINT = ROOT / "artifacts/crc-garden/leaf-issuance-checkpoint.json"
SUPPLY_ATOMS = 100_000_000_000_000_000
MINT_COUNT = 812
FINAL_MINT_HEIGHT = 967930
FINAL_MINT_BLOCK = "0000000000000000000062b25ebb689e0866e3f4830373311291267ede20972f"
EXPECTED_ALLOCATION_SHA256 = "5279b7acf7248d1d3bf7232e1bc5231b7078350479e730765607211a57d1d315"


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def verify_checkpoint(checkpoint):
    if checkpoint.get("format") != "crc20-leaf-external-issuance-v1":
        raise ValueError("wrong checkpoint format")
    if checkpoint.get("provenance") != "crc.garden activity API labels; not independently derived from on-chain mint markers":
        raise ValueError("checkpoint provenance missing")
    rows = checkpoint.get("allocations")
    if not isinstance(rows, list) or len(rows) != MINT_COUNT:
        raise ValueError("missing mint allocation")
    if len({row["txid"] for row in rows}) != MINT_COUNT:
        raise ValueError("duplicate mint transaction")
    positions = [(row["height"], row["tx_index"]) for row in rows]
    if positions != sorted(positions) or len(set(positions)) != MINT_COUNT:
        raise ValueError("mint allocation order invalid")
    for row in rows:
        if not isinstance(row["amount_atoms"], str) or not row["amount_atoms"].isdigit() or int(row["amount_atoms"]) <= 0:
            raise ValueError("invalid mint amount")
    if sum(int(row["amount_atoms"]) for row in rows) != SUPPLY_ATOMS:
        raise ValueError("mint supply mismatch")
    if checkpoint.get("allocation_sha256") != digest(rows) or digest(rows) != EXPECTED_ALLOCATION_SHA256:
        raise ValueError("mint allocation digest mismatch")
    final = rows[-1]
    anchor = {"height": final["height"], "block_hash": final["block_hash"], "tx_index": final["tx_index"]}
    if checkpoint.get("anchor") != anchor or anchor["height"] != FINAL_MINT_HEIGHT or anchor["block_hash"] != FINAL_MINT_BLOCK:
        raise ValueError("mint-out anchor mismatch")
    return SUPPLY_ATOMS


def build_checkpoint(archive, order):
    check_coverage(archive, order)
    positions = {txid: (block_hash, height, tx_index)
                 for txid, block_hash, height, tx_index in order.execute(
                     "SELECT txid, block_hash, block_height, tx_index FROM event_positions")}
    rows = []
    for txid, block_hash, height, beneficiary, amount, status in archive.execute(
            "SELECT txid, block_hash, block_height, mint_beneficiary, amount_atoms, mint_status "
            "FROM events WHERE kind='mint'"):
        proof = positions.get(txid)
        if proof is None or proof[:2] != (block_hash, height):
            raise ValueError(f"mint block proof missing or moved: {txid}")
        if status not in ("allocated", "clamped") or not beneficiary:
            raise ValueError(f"invalid mint site label: {txid}")
        outputs = [dict(script_hex=script, sats=sats, core_address=address)
                   for script, sats, address in archive.execute(
                       "SELECT script_hex, value_sats, address FROM outputs WHERE txid=? ORDER BY vout", (txid,))]
        if inspect_mint(outputs).beneficiary_address != beneficiary:
            raise ValueError(f"mint recipient differs from Bitcoin output: {txid}")
        rows.append({"txid": txid, "block_hash": block_hash, "height": height,
                     "tx_index": proof[2], "beneficiary": beneficiary,
                     "amount_atoms": str(amount), "site_status": status})
    rows.sort(key=lambda row: (row["height"], row["tx_index"]))
    if len(rows) != MINT_COUNT:
        raise ValueError("mint count mismatch")
    final = rows[-1]
    checkpoint = {
        "format": "crc20-leaf-external-issuance-v1",
        "provenance": "crc.garden activity API labels; not independently derived from on-chain mint markers",
        "anchor": {"height": final["height"], "block_hash": final["block_hash"], "tx_index": final["tx_index"]},
        "allocation_sha256": digest(rows),
        "allocations": rows,
    }
    verify_checkpoint(checkpoint)
    return checkpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with sqlite3.connect(ARCHIVE) as archive, sqlite3.connect(ORDER) as order:
        built = build_checkpoint(archive, order)
    if args.check:
        if json.loads(CHECKPOINT.read_text()) != built:
            raise ValueError("checkpoint differs from verified archive")
    else:
        CHECKPOINT.write_text(json.dumps(built, indent=2) + "\n")
    print(json.dumps({"mints": len(built["allocations"]), "atoms": SUPPLY_ATOMS,
                      "allocation_sha256": built["allocation_sha256"], "anchor": built["anchor"]}, sort_keys=True))


if __name__ == "__main__":
    main()
