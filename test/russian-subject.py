#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Русский язык».

Предмет должен существовать в общей subject-архитектуре, но пока не иметь
выдуманного учебного контента: только реальная заблокированная тема
«Итоговое сочинение».  Проверяются API, каталог, locked-состояние и
изоляция состояния при переключении туда-обратно.
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


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_russian_subject_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def topic_records(catalog: dict) -> list[dict]:
    """Поддержать нормальное Skill-представление и явный lockedTopics."""
    records = list(catalog.get("skills") or [])
    records.extend(catalog.get("lockedTopics") or catalog.get("topics") or [])
    return [x for x in records if isinstance(x, dict)]


def main():
    with tempfile.TemporaryDirectory(prefix="ege-russian-") as tmp:
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
            opener = make_device()
            status, subjects = request(opener, base, "/api/subjects")
            assert status == 200, (status, subjects)
            russian = next((s for s in subjects.get("subjects", []) if s.get("title") == "Русский язык"), None)
            assert russian, subjects
            rid = russian["id"]
            assert rid == "russian", russian
            assert russian.get("status") == "coming-soon", russian
            assert russian.get("locked") is True, russian
            assert set(russian.get("features", {})) == {"lessons", "practice", "forecast", "diagnostics", "missions", "bosses", "daily", "path"}, russian
            assert not any(russian.get("features", {}).get(k) for k in ("lessons", "practice", "forecast", "diagnostics")), russian

            status, boot = request(opener, base, f"/api/bootstrap?subject={rid}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == rid and state["subject"] == rid
            assert catalog.get("tasks", []) == [], catalog
            assert catalog.get("lessons", []) == [], catalog
            assert catalog.get("missions", []) == [], catalog
            assert catalog.get("bosses", []) == [], catalog
            assert catalog.get("diagnosticTasks", []) == [], catalog
            topics = [x for x in topic_records(catalog) if x.get("name") == "Итоговое сочинение"]
            assert len(topics) == 1, catalog
            assert topics[0].get("locked") is True or topics[0].get("status") in {"locked", "coming-soon"}, topics[0]

            status, tasks = request(opener, base, f"/api/catalog-tasks?subject={rid}")
            assert status == 200 and tasks.get("tasks") == [], (status, tasks)
            status, lessons = request(opener, base, f"/api/catalog-lessons?subject={rid}")
            assert status == 200 and lessons.get("lessons") == [], (status, lessons)

            # Переключение и запись в профиль не смешиваются с новым предметом.
            status, profile = request(opener, base, "/api/bootstrap?subject=profile_math")
            assert status == 200, (status, profile)
            pver = profile["state"]["stateVersion"]
            pskill = profile["catalog"]["skills"][0]["id"]
            status, saved = request(opener, base, f"/api/progress/{pskill}", "PATCH", {
                "subject": "profile_math", "expectedVersion": pver,
                "progress": {"progress": 42, "solved": 2, "correct": 1, "timeSec": 30},
            })
            assert status == 200, (status, saved)
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": rid})
            assert status == 200 and switched["subject"] == rid, (status, switched)
            assert switched["state"]["xp"] == 0 and switched["state"]["taskAttempts"] == [], switched
            assert switched["state"].get("skillStats", {}).get(pskill) is None, switched["state"]["skillStats"]
            status, locked_settings = request(opener, base, "/api/settings", "PATCH", {
                "subject": rid, "expectedVersion": switched["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "Русский гость"},
            })
            assert status == 200, (status, locked_settings)
            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["state"]["skillStats"][pskill]["progress"] == 42, back["state"]
            assert back["catalog"]["subject"] == "profile_math", back["catalog"]["subject"]

            # Прямой API не должен создавать учебный контент из locked-темы.
            locked_id = topics[0].get("id")
            if locked_id:
                status, _ = request(opener, base, f"/api/progress/{locked_id}", "PATCH", {
                    "subject": rid, "expectedVersion": switched["state"]["stateVersion"],
                    "progress": {"progress": 100, "solved": 1, "correct": 1, "timeSec": 1},
                })
                assert status in {400, 423}, status

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_russian = next((s for s in public.get("subjects", []) if s.get("id") == rid), None)
            assert public_russian, public
            public_counts = public_russian.get("counts", {})
            assert all(public_counts.get(key) == 0 for key in ("tasks", "lessons", "missions", "bosses", "diagnostics")), public_russian
            assert public_russian.get("status") == "locked" and public_russian.get("locked") is True, public_russian
            print("Russian subject integration OK: locked topic exists, content is empty, subject state is isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
