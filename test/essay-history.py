#!/usr/bin/env python3
"""История сочинений GET /api/essays?history=1 (функции + HTTP-гейт Plus).

Функции на temp-БД без HTTP:
  * пустая история: items [], total 0, hasEssayTasks True, essaySkills —
    только живой навык каталога;
  * призрак прошлого (навык+задания, удалённые из файлов, но живые в БД
    из-за чужого прогресса): в essaySkills его нет — иначе кнопка
    «Написать следующее» уходила в пустой банк и тост вместо практики
    (живой случай: russian_essay перед russian_essay_source);
  * гость (None): пустой срез;
  * пагинация: кривой limit/offset — ValueError, а не 500.

HTTP-гейт на живом temp-сервере: «Мои сочинения» — раздел Plus.
Без подписки history=1 отвечает 403 SUBSCRIPTION_REQUIRED (практика
и экран разбора при этом остаются бесплатными: statuses=1 и точечные
чтения гейта не несут). С грантом Plus — 200 и живой навык.
"""
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
    spec = importlib.util.spec_from_file_location("ege_essay_history_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    with tempfile.TemporaryDirectory(prefix="ege-essay-hist-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
            out = server.essay_history_list(conn, 1, "russian")
            check("EMPTY items/total", out.get("items") == [] and out.get("total") == 0,
                  str({k: out.get(k) for k in ("total", "limit", "offset")}))
            check("EMPTY hasEssayTasks", out.get("hasEssayTasks") is True)
            check("EMPTY essaySkills live only", out.get("essaySkills") == ["russian_essay_source"],
                  str(out.get("essaySkills")))

            # Призрак прошлого: как продовая пара russian_essay / re_* —
            # удалён из файлов, но строка в БД жива (чужой прогресс).
            conn.execute(
                "INSERT INTO skills(id, topic_id, level_id, name, display_order, subject)"
                " VALUES ('russian_essay','russian_writing','russian','Итоговое сочинение',0,'russian')")
            conn.execute(
                "INSERT INTO tasks(id, skill_id, topic, difficulty, statement, answer,"
                " explanation, task_type, metadata_json)"
                " VALUES ('re_9_9','russian_essay','t',1,'s','a','e','long_text','{}')")
            conn.commit()
            out = server.essay_history_list(conn, 1, "russian")
            check("GHOST skill excluded", out.get("essaySkills") == ["russian_essay_source"],
                  str(out.get("essaySkills")))
            check("GHOST hasEssayTasks stays true", out.get("hasEssayTasks") is True)

            out = server.essay_history_list(conn, None, "russian")
            check("GUEST empty slice", out.get("items") == [] and out.get("total") == 0)

            for bad in ({"limit": 999}, {"limit": 0}, {"offset": -1}):
                try:
                    server.essay_history_list(conn, 1, "russian", **bad)
                    check(f"BAD {bad} -> ValueError", False, "no exception")
                except ValueError:
                    check(f"BAD {bad} -> ValueError", True)
        finally:
            conn.close()
        http_gate(server, Path(tmp) / "ege.sqlite3")
    print(f"ALL OK: {checks} checks" if not failures else f"{failures} FAILURES: {checks} checks")
    raise SystemExit(1 if failures else 0)


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read() or b"{}"
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, {}


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def http_gate(server, db_path: Path):
    """Плюс-гейт истории на живом temp-сервере (прод не трогаем)."""
    httpd = server.create_http_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        guest = make_device()
        status, data = request(guest, base, "/api/essays?history=1&subject=russian")
        check("GUEST history -> 401", status == 401, f"{status} {data}")

        user = make_device()
        status, _ = request(user, base, "/api/profile/claim", "POST",
                            {"subject": "russian", "onboarded": True, "name": "Плюс-тест"})
        check("CLAIM", status == 200)
        status, data = request(user, base, "/api/essays?history=1&subject=russian")
        check("FREE history -> 403 SUBSCRIPTION_REQUIRED",
              status == 403 and data.get("code") == "SUBSCRIPTION_REQUIRED",
              f"{status} {data}")
        # Практика и разбор остаются бесплатными: гейта нет.
        status, data = request(user, base, "/api/essays?statuses=1&subject=russian")
        check("FREE statuses -> 200 (practice intact)",
              status == 200 and isinstance(data.get("statuses"), dict), f"{status} {str(data)[:120]}")

        conn = server.connect()
        try:
            uid = conn.execute("SELECT id FROM users LIMIT 1").fetchone()["id"]
        finally:
            conn.close()
        conn = server.connect()
        try:
            server._SUB.admin_grant(conn, int(uid), "month")
        finally:
            conn.close()
        status, data = request(user, base, "/api/essays?history=1&subject=russian")
        check("PLUS history -> 200 live skill only",
              status == 200 and data.get("essaySkills") == ["russian_essay_source"],
              f"{status} {str(data.get('essaySkills'))}")
    finally:
        httpd.shutdown()


main()
