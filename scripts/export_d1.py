#!/usr/bin/env python3
"""ローカルSQLiteの本番移行用SQLを生成する。"""
import argparse
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parents[1]


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def insert(table, columns, rows):
    lines = []
    for row in rows:
        values = ",".join(literal(row[column]) for column in columns)
        lines.append(f"INSERT OR REPLACE INTO {table}({','.join(columns)}) VALUES({values});")
    return lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default=ROOT / "data" / "results.sqlite3", type=Path)
    parser.add_argument("--output", default=ROOT / "data" / "d1-import.sql", type=Path)
    args = parser.parse_args()
    db = sqlite3.connect(args.database)
    db.row_factory = sqlite3.Row
    try:
        statements = ["PRAGMA foreign_keys=ON;"]
        statements += insert("players", ["id", "name", "created_at", "archived"], db.execute("SELECT id,name,created_at,archived FROM players ORDER BY created_at"))
        statements += insert("games", ["id", "played_at", "created_at"], db.execute("SELECT id,played_at,created_at FROM games ORDER BY played_at,created_at"))
        statements += insert("results", ["game_id", "player_id", "rank", "score"], db.execute("SELECT game_id,player_id,rank,score FROM results ORDER BY game_id,rank"))
        statements += insert("settings", ["key", "value"], db.execute("SELECT key,value FROM settings WHERE key IN ('admin_pin','access_pin') ORDER BY key"))
    finally:
        db.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"移行SQLを作成しました: {args.output}")


if __name__ == "__main__":
    main()
