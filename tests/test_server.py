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


if __name__ == "__main__":
    unittest.main()
