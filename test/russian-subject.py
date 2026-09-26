#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Русский язык».

Предмет открыт: тема «Итоговое сочинение» доступна для практики с реальными
заданиями из официального банка ФИПИ, урока нет (practice available /
lesson unavailable). Проверяются API, каталог, unlocked-состояние и изоляция
состояния при переключении туда-обратно.
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
        return exc.code, json.loads(exc.read() or b"{}") if exc.headers.get("Content-Type", "").startswith("application/json") else {}


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def words_text(n: int) -> str:
    return " ".join(["слово"] * n)


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
            assert russian.get("status") == "ready", russian
            assert russian.get("locked") is False, russian
            assert set(russian.get("features", {})) == {"lessons", "practice", "forecast", "diagnostics", "missions", "bosses", "daily", "path"}, russian
            assert russian["features"]["practice"] is True and russian["features"]["missions"] is True, russian
            assert not any(russian["features"][k] for k in ("lessons", "forecast", "diagnostics", "bosses", "daily")), russian

            status, boot = request(opener, base, f"/api/bootstrap?subject={rid}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == rid and state["subject"] == rid
            tasks = catalog.get("tasks", [])
            assert len(tasks) == 6, catalog
            assert all(t.get("skill") == "russian_essay" for t in tasks), catalog
            assert all(t.get("type") == "long_text" for t in tasks), catalog
            assert catalog.get("lessons", []) == [], catalog
            missions = catalog.get("missions", [])
            assert len(missions) == 1 and missions[0].get("skill") == "russian_essay", catalog
            assert catalog.get("bosses", []) == [], catalog
            assert catalog.get("diagnosticTasks", []) == [], catalog
            topics = [x for x in catalog.get("skills", []) if x.get("name") == "Итоговое сочинение"]
            assert len(topics) == 1, catalog
            assert not topics[0].get("locked") and topics[0].get("status", "ready") == "ready", topics[0]

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={rid}")
            assert status == 200 and len(task_details.get("tasks", [])) == 6, (status, task_details)
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
            status, settings = request(opener, base, "/api/settings", "PATCH", {
                "subject": rid, "expectedVersion": switched["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "Русский гость"},
            })
            assert status == 200, (status, settings)

            # Практика темы доступна: запись прогресса russian_essay проходит.
            status, progress = request(opener, base, f"/api/progress/russian_essay", "PATCH", {
                "subject": rid, "expectedVersion": settings["stateVersion"],
                "progress": {"progress": 10, "solved": 1, "correct": 1, "timeSec": 60},
            })
            assert status == 200, (status, progress)

            # Приём сочинения: сервер сам считает слова и отклоняет короткий текст.
            status, short = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re_1_1", "skill": "russian_essay",
                "text": words_text(149), "id": "essay-short-1",
            })
            assert status == 422 and short.get("reason") == "essay_too_short", (status, short)
            assert short.get("wordCount") == 149 and short.get("minWords") == 150, short

            status, ok_sub = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re_1_1", "skill": "russian_essay",
                "text": words_text(150), "id": "essay-ok-1",
            })
            assert status == 200 and ok_sub.get("ok") is True, (status, ok_sub)
            assert ok_sub.get("wordCount") == 150 and ok_sub.get("evaluationStatus") == "submitted", ok_sub

            # Идемпотентность: тот же client_id не плодит записи.
            status, again = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re_1_1", "skill": "russian_essay",
                "text": words_text(150), "id": "essay-ok-1",
            })
            assert status == 200, (status, again)

            # Задание без long_text не принимает длинный ответ.
            status, wrong_task = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "n01_p1", "skill": "russian_essay",
                "text": words_text(200), "id": "essay-wrong-task",
            })
            assert status == 400, (status, wrong_task)

            # Текст реально сохранён в essay_submissions.
            conn = server.connect()
            try:
                rows = conn.execute(
                    "SELECT COUNT(*) AS n FROM essay_submissions WHERE task_id='re_1_1'").fetchone()
                assert rows["n"] == 1, rows
                stored = conn.execute(
                    "SELECT word_count, evaluation_status FROM essay_submissions WHERE task_id='re_1_1'").fetchone()
                assert stored["word_count"] == 150 and stored["evaluation_status"] == "submitted", stored
            finally:
                conn.close()

            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["state"]["skillStats"][pskill]["progress"] == 42, back["state"]
            assert back["catalog"]["subject"] == "profile_math", back["catalog"]["subject"]
            # Прогресс русского не протёк в профиль.
            assert back["state"]["skillStats"].get("russian_essay") is None, back["state"]["skillStats"]

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_russian = next((s for s in public.get("subjects", []) if s.get("id") == rid), None)
            assert public_russian, public
            public_counts = public_russian.get("counts", {})
            assert public_counts.get("tasks") == 6, public_russian
            assert public_counts.get("missions") == 1, public_russian
            assert public_counts.get("lessons") == 0 and public_counts.get("bosses") == 0, public_russian
            print("Russian subject integration OK: essay practice available, submissions validated and stored, state isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
