#!/usr/bin/env python3
"""RUNTEQ非公式麻雀サークル：成績表."""
import argparse
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
"""


class AppError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


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


def pin_hash(pin, salt=None):
    if not isinstance(pin, str) or not re.fullmatch(r"[0-9]{4,12}", pin):
        raise AppError(400, "管理者PINは4〜12桁の数字で入力してください。")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 300_000).hex()
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


def read_json(handler):
    if handler.headers.get("Content-Type", "").split(";")[0] != "application/json":
        raise AppError(415, "データ形式が正しくありません。")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if length < 0 or length > 100_000:
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
        self.end_headers()
        self.wfile.write(raw)

    def serve_file(self, path):
        files = {"/": "index.html", "/app.js": "app.js", "/stats.js": "stats.js", "/styles.css": "styles.css"}
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

    def require_admin(self, db):
        if not self.is_admin(db):
            raise AppError(403, "管理者PINでロックを解除してください。")

    def create_admin_session(self, db):
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 60 * 60 * 24 * 30
        db.execute("DELETE FROM admin_sessions WHERE expires<=?", (int(time.time()),))
        db.execute("INSERT INTO admin_sessions VALUES(?,?)", (token_hash(token), expires))
        self.admin_cookie = token

    def record_pin_attempt(self, db):
        timestamp = int(time.time())
        ip = self.client_address[0]
        row = db.execute("SELECT count,reset_at FROM admin_attempts WHERE ip=?", (ip,)).fetchone()
        if row and row["reset_at"] > timestamp and row["count"] >= 10:
            raise AppError(429, "PINの入力回数が多いため、1分後にお試しください。")
        count = row["count"] + 1 if row and row["reset_at"] > timestamp else 1
        db.execute("INSERT OR REPLACE INTO admin_attempts VALUES(?,?,?)", (ip, count, timestamp + 60))
        db.commit()

    def handle_request(self):
        self.admin_cookie = None
        try:
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                if self.command != "GET":
                    raise AppError(405, "この操作はできません。")
                return self.serve_file(path)
            with connect() as db:
                if path == "/api/state" and self.command == "GET":
                    payload = state(db)
                    payload.update({"adminConfigured": admin_configured(db), "isAdmin": self.is_admin(db)})
                    return self.send_json(200, payload)
                if self.command != "GET" and self.headers.get("X-Requested-With") != "HanchanRecord":
                    raise AppError(403, "アプリの画面から操作してください。")
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
                    body = read_json(self)
                    played_at = body.get("played_at")
                    try:
                        parsed = dt.datetime.fromisoformat(played_at)
                        if not 1900 <= parsed.year <= 2200:
                            raise ValueError
                    except (TypeError, ValueError):
                        raise AppError(400, "対局日時を正しく入力してください。")
                    results = body.get("results")
                    if not isinstance(results, list) or len(results) != 4 or not all(isinstance(x, dict) for x in results):
                        raise AppError(400, "4人分の結果を入力してください。")
                    player_ids = [x.get("player_id") for x in results]
                    ranks = [x.get("rank") for x in results]
                    scores = [x.get("score") for x in results]
                    if len(set(player_ids)) != 4:
                        raise AppError(400, "同じメンバーを重複して選択できません。")
                    known = {row[0] for row in db.execute("SELECT id FROM players WHERE archived=0")}
                    if any(not isinstance(x, str) or x not in known for x in player_ids):
                        raise AppError(400, "登録済みのメンバーを4人選んでください。")
                    if sorted(ranks) != [1, 2, 3, 4] or any(type(x) is not int for x in ranks):
                        raise AppError(400, "順位は1位から4位を1人ずつ選んでください。")
                    if any(type(x) is not int or x < -1_000_000 or x > 1_000_000 or x % 100 for x in scores):
                        raise AppError(400, "点数は100点単位で入力してください。")
                    if sum(scores) != 100_000:
                        raise AppError(400, f"4人の点数合計を100,000点にしてください（現在 {sum(scores):,}点）。")
                    game_id = uid()
                    created_at = now()
                    db.execute("INSERT INTO games VALUES(?,?,?)", (game_id, played_at, created_at))
                    db.executemany("INSERT INTO results VALUES(?,?,?,?)", [(game_id, p, r, s) for p, r, s in zip(player_ids, ranks, scores)])
                    return self.send_json(201, {"id": game_id})
                if path.startswith("/api/games/") and self.command == "DELETE":
                    self.require_admin(db)
                    game_id = path.removeprefix("/api/games/")
                    cursor = db.execute("DELETE FROM games WHERE id=?", (game_id,))
                    if cursor.rowcount != 1:
                        raise AppError(404, "対局が見つかりません。")
                    return self.send_json(200, {"ok": True})
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
