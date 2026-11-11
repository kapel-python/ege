#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Русский язык (ОГЭ)».

Шестой предмет оси oge: 13 линий (№1–12 тестовые + №13 сочинение),
линия №12 (сжатое изложение) locked — аудио на сайте нет. Прогноз в
первичных баллах (total 20: 11 линий по 1 + сочинение 9 по критериям
И1–И3), цели-оценки g3/g4/g5. Уроки — по одному на линию (12 открытых);
сочинения ЕСТЬ (long_text + исходники в essay_texts.d, рубрика ОГЭ
И1–И3 + ГК1–ГК4, объём от 70 слов).
Проверяются API, каталог, SEO-ось /oge/ с кросс-проверкой, приём
сочинения по правилам ОГЭ (70 слов проходит, 60 — нет) и изоляция
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

RID = "oge_russian"
LOCKED_SKILLS: set[str] = {"or12_summary"}
ESSAY_SKILL = "or13_essay"
ESSAY_TASK = "oge_re13_1"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_oge_rus_subject_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None, raw=False):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            payload = response.read()
            if raw:
                return response.status, payload
            return response.status, json.loads(payload or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read() or b""
        if raw:
            return exc.code, payload
        try:
            return exc.code, json.loads(payload) if payload else {}
        except ValueError:
            return exc.code, {}


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def main():
    with tempfile.TemporaryDirectory(prefix="ege-oge-rus-") as tmp:
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
            oge = next((s for s in subjects.get("subjects", []) if s.get("id") == RID), None)
            assert oge, subjects
            assert oge.get("status") == "ready", oge
            assert oge.get("locked") is False, oge
            assert oge.get("exam") == "oge", oge
            assert set(oge.get("features", {})) == {"lessons", "practice", "forecast", "diagnostics",
                                                    "missions", "bosses", "daily", "path"}, oge
            assert all(oge["features"].values()), oge
            exams = {s.get("id"): s.get("exam") for s in subjects.get("subjects", [])}
            assert exams.get("russian") == "ege", exams
            assert all(v == "ege" for k, v in exams.items()
                       if not k.startswith("oge_")), exams

            status, boot = request(opener, base, f"/api/bootstrap?subject={RID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == RID and state["subject"] == RID

            skills = catalog.get("skills", [])
            assert len(skills) == 13, len(skills)
            by_id = {s["id"]: s for s in skills}
            locked = {sid for sid, s in by_id.items() if s.get("locked")}
            assert locked == LOCKED_SKILLS, locked
            assert all(isinstance(s.get("metadata", {}).get("hints"), list)
                       and len(s["metadata"]["hints"]) == 3
                       and all(h.strip() for h in s["metadata"]["hints"]) for s in skills), skills

            tasks = catalog.get("tasks", [])
            assert len(tasks) >= 170, len(tasks)
            task_ids = {t["id"] for t in tasks}
            per_skill: dict[str, int] = {}
            for t in tasks:
                per_skill[t["skill"]] = per_skill.get(t["skill"], 0) + 1
            # 11 открытых тестовых линий по 15 заданий + 12 сочинений;
            # locked-линия (изложение) заданий не имеет.
            assert set(per_skill) == (set(by_id) - LOCKED_SKILLS), sorted(set(by_id) ^ set(per_skill) ^ LOCKED_SKILLS)
            short = [t for t in tasks if t.get("type") == "short_answer"]
            assert len(short) == 165, len(short)
            assert all((t.get("answer") or "").strip() and (t.get("solution") or "").strip()
                       for t in short), "короткие задания без ответа/решения"
            essays = [t for t in tasks if t.get("type") == "long_text"]
            assert len(essays) == 12, len(essays)
            assert all(t["skill"] == ESSAY_SKILL and t.get("sourceTextId") for t in essays), essays

            missions = catalog.get("missions", [])
            assert {m.get("skill") for m in missions} == (set(by_id) - LOCKED_SKILLS), missions
            assert all(m.get("tasks") and all(t in task_ids for t in m["tasks"]) for m in missions), missions
            bosses = catalog.get("bosses", [])
            assert {b.get("cat") for b in bosses} == {"orge_text", "orge_lang", "orge_norms"}, bosses
            assert {g.get("id") for g in catalog.get("goals", [])} == {"g3", "g4", "g5"}, catalog.get("goals")
            diag = catalog.get("diagnosticTasks", [])
            assert len(diag) >= 5 and set(diag) <= task_ids and len(set(diag)) == len(diag), diag

            lessons = catalog.get("lessons", [])
            assert {x.get("skill") for x in lessons} == (set(by_id) - LOCKED_SKILLS), lessons
            essay_lessons = [x for x in lessons if x.get("skill") == ESSAY_SKILL]
            assert len(essay_lessons) == 1, essay_lessons
            el = essay_lessons[0]
            # Урок сочинения ОГЭ: 10 шагов (карта, лайфхак, тезис, аргументы,
            # вывод) — без INDEPENDENT_TASK: практика сочинения идёт отдельным
            # конвейером, не шагом урока.
            assert 8 <= len(el.get("steps", [])) <= 12, len(el["steps"])

            fc = catalog.get("forecast") or oge.get("forecast") or {}
            weights = fc.get("weights", {})
            assert sum(weights.values()) == 20, weights
            assert weights.get(ESSAY_SKILL) == 9, weights
            assert fc.get("total") == 20 and len(fc.get("scale", [])) == 21, fc

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={RID}")
            assert status == 200 and len(task_details.get("tasks", [])) == len(tasks), (status, task_details)
            status, lesson_details = request(opener, base, f"/api/catalog-lessons?subject={RID}")
            assert status == 200 and len(lesson_details.get("lessons", [])) == 12, (status, lesson_details)

            # Исходный текст сочинения отдаётся своему предмету (GET /api/essay-text).
            status, src = request(opener, base,
                                  f"/api/essay-text?subject={RID}&id=oge_src_40964")
            assert status == 200 and (src.get("sourceText") or {}).get("text"), (status, src)
            assert "Почему важно сделать правильный выбор" in (src.get("sourceText") or {}).get("problem", ""), src

            # SEO-ось /oge/: хаб и страница номера — 200 с подписью ОГЭ.
            status, hub = request(opener, base, f"/oge/{RID}/", raw=True)
            assert status == 200 and "ОГЭ".encode() in hub, (status, len(hub))
            assert "ЕГЭ по".encode() not in hub, "ось перепутана"
            status, oge_index = request(opener, base, "/oge/", raw=True)
            assert status == 200 and RID.encode() in oge_index, (status, len(oge_index))
            for bad in (f"/ege/{RID}/", f"/ege/{RID}/zadanie-1/",
                        "/oge/russian/", "/oge/profile_math/"):
                status, _ = request(opener, base, bad, raw=True)
                assert status == 404, (bad, status)

            # Изоляция состояния при переключении туда-обратно.
            # Онбординг пройден (заявка /api/profile/claim) — только после
            # этого в базе есть пользователь и доступны пишущие домены.
            status, profile = request(opener, base, "/api/bootstrap?subject=russian")
            assert status == 200, (status, profile)
            status, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "russian", "onboarded": True, "name": "ОГЭ гость",
                "selfLevel": "base", "goal": "g60",
            })
            assert status == 200, (status, claimed)
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": RID})
            assert status == 200 and switched["subject"] == RID, (status, switched)
            assert switched["state"]["xp"] == 0 and switched["state"]["taskAttempts"] == [], switched
            status, settings = request(opener, base, "/api/settings", "PATCH", {
                "subject": RID, "expectedVersion": switched["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "ОГЭ гость", "goal": "g4"},
            })
            assert status == 200, (status, settings)

            # Приём сочинения по правилам ОГЭ: 70 слов проходит (у ЕГЭ — 150),
            # 60 слов — 422 с minWords=70.
            ok_text = " ".join(["слово"] * 75)
            status, accepted = request(opener, base, "/api/essays", "POST", {
                "subject": RID, "taskId": ESSAY_TASK, "skill": ESSAY_SKILL,
                "text": ok_text, "id": "essay-oge-rus-1",
            })
            assert status == 200, (status, accepted)
            assert accepted.get("minWords") == 70, accepted
            status, rejected = request(opener, base, "/api/essays", "POST", {
                "subject": RID, "taskId": ESSAY_TASK, "skill": ESSAY_SKILL,
                "text": " ".join(["слово"] * 60), "id": "essay-oge-rus-2",
            })
            assert status == 422 and rejected.get("minWords") == 70, (status, rejected)
            # В ЕГЭ-предмете порог остался 150: 100 слов не проходит.
            status, ege_rej = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_1", "skill": "russian_essay_source",
                "text": " ".join(["слово"] * 100), "id": "essay-ege-rus-1",
            })
            assert status == 422 and ege_rej.get("minWords") == 150, (status, ege_rej)

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_oge = next((s for s in public.get("subjects", []) if s.get("id") == RID), None)
            assert public_oge, public
            assert public_oge.get("counts", {}).get("tasks") == len(tasks), public_oge

            print(f"OGE russian subject integration OK: {len(tasks)} tasks (12 essays), 13 skills "
                  f"(1 locked: изложение), 12 lessons, {len(missions)} missions, essay rules 70 words")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
