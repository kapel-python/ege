#!/usr/bin/env python3
"""OCC regression for independent state domains.

Two tabs read one version. The first appends an attempt, the stale second write
gets 409 without altering history, then a fresh write advances the version.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_server_occ", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def client():
    jar = CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def attempt(task_id: str, correct: bool, ts: int):
    return {"taskId": task_id, "skill": "n01_planimetry", "correct": correct,
            "hintLevel": 0, "seconds": 10, "ts": ts}


def main():
    with tempfile.TemporaryDirectory(prefix="ege-occ-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            tab_a, jar_a = client()
            status, boot = request(tab_a, base, "/api/bootstrap")
            assert status == 200, (status, boot)
            state_a = boot["state"]
            assert state_a["stateVersion"] == 1, state_a

            tab_b, jar_b = client()
            for cookie in jar_a:
                jar_b.set_cookie(cookie)
            status, boot_b = request(tab_b, base, "/api/bootstrap")
            assert status == 200 and boot_b["state"]["stateVersion"] == 1, (status, boot_b)
            state_b = boot_b["state"]

            status, saved_a = request(tab_a, base, "/api/events/attempts", "POST", {
                "subject": state_a["subject"], "expectedVersion": state_a["stateVersion"],
                "events": [attempt("n01_p1", True, 1700000000000)],
            })
            assert status == 200 and saved_a["stateVersion"] == 2, (status, saved_a)

            status, conflict = request(tab_b, base, "/api/events/attempts", "POST", {
                "subject": state_b["subject"], "expectedVersion": state_b["stateVersion"],
                "events": [attempt("n01_p2", False, 1700000001000)],
            })
            assert status == 409, (status, conflict)
            assert conflict["expectedVersion"] == 1 and conflict["currentVersion"] == 2, conflict

            status, after_conflict = request(tab_a, base, "/api/bootstrap")
            assert status == 200, (status, after_conflict)
            ids = [item["taskId"] for item in after_conflict["state"]["taskAttempts"]]
            assert ids == ["n01_p1"], ids
            assert after_conflict["state"]["stateVersion"] == 2, after_conflict["state"]

            status, saved_b = request(tab_a, base, "/api/events/attempts", "POST", {
                "subject": state_a["subject"], "expectedVersion": 2,
                "events": [attempt("n01_p2", False, 1700000001000)],
            })
            assert status == 200 and saved_b["stateVersion"] == 3, (status, saved_b)
            print("OCC domain regression OK: stale event=409, history preserved, version 1→2→3")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
