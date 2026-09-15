#!/usr/bin/env python3
"""Domain-state API regression: append-only events and independent patches."""
from __future__ import annotations

import http.cookiejar
import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_server_domains", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def main():
    with tempfile.TemporaryDirectory(prefix="ege-domains-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        try:
            status, boot = request(opener, base, "/api/bootstrap")
            assert status == 200, (status, boot)
            version = boot["state"]["stateVersion"]
            subject = boot["state"]["subject"]
            event1 = {"taskId": "n01_p1", "skill": "n01_planimetry", "correct": True, "hintLevel": 0, "seconds": 12, "ts": 1700000000000}
            status, first = request(opener, base, "/api/events/attempts", "POST", {
                "subject": subject, "expectedVersion": version, "events": [event1],
            })
            assert status == 200 and first["stateVersion"] == version + 1, (status, first)
            event2 = {"taskId": "n01_p2", "skill": "n01_planimetry", "correct": False, "hintLevel": 1, "seconds": 8, "ts": 1700000001000}
            status, second = request(opener, base, "/api/events/attempts", "POST", {
                "subject": subject, "expectedVersion": first["stateVersion"], "events": [event2],
            })
            assert status == 200, (status, second)
            # Replaying an already accepted immutable event is idempotent, not a
            # duplicate and never a replacement of the previous history.
            status, replay = request(opener, base, "/api/events/attempts", "POST", {
                "subject": subject, "expectedVersion": second["stateVersion"], "events": [event1],
            })
            assert status == 200, (status, replay)
            status, after = request(opener, base, "/api/bootstrap")
            attempts = after["state"]["taskAttempts"]
            assert [item["taskId"] for item in attempts].count("n01_p1") == 1, attempts
            assert [item["taskId"] for item in attempts].count("n01_p2") == 1, attempts
            # Timeline is also append-only and keeps prior entries.
            status, timeline = request(opener, base, "/api/events/timeline", "POST", {
                "subject": subject, "expectedVersion": replay["stateVersion"],
                "events": [{"text": "Первое событие", "ts": 1700000002000}],
            })
            assert status == 200, (status, timeline)
            status, timeline2 = request(opener, base, "/api/events/timeline", "POST", {
                "subject": subject, "expectedVersion": timeline["stateVersion"],
                "events": [{"text": "Второе событие", "ts": 1700000003000}],
            })
            assert status == 200, (status, timeline2)
            status, after = request(opener, base, "/api/bootstrap")
            texts = [item["text"] for item in after["state"]["timeline"]]
            assert "Первое событие" in texts and "Второе событие" in texts, texts
            # Progress PATCH mutates only the addressed skill and leaves append
            # history intact.
            status, progress = request(opener, base, "/api/progress/n01_planimetry", "PATCH", {
                "subject": subject, "expectedVersion": timeline2["stateVersion"],
                "progress": {"progress": 37, "solved": 2, "correct": 1, "timeSec": 20},
            })
            assert status == 200, (status, progress)
            # Create an error entity, then resolve the same immutable row by id.
            status, error_create = request(opener, base, "/api/errors", "POST", {
                "subject": subject, "expectedVersion": progress["stateVersion"],
                "error": {"taskId": "n01_p2", "skill": "n01_planimetry", "sub": "Тест", "ts": 1700000004000},
            })
            assert status == 200 and error_create["error"]["id"], (status, error_create)
            status, error_resolve = request(opener, base, f"/api/errors/{error_create['error']['id']}", "PATCH", {
                "subject": subject, "expectedVersion": error_create["stateVersion"], "resolved": True,
            })
            assert status == 200, (status, error_resolve)
            # Activity writes a delta event and keeps the daily read model. The
            # same aggregate retry must not create a duplicate activity event.
            activity_body = {"subject": subject, "expectedVersion": error_resolve["stateVersion"],
                             "domains": {"activity": {"2023-11-14": {"solved": 2, "correct": 1, "xp": 30}}}}
            status, activity = request(opener, base, "/api/state-domains", "PATCH", activity_body)
            assert status == 200, (status, activity)
            activity_body["expectedVersion"] = activity["stateVersion"]
            status, activity_replay = request(opener, base, "/api/state-domains", "PATCH", activity_body)
            assert status == 200, (status, activity_replay)
            # Lesson, open lesson draft and mission are independent mutable
            # domains. Their patch must not rewrite append-only history.
            lesson_body = {"subject": subject, "expectedVersion": activity_replay["stateVersion"], "domains": {
                "lessonSessions": {"lesson_n07_exponential": {"idx": 1, "stepState": {}, "xp": 10}},
                "lessonAttempts": [{"lessonId": "lesson_n07_exponential", "completed": True, "firstCompletion": True, "xp": 120, "wrongAttempts": 0, "durationSec": 30, "ts": 1700000005000}],
                "completedLessons": {"lesson_n07_exponential": {"ts": 1700000005000}},
                "missionProgress": {"m-n01_planimetry": 3},
                "missionsDone": {"m-n01_planimetry": {"ts": 1700000006000}},
            }}
            status, lesson_patch = request(opener, base, "/api/state-domains", "PATCH", lesson_body)
            assert status == 200, (status, lesson_patch)
            status, settings = request(opener, base, "/api/settings", "PATCH", {
                "subject": subject, "expectedVersion": lesson_patch["stateVersion"],
                "settings": {"name": "Доменный ученик", "selfLevel": "base"},
            })
            assert status == 200, (status, settings)
            conn = server.connect()
            try:
                count = conn.execute("SELECT COUNT(*) FROM activity_events").fetchone()[0]
                assert count == 1, count
            finally:
                conn.close()
            status, after = request(opener, base, "/api/bootstrap")
            state = after["state"]
            assert state["name"] == "Доменный ученик" and state["selfLevel"] == "base", state
            assert state["lessonSessions"].get("lesson_n07_exponential", {}).get("idx") == 1, state["lessonSessions"]
            assert "lesson_n07_exponential" in state["completedLessons"], state["completedLessons"]
            assert state["missionProgress"].get("m-n01_planimetry") == 3 and "m-n01_planimetry" in state["missionsDone"], state["missionProgress"]
            assert any(item["lessonId"] == "lesson_n07_exponential" for item in state["lessonAttempts"]), state["lessonAttempts"]
            assert state["skillStats"]["n01_planimetry"]["progress"] == 37, state["skillStats"]
            assert any(item["id"] == error_create["error"]["id"] and item["resolved"] for item in state["errors"]), state["errors"]
            assert {"n01_p1", "n01_p2"}.issubset({item["taskId"] for item in state["taskAttempts"]}), state["taskAttempts"]
            assert "Первое событие" in [item["text"] for item in state["timeline"]], state["timeline"]
            # The old whole-snapshot endpoint is intentionally retired: it must
            # never regain the ability to delete and rewrite all domains.
            status, legacy = request(opener, base, "/api/state", "PUT", {"subject": subject, "expectedVersion": state["stateVersion"]})
            assert status == 410, (status, legacy)
            status, after_legacy = request(opener, base, "/api/bootstrap")
            assert {"n01_p1", "n01_p2"}.issubset({item["taskId"] for item in after_legacy["state"]["taskAttempts"]}), after_legacy["state"]
            print("Domain event/patch regression OK: independent writes never replace other domains")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
