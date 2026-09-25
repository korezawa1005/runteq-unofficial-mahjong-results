#!/usr/bin/env python3
"""本番D1の管理者PINを、PINを履歴へ残さずリセットする。"""
import getpass
import hashlib
from pathlib import Path
import re
import secrets
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main():
    pin = getpass.getpass("新しい管理者PIN（4〜12桁の数字）: ")
    if not re.fullmatch(r"[0-9]{4,12}", pin):
        raise SystemExit("管理者PINは4〜12桁の数字で入力してください。")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 100_000).hex()
    sql_file = ROOT / "data" / ".reset-admin-pin.sql"
    sql_file.write_text(
        "INSERT INTO settings(key,value) VALUES('admin_pin','"
        + salt + ":" + digest
        + "') ON CONFLICT(key) DO UPDATE SET value=excluded.value;\nDELETE FROM admin_sessions;\nDELETE FROM admin_attempts;\n",
        encoding="utf-8",
    )
    try:
        subprocess.run(
            ["npx", "wrangler", "d1", "execute", "DB", "--remote", "--file", str(sql_file), "--yes"],
            cwd=ROOT,
            check=True,
        )
    finally:
        sql_file.unlink(missing_ok=True)
    print("管理者PINをリセットしました。")


if __name__ == "__main__":
    main()
