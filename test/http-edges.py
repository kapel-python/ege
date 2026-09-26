#!/usr/bin/env python3
"""HTTP- и reset-регрессии: регрессии на «тихие» ответы и на сброс прогресса.

1. do_PUT не имел catch-all: любой неузнанный PUT выходил из функции, не
   ответив ничего. На HTTP/1.1 с keep-alive клиент висел до таймаута вместо
   обычного 404. Проверяем именно это (таймаут = провал, а не «медленно»).
2. «Весь прогресс» у админа не удалял essay_submissions: ученик после сброса
   видел свой прежний отчёт о сочинении и мог открыть /essay/<sid> заново.

Свой temp-БД и живой сервер на временном порту; прод не трогается.
"""
from __future__ import annotations

import importlib.util
import json
import os
import socket
import tempfile
import threading
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ESSAY_TASK_ID = "re27_1"

FAILURES: list = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_BACKUP_DISABLE"] = "1"
    spec = importlib.util.spec_from_file_location("ege_http_edges", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def opener():
    return build_opener(HTTPCookieProcessor(CookieJar()))


def call(op, base: str, path: str, method: str = "GET", body: dict | None = None,
         timeout: float = 5.0):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with op.open(req, timeout=timeout) as response:
            return response.status, response.read()
    except HTTPError as error:
        with error:
            return error.code, error.read()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-http-edges-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        server.install_catalog(server.connect())

        port = free_port()
        httpd = server.create_http_server("127.0.0.1", port)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        time.sleep(0.4)
        base = f"http://127.0.0.1:{port}"
        op = opener()
        try:
            print("do_PUT must answer, not hang")
            for label, path in (("root", "/"), ("static page", "/main.html"),
                                ("unknown api", "/api/does-not-exist"),
                                ("admin api", "/api/admin/whatever")):
                try:
                    status, raw = call(op, base, path, method="PUT", body={})
                    check(f"PUT {label} -> 404", status == 404, f"got {status}")
                    check(f"PUT {label} body is json", b"error" in raw[:200], f"{raw[:80]!r}")
                except (URLError, socket.timeout, TimeoutError) as exc:
                    check(f"PUT {label} answered (no hang)", False, f"no response: {exc}")

            print("known PUT keeps its own status")
            status, _ = call(op, base, "/api/state", method="PUT", body={})
            check("PUT /api/state -> 410", status == 410, f"got {status}")

            print("other methods still answer on unknown paths")
            for method in ("DELETE", "PATCH", "POST"):
                try:
                    status, _ = call(op, base, "/api/does-not-exist", method=method, body={})
                    check(f"{method} unknown -> 404", status == 404, f"got {status}")
                except (URLError, socket.timeout, TimeoutError) as exc:
                    check(f"{method} unknown answered", False, f"no response: {exc}")

            print("admin 'all-progress' reset must clear essay submissions")
            conn = server.connect()
            try:
                conn.execute(
                    "INSERT INTO users(session_token, created_at) "
                    "VALUES ('tok-reset-1','2026-01-01')")
                user_id = conn.execute(
                    "SELECT id FROM users WHERE session_token='tok-reset-1'").fetchone()["id"]
                server.ensure_subject_rows(conn, user_id, "russian")
                conn.execute(
                    "INSERT INTO essay_submissions"
                    "(user_id, subject, task_id, skill_id, text, word_count, client_id,"
                    " evaluation_status, evaluation_result, evaluated_at, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (user_id, "russian", ESSAY_TASK_ID, "russian_essay_source",
                     "сочинение " * 40, 160, "cid-reset-1", "ready",
                     json.dumps({"total_score": 20, "max_score": 22}), 1, "2026-01-01"))
                conn.execute(
                    "INSERT INTO task_attempts(user_id, subject, task_id, skill_id, correct,"
                    " hint_level, seconds, created_at)"
                    " VALUES (?,?,?,?,1,0,5,'2026-01-01')",
                    (user_id, "russian", "n01_p1", "n01_planimetry"))
                conn.commit()

                before = conn.execute(
                    "SELECT COUNT(*) c FROM essay_submissions WHERE user_id=?",
                    (user_id,)).fetchone()["c"]
                check("essay submission is stored", before == 1, f"c={before}")

                server.admin_reset(conn, user_id, "all-progress")

                left = conn.execute(
                    "SELECT COUNT(*) c FROM essay_submissions WHERE user_id=?",
                    (user_id,)).fetchone()["c"]
                check("essay submissions cleared", left == 0, f"still {left}")
                attempts = conn.execute(
                    "SELECT COUNT(*) c FROM task_attempts WHERE user_id=?",
                    (user_id,)).fetchone()["c"]
                check("other progress cleared too", attempts == 0, f"still {attempts}")

                print("a targeted reset must still leave other subjects alone")
                conn.execute(
                    "INSERT INTO essay_submissions"
                    "(user_id, subject, task_id, skill_id, text, word_count, client_id, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (user_id, "russian", ESSAY_TASK_ID, "russian_essay_source",
                     "ещё одно сочинение " * 30, 150, "cid-reset-2", "2026-01-02"))
                conn.commit()
                server.admin_reset(conn, user_id, "errors")
                kept = conn.execute(
                    "SELECT COUNT(*) c FROM essay_submissions WHERE user_id=?",
                    (user_id,)).fetchone()["c"]
                check("targeted 'errors' reset keeps essays", kept == 1, f"c={kept}")
            finally:
                conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}/{CHECKS} — {', '.join(FAILURES[:6])}")
        return 1
    print(f"PASS: {CHECKS} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
