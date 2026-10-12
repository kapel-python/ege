#!/usr/bin/env python3
"""Интеграционная регрессия предмета «История».

Предмет открыт практикой без уроков: все 21 задание ЕГЭ-2026 — часть 1
№1–12 с кратким ответом (автопроверка: цифры и слова, карты и изображения
с локальными рисунками) и часть 2 №13–21 с самопроверкой по официальному
разбору источника. Проверяются API, каталог, unlocked-состояние, прогноз
(шкала 42 первичных → 100 тестовых, provisional) и изоляция состояния при
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

SID = "history"

SKILLS = ["h01_dates", "h02_chrono", "h03_facts", "h04_table", "h05_persons",
          "h06_source", "h07_culture", "h08_image", "h09_map", "h10_map",
          "h11_maptext", "h12_mapchoice", "h13_attr", "h14_search", "h15_imgout",
          "h16_wow", "h17_causes", "h18_terms", "h19_termfact", "h20_args",
          "h21_thesis"]
PART1 = set(SKILLS[:12])
PART2 = set(SKILLS[12:])
# Баллы линий по спецификации ФИПИ-2026 (первичный максимум — 42).
POINTS = {"h01_dates": 2, "h02_chrono": 1, "h03_facts": 2, "h04_table": 3,
          "h05_persons": 2, "h06_source": 2, "h07_culture": 2, "h08_image": 1,
          "h09_map": 1, "h10_map": 1, "h11_maptext": 1, "h12_mapchoice": 2,
          "h13_attr": 2, "h14_search": 2, "h15_imgout": 2, "h16_wow": 2,
          "h17_causes": 3, "h18_terms": 3, "h19_termfact": 2, "h20_args": 3,
          "h21_thesis": 3}
# Пол против потери контента (потолки источника: h04 — 89 сырых, h08 — 89,
# новые линии части 2 короткие: h18 — 16, h19/h20 — добор legacy-блоками).
FLOOR_PART1 = 80
FLOOR_PART2 = 60
FLOOR_THIN = {"h18_terms": 12, "h19_termfact": 10, "h20_args": 20}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_history_subject_test", SERVER_PATH)
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
    with tempfile.TemporaryDirectory(prefix="ege-history-") as tmp:
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
            hist = next((s for s in subjects.get("subjects", []) if s.get("id") == SID), None)
            assert hist, subjects
            assert hist.get("title") == "История", hist
            assert hist.get("status") == "ready", hist
            assert hist.get("locked") is False, hist
            assert set(hist.get("features", {})) == {"lessons", "practice", "forecast", "diagnostics",
                                                     "missions", "bosses", "daily", "path"}, hist
            # Практика без уроков: уроки выключены, всё остальное включено.
            assert hist["features"]["lessons"] is False, hist
            assert all(v is True for k, v in hist["features"].items() if k != "lessons"), hist

            status, boot = request(opener, base, f"/api/bootstrap?subject={SID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == SID and state["subject"] == SID

            skills = catalog.get("skills", [])
            assert {s["id"] for s in skills} == set(SKILLS), [s["id"] for s in skills]
            assert not [s for s in skills if s.get("locked")], skills

            tasks = catalog.get("tasks", [])
            per_skill: dict[str, int] = {}
            for t in tasks:
                per_skill.setdefault(t.get("skill"), 0)
                per_skill[t.get("skill")] += 1
            assert set(per_skill) == set(SKILLS), sorted(set(per_skill) ^ set(SKILLS))
            for skill in PART1:
                assert per_skill[skill] >= FLOOR_PART1, (skill, per_skill[skill])
            for skill in PART2:
                assert per_skill[skill] >= FLOOR_THIN.get(skill, FLOOR_PART2), (skill, per_skill[skill])
            # Часть 1 — строгая сверка ответа; часть 2 — самопроверка
            # по официальному разбору (у задания нет машинного ключа).
            for t in tasks:
                if t.get("skill") in PART1:
                    assert t.get("check", "auto") == "auto", t["id"]
                    assert (t.get("answer") or "").strip(), t["id"]
                else:
                    assert t.get("check") == "self", t["id"]
                    assert (t.get("solution") or "").strip(), t["id"]
                    assert (t.get("answer") or "").strip(), t["id"]
                assert t.get("points") == POINTS[t["skill"]], (t["id"], t.get("points"))
            # Карты и изображения части 1 — только с рисунком.
            for t in tasks:
                if t.get("skill") in {"h08_image", "h09_map", "h10_map", "h11_maptext",
                                      "h12_mapchoice", "h15_imgout"}:
                    assert (t.get("visual") or {}).get("assetId"), t["id"]

            # Прогноз: веса покрывают все 21 навык, сумма 42, шкала до 100.
            forecast = catalog.get("forecast") or {}
            assert forecast.get("total") == 42, forecast.get("total")
            assert len(forecast.get("scale") or []) == 43, len(forecast.get("scale") or [])
            assert forecast["scale"][0] == 0 and forecast["scale"][42] == 100, forecast["scale"]
            assert all(b >= a for a, b in zip(forecast["scale"], forecast["scale"][1:])), forecast["scale"]
            weights = forecast.get("weights") or {}
            assert set(weights) == set(SKILLS), set(weights) ^ set(SKILLS)
            assert sum(weights.values()) == 42, sum(weights.values())

            # Цели — общая шкала g60/g80/g95 (GOAL_LABELS в админке не трогаем).
            goals = {g["id"] for g in catalog.get("goals", [])}
            assert goals == {"g60", "g80", "g95"}, goals
            assert len(catalog.get("diagnosticTasks", [])) == 6, catalog.get("diagnosticTasks")
            task_ids = {t["id"] for t in tasks}
            assert set(catalog["diagnosticTasks"]) <= task_ids, catalog["diagnosticTasks"]
            diag_skills = {t["skill"] for t in tasks if t["id"] in set(catalog["diagnosticTasks"])}
            assert diag_skills <= PART1, diag_skills
            daily = catalog.get("daily") or {}
            assert daily.get("skill") in {s["id"] for s in skills} and daily.get("target", 0) > 0, daily

            # Уроков нет (добавим позже), миссии — по одной на линию.
            assert catalog.get("lessons", []) == [], catalog.get("lessons")
            missions = catalog.get("missions", [])
            assert len(missions) == 21, len(missions)
            for m in missions:
                assert m.get("skill") in set(SKILLS), m
                assert m.get("tasks") and set(m["tasks"]) <= task_ids, m
            bosses = catalog.get("bosses", [])
            assert len(bosses) == 4, bosses
            cat_ids = {c["id"] for c in catalog.get("categories", [])}
            assert all(b.get("cat") in cat_ids for b in bosses), bosses

            # Визуал: настоящие рисунки источника (PNG) в assets/history.
            assets = catalog.get("visualAssets", [])
            assert len(assets) >= 400, len(assets)
            for a in assets:
                assert a.get("src", "").startswith("assets/history/") \
                    and a["src"].split("?")[0].endswith(".png"), a
            visuals = [t for t in tasks if (t.get("visual") or {}).get("assetId")]
            asset_ids = {a["id"] for a in assets}
            used_ids = {(t.get("visual") or {})["assetId"] for t in visuals}
            assert used_ids <= asset_ids, "визуал без актива"
            assert asset_ids <= used_ids, "актив без задания"
            audit = (catalog.get("visualAudit") or {}).get("taskStatuses") or {}
            assert set(audit) <= task_ids, len(audit)

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={SID}")
            assert status == 200 and len(task_details.get("tasks", [])) == len(tasks), (status, len(task_details.get("tasks", [])))
            status, lesson_details = request(opener, base, f"/api/catalog-lessons?subject={SID}")
            assert status == 200 and lesson_details.get("lessons", []) == [], (status, lesson_details)

            # Переключение и запись в профиль не смешиваются с новым предметом.
            status, profile = request(opener, base, "/api/bootstrap?subject=profile_math")
            assert status == 200, (status, profile)
            status, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Историк гость",
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
                "settings": {"onboarded": True, "name": "Историк гость"},
            })
            assert status == 200, (status, settings)

            # Практика линии доступна: запись прогресса проходит.
            status, progress = request(opener, base, "/api/progress/h01_dates", "PATCH", {
                "subject": SID, "expectedVersion": settings["stateVersion"],
                "progress": {"progress": 10, "solved": 1, "correct": 1, "timeSec": 60},
            })
            assert status == 200, (status, progress)

            status, back = request(opener, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and back["state"]["skillStats"][pskill]["progress"] == 42, back["state"]
            assert back["state"]["skillStats"].get("h01_dates") is None, back["state"]["skillStats"]

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_hist = next((s for s in public.get("subjects", []) if s.get("id") == SID), None)
            assert public_hist, public
            public_counts = public_hist.get("counts", {})
            assert public_counts.get("tasks") == len(tasks), public_hist
            assert public_counts.get("skills") == 21, public_hist
            assert public_counts.get("lessons") == 0 and public_counts.get("missions") == 21, public_hist
            assert public_counts.get("bosses") == 4, public_hist
            print(f"History subject integration OK: 21 lines, {len(tasks)} real tasks,"
                  " practice without lessons, forecast 42->100, state isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
