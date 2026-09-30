#!/usr/bin/env python3
"""Offline, transaction-first checks for the archived CRC mint examples."""

import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from crc_mint_semantics import inspect_mint, replay_mint_observations


ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "artifacts/crc-garden/activity-2026-09-30.sqlite"
FIXTURES = ROOT / "artifacts/crc-garden/golden-transactions.json"


class MintSemanticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = sqlite3.connect(f"file:{DATABASE}?mode=ro", uri=True)
        cls.db.row_factory = sqlite3.Row
        cls.fixtures = json.loads(FIXTURES.read_text())["cases"]

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_three_golden_mint_topologies(self):
        expected = {
            "BTC": (0, 1, 2, 4),
            "LEAF": (2, 3, 4, 6),
            "ORDI": (0, 2, 1, 4),
        }
        for case in self.fixtures:
            if case["api_event"]["kind"] != "mint":
                continue
            asset = case["api_event"]["mint_payment_asset"]
            with self.subTest(asset=asset):
                observed = inspect_mint(case["chain_transaction"]["outputs"])
                marker, beneficiary, vault, count = expected[asset]
                self.assertEqual((observed.marker_vout, observed.beneficiary_vout,
                                  observed.vault_vout, observed.output_count),
                                 (marker, beneficiary, vault, count))
                self.assertEqual(observed.beneficiary_address,
                                 case["api_event"]["mint_beneficiary"])
                self.assertIsNone(observed.minted_atoms)
                self.assertIsNone(observed.csv_blocks)
                self.assertEqual(observed.payment_asset_evidence,
                                 "ico-20-transfer" if asset == "LEAF" else "btc-output" if asset == "BTC" else "unknown")

    def test_replay_all_mints_and_keep_api_amounts_as_labels(self):
        report = replay_mint_observations(self.db)
        self.assertEqual(report["mint_count"], 812)
        self.assertEqual(report["asset_labels"], {"BTC": 159, "LEAF": 645, "ORDI": 8})
        self.assertEqual(report["csv_labels"], {144: 219, 1000: 149, 2100: 168, 6767: 276})
        self.assertEqual(report["status_labels"], {"allocated": 811, "clamped": 1})
        self.assertEqual(report["beneficiary_matches"], 812)
        self.assertEqual(report["btc_payment_matches"], 159)
        self.assertEqual(report["ico_payment_matches"], 645)
        self.assertEqual(report["ordi_payment_unverified"], 8)
        self.assertEqual(report["api_minted_atoms_total"], 100000000000000000)
        self.assertEqual(report["mint_amounts_on_chain"], 0)
        self.assertEqual(report["csv_blocks_in_mint_transactions"], 0)
        self.assertEqual(report["revealed_csv_spends"], {144: 172, 1000: 113})
        self.assertEqual(report["revealed_csv_maturity_failures"], 0)
        self.assertEqual(report["same_block_same_payment_different_allocation_groups"], 7)
        self.assertEqual((report["rate_only_holdout_exact"], report["rate_only_holdout_total"]), (8, 206))
        self.assertEqual(report["minted_atoms_by_asset_label"], {
            "BTC": 120058047619051,
            "LEAF": 99873765619047615,
            "ORDI": 6176333333334,
        })

    def test_corrupt_payment_and_beneficiary_are_rejected(self):
        import copy
        btc = next(c for c in self.fixtures if c["api_event"]["mint_payment_asset"] == "BTC")
        bad = copy.deepcopy(btc["chain_transaction"]["outputs"])
        bad[2]["sats"] -= 1
        observed = inspect_mint(bad)
        self.assertNotEqual(observed.btc_payment_sats,
                            int(btc["api_event"]["mint_payment_amount_atoms"]))
        bad = copy.deepcopy(btc["chain_transaction"]["outputs"])
        bad[1]["core_address"] = "changed"
        self.assertNotEqual(inspect_mint(bad).beneficiary_address,
                            btc["api_event"]["mint_beneficiary"])

    def test_csv_labels_do_not_prove_maturity(self):
        case = next(c for c in self.fixtures if c["api_event"]["kind"] == "mint")
        observed = inspect_mint(case["chain_transaction"]["outputs"])
        self.assertIsNone(observed.csv_blocks)
        self.assertIsNotNone(case["api_event"]["mint_csv_blocks"])


if __name__ == "__main__":
    unittest.main()
