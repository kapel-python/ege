#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Биология (ОГЭ)».

Второй предмет оси oge: 26 линий (№1–21 часть 1, №22–26 часть 2),
прогноз в первичных баллах (total 47, identity-шкала), цели-оценки g3/g4/g5.
26 уроков (по одному на линию), без сочинений. Все 26 навыков открыты: 9 figure-линий
(№1, 4, 13, 14, 16, 19–22) закрыты восстановленными рисунками
(tools/apply_oge_bio_figures.py, assets/oge_biology/).
Проверяются API, каталог, SEO-ось /oge/ с кросс-проверкой и изоляция
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

RID = "oge_biology"
LOCKED_SKILLS = set()
PART2_SKILLS = {"ob22_biorole", "ob23_scimethod",
                "ob24_biotext", "ob25_biostat", "ob26_energy"}
PART2_POINTS = {"ob22_biorole": 2, "ob23_scimethod": 2,
                "ob24_biotext": 3, "ob25_biostat": 3, "ob26_energy": 3}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_oge_bio_subject_test", SERVER_PATH)
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
    with tempfile.TemporaryDirectory(prefix="ege-oge-bio-") as tmp:
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
            assert oge["features"]["lessons"] is True, oge
            assert oge["features"]["practice"] is True and oge["features"]["forecast"] is True, oge
            assert oge["features"]["diagnostics"] is True and oge["features"]["missions"] is True, oge
            # Предметы оси ege остались на месте; ось oge делим с соседями.
            exams = {s.get("id"): s.get("exam") for s in subjects.get("subjects", [])}
            assert all(v == "ege" for k, v in exams.items()
                       if k in ("profile_math", "basic_math", "russian", "biology",
                                "society", "informatics", "history")), exams
            assert all(v in ("ege", "oge") for v in exams.values()), exams

            status, boot = request(opener, base, f"/api/bootstrap?subject={RID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == RID and state["subject"] == RID

            skills = catalog.get("skills", [])
            assert len(skills) == 26, len(skills)
            by_id = {s["id"]: s for s in skills}
            assert set(by_id) == {f"ob{n:02d}_{suf}" for n, suf in [
                (1, "science"), (2, "kingdoms"), (3, "syscat"), (4, "graphics"),
                (5, "processes"), (6, "devices"), (7, "veracity"), (8, "structure"),
                (9, "divchoice"), (10, "gaps"), (11, "divmatch"), (12, "judgments"),
                (13, "morph"), (14, "humanfeat"), (15, "humanbody"),
                (16, "humanstruct"), (17, "humanchoice"), (18, "humanmatch"),
                (19, "ecodesc"), (20, "foodchain"), (21, "biorel"),
                (22, "biorole"), (23, "scimethod"), (24, "biotext"),
                (25, "biostat"), (26, "energy")]}, sorted(by_id)
            # У каждой темы ровно 3 подсказки (требует контракт реестра).
            assert all(isinstance(s.get("metadata", {}).get("hints"), list)
                       and len(s["metadata"]["hints"]) == 3
                       and all(h.strip() for h in s["metadata"]["hints"]) for s in skills), skills
            locked = {sid for sid, s in by_id.items() if s.get("locked")}
            assert locked == LOCKED_SKILLS, locked

            tasks = catalog.get("tasks", [])
            assert len(tasks) >= 1100, len(tasks)
            task_ids = {t["id"] for t in tasks}
            per_skill: dict[str, int] = {}
            for t in tasks:
                per_skill[t["skill"]] = per_skill.get(t["skill"], 0) + 1
            # У каждой открытой темы есть задания; у locked — нет.
            assert set(per_skill) == (set(by_id) - LOCKED_SKILLS), sorted(set(by_id) ^ set(per_skill) ^ LOCKED_SKILLS)
            assert all(v >= 1 for v in per_skill.values()), per_skill
            # Часть 2 — развернутый ответ с самопроверкой и весом линии.
            part2 = [t for t in tasks if t["skill"] in PART2_SKILLS]
            assert part2, "нет заданий части 2"
            assert all(t.get("check") == "self" and t.get("type") == "extended_answer"
                       and t.get("points") == PART2_POINTS[t["skill"]] for t in part2), part2
            part1 = [t for t in tasks if t not in part2]
            assert all(t.get("points") in (1, 2, 3) and (t.get("answer") or "").strip()
                       for t in part1), part1

            missions = catalog.get("missions", [])
            assert {m.get("skill") for m in missions} == (set(by_id) - LOCKED_SKILLS), missions
            assert all(m.get("tasks") and all(t in task_ids for t in m["tasks"]) for m in missions), missions
            bosses = catalog.get("bosses", [])
            assert {b.get("cat") for b in bosses} == {"oge_bio_general", "oge_bio_diversity",
                                                      "oge_bio_human", "oge_bio_eco"}, bosses
            assert all(b.get("size", 0) > 0 and b.get("xp", 0) > 0 for b in bosses), bosses
            assert {g.get("id") for g in catalog.get("goals", [])} == {"g3", "g4", "g5"}, catalog.get("goals")
            diag = catalog.get("diagnosticTasks", [])
            assert len(diag) >= 6 and set(diag) <= task_ids and len(set(diag)) == len(diag), diag
            daily_cfg = catalog.get("daily") or {}
            assert daily_cfg.get("target", 0) > 0 and daily_cfg.get("skill") in task_ids or daily_cfg.get("skill"), daily_cfg
            # Уроки: по одному на линию; финал каждого — реальное задание
            # банка того же скила, у всех ACTION — ответ, разбор и 3 подсказки.
            lessons = catalog.get("lessons", [])
            assert len(lessons) == 26, len(lessons)
            assert {x.get("skill") for x in lessons} == set(by_id), lessons
            assert all(isinstance(x.get("steps"), list) and 15 <= len(x["steps"]) <= 22
                       for x in lessons), [len(x.get("steps", [])) for x in lessons]
            task_skill = {t["id"]: t["skill"] for t in tasks}
            for x in lessons:
                final = x["steps"][-1]
                assert final.get("type") == "INDEPENDENT_TASK", x
                assert final.get("taskId") in task_ids, x
                assert task_skill[final["taskId"]] == x["skill"], x
                assert isinstance(final.get("hints"), list) and len(final["hints"]) == 3, x
                assert "answer" not in final and "solution" not in final, x
                for st in x["steps"]:
                    if st.get("type") in ("ACTION", "VALIDATION"):
                        assert (st.get("answer") or "").strip() and (st.get("solution") or "").strip() \
                            and (st.get("errorType") or "").strip(), (x["id"], st.get("id"))
                        assert isinstance(st.get("hints"), list) and len(st["hints"]) == 3 \
                            and all(h.strip() for h in st["hints"]), (x["id"], st.get("id"))

            # Прогноз: веса по баллам линий, сумма 47, шкала длиной 48.
            fc = catalog.get("forecast") or oge.get("forecast") or {}
            weights = fc.get("weights", {})
            assert sum(weights.values()) == 47, weights
            assert fc.get("total") == 47 and len(fc.get("scale", [])) == 48, fc

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={RID}")
            assert status == 200 and len(task_details.get("tasks", [])) == len(tasks), (status, task_details)
            status, lesson_details = request(opener, base, f"/api/catalog-lessons?subject={RID}")
            served = lesson_details.get("lessons", [])
            assert status == 200 and len(served) == 26, (status, lesson_details)
            assert {x.get("skill") for x in served} == set(by_id), served

            # SEO-ось /oge/: хаб и страница номера — 200 с подписью ОГЭ.
            status, hub = request(opener, base, f"/oge/{RID}/", raw=True)
            assert status == 200 and "ОГЭ".encode() in hub, (status, len(hub))
            assert "ЕГЭ по".encode() not in hub, "ось перепутана"
            status, task_page = request(opener, base, f"/oge/{RID}/zadanie-6/", raw=True)
            assert status == 200 and "Задание 6 ОГЭ".encode() in task_page, (status, len(task_page))
            status, oge_index = request(opener, base, "/oge/", raw=True)
            assert status == 200 and RID.encode() in oge_index, (status, len(oge_index))
            # Кросс-ось — 404, а не утечка.
            for bad in (f"/ege/{RID}/", f"/ege/{RID}/zadanie-6/",
                        "/oge/profile_math/", "/oge/profile_math/zadanie-1/"):
                status, _ = request(opener, base, bad, raw=True)
                assert status == 404, (bad, status)
            # Ось ege жива как раньше.
            status, ege_hub = request(opener, base, "/ege/basic_math/", raw=True)
            assert status == 200 and "Задание".encode() in ege_hub and "ЕГЭ".encode() in ege_hub, (status, len(ege_hub))
            status, sitemap = request(opener, base, "/sitemap.xml", raw=True)
            assert status == 200 and f"/oge/{RID}/".encode() in sitemap, (status, len(sitemap))
            assert "/ege/basic_math/".encode() in sitemap, (status, len(sitemap))

            # Онбординг и изоляция: профиль ↔ oge не смешиваются.
            status, profile = request(opener, base, "/api/bootstrap?subject=profile_math")
            assert status == 200, (status, profile)
            status, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "ОГЭ гость",
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
            pskill = "ob02_kingdoms"
            status, saved = request(opener, base, f"/api/progress/{pskill}", "PATCH", {
                "subject": RID, "expectedVersion": settings["stateVersion"],
                "progress": {"progress": 10, "solved": 1, "correct": 1, "timeSec": 60},
            })
            assert status == 200, (status, saved)
            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["catalog"]["subject"] == "profile_math", (status, back)
            assert back["state"]["skillStats"].get(pskill) is None, back["state"]["skillStats"]

            # Сочинений в предмете нет: приём текста на обычное задание
            # отклоняется (не long_text), эссе-конвейер для oge закрыт.
            status, no_essay = request(opener, base, "/api/essays", "POST", {
                "subject": RID, "taskId": "ob02_p1", "skill": "ob02_kingdoms",
                "text": " ".join(["слово"] * 200), "id": "essay-oge-1",
            })
            assert status == 400, (status, no_essay)

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_oge = next((s for s in public.get("subjects", []) if s.get("id") == RID), None)
            assert public_oge, public
            assert public_oge.get("counts", {}).get("tasks") == len(tasks), public_oge
            print(f"OGE biology subject integration OK: {len(tasks)} tasks, 26 skills "
                  f"(0 locked, figures restored), {len(lessons)} lessons, {len(missions)} missions, /oge/ SEO axis isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
