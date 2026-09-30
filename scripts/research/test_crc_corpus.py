#!/usr/bin/env python3
"""Offline checks for the archived mainnet CRC activity corpus."""

import json
import sqlite3
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from crc_corpus_fixtures import build_fixtures, marker, parse_transaction


ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
FIXTURES = ROOT / "artifacts/crc-garden/golden-transactions.json"


class CorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = sqlite3.connect(f"file:{DATABASE}?mode=ro", uri=True)
        cls.db.row_factory = sqlite3.Row
        cls.rows = cls.db.execute("""
            SELECT e.*, t.raw_json AS transaction_json FROM events e
            JOIN transactions t USING (txid)
            ORDER BY e.event_index
        """).fetchall()
        cls.outputs = {
            (r["txid"], r["vout"]): r for r in cls.db.execute("SELECT * FROM outputs")
        }

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_every_raw_transaction_matches_chain_identity_and_core_outputs(self):
        self.assertEqual(len(self.rows), 1950)
        self.assertEqual(len({r["txid"] for r in self.rows}), 1950)
        for row in self.rows:
            core = json.loads(row["transaction_json"])
            parsed = parse_transaction(bytes.fromhex(core["hex"]))
            with self.subTest(txid=row["txid"]):
                self.assertEqual(parsed.txid, row["txid"])
                self.assertEqual(core["txid"], row["txid"])
                self.assertEqual(core["blockhash"], row["block_hash"])
                self.assertEqual(len(parsed.outputs), len(core["vout"]))
                self.assertEqual(len(parsed.inputs), len(core["vin"]))
                for index, (value, script) in enumerate(parsed.outputs):
                    output = self.outputs[(row["txid"], index)]
                    self.assertEqual(value, output["value_sats"])
                    self.assertEqual(script.hex(), output["script_hex"])
                self.assertEqual(parsed.witness_counts, tuple(len(v.get("txinwitness", [])) for v in core["vin"]))

    def test_crc_markers_and_site_event_labels_are_separate_oracles(self):
        counts = Counter()
        marker_positions = Counter()
        for row in self.rows:
            parsed = parse_transaction(bytes.fromhex(json.loads(row["transaction_json"])["hex"]))
            outputs = [self.outputs[(row["txid"], i)] for i in range(len(parsed.outputs))]
            markers = [(i, value) for i, (_, script) in enumerate(parsed.outputs)
                       if (value := marker(script)) is not None and value.get("p") == "crc-20"]
            with self.subTest(txid=row["txid"]):
                self.assertEqual(len(markers), 1)
                marker_index, marker_json = markers[0]
                self.assertEqual(marker_json["op"], row["kind"])
                self.assertEqual(marker_json["tick"], row["tick"])
                if row["kind"] == "transfer":
                    self.assertEqual(marker_json["amt"], row["amount_atoms"])
                    self.assertLess(marker_index + 1, len(outputs))
                    self.assertEqual(outputs[marker_index + 1]["address"], row["to_address"])
                    self.assertGreater(outputs[marker_index + 1]["value_sats"], 0)
                if row["kind"] == "mint":
                    self.assertNotIn("amt", marker_json)
                    self.assertIn(row["mint_payment_asset"], ("BTC", "LEAF", "ORDI"))
                counts[row["kind"]] += 1
                marker_positions[(row["kind"], row["mint_payment_asset"], marker_index)] += 1
        self.assertEqual(counts, {"deploy": 1, "mint": 812, "transfer": 1137})
        self.assertEqual(marker_positions[("deploy", None, 0)], 1)
        self.assertEqual(marker_positions[("mint", "BTC", 0)], 159)
        self.assertEqual(marker_positions[("mint", "LEAF", 2)], 645)
        self.assertEqual(marker_positions[("mint", "ORDI", 0)], 8)
        self.assertEqual(marker_positions[("transfer", None, 0)], 314)
        self.assertEqual(marker_positions[("transfer", None, 1)], 823)

    def test_six_output_market_shape_has_distinct_signed_inputs(self):
        count = 0
        for row in self.rows:
            if row["kind"] != "transfer":
                continue
            tx = parse_transaction(bytes.fromhex(json.loads(row["transaction_json"])["hex"]))
            if len(tx.outputs) != 6:
                continue
            with self.subTest(txid=row["txid"]):
                count += 1
                self.assertGreaterEqual(len(tx.inputs), 4)
                self.assertNotEqual(tx.inputs[0], tx.inputs[1])
                self.assertGreaterEqual(tx.witness_counts[0], 1)
                self.assertGreaterEqual(tx.witness_counts[1], 1)
                self.assertGreaterEqual(tx.witness_counts[2], 2)
                self.assertIn(len(tx.witnesses[0][0]), (65, 71, 72))
                self.assertIn(len(tx.witnesses[1][0]), (65, 71, 72))
                self.assertIn(len(tx.witnesses[2][0]), (71, 72))
                self.assertNotEqual(tx.witnesses[0][0], tx.witnesses[1][0])
                self.assertGreater(tx.outputs[0][0], 0)
                self.assertEqual(tx.outputs[1][0], 0)
                self.assertGreater(tx.outputs[2][0], 0)
                self.assertGreater(tx.outputs[3][0], 0)
                self.assertGreater(tx.outputs[4][0], 0)
                self.assertGreater(tx.outputs[5][0], 0)
                self.assertEqual(self.outputs[(row["txid"], 2)]["address"], row["to_address"])
        self.assertEqual(count, 743)

    def test_golden_fixtures_are_reproducible_and_separate_oracles(self):
        generated = build_fixtures(self.db)
        self.assertEqual(generated, json.loads(FIXTURES.read_text()))
        self.assertEqual(len(generated["cases"]), 9)
        for case in generated["cases"]:
            self.assertEqual(parse_transaction(bytes.fromhex(case["raw_transaction_hex"])).txid, case["txid"])
            self.assertEqual(case["api_event"]["txid"], case["txid"])
            self.assertNotIn("api_event", case["chain_transaction"])


if __name__ == "__main__":
    unittest.main()
