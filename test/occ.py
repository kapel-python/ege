#!/usr/bin/env python3
"""OCC regression: two stale clients cannot overwrite each other.

Runs against a temporary SQLite file and an in-process HTTP server. It proves:
- GET/bootstrap returns stateVersion;
- the first PUT advances it;
- a stale PUT gets 409 and changes no state;
- a fresh subsequent PUT advances the version again.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
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


def client(base: str):
    jar = CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def request(opener, base: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method="PUT" if body is not None else "GET")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def main():
    with tempfile.TemporaryDirectory(prefix="ege-occ-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            tab_a, jar_a = client(base)
            status, boot = request(tab_a, base, "/api/bootstrap")
            assert status == 200, (status, boot)
            state_a = boot["state"]
            assert state_a["stateVersion"] == 1, state_a

            # A second tab carries the same account cookie and therefore reads
            # the same version, just as a real duplicate browser tab would.
            tab_b, jar_b = client(base)
            for cookie in jar_a:
                jar_b.set_cookie(cookie)
            status, boot_b = request(tab_b, base, "/api/bootstrap")
            assert status == 200 and boot_b["state"]["stateVersion"] == 1, (status, boot_b)
            state_b = boot_b["state"]

            state_a["name"] = "fresh tab"
            state_a["expectedVersion"] = state_a["stateVersion"]
            status, saved_a = request(tab_a, base, "/api/state", state_a)
            assert status == 200 and saved_a["stateVersion"] == 2, (status, saved_a)

            # This stale snapshot must not overwrite the new name, even though
            # it contains a different profile value and the full old snapshot.
            state_b["name"] = "stale tab"
            state_b["expectedVersion"] = state_b["stateVersion"]
            status, conflict = request(tab_b, base, "/api/state", state_b)
            assert status == 409, (status, conflict)
            assert conflict["expectedVersion"] == 1 and conflict["currentVersion"] == 2, conflict

            status, after_conflict = request(tab_a, base, "/api/bootstrap")
            assert status == 200, (status, after_conflict)
            assert after_conflict["state"]["name"] == "fresh tab", after_conflict["state"]
            assert after_conflict["state"]["stateVersion"] == 2, after_conflict["state"]

            # Fast sequential saves based on the newly returned version succeed
            # and the version remains monotonic.
            fresh = after_conflict["state"]
            fresh["name"] = "second fresh write"
            fresh["expectedVersion"] = fresh["stateVersion"]
            status, saved_b = request(tab_a, base, "/api/state", fresh)
            assert status == 200 and saved_b["stateVersion"] == 3, (status, saved_b)
            print("OCC HTTP regression OK: stale PUT=409, data preserved, version 1→2→3")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
