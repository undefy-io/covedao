import copy
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from crc_issuance_checkpoint import (  # noqa: E402
    ARCHIVE,
    CHECKPOINT,
    ORDER,
    SUPPLY_ATOMS,
    build_checkpoint,
    digest,
    verify_checkpoint,
)


class CheckpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with sqlite3.connect(ARCHIVE) as archive, sqlite3.connect(ORDER) as order:
            cls.checkpoint = build_checkpoint(archive, order)

    def test_frozen_allocation_is_complete_and_ordered(self):
        rows = self.checkpoint["allocations"]
        self.assertEqual(len(rows), 812)
        self.assertEqual(sum(int(row["amount_atoms"]) for row in rows), SUPPLY_ATOMS)
        self.assertEqual(len({row["txid"] for row in rows}), len(rows))
        self.assertEqual([(r["height"], r["tx_index"]) for r in rows],
                         sorted((r["height"], r["tx_index"]) for r in rows))
        self.assertEqual(verify_checkpoint(self.checkpoint), SUPPLY_ATOMS)

    def test_release_artifact_matches_rebuild(self):
        self.assertEqual(json.loads(CHECKPOINT.read_text()), self.checkpoint)

    def test_tampered_amount_or_duplicate_fails(self):
        tampered = copy.deepcopy(self.checkpoint)
        tampered["allocations"][0]["amount_atoms"] = str(int(tampered["allocations"][0]["amount_atoms"]) + 1)
        with self.assertRaises(ValueError):
            verify_checkpoint(tampered)
        tampered = copy.deepcopy(self.checkpoint)
        tampered["allocations"][1]["txid"] = tampered["allocations"][0]["txid"]
        with self.assertRaises(ValueError):
            verify_checkpoint(tampered)

    def test_missing_row_or_changed_anchor_fails(self):
        tampered = copy.deepcopy(self.checkpoint)
        tampered["allocations"].pop()
        with self.assertRaises(ValueError):
            verify_checkpoint(tampered)
        tampered = copy.deepcopy(self.checkpoint)
        tampered["anchor"]["block_hash"] = "00" * 32
        with self.assertRaises(ValueError):
            verify_checkpoint(tampered)

    def test_recomputed_digest_cannot_rewrite_frozen_beneficiary(self):
        tampered = copy.deepcopy(self.checkpoint)
        tampered["allocations"][0]["beneficiary"] = "bc1qattacker"
        tampered["allocation_sha256"] = digest(tampered["allocations"])
        with self.assertRaisesRegex(ValueError, "digest"):
            verify_checkpoint(tampered)


if __name__ == "__main__":
    unittest.main()
