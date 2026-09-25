#!/usr/bin/env python3
"""RUNTEQ非公式麻雀サークル：成績表."""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SIMPLE_DATABASE_PATH", ROOT / "data" / "results.sqlite3"))
SCHEMA = """
CREATE TABLE IF NOT EXISTS players(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS games(
  id TEXT PRIMARY KEY,
  played_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results(
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 4),
  score INTEGER NOT NULL,
  PRIMARY KEY(game_id, player_id),
  UNIQUE(game_id, rank)
);
CREATE INDEX IF NOT EXISTS results_player ON results(player_id);
CREATE INDEX IF NOT EXISTS games_played ON games(played_at, created_at);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS access_sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS access_attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
"""


class AppError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        columns = {row[1] for row in db.execute("PRAGMA table_info(players)")}
        if "archived" not in columns:
            db.execute("ALTER TABLE players ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def uid():
    return secrets.token_hex(12)


def pin_hash(pin, salt=None, label="管理者PIN"):
    if not isinstance(pin, str) or not re.fullmatch(r"[0-9]{4,12}", pin):
        raise AppError(400, f"{label}は4〜12桁の数字で入力してください。")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 100_000).hex()
    return f"{salt}:{digest}"


def verify_pin(pin, stored):
    try:
        salt, expected = stored.split(":", 1)
        actual = pin_hash(pin, salt).split(":", 1)[1]
        return hmac.compare_digest(actual, expected)
    except (AttributeError, ValueError, AppError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def admin_configured(db):
    return db.execute("SELECT 1 FROM settings WHERE key='admin_pin'").fetchone() is not None


def access_configured(db):
    return db.execute("SELECT 1 FROM settings WHERE key='access_pin'").fetchone() is not None


def validate_played_at(value):
    try:
        parsed = dt.datetime.fromisoformat(value)
        if not 1900 <= parsed.year <= 2200:
            raise ValueError
    except (TypeError, ValueError):
        raise AppError(400, "対局日時を正しく入力してください。")
    return value


def validate_results(db, results, allow_archived=False):
    if not isinstance(results, list) or len(results) != 4 or not all(isinstance(x, dict) for x in results):
        raise AppError(400, "4人分の結果を入力してください。")
    player_ids = [x.get("player_id") for x in results]
    ranks = [x.get("rank") for x in results]
    scores = [x.get("score") for x in results]
    if len(set(player_ids)) != 4:
        raise AppError(400, "同じメンバーを重複して選択できません。")
    query = "SELECT id FROM players" if allow_archived else "SELECT id FROM players WHERE archived=0"
    known = {row[0] for row in db.execute(query)}
    if any(not isinstance(x, str) or x not in known for x in player_ids):
        raise AppError(400, "登録済みのメンバーを4人選んでください。")
    if any(type(x) is not int for x in ranks) or sorted(ranks) != [1, 2, 3, 4]:
        raise AppError(400, "順位は1位から4位を1人ずつ選んでください。")
    if any(type(x) is not int or x < -1_000_000 or x > 1_000_000 or x % 100 for x in scores):
        raise AppError(400, "点数は100点単位で入力してください。")
    if sum(scores) != 100_000:
        raise AppError(400, f"4人の点数合計を100,000点にしてください（現在 {sum(scores):,}点）。")
    ordered = sorted(results, key=lambda item: item["rank"])
    if any(ordered[index]["score"] < ordered[index + 1]["score"] for index in range(3)):
        raise AppError(400, "点数と順位が一致していません。高い点数の人を上位にしてください。")
    return [(item["player_id"], item["rank"], item["score"]) for item in results]


def backup_data(db):
    return {
        "format": "runteq-mahjong-backup",
        "version": 1,
        "exported_at": now(),
        "players": [dict(row) for row in db.execute("SELECT id,name,created_at,archived FROM players ORDER BY created_at,id")],
        "games": [
            {
                "id": game["id"],
                "played_at": game["played_at"],
                "created_at": game["created_at"],
                "results": [dict(row) for row in db.execute("SELECT player_id,rank,score FROM results WHERE game_id=? ORDER BY rank", (game["id"],))],
            }
            for game in db.execute("SELECT id,played_at,created_at FROM games ORDER BY played_at,created_at")
        ],
    }


def validate_backup(payload):
    if payload.get("format") != "runteq-mahjong-backup" or payload.get("version") != 1:
        raise AppError(400, "このアプリのバックアップファイルではありません。")
    players = payload.get("players")
    games = payload.get("games")
    if not isinstance(players, list) or not isinstance(games, list):
        raise AppError(400, "バックアップの内容が正しくありません。")
    if len(players) > 10_000 or len(games) > 100_000:
        raise AppError(400, "バックアップの件数が多すぎます。")
    player_ids, names = set(), set()
    normalized_players = []
    for player in players:
        if not isinstance(player, dict):
            raise AppError(400, "メンバーデータが正しくありません。")
        ident, name, created_at = player.get("id"), player.get("name"), player.get("created_at")
        archived = player.get("archived", 0)
        if not isinstance(ident, str) or not ident or ident in player_ids or not isinstance(name, str) or not 1 <= len(name.strip()) <= 20 or name.strip() in names:
            raise AppError(400, "メンバーデータが正しくありません。")
        if not isinstance(created_at, str) or type(archived) not in (bool, int) or archived not in (0, 1, False, True):
            raise AppError(400, "メンバーデータが正しくありません。")
        player_ids.add(ident)
        names.add(name.strip())
        normalized_players.append((ident, name.strip(), created_at, int(archived)))
    game_ids, normalized_games = set(), []
    for game in games:
        if not isinstance(game, dict) or not isinstance(game.get("id"), str) or not game["id"] or game["id"] in game_ids:
            raise AppError(400, "対局データが正しくありません。")
        validate_played_at(game.get("played_at"))
        if not isinstance(game.get("created_at"), str):
            raise AppError(400, "対局データが正しくありません。")
        results = game.get("results")
        if not isinstance(results, list) or len(results) != 4:
            raise AppError(400, "対局結果が正しくありません。")
        ids = [item.get("player_id") for item in results if isinstance(item, dict)]
        ranks = [item.get("rank") for item in results if isinstance(item, dict)]
        scores = [item.get("score") for item in results if isinstance(item, dict)]
        if len(ids) != 4 or len(set(ids)) != 4 or any(ident not in player_ids for ident in ids) or any(type(rank) is not int for rank in ranks) or sorted(ranks) != [1, 2, 3, 4]:
            raise AppError(400, "対局結果が正しくありません。")
        if any(type(score) is not int or score % 100 or not -1_000_000 <= score <= 1_000_000 for score in scores) or sum(scores) != 100_000:
            raise AppError(400, "対局結果の点数が正しくありません。")
        ordered = sorted(results, key=lambda item: item["rank"])
        if any(ordered[index]["score"] < ordered[index + 1]["score"] for index in range(3)):
            raise AppError(400, "対局結果の点数と順位が一致していません。")
        game_ids.add(game["id"])
        normalized_games.append((game["id"], game["played_at"], game["created_at"], [(item["player_id"], item["rank"], item["score"]) for item in results]))
    return normalized_players, normalized_games


def state(db):
    players = [dict(row) for row in db.execute("SELECT id,name,created_at,archived FROM players ORDER BY archived,created_at,id")]
    for player in players:
        player["archived"] = bool(player["archived"])
    games = []
    rows = db.execute("""
      SELECT g.id,g.played_at,g.created_at,r.player_id,r.rank,r.score,p.name
      FROM games g JOIN results r ON r.game_id=g.id JOIN players p ON p.id=r.player_id
      ORDER BY g.played_at DESC,g.created_at DESC,r.rank
    """)
    for row in rows:
        if not games or games[-1]["id"] != row["id"]:
            games.append({"id": row["id"], "played_at": row["played_at"], "created_at": row["created_at"], "results": []})
        games[-1]["results"].append({"player_id": row["player_id"], "name": row["name"], "rank": row["rank"], "score": row["score"]})
    return {"players": players, "games": games}


def read_json(handler, maximum=100_000):
    if handler.headers.get("Content-Type", "").split(";")[0] != "application/json":
        raise AppError(415, "データ形式が正しくありません。")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if length < 0 or length > maximum:
            raise ValueError
        data = json.loads(handler.rfile.read(length))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        raise AppError(400, "データを読み込めませんでした。")
    if not isinstance(data, dict):
        raise AppError(400, "データ形式が正しくありません。")
    return data


class Handler(BaseHTTPRequestHandler):
    server_version = "HanchanRecord"

    def log_message(self, fmt, *args):
        try:
            print(f"{self.command} {urlsplit(self.path).path}", flush=True)
        except (OSError, ValueError):
            pass

    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.admin_cookie is not None:
            maximum = 60 * 60 * 24 * 30 if self.admin_cookie else 0
            self.send_header("Set-Cookie", f"hanchan_admin={self.admin_cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={maximum}")
        if self.access_cookie is not None:
            maximum = 60 * 60 * 24 * 30 if self.access_cookie else 0
            self.send_header("Set-Cookie", f"hanchan_access={self.access_cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={maximum}")
        self.end_headers()
        self.wfile.write(raw)

    def serve_file(self, path):
        files = {"/": "index.html", "/app.js": "app.js", "/stats.js": "stats.js", "/styles.css": "styles.css", "/assets/rantekun.jpg": "assets/rantekun.jpg"}
        name = files.get(path)
        if not name:
            raise AppError(404, "ページが見つかりません。")
        file = ROOT / "public" / name
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(file)[0] or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def do_PATCH(self):
        self.handle_request()

    def is_admin(self, db):
        try:
            jar = cookies.SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            token = jar["hanchan_admin"].value
        except (KeyError, cookies.CookieError):
            return False
        return db.execute("SELECT 1 FROM admin_sessions WHERE token=? AND expires>?", (token_hash(token), int(time.time()))).fetchone() is not None

    def is_access(self, db):
        if not access_configured(db) or self.is_admin(db):
            return True
        try:
            jar = cookies.SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            token = jar["hanchan_access"].value
        except (KeyError, cookies.CookieError):
            return False
        return db.execute("SELECT 1 FROM access_sessions WHERE token=? AND expires>?", (token_hash(token), int(time.time()))).fetchone() is not None

    def require_access(self, db):
        if not self.is_access(db):
            raise AppError(401, "共通PINを入力してください。")

    def require_admin(self, db):
        if not self.is_admin(db):
            raise AppError(403, "管理者PINでロックを解除してください。")

    def create_admin_session(self, db):
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 60 * 60 * 24 * 30
        db.execute("DELETE FROM admin_sessions WHERE expires<=?", (int(time.time()),))
        db.execute("INSERT INTO admin_sessions VALUES(?,?)", (token_hash(token), expires))
        self.admin_cookie = token

    def create_access_session(self, db):
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 60 * 60 * 24 * 30
        db.execute("DELETE FROM access_sessions WHERE expires<=?", (int(time.time()),))
        db.execute("INSERT INTO access_sessions VALUES(?,?)", (token_hash(token), expires))
        self.access_cookie = token

    def record_pin_attempt(self, db):
        timestamp = int(time.time())
        ip = self.client_address[0]
        row = db.execute("SELECT count,reset_at FROM admin_attempts WHERE ip=?", (ip,)).fetchone()
        if row and row["reset_at"] > timestamp and row["count"] >= 10:
            raise AppError(429, "PINの入力回数が多いため、1分後にお試しください。")
        count = row["count"] + 1 if row and row["reset_at"] > timestamp else 1
        db.execute("INSERT OR REPLACE INTO admin_attempts VALUES(?,?,?)", (ip, count, timestamp + 60))
        db.commit()

    def record_access_attempt(self, db):
        timestamp = int(time.time())
        ip = self.client_address[0]
        row = db.execute("SELECT count,reset_at FROM access_attempts WHERE ip=?", (ip,)).fetchone()
        if row and row["reset_at"] > timestamp and row["count"] >= 10:
            raise AppError(429, "PINの入力回数が多いため、1分後にお試しください。")
        count = row["count"] + 1 if row and row["reset_at"] > timestamp else 1
        db.execute("INSERT OR REPLACE INTO access_attempts VALUES(?,?,?)", (ip, count, timestamp + 60))
        db.commit()

    def handle_request(self):
        self.admin_cookie = None
        self.access_cookie = None
        try:
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                if self.command != "GET":
                    raise AppError(405, "この操作はできません。")
                return self.serve_file(path)
            with connect() as db:
                if path == "/api/state" and self.command == "GET":
                    configured = access_configured(db)
                    allowed = self.is_access(db)
                    payload = state(db) if allowed else {"players": [], "games": []}
                    payload.update({"adminConfigured": admin_configured(db), "isAdmin": self.is_admin(db), "accessConfigured": configured, "hasAccess": allowed})
                    return self.send_json(200, payload)
                if self.command != "GET" and self.headers.get("X-Requested-With") != "HanchanRecord":
                    raise AppError(403, "アプリの画面から操作してください。")
                if path == "/api/access/login" and self.command == "POST":
                    if not access_configured(db):
                        raise AppError(409, "共通PINはまだ設定されていません。")
                    self.record_access_attempt(db)
                    body = read_json(self)
                    stored = db.execute("SELECT value FROM settings WHERE key='access_pin'").fetchone()[0]
                    if not verify_pin(body.get("pin"), stored):
                        raise AppError(401, "共通PINが違います。")
                    db.execute("DELETE FROM access_attempts WHERE ip=?", (self.client_address[0],))
                    self.create_access_session(db)
                    return self.send_json(200, {"ok": True})
                if path == "/api/admin/setup" and self.command == "POST":
                    if admin_configured(db):
                        raise AppError(409, "管理者PINは設定済みです。")
                    body = read_json(self)
                    pin = body.get("pin")
                    db.execute("INSERT INTO settings VALUES('admin_pin',?)", (pin_hash(pin),))
                    self.create_admin_session(db)
                    return self.send_json(201, {"ok": True})
                if path == "/api/admin/login" and self.command == "POST":
                    if not admin_configured(db):
                        raise AppError(409, "先に管理者PINを設定してください。")
                    self.record_pin_attempt(db)
                    body = read_json(self)
                    stored = db.execute("SELECT value FROM settings WHERE key='admin_pin'").fetchone()[0]
                    if not verify_pin(body.get("pin"), stored):
                        raise AppError(401, "管理者PINが違います。")
                    db.execute("DELETE FROM admin_attempts WHERE ip=?", (self.client_address[0],))
                    self.create_admin_session(db)
                    return self.send_json(200, {"ok": True})
                if path == "/api/admin/logout" and self.command == "POST":
                    try:
                        jar = cookies.SimpleCookie()
                        jar.load(self.headers.get("Cookie", ""))
                        db.execute("DELETE FROM admin_sessions WHERE token=?", (token_hash(jar["hanchan_admin"].value),))
                    except (KeyError, cookies.CookieError):
                        pass
                    self.admin_cookie = ""
                    return self.send_json(200, {"ok": True})
                if path == "/api/admin/access-pin" and self.command == "POST":
                    self.require_admin(db)
                    body = read_json(self)
                    hashed = pin_hash(body.get("pin"), label="共通PIN")
                    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('access_pin',?)", (hashed,))
                    db.execute("DELETE FROM access_sessions")
                    self.create_access_session(db)
                    return self.send_json(200, {"ok": True})
                if path == "/api/admin/change-pin" and self.command == "POST":
                    self.require_admin(db)
                    body = read_json(self)
                    hashed = pin_hash(body.get("pin"))
                    db.execute("UPDATE settings SET value=? WHERE key='admin_pin'", (hashed,))
                    db.execute("DELETE FROM admin_sessions")
                    self.create_admin_session(db)
                    return self.send_json(200, {"ok": True})
                self.require_access(db)
                if path == "/api/players" and self.command == "POST":
                    self.require_admin(db)
                    body = read_json(self)
                    name = body.get("name")
                    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 20:
                        raise AppError(400, "名前は1〜20文字で入力してください。")
                    player = {"id": uid(), "name": name.strip(), "created_at": now(), "archived": False}
                    try:
                        db.execute("INSERT INTO players(id,name,created_at,archived) VALUES(?,?,?,0)", (player["id"], player["name"], player["created_at"]))
                    except sqlite3.IntegrityError:
                        raise AppError(409, "同じ名前のメンバーが登録されています。")
                    return self.send_json(201, player)
                if path.startswith("/api/players/") and self.command == "PATCH":
                    self.require_admin(db)
                    player_id = path.removeprefix("/api/players/")
                    current = db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
                    if not current:
                        raise AppError(404, "メンバーが見つかりません。")
                    body = read_json(self)
                    name = body.get("name", current["name"])
                    archived = body.get("archived", bool(current["archived"]))
                    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 20:
                        raise AppError(400, "名前は1〜20文字で入力してください。")
                    if type(archived) is not bool:
                        raise AppError(400, "メンバーの状態が正しくありません。")
                    try:
                        db.execute("UPDATE players SET name=?,archived=? WHERE id=?", (name.strip(), int(archived), player_id))
                    except sqlite3.IntegrityError:
                        raise AppError(409, "同じ名前のメンバーが登録されています。")
                    return self.send_json(200, {"ok": True})
                if path == "/api/games" and self.command == "POST":
                    self.require_admin(db)
                    body = read_json(self)
                    played_at = validate_played_at(body.get("played_at"))
                    rows = validate_results(db, body.get("results"))
                    game_id = uid()
                    created_at = now()
                    db.execute("INSERT INTO games VALUES(?,?,?)", (game_id, played_at, created_at))
                    db.executemany("INSERT INTO results VALUES(?,?,?,?)", [(game_id, *row) for row in rows])
                    return self.send_json(201, {"id": game_id})
                if path.startswith("/api/games/") and self.command == "PATCH":
                    self.require_admin(db)
                    game_id = path.removeprefix("/api/games/")
                    if not db.execute("SELECT 1 FROM games WHERE id=?", (game_id,)).fetchone():
                        raise AppError(404, "対局が見つかりません。")
                    body = read_json(self)
                    played_at = validate_played_at(body.get("played_at"))
                    rows = validate_results(db, body.get("results"), allow_archived=True)
                    db.execute("UPDATE games SET played_at=? WHERE id=?", (played_at, game_id))
                    db.execute("DELETE FROM results WHERE game_id=?", (game_id,))
                    db.executemany("INSERT INTO results VALUES(?,?,?,?)", [(game_id, *row) for row in rows])
                    return self.send_json(200, {"ok": True})
                if path.startswith("/api/games/") and self.command == "DELETE":
                    self.require_admin(db)
                    game_id = path.removeprefix("/api/games/")
                    cursor = db.execute("DELETE FROM games WHERE id=?", (game_id,))
                    if cursor.rowcount != 1:
                        raise AppError(404, "対局が見つかりません。")
                    return self.send_json(200, {"ok": True})
                if path == "/api/admin/backup" and self.command == "GET":
                    self.require_admin(db)
                    return self.send_json(200, backup_data(db))
                if path == "/api/admin/restore" and self.command == "POST":
                    self.require_admin(db)
                    body = read_json(self, maximum=20_000_000)
                    players, games = validate_backup(body)
                    db.execute("DELETE FROM results")
                    db.execute("DELETE FROM games")
                    db.execute("DELETE FROM players")
                    db.executemany("INSERT INTO players(id,name,created_at,archived) VALUES(?,?,?,?)", players)
                    for game_id, played_at, created_at, results in games:
                        db.execute("INSERT INTO games(id,played_at,created_at) VALUES(?,?,?)", (game_id, played_at, created_at))
                        db.executemany("INSERT INTO results(game_id,player_id,rank,score) VALUES(?,?,?,?)", [(game_id, *row) for row in results])
                    return self.send_json(200, {"ok": True, "players": len(players), "games": len(games)})
            raise AppError(404, "ページが見つかりません。")
        except AppError as error:
            self.send_json(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            import traceback
            traceback.print_exc()
            self.send_json(500, {"error": "処理できませんでした。"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--database", help="SQLiteファイルの保存先")
    args = parser.parse_args()
    global DB_PATH
    if args.database:
        DB_PATH = Path(args.database)
    initialize()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"RUNTEQ非公式麻雀サークル：成績表: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
