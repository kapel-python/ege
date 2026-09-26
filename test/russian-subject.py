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
            assert russian["features"]["practice"] is True and russian["features"]["missions"] is False, russian
            assert not any(russian["features"][k] for k in ("lessons", "forecast", "diagnostics", "bosses", "daily")), russian

            status, boot = request(opener, base, f"/api/bootstrap?subject={rid}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == rid and state["subject"] == rid
            tasks = catalog.get("tasks", [])
            # Два вида практики: свободные темы (итоговое) и работа с текстом
            # (задание 27, у каждого задания есть исходник).
            source_tasks = [t for t in tasks if t.get("skill") == "russian_essay_source"]
            assert len(source_tasks) == 8, len(source_tasks)
            assert len(tasks) == 8, "в предмете одна тема — работа с текстом"
            assert all(t.get("type") == "long_text" for t in tasks), catalog
            assert all(t.get("sourceTextId") for t in source_tasks), "у задания 27 без исходника"

            # Исходники читаются сервером и содержат текст без разбора.
            status, source_detail = request(opener, base, f"/api/catalog-tasks?subject={rid}")
            assert status == 200, (status, source_detail)
            detail_tasks = {t["id"]: t for t in source_detail.get("tasks", [])}
            re27 = detail_tasks["re27_1"]
            assert re27["sourceTextId"] == "src_brushtein_vybor_exam", re27
            status, source_payload = request(opener, base,
                                             f"/api/essay-text?subject={rid}&id={re27['sourceTextId']}")
            assert status == 200, (status, source_payload)
            src = source_payload["sourceText"]
            assert src["author"] and src["problem"] and len(src["text"]) > 500, src
            assert 150 <= src["wordCount"] <= 400, src
            # Каждый из 8 текстов — экзаменационная нарезка, а не целый фрагмент.
            volumes = {}
            for task in source_tasks:
                payload = request(opener, base,
                                   f"/api/essay-text?subject={rid}&id={task['sourceTextId']}")
                assert payload[0] == 200, (task["id"], payload)
                volumes[task["id"]] = payload[1]["sourceText"]["wordCount"]
            assert all(150 <= v <= 400 for v in volumes.values()), volumes
            assert len(volumes) == len(source_tasks), volumes
            # Ответ ученика (позиция автора, ключевые фрагменты) в тексте не лежит.
            for spoiler in ("Авторская позиция", "Позиция автора:", "Ключевые фрагменты",
                            "Связь между фрагментами", "Разбор текста"):
                assert spoiler not in src["text"], spoiler
            status, no_source = request(opener, base, f"/api/essay-text?subject={rid}&id=nope")
            assert status == 404, (status, no_source)
            assert catalog.get("lessons", []) == [], catalog
            missions = catalog.get("missions", [])
            assert missions == [], "миссий нет: практика идёт по теме"
            assert catalog.get("bosses", []) == [], catalog
            assert catalog.get("diagnosticTasks", []) == [], catalog
            topics = [x for x in catalog.get("skills", []) if x.get("id") == "russian_essay_source"]
            assert len(topics) == 1 and topics[0].get("ege") == "27", topics
            assert not topics[0].get("locked") and topics[0].get("status", "ready") == "ready", topics[0]
            assert not [x for x in catalog.get("skills", []) if x.get("id") == "russian_essay"], \
                "свободное сочинение без исходника убрано"

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={rid}")
            assert status == 200 and len(task_details.get("tasks", [])) == 8, (status, len(task_details.get("tasks", [])))
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
            status, progress = request(opener, base, f"/api/progress/russian_essay_source", "PATCH", {
                "subject": rid, "expectedVersion": settings["stateVersion"],
                "progress": {"progress": 10, "solved": 1, "correct": 1, "timeSec": 60},
            })
            assert status == 200, (status, progress)

            # Приём сочинения: сервер сам считает слова и отклоняет короткий текст.
            status, short = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re27_1", "skill": "russian_essay_source",
                "text": words_text(149), "id": "essay-short-1",
            })
            assert status == 422 and short.get("reason") == "essay_too_short", (status, short)
            assert short.get("wordCount") == 149 and short.get("minWords") == 150, short

            status, ok_sub = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re27_1", "skill": "russian_essay_source",
                "text": words_text(150), "id": "essay-ok-1",
            })
            assert status == 200 and ok_sub.get("ok") is True, (status, ok_sub)
            assert ok_sub.get("wordCount") == 150 and ok_sub.get("evaluationStatus") == "submitted", ok_sub

            # Идемпотентность: тот же client_id не плодит записи.
            status, again = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "re27_1", "skill": "russian_essay_source",
                "text": words_text(150), "id": "essay-ok-1",
            })
            assert status == 200, (status, again)

            # Задание без long_text не принимает длинный ответ.
            status, wrong_task = request(opener, base, "/api/essays", "POST", {
                "subject": rid, "taskId": "n01_p1", "skill": "russian_essay_source",
                "text": words_text(200), "id": "essay-wrong-task",
            })
            assert status == 400, (status, wrong_task)

            # Текст реально сохранён в essay_submissions.
            conn = server.connect()
            try:
                rows = conn.execute(
                    "SELECT COUNT(*) AS n FROM essay_submissions WHERE task_id='re27_1'").fetchone()
                assert rows["n"] == 1, rows
                stored = conn.execute(
                    "SELECT word_count, evaluation_status FROM essay_submissions WHERE task_id='re27_1'").fetchone()
                assert stored["word_count"] == 150 and stored["evaluation_status"] == "submitted", stored
            finally:
                conn.close()

            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["state"]["skillStats"][pskill]["progress"] == 42, back["state"]
            assert back["catalog"]["subject"] == "profile_math", back["catalog"]["subject"]
            # Прогресс русского не протёк в профиль.
            assert back["state"]["skillStats"].get("russian_essay_source") is None, back["state"]["skillStats"]

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_russian = next((s for s in public.get("subjects", []) if s.get("id") == rid), None)
            assert public_russian, public
            public_counts = public_russian.get("counts", {})
            assert public_counts.get("tasks") == 8, public_russian
            assert public_counts.get("skills") == 1, public_russian
            assert public_counts.get("missions") == 0, public_russian
            assert public_counts.get("lessons") == 0 and public_counts.get("bosses") == 0, public_russian

            # Наследие старой системы сочинений (skill russian_essay, миссия
            # russian_essay_practice, задания re_1_*/re_2_*/re_3_*) остаётся в
            # таблицах, пока на него ссылается чей-то прогресс: prune такие узлы
            # пропускает (см. _prune_removed_catalog_rows). В выдаче их быть не
            # должно — иначе у клиента появляются фантомные ошибки на
            # несуществующих заданиях, прогресс удалённого навыка и «выполненная»
            # миссия, которой в каталоге нет. Принудительный сброс профиля для
            # этого не нужен: строки просто не выдаются.
            # accountId заранее: запись ниже держит write-lock, а HTTP-сервер
            # в этом тесте однопоточный и ждал бы его до конца блока.
            status, boot_russian = request(opener, base, f"/api/bootstrap?subject={rid}")
            assert status == 200 and boot_russian.get("accountId"), boot_russian
            legacy = server.connect()
            try:
                legacy.execute("PRAGMA foreign_keys=OFF")
                uid_row = legacy.execute("SELECT id FROM users WHERE account_id=?",
                                         (boot_russian["accountId"],)).fetchone()
                assert uid_row is not None, boot_russian["accountId"]
                legacy_uid = uid_row["id"]
                legacy.execute(
                    "INSERT OR IGNORE INTO skills (id, topic_id, name, display_order, subject)"
                    " VALUES ('russian_essay','russian_writing','Итоговое сочинение',1,'russian')")
                for old in ("re_1_2", "re_2_1", "re_3_4"):
                    legacy.execute(
                        "INSERT OR IGNORE INTO tasks (id, skill_id, topic, statement, answer, task_type)"
                        " VALUES (?,'russian_essay','Сочинение','x','','long_text')", (old,))
                legacy.execute(
                    "INSERT OR IGNORE INTO missions (id, skill_id, title)"
                    " VALUES ('russian_essay_practice','russian_essay','Практика')")
                for old in ("re_1_2", "re_2_1", "re_3_4"):
                    legacy.execute(
                        "INSERT INTO user_errors (user_id, task_id, skill_id, topic, created_at,"
                        " resolved, subject, client_id, kind)"
                        " VALUES (?,?,'russian_essay','Сочинение',1,0,'russian',?,'major')",
                        (legacy_uid, old, f"legacy-{old}"))
                legacy.execute(
                    "INSERT INTO user_progress (user_id, subject, skill_id, progress, solved, correct, time_sec)"
                    " VALUES (?,'russian','russian_essay',17,8,3,142.8)", (legacy_uid,))
                legacy.execute(
                    "INSERT OR REPLACE INTO user_missions (user_id, subject, mission_id, progress, completed_at)"
                    " VALUES (?,'russian','russian_essay_practice',6,1)", (legacy_uid,))
                legacy.commit()
            finally:
                legacy.close()

            status, after_legacy = request(opener, base, f"/api/bootstrap?subject={rid}")
            assert status == 200, (status, after_legacy)
            legacy_state = after_legacy["state"]
            legacy_error_ids = {e["taskId"] for e in legacy_state.get("errors", [])}
            assert not (legacy_error_ids & {"re_1_2", "re_2_1", "re_3_4"}), legacy_error_ids
            assert "russian_essay" not in legacy_state.get("skillStats", {}), legacy_state.get("skillStats")
            assert legacy_state.get("skillStats", {}).get("russian_essay_source") is not None, legacy_state.get("skillStats")
            assert "russian_essay_practice" not in legacy_state.get("missionProgress", {}), legacy_state.get("missionProgress")
            assert "russian_essay_practice" not in legacy_state.get("missionsDone", {}), legacy_state.get("missionsDone")
            # Реальный прогресс по живому навыку не пострадал.
            assert legacy_state["skillStats"]["russian_essay_source"]["solved"] == 1, legacy_state["skillStats"]
            print("Russian subject integration OK: essay practice available, submissions validated and stored,"
                  " state isolated, legacy catalog leftovers hidden")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
