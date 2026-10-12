#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Информатика (ОГЭ)».

Второй предмет оси oge: 16 линий (№1–10 краткий ответ без компьютера,
№9 — со схемами-рисунками, №11–16 компьютерный практикум), прогноз
в первичных баллах (total 21, identity-шкала), цели-оценки g3/g4/g5.
Без уроков и сочинений.
Навыки №11–16 (поиск файлов, файлы по условию, презентация/документ,
таблицы, Робот, программирование — нужен компьютер) — locked;
№9 (схемы дорог) открыт фигурами источника. Проверяются API, каталог, SEO-ось /oge/
с кросс-проверкой и изоляция состояния при переключении туда-обратно.
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

RID = "oge_informatics"
LOCKED_SKILLS = {"oi11_filesearch", "oi12_filecount",
                 "oi13_office", "oi14_spreadsheet", "oi15_robot",
                 "oi16_coding"}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_oge_inf_subject_test", SERVER_PATH)
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
    with tempfile.TemporaryDirectory(prefix="ege-oge-inf-") as tmp:
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
            assert oge["features"]["lessons"] is False, oge
            assert oge["features"]["practice"] is True and oge["features"]["forecast"] is True, oge
            assert oge["features"]["diagnostics"] is True and oge["features"]["missions"] is True, oge

            status, boot = request(opener, base, f"/api/bootstrap?subject={RID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == RID and state["subject"] == RID

            skills = catalog.get("skills", [])
            assert len(skills) == 16, len(skills)
            by_id = {s["id"]: s for s in skills}
            assert set(by_id) == {f"oi{n:02d}_{suf}" for n, suf in [
                (1, "memory"), (2, "decode"), (3, "logic"), (4, "models"),
                (5, "executor"), (6, "program"), (7, "network"), (8, "queries"),
                (9, "graphs"), (10, "numsys"), (11, "filesearch"), (12, "filecount"),
                (13, "office"), (14, "spreadsheet"), (15, "robot"), (16, "coding")]}, sorted(by_id)
            # У каждой темы ровно 3 подсказки (требует контракт реестра).
            assert all(isinstance(s.get("metadata", {}).get("hints"), list)
                       and len(s["metadata"]["hints"]) == 3
                       and all(h.strip() for h in s["metadata"]["hints"]) for s in skills), skills
            locked = {sid for sid, s in by_id.items() if s.get("locked")}
            assert locked == LOCKED_SKILLS, locked

            tasks = catalog.get("tasks", [])
            assert len(tasks) == 520, len(tasks)
            task_ids = {t["id"] for t in tasks}
            per_skill: dict[str, int] = {}
            for t in tasks:
                per_skill[t["skill"]] = per_skill.get(t["skill"], 0) + 1
            # Честные капы волн (пулы СДАМ ГИА исчерпаны): весь годный пул
            # целиком; волна 3 вычистила усечённые "<"-сравнения (SKIP_SRC).
            # №9 открыт фигурами (67 схем, visual-provided).
            assert per_skill == {"oi01_memory": 44, "oi02_decode": 94,
                                 "oi03_logic": 17, "oi04_models": 82,
                                 "oi05_executor": 39, "oi06_program": 27,
                                 "oi07_network": 59, "oi08_queries": 57,
                                 "oi09_graphs": 67, "oi10_numsys": 34}, per_skill
            # У каждой открытой темы есть задания; у locked — нет.
            assert set(per_skill) == (set(by_id) - LOCKED_SKILLS), sorted(set(by_id) ^ set(per_skill) ^ LOCKED_SKILLS)
            assert all(v >= 1 for v in per_skill.values()), per_skill
            # Весь банк — краткий ответ с автопроверкой весом 1
            # (компьютерный практикум №11–16 в банк не входит).
            assert all(t.get("points") == 1 and (t.get("answer") or "").strip() for t in tasks), tasks
            assert all(t.get("type") == "short_answer" for t in tasks), tasks
            # №9 — с фигурами: у каждого задания visual.assetId из visualAssets.
            assets = {a.get("id") for a in catalog.get("visualAssets", [])}
            fig = [t for t in tasks if t["skill"] == "oi09_graphs"]
            assert len(fig) == 67, len(fig)
            assert all((t.get("visual") or {}).get("assetId") in assets for t in fig), fig

            missions = catalog.get("missions", [])
            assert {m.get("skill") for m in missions} == (set(by_id) - LOCKED_SKILLS), missions
            assert all(m.get("tasks") and all(t in task_ids for t in m["tasks"]) for m in missions), missions
            bosses = catalog.get("bosses", [])
            assert {b.get("cat") for b in bosses} == {"oge_inf_info", "oge_inf_models", "oge_inf_algo"}, bosses
            assert all(b.get("size", 0) > 0 and b.get("xp", 0) > 0 for b in bosses), bosses
            assert {g.get("id") for g in catalog.get("goals", [])} == {"g3", "g4", "g5"}, catalog.get("goals")
            diag = catalog.get("diagnosticTasks", [])
            assert len(diag) >= 6 and set(diag) <= task_ids and len(set(diag)) == len(diag), diag
            daily_cfg = catalog.get("daily") or {}
            assert daily_cfg.get("target", 0) > 0 and daily_cfg.get("skill") in task_ids or daily_cfg.get("skill"), daily_cfg
            assert catalog.get("lessons", []) == [], catalog.get("lessons")

            # Прогноз: веса 12x1 + 2 + 3 + 2 + 2 = 21, шкала длиной 22.
            fc = catalog.get("forecast") or oge.get("forecast") or {}
            weights = fc.get("weights", {})
            assert sum(weights.values()) == 21, weights
            assert fc.get("total") == 21 and len(fc.get("scale", [])) == 22, fc

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={RID}")
            assert status == 200 and len(task_details.get("tasks", [])) == len(tasks), (status, task_details)
            status, lessons = request(opener, base, f"/api/catalog-lessons?subject={RID}")
            assert status == 200 and lessons.get("lessons", []) == [], (status, lessons)

            # SEO-ось /oge/: хаб и страница номера — 200 с подписью ОГЭ.
            status, hub = request(opener, base, f"/oge/{RID}/", raw=True)
            assert status == 200 and "ОГЭ".encode() in hub, (status, len(hub))
            assert "ЕГЭ по".encode() not in hub, "ось перепутана"
            status, task_page = request(opener, base, f"/oge/{RID}/zadanie-1/", raw=True)
            assert status == 200 and "Задание 1 ОГЭ".encode() in task_page, (status, len(task_page))
            status, oge_index = request(opener, base, "/oge/", raw=True)
            assert status == 200 and RID.encode() in oge_index, (status, len(oge_index))
            # Кросс-ось — 404, а не утечка.
            for bad in (f"/ege/{RID}/", f"/ege/{RID}/zadanie-1/",
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
            pskill = "oi01_memory"
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
                "subject": RID, "taskId": "oi01_p1", "skill": "oi01_memory",
                "text": " ".join(["слово"] * 200), "id": "essay-oge-1",
            })
            assert status == 400, (status, no_essay)

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_oge = next((s for s in public.get("subjects", []) if s.get("id") == RID), None)
            assert public_oge, public
            assert public_oge.get("counts", {}).get("tasks") == len(tasks), public_oge
            print(f"OGE informatics subject integration OK: {len(tasks)} tasks, 16 skills "
                  f"(6 locked), {len(missions)} missions, /oge/ SEO axis isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
