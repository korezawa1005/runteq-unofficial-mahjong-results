#!/usr/bin/env python3
"""半荘記録をターミナル終了後も動く状態で起動する。"""
import fcntl
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
URL = "http://127.0.0.1:8010"
OPENER = build_opener(ProxyHandler({}))


def healthy():
    try:
        with OPENER.open(URL + "/api/state", timeout=2) as response:
            return response.status == 200 and isinstance(json.load(response).get("players"), list)
    except (OSError, ValueError, AttributeError):
        return False


def main():
    DATA.mkdir(exist_ok=True)
    with (DATA / "start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if healthy():
            print(f"半荘記録は起動しています: {URL}")
            return 0
        with socket.socket() as sock:
            sock.settimeout(2)
            if sock.connect_ex(("127.0.0.1", 8010)) == 0:
                print("ポート8010は別の処理が使用しています。", file=sys.stderr)
                return 1
        with (DATA / "server.log").open("ab", buffering=0) as log:
            process = subprocess.Popen(
                [sys.executable, "-u", str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", "8010"],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        for _ in range(50):
            if process.poll() is not None:
                break
            if healthy():
                (DATA / "server.pid").write_text(str(process.pid) + "\n")
                print(f"半荘記録を起動しました: {URL}")
                return 0
            time.sleep(.1)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        print("起動できませんでした。data/server.logを確認してください。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
