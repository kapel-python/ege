#!/usr/bin/env python3
"""Серия через HTTP: GET /api/streak и POST /api/streak/restore на живом
сервере с temp-БД (прод не трогается).

Сценарий: онбординг -> учёба 5/4/3 дня назад (P=3) -> статус lost с
frozenValue=3 -> restore возвращает active/3 и тратит 1 из 3 -> повторный
restore при живой серии 409 STREAK_ACTIVE -> гостю оба эндпоинта 401.
"""
from __future__ import annotations

import datetime as dt
import http.cookiejar
import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_streak_http_test", SERVER_PATH)
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


def make_device():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def msk_today() -> dt.date:
    return dt.datetime.now(ZoneInfo("Europe/Moscow")).date()


def main():
    with tempfile.TemporaryDirectory(prefix="ege-streak-http-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
            conn.commit()
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            guest, _ = make_device()
            user, _ = make_device()

            status, claimed = request(user, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Ученик",
                "selfLevel": "base", "goal": "g60",
            })
            check("онбординг", status == 200 and claimed.get("accountId"), f"{status} {claimed}")
            if status != 200:
                raise SystemExit(1)

            conn = server.connect()
            try:
                uid = conn.execute("SELECT id FROM users WHERE account_id=?",
                                   (claimed["accountId"],)).fetchone()["id"]
                for off in (-5, -4, -3):
                    d = (msk_today() + dt.timedelta(days=off)).isoformat()
                    conn.execute("INSERT OR REPLACE INTO activity_history"
                                 "(user_id,subject,activity_date,solved,correct,xp)"
                                 " VALUES(?,?,?,?,?,?)", (uid, "profile_math", d, 3, 3, 30))
                conn.commit()
            finally:
                conn.close()

            status, st = request(user, base, "/api/streak?subject=profile_math")
            check("GET статус lost", status == 200 and st.get("status") == "lost",
                  f"{status} {st}")
            check("GET прошлое значение", st.get("streak") == 0 and st.get("frozenValue") == 3,
                  str({k: st.get(k) for k in ("streak", "frozenValue")}))
            check("GET лимиты", st.get("canRestore") is True and st.get("restoresLeft") == 3
                  and st.get("restoresUsed") == 0,
                  str({k: st.get(k) for k in ("canRestore", "restoresLeft", "restoresUsed")}))

            status, res = request(user, base, "/api/streak/restore", "POST", {"subject": "profile_math"})
            check("POST restore 200", status == 200 and res.get("ok") is True, f"{status} {res}")
            check("restore вернул серию", res.get("status") == "active" and res.get("streak") == 3,
                  str({k: res.get(k) for k in ("status", "streak")}))
            check("restore потратил 1", res.get("restoresUsed") == 1 and res.get("restoresLeft") == 2,
                  str({k: res.get(k) for k in ("restoresUsed", "restoresLeft")}))

            status, st2 = request(user, base, "/api/streak?subject=profile_math")
            check("после restore active", status == 200 and st2.get("status") == "active"
                  and st2.get("streak") == 3, f"{status} {st2}")

            status, res2 = request(user, base, "/api/streak/restore", "POST", {"subject": "profile_math"})
            check("повтор при живой 409", status == 409 and res2.get("code") == "STREAK_ACTIVE",
                  f"{status} {res2}")

            status, _ = request(guest, base, "/api/streak?subject=profile_math")
            check("гость GET 401", status == 401, str(status))
            status, _ = request(guest, base, "/api/streak/restore", "POST", {"subject": "profile_math"})
            check("гость POST 401", status == 401, str(status))
        finally:
            httpd.shutdown()

    print(f"\nchecks={checks} failures={failures}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
