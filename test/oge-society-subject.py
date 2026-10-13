#!/usr/bin/env python3
"""Интеграционная регрессия предмета «Обществознание (ОГЭ)».

Второй предмет оси oge: 20 линий (короткий ответ + развёрнутый с
самопроверкой), прогноз в первичных баллах (total 37, identity-шкала),
цели-оценки g3/g4/g5. Уроки: 20 (по одному на линию), без сочинений.
Тема №7 (фото) открыта реальными рисунками источника (assets/oge_society, visual-provided).
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

RID = "oge_society"
LOCKED_SKILLS: set[str] = set()
PART2_SKILLS = {"os01_concepts", "os07_photo", "os08_finance", "os12_stats",
                "os17_significance", "os18_plan", "os19_analysis",
                "os20_examples"}
OPEN_SKILL_IDS = {
    "os01_concepts", "os02_table", "os03_compare", "os04_culture", "os05_man",
    "os06_social", "os07_photo", "os08_finance", "os09_agents", "os10_econ",
    "os11_politics", "os12_stats", "os13_law", "os14_match", "os15_socrel",
    "os16_lawjudge", "os17_significance", "os18_plan", "os19_analysis",
    "os20_examples",
}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_oge_society_subject_test", SERVER_PATH)
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
    with tempfile.TemporaryDirectory(prefix="ege-oge-society-") as tmp:
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
            # Якорные предметы остались на оси ege.
            exams = {s.get("id"): s.get("exam") for s in subjects.get("subjects", [])}
            for anchor in ("profile_math", "basic_math", "russian", "society"):
                if anchor in exams:
                    assert exams[anchor] == "ege", (anchor, exams)

            status, boot = request(opener, base, f"/api/bootstrap?subject={RID}")
            assert status == 200, (status, boot)
            catalog, state = boot["catalog"], boot["state"]
            assert catalog["subject"] == RID and state["subject"] == RID

            skills = catalog.get("skills", [])
            assert len(skills) == 20, len(skills)
            by_id = {s["id"]: s for s in skills}
            assert set(by_id) == OPEN_SKILL_IDS | LOCKED_SKILLS, sorted(by_id)
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
            # Все 20 тем открыты и имеют задания.
            assert set(per_skill) == OPEN_SKILL_IDS, sorted(set(by_id) ^ set(per_skill))
            assert all(v >= 1 for v in per_skill.values()), per_skill
            # Фото-тема №7: все задания с рисунком (visual.assetId).
            photo = [t for t in tasks if t["skill"] == "os07_photo"]
            assert len(photo) >= 40, len(photo)
            assert all((t.get("visual") or {}).get("assetId") for t in photo), photo
            # Часть с развёрнутым ответом — самопроверка и вес 2.
            part2 = [t for t in tasks if t["skill"] in PART2_SKILLS]
            assert part2, "нет заданий с развёрнутым ответом"
            assert all(t.get("check") == "self" and t.get("points") == 2 for t in part2), part2
            part1 = [t for t in tasks if t not in part2]
            assert all(t.get("points") == 1 and (t.get("answer") or "").strip() for t in part1), part1

            missions = catalog.get("missions", [])
            assert {m.get("skill") for m in missions} == OPEN_SKILL_IDS, missions
            assert all(m.get("tasks") and all(t in task_ids for t in m["tasks"]) for m in missions), missions
            bosses = catalog.get("bosses", [])
            assert {b.get("cat") for b in bosses} == {"oss_person", "oss_spheres",
                                                      "oss_polaw", "oss_text"}, bosses
            assert all(b.get("size", 0) > 0 and b.get("xp", 0) > 0 for b in bosses), bosses
            assert {g.get("id") for g in catalog.get("goals", [])} == {"g3", "g4", "g5"}, catalog.get("goals")
            diag = catalog.get("diagnosticTasks", [])
            assert len(diag) >= 6 and set(diag) <= task_ids and len(set(diag)) == len(diag), diag
            # Диагностика — только автопроверка (поле ввода).
            diag_tasks = {t["id"]: t for t in tasks if t["id"] in set(diag)}
            assert all(t.get("check", "auto") != "self" for t in diag_tasks.values()), diag
            daily_cfg = catalog.get("daily") or {}
            assert daily_cfg.get("target", 0) > 0, daily_cfg
            assert daily_cfg.get("skill") in per_skill, daily_cfg
            # Уроки: 20, по одному на линию (bootstrap отдаёт полные уроки).
            boot_lessons = catalog.get("lessons", [])
            assert len(boot_lessons) == 20, len(boot_lessons)
            assert {le.get("skill") for le in boot_lessons} == OPEN_SKILL_IDS, boot_lessons
            assert len({le.get("id") for le in boot_lessons}) == 20, boot_lessons
            assert all(15 <= len(le.get("steps", [])) <= 22 for le in boot_lessons), boot_lessons
            assert all(100 <= (le.get("xp") or 0) <= 140 for le in boot_lessons), boot_lessons

            # Прогноз: сумма весов 37, шкала длиной 38.
            fc = catalog.get("forecast") or oge.get("forecast") or {}
            weights = fc.get("weights", {})
            assert sum(weights.values()) == 37, weights
            assert set(weights) == set(by_id), sorted(set(weights) ^ set(by_id))
            assert fc.get("total") == 37 and len(fc.get("scale", [])) == 38, fc

            status, task_details = request(opener, base, f"/api/catalog-tasks?subject={RID}")
            assert status == 200 and len(task_details.get("tasks", [])) == len(tasks), (status, task_details)
            status, lessons = request(opener, base, f"/api/catalog-lessons?subject={RID}")
            assert status == 200 and len(lessons.get("lessons", [])) == 20, (status, lessons)
            # Каждый урок: связка с практикой (финал — задание своего скила),
            # у всех ACTION ровно 3 подсказки.
            task_by_id = {t["id"]: t for t in tasks}
            full_by_skill = {}
            for le in lessons["lessons"]:
                assert 15 <= len(le.get("steps", [])) <= 22, le.get("id")
                assert le.get("skill") not in full_by_skill, le.get("id")
                full_by_skill[le["skill"]] = le
                interactive = [s for s in le["steps"]
                               if s.get("type") in ("ACTION", "VALIDATION")]
                assert 10 <= len(interactive) <= 15, le.get("id")
                for s in interactive:
                    assert isinstance(s.get("hints"), list) and len(s["hints"]) == 3, (le.get("id"), s.get("id"))
                    assert (s.get("answer") or "").strip(), (le.get("id"), s.get("id"))
                    assert "Ответ:" in (s.get("solution") or ""), (le.get("id"), s.get("id"))
                indep = [s for s in le["steps"] if s.get("type") == "INDEPENDENT_TASK"]
                assert len(indep) == 1 and le["steps"][-1].get("type") == "INDEPENDENT_TASK", le.get("id")
                fin_id = indep[0].get("taskId")
                assert fin_id in task_by_id, (le.get("id"), fin_id)
                assert task_by_id[fin_id]["skill"] == le["skill"], (le.get("id"), fin_id)
            assert set(full_by_skill) == OPEN_SKILL_IDS, sorted(full_by_skill)

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
            pskill = "os04_culture"
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
                "subject": RID, "taskId": "os02_p1", "skill": "os02_table",
                "text": " ".join(["слово"] * 200), "id": "essay-oge-1",
            })
            assert status == 400, (status, no_essay)

            status, public = request(opener, base, "/api/status")
            assert status == 200, (status, public)
            public_oge = next((s for s in public.get("subjects", []) if s.get("id") == RID), None)
            assert public_oge, public
            assert public_oge.get("counts", {}).get("tasks") == len(tasks), public_oge
            print(f"OGE society subject integration OK: {len(tasks)} tasks, 20 skills "
                  f"(0 locked), 20 lessons, {len(missions)} missions, /oge/ SEO axis isolated")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
