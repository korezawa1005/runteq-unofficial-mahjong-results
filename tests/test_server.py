import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("simple_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = server.DB_PATH
        server.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        server.initialize()

    def tearDown(self):
        server.DB_PATH = self.previous
        self.temp.cleanup()

    def test_state_groups_four_results(self):
        with server.connect() as db:
            ids = []
            for name in "ABCD":
                ident = server.uid()
                ids.append(ident)
                db.execute("INSERT INTO players(id,name,created_at) VALUES(?,?,?)", (ident, name, server.now()))
            game_id = server.uid()
            db.execute("INSERT INTO games VALUES(?,?,?)", (game_id, "2026-09-21T12:00", server.now()))
            db.executemany("INSERT INTO results VALUES(?,?,?,?)", [(game_id, ident, rank, 50000-rank*10000) for rank, ident in enumerate(ids, 1)])
        with server.connect() as db:
            result = server.state(db)
        self.assertEqual(len(result["players"]), 4)
        self.assertFalse(result["players"][0]["archived"])
        self.assertEqual([x["rank"] for x in result["games"][0]["results"]], [1, 2, 3, 4])

    def test_pin_is_hashed_and_verified(self):
        stored = server.pin_hash("1234")
        self.assertNotIn("1234", stored)
        self.assertTrue(server.verify_pin("1234", stored))
        self.assertFalse(server.verify_pin("9999", stored))
        with self.assertRaises(server.AppError):
            server.pin_hash("12ab")

    def test_existing_database_gets_archived_column(self):
        old_path = server.DB_PATH
        server.DB_PATH = Path(self.temp.name) / "old.sqlite3"
        with server.connect() as db:
            db.execute("CREATE TABLE players(id TEXT PRIMARY KEY,name TEXT,created_at TEXT)")
        server.initialize()
        with server.connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(players)")}
        self.assertIn("archived", columns)
        server.DB_PATH = old_path

    def seed_players(self):
        with server.connect() as db:
            ids = []
            for name in "ABCD":
                ident = server.uid()
                ids.append(ident)
                db.execute("INSERT INTO players(id,name,created_at) VALUES(?,?,?)", (ident, name, server.now()))
        return ids

    def test_result_validation_accepts_ties_and_rejects_rank_score_conflict(self):
        ids = self.seed_players()
        tied = [
            {"player_id": ids[0], "rank": 1, "score": 35000},
            {"player_id": ids[1], "rank": 2, "score": 35000},
            {"player_id": ids[2], "rank": 3, "score": 20000},
            {"player_id": ids[3], "rank": 4, "score": 10000},
        ]
        with server.connect() as db:
            self.assertEqual(len(server.validate_results(db, tied)), 4)
            tied[0]["score"], tied[1]["score"] = 30000, 40000
            with self.assertRaisesRegex(server.AppError, "点数と順位"):
                server.validate_results(db, tied)

    def test_backup_contains_records_but_not_pin_settings(self):
        ids = self.seed_players()
        with server.connect() as db:
            db.execute("INSERT INTO settings VALUES('admin_pin','secret-hash')")
            game_id = server.uid()
            db.execute("INSERT INTO games VALUES(?,?,?)", (game_id, "2026-09-25T12:00", server.now()))
            scores = [40000, 30000, 20000, 10000]
            db.executemany("INSERT INTO results VALUES(?,?,?,?)", [(game_id, ident, rank, scores[rank - 1]) for rank, ident in enumerate(ids, 1)])
            backup = server.backup_data(db)
        self.assertEqual(backup["format"], "runteq-mahjong-backup")
        self.assertEqual(len(backup["players"]), 4)
        self.assertEqual(len(backup["games"]), 1)
        self.assertNotIn("settings", backup)
        players, games = server.validate_backup(backup)
        self.assertEqual((len(players), len(games)), (4, 1))


if __name__ == "__main__":
    unittest.main()
