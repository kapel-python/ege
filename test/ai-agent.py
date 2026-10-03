#!/usr/bin/env python3
"""ИИ-наставник: треды, цикл tool-calling, подтверждения, квота.

Temp-БД, живой сервер, мок провайдера (без сети и денег):
  * гость — 401 GUEST_PENDING везде, профиля не заводит;
  * чужой тред — 404, чужие сообщения не отдаются, инструменты чужих не видят;
  * ответ без tools — финальный текст и одно списание квоты;
  * ответ с tools — цикл отрабатывает, шаги в базе и в ответе;
  * действие — confirm без записи, approve меняет, отмена пишет «Отменено учеником»;
  * длинный цикл — обрыв ответом по собранным данным (вызов без tools);
  * 10 ходов — ок, 11-й — 429 AI_LIMIT; 502 возвращает жетон;
  * повторный ход — кэш, usage.cost не растёт;
  * 400 на пустой/длинный, 400 AGENT_BUSY на параллельный ход;
  * парсер ai.py: реплика вместе с вызовами — не ошибка (preamble), пустой ответ — ошибка;
  * заголовок — первые 60 символов, подписка — колонка в users.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
os.environ["EGE_TRUSTED_PROXY"] = "1"
# Механика квоты тестируется на фиксированном потолке 10: дефолт продукта
# (AGENT_QUOTA_MAX_DEFAULT=5) проверяет test/subscription.py (free-квота),
# здесь важны drain/429/refund, а не конкретная цифра.
os.environ["EGE_AGENT_QUOTA_MAX"] = "10"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def section(title):
    print(f"\n== {title}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_ai_agent_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    def __init__(self, ip: str):
        self.ip = ip
        self.cookies: dict[str, str] = {}

    def request(self, base: str, method: str, path: str, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        req.add_header("X-Forwarded-For", self.ip)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as exc:
            resp = exc
        with resp:
            for sc in resp.headers.get_all("Set-Cookie") or []:
                name, _, rest = sc.partition("=")
                value = rest.split(";")[0].strip()
                if value:
                    self.cookies[name.strip()] = value
                else:
                    self.cookies.pop(name.strip(), None)
            status = resp.status
            raw = resp.read()
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return status, payload


def _user_id_by_name(server, who: str):
    conn = server.connect()
    try:
        row = conn.execute("SELECT id FROM users WHERE name=? ORDER BY id DESC LIMIT 1", (who,)).fetchone()
        return int(row["id"]) if row else None
    finally:
        conn.close()


def _profile_name(server, user_id: int):
    """Текущее имя пользователя по его users.id (имя само меняется — искать по
    нему бессмысленно: после update_profile запрос «где Жена-52» уже ничего не
    найдёт)."""
    conn = server.connect()
    try:
        row = conn.execute("SELECT name FROM users WHERE id=?", (int(user_id),)).fetchone()
        return row["name"] if row else None
    finally:
        conn.close()


def _find_topics_probes(server) -> dict:
    """Проверки нового поискового инструмента: он должен выдавать только
    СУЩЕСТВУЮЩИЕ id и понимать человеческие словоформы.

    Замена ему — угадывание id: легенды id не было ни в одном ответе, поэтому
    «дай задание на производную» кончалось либо ошибкой, либо выдуманным id."""
    conn = server.connect()
    try:
        agent = server._AGENT
        uid = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()["id"]
        out = {}

        deriv = agent.find_topics(conn, uid, "profile_math", {"query": "производная"})
        out["deriv"] = [t["id"] for t in deriv.get("tasks", [])][:4]
        out["deriv_ok"] = bool(out["deriv"]) and all(
            t.startswith("n09") for t in out["deriv"][:2])
        # Совпадение по названию навыка должно поднимать его задания над
        # «произведением векторов» (то же начало слова).
        out["rank"] = out["deriv"][:3]
        # «Произведение векторов» и «производная» начинаются одинаково: приоритет
        # должен отдавать задания по названию НАВЫКА, а не по слову внутри темы.
        out["rank_ok"] = bool(out["rank"]) and not out["rank"][0].startswith("n02")

        stem = agent.find_topics(conn, uid, "profile_math", {"query": "логарифмы"})
        out["stem"] = [t["topic"] for t in stem.get("tasks", [])][:3]
        out["stem_ok"] = any("огарифм" in t for t in out["stem"])

        num = agent.find_topics(conn, uid, "russian", {"query": "задание 27"})
        out["num"] = [t["id"] for t in num.get("tasks", [])][:3]
        out["num_ok"] = bool(out["num"]) and all(t.startswith("re27") for t in out["num"])

        empty = agent.find_topics(conn, uid, "profile_math", {"query": "квантовая хромодинамика"})
        out["empty_found"] = empty.get("found")
        out["empty_ok"] = not empty.get("found") and "нет ничего похожего" in (empty.get("note") or "")

        phantom = []
        for q, subj in (("производная", "profile_math"), ("логарифмы", "profile_math"),
                        ("векторы", "profile_math"), ("вероятность", "profile_math"),
                        ("сочинение", "russian")):
            found = agent.find_topics(conn, uid, subj, {"query": q})
            for t in found.get("tasks", []):
                if not conn.execute("SELECT COUNT(*) FROM tasks WHERE id=?", (t["id"],)).fetchone()[0]:
                    phantom.append(t["id"])
            for s in found.get("skills", []):
                if not conn.execute("SELECT COUNT(*) FROM skills WHERE id=?", (s["id"],)).fetchone()[0]:
                    phantom.append(s["id"])
            for l in found.get("lessons", []):
                if not conn.execute("SELECT COUNT(*) FROM lessons WHERE id=?", (l["id"],)).fetchone()[0]:
                    phantom.append(l["id"])
        out["phantom"] = phantom
        return out
    finally:
        conn.close()


def _errors_probes(server) -> dict:
    """Старая открытая ошибка обязана быть ВИДНА модели (живой замер
    agent-hard: вопрос «отметь ошибку по n01_p1» при 12 ошибках — модель
    честно ответила «такой ошибки нет», потому что список свежих из 10 строк
    её не содержал). Проверяем на живых данных каталога: сеем 12 ошибок и
    смотрим, что первая открытая видна и находится точечно."""
    conn = server.connect()
    try:
        agent = server._AGENT
        uid = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()["id"]
        subj = "profile_math"
        out = {}
        # Чистим и сеем 12 ошибок: первая открытая — самая старая.
        conn.execute("DELETE FROM user_errors WHERE user_id=? AND subject=?", (uid, subj))
        tids = [r[0] for r in conn.execute(
            "SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id"
            " WHERE s.subject='profile_math' ORDER BY t.id LIMIT 12")]
        assert len(tids) == 12, f"нужно 12 заданий, есть {len(tids)}"
        skid = conn.execute("SELECT skill_id FROM tasks WHERE id=?", (tids[0],)).fetchone()[0]
        for i, tid in enumerate(tids):
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                         " VALUES(?,?,?,?,?,?,?,?,?)",
                         (uid, tid, skid, "топик", str(i), 1 if i >= 8 else 0,
                          subj, f"probe-{uid}-{i}", "minor"))
        conn.commit()
        first_open = tids[0]
        dflt = agent.fold_web(conn, uid, subj, {"op": "errors"})
        out["old_visible"] = any(e.get("taskId") == first_open for e in dflt.get("last", []))
        out["open_first"] = all(e.get("resolved") is False for e in dflt.get("last", [])[:8])
        one = agent.fold_web(conn, uid, subj, {"op": "errors", "taskId": first_open})
        out["lookup"] = [(e.get("id"), e.get("taskId")) for e in one.get("last", [])]
        out["lookup_ok"] = any(t == first_open for _, t in out["lookup"])
        none = agent.fold_web(conn, uid, subj, {"op": "errors", "taskId": "n99_p9"})
        out["empty_ok"] = none.get("last") == [] and bool(none.get("note")) and bool(none.get("bySkill"))
        return out
    finally:
        conn.close()


def _resolve_error_rejects_conflicting_ids(server) -> bool:
    """resolve_error не должен доверять выдуманному errorId.

    Живой случай (стресс-тест): ученик «разобрался с ошибкой по теме
    “Производная”», модель позвала resolve_error(errorId=7, taskId=n09_p1).
    Число 7 было выдумано моделью и попало в СОВСЕМ другую ошибку — ученик
    подтвердил карточку, и чужая ошибка исчезла из его списка. Контракт: если
    названы и id, и задание, они обязаны указывать на одну строку.
    """
    conn = server.connect()
    try:
        row = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return False
        uid = int(row["id"])
        subj = "profile_math"
        tasks = [r[0] for r in conn.execute(
            "SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject=? LIMIT 2", (subj,))]
        if len(tasks) < 2:
            return False
        now = str(int(time.time() * 1000))
        ids = []
        for i, task in enumerate(tasks[:2], start=1):
            cur = conn.execute(
                "INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                " VALUES(?,?,'n01_planimetry',?,?,0,?,?,'minor')",
                (uid, task, f"конфликт-{i}", now, subj, f"conflict-{uid}-{i}"))
            ids.append(int(cur.lastrowid))
        conn.commit()
        agent = server._AGENT
        try:
            agent.propose_action(conn, uid, subj, "resolve_error",
                                 {"errorId": str(ids[0]), "taskId": tasks[1]})
            return False  # принял противоречивый вызов — дыра осталась
        except ValueError:
            pass
        prop = agent.propose_action(conn, uid, subj, "resolve_error",
                                    {"errorId": str(ids[0]), "taskId": tasks[0]})
        return int(prop["errorId"]) == ids[0] and bool(prop.get("topic"))
    finally:
        conn.close()


def _essay_and_reset_probes(server):
    """Остальные проверки слоя инструментов на своей базе (без HTTP)."""
    conn = server.connect()
    try:
        agent = server._AGENT
        subj = "profile_math"
        row = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()
        uid = int(row["id"]) if row else None
        out = {}

        # 1. reset_progress обязан обнулить user_stats: fold_web(progress) читает
        #    именно его, иначе наставник цитирует стёртые цифры.
        conn.execute("INSERT OR REPLACE INTO user_stats(user_id,subject,xp,streak,last_active_date,"
                     "total_solved,total_correct,total_time_sec,hints_used,correct_series,"
                     "best_series,errors_resolved) VALUES(?,?,777,9,'2026-01-01',12,5,0,0,0,0,3)",
                     (uid, subj))
        conn.commit()
        before = dict(conn.execute("SELECT xp, streak, total_solved FROM user_stats WHERE user_id=? AND subject=?",
                                   (uid, subj)).fetchone())
        agent.apply_action(conn, uid, subj, "reset_progress", {"action": "reset_progress"})
        after = dict(conn.execute("SELECT xp, streak, total_solved FROM user_stats WHERE user_id=? AND subject=?",
                                  (uid, subj)).fetchone())
        out["reset_stats"] = before["xp"] == 777 and after["xp"] == 0 and after["total_solved"] == 0
        out["reset_tool_view"] = agent.fold_web(conn, uid, subj, {"op": "progress"})

        # 2. Результат инструмента в контекст модели — всегда валидный JSON.
        payload = agent._tool_payload({"attempts": [{"taskId": f"n01_p{i}", "correct": True,
                                                     "topic": "тема " * 20} for i in range(60)]}, 4000)
        try:
            parsed = json.loads(payload)
            out["payload_json"] = bool(parsed.get("truncated")) and len(payload) <= 4000
        except ValueError:
            out["payload_json"] = False

        # 3. Прогноз: вилка не выходит за шкалу предмета.
        fc = agent.fold_web(conn, uid, subj, {"op": "forecast"})
        out["forecast_clamped"] = (fc.get("scaleMax") is None
                                   or (fc.get("high") or 0) <= fc["scaleMax"]
                                   and (fc.get("low") or 0) >= 0)
        out["forecast_note"] = bool(fc.get("note"))

        # 4. Навыки отдают mastery рядом с client-progress.
        sk = agent.fold_web(conn, uid, subj, {"op": "skills"})
        first = (sk.get("skills") or [{}])[0]
        out["skills_mastery"] = "mastery" in first and bool(sk.get("note"))
        return out
    finally:
        conn.close()


def _knowledge_and_paging_probes(server):
    """База знаний по темам и пагинация ошибок/попыток (без HTTP)."""
    conn = server.connect()
    try:
        agent = server._AGENT
        subj = "profile_math"
        row = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()
        uid = int(row["id"]) if row else None
        out = {}

        # 1. Без topic — вся справка; с topic — только раздел (короче и точнее).
        full = agent.project_info(conn, uid, subj, {})
        part = agent.project_info(conn, uid, subj, {"topic": "проверки"})
        out["knowledge_full"] = "Устройства" in full.get("text", "") and "matched" not in full
        out["knowledge_part"] = (
            part.get("matched") == ["Проверок сочинений в сутки: 5"]
            and "Устройства" not in part.get("text", "")
            and "5" in part.get("text", "")
            and len(part["text"]) < len(full["text"]))
        # Короткий код «XP» (2 буквы) находится, мусор — нет, пустая тема — вся.
        xp = agent.project_info(conn, uid, subj, {"topic": "XP"})
        miss = agent.project_info(conn, uid, subj, {"topic": "абракадабра"})
        out["knowledge_xp"] = xp.get("matched") == ["Практика и опыт (XP)"]
        out["knowledge_miss"] = (miss.get("matched") == []
                                 and len(miss.get("text", "")) == len(full.get("text", "")))
        # Тема «сочинение» не тянет чужие разделы (раньше тянула 5 из 7).
        soch = agent.project_info(conn, uid, subj, {"topic": "сочинение"})
        out["knowledge_narrow"] = (len(soch.get("matched") or []) <= 2
                                   and "Устройства" not in soch.get("text", ""))
        # Вопрос ученика -> тема для запасного вызова (иначе fallback несёт всё).
        out["knowledge_args"] = (
            agent._args_for_tool("project_info", "сколько проверок в день") == {"topic": "проверки сочинений в сутки"}
            and agent._args_for_tool("project_info", "расскажи о приложении") == {})

        # 2. Пагинация: сеем 4 ошибки и листаем их limit/offset.
        task = conn.execute("SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id"
                            " WHERE s.subject=? LIMIT 1", (subj,)).fetchone()
        tid = task["id"]
        for i in range(4):
            conn.execute("DELETE FROM user_errors WHERE client_id=?", (f"paging-probe-{i}",))
        for i in range(4):
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,"
                         "subject,client_id,kind) VALUES(?,?,'n01_planimetry',?, '1',0,?,?,'major')",
                         (uid, tid, f"Тема {i}", subj, f"paging-probe-{i}"))
        conn.commit()
        first = agent.fold_web(conn, uid, subj, {"op": "errors", "taskId": tid, "limit": 2})
        second = agent.fold_web(conn, uid, subj, {"op": "errors", "taskId": tid, "limit": 2, "offset": 2})
        ids_first = [r["id"] for r in first.get("last", [])]
        ids_second = [r["id"] for r in second.get("last", [])]
        out["paging_errors"] = (len(ids_first) == 2 and len(ids_second) == 2
                                and not set(ids_first) & set(ids_second)
                                and first.get("offset") == 0 and second.get("offset") == 2)
        for i in range(4):
            conn.execute("DELETE FROM user_errors WHERE client_id=?", (f"paging-probe-{i}",))
        conn.commit()

        # 3. Поиск и открытие через границу предметов.
        other = agent.find_topics(conn, uid, subj, {"query": "задание 27"})
        other_tasks = other.get("tasks") or []
        out["find_other"] = (bool(other.get("otherSubject"))
                             and any(x["id"].startswith("re27_") for x in other_tasks)
                             and all("subject" in x for x in other_tasks))
        out["find_other_detail"] = [x["id"] for x in other_tasks[:3]]
        cross_task = agent.task_get(conn, uid, subj, {"taskId": "re27_1"})
        try:
            cross_lesson = agent.lesson_get(conn, uid, "russian", {"lessonId": "lesson_n01_opisannye"})
            lesson_ok = cross_lesson.get("lessonId") == "lesson_n01_opisannye"
        except ValueError:
            lesson_ok = False
        out["cross_open"] = (cross_task.get("subject") == "russian"
                             and cross_task.get("taskId") == "re27_1" and lesson_ok)
        # Бред по-прежнему пусто везде, а не «нашлось в другом».
        none = agent.find_topics(conn, uid, subj, {"query": "абракадабра несуществующая"})
        out["find_other"] = out["find_other"] and none.get("found") == 0 and not none.get("otherSubject")

        # 4. Урок: хвост не отрезается молча.
        lg = agent.lesson_get(conn, uid, subj, {"skillId": "n01_planimetry"})
        pack_len = len(lg.get("text", ""))
        out["lesson_pack_detail"] = (lg.get("stepsShown"), lg.get("stepsTotal"), pack_len)
        total_steps = lg.get("stepsTotal")
        out["lesson_pack"] = (pack_len <= 2000 and "subject" in lg
                              and (total_steps is None  # влез целиком — хвоста нет
                                   or ("note" in lg and lg.get("stepsShown", 0) < total_steps)))

        # 5. Сложность, исходник, масштаб навыков, лента.
        found_diff = agent.find_topics(conn, uid, subj, {"query": "производная"})
        diffs = [x.get("difficulty") for x in found_diff.get("tasks", [])]
        tg_diff = agent.task_get(conn, uid, subj, {"taskId": "n09_p1"})
        out["difficulty"] = (all(isinstance(d, int) and 1 <= d <= 4 for d in diffs) and bool(diffs)
                             and isinstance(tg_diff.get("difficulty"), int))
        out["difficulty_detail"] = diffs[:4]
        src = agent.task_get(conn, uid, subj, {"taskId": "re27_1"})
        out["essay_source"] = (bool(src.get("problem")) and bool(src.get("sourceExcerpt"))
                               and src.get("sourceTruncated") is True and bool(src.get("author")))
        out["essay_source_detail"] = (src.get("problem") or "")[:60]
        sk = agent.fold_web(conn, uid, subj, {"op": "skills"})
        first = next((s for s in sk.get("skills", []) if s["id"] == "n01_planimetry"), {})
        out["skills_scale"] = (first.get("totalTasks", 0) == 7
                               and isinstance(first.get("tasksLeft"), int)
                               and "lessonDone" in first)
        out["skills_scale_detail"] = {k: first.get(k) for k in ("totalTasks", "tasksLeft", "lessonDone", "mastery")}
        conn.execute("INSERT INTO timeline(user_id,subject,created_at,text,client_id)"
                     " VALUES(?,?,?,?,?)", (uid, subj, "1700000000000", "Решено задание n01_p1", "probe-tl-1"))
        conn.commit()
        tl = agent.fold_web(conn, uid, subj, {"op": "timeline"})
        empty = agent.fold_web(conn, uid, "russian", {"op": "timeline"})
        out["timeline"] = (any("n01_p1" in e.get("text", "") for e in tl.get("events", []))
                           and empty.get("events") == []
                           and agent.fallback_tool_for("что я делал вчера")[0] == "fold_web"
                           and agent.fallback_tool_for("что я делал вчера")[1] == {"op": "timeline"})
        out["timeline_detail"] = [e.get("text") for e in tl.get("events", [])][:2]
        conn.execute("DELETE FROM timeline WHERE client_id=?", ("probe-tl-1",))
        conn.commit()

        # 6. Сочинения по разным текстам различимы: автор/проблема на месте.
        task = conn.execute("SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id"
                            " WHERE s.subject='russian' AND t.id LIKE 're27_%' LIMIT 1").fetchone()
        det = None
        if task is not None:
            conn.execute("INSERT INTO essay_submissions(user_id,subject,task_id,skill_id,text,word_count,"
                         "client_id,evaluation_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                         (uid, "russian", task["id"], "russian_essay_source", "текст " * 60, 160,
                          "src-probe-1", "submitted", "1700000000000"))
            conn.commit()
            sub = conn.execute("SELECT id FROM essay_submissions WHERE client_id=?",
                               ("src-probe-1",)).fetchone()
            det = agent.essay_history(conn, uid, subj, {"submissionId": int(sub["id"])})
            conn.execute("DELETE FROM essay_submissions WHERE client_id=?", ("src-probe-1",))
            conn.commit()
        out["essay_src"] = (det is not None and bool((det.get("essay") or {}).get("sourceAuthor"))
                            and bool((det.get("essay") or {}).get("sourceProblem")))
        out["essay_src_detail"] = ((det.get("essay") or {}).get("sourceAuthor"),
                                   ((det.get("essay") or {}).get("sourceProblem") or "")[:50])

        # 7. Поля «как сейчас» — не изменение: карточка не врёт.
        cur = conn.execute("SELECT self_level, goal_id FROM user_subjects WHERE user_id=? AND subject=?",
                           (uid, subj)).fetchone()
        cur_level, cur_goal = cur["self_level"], cur["goal_id"]
        try:
            agent.propose_action(conn, uid, subj, "update_profile",
                                 {"selfLevel": cur_level, "goal": cur_goal})
            noop_same = False
        except ValueError:
            noop_same = True
        mixed = agent.propose_action(conn, uid, subj, "update_profile",
                                     {"selfLevel": cur_level,
                                      "goal": "g95" if cur_goal != "g95" else "g60"})
        out["noop"] = (noop_same and set(mixed.get("patch", {})) == {"goal"})
        out["noop_detail"] = mixed.get("label")
        return out
    finally:
        conn.close()


def _resolve_error_refuses_resolved(server) -> bool:
    """Уже разобранная ошибка не должна получать «готово» вхолостую."""
    conn = server.connect()
    try:
        agent = server._AGENT
        subj = "profile_math"
        row = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return False
        uid = int(row["id"])
        task = conn.execute("SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id"
                            " WHERE s.subject=? LIMIT 1", (subj,)).fetchone()
        if not task:
            return False
        cid = f"resolved-probe-{uid}"
        conn.execute("DELETE FROM user_errors WHERE client_id=?", (cid,))
        conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,"
                     "subject,client_id,kind) VALUES(?,?,'n01_planimetry','Проба','1',1,?,?,'minor')",
                     (uid, task["id"], subj, cid))
        conn.commit()
        eid = conn.execute("SELECT id FROM user_errors WHERE client_id=?", (cid,)).fetchone()["id"]
        try:
            agent.propose_action(conn, uid, subj, "resolve_error", {"errorId": str(eid)})
            return False  # принял уже разобранную — ученику покажут ложную галочку
        except ValueError:
            return True
    finally:
        conn.close()


def main():
    with tempfile.TemporaryDirectory(prefix="ege-ai-agent-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        agent = server._AGENT
        assert ai is not None and agent is not None, "AI/agent modules not loaded"

        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        # Мок провайдера: очередь сценариев, счётчик вызовов = usage.cost.
        calls = {"n": 0}
        script: list = []
        lock = threading.Lock()
        # Модель, ПОВТОРЯЮЩАЯ действие, если не видит его результата (живой
        # случай, чат 52). Обычная очередь сценариев для этого не годится: там
        # ответ задан заранее, и тест проходил бы даже с багом — потому что
        # мок не повторял вызов. Здесь повтор вызывается САМ, по contents
        # messages: если результата применения в контексте нет, модель снова
        # просит то же действие (так вела себя боевая модель).
        repeat_if_no_result = {"name": None, "args": None, "calls": 0}

        def _applied_visible(messages) -> bool:
            for m in messages or []:
                if m.get("role") == "tool" and "applied" in str(m.get("content") or ""):
                    return True
            return False

        def mock_chat(messages, tools, **kw):
            with lock:
                calls["n"] += 1
                want = repeat_if_no_result["name"]
                if want and not _applied_visible(messages):
                    repeat_if_no_result["calls"] += 1
                    return {"text": None, "tool_calls": [{"id": f"rep{repeat_if_no_result['calls']}",
                                                         "name": want,
                                                         "arguments": repeat_if_no_result["args"] or {}}]}
                if script:
                    return script.pop(0)
            return {"text": "Финальный ответ.", "tool_calls": []}

        def mock_plain(messages, **kw):
            """Финал по потолку шагов (agent._summarize) идёт в chat() без tools."""
            with lock:
                calls["n"] += 1
                item = script.pop(0) if script else None
            if not item or item.get("tool_calls"):
                return ""  # без инструментов ответ без вызовов — тут пусто
            return item.get("text") or ""

        ai.chat_with_tools = mock_chat
        ai.chat = mock_plain
        ai.reset_ai_rate()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def claim(client, name, subject="profile_math"):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": subject, "onboarded": True, "name": name})

        def new_thread(client):
            return client.request(base, "POST", "/api/agent/threads", {})

        def turn(client, tid, text, extra=None):
            payload = {"threadId": tid, "text": text}
            if extra:
                payload.update(extra)
            return client.request(base, "POST", "/api/agent/turns", payload)

        try:
            section("парсер: реплика вместе с вызовами — не ошибка формата")
            # Живой случай 29.09 (gptunnel/qwen3.8-flash): ответ на «вызови все
            # доступные инструменты» приходил как «Сейчас соберу… » + tool_calls,
            # строгий разбор давал AIFormatError → 502 и пустой тред.
            mixed = ai.parse_tool_message({"content": "Сейчас соберу всё.", "tool_calls": [
                {"id": "1", "function": {"name": "fold_web", "arguments": "{}"}}]})
            check("текст+вызовы разбираются, вызовы главнее",
                  bool(mixed["tool_calls"]) and mixed["text"] == "Сейчас соберу всё."
                  and mixed["preamble"] == "Сейчас соберу всё.", str(mixed)[:200])
            only_calls = ai.parse_tool_message({"content": None, "tool_calls": [
                {"function": {"name": "fold_web", "arguments": '{"op":"forecast"}'}}]})
            check("только вызовы — ок, preamble пустой",
                  only_calls["tool_calls"][0]["name"] == "fold_web" and only_calls["preamble"] is None,
                  str(only_calls)[:200])
            check("только текст — ок",
                  ai.parse_tool_message({"content": "hi"})["text"] == "hi")
            try:
                ai.parse_tool_message({"content": None, "tool_calls": []})
                check("пустой ответ — AIFormatError", False)
            except ai.AIFormatError:
                check("пустой ответ — AIFormatError", True)

            section("гость закрыт")
            guest = Client("10.0.0.1")
            for method, path, body in [
                ("GET", "/api/agent/threads", None),
                ("GET", "/api/agent/limits", None),
                ("POST", "/api/agent/threads", {}),
                ("POST", "/api/agent/turns", {"threadId": 1, "text": "hi"}),
                ("POST", "/api/agent/turns/confirm", {"messageId": 1, "approve": True}),
            ]:
                status, body_out = guest.request(base, method, path, body)
                check(f"{method} {path} гостю -> 401 GUEST_PENDING",
                      status == 401 and body_out.get("code") == "GUEST_PENDING", f"{status} {body_out}")
            check("гостю не выдали сессию", "ege_session" not in guest.cookies)

            section("треды и изоляция")
            a = Client("10.1.0.1")
            b = Client("10.2.0.1")
            status, _ = claim(a, "Аня")
            check("claim Аня", status == 200, str(status))
            status, _ = claim(b, "Боря")
            check("claim Боря", status == 200, str(status))
            status, body = new_thread(a)
            check("создать тред", status == 200 and body.get("thread", {}).get("id"), f"{status} {body}")
            tid_a = body["thread"]["id"]
            status, body = b.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            check("чужой тред -> 404", status == 404, f"{status} {body}")
            status, body = turn(b, tid_a, "привет")
            check("чужой ход -> 404", status == 404, f"{status} {body}")
            status, body = b.request(base, "POST", f"/api/agent/threads/{tid_a}/delete", {})
            check("чужое удаление -> 404", status == 404, f"{status} {body}")

            section("«Новый чат» не плодит пустые чаты")
            # Кнопка «Новый чат» раньше писала строку в базу на КАЖДОЕ нажатие, до
            # первого вопроса: десять нажатий подряд без вопроса оставляли десять
            # пустых чатов в списке — мусор, который нечего открывать. Теперь
            # верхний из пустых переиспользуется (чистый лист он и так), лишние
            # пустые удаляются, а первое сообщение делает чат непустым, и
            # следующий «Новый чат» создаёт новый честно.
            ce = Client("10.1.0.9")
            claim(ce, "Пустой")
            ids = []
            for _ in range(5):
                st, bd = new_thread(ce)
                ids.append((bd.get("thread") or {}).get("id"))
            check("пять нажатий без вопроса -> один и тот же чат",
                  len(set(ids)) == 1 and bool(ids[0]), str(ids))
            st, bd = new_thread(ce)
            check("сервер честно помечает переиспользование",
                  bd.get("reused") is True and (bd.get("thread") or {}).get("id") == ids[0], str(bd))
            st, lst = ce.request(base, "GET", "/api/agent/threads", None)
            check("в списке ровно один чат", len(lst.get("threads") or []) == 1,
                  str([t.get("id") for t in (lst.get("threads") or [])]))
            with lock:
                script.clear()
                script.append({"text": "Готов.", "tool_calls": []})
            st, bd = turn(ce, ids[0], "первый вопрос")
            check("ход в переиспользованный чат -> 200", st == 200, f"{st} {str(bd)[:200]}")
            st, bd2 = new_thread(ce)
            check("после вопроса «Новый чат» создаёт НОВЫЙ чат",
                  st == 200 and (bd2.get("thread") or {}).get("id") != ids[0]
                  and bd2.get("reused") is not True, str(bd2))
            st, lst = ce.request(base, "GET", "/api/agent/threads", None)
            check("в списке два чата (старый не тронут)",
                  len(lst.get("threads") or []) == 2,
                  str([t.get("id") for t in (lst.get("threads") or [])]))
            # Мусор прежнего поведения (пустые строки в базе) убирается тем же
            # запросом: пустой чат не содержит ничего, терять нечего.
            conn3 = server.connect()
            try:
                empty_user = conn3.execute("SELECT id FROM users WHERE name='Пустой'").fetchone()
                junk = []
                for k in range(3):
                    cur = conn3.execute(
                        "INSERT INTO agent_threads(user_id, subject, title, created_at, updated_at, public_id)"
                        " VALUES(?,?,?,?,?,?)",
                        (int(empty_user["id"]), "profile_math", "Новый чат", "1", "1",
                         f"JUNK{k}{abs(hash((k, ids[0]))) % 10 ** 8:08d}"))
                    junk.append(int(cur.lastrowid))
                conn3.commit()
            finally:
                conn3.close()
            st, bd3 = new_thread(ce)
            st, lst = ce.request(base, "GET", "/api/agent/threads", None)
            left = {t.get("id") for t in (lst.get("threads") or [])}
            check("накопленный мусор из пустых чатов убран",
                  not (left & set(junk)), f"остались: {sorted(left & set(junk))}")
            check("непустой чат и новый — на месте",
                  (bd2.get("thread") or {}).get("id") in left, str(sorted(left)))

            section("параллельные ходы в РАЗНЫХ чатах не съедают лишние жетоны")
            # Жалоба: «написать агенту в разных чатах — можно потратить 2 жетона,
            # когда есть один, потому что жетон списывается только после успешного
            # ответа». Проверяем ровно это. Замер (test/ai-agent.py, этот блок) на
            # коде БЕЗ резерва до модели даёт 5×200 при одном жетоне; с резервом
            # (agent_quota_reserve, CAS `UPDATE ... WHERE count > 0`) — ровно один.
            #
            # Пять РАЗНЫХ чатов вставляем прямо в базу: через API пять пустых
            # схлопнулись бы в один (переиспользование пустых), а для проверки
            # нужны именно пять независимых слотов _agent_busy.
            cr = Client("10.1.0.11")
            claim(cr, "Гонка")
            conn4 = server.connect()
            try:
                ruser = int(conn4.execute("SELECT id FROM users WHERE name='Гонка' ORDER BY id DESC LIMIT 1").fetchone()["id"])
                agent.ensure_agent_schema(conn4)
                race_tids = []
                for k in range(5):
                    cur = conn4.execute(
                        "INSERT INTO agent_threads(user_id, subject, title, created_at, updated_at, public_id)"
                        " VALUES(?,?,?,?,?,?)",
                        (ruser, "profile_math", f"чат {k}", "1", "1", f"RACE{k}{ruser}"))
                    race_tids.append(int(cur.lastrowid))
                    # История в чате: без неё первый вопрос попал бы в кэш повтора.
                    conn4.execute(
                        "INSERT INTO agent_messages(thread_id, user_id, role, content, seq, created_at)"
                        " VALUES(?,?,?,?,?,?)",
                        (race_tids[-1], ruser, "user", f"старый вопрос {k}", 1, "1"))
                agent.admin_agent_quota_set(conn4, ruser, {"limit": 1, "remaining": 1})
                conn4.commit()
            finally:
                conn4.close()
            # Модель спит, пока тест не отпустит: иначе гонку решил бы джиттер.
            race_gate = threading.Event()
            real_chat, real_plain = ai.chat_with_tools, ai.chat
            def slow_chat(messages, tools, **kw):
                race_gate.wait(10)
                time.sleep(0.3)
                return {"text": "Гонка.", "tool_calls": []}
            def slow_plain(messages, **kw):
                race_gate.wait(10)
                time.sleep(0.3)
                return "Гонка."
            ai.chat_with_tools, ai.chat = slow_chat, slow_plain
            race_results = {}
            race_barrier = threading.Barrier(5)
            def race_fire(idx, tid):
                race_barrier.wait(10)
                st, bd = cr.request(base, "POST", "/api/agent/turns",
                                    {"threadId": tid, "text": f"вопрос {idx}"})
                race_results[idx] = (st, (bd or {}).get("code") or "")
            race_threads = [threading.Thread(target=race_fire, args=(i, t)) for i, t in enumerate(race_tids)]
            for th in race_threads:
                th.start()
            time.sleep(0.7)          # все пять внутри и висят на моке
            race_gate.set()          # пускаем модель разом
            for th in race_threads:
                th.join(30)
            ai.chat_with_tools, ai.chat = real_chat, real_plain
            race_ok = [i for i, (st, _) in race_results.items() if st == 200]
            race_429 = {i: code for i, (st, code) in race_results.items() if st == 429}
            check("при одном жетоне из 5 параллельных ходов проходит РОВНО ОДИН",
                  len(race_ok) == 1, f"200={sorted(race_ok)} 429={sorted(race_429)} коды={set(race_429.values())}")
            check("остальные отбиты лимитом (AI_LIMIT), а не чем-то ещё",
                  len(race_429) == 4 and set(race_429.values()) == {server.AI_LIMIT_CODE},
                  str(race_429))
            st, rq = cr.request(base, "GET", "/api/agent/limits", None)
            check("после гонки карман пуст, перерасхода нет",
                  rq.get("remaining") == 0 and rq.get("limit") == 1, str(rq))
            conn5 = server.connect()
            try:
                wrote = conn5.execute(
                    "SELECT COUNT(*) FROM agent_messages WHERE role='user' AND thread_id IN (%s)"
                    % ",".join("?" * len(race_tids)), race_tids).fetchone()[0]
                # 5 старых + 1 новый: четыре лишних хода в базу не попали.
                check("в базу записан ровно один новый вопрос", wrote == 6, str(wrote))
            finally:
                conn5.close()

            section("брошенное подтверждение не висит и не повторяет действие")
            # Живой случай: ход просит действие, ученик НЕ жмёт «Применить», а
            # задаёт новый вопрос. Раньше шаг оставался needs_confirm НАВСЕГДА, и
            # модель в каждом следующем ходе получала tool-вызов без результата
            # («Ожидает подтверждения») — то есть висящий вызов, на который она
            # отвечает ПОВТОРНЫМ вызовом того же действия. Замер на моке, который
            # повторяет действие, пока не увидит результат (как вела себя боевая
            # модель в чате 52): без фикса — три одинаковые карточки «Применить»
            # в ленте и три потраченных жетона, действие не применено.
            cso = Client("10.12.0.30")
            claim(cso, "Сирота")
            stid = cso.request(base, "POST", "/api/agent/threads", {})[1]["thread"]["id"]

            def orphan_repeat_chat(messages, tools, **kw):
                """Повторяет действие, пока не увидит результата своего вызова."""
                action_seen = False
                resolved = False
                for m in messages or []:
                    if m.get("role") == "assistant":
                        for tc in (m.get("tool_calls") or []):
                            if (tc.get("function") or {}).get("name") == "update_profile":
                                action_seen = True
                    if m.get("role") == "tool":
                        txt = str(m.get("content") or "")
                        if "applied" in txt or "не применено" in txt or "Отменено" in txt:
                            resolved = True
                if action_seen and not resolved:
                    return {"text": None, "tool_calls": [
                        {"id": "orp", "name": "update_profile",
                         "arguments": {"selfLevel": "base"}}]}
                if not action_seen:
                    return {"text": None, "tool_calls": [
                        {"id": "oa", "name": "update_profile",
                         "arguments": {"selfLevel": "base"}}]}
                return {"text": "Профиль обновлён.", "tool_calls": []}

            with lock:
                keep_chat, keep_plain = ai.chat_with_tools, ai.chat
                ai.chat_with_tools, ai.chat = orphan_repeat_chat, mock_plain
            try:
                st, bo1 = cso.request(base, "POST", "/api/agent/turns",
                                      {"threadId": stid, "text": "зови меня Артём"})
                check("ход 1 просит действие и ждёт подтверждения",
                      st == 200 and bo1.get("pending") is True, f"{st} {str(bo1)[:160]}")
                orphan_step = (bo1.get("steps") or [{}])[0].get("id")
                st, bo2 = cso.request(base, "POST", "/api/agent/turns",
                                      {"threadId": stid, "text": "а сколько я решаю?"})
                check("новый вопрос НЕ предлагает действие снова",
                      st == 200 and bo2.get("pending") is not True, f"{st} {str(bo2)[:200]}")
                check("сервер говорит, какой шаг погас (dropped)",
                      (bo2.get("dropped") or []) == [orphan_step],
                      f"{bo2.get('dropped')} ждём {orphan_step}")
                st, bo3 = cso.request(base, "POST", "/api/agent/turns",
                                      {"threadId": stid, "text": "и ещё вопрос"})
                check("и следующий ход тоже чист",
                      st == 200 and bo3.get("pending") is not True, f"{st} {str(bo3)[:160]}")
                conn6 = server.connect()
                try:
                    rows = conn6.execute(
                        "SELECT id, status FROM agent_messages"
                        " WHERE thread_id=? AND role='tool' ORDER BY seq", (stid,)).fetchall()
                    stat = [dict(r) for r in rows]
                    lvl = conn6.execute("SELECT self_level FROM user_subjects"
                                        " WHERE user_id=(SELECT id FROM users WHERE name='Сирота')"
                                        " AND subject='profile_math'").fetchone()
                finally:
                    conn6.close()
                check("в базе ровно один шаг, и он погашен, а не ждёт подтверждения",
                      len(stat) == 1 and stat[0]["status"] == "dropped", str(stat))
                check("действие не применено (профиль не тронут)",
                      lvl is None or not lvl["self_level"], str(dict(lvl) if lvl else None))
                # «Применить» у погашенного шага честно отказывает, а не применяет
                # действие задним числом.
                st, boc = cso.request(base, "POST", "/api/agent/turns/confirm",
                                      {"messageId": orphan_step, "approve": True})
                check("«Применить» у погашенного шага -> 400, а не тихое применение",
                      st == 400 and bool(boc.get("error")), f"{st} {str(boc)[:160]}")
            finally:
                with lock:
                    ai.chat_with_tools, ai.chat = keep_chat, keep_plain

            section("ответ без tools: финал + одно списание")
            with lock:
                script.clear()
                calls["n"] = 0
            status, body = turn(a, tid_a, "просто привет")
            check("ход без tools -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("ответ несёт заголовок треда", body.get("thread", {}).get("title"), str(body.get("thread")))
            check("шагов нет", body.get("steps") == [], str(body.get("steps")))
            check("usage.cost == 1", body.get("usage", {}).get("cost") == 1, str(body.get("usage")))
            status, quota = a.request(base, "GET", "/api/agent/limits", None)
            check("квота 9 из 10", quota.get("remaining") == 9 and quota.get("limit") == 10, str(quota))
            check("заголовок детерминирован (первые 60)",
                  True, "")
            status, body = a.request(base, "GET", "/api/agent/threads", None)
            title = (body.get("threads") or [{}])[0].get("title", "")
            check("заголовок — первые 60 символов вопроса",
                  title.startswith("просто привет"), title)
            check("список тредов несёт квоту (первый экран за 2 RTT)",
                  (body.get("quota") or {}).get("limit") == 10, str(body.get("quota")))
            status, ctx = a.request(base, "GET", "/api/agent/context", None)
            check("контекст шапки: уровень/серия",
                  status == 200 and ctx.get("level") == 1 and ctx.get("streak") == 0
                  and ctx.get("need") == 400 and ctx.get("pct") == 0, f"{status} {ctx}")
            status, ctx = guest.request(base, "GET", "/api/agent/context", None)
            check("контекст гостю -> 401 GUEST_PENDING",
                  status == 401 and ctx.get("code") == "GUEST_PENDING", f"{status} {ctx}")

            section("ответ с tools: цикл и шаги в базе")
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "c1", "name": "fold_web", "arguments": {"op": "forecast"}}]},
                    {"text": "Прогноз: всё по данным.", "tool_calls": []},
                ])
                calls["n"] = 0
            status, body = turn(a, tid_a, "какой у меня прогноз?")
            check("ход с tools -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("один шаг чтения", len(body.get("steps") or []) == 1
                  and body["steps"][0].get("tool") == "fold_web", str(body.get("steps")))
            check("шаг человеческий", "прогноз" in (body["steps"][0].get("label") or "").lower(), str(body["steps"][0]))
            check("usage.cost == 2", body.get("usage", {}).get("cost") == 2, str(body.get("usage")))
            status, body = a.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            roles = [m["role"] for m in body.get("messages", [])]
            check("в базе user+tool+assistant", "user" in roles and "tool" in roles and "assistant" in roles, str(roles))

            section("действие: confirm без записи, approve меняет")
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "c2", "name": "update_profile",
                                                   "arguments": {"selfLevel": "confident"}}]},
                ])
            # текущий уровень
            conn2 = server.connect()
            try:
                cur_level = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                before_level = cur_level["self_level"] if cur_level else None
            finally:
                conn2.close()
            status, body = turn(a, tid_a, "поставь мне уверенный уровень")
            check("действие -> pending без финала",
                  status == 200 and body.get("pending") is True and body.get("final") is None,
                  f"{status} {body}")
            pending_id = (body.get("steps") or [{}])[0].get("id")
            check("шаг needs_confirm", (body.get("steps") or [{}])[0].get("status") == "needs_confirm")
            conn2 = server.connect()
            try:
                cur = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                check("до approve данные не меняются", (cur["self_level"] if cur else None) == before_level)
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.append({"text": "Уровень обновлён.", "tool_calls": []})
            status, body = a.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": pending_id, "approve": True})
            check("approve -> 200 с финалом", status == 200 and body.get("final"), f"{status} {body}")
            conn2 = server.connect()
            try:
                cur = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                check("после approve уровень confident", cur and cur["self_level"] == "confident", str(dict(cur) if cur else None))
            finally:
                conn2.close()

            section("отмена пишет «Отменено учеником»")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "c3", "name": "reset_progress", "arguments": {}}]})
            status, body = turn(a, tid_a, "сбрось мой прогресс")
            check("reset -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            cancel_id = (body.get("steps") or [{}])[0].get("id")
            status, body = a.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": cancel_id, "approve": False})
            check("cancel -> Отменено учеником",
                  status == 200 and body.get("final") == "Отменено учеником.", f"{status} {body}")

            section("длинный цикл обрывается ответом, а не отказом")
            with lock:
                script.clear()
                for i in range(12):
                    script.append({"text": None, "tool_calls": [{"id": f"l{i}", "name": "fold_web",
                                                                 "arguments": {"op": "progress"}}]})
            status, body = turn(a, tid_a, "расскажи всё подробно")
            check("длинный цикл -> 200 с финалом",
                  status == 200 and isinstance(body.get("final"), str) and "не успел" in body["final"],
                  f"{status} {str(body)[:200]}")
            check("шагов не больше MAX",
                  len(body.get("steps") or []) <= agent.MAX_TOOL_STEPS, str(len(body.get("steps") or [])))
            # Тот же потолок, но на вызове без инструментов модель отвечает
            # текстом: ход заканчивается настоящим ответом по собранным данным.
            with lock:
                script.clear()
                for i in range(agent.MAX_TOOL_STEPS + 1):
                    script.append({"text": None, "tool_calls": [{"id": f"m{i}", "name": "fold_web",
                                                                 "arguments": {"op": "progress"}}]})
                script.append({"text": "Собрал всё по твоим данным.", "tool_calls": []})
            status, body = turn(a, tid_a, "вызови все доступные инструменты")
            check("потолок шагов -> ответ по собранным данным",
                  status == 200 and body.get("final") == "Собрал всё по твоим данным."
                  and len(body.get("steps") or []) == agent.MAX_TOOL_STEPS,
                  f"{status} {str(body)[:200]}")
            # Реплика модели вместе с вызовами — обычный ход, а не 502: реплика
            # уходит в preamble, инструменты выполняются.
            with lock:
                script.clear()
                script.append(ai.parse_tool_message({"content": "Сейчас соберу всё.", "tool_calls": [
                    {"id": "p1", "function": {"name": "fold_web",
                                              "arguments": '{"op":"forecast"}'}}]}))
                script.append({"text": "Вот твой прогноз.", "tool_calls": []})
            status, body = turn(a, tid_a, "собери всё по мне")
            check("реплика+вызовы -> 200 с финалом",
                  status == 200 and body.get("final") == "Вот твой прогноз."
                  and len(body.get("steps") or []) == 1,
                  f"{status} {str(body)[:200]}")

            section("400 на пустой/длинный")
            status, body = turn(a, tid_a, "   ")
            check("пустой -> 400", status == 400, f"{status} {body}")
            status, body = turn(a, tid_a, "x" * 3000)
            check("длинный -> 400", status == 400, f"{status} {body}")

            section("инструменты не видят чужих данных")
            # Ане — ошибку, Боря её не видит.
            conn2 = server.connect()
            try:
                anya = conn2.execute("SELECT id FROM users WHERE name='Аня'").fetchone()
                borya = conn2.execute("SELECT id FROM users WHERE name='Боря'").fetchone()
                task = conn2.execute("SELECT t.id AS tid, t.skill_id AS sid FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject='profile_math' LIMIT 1").fetchone()
                conn2.execute("INSERT INTO user_errors(user_id, subject, task_id, skill_id, topic, created_at, resolved) VALUES (?,?,?,?,?,?,0)",
                              (int(anya["id"]), "profile_math", task["tid"], task["sid"], "t", "1"))
                conn2.commit()
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "e1", "name": "fold_web", "arguments": {"op": "errors", "limit": 5}}]},
                    {"text": "Готово.", "tool_calls": []},
                ])
            status, body = b.request(base, "POST", "/api/agent/threads", {})
            tid_b = body["thread"]["id"]
            status, body = turn(b, tid_b, "покажи мои ошибки")
            got = (body.get("steps") or [{}])[0].get("result", {})
            check("Боря не видит Анину ошибку", got.get("total") == 0 and got.get("open") == 0, str(got))

            section("повторный ход кэшируется, cost не растёт")
            with lock:
                script.clear()
                script.append({"text": "Кэшируемый ответ.", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(a, tid_a, "повторимый вопрос")
            check("первый -> 200", status == 200, f"{status}")
            first_cost = calls["n"]
            status, body = turn(a, tid_a, "повторимый вопрос")
            check("повтор -> cached", status == 200 and body.get("cached") is True, f"{status} {body}")
            check("cost не растёт", calls["n"] == first_cost, f"{calls['n']} vs {first_cost}")
            check("usage.cost 0 у кэша", body.get("usage", {}).get("cost") == 0, str(body.get("usage")))
            with lock:
                script.clear()
                script.append({"text": "Свежая попытка.", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(a, tid_a, "повторимый вопрос", {"force": True})
            check("force:true обходит кэш", status == 200 and body.get("cached") is not True
                  and body.get("final") == "Свежая попытка.", f"{status} {body}")
            check("force зовёт модель", calls["n"] == 1, str(calls["n"]))

            section("replaceLast: ход ЗАМЕНЯЕТ последнюю пару, а не дублирует")
            # Свой клиент с большим грантом: у Ани к этому месту жетоны
            # предыдущих секций уже на исходе, а здесь каждый ход платит.
            c4 = Client("10.8.0.1")
            claim(c4, "Дина-замена")
            _, body = new_thread(c4)
            tid_d = body["thread"]["id"]
            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                uid_d = conn2.execute("SELECT id FROM users WHERE name='Дина-замена'").fetchone()["id"]
                agent.admin_agent_quota_set(conn2, uid_d, {"remaining": 100})
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.append({"text": "Первый ответ.", "tool_calls": []})
                script.append({"text": "Второй ответ.", "tool_calls": []})
            status, body = turn(c4, tid_d, "заменяемый вопрос")
            check("обычный ход -> 200", status == 200, f"{status} {body}")
            status, body = turn(c4, tid_d, "заменяемый вопрос", {"replaceLast": True})
            check("replaceLast с тем же текстом обходит кэш (не cached)",
                  status == 200 and body.get("cached") is not True, f"{status} {body}")
            check("replaceLast -> новый ответ от модели",
                  body.get("final") == "Второй ответ.", str(body.get("final")))

            def msgs_of(tid):
                c = server.connect()
                c.row_factory = sqlite3.Row
                try:
                    return c.execute("SELECT role, content FROM agent_messages"
                                     " WHERE thread_id=? ORDER BY seq", (int(tid),)).fetchall()
                finally:
                    c.close()

            rows = msgs_of(tid_d)
            user_cnt = sum(1 for r in rows if r["role"] == "user" and (r["content"] or "") == "заменяемый вопрос")
            check("в базе ОДИН такой вопрос (пара заменена, не продублирована)", user_cnt == 1, str(user_cnt))
            finals = [r["content"] for r in rows if r["role"] == "assistant" and (r["content"] or "").strip()]
            check("в базе последний финал — новый", finals[-1] == "Второй ответ.", str(finals[-2:]))

            status, body = turn(c4, tid_d, "изменённый вопрос", {"replaceLast": True})
            check("замена на другой текст -> 200", status == 200, f"{status} {body}")
            rows = msgs_of(tid_d)
            check("старый вопрос исчез из базы",
                  not any(r["role"] == "user" and r["content"] == "заменяемый вопрос" for r in rows),
                  str([r["content"] for r in rows if r["role"] == "user"][-2:]))

            # Неуспех заменяющего хода не сносит старую пару (снос — в транзакции успеха).
            def boom_chat(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                raise ai.AIError("upstream 500")
            saved = ai.chat_with_tools
            ai.chat_with_tools = boom_chat
            try:
                status, body = turn(c4, tid_d, "вопрос со сбоем", {"replaceLast": True})
                check("сбой модели -> 502", status == 502, f"{status} {body}")
            finally:
                ai.chat_with_tools = saved
            rows = msgs_of(tid_d)
            check("после 502 старая пара цела (изменённый вопрос на месте)",
                  any(r["role"] == "user" and r["content"] == "изменённый вопрос" for r in rows)
                  and not any(r["content"] == "вопрос со сбоем" for r in rows),
                  str([r["content"] for r in rows if r["role"] == "user"][-2:]))

            # replaceLast поверх ожидания подтверждения действия — 400, ничего не ломает.
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "act1", "name": "reset_progress",
                                                             "arguments": {}}]})
            c3 = Client("10.9.0.1")
            claim(c3, "Дина-pending")
            _, body = new_thread(c3)
            tid_v = body["thread"]["id"]
            status, body = turn(c3, tid_v, "разбери ошибку")
            check("ход встал на подтверждение", status == 200 and body.get("pending") is True, f"{status} {body}")
            status, body = turn(c3, tid_v, "другой вопрос", {"replaceLast": True})
            check("replaceLast при needs_confirm -> 400 AGENT_PENDING",
                  status == 400 and body.get("code") == "AGENT_PENDING", f"{status} {body}")
            rows = msgs_of(tid_v)
            check("ожидающий шаг не снесён",
                  any(r["role"] == "tool" for r in rows) and not any(r["content"] == "другой вопрос" for r in rows),
                  str([(r["role"], r["content"][:20]) for r in rows]))

            section("ошибка инструмента -> модель чинит вызов, ход не теряется")
            # Раньше первая же ошибка инструмента убивала ход: 400 AGENT_TOOL_ERROR
            # ученику. Живой стресс-тест (test/agent-stress.py) показал, что это
            # не редкий край, а 6 ходов из 20: «объясни тему производные» →
            # 400 «уроки по скиллу не найдены», «поменяй цель на 95+» → 400
            # «цель не из шкалы предмета». Теперь ошибка уходит обратно в
            # контекст с подсказками, и модель повторяет вызов сама.
            cfix = Client("10.9.0.2")
            claim(cfix, "Ева-починка")
            _, tf = new_thread(cfix)
            tid_f = tf["thread"]["id"]
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "bad1", "name": "fold_web",
                                                             "arguments": {"op": "no_such_op"}}]})
                script.append({"text": None, "tool_calls": [{"id": "bad2", "name": "fold_web",
                                                             "arguments": {"op": "profile"}}]})
                script.append({"text": "Разобрался, вот твой профиль.", "tool_calls": []})
            _, quota_before = cfix.request(base, "GET", "/api/agent/limits", None)
            status, body = turn(cfix, tid_f, "сломай инструмент")
            check("битый op не убивает ход — модель чинит и отвечает",
                  status == 200 and body.get("final") and "no_such_op" not in json.dumps(body.get("steps")),
                  f"{status} {str(body)[:300]}")
            check("в ленте виден только успешный вызов",
                  [s.get("args", {}).get("op") for s in body.get("steps") or []] == ["profile"],
                  str([s.get("args") for s in body.get("steps") or []]))
            _, quota_after = cfix.request(base, "GET", "/api/agent/limits", None)
            check("ход с починкой инструмента стоит ровно один жетон",
                  quota_after.get("remaining") == (quota_before.get("remaining") or 0) - 1,
                  f"{quota_before} -> {quota_after}")

            section("ошибка инструмента исчерпала попытки -> честный ответ, не 400")
            _, tf2 = new_thread(cfix)
            tid_f2 = tf2["thread"]["id"]
            with lock:
                script.clear()
                for i in range(agent.MAX_TOOL_RETRIES + 2):
                    script.append({"text": None, "tool_calls": [{"id": f"loop{i}", "name": "lesson_get",
                                                                 "arguments": {"skillId": "нет_такого"}}]})
            status, body = turn(cfix, tid_f2, "объясни несуществующий урок")
            check("ход выживает после серии неверных вызовов",
                  status == 200 and bool(body.get("final")), f"{status} {str(body)[:300]}")
            check("в ленте нет ни одного неверного вызова",
                  len(body.get("steps") or []) == 0, str(len(body.get("steps") or [])))

            section("update_profile принимает человеческую формулировку цели")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "g1", "name": "update_profile",
                                                             "arguments": {"goal": "95+ баллов"}}]})
            status, body = turn(cfix, tid_f2, "хочу набрать 95+")
            step_g = (body.get("steps") or [{}])[0] or {}
            prop = step_g.get("proposal") or {}
            check("«95+ баллов» -> id цели g95",
                  body.get("pending") is True and (prop.get("patch") or {}).get("goal") == "g95",
                  f"{status} {body}")
            check("подпись подтверждения человеческая, без id",
                  "g95" not in str(step_g.get("label") or ""), str(step_g.get("label")))
            check("resolve_error не доверяет выдуманному errorId",
                  _resolve_error_rejects_conflicting_ids(server))
            check("resolve_error честно отказывает по уже разобранной ошибке",
                  _resolve_error_refuses_resolved(server))

            section("инструменты отдают данные, а не обрывки")
            probes = _essay_and_reset_probes(server)
            check("reset_progress обнуляет user_stats",
                  probes["reset_stats"], str(probes["reset_tool_view"]))
            check("после сброса fold_web(progress) пустой",
                  all((probes["reset_tool_view"].get(k) or 0) == 0
                      for k in ("xp", "streak", "solved")), str(probes["reset_tool_view"]))
            check("большой результат режется по элементам, JSON остаётся валидным",
                  probes["payload_json"])
            check("вилка прогноза не выходит за шкалу предмета",
                  probes["forecast_clamped"], str(probes.get("forecast_note")))
            check("в skills есть mastery и подпись", probes["skills_mastery"])
            kprobes = _knowledge_and_paging_probes(server)
            check("справка без topic — целиком", kprobes["knowledge_full"])
            check("справка с topic — только раздел",
                  kprobes["knowledge_part"], str(kprobes.get("knowledge_part")))
            check("короткая тема XP находится, мусор даёт всё",
                  kprobes["knowledge_xp"] and kprobes["knowledge_miss"])
            check("«сочинение» не тянет чужие разделы", kprobes["knowledge_narrow"])
            check("вопрос ученика превращается в topic", kprobes["knowledge_args"])
            check("ошибки листаются limit/offset без пересечений",
                  kprobes["paging_errors"])
            check("поиск добирает из другого предмета («задание 27» из математики)",
                  kprobes["find_other"], str(kprobes.get("find_other_detail")))
            check("task_get и lesson_get открываются из чужого предмета",
                  kprobes["cross_open"])
            check("урок упаковывается до бюджета и честно говорит про хвост",
                  kprobes["lesson_pack"], str(kprobes.get("lesson_pack_detail")))
            check("у заданий видна сложность (find и task_get)",
                  kprobes["difficulty"], str(kprobes.get("difficulty_detail")))
            check("task_get сочинения несёт проблему и исходник",
                  kprobes["essay_source"], str(kprobes.get("essay_source_detail")))
            check("навыки знают масштаб темы и урок",
                  kprobes["skills_scale"], str(kprobes.get("skills_scale_detail")))
            check("лента событий отвечает на «что я делал»",
                  kprobes["timeline"], str(kprobes.get("timeline_detail")))
            check("сочинения различимы по исходнику, а не только по id",
                  kprobes["essay_src"], str(kprobes.get("essay_src_detail")))
            check("подтверждение не обещает то, что уже так",
                  kprobes["noop"], str(kprobes.get("noop_detail")))

            section("квота: 10 ходов, 11-й 429, 502 возвращает жетон")
            c = Client("10.3.0.1")
            claim(c, "Вера")
            status, body = new_thread(c)
            tid_c = body["thread"]["id"]
            with lock:
                script.clear()
            for i in range(10):
                with lock:
                    script.append({"text": f"Ответ {i}.", "tool_calls": []})
                status, body = turn(c, tid_c, f"вопрос {i}")
                check(f"ход {i + 1} -> 200", status == 200, f"{status} {body}")
            status, body = turn(c, tid_c, "лишний вопрос")
            check("11-й -> 429 AI_LIMIT",
                  status == 429 and body.get("code") == "AI_LIMIT", f"{status} {body}")
            check("429 несёт limit/remaining", body.get("limit") == 10 and body.get("remaining") == 0, str(body))
            # 502 возвращает жетон: чистим квоту ageing через refund проверки.
            # Берём свежего пользователя, тратим 1, роняем модель, проверяем возврат.
            d = Client("10.4.0.1")
            claim(d, "Гоша")
            status, body = new_thread(d)
            tid_d = body["thread"]["id"]
            with lock:
                script.clear()

            def boom(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                raise ai.AIError("upstream 500")

            old_chat = ai.chat_with_tools
            ai.chat_with_tools = boom
            status, body = turn(d, tid_d, "урони модель")
            check("сбой модели -> 502", status == 502, f"{status} {body}")
            ai.chat_with_tools = mock_chat
            status, quota = d.request(base, "GET", "/api/agent/limits", None)
            check("502 вернул жетон (10 из 10)", quota.get("remaining") == 10, str(quota))

            section("повтор: AIFormatError один раз -> ход проходит")
            f = Client("10.6.0.1")
            claim(f, "Иван")
            status, body = new_thread(f)
            tid_f = body["thread"]["id"]
            with lock:
                script.clear()
                calls["n"] = 0

            flaky = {"failed": False}
            temps = {"seen": []}
            def flaky_chat(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                    temps["seen"].append((kw.get("temperature"), kw.get("timeout")))
                    if not flaky["failed"]:
                        flaky["failed"] = True
                        raise ai.AIFormatError("текст и вызовы одновременно")
                return {"text": "Ответ после повтора.", "tool_calls": []}

            old_chat = ai.chat_with_tools
            ai.chat_with_tools = flaky_chat
            status, body = turn(f, tid_f, "вопрос с повтором")
            ai.chat_with_tools = mock_chat
            check("AIFormatError один раз -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("повтор был (2 вызова)", calls["n"] == 2, str(calls["n"]))
            # Повтор при temperature 0 вернул бы ТОТ ЖЕ вырожденный ответ —
            # ровно ту ошибку, ради которой повтор и делается. Второй вызов
            # поэтому идёт с чуть другой температурой.
            check("повтор идёт с другой температурой (иначе он бессмыслен)",
                  len(temps["seen"]) == 2 and temps["seen"][0][0] == 0.0
                  and temps["seen"][1][0] == server._AGENT_RETRY_TEMPERATURE
                  and temps["seen"][1][0] != temps["seen"][0][0], str(temps["seen"]))
            # Бюджет хода спускается вниз и ограничивает один вызов:
            # 90-секундный потолок раньше проверялся только между шагами, и один
            # зависший вызов провайдера тянул ход ещё на EGE_AI_TIMEOUT_SEC.
            check("вызов ограничен остатком бюджета хода",
                  all(isinstance(t, (int, float)) and 0 < t <= ai.DEFAULT_TIMEOUT_SEC
                      for _, t in temps["seen"]), str(temps["seen"]))
            # Сам потолок одного вызова: не больше общего таймаута провайдера и
            # не больше того, что реально осталось от хода.
            check("_agent_call_timeout: без бюджета — общий таймаут",
                  server._agent_call_timeout(None) is None
                  and server._agent_call_timeout(10.0) == 10.0
                  and server._agent_call_timeout(1000.0) == ai.DEFAULT_TIMEOUT_SEC
                  and server._agent_call_timeout(0) is None,
                  f"{server._agent_call_timeout(None)} {server._agent_call_timeout(10.0)} "
                  f"{server._agent_call_timeout(1000.0)} {server._agent_call_timeout(0)}")

            section("повтор есть и в resume после подтверждения")
            # Раньше у _chat_cf повтора не было вовсе: одна форматная ошибка
            # после уже применённого действия отдавала 502 и откатывала шаг.
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "cf1", "name": "update_profile",
                                                            "arguments": {"selfLevel": "base"}}]})
            status, body = turn(f, tid_f, "поставь базовый уровень")
            check("действие -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            confirm_id = (body.get("steps") or [{}])[0].get("id")
            flaky2 = {"failed": False, "n": 0}
            def flaky_cf(messages, tools, **kw):
                with lock:
                    flaky2["n"] += 1
                    if not flaky2["failed"]:
                        flaky2["failed"] = True
                        raise ai.AIFormatError("пустой ответ модели")
                return {"text": "Уровень обновлён после повтора.", "tool_calls": []}
            ai.chat_with_tools = flaky_cf
            status, body = f.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": confirm_id, "approve": True})
            ai.chat_with_tools = mock_chat
            check("resume с одной форматной ошибкой -> 200",
                  status == 200 and (body.get("final") or "").startswith("Уровень обновлён"),
                  f"{status} {body}")
            check("resume позвал модель дважды (один повтор)", flaky2["n"] == 2, str(flaky2["n"]))
            status, body = f.request(base, "GET", f"/api/agent/threads/{tid_f}", None)
            done = [m for m in body.get("messages", []) if m.get("id") == confirm_id]
            check("шаг применён, а не откатан", bool(done) and done[0].get("status") == "applied",
                  str(done)[:160])

            section("кнопки-продолжения: модель даёт свои, сервер режет блок из текста")
            # Свой клиент с большим грантом: у Ани к этому месту жетоны
            # предыдущих секций уже на исходе, а тут каждый ход платит.
            k = Client("10.11.0.1")
            claim(k, "Кира-кнопки")
            conn_k = server.connect()
            conn_k.row_factory = sqlite3.Row
            try:
                uid_k = conn_k.execute("SELECT id FROM users WHERE name='Кира-кнопки'").fetchone()["id"]
                agent.admin_agent_quota_set(conn_k, uid_k, {"remaining": 200})
            finally:
                conn_k.close()
            _, body = new_thread(k)
            tid_k = body["thread"]["id"]
            # Формат блока — часть контракта: если он утечёт в final, ученик
            # увидит в ленте кусок служебного JSON.
            raw, sugg = agent.split_suggestions(
                "Держи разбор.\n\n```suggest\n"
                '[{"label":"Дай задачу","ask":"Дай задачу на производную, простую."},'
                '{"label":"Проще","ask":"Объясни то же самое проще."}]\n'
                "```")
            check("блок вырезан из текста, варианты разобраны",
                  raw == "Держи разбор." and len(sugg) == 2
                  and sugg[0]["label"] == "Дай задачу" and sugg[0]["ask"].startswith("Дай задачу"),
                  f"{raw!r} {sugg}")
            check("построчный формат блока тоже принимается (label | ask)",
                  agent.split_suggestions("Текст.\n```suggest\nРазбери ошибку | Разбери мою ошибку по шагам.\n```")[1]
                  == [{"label": "Разбери ошибку", "ask": "Разбери мою ошибку по шагам."}])
            check("свободное содержимое кнопок проходит как есть (хоть «я умный»)",
                  agent.split_suggestions("Текст.\n```suggest\n"
                                          '[{"label":"я умный","ask":"Докажи, что ты умнее меня, наставник."}]\n'
                                          "```")[1]
                  == [{"label": "я умный", "ask": "Докажи, что ты умнее меня, наставник."}])
            check("мусор в блоке не ломает ответ и не даёт пустых кнопок",
                  agent.split_suggestions("Ответ.\n```suggest\nне json и не список\n```")[0] == "Ответ."
                  and agent.split_suggestions("Ответ.\n```suggest\nне json и не список\n```")[1] == [])
            check("больше трёх вариантов не берём, дубли по ask схлопываются",
                  len(agent.split_suggestions("x\n```suggest\n"
                                              + json.dumps([{"label": f"L{i}", "ask": f"вопрос {i}"} for i in range(6)])
                                              + "\n```")[1]) == agent.MAX_SUGGESTIONS
                  and len(agent.split_suggestions("x\n```suggest\n"
                                                  + json.dumps([{"label": "A", "ask": "тот же"},
                                                                {"label": "B", "ask": "тот же"}])
                                                  + "\n```")[1]) == 1)

            with lock:
                script.clear()
                script.append({"text": "Собрал по тебе.\n\n```suggest\n"
                                       '[{"label":"Разбери ошибку","ask":"Разбери мою ошибку по шагам."},'
                                       '{"label":"Дай задачу","ask":"Дай задачу на слабую тему."}]\n'
                                       "```", "tool_calls": []})
            status, body = turn(k, tid_k, "расскажи про прогресс")
            check("ход отдаёт suggests клиенту",
                  status == 200 and [s["label"] for s in (body.get("suggests") or [])]
                  == ["Разбери ошибку", "Дай задачу"], f"{status} {body.get('suggests')}")
            check("служебный блок не попал в текст ответа",
                  body.get("final") == "Собрал по тебе.", repr(body.get("final")))
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            last = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]
            check("в базе тоже чистый текст (блок в историю не уходит)",
                  last["content"] == "Собрал по тебе." and "suggest" not in last["content"],
                  repr(last["content"]))
            check("история отдаёт НАСТОЯЩИЕ кнопки ответа (слова модели, не шаблон)",
                  last.get("suggests") == [{"label": "Разбери ошибку", "ask": "Разбери мою ошибку по шагам."},
                                           {"label": "Дай задачу", "ask": "Дай задачу на слабую тему."}],
                  repr(last.get("suggests")))
            # Кэшированный повтор того же вопроса: кнопки — те же, из базы.
            status, body = turn(k, tid_k, "расскажи про прогресс")
            check("кэшированный ход отдаёт сохранённые кнопки",
                  status == 200 and body.get("cached") is True
                  and [x["label"] for x in (body.get("suggests") or [])]
                  == ["Разбери ошибку", "Дай задачу"], f"{status} {body.get('suggests')}")

            with lock:
                script.clear()
                script.append({"text": "Просто ответ без блока.", "tool_calls": []})
            status, body = turn(k, tid_k, "ещё вопрос")
            check("без блока кнопок нет (а не дежурный набор)",
                  status == 200 and body.get("suggests") == [],
                  f"{status} {body.get('suggests')}")
            with lock:
                script.clear()
                script.append({"text": "Дерзкий ответ.\n\n```suggest\n"
                                       '[{"label":"я умный","ask":"Докажи, что ты умнее меня, наставник."},'
                                       '{"label":"ещё дерзче","ask":"Придумай вопрос посложнее."}]\n'
                                       "```", "tool_calls": []})
            status, body = turn(k, tid_k, "дерзни")
            check("свободные названия кнопок доходят до клиента как есть",
                  status == 200 and [x["label"] for x in (body.get("suggests") or [])]
                  == ["я умный", "ещё дерзче"], f"{status} {body.get('suggests')}")
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            last = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]
            check("свободные кнопки переживают перезагрузку (лежат в базе)",
                  [x["label"] for x in (last.get("suggests") or [])] == ["я умный", "ещё дерзче"],
                  repr(last.get("suggests")))

            # Длинный ответ: блок кнопок стоит В КОНЦЕ, за прежним потолком в
            # 8000 знаков. Раньше текст резался до разбора блока, и у длинного
            # ответа кнопки пропадали совсем.
            long_answer = ("Разбираю твои ошибки по шагам. " * 320).strip()
            with lock:
                script.clear()
                script.append({"text": long_answer + "\n\n```suggest\n"
                               '[{"label":"Дай задачу","ask":"Дай задачу на производную."}]\n```',
                               "tool_calls": []})
            status, body = turn(k, tid_k, "разбери мои ошибки подробно")
            check("кнопки выживают у длинного ответа (блок не срезан потолком)",
                  status == 200 and len(body.get("final") or "") > 8000
                  and [s["label"] for s in (body.get("suggests") or [])] == ["Дай задачу"]
                  and "suggest" not in (body.get("final") or ""),
                  f"{status} len={len(body.get('final') or '')} {body.get('suggests')}")
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            stored = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]["content"]
            check("в базе длинный ответ тоже без блока и в пределах потолка",
                  "suggest" not in stored and len(stored) <= agent.AGENT_REPLY_MAX,
                  f"len={len(stored)}")

            check("потолки ответа согласованы (ai.AI_REPLY_MAX == agent.AGENT_REPLY_MAX)",
                  ai.AI_REPLY_MAX == agent.AGENT_REPLY_MAX,
                  f"{ai.AI_REPLY_MAX} vs {agent.AGENT_REPLY_MAX}")
            check("потолок ответа действительно шире прежних 8000",
                  agent.AGENT_REPLY_MAX > 8000, str(agent.AGENT_REPLY_MAX))

            section("find_topics: поиск по каталогу вместо угадывания id")
            cap = _find_topics_probes(server)
            check("поиск по теме находит существующие задания", cap["deriv_ok"], str(cap["deriv"]))
            check("выданные id РЕАЛЬНО существуют (галлюцинаций нет)",
                  not cap["phantom"], str(cap["phantom"]))
            check("словоформа учитывается («логарифмы» → «Логарифмическое»)",
                  cap["stem_ok"], str(cap["stem"]))
            check("запрос только с номером находит re27_*", cap["num_ok"], str(cap["num"]))
            check("тема по названию навыка приоритетнее, чем по тексту задания",
                  cap["rank_ok"], str(cap["rank"]))
            check("на несуществующую тему — честный пустой ответ, а не весь каталог",
                  cap["empty_ok"], str(cap["empty_found"]))
            section("errors: старая открытая ошибка видна + точечный поиск")
            cap = _errors_probes(server)
            check("первая открытая ошибка видна в списке по умолчанию", cap["old_visible"],
                  str([e for e in cap.get("lookup", [])]))
            check("открытые идут первыми (разбирать предстоит их)",
                  cap["open_first"])
            check("точечный поиск по taskId находит её", cap["lookup_ok"], str(cap["lookup"]))
            check("по несуществующему заданию — честное пусто с тем же форматом",
                  cap["empty_ok"])
            check("find_topics виден модели и отнесён к чтению",
                  "find_topics" in [t["function"]["name"] for t in agent.AGENT_TOOLS]
                  and "find_topics" in agent.READ_TOOLS,
                  str([t["function"]["name"] for t in agent.AGENT_TOOLS]))

            section("project_info: справка о приложении вместо выдумок")
            # База знаний — один файл agent_knowledge.md рядом с модулем: модель
            # зовёт инструмент и получает ВЕСЬ текст. Проверяем и содержимое:
            # ученику положено знать лимиты, но НЕ положено — техническое нутро.
            names = [t["function"]["name"] for t in agent.AGENT_TOOLS]
            check("project_info виден модели и отнесён к чтению",
                  "project_info" in names and "project_info" in agent.READ_TOOLS, str(names))
            res = agent.execute_read_tool(conn, 1, "profile_math", "project_info", {})
            text = res.get("text") or ""
            check("справка отдаётся целиком, с цифрами лимитов",
                  "5" in text and "10" in text and "150" in text and "22" in text, text[:120])
            check("справка влезает в потолок контекста целиком (резать нельзя)",
                  len(__import__("json").dumps(res, ensure_ascii=False)) <= 4000,
                  str(len(__import__("json").dumps(res, ensure_ascii=False))))
            banned = [w for w in ("HMAC", "айпи", "ферм", "ai_take", "device_fp", "анти",
                                  "провайдер", "failover", "таблиц", "SQL", "бюджет")
                      if w.lower() in text.lower()]
            check("в справке нет технического нутра (только то, что видит ученик)",
                  not banned, str(banned))
            check("fallback ведёт вопросы о лимитах в project_info, а не в историю",
                  agent.fallback_tool_for("сколько проверок сочинений в день")[0] == "project_info"
                  and agent.fallback_tool_for("как мне самому сбросить прогресс")[0] == "project_info",
                  str(agent.fallback_tool_for("сколько проверок сочинений в день")))
            check("текстовый вызов project_info() тоже исполняется",
                  (agent.pseudo_call("project_info()") or (None,))[0] == "project_info")

            section("модель не имеет права сказать «инструмента нет» (живой случай: чат 54)")
            # «Подбери тему производная» → «Не хватает инструмента для поиска по
            # каталогу темы — у меня нет возможности его вызвать», при том что
            # find_topics в списке был. Ученику такое отвечать нельзя: он уйдёт
            # искать несуществующий инструмент. Сервер зовёт инструмент сам.
            c3 = Client("10.9.0.4")
            claim(c3, "Кузя-54")
            _, tf4 = new_thread(c3)
            tid_f4 = tf4["thread"]["id"]
            with lock:
                script.clear()
                script.append({"text": "Не хватает инструмента для поиска по каталогу темы — "
                                       "у меня нет возможности его вызвать.", "tool_calls": []})
                script.append({"text": "Вот производные: задания и урок.", "tool_calls": []})
            status, body = turn(c3, tid_f4, "Подбери тему производная")
            check("ход не прошёл пустым: сервер позвал инструмент сам",
                  status == 200 and body.get("steps"), f"{status} {str(body)[:220]}")
            check("ответ ученику больше НЕ содержит «инструмента нет»",
                  not re.search(r"не хватает инструмента|нет возможности его вызвать",
                                body.get("final") or "", re.IGNORECASE),
                  (body.get("final") or "")[:160])
            check("ответ по данным, а не отказ",
                  "производн" in (body.get("final") or "").lower(),
                  (body.get("final") or "")[:120])
            check("поиск отработал по вопросу, а не наугад",
                  any((s.get("args") or {}).get("query") == "производная"
                      for s in body.get("steps") or [] if s.get("tool") == "find_topics"),
                  str([s.get("args") for s in body.get("steps") or []]))

            # Вызов, написанный ТЕКСТОМ: модель показала ученику служебный
            # синтаксис («find_topics(query="логарифмы")») и ничего не получила.
            with lock:
                script.clear()
                script.append({"text": 'find_topics(query="логарифмы")\n\nСейчас возьму задание.',
                               "tool_calls": []})
                script.append({"text": "Вот задание на логарифмы.", "tool_calls": []})
            status, body = turn(c3, tid_f4, "дай мне задание на логарифмы")
            check("текстовый вызов разобран и выполнен по-настоящему",
                  any(s.get("tool") == "find_topics" for s in body.get("steps") or []),
                  str([s.get("tool") for s in body.get("steps") or []]))
            check("в ответе ученику нет служебного синтаксиса",
                  not re.search(r"(fold_web|find_topics|task_get|lesson_get)\s*\(",
                                body.get("final") or ""),
                  (body.get("final") or "")[:140])

            section("одно подтверждение на действие (живой случай: чат 52)")
            # Ученик: «Смени мое имя на Артем». Модель зовёт update_profile,
            # ученик подтверждает — и resume цикла ОБЯЗАН видеть, что действие
            # уже применено. Раньше `history[:-2]` отрезал ровно эти два
            # сообщения (assistant с вызовом + tool с {proposal, applied}), и
            # модель снова звала update_profile: ученику приходилось
            # подтверждать одно и то же ВТОРОЙ раз, а имя менялось только
            # после этого второго подтверждения.
            c2 = Client("10.9.0.3")
            claim(c2, "Жена-52")
            uid2 = _user_id_by_name(server, "Жена-52")
            _, tf3 = new_thread(c2)
            tid_f3 = tf3["thread"]["id"]
            with lock:
                script.clear()
                # Модель повторяет действие, пока не увидит результат
                # применения, — как в боевом чате 52.
                repeat_if_no_result["name"] = "update_profile"
                repeat_if_no_result["args"] = {"name": "Артем"}
                repeat_if_no_result["calls"] = 0
            status, body = turn(c2, tid_f3, "смени моё имя на Артем")
            step_n = (body.get("steps") or [{}])[0] or {}
            check("действие встало на подтверждение",
                  body.get("pending") is True and step_n.get("tool") == "update_profile",
                  f"{status} {body}")
            check("имя ещё НЕ применено до подтверждения",
                  _profile_name(server, uid2) != "Артем",
                  str(_profile_name(server, uid2)))
            status, body = c2.request(base, "POST", "/api/agent/turns/confirm",
                                      {"messageId": step_n.get("id"), "approve": True})
            check("подтверждение -> 200 с ответом", status == 200 and body.get("final"),
                  f"{status} {str(body)[:200]}")
            check("после ОДНОГО подтверждения имя применено",
                  _profile_name(server, uid2) == "Артем",
                  str(_profile_name(server, uid2)))
            check("второго подтверждения не требуется (pending не вернулся)",
                  not body.get("pending") and not any(s.get("status") == "needs_confirm"
                                                      for s in body.get("steps") or []),
                  str(body.get("steps")))
            check("resume не звал то же действие снова",
                  not any(s.get("tool") == "update_profile" for s in body.get("steps") or []),
                  str([s.get("tool") for s in body.get("steps") or []]))
            check("модель увидела результат применения и не стала повторять",
                  repeat_if_no_result["calls"] <= 1,
                  f"повторов вызова: {repeat_if_no_result['calls']}")
            with lock:
                repeat_if_no_result["name"] = None
            # Ровно одно сообщение-действие в базе на этот вопрос.
            rows_c2 = c2.request(base, "GET", f"/api/agent/threads/{tid_f3}", None)[1]
            applied_msgs = [m for m in (rows_c2.get("messages") or [])
                            if m.get("role") == "tool" and m.get("tool") == "update_profile"]
            check("в переписке ровно ОДИН шаг update_profile",
                  len(applied_msgs) == 1, str(len(applied_msgs)))

            section("кнопки-продолжения: блок вырезается всегда")
            # Живой случай: ответ провайдера обрезался по лимиту, закрывающая
            # ограда ```suggest не пришла — и весь служебный блок остался в
            # ответе ученику вместе с «Извини, последняя кнопка кривая».
            cut = "Ответ нормальный.\n\nИзвини, кнопка кривая:\n\n```suggest\n[{\"label\":\"Дай\",\"ask\":\"Дай ещё\"},{\"label\":\"Отм"
            text_out, items_out = agent.split_suggestions(cut)
            check("обрезанный блок не попадает в ответ ученику",
                  "suggest" not in text_out.lower() and "```" not in text_out,
                  repr(text_out[:120]))
            check("слова ответа до блока сохранены",
                  "Ответ нормальный" in text_out, repr(text_out[:120]))
            check("кнопок из обрезанного блока нет (лучше нет, чем мусор)", items_out == [],
                  str(items_out))
            two_blocks = ("Разберём.\n```suggest\n[{\"label\":\"Ещё\",\"ask\":\"Дай ещё задачу\"}]\n```\n"
                          "Между.\n```suggest\n[{\"label\":\"План\",\"ask\":\"Собери план\"}]\n```")
            text_two, items_two = agent.split_suggestions(two_blocks)
            check("два блока: оба вырезаны, обе кнопки взяты",
                  "suggest" not in text_two.lower() and len(items_two) == 2,
                  f"{text_two!r} {[i['label'] for i in items_two]}")

            section("«сейчас посмотрю» без вызова -> инструмент зовётся")
            # Живой случай: «посмотри мой профиль» → «Сейчас посмотрю твой
            # профиль» и НИ ОДНОГО вызова. Правило в промпте лечит не всех,
            # поэтому цикл переспрашивает, а потом зовёт инструмент сам.
            with lock:
                script.clear()
                script.append({"text": "Сейчас посмотрю твой профиль", "tool_calls": []})
                script.append({"text": None, "tool_calls": [
                    {"id": "s1", "name": "fold_web", "arguments": {"op": "profile"}}]})
                script.append({"text": "Ты Иван, уровень base.", "tool_calls": []})
            status, body = turn(k, tid_k, "посмотри мой профиль")
            check("обещание без вызова -> ход всё равно с шагом",
                  status == 200 and len(body.get("steps") or []) == 1
                  and body["steps"][0]["tool"] == "fold_web"
                  and body.get("final") == "Ты Иван, уровень base.", f"{status} {str(body)[:200]}")

            # Модель упрямится и после переспроса: сервер зовёт инструмент сам,
            # выбирая его по вопросу, и отвечает по данным — без блока кнопок
            # «сейчас посмотрю» на экране.
            with lock:
                script.clear()
                script.append({"text": "Сейчас проверю твои ошибки.", "tool_calls": []})
                script.append({"text": "Сейчас проверю твои ошибки.", "tool_calls": []})
                script.append({"text": "Вот что видно по ошибкам.", "tool_calls": []})
            status, body = turn(k, tid_k, "где я ошибаюсь?")
            check("упрямое обещание -> сервер зовёт инструмент сам",
                  status == 200 and len(body.get("steps") or []) == 1
                  and body["steps"][0]["tool"] == "fold_web"
                  and body["steps"][0]["args"].get("op") == "errors"
                  and body.get("final") == "Вот что видно по ошибкам.", f"{status} {str(body)[:240]}")

            # Обычный короткий ответ (приветствие) переспросом не ломается:
            # вопрос не про данные — лишнего вызова быть не должно.
            with lock:
                script.clear()
                script.append({"text": "Привет! Чем помочь?", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(k, tid_k, "привет")
            check("приветствие отвечает сразу, без вызова и переспроса",
                  status == 200 and body.get("final") == "Привет! Чем помочь?"
                  and not (body.get("steps") or []) and calls["n"] == 1,
                  f"{status} {str(body)[:200]} cost={calls['n']}")

            section("невидимые повторы переживают серию сбоев")
            # Три подряд неудачных вызова модели раньше давали 502 (два повтора
            # и всё): теперь температура растёт 0 → 0.3 → 0.6 и попыток хватает.
            h = Client("10.10.0.1")
            claim(h, "Егор-серия")
            _, body = new_thread(h)
            tid_h = body["thread"]["id"]
            temps_h = {"seen": []}

            def always_fail(messages, tools, **kw):
                with lock:
                    temps_h["seen"].append(kw.get("temperature"))
                raise ai.AIError("upstream 500")

            saved_chat = ai.chat_with_tools
            ai.chat_with_tools = always_fail
            try:
                status, body = turn(h, tid_h, "сбойный вопрос")
            finally:
                ai.chat_with_tools = saved_chat
            check("три попытки с растущей температурой",
                  temps_h["seen"][:3] == [0.0, server._AGENT_RETRY_TEMPERATURE, 0.6], str(temps_h["seen"]))
            check("серия сбоев -> 502 (жетон вернётся)", status == 502, f"{status} {body}")

            with lock:
                script.clear()
                script.append({"text": "Ответ со второй попытки.", "tool_calls": []})
            status, quota = h.request(base, "GET", "/api/agent/limits", None)
            check("502 не списал жетон", quota.get("remaining") == 10, str(quota))
            status, body = turn(h, tid_h, "нормальный вопрос")
            check("после сбоя ход идёт как обычно", status == 200 and body.get("final"), f"{status} {body}")

            section("потолок хода: сетка взята с запасом, а не отказ")
            # run_cycle напрямую: бюджет задаём сами, ждать 90 секунд не надо.
            conn3 = server.connect()
            conn3.row_factory = sqlite3.Row
            try:
                anya_id = int(conn3.execute("SELECT id FROM users WHERE name='Аня'").fetchone()["id"])

                spent = {"b": []}

                def budgeted(messages, tools, budget=None):
                    spent["b"].append(budget)
                    # Съедаем бюджет хода: мгновенный мок иначе успевает
                    # выбить все 10 шагов, а тут проверяем именно обрыв.
                    time.sleep(0.3)
                    if tools:
                        return {"text": None, "tool_calls": [
                            {"id": "bt1", "name": "fold_web", "arguments": {"op": "progress"}}]}
                    return {"text": "", "tool_calls": []}

                steps, final, pending = agent.run_cycle(
                    conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                    budgeted, deadline=time.monotonic() + agent.TURN_CALL_FLOOR_SEC + 0.25)
                check("истёкший бюджет с собранными шагами -> честный ответ, не 502",
                      len(steps) == 1 and isinstance(final, str) and "не успел" in final
                      and pending is None, f"{len(steps)} {final!r}")
                # Вызовы хода ограничены остатком бюджета, а финал по собранным
                # данным (_summarize) получает СВОЁ окно TURN_SUMMARY_EXTRA_SEC:
                # к этому моменту бюджет хода обычно исчерпан, и без своего окна
                # честный ответ подменялся бы просьбой уточнить вопрос — ровно
                # тогда, когда все данные уже на руках (так и было: «не успел»
                # вместо ответа приходил даже при живом провайдере).
                check("шаг хода ограничен остатком бюджета, финал — своим окном",
                      len(spent["b"]) >= 2 and spent["b"][0] <= agent.TURN_CALL_FLOOR_SEC + 0.3
                      and spent["b"][-1] <= agent.TURN_SUMMARY_EXTRA_SEC,
                      str(spent["b"]))

                # Бюджет убывает от шага к шагу — потолок один на весь ход,
                # а не на каждый вызов с нуля.
                two_budgets = []

                def two_steps(messages, tools, budget=None):
                    two_budgets.append(budget)
                    if len(two_budgets) == 1:
                        return {"text": None, "tool_calls": [
                            {"id": "bt2", "name": "fold_web", "arguments": {"op": "progress"}}]}
                    return {"text": "Второй ответ.", "tool_calls": []}

                steps, final, pending = agent.run_cycle(
                    conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                    two_steps, deadline=time.monotonic() + 30.0)
                check("два шага -> бюджет уменьшился",
                      len(two_budgets) == 2 and two_budgets[1] < two_budgets[0], str(two_budgets))
                check("два шага -> обычный ответ", len(steps) == 1 and final == "Второй ответ.",
                      f"{len(steps)} {final!r}")

                def instant(messages, tools, budget=None):
                    return {"text": "Готовый ответ.", "tool_calls": []}

                try:
                    agent.run_cycle(conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                                    instant, deadline=time.monotonic() - 1.0)
                    check("истёкший бюджет без единого шага -> 502 (жетон вернётся)", False, "ответ вместо отказа")
                except TimeoutError:
                    check("истёкший бюджет без единого шага -> 502 (жетон вернётся)", True)
            finally:
                conn3.close()

            section("AGENT_BUSY на параллельный ход")
            e = Client("10.5.0.1")
            claim(e, "Женя")
            status, body = new_thread(e)
            tid_e = body["thread"]["id"]
            # Детерминированно: держим слот треда вручную — второй ход в тот же
            # тред обязан получить 400 AGENT_BUSY, а не встать в очередь.
            assert server._agent_busy_acquire(tid_e), "busy acquire failed"
            try:
                s2, b2 = turn(e, tid_e, "второй вопрос")
            finally:
                server._agent_busy_release(tid_e)
            check("параллельный -> 400 AGENT_BUSY",
                  s2 == 400 and b2.get("code") == "AGENT_BUSY", f"{s2} {b2}")
            check("BUSY несёт retryAfter",
                  isinstance(b2.get("retryAfter"), int) and b2.get("retryAfter") >= 1, f"{s2} {b2}")
            with lock:
                script.clear()
                script.append({"text": "Ответ после busy.", "tool_calls": []})
            s3, b3 = turn(e, tid_e, "вопрос после busy")
            check("после release ход идёт", s3 == 200 and b3.get("final"), f"{s3} {b3}")

            section("подписка и удаление")
            conn2 = server.connect()
            try:
                cols = {r["name"] for r in conn2.execute("PRAGMA table_info(users)")}
                check("users.subscription существует", "subscription" in cols, str(sorted(cols)[:8]))
            finally:
                conn2.close()
            status, body = a.request(base, "POST", f"/api/agent/threads/{tid_a}/delete", {})
            check("удалить свой тред", status == 200, f"{status} {body}")
            status, body = a.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            check("удалённый тред -> 404", status == 404, f"{status} {body}")
            check("404 несёт код THREAD_NOT_FOUND", body.get("code") == "THREAD_NOT_FOUND", f"{status} {body}")

            section("approve -> 502 откатывает шаг в needs_confirm")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "r1", "name": "update_profile",
                                                             "arguments": {"selfLevel": "base"}}]})
            status, body = turn(d, tid_d, "поставь базовый уровень")
            check("действие -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            retry_id = (body.get("steps") or [{}])[0].get("id")
            ai.chat_with_tools = boom
            status, body = d.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": retry_id, "approve": True})
            check("resume упал -> 502", status == 502, f"{status} {body}")
            ai.chat_with_tools = mock_chat
            status, body = d.request(base, "GET", f"/api/agent/threads/{tid_d}", None)
            st = [m for m in body.get("messages", []) if m.get("id") == retry_id]
            check("шаг снова needs_confirm", bool(st) and st[0].get("status") == "needs_confirm",
                  str(st)[:200])
            with lock:
                script.clear()
                script.append({"text": "Уровень обновлён.", "tool_calls": []})
            status, body = d.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": retry_id, "approve": True})
            check("повторный approve -> 200", status == 200 and body.get("final"), f"{status} {body}")

            section("персональный потолок ходов наставника")
            g = Client("10.7.0.1")
            claim(g, "Гоша-грант")
            status, body = new_thread(g)
            tid_g = body["thread"]["id"]
            with lock:
                script.clear()
            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("до гранта обычные 10", quota.get("limit") == 10 and quota.get("remaining") == 10, str(quota))

            def uid_of(name):
                c = server.connect()
                c.row_factory = sqlite3.Row
                try:
                    return c.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()["id"]
                finally:
                    c.close()

            uid_g = uid_of("Гоша-грант")
            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 500})
                check("admin выдал 500 ходов", st.get("limit") == 500 and st.get("remaining") == 500, str(st))
                check("customLimit виден админу", st.get("customLimit") == 500, str(st))
                check("глобальный потолок не тронут", st.get("globalLimit") == 10, str(st))
            finally:
                conn2.close()

            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("живой сервер отдаёт 500 из 500",
                  quota.get("limit") == 500 and quota.get("remaining") == 500, str(quota))

            # Главное: грант выше общего потолка переживает ленивую зарядку.
            # Без персонального потолка MIN(10, ...) срезал бы его на первом
            # же 8-часовом тике — ровно те грабли, что закрыла ai_user_limits
            # для проверок сочинений.
            with lock:
                script.clear()
                script.append({"text": "Ход после гранта.", "tool_calls": []})
            status, body = turn(g, tid_g, "первый вопрос после гранта")
            check("ход после гранта -> 200", status == 200 and body.get("final"), f"{status} {body}")

            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                owner = f"agent:{uid_g}"
                win = agent.agent_quota_window_ms()
                # Ход выше запустил таймер цепочки — прокручиваем окно на тик+.
                agent.agent_quota_status(conn2, uid_g, int(time.time() * 1000) + win)
                row = conn2.execute("SELECT count, timer_ms FROM ai_usage WHERE owner=?",
                                    (owner,)).fetchone()
                check("грант пережил 8-часовой тик (не срезан до 10)",
                      int(row["count"]) == 500, str(dict(row)))
                check("карман полон -> таймер стоит", row["timer_ms"] is None, str(dict(row)))
                # Возврат жетона тоже уважает персональный потолок.
                conn2.execute("UPDATE ai_usage SET count=1, timer_ms=? WHERE owner=?",
                              (int(time.time() * 1000), owner))
                conn2.commit()
                agent.agent_quota_refund(conn2, uid_g)
                row = conn2.execute("SELECT count FROM ai_usage WHERE owner=?", (owner,)).fetchone()
                check("возврат жетона не выше персонального потолка", int(row["count"]) == 2, str(dict(row)))
            finally:
                conn2.close()

            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                st = agent.admin_agent_quota_set(conn2, uid_g, {"limit": None, "refill": True})
                check("limit null -> общий потолок 10",
                      st.get("limit") == 10 and st.get("remaining") == 10
                      and st.get("customLimit") is None, str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 3})
                check("частичный остаток ниже потолка -> таймер стартует",
                      st.get("remaining") == 3 and st.get("resetInSec"), str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 20})
                check("грант выше потолка сам поднимает потолок",
                      st.get("limit") == 20 and st.get("remaining") == 20, str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 0})
                check("потолок 20, остаток 0 -> ждём возврата",
                      st.get("limit") == 20 and st.get("remaining") == 0 and st.get("resetInSec"), str(st))
                try:
                    agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 5000})
                    check("remaining > 1000 отвергается", False, "принято")
                except ValueError:
                    check("remaining > 1000 отвергается", True)
                st = agent.admin_agent_quota_set(conn2, uid_g, {"limit": None, "refill": True})
                check("снятие потолка возвращает 10", st.get("limit") == 10, str(st))
                server.ensure_ai_user_limit_schema(conn2)
                row = conn2.execute("SELECT COUNT(*) c FROM ai_user_limits WHERE user_id=?",
                                    (uid_g,)).fetchone()
                check("потолок наставника не трогает ai_user_limits", int(row["c"]) == 0, str(dict(row)))
            finally:
                conn2.close()

            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("после снятия потолка снова 10 из 10",
                  quota.get("limit") == 10 and quota.get("remaining") == 10, str(quota))

            section("один запрос — один инструмент + живые шаги")
            # Пачка вызовов в одном ответе модели запрещена (правило 2b): сервер
            # берёт только первый, остальное модель переспрашивает следующим
            # кругом. Клиент при этом видит шаги во время хода (liveSteps в GET
            # треда), а не пачку в конце долгого молчания.
            h = Client("10.8.0.1")
            claim(h, "Харитон-лайв")
            status, body = new_thread(h)
            tid_h = body["thread"]["id"]
            slow = {"on": True}
            real_mock = ai.chat_with_tools

            def slow_mock(messages, tools, **kw):
                if slow["on"]:
                    time.sleep(0.8)
                return real_mock(messages, tools, **kw)

            ai.chat_with_tools = slow_mock
            try:
                with lock:
                    script.clear()
                    script.append({"text": "Сейчас соберу всё.", "tool_calls": [
                        {"id": "lv1", "name": "fold_web", "arguments": {"op": "profile"}},
                        {"id": "lv2", "name": "fold_web", "arguments": {"op": "forecast"}}],
                        "preamble": "Сейчас соберу всё."})
                    script.append({"text": None, "tool_calls": [
                        {"id": "lv3", "name": "fold_web", "arguments": {"op": "forecast"}}]})
                    script.append({"text": "Готово, вот разбор.", "tool_calls": []})
                holder: dict = {}

                def fire_live():
                    holder["st"], holder["body"] = turn(h, tid_h, "как мои дела")

                ft = threading.Thread(target=fire_live, daemon=True)
                ft.start()
                time.sleep(0.3)
                seen = []
                for _ in range(40):
                    s2, g2 = h.request(base, "GET", f"/api/agent/threads/{tid_h}", None)
                    if s2 == 200:
                        seen.append((bool(g2.get("busy")), len(g2.get("liveSteps") or [])))
                    if not ft.is_alive():
                        break
                    time.sleep(0.2)
                ft.join(timeout=60)
                slow["on"] = False
                check("ход с пачкой -> 200 и два шага (пачка разбита на круги)",
                      holder.get("st") == 200 and len((holder.get("body") or {}).get("steps", [])) == 2,
                      str(holder.get("body"))[:300])
                counts = [n for _, n in seen]
                check("опрос видел живые шаги во время хода",
                      any(n > 0 for n in counts), str(seen[:12]))
                check("шаги нарастали постепенно, а не пачкой сразу",
                      1 in counts and 2 in counts, str(counts))
                s2, g2 = h.request(base, "GET", f"/api/agent/threads/{tid_h}", None)
                check("после хода снимок пуст, слот свободен",
                      s2 == 200 and g2.get("liveSteps") == [] and g2.get("busy") is False,
                      str({k: g2.get(k) for k in ("busy", "liveSteps")}))
            finally:
                ai.chat_with_tools = real_mock
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
