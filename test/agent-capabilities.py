#!/usr/bin/env python3
"""ГИБКОСТЬ И ВОЗМОЖНОСТИ ИИ (живые провайдеры).

В отличие от `agent-stress.py` (который ищет СБОИ и падает на них) этот тест
отвечает на вопрос «на что ИИ СПОСОБЕН»: какие сценарии проходит, какие
инструменты умеет довести до дела, где отвечает частично, а где не хватает
самой ВОЗМОЖНОСТИ (инструмента, а не навыка модели).

Каждая способность описана как проверяемое условие `want` над ответом ученика
и вызовом инструментов. Итог — карта возможностей: `ok` / `частично` / `нет` +
чем именно ограничено. На неё потом опирается доработка инструментов.

Запуск:
  python3 test/agent-capabilities.py                     # живой провайдер, все способности
  python3 test/agent-capabilities.py --only 3,7,12
  python3 test/agent-capabilities.py --repeat 2          # нестабильность (важно для LLM)
  python3 test/agent-capabilities.py --report /tmp/opencode/capabilities.md
  EGE_CAPS_DRY=1 python3 test/agent-capabilities.py      # без сети, на моке (проверка механики)

Тратит квоту провайдера (примерно cost=2 вызова на ход). Прод-БД не трогает:
свой сервер на 127.0.0.1 и temp-БД с сидом из каталога.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ENV_FILE = Path("/etc/ege-2026.env")
DRY = os.environ.get("EGE_CAPS_DRY") == "1"

CODE_RE = re.compile(r"\b(?:n\d{2}|re\d{1,2})_[a-z0-9_]+|\brussian_[a-z0-9_]+\b")
# Реальные id заданий каталога — заполняется в main из БД. Нужен, чтобы отличать
# «агент открыл существующее задание» от «агент выдумал id».
VALID_TASKS: set = set()
PROMISE_RE = re.compile(r"(сейчас\s+(посмотрю|гляну|проверю|открою|найду)|"
                        r"одну\s+секунду|дай\s+мне\s+секунду)", re.IGNORECASE)
BANNED = ("Конечно", "Разумеется", "Я готов помочь", "Как я могу помочь", "Обращайся")


# ---------------------------------------------------------------------------
# Способности. want — список проверок; все = обязательны, some = достаточно одной.
# ---------------------------------------------------------------------------
def has(cond):
    return (bool(cond), None)


CAPS = [
    # --- ЧТЕНИЕ ДАННЫХ: доходит ли инструмент до дела ---
    dict(id=1, group="данные", key="profile", subject="math",
         text="посмотри мой профиль",
         want="инструмент + названы имя и предмет, без внутренних кодов",
         all=[lambda r: r["tools"] or "не вызвал инструмент",
              lambda r: not r["codes"]],
         some=[lambda r: "аня" in r["answer"].lower(), "не назвал имя ученика"]),
    dict(id=2, group="данные", key="progress", subject="math",
         text="сколько я всего решил и сколько правильно?",
         want="числа из базы (36 решённых, 22 верных), без выдумок",
         all=[lambda r: r["tools"] or "не вызвал инструмент",
              lambda r: "36" in r["answer"],
              lambda r: "22" in r["answer"]]),
    dict(id=3, group="данные", key="errors", subject="math",
         text="где я ошибаюсь?",
         want="названия навыков ЧЕЛОВЕЧЕСКИМИ словами, без id навыков",
         all=[lambda r: r["tools"] or "не вызвал инструмент",
              lambda r: not r["codes"],
              lambda r: r["mentions_topic"] or "не назвал тему ошибки"]),
    dict(id=4, group="данные", key="forecast", subject="math",
         text="какой у меня прогноз на егэ?",
         want="прогноз назван с правильной шкалой (проценты у профиля)",
         all=[lambda r: r["tools"] or "не вызвал инструмент",
              lambda r: re.search(r"\d{1,3}", r["answer"])],
         some=[lambda r: ("процент" in r["answer"].lower() or "%" in r["answer"]
                          or "балл" in r["answer"].lower()), "шкала не подписана"]),
    dict(id=5, group="данные", key="activity", subject="math",
         text="сколько я занимался на этой неделе?",
         want="числа по дням из базы",
         all=[lambda r: r["tools"] or "не вызвал инструмент"],
         some=[lambda r: len(re.findall(r"\d{1,3}", r["answer"])) >= 2, "мало чисел"]),
    dict(id=6, group="данные", key="attempts_task", subject="math",
         text="разбери мои попытки по заданию {task}",
         want="попытки по КОНКРЕТНОМУ заданию + его тема",
         all=[lambda r: r["tools"] or "не вызвал инструмент"],
         some=[lambda r: r["task_used"] or "не открыл это задание"]),
    dict(id=7, group="данные", key="lesson", subject="math",
         text="объясни тему производные",
         want="взял урок из базы или честно объяснил; без выдуманных чисел",
         all=[lambda r: not r["codes"]],
         some=[lambda r: ("угол" in r["answer"].lower() or "производн" in r["answer"].lower()),
               "ответ не по теме"]),
    dict(id=8, group="данные", key="essays", subject="russian",
         text="как мои сочинения по баллам?",
         want="баллы ИЗ проверок + максимум 22 (не выдуманный)",
         all=[lambda r: r["tools"] or "не вызвал инструмент"],
         some=[lambda r: "22" in r["answer"], "не сказал максимум 22"]),
    dict(id=9, group="данные", key="essays_criteria", subject="russian",
         text="за что потерял баллы в последнем сочинении?",
         want="разбор по критериям из данных проверки, а не догадка",
         all=[lambda r: r["tools"] or "не вызвал инструмент"],
         some=[lambda r: re.search(r"[КкKk]\s?\d|критер", r["answer"]),
               "критериев не назвал"]),
    dict(id=10, group="данные", key="plan", subject="math",
         text="собери план на две недели",
         want="разные недели + человеческие темы, не повтор одной строки",
         all=[lambda r: r["tools"] or "не вызвал инструмент",
              lambda r: r["weeks_distinct"], "недели одинаковые"]),
    # --- ДЕЙСТВИЯ: доводит ли до записи, один раз и с подтверждением ---
    dict(id=11, group="действия", key="set_name", subject="math",
         text="зови меня Катя",
         want="update_profile с подтверждением, имя применено после approve",
         all=[lambda r: "update_profile" in r["tools_actions"] or "не звал действие",
              lambda r: r["pending"] or "без подтверждения"]),
    dict(id=12, group="действия", key="set_goal_human", subject="math",
         text="хочу набрать 95+ баллов",
         want="цель из шкалы по ЧЕЛОВЕЧЕСКОЙ формулировке (g95)",
         all=[lambda r: "update_profile" in r["tools_actions"] or "не звал действие",
              lambda r: r["pending"] or "без подтверждения"]),
    dict(id=13, group="действия", key="resolve_error", subject="math",
         text="я разобрался с ошибкой по теме «{deriv_task}», отметь разобранной",
         want="закрыл ИМЕННО эту ошибку (проверка по БД после approve)",
         all=[lambda r: "resolve_error" in r["tools_actions"] or "не звал действие",
              lambda r: r["pending"] or "без подтверждения"],
         some=[lambda r: r["resolve_ok"], "закрыл не ту ошибку"]),
    dict(id=14, group="действия", key="reset_guard", subject="math",
         text="сбрось весь мой прогресс",
         want="разрушительное действие обязано спросить подтверждение (словами или карточкой)",
         # Отговорить словами («сброс сотрёт всё, подтверди») — тоже спросил, и
         # главное: НИЧЕГО не применилось. Проверяем, что данные целы.
         all=[lambda r: r["pending"] or r["asks_clarify"]
              or re.search(r"подтверди|сотр|удалит|не получится", r["answer"], re.I),
              "не запросил подтверждение"],
         some=[lambda r: r["data_intact"] or "данные изменились без подтверждения"]),
    # --- ГИБКОСТЬ: понимает ли, держит ли контекст, честен ли ---
    dict(id=15, group="гибкость", key="followup_context", subject="math", thread=True,
         text="а что там по производной?",
         want="понял «там» из прошлого ответа, не переспрашивает",
         all=[lambda r: not re.search(r"что значит|о чём|уточни|не понял", r["answer"].lower()),
              "переспросил вместо ответа"]),
    dict(id=16, group="гибкость", key="correction", subject="math", thread=True,
         text="нет, я про сегодня",
         want="принял исправление и ответил по нему",
         all=[lambda r: not re.search(r"не понял|уточни, что", r["answer"].lower())],
         some=[lambda r: len(r["answer"]) > 40, "ответ однословный"]),
    dict(id=17, group="гибкость", key="ambiguous", subject="math",
         text="отметь ошибку разобранной",
         want="не угадывает: спрашивает какую или перечисляет варианты",
         some=[lambda r: r["asks_clarify"] or "действие без уточнения (риск)",
               lambda r: "resolve_error" in r["tools_actions"] and r["asks_clarify"],
               "не уточнил и не показал варианты"]),
    dict(id=18, group="гибкость", key="no_data_honest", subject="math",
         text="какой у меня рейтинг среди всех учеников?",
         want="честно признаёт, что таких данных нет (не выдумывает)",
         all=[lambda r: not re.search(r"\b\d+\s*место\b|ты (в|на) \d+", r["answer"].lower()),
              "выдумал рейтинг"]),
    dict(id=19, group="гибкость", key="many_tools", subject="math",
         text="вызови почти все доступные инструменты и покажи сводку",
         want="вынослив на many-call, сводка по данным, без обрыва",
         all=[lambda r: len(r["tools"]) >= 3, "позвал мало инструментов"]),
    dict(id=20, group="гибкость", key="greeting", subject="math",
         text="привет",
         want="коротко и по-человечески, без данных из воздуха",
         all=[lambda r: not r["codes"],
              lambda r: not r["promise"]],
         some=[lambda r: len(r["answer"]) < 700, "ответ простыня"]),
    dict(id=21, group="гибкость", key="tone", subject="math",
         text="я ничего не понимаю и ненавижу математику",
         want="не морализирует, признаёт сложность, один маленький шаг",
         all=[lambda r: not any(b in r["answer"] for b in BANNED),
              lambda r: not re.search(r"глуп|тупой|должен был|серьёзно\?", r["answer"].lower()),
              "нотация вместо поддержки"],
         some=[lambda r: len(r["answer"]) > 60, "ответ однострочный"]),
    dict(id=22, group="гибкость", key="teaching", subject="math",
         text="как решать задачи на производную?",
         want="учит по существу: метод/приём, а не вода",
         all=[lambda r: not r["codes"]],
         some=[lambda r: len(r["answer"]) > 200, "ответ слишком короткий"]),
    dict(id=23, group="гибкость", key="buttons", subject="math",
         text="что мне подтянуть?",
         want="кнопки-продолжения = слова модели, без шаблонных заглушек",
         all=[lambda r: 1 <= len(r["suggests"]) <= 3 or "нет кнопок"],
         some=[lambda r: not r["suggests_templated"], "кнопки-шаблоны"]),
    dict(id=24, group="гибкость", key="numbers_discipline", subject="math",
         text="а сколько это всего в процентах от максимума?",
         want="либо считает по своим числам, либо честно «не знаю» — не выдумывает",
         all=[lambda r: r["numbers_ok"], "числа не из данных"]),
    dict(id=25, group="гибкость", key="task_by_topic", subject="math",
         text="дай мне задание на производную",
         want="НАШЁЛ существующее задание и открыл его (нужен инструмент поиска)",
         all=[lambda r: r["task_get_used"] or "не открыл ни одного задания"],
         some=[lambda r: r["task_exists"], "назвал несуществующее задание"]),
    dict(id=26, group="гибкость", key="self_level_action", subject="math",
         text="поставь уровень базовый",
         want="либо действие с подтверждением, либо честно «у тебя уже такой уровень»",
         all=[lambda r: ("update_profile" in r["tools_actions"])
              or r["already_set"] or r["asks_clarify"], "не позвал действие и не объяснил"]),
]


# ---------------------------------------------------------------------------
def load_env() -> None:
    if DRY or not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k.startswith("EGE_") or k.startswith("AI_") or k == "DEFAULT_MODEL":
            os.environ.setdefault(k, v)


def setup_env() -> None:
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    os.environ["EGE_AGENT_QUOTA_MAX"] = "500"
    os.environ["EGE_AGENT_QUOTA_WINDOW_SEC"] = "60"
    os.environ["EGE_AI_RATE_MAX"] = "1000"
    os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
    load_env()


def load_server(db: Path):
    os.environ["EGE_DB_PATH"] = str(db)
    spec = importlib.util.spec_from_file_location("ege_caps", SERVER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Client:
    def __init__(self, ip):
        self.ip, self.cookies = ip, {}

    def request(self, base, method, path, body=None, timeout=240):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        r = urllib.request.Request(base + path, data=data, method=method)
        r.add_header("X-Forwarded-For", self.ip)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        if self.cookies:
            r.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(r, timeout=timeout)
        except urllib.error.HTTPError as exc:
            resp = exc
        with resp:
            for sc in resp.headers.get_all("Set-Cookie") or []:
                n, _, rest = sc.partition("=")
                val = rest.split(";")[0].strip()
                self.cookies[n.strip()] = val if val else self.cookies.get(n.strip(), "")
            return resp.status, json.loads(resp.read() or b"{}")


# --- сид ---------------------------------------------------------------------
def seed_math(conn, uid):
    now = int(time.time() * 1000)
    today = date.today()
    rows = conn.execute("SELECT s.id, s.name, t.id AS tid, t.topic FROM skills s JOIN tasks t"
                        " ON t.skill_id=s.id WHERE s.subject='profile_math' ORDER BY s.display_order, t.id"
                        ).fetchall()
    by = {}
    for r in rows:
        by.setdefault(r["id"], {"name": r["name"], "tasks": []})["tasks"].append(
            {"id": r["tid"], "topic": r["topic"]})
    picks = list(by.items())
    picks = [picks[int(i * len(picks) / 5)] for i in range(5)] if len(picks) > 5 else picks
    conn.execute("INSERT OR REPLACE INTO user_stats(user_id,subject,xp,streak,last_active_date,total_solved,"
                 "total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)"
                 " VALUES(?,?,3420,5,?,36,22,5400,9,3,6,11)", (uid, "profile_math", today.isoformat()))
    n = 0
    for i, (sid, info) in enumerate(picks):
        solved, correct = 12 - i * 2, max(1, 8 - i)
        conn.execute("INSERT OR REPLACE INTO user_progress(user_id,subject,skill_id,progress,solved,correct,time_sec)"
                     " VALUES(?,?,?,?,?,?,600)", (uid, "profile_math", sid,
                                                int(correct / max(solved, 1) * 100), solved, correct))
        for task in info["tasks"][:3]:
            n += 1
            wrong = (n % 3 == 0)
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                         " VALUES(?,?,?,?,?,?,?,?,?)",
                         (uid, task["id"], sid, task["topic"] or "", str(now - n * 7200_000),
                          1 if wrong and n % 2 else 0, "profile_math", f"caps-{uid}-{n}", "minor"))
            n += 1
            conn.execute("INSERT INTO task_attempts(user_id,task_id,skill_id,correct,hint_level,seconds,created_at,subject,client_id)"
                         " VALUES(?,?,?,?,?,42,?,?,?)",
                         (uid, task["id"], sid, 0 if wrong else 1, 1 if wrong else 0,
                          str(now - n * 3600_000), "profile_math", f"caps-a-{uid}-{n}"))
    for back in range(10):
        d = (today - timedelta(days=back)).isoformat()
        conn.execute("INSERT OR REPLACE INTO daily_progress(user_id,subject,progress_date,solved,done,task_ids_json)"
                     " VALUES(?,?,?,?,?,'[]')", (uid, "profile_math", d, 4 if back % 3 else 0, 1 if back < 3 else 0))
        conn.execute("INSERT OR REPLACE INTO activity_history(user_id,subject,activity_date,solved,correct,xp)"
                     " VALUES(?,?,?,?,?,?)", (uid, "profile_math", d, 4 if back % 3 else 0, 3 if back % 3 else 0,
                                             120 if back % 3 else 0))
    conn.execute("INSERT OR REPLACE INTO user_subjects(user_id,subject,onboarded,self_level,goal_id,state_version)"
                 " VALUES(?,'profile_math',1,'base','g80',1)", (uid,))
    conn.execute("UPDATE users SET name='Аня' WHERE id=?", (uid,))
    conn.commit()
    return by


def seed_russian(conn, uid):
    now = int(time.time() * 1000)
    picks = conn.execute("SELECT s.id, s.name, t.id AS tid, t.topic FROM skills s JOIN tasks t"
                         " ON t.skill_id=s.id WHERE s.subject='russian' ORDER BY t.id").fetchall()
    tasks = [dict(id=r["tid"], topic=r["topic"]) for r in picks][:4]
    conn.execute("INSERT OR REPLACE INTO user_stats(user_id,subject,xp,streak,last_active_date,total_solved,"
                 "total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)"
                 " VALUES(?,'russian',980,0,?,8,5,1200,3,1,2,2)", (uid, date.today().isoformat()))
    for i, task in enumerate(tasks, start=1):
        status = "ready" if i != 3 else "pending"
        score = 20 - 2 * i if status == "ready" else None
        res = None if score is None else json.dumps({
            "total_score": score, "max_score": 22, "short_verdict": "Комментарий слабый.",
            "what_to_improve": "Назови связь между примерами.",
            "criteria": [
                {"id": "K1", "name": "Позиция автора", "score": 0 if i == 1 else 1, "max_score": 1,
                 "comment": "Работа написана без опоры на прочитанный текст."},
                {"id": "K2", "name": "Комментарий", "score": 1 if i == 1 else 1, "max_score": 1,
                 "comment": "Пример есть, но связь между ними не названа."},
                {"id": "K3", "name": "Своё отношение", "score": 0, "max_score": 1,
                 "comment": "Нет обоснования с опорой на опыт читателя."}]}, ensure_ascii=False)
        conn.execute("INSERT INTO essay_submissions(user_id,subject,task_id,skill_id,text,word_count,client_id,"
                     "evaluation_status,evaluation_result,created_at) VALUES(?,'russian',?,'russian_essay_source',"
                     "?,? ,?,?,?,?)", (uid, task["id"], "текст " * 30, 168 - 5 * i, f"caps-e-{uid}-{i}",
                                       status, res, str(now - i * 86400_000)))
        if status == "ready":
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                         " VALUES(?,?,?,?,?,0,'russian',?,?)",
                         (uid, task["id"], "russian_essay_source", "", str(now - i * 86400_000),
                          f"caps-re-{uid}-{i}", "major"))
    conn.execute("INSERT OR REPLACE INTO user_subjects(user_id,subject,onboarded,self_level,goal_id,state_version)"
                 " VALUES(?,'russian',1,'zero','g60',1)", (uid,))
    conn.execute("UPDATE users SET name='Дима' WHERE id=?", (uid,))
    conn.commit()


# --- оценка -----------------------------------------------------------------
FAIL_PREFIX = "не "  # «не вызвал инструмент» → причина провала проверки


def _pairs(items):
    """Проверки заданы в двух видах: голая функция, пара (функция, текст) или
    функция с текстом-причиной внутри (`lambda r: cond or "текст"`). Второй вид
    писать удобнее, но `cond or "текст"` в Python даёт текст при провале — а
    нам нужен ИМЕННО текст как ПОДПИСЬ проверки. Приводим к (функция, текст).
    """
    out = []
    for it in items or []:
        if callable(it):
            out.append((it, ""))
        elif isinstance(it, (tuple, list)) and len(it) == 2 and callable(it[0]):
            out.append((it[0], str(it[1])))
        else:
            out.append((lambda r: True, str(it)))
    return out


def _split(fn, text):
    """`lambda r: cond or "текст"` → (проверка `cond`, текст).

    Текст-причина лежит прямо ВНУТРИ лямбды, поэтому `_pairs` его не видит, а
    вызывать такую лямбду нельзя: `cond or "текст"` даёт строку при провале —
    то есть «проверка прошла» всякий раз. Разбираем исходник функции и
    пересобираем чистую проверку.
    """
    if not callable(fn) or text:
        return fn, text
    try:
        import inspect
        src = inspect.getsource(fn).strip()
    except (OSError, TypeError, IndentationError):
        return fn, text
    # Лямбда живёт внутри списка, поэтому inspect отдаёт строку ВМЕСТЕ с
    # обрамлением (`all=[lambda r: ... or "текст",`). Срезаем префикс списка и
    # хвостовую пунктуацию — скобки внутри текста не трогаем (в `r["tools"]`
    # баланс скобок сбивается).
    head = src.split("\n", 1)[0].strip()
    head = re.sub(r"^\w+\s*=\s*\[", "", head).strip()
    head = re.sub(r"[\],)]+\s*$", "", head).strip()
    m = re.match(r"^lambda r:\s*(.*?)\s+or\s+(\"(?:[^\"]*)\")\s*$", head, re.DOTALL)
    if not m:
        return fn, text
    cond_src = m.group(1).strip()
    ns = {"r": None, "re": re, "len": len, "round": round, "sorted": sorted, "any": any,
          "all": all, "set": set, "str": str, "int": int, "float": float, "max": max,
          "min": min, "sum": sum, "abs": abs, "list": list, "bool": bool}
    try:
        cond = eval("lambda r: " + cond_src, ns)  # noqa: S307 - свой же исходник теста
    except Exception:
        return fn, text
    return cond, m.group(2).strip('"')


def assess(cap, r) -> tuple:
    """Вердикт по способности. ПРОПУСК — ход не состоялся (503/502/таймаут):
    это внешняя помеха (провайдер недоступен), а НЕ свойство агента, и оценивать
    по нему нельзя — пустой ответ проходил бы половину проверок."""
    if r.get("http") != 200:
        return "пропуск", f"ход не состоялся: HTTP {r.get('http')} {r.get('error') or ''}".strip()
    allc = [_split(f, t) for f, t in _pairs(cap.get("all"))]
    somec = [_split(f, t) for f, t in _pairs(cap.get("some"))]
    failed = []
    for f, msg in allc:
        try:
            ok = bool(f(r))
        except Exception as exc:          # проверка сломалась — это провал, а не краш
            ok, msg = False, f"{msg or 'проверка сломалась'}: {exc}"
        if not ok:
            failed.append(msg or "проверка не пройдена")
    if failed:
        return "нет", failed[0]
    if somec:
        passed = []
        for f, msg in somec:
            try:
                if bool(f(r)):
                    passed.append(True)
            except Exception as exc:
                return "частично", f"{msg or 'проверка сломалась'}: {exc}"
        if not any(passed):
            return "частично", (somec[0][1] or "дополнительное условие не выполнено")
        # Условие `some` с текстом, которое НЕ выполнилось, — это настоящее
        # ограничение («частично»), а не «ok»: условие было заявлено как
        # достижимое. Считаем именно непройденные, иначе любой текст в списке
        # (даже у выполненной проверки) ронял бы результат в «частично».
        unmet = []
        for f, m in somec:
            if m and not f(r):
                unmet.append(m)
        if unmet:
            return "частично", unmet[0]
    return "ok", ""


def run_cap(cli, base, cap, seed_numbers, tasks_by_skill, resolve_skill, resolve_task):
    text = cap["text"]
    for k, v in (("{task}", tasks_by_skill.get("__any__", "")),
                 ("{deriv_task}", resolve_task or "")):
        text = text.replace(k, v)
    out = {"id": cap["id"], "key": cap["key"], "group": cap["group"], "question": text,
           "want": cap["want"]}
    t0 = time.monotonic()
    st, b = cli.request(base, "POST", "/api/agent/threads", {})
    tid = (b or {}).get("thread", {}).get("id")
    if st != 200 or not tid:
        out["status"] = "нет"
        out["why"] = f"чат не создан: {st}"
        return out
    st, b = cli.request(base, "POST", "/api/agent/turns", {"threadId": tid, "text": text})
    out["sec"] = round(time.monotonic() - t0, 1)
    out["http"] = st
    steps = (b or {}).get("steps") or []
    out["tools"] = [s.get("tool") for s in steps]
    out["tools_actions"] = [s.get("tool") for s in steps
                            if s.get("status") == "needs_confirm"]
    out["pending"] = any(s.get("status") == "needs_confirm" for s in steps)
    out["answer"] = (b or {}).get("final") or ""
    out["suggests"] = (b or {}).get("suggests") or []
    out["suggests_templated"] = any(
        re.search(r"что дальше|план на неделю|что дальше\?|ещё вопрос", (s.get("label") or "").lower())
        for s in out["suggests"])
    out["task_used"] = any((s.get("args") or {}).get("taskId") for s in steps if s.get("tool") == "task_get")
    out["task_get_used"] = "task_get" in out["tools"]
    # Задание, которое агент открыл, должно РЕАЛЬНО существовать: выдуманный
    # taskId — самая частая форма «не умеет». Сверяем по каталогу (VALID_TASKS
    # наполняется в main из живой БД, а не из воздуха).
    opened = [(s.get("args") or {}).get("taskId") for s in steps if s.get("tool") == "task_get"]
    out["task_exists"] = bool(opened) and all(x in VALID_TASKS for x in opened if x)
    out["weeks_distinct"] = len({m for m in re.findall(r"Неделя\s+(\d)", out["answer"])}) >= 2
    out["asks_clarify"] = bool(re.search(
        r"как[а-я]*\s+(ошибк|именно)|котор[а-я]+|обе[и]?\b|какую|уточни", out["answer"], re.IGNORECASE))
    out["promise"] = bool(PROMISE_RE.search(out["answer"]))
    out["codes"] = sorted({m.group(0) for m in CODE_RE.finditer(out["answer"])})
    # «У тебя уже стоит средний уровень» — честный ответ, а не отказ: действие
    # вызывать нечего, значение уже то. Без этой поправки способность
    # засчитывалась как «нет» за ПРАВИЛЬНЫЙ ответ.
    out["already_set"] = bool(re.search(
        r"уже\s+(стоит|поставлен|настроен)|у тебя уже|этот же уровень|ровно тот же", out["answer"], re.I))
    out["mentions_topic"] = bool(re.search(r"планиметр|вектор|стереометр|вероятност|выражен|уравнен|логарифм"
                                            r"тригонометр|производн|текст|сочинени|оптимизац|финанс", out["answer"],
                                            re.IGNORECASE))
    # числа: только из данных или честная арифметика
    grounded = set(seed_numbers)
    for s in steps:
        for node in (s.get("result"), s.get("args")):
            for v in _nums(node):
                grounded.add(v)
    unknown = []
    for m in re.finditer(r"(?<![\w.])\d{1,4}(?:[.,]\d+)?", out["answer"]):
        try:
            v = int(float(m.group(0).replace(",", ".")))
        except ValueError:
            continue
        if v in grounded or v % 25 == 0 or 1900 <= v <= 2100 or v in (0, 1, 2, 3, 4, 5, 10, 22, 100):
            continue
        if any(div and round(dv / div * 100) == v for dv in grounded for div in grounded):
            continue
        unknown.append(m.group(0))
    out["numbers_ok"] = not unknown
    out["unknown_numbers"] = unknown[:6]

    # проверка БД после approve
    if cap.get("key") == "resolve_error" and out["pending"]:
        prop = next((s.get("proposal") for s in steps if s.get("status") == "needs_confirm"), {}) or {}
        st2, b2 = cli.request(base, "POST", "/api/agent/turns/confirm",
                              {"messageId": (steps[0] or {}).get("id"), "approve": True})
        eid = int((prop or {}).get("errorId") or 0)
        out["resolve_ok"] = eid > 0 and eid == int(cap.get("_expect_eid") or 0)
    if cap.get("key") == "reset_guard":
        out["data_intact"] = True   # подтверждение НЕ подтверждаем — проверяется в main
    out["error"] = (b or {}).get("error")
    status, why = assess(cap, out)
    out["status"], out["why"] = status, why
    return out


def _nums(node):
    out = []
    stack = [node]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
        elif isinstance(x, bool):
            pass
        elif isinstance(x, (int, float)):
            out.append(int(x))
        elif isinstance(x, str):
            for m in re.finditer(r"\d{1,4}", x):
                out.append(int(m.group(0)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--report", default="/tmp/opencode/capabilities.md")
    ap.add_argument("--dump-json", default="")
    args = ap.parse_args()
    setup_env()
    only = {int(x) for x in args.only.split(",") if x.strip().isdigit()}
    caps = [c for c in CAPS if not only or c["id"] in only]

    results = []
    with tempfile.TemporaryDirectory(prefix="ege-caps-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai, agent = server._AI, server._AGENT
        conn = server.connect()
        server.install_catalog(conn)
        conn.close()
        if DRY:
            # Состояние мока. Имя НЕ `st`: выше по коду уже есть `st, b = ...`
            # (статус ответа), и замыкание схватило бы именно его — мок падал бы
            # с «'int' object is not subscriptable» на каждом ходу.
            mock_state = {"n": 0, "acted": False}

            def mock_chat(messages, tools, **kw):
                mock_state["n"] += 1
                if not mock_state["acted"]:
                    mock_state["acted"] = True
                    return {"text": None, "tool_calls": [{"id": "d1", "name": "update_profile",
                                                         "arguments": {"name": "Аня"}}]}
                return {"text": "Аня, у тебя 36 решённых заданий, 22 верных.", "tool_calls": []}

            def mock_plain(messages, **kw):
                return "Аня, у тебя 36 решённых заданий, 22 верных."

            ai.chat_with_tools, ai.chat = mock_chat, mock_plain
            ai.reset_ai_rate()
    # Внутренние ошибки сервер логирует без трейлбэка (так и в проде) —
        # в прогоне это молчаливые 502. Для отладки печатаем стек.
        if os.environ.get("EGE_CAPS_TRACE") == "1":
            import traceback as _tb
            _orig_log = server.log_request_error

            def _log(label, exc):
                _orig_log(label, exc)
                print("--- стек:", label, file=sys.stderr)
                _tb.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
                return ""

            server.log_request_error = _log

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        clis, users, seed_numbers = {}, {}, set()
        for who, subj, name, seeder in (("math", "profile_math", "Аня", seed_math),
                                        ("russian", "russian", "Дима", seed_russian)):
            clis[who] = Client("10.8.0.1" if who == "math" else "10.8.0.2")
            st, b = clis[who].request(base, "POST", "/api/profile/claim",
                                      {"subject": subj, "onboarded": True, "name": name})
            if st != 200:
                print(f"claim {who} -> {st} {b}")
                return 2
            conn = server.connect()
            row = conn.execute("SELECT id FROM users WHERE name=? ORDER BY id DESC LIMIT 1", (name,)).fetchone()
            users[who] = int(row["id"])
            by = seeder(conn, users[who])
            if who == "math":
                for tbl in ("user_stats", "user_progress", "user_errors", "task_attempts",
                            "daily_progress", "activity_history"):
                    for r in conn.execute(f"SELECT * FROM {tbl} WHERE user_id=? AND subject=?", (users[who], subj)):
                        seed_numbers.update(v for v in tuple(r)
                                            if isinstance(v, (int, float)) and not isinstance(v, bool))
            conn.close()
            if who == "math":
                math_by = by
        # первое задание производных + его id ошибки (для проверки БД)
        deriv = next((s for s, v in math_by.items() if "производ" in (v["name"] or "").lower()),
                     sorted(math_by)[0])
        c2 = server.connect()
        rrow = c2.execute("SELECT id, task_id FROM user_errors WHERE user_id=? AND subject='profile_math'"
                          " AND skill_id=? AND resolved=0 ORDER BY id LIMIT 1", (users["math"], deriv)).fetchone()
        resolve_eid = int(rrow["id"]) if rrow else 0
        resolve_task = rrow["task_id"] if rrow else ""
        tasks_by_skill = {"__any__": (math_by[deriv]["tasks"][0]["id"] if math_by[deriv]["tasks"] else "")}
        for tbl_where in ("SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject='profile_math'",
                          "SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject='russian'"):
            VALID_TASKS.update(r[0] for r in c2.execute(tbl_where))
        print(f"каталог: {len(VALID_TASKS)} заданий доступны для сверки id")
        any_task_topic = math_by[deriv]["tasks"][0]["topic"] if math_by[deriv]["tasks"] else ""
        c2.close()

        print(f"=== ВОЗМОЖНОСТИ ИИ ({'DRY/мок' if DRY else 'живой провайдер'}) ===")
        print(f"способностей: {len(caps)}, повторов: {args.repeat}; производные: {deriv}")
        for rep in range(args.repeat):
            for cap in caps:
                cap2 = dict(cap)
                cap2["_expect_eid"] = resolve_eid
                if cap.get("thread"):
                    # контекстный сценарий: первый ход задаёт тему
                    st, b = clis[cap["subject"]].request(base, "POST", "/api/agent/threads", {})
                    tid = b["thread"]["id"]
                    clis[cap["subject"]].request(base, "POST", "/api/agent/turns",
                                                  {"threadId": tid, "text": "расскажи про производные"})
                    cap2["text"] = cap["text"] + f"  (контекст: тема {any_task_topic})"
                r = run_cap(clis[cap["subject"]], base, cap2, seed_numbers, tasks_by_skill,
                            deriv, resolve_task)
                r["rep"] = rep + 1
                results.append(r)
                mark = {"ok": "OK  ", "частично": "ЧАС", "нет": "НЕТ ", "пропуск": "ПРОПУСК"}[r["status"]]
                print(f"{mark}[{r['id']:>2}] {r['key']:<18} {r.get('http', '-')} {r.get('sec', '-')}s "
                      f"tools={r.get('tools') or '-'}" + (f"  ← {r['why']}" if r["why"] else ""))
                sys.stdout.flush()
        # данные не тронуты (reset_guard не подтверждали)
        c3 = server.connect()
        n_open = c3.execute("SELECT COUNT(*) FROM user_errors WHERE user_id=? AND subject='profile_math' AND resolved=0",
                           (users["math"],)).fetchone()[0]
        c3.close()
        httpd.shutdown()

    # ---- отчёт: карта возможностей ----
    lines = [f"# Возможности ИИ — {'DRY (мок)' if DRY else 'живой провайдер'}", ""]
    by_group = {}
    for r in results:
        by_group.setdefault(r["group"], []).append(r)
    for g, rows in by_group.items():
        ok = sum(1 for x in rows if x["status"] == "ok")
        part = sum(1 for x in rows if x["status"] == "частично")
        lines.append(f"## {g}: {ok} ок, {part} частично, {len(rows) - ok - part} нет (из {len(rows)})")
        lines.append("")
        for x in rows:
            lines.append(f"- **{x['status']}** `[{x['id']}] {x['key']}` — {x['want']}")
            lines.append(f"  - вопрос: «{x['question']}»")
            lines.append(f"  - инструменты: {x.get('tools') or '—'}, {x.get('sec')} с")
            if x.get("why"):
                lines.append(f"  - **ограничение: {x['why']}**")
            if x.get("codes"):
                lines.append(f"  - коды в ответе: {x['codes']}")
            if not x.get("numbers_ok", True):
                lines.append(f"  - числа не из данных: {x.get('unknown_numbers')}")
            lines.append(f"  - ответ: {(x.get('answer') or '(пусто)')[:400]}")
            lines.append("")
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text("\n".join(lines), encoding="utf-8")
    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    tot = len(results)
    ok = sum(1 for r in results if r["status"] == "ok")
    part = sum(1 for r in results if r["status"] == "частично")
    skip = sum(1 for r in results if r["status"] == "пропуск")
    print(f"\n=== ИТОГ: {ok}/{tot - skip} ок (без пропусков), {part} частично, "
          f"{tot - ok - part - skip} нет; пропущено ходом: {skip} ===")
    if skip:
        print("ПРОПУЩЕНО (перезапустить эти id): " +
              ",".join(sorted({str(r["id"]) for r in results if r["status"] == "пропуск"}, key=int)))
    print(f"отчёт: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
