#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Биология».

Предмет открыт: полная программа ЕГЭ — 28 линий (часть 1 №1–21 с кратким
ответом, часть 2 №22–28 с развёрнутым ответом), 28 тем, уроки, миссии,
боссы, диагностика и прогноз (шкала 57 первичных → 100 тестовых, ФИПИ-2026).
Проверяются API, каталог, unlocked-состояние и изоляция состояния при
переключении туда-обратно.
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

SID = "biology"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_biology_subject_test", SERVER_PATH)
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


def main():
    with tempfile.TemporaryDirectory(prefix="ege-biology-") as tmp:
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
            bio = next((s for s in subjects.get("subjects", []) if s.get("id") == SID), None)
            assert bio, subjects
            assert bio.get("title") == "Биология", bio
            assert bio.get("status") == "ready", bio
            assert bio.get("locked") is False, bio
            assert set(bio.get("features", {})) == {"lessons", "practice", "forecast", "diagnostics",
                                                    "missions", "bosses", "daily", "path"}, bio
            assert all(bio["features"].values()), bio

            status, boot = request(opener, base, f"/api/bootstrap?subject={SID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == SID and state["subject"] == SID

            skills = catalog.get("skills", [])
            assert len(skills) == 28, len(skills)
            assert {s.get("ege") for s in skills} == {f"№{i}" for i in list(range(1, 22)) + list(range(22, 29))}, skills
            assert not [s for s in skills if s.get("locked")], skills

            tasks = catalog.get("tasks", [])
            assert len(tasks) == 284, len(tasks)
            short = [t for t in tasks if t.get("type") == "short_answer"]
            extended = [t for t in tasks if t.get("type") == "extended_answer"]
            assert len(short) == 263 and len(extended) == 21, (len(short), len(extended))
            # Часть 1: темы по 15 заданий (единая система); темы, где задание
            # построено на официальном рисунке, источник текстом не отдаёт —
            # там остаётся 5 (bio05, 09, 13) или 13 (bio06, дошли не все).
            per_skill: dict[str, int] = {}
            for t in short:
                per_skill.setdefault(t.get("skill"), 0)
                per_skill[t.get("skill")] += 1
            part1_skills = [s["id"] for s in skills if s["id"] not in
                            {"bio22_experiment", "bio23_conclusion", "bio24_picture",
                             "bio25_humanadv", "bio26_genbioadv", "bio27_cytology",
                             "bio28_genetics"}]
            assert set(per_skill) == set(part1_skills), sorted(set(per_skill) ^ set(part1_skills))
            assert all(v >= 5 for v in per_skill.values()), per_skill
            assert all(v == 15 for sid, v in per_skill.items() if sid not in
                       {"bio05_cellfig", "bio09_divfig", "bio13_humanfig",
                        "bio06_cellmatch", "bio10_divmatch", "bio14_humanmatch"}), per_skill
            # Часть 2: 7 линий по 3 задания, у каждого есть образец решения.
            per_adv: dict[str, int] = {}
            for t in extended:
                per_adv.setdefault(t.get("skill"), 0)
                per_adv[t.get("skill")] += 1
                assert t.get("solution"), t["id"]
            assert len(per_adv) == 7 and all(v == 3 for v in per_adv.values()), per_adv
            # Баллы линий: часть 1 — 1/2, часть 2 — 3.
            points = {t["id"]: t.get("points") for t in tasks}
            assert all(points[f"bio{i:02d}_p1"] in (1, 2) for i in range(1, 22)), points
            assert all(points[f"bio{i}_p1"] == 3 for i in range(22, 29)), points

            # Прогноз: веса покрывают все 28 навыков, сумма 57, шкала до 100.
            forecast = catalog.get("forecast") or {}
            assert forecast.get("total") == 57, forecast.get("total")
            assert len(forecast.get("scale") or []) == 58, len(forecast.get("scale") or [])
            assert forecast["scale"][0] == 0 and forecast["scale"][57] == 100, forecast["scale"]
            assert all(b >= a for a, b in zip(forecast["scale"], forecast["scale"][1:])), forecast["scale"]
            weights = forecast.get("weights") or {}
            assert set(weights) == {s["id"] for s in skills}, set(weights) ^ {s["id"] for s in skills}
            assert sum(weights.values()) == 57, sum(weights.values())

            # Цели — общая шкала g60/g80/g95 (GOAL_LABELS в админке не трогаем).
            goals = {g["id"] for g in catalog.get("goals", [])}
            assert goals == {"g60", "g80", "g95"}, goals
            assert catalog.get("diagnosticTasks") and len(catalog["diagnosticTasks"]) == 5, catalog.get("diagnosticTasks")
            task_ids = {t["id"] for t in tasks}
            assert set(catalog["diagnosticTasks"]) <= task_ids, catalog["diagnosticTasks"]
            daily = catalog.get("daily") or {}
            assert daily.get("skill") in {s["id"] for s in skills} and daily.get("target", 0) > 0, daily

            # Уроки: по одному на линию, миссии — по одной на линию.
            lessons = catalog.get("lessons", [])
            assert len(lessons) == 28, len(lessons)
            assert {x.get("skill") for x in lessons} == {s["id"] for s in skills}, lessons
            assert all(x.get("steps") for x in lessons), lessons
            missions = catalog.get("missions", [])
            assert len(missions) == 28, len(missions)
            for m in missions:
                assert m.get("skill") in {s["id"] for s in skills}, m
                assert m.get("tasks") and set(m["tasks"]) <= task_ids, m
            bosses = catalog.get("bosses", [])
            assert len(bosses) == 2, bosses
            cat_ids = {c["id"] for c in catalog.get("categories", [])}
            assert all(b.get("cat") in cat_ids for b in bosses), bosses

            # Визуал: 6 локальных SVG, каждая привязана к своему заданию.
            assets = catalog.get("visualAssets", [])
            assert len(assets) == 6, len(assets)
            for a in assets:
                assert a.get("src", "").startswith("assets/biology/") and a["src"].endswith(".svg"), a
                assert a.get("taskId") in task_ids, a
            visuals = [t for t in tasks if (t.get("visual") or {}).get("assetId")]
            assert len(visuals) == 6, len(visuals)
            asset_ids = {a["id"] for a in assets}
            assert {(t.get("visual") or {})["assetId"] for t in visuals} <= asset_ids, visuals
            audit = (catalog.get("visualAudit") or {}).get("taskStatuses") or {}
            assert set(audit) == task_ids, len(audit)

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={SID}")
            assert status == 200 and len(task_details.get("tasks", [])) == 284, (status, len(task_details.get("tasks", [])))
            status, lesson_details = request(opener, base, f"/api/catalog-lessons?subject={SID}")
            assert status == 200 and len(lesson_details.get("lessons", [])) == 28, (status, lesson_details)

            # Переключение и запись в профиль не смешиваются с новым предметом.
            status, profile = request(opener, base, "/api/bootstrap?subject=profile_math")
            assert status == 200, (status, profile)
            status, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Био гость",
                "selfLevel": "base", "goal": "g60",
            })
            assert status == 200, (status, claimed)
            pver = profile["state"]["stateVersion"]
            pskill = profile["catalog"]["skills"][0]["id"]
            status, saved = request(opener, base, f"/api/progress/{pskill}", "PATCH", {
                "subject": "profile_math", "expectedVersion": pver,
                "progress": {"progress": 42, "solved": 2, "correct": 1, "timeSec": 30},
            })
            assert status == 200, (status, saved)
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": SID})
            assert status == 200 and switched["subject"] == SID, (status, switched)
            assert switched["state"]["xp"] == 0 and switched["state"]["taskAttempts"] == [], switched
            assert switched["state"].get("skillStats", {}).get(pskill) is None, switched["state"]["skillStats"]
            status, settings = request(opener, base, "/api/settings", "PATCH", {
                "subject": SID, "expectedVersion": switched["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "Био гость"},
            })
            assert status == 200, (status, settings)

            # Практика линии доступна: запись прогресса проходит.
            status, progress = request(opener, base, "/api/progress/bio04_cross", "PATCH", {
                "subject": SID, "expectedVersion": settings["stateVersion"],
                "progress": {"progress": 10, "solved": 1, "correct": 1, "timeSec": 60},
            })
            assert status == 200, (status, progress)

            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["state"]["skillStats"][pskill]["progress"] == 42, back["state"]
            assert back["state"]["skillStats"].get("bio04_cross") is None, back["state"]["skillStats"]

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_bio = next((s for s in public.get("subjects", []) if s.get("id") == SID), None)
            assert public_bio, public
            public_counts = public_bio.get("counts", {})
            assert public_counts.get("tasks") == 284, public_bio
            assert public_counts.get("skills") == 28, public_bio
            assert public_counts.get("lessons") == 28, public_bio
            assert public_counts.get("missions") == 28 and public_counts.get("bosses") == 2, public_bio
            print("Biology subject integration OK: 28 lines, 284 tasks (263 доступны), 28 lessons,"
                  " forecast 57->100, state isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
