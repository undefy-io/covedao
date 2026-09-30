import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))
from crc_block_order import (  # noqa: E402
    DEFAULT_ARCHIVE,
    DEFAULT_OUTPUT,
    check_coverage,
    create_tables,
    merkle_levels,
    normalize_block,
    save_block,
    sha256d,
)


TX_A = "01" * 32
TX_B = "02" * 32
TXIDS = ["ff" * 32, TX_B, TX_A]
ROOT = merkle_levels(TXIDS)[-1][0][::-1].hex()
HEADER_HEX = (bytes.fromhex("01000000" + "00" * 32)
              + bytes.fromhex(ROOT)[::-1]
              + bytes.fromhex("00000000ffff001d00000000")).hex()
HASH = sha256d(bytes.fromhex(HEADER_HEX))[::-1].hex()
OTHER_HASH = "cd" * 32


class BlockOrderTests(unittest.TestCase):
    def setUp(self):
        self.archive = sqlite3.connect(":memory:")
        self.archive.executescript("""
            CREATE TABLE events(event_index INTEGER PRIMARY KEY, txid TEXT, block_hash TEXT, block_height INTEGER);
            CREATE TABLE transactions(txid TEXT PRIMARY KEY, block_hash TEXT, block_height INTEGER);
        """)
        self.archive.executemany("INSERT INTO events VALUES (?, ?, ?, ?)",
                                 [(0, TX_A, HASH, 100), (1, TX_B, HASH, 100)])
        self.archive.executemany("INSERT INTO transactions VALUES (?, ?, ?)",
                                 [(TX_A, HASH, 100), (TX_B, HASH, 100)])
        self.db = sqlite3.connect(":memory:")
        create_tables(self.db)
        self.block = normalize_block({"hash": HASH, "height": 100, "confirmations": 5,
                                      "merkleroot": ROOT, "tx": TXIDS}, HASH, 100, HEADER_HEX)
        save_block(self.db, self.block, [(TX_A, HASH), (TX_B, HASH)])
        self.archive.commit()

    def tearDown(self):
        self.archive.close()
        self.db.close()

    def test_consensus_order_overrides_api_event_order(self):
        result = check_coverage(self.archive, self.db)
        self.assertEqual(result["events"], 2)
        self.assertEqual(result["blocks"], 1)
        self.assertEqual(dict(self.db.execute("SELECT txid, tx_index FROM event_positions")),
                         {TX_A: 2, TX_B: 1})

    def test_wrong_hash_height_and_noncanonical_block_rejected(self):
        for changes, error in [({"hash": OTHER_HASH}, "hash"),
                               ({"height": 101}, "height"),
                               ({"confirmations": -1}, "active")]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, error):
                normalize_block({**{"hash": HASH, "height": 100, "confirmations": 5,
                                    "merkleroot": ROOT, "tx": TXIDS}, **changes}, HASH, 100, HEADER_HEX)

    def test_missing_and_duplicate_event_txid_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            normalize_block({"hash": HASH, "height": 100, "confirmations": 5,
                             "merkleroot": ROOT, "tx": [TX_A]}, HASH, 100, HEADER_HEX, [TX_A, TX_B])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            normalize_block({"hash": HASH, "height": 100, "confirmations": 5,
                             "merkleroot": ROOT, "tx": [TX_A, TX_B, TX_A]}, HASH, 100, HEADER_HEX)
        self.archive.execute("INSERT INTO events VALUES (2, ?, ?, ?)", (TX_A, HASH, 100))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            check_coverage(self.archive, self.db)

    def test_offline_check_detects_missing_or_moved_event(self):
        branch = self.db.execute("SELECT merkle_branch FROM event_positions WHERE txid=?", (TX_B,)).fetchone()[0]
        self.db.execute("DELETE FROM event_positions WHERE txid=?", (TX_B,))
        with self.assertRaisesRegex(ValueError, "missing"):
            check_coverage(self.archive, self.db)
        self.db.execute("INSERT INTO event_positions VALUES (?, ?, ?, ?, ?)", (TX_B, HASH, 100, 0, branch))
        with self.assertRaisesRegex(ValueError, "proof"):
            check_coverage(self.archive, self.db)
        self.db.execute("UPDATE event_positions SET tx_index=1 WHERE txid=?", (TX_B,))
        self.archive.execute("UPDATE events SET block_hash=? WHERE txid=?", (OTHER_HASH, TX_B))
        with self.assertRaisesRegex(ValueError, "block"):
            check_coverage(self.archive, self.db)

    def test_wrong_header_or_proof_rejected_offline(self):
        self.db.execute("UPDATE blocks SET header_hex='00' WHERE block_hash=?", (HASH,))
        with self.assertRaisesRegex(ValueError, "header"):
            check_coverage(self.archive, self.db)
        self.db.execute("UPDATE blocks SET header_hex=? WHERE block_hash=?", (HEADER_HEX, HASH))
        self.db.execute("UPDATE event_positions SET merkle_branch=? WHERE txid=?", (b"\x00" * 64, TX_A))
        with self.assertRaisesRegex(ValueError, "proof"):
            check_coverage(self.archive, self.db)

    def test_offline_cli_check(self):
        from crc_block_order import main

        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "events.sqlite"
            output = Path(directory) / "blocks.sqlite"
            with sqlite3.connect(archive) as db:
                self.archive.backup(db)
            with sqlite3.connect(output) as db:
                self.db.backup(db)
            self.assertEqual(main(["--archive", str(archive), "--output", str(output), "--check"]), 0)

    def test_full_archived_corpus_offline(self):
        if not DEFAULT_OUTPUT.exists():
            self.skipTest("run crc_block_order.py to generate block-order artifact")
        with sqlite3.connect(DEFAULT_ARCHIVE) as archive, sqlite3.connect(DEFAULT_OUTPUT) as db:
            report = check_coverage(archive, db)
            self.assertEqual(report["events"], 1950)
            self.assertEqual(report["blocks"], 624)
            hash_ = "0000000000000000000111f15dcd5671d92531e8c63ec5550142fa18479886f5"
            txids = [row[0] for row in db.execute(
                "SELECT txid FROM event_positions WHERE block_hash=? ORDER BY tx_index", (hash_,))]
            self.assertEqual(len(txids), 55)
            self.assertEqual(len(set(txids)), 55)
            positions = dict(db.execute("SELECT txid, tx_index FROM event_positions WHERE block_hash=?", (hash_,)))
            self.assertEqual(positions["09ee82c24073dcabec36ad5a761d5be4f46c307ed186e0a922e3faa7aa218ca2"], 3041)
            self.assertEqual(positions["0e45c5610a10fdcf1d6244a358cf353fdc485882a48455a8fdbb7a93b2d526ae"], 2795)


if __name__ == "__main__":
    unittest.main()
