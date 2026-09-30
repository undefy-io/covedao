import json
import sqlite3
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))
from crc_prevouts import (  # noqa: E402
    DEFAULT_ARCHIVE,
    check_coverage,
    create_tables,
    event_inputs,
    normalize_parent,
    normalize_raw_parent,
    save_parent,
    script_address,
)


class PrevoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.archive = sqlite3.connect(DEFAULT_ARCHIVE)
        cls.events = event_inputs(cls.archive)
        archived_txids = {row[0] for row in cls.archive.execute("SELECT txid FROM transactions")}
        cls.event = next(row for row in cls.events if row["kind"] == "transfer"
                         and len(row["inputs"]) > 1 and row["inputs"][0][0] in archived_txids)
        cls.parent_txid, cls.parent_vout = cls.event["inputs"][0]
        raw = cls.archive.execute("SELECT raw_json FROM transactions WHERE txid=?", (cls.parent_txid,)).fetchone()
        cls.parent = json.loads(raw[0])

    @classmethod
    def tearDownClass(cls):
        cls.archive.close()

    def test_known_parent_raw_txid_output_and_address(self):
        row = normalize_parent(self.parent, {self.parent_vout})
        from_raw = normalize_raw_parent(self.parent_txid, self.parent["hex"], {self.parent_vout})
        self.assertEqual(row["txid"], self.parent_txid)
        output = row["outputs"][self.parent_vout]
        self.assertEqual(from_raw["outputs"][self.parent_vout], output)
        self.assertEqual(output["script_hex"], self.parent["vout"][self.parent_vout]["scriptPubKey"]["hex"])
        self.assertEqual(output["address"], self.parent["vout"][self.parent_vout]["scriptPubKey"].get("address"))
        self.assertEqual(script_address(bytes.fromhex(output["script_hex"])), output["address"])
        self.assertGreaterEqual(output["value_sats"], 0)

    def test_wrong_txid_or_outpoint_is_rejected(self):
        wrong = dict(self.parent, txid="00" * 32)
        with self.assertRaisesRegex(ValueError, "txid"):
            normalize_parent(wrong, {self.parent_vout})
        with self.assertRaisesRegex(ValueError, "outpoint"):
            normalize_parent(self.parent, {len(self.parent["vout"])})

    def test_missing_or_wrong_script_fails_coverage(self):
        with sqlite3.connect(":memory:") as db:
            create_tables(db)
            save_parent(db, normalize_parent(self.parent, {self.parent_vout}))
            with self.assertRaisesRegex(ValueError, "missing"):
                check_coverage(self.archive, db)
            db.execute("UPDATE prevouts SET script_hex='00' WHERE txid=? AND vout=?", (self.parent_txid, self.parent_vout))
            with self.assertRaisesRegex(ValueError, "script"):
                check_coverage(self.archive, db, require_all=False)

    def test_wrong_address_fails_coverage(self):
        with sqlite3.connect(":memory:") as db:
            create_tables(db)
            save_parent(db, normalize_parent(self.parent, {self.parent_vout}))
            db.execute("UPDATE prevouts SET address='bc1qwrong' WHERE txid=? AND vout=?",
                       (self.parent_txid, self.parent_vout))
            with self.assertRaisesRegex(ValueError, "address"):
                check_coverage(self.archive, db, require_all=False)

    def test_every_event_input_referenced_and_first_input_label_counted(self):
        self.assertEqual(sum(len(row["inputs"]) for row in self.events), 5190)
        self.assertEqual(len({item for row in self.events for item in row["inputs"]}), 5190)
        self.assertTrue(any(row["from_address"] for row in self.events if row["kind"] == "transfer"))

    def test_complete_artifact_offline(self):
        artifact = Path(__file__).resolve().parents[2] / "artifacts/crc-garden/parent-prevouts.sqlite"
        if not artifact.exists():
            self.skipTest("run crc_prevouts.py to generate parent artifact")
        with sqlite3.connect(artifact) as db:
            report = check_coverage(self.archive, db)
            market = "8012a907a93e1faedd9e7c89bd25306db7449a2370d1b1957dc0d79011415c2a"
            raw = json.loads(self.archive.execute("SELECT raw_json FROM transactions WHERE txid=?", (market,)).fetchone()[0])
            for vin in raw["vin"][:2]:
                parent = db.execute("SELECT raw_hex FROM parents WHERE txid=?", (vin["txid"],)).fetchone()
                prevout = db.execute("SELECT value_sats, script_hex, address FROM prevouts WHERE txid=? AND vout=?",
                                     (vin["txid"], vin["vout"])).fetchone()
                self.assertIsNotNone(parent)
                self.assertIsNotNone(prevout)
                self.assertTrue(prevout[1])
                self.assertTrue(prevout[2])
        self.assertEqual(report["inputs"], 5190)
        self.assertEqual(report["missing"], 0)
        self.assertEqual(report["wrong"], 0)


if __name__ == "__main__":
    unittest.main()
