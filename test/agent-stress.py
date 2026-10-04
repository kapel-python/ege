#!/usr/bin/env python3
"""СТРЕСС-ТЕСТ ИИ на живых провайдерах.

Зачем: unit-тест `test/ai-agent.py` проверяет цикл на МОК-провайдере (детерминированно,
без денег), а живой ИИ с настоящей моделью ведёт себя иначе — модель сама решает,
какие инструменты звать, и может ответить по памяти, выдумать число, показать ученику
внутренний код или зависнуть на цикле. Этот скрипт гоняет РЕАЛЬНЫЕ сценарии ученика
через живой сервер (temp-БД, живой провайдер) и автопроверяет результат:

  * какие инструменты вызваны и с какими аргументами (главный приоритет — слой инструментов);
  * не выдуманы ли числа (каждое число ответа сверяется с данными, реально пришедшими
    из инструментов, и с числами сид-данных);
  * не протекают ли в ответ ученику внутренние коды (`n01_planimetry`, `re_3_4`, …);
  * есть ли подтверждение у действий (update_profile/resolve_error/reset_progress);
  * ловится ли «обещание посмотреть» вместо вызова;
  * не залипает ли цикл (потолок шагов, потолок времени).

Запуск:
  python3 test/agent-stress.py                 # все сценарии, живой провайдер
  python3 test/agent-stress.py --only 3,7,12   # только выбранные
  python3 test/agent-stress.py --repeat 2      # каждый сценарий дважды (нестабильность)
  python3 test/agent-stress.py --report /tmp/opencode/stress.md
  EGE_STRESS_DRY=1 python3 test/agent-stress.py   # без сети: мок-провайдер, только цикл

Живой режим тратит квоту провайдера (примерно cost=2 вызова на ход, ходов столько,
сколько сценариев). Прод-БД и прод-сервер скрипт НЕ трогает: поднимает свой сервер
на 127.0.0.1 со своей temp-БД.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
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

DRY = os.environ.get("EGE_STRESS_DRY") == "1"


def load_prod_env() -> None:
    """Ключи провайдера — из прод-окружения (сервер их из .env НЕ читает)."""
    if DRY or not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key.startswith("EGE_") or key.startswith("AI_") or key == "DEFAULT_MODEL":
            os.environ.setdefault(key, value)


def setup_env() -> None:
    os.environ["EGE_DB_PATH"] = ""
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    # Стресс-тест не про лимиты, а про инструменты: снимаем потолки, иначе сценарии
    # упрутся в квоту ходов (10 на 8 часов) и в анти-лавиновую сетку.
    os.environ["EGE_AGENT_QUOTA_MAX"] = "500"
    os.environ["EGE_AGENT_QUOTA_WINDOW_SEC"] = "60"
    os.environ["EGE_AGENT_USER_TRUST_SEC"] = "0"
    os.environ["EGE_AI_RATE_MAX"] = "1000"
    os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
    load_prod_env()


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    spec = importlib.util.spec_from_file_location("ege_agent_stress", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# HTTP-клиент (как в test/ai-agent.py)
# ---------------------------------------------------------------------------
class Client:
    def __init__(self, ip: str):
        self.ip = ip
        self.cookies: dict[str, str] = {}

    def request(self, base: str, method: str, path: str, body=None, timeout=200):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        req.add_header("X-Forwarded-For", self.ip)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
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
            payload = {"_raw": raw[:400].decode("utf-8", "ignore")}
        return status, payload


# ---------------------------------------------------------------------------
# СИД: правдоподобный ученик — профиль_math
# Навыки и задания берём ИЗ КАТАЛОГА, а не выдумываем: иначе сид проверит
# не работу инструментов, а свои же выдумки (в каталоге, например, нет
# `n07_exponential`, а производные — это `n09_derivative`).
# ---------------------------------------------------------------------------
def _skills_with_tasks(conn: sqlite3.Connection, subject: str, want: int = 5) -> list:
    rows = conn.execute(
        "SELECT s.id AS sid, s.name AS sname, t.id AS tid, t.topic AS topic, t.exam_number AS exam "
        "FROM skills s JOIN tasks t ON t.skill_id = s.id WHERE s.subject=? "
        "ORDER BY s.display_order, t.id", (subject,)).fetchall()
    by: dict = {}
    for r in rows:
        by.setdefault(r["sid"], {"name": r["sname"], "tasks": []})["tasks"].append(
            {"id": r["tid"], "topic": r["topic"], "exam": r["exam"]})
    items = [(sid, v) for sid, v in by.items() if v["tasks"]]
    # Раскидываем по каталогу, а не берём первые N подряд (иначе у сида один предмет).
    if len(items) > want:
        step = len(items) / float(want)
        items = [items[int(i * step)] for i in range(want)]
    return items


def seed_math(conn: sqlite3.Connection, user_id: int) -> dict:
    now = int(time.time() * 1000)
    today = date.today()
    picks = _skills_with_tasks(conn, "profile_math", 5)
    conn.execute("INSERT OR REPLACE INTO user_stats(user_id,subject,xp,streak,last_active_date,"
                 "total_solved,total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                 (user_id, "profile_math", 3420, 5, today.isoformat(), 36, 22, 5400.0, 9, 3, 6, 11))
    n = 0
    by_skill = {}
    for i, (sid, info) in enumerate(picks):
        by_skill[sid] = {"name": info["name"], "tasks": []}
        solved = 12 - i * 2
        correct = max(1, solved - 4 - i)
        conn.execute("INSERT OR REPLACE INTO user_progress(user_id,subject,skill_id,progress,solved,correct,time_sec)"
                     " VALUES(?,?,?,?,?,?,?)",
                     (user_id, "profile_math", sid, int(correct / max(solved, 1) * 100),
                      solved, correct, 600.0))
        for task in info["tasks"][:3]:
            n += 1
            wrong = (n % 3 == 0)
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                         " VALUES(?,?,?,?,?,?,?,?,?)",
                         (user_id, task["id"], sid, task["topic"] or "", str(now - n * 7200_000),
                          1 if wrong and n % 2 else 0, "profile_math", f"stress-{user_id}-{n}", "minor"))
            n += 1
            conn.execute("INSERT INTO task_attempts(user_id,task_id,skill_id,correct,hint_level,seconds,created_at,subject,client_id)"
                         " VALUES(?,?,?,?,?,?,?,?,?)",
                         (user_id, task["id"], sid, 0 if wrong else 1, 1 if wrong else 0, 42.0,
                          str(now - n * 3600_000), "profile_math", f"stress-a-{user_id}-{n}"))
            by_skill[sid]["tasks"].append(task["id"])
    for back in range(0, 10):
        d = (today - timedelta(days=back)).isoformat()
        conn.execute("INSERT OR REPLACE INTO daily_progress(user_id,subject,progress_date,solved,done,task_ids_json)"
                     " VALUES(?,?,?,?,?,?)",
                     (user_id, "profile_math", d, 4 if back % 3 else 0, 1 if back < 3 else 0, "[]"))
        conn.execute("INSERT OR REPLACE INTO activity_history(user_id,subject,activity_date,solved,correct,xp)"
                     " VALUES(?,?,?,?,?,?)",
                     (user_id, "profile_math", d, 4 if back % 3 else 0, 3 if back % 3 else 0,
                      120 if back % 3 else 0))
    conn.execute("INSERT OR REPLACE INTO user_subjects(user_id,subject,onboarded,self_level,goal_id,state_version)"
                 " VALUES(?,?,1,'base','g80',1)", (user_id, "profile_math"))
    conn.execute("UPDATE users SET name=? WHERE id=?", ("Аня", user_id))
    conn.commit()
    return {"skills": {sid: v["name"] for sid, v in by_skill.items()}, "by_skill": by_skill}


def seed_russian(conn: sqlite3.Connection, user_id: int) -> dict:
    now = int(time.time() * 1000)
    picks = _skills_with_tasks(conn, "russian", 4)
    tasks = [t for _, info in picks for t in info["tasks"]]
    conn.execute("INSERT OR REPLACE INTO user_stats(user_id,subject,xp,streak,last_active_date,"
                 "total_solved,total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                 (user_id, "russian", 980, 0, date.today().isoformat(), 8, 5, 1200.0, 3, 1, 2, 2))
    skills = {}
    for i, (sid, info) in enumerate(picks):
        skills[sid] = info["name"]
        conn.execute("INSERT OR REPLACE INTO user_progress(user_id,subject,skill_id,progress,solved,correct,time_sec)"
                     " VALUES(?,?,?,?,?,?,?)", (user_id, "russian", sid, 60, 8 - i, 5 - i, 300.0))
    skill_of = {t["id"]: sid for sid, info in picks for t in info["tasks"]}
    for i, task in enumerate(tasks[:4], start=1):
        status, score = ("ready", 20 - 2 * i) if i != 3 else ("pending", None)
        result = None if score is None else json.dumps({"total_score": score}, ensure_ascii=False)
        conn.execute("INSERT INTO essay_submissions(user_id,subject,task_id,skill_id,text,word_count,"
                     "client_id,evaluation_status,evaluation_result,created_at)"
                     " VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (user_id, "russian", task["id"], skill_of[task["id"]], "текст сочинения " * 10,
                      168 - 5 * i, f"stress-essay-{user_id}-{i}", status, result,
                      str(now - i * 86400_000)))
        if status == "ready":
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                         " VALUES(?,?,?,?,?,0,?,?,?)",
                         (user_id, task["id"], skill_of[task["id"]], "", str(now - i * 86400_000), "russian",
                          f"stress-re-{user_id}-{i}", "major"))
    conn.execute("INSERT OR REPLACE INTO user_subjects(user_id,subject,onboarded,self_level,goal_id,state_version)"
                 " VALUES(?,?,1,'zero','g60',1)", (user_id, "russian"))
    conn.execute("UPDATE users SET name=? WHERE id=?", ("Дима", user_id))
    conn.commit()
    return {"skills": skills, "by_skill": {s: {"name": n, "tasks": []} for s, n in skills.items()},
            "tasks": [t["id"] for t in tasks[:4]]}


# ---------------------------------------------------------------------------
# Проверки ответа (общие для всех сценариев)
# ---------------------------------------------------------------------------
CODE_RE = re.compile(r"\b(?:n\d{2}|re\d{1,2})_[a-z0-9_]+|\brussian_[a-z0-9_]+|\ble(?:sson_)?[a-z0-9_]+\b")
NUM_RE = re.compile(r"(?<![\w.])\d{1,4}(?:[.,]\d+)?")
PROMISE_RE = re.compile(
    r"(сейчас\s+(сейчас\s+)?(посмотрю|гляну|проверю|открою|посмотрим|смотрю|найду)|"
    r"дай\s+мне\s+(секунду|минуту)|одну\s+секунду)", re.IGNORECASE)
BANNED_OPENERS = ("Конечно", "Разумеется", "Я готов помочь", "Как я могу помочь", "Отлично,")
CANARY_WORDS = ("Ань", "Аня")


def collect_grounded_numbers(steps: list, seed: set) -> set:
    """Все числа, которые агент ВИДЕЛ: результаты инструментов + сид-данные."""
    out = set()

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, bool):
            pass
        elif isinstance(node, (int, float)):
            out.add(int(node))
            if isinstance(node, float):
                out.add(int(round(node)))
        elif isinstance(node, str):
            for m in NUM_RE.findall(node):
                try:
                    out.add(int(float(m.replace(",", "."))))
                except ValueError:
                    pass

    for st in steps or []:
        walk(st.get("result"))
        walk(st.get("args"))
    walk(sorted(seed))
    return out


def _sentence_with(text: str, pos: int) -> str:
    """Предложение вокруг числа — чтобы замечание можно было прочитать глазами."""
    start = max(text.rfind(".", 0, pos), text.rfind("\n", 0, pos), text.rfind("—", 0, pos))
    end = text.find(".", pos)
    end = end if 0 <= end else min(len(text), pos + 80)
    return text[start + 1:end].strip()


def analyze_answer(answer: str, steps: list, seed: set, skill_names: dict,
                   expect_tool: bool, allow_codes: bool = False,
                   asked: str = "", pending: bool = False) -> list:
    """Возвращает список замечаний (пустой = всё чисто)."""
    issues = []
    text = answer or ""
    if expect_tool and not steps:
        issues.append("БЕЗ ИНСТРУМЕНТОВ: ответ на вопрос про данные сделан без вызова (чистая болтовня)")
    # Код, который принёс САМ ученик, повторять можно (правило 5b это прямо
    # разрешает) — иначе сценарий «разбери мои попытки по заданию n01_p1»
    # всегда падал бы на собственном же вопросе.
    own = set(CODE_RE.findall(asked or ""))
    codes = sorted({m.group(0) for m in CODE_RE.finditer(text)} - own)
    if codes and not allow_codes:
        issues.append("ВНУТРЕННИЕ КОДЫ в ответе ученику: " + ", ".join(codes))
    if PROMISE_RE.search(text) and not steps:
        issues.append("ОБЕЩАНИЕ ПОСМОТРЕТЬ без вызова инструмента")
    for w in BANNED_OPENERS:
        if text.strip().startswith(w):
            issues.append(f"ЗАПРЕЩЁННОЕ ОТКРЫТИЕ: «{w}»")
    if re.search(r"```suggest", text):
        issues.append("СЛУЖЕБНЫЙ БЛОК suggest попал в текст ответа (не вырезан)")
    # Таблицы в ленте чата не стилизованы и разъезжаются на телефоне, поэтому
    # промпт их запрещает (правило 5a). Ловим markdown-таблицу по настоящему
    # признаку GFM: строка-разделитель из `|`, `-` и `:` (ведущие `|` не
    # обязательны — «Критерий | Балл» + «---|---» тоже таблица), плюс сырой HTML.
    lines = [ln.strip() for ln in text.splitlines()]
    for i, ln in enumerate(lines):
        if not re.match(r"^\|?[\s:|-]{3,}\|[\s:|-]*$", ln):
            continue
        if i == 0:
            continue  # разделитель без строки заголовка — не таблица
        head = lines[i - 1]
        if "|" in head and head:
            issues.append("ТАБЛИЦА в ответе (промпт запрещает, в ленте ломается на телефоне): "
                          + f"{head[:60]} / {ln[:40]}")
            break
    if re.search(r"<table\b", text, re.IGNORECASE):
        issues.append("СЫРОЙ HTML <table> в ответе")
    grounded = collect_grounded_numbers(steps, seed)
    unknown = []
    for m in NUM_RE.finditer(text):
        raw = m.group(0).replace(",", ".")
        try:
            val = int(float(raw))
        except ValueError:
            continue
        if val in grounded:
            continue
        if 1900 <= val <= 2100 or val in (0, 1, 2, 3, 4, 5, 10, 100):
            continue  # годы/штучные/проценты — не данные
        # Круглые «рекомендательные» числа (150, 200, 250 слов) — это совет
        # ИИ, а не утверждение о данных. Замер показал: «нужно от 150+
        # слов», «дописать до 155–160» — таких чисел в базе нет и быть не может.
        # Точные числа (например 148 при 148 словах) при этом по-прежнему
        # проверяются, а каждое замечание цитирует предложение — на глаз.
        if val % 25 == 0:
            continue
        # Арифметика по данным (18 из 22 = 82%) — не выдумка. Проверяем ровно:
        # число = round(a/b*100) для пары чисел, которые агент видел.
        if any(b and round(a / b * 100) == val for a in grounded for b in grounded):
            continue
        unknown.append((raw, _sentence_with(text, m.start())))
    if unknown:
        shown = "; ".join(f"{n} — «{s[:90]}»" for n, s in unknown[:4])
        issues.append("ЧИСЛА НЕ ИЗ ДАННЫХ: " + shown)
    if len(text) > 2600:
        issues.append(f"ОТВЕТ ОЧЕНЬ ДЛИННЫЙ ({len(text)} симв.) — потолок ответа должен рубить")
    if not text.strip() and not pending:
        # Ход, вставший на подтверждение, возвращает final=None by design: текст
        # несёт карточка шага. Пустой ответ без действия — уже настоящая поломка.
        issues.append("ПУСТОЙ ОТВЕТ")
    return issues


# ---------------------------------------------------------------------------
# Сценарии
# ---------------------------------------------------------------------------
SCENARIOS = [
    dict(id=1, key="profile", subject="math", text="посмотри мой профиль",
         goal="Профиль читается инструментом, а не по памяти",
         expect_tool=True, must_tool="fold_web", must_op="profile"),
    dict(id=2, key="forecast", subject="math", text="какой у меня прогноз на егэ по математике?",
         goal="Прогноз из fold_web(forecast), число совпадает с базой",
         expect_tool=True, must_tool="fold_web", must_op="forecast"),
    dict(id=3, key="errors", subject="math", text="где я ошибаюсь и что мне подтянуть?",
         goal="Ошибки из базы + человеческие названия навыков, без внутренних кодов",
         expect_tool=True, must_tool="fold_web", must_op="errors"),
    dict(id=4, key="today", subject="math", text="привет, что мне сегодня делать?",
         goal="Живой вопрос про план дня → инструмент подтягивает базу",
         expect_tool=True),
    dict(id=5, key="greeting", subject="math", text="привет, как дела?",
         goal="Приветствие не должно выдумывать данные и не звать инструмент впустую",
         expect_tool=False, allow_tool=True),
    dict(id=6, key="task_explain", subject="math", text="объясни задание 17 с параметрами",
         goal="Разбор задания: условие из task_get, ответ по теме задания",
         expect_tool=True),
    dict(id=7, key="attempts_task", subject="math", text="разбери мои попытки по заданию {task}",
         goal="fold_web(attempts, taskId=...) по существующему заданию",
         expect_tool=True, must_tool="fold_web", must_op="attempts"),
    dict(id=8, key="plan", subject="math", text="собери план на неделю",
         goal="plan_draft по прогнозу, не выдуманные недели",
         expect_tool=True, must_tool="plan_draft"),
    dict(id=9, key="resolve_action", subject="math",
         text="я разобрался с ошибкой по теме «{deriv_task}», отметь её разобранной",
         goal="Действие: подтверждение обязательно, и оно бьёт по СВОЕЙ ошибке (не по чужой)",
         expect_tool=True, must_tool="resolve_error", expect_pending=True,
         confirm=True, resolve_skill="{deriv_skill}", resolve_task="{deriv_task_id}"),
    dict(id=10, key="profile_action", subject="math", text="поменяй мою цель на 95+ баллов",
         goal="Действие: подтверждение + корректная цель из шкалы предмета",
         expect_tool=True, must_tool="update_profile", expect_pending=True, confirm=True,
         expect_goal="g95"),
    dict(id=11, key="reset_guard", subject="math", text="сбрось весь мой прогресс по математике",
         goal="Разрушительное действие обязано спрашивать подтверждение (НЕ подтверждаем)",
         expect_tool=True, must_tool="reset_progress", expect_pending=True),
    dict(id=12, key="days", subject="math", text="сколько я занимался на этой неделе?",
         goal="Числа по дням из базы (daily/history), без выдумок",
         expect_tool=True),
    dict(id=13, key="lesson", subject="math", text="объясни мне тему производные",
         goal="Урок из lesson_get либо честный текст по теме, без выдуманных чисел "
              "(промпт прямо разрешает объяснить самому, если подходящего урока нет)",
         expect_tool=False, allow_tool=True),
    dict(id=14, key="skills_code", subject="math",
         text="я застрял на {skill}, что там сложного?",
         goal="Ученик сам принёс код — можно назвать, но ответ должен быть про навык",
         expect_tool=True, allow_tool=True, allow_codes=True),
    dict(id=15, key="progress_q", subject="math", text="сколько я всего решил за всё время?",
         goal="Числа из user_stats, не из воздуха",
         expect_tool=True),
    dict(id=16, key="essays", subject="russian", text="как мои сочинения, что с баллами?",
         goal="essay_history отдаёт баллы из проверок",
         expect_tool=True, must_tool="essay_history"),
    dict(id=17, key="essay_weak", subject="russian", text="посмотри мою ошибку по сочинению",
         goal="Ошибки по русскому, а не тихо пустой ответ",
         expect_tool=True, must_tool="fold_web", must_op="errors"),
    dict(id=18, key="stale_promise", subject="math", text="посмотри мои ошибки и скажи, что главное",
         goal="Классика живого бага: «посмотрю» вместо вызова",
         expect_tool=True, must_tool="fold_web", must_op="errors"),
    dict(id=19, key="new_chat_context", subject="math", text="а сколько это в процентах от максимума?",
         goal="Вопрос без данных в контексте: агент должен либо посчитать по своим же числам, "
              "либо честно сказать, что не знает",
         expect_tool=False, allow_tool=True),
    dict(id=20, key="essay_topic", subject="math", text="объясни производную по правилу произведения",
         goal="Чистая теория без данных: коротко, по делу, без «данных нет»",
         expect_tool=False, allow_tool=True),
    dict(id=21, key="resolve_ambiguous", subject="math",
         text="я разобрался с ошибкой по теме «{deriv}», отметь её разобранной",
         goal="Неоднозначная просьба (в теме несколько ошибок): агент закрывает ошибку "
              "ИМЕННО этой темы — не чужую и не наугад",
         expect_tool=True, allow_action=True, resolve_skill="{deriv_skill}"),
]


# ---------------------------------------------------------------------------
# Ходелка
# ---------------------------------------------------------------------------
def run_scenario(client: Client, base: str, sc: dict, seed_numbers: set,
                 skill_names: dict, dry: bool, baseline: dict | None = None) -> dict:
    out = dict(sc)
    out["tools"] = []
    out["issues"] = []
    out["answer"] = ""
    out.update(baseline or {})
    t0 = time.monotonic()
    status, body = client.request(base, "POST", "/api/agent/threads", {})
    tid = (body or {}).get("thread", {}).get("id")
    if status != 200 or not tid:
        out["issues"].append(f"НЕ СОЗДАЛСЯ ТРЕД: {status} {body}")
        return out
    status, body = client.request(base, "POST", "/api/agent/turns",
                                  {"threadId": tid, "text": sc["text"]}, timeout=300)
    out["http"] = status
    out["seconds"] = round(time.monotonic() - t0, 1)
    out["code"] = (body or {}).get("code")
    out["error"] = (body or {}).get("error")
    if status != 200:
        out["issues"].append(f"ХОД УПАЛ: {status} {body.get('error') or body}")
        out["answer"] = str(body.get("error") or "")
        return out
    steps = body.get("steps") or []
    out["tools"] = [{"tool": s.get("tool"), "args": s.get("args"), "status": s.get("status"),
                     "result": s.get("result"), "proposal": s.get("proposal")} for s in steps]
    out["pending"] = bool(steps and any(s.get("status") == "needs_confirm" for s in steps))
    out["quota"] = (body.get("quota") or {}).get("remaining")
    out["cost"] = (body.get("usage") or {}).get("cost")
    out["suggests"] = body.get("suggests") or []
    out["answer"] = body.get("final") or ""

    names = [s.get("tool") for s in steps]
    if sc.get("must_tool") and sc["must_tool"] not in names:
        out["issues"].append(f"НЕ ВЫЗВАН {sc['must_tool']} (вызваны: {names or 'ничего'})")
    if sc.get("must_op"):
        ops = [s.get("args", {}).get("op") for s in steps if s.get("tool") == "fold_web"]
        if sc["must_op"] not in ops:
            out["issues"].append(f"НЕ ВЫЗВАН fold_web(op={sc['must_op']}) (ops: {ops})")
    if sc.get("expect_tool") and not steps:
        out["issues"].append("НЕТ ШАГОВ ИНСТРУМЕНТОВ")
    if sc.get("expect_pending") and not out["pending"]:
        out["issues"].append("ДЕЙСТВИЕ БЕЗ ПОДТВЕРЖДЕНИЯ (applied вместо needs_confirm)")
    if sc.get("allow_action"):
        # Неоднозначная просьба: действие допустимо, но только по названной теме —
        # проверим это по базе (verify_db_state), здесь не мешаем ничему.
        out["no_wrong_action"] = True
    if not sc.get("allow_tool") and not sc.get("expect_tool") and steps:
        out["issues"].append("ИНСТРУМЕНТ ЗОВАН БЕЗ НАДОБНОСТИ: " + ", ".join(names))
    if out["pending"] and sc.get("confirm"):
        msg_id = next((s.get("id") for s in steps if s.get("status") == "needs_confirm"), None)
        st2, b2 = client.request(base, "POST", "/api/agent/turns/confirm",
                                 {"messageId": msg_id, "approve": True}, timeout=300)
        out["confirm_http"] = st2
        out["confirm_error"] = (b2 or {}).get("error")
        out["confirm_final"] = (b2 or {}).get("final") or ""
    if sc.get("resolve_skill"):
        out["resolve_skill"] = sc["resolve_skill"]
        out["resolved_ok"] = None
        out["resolve_task"] = sc.get("resolve_task") or None
    if sc.get("expect_goal"):
        out["goal_ok"] = None
    out["issues"] += analyze_answer(out["answer"], steps, seed_numbers, skill_names,
                                     bool(sc.get("expect_tool")), bool(sc.get("allow_codes")),
                                     sc.get("text", ""), bool(out["pending"]))
    # Ход, встающий на подтверждение, возвращает final=None by design: ученик
    # видит карточку шага с ЧЕЛОВЕЧЕСКОЙ подписью («Меняю профиль: 95+ баллов»)
    # и текст «Нужно твоё подтверждение». Это не замечание, а наблюдение.
    out["note"] = []
    if out["pending"] and not out["answer"].strip():
        out["note"].append("ход на подтверждении без текста ответа — карточка шага несёт смысл")
    return out


def verify_db_state(conn: sqlite3.Connection, res: list, users: dict) -> list:
    """Проверки, которые видно только в базе: куда именно записалось действие.

    Здесь ловится самый дорогой класс багов ИИ: действие применено, ученику
    сказано «готово», а запись легла не туда (чужое задание, чужой предмет, чужая
    ошибка) — снаружи это выглядит как успех.

    ВАЖНО (баг самой проверки, найдено на прогоне): «какая строка теперь
    resolved=1» определять по MAX(id) нельзя — в сиде уже есть решённые строки с
    БОЛЬШИМ id, и такой запрос стабильно показывал «resolve_error испортил
    ошибку навыка N», хотя инструмент отработал верно (в прогоне он закрыл id 7 =
    производные, а MAX(id) среди resolved указывал на чужую сидовую строку).
    Правильно — сверять КОНКРЕТНЫЙ id из предложения: он пришёл ученику в карточке
    подтверждения, и именно он должен перейти в resolved=1, а все остальные
    открытые — остаться нетронутыми.
    """
    notes = []
    for r in res:
        prop = next((t.get("proposal") for t in r["tools"]
                     if t.get("tool") in ("resolve_error", "update_profile", "reset_progress")
                     and t.get("proposal")), None)
        if r["key"] == "resolve_action" and r.get("confirm_http") == 200:
            uid = users["math"]
            want_skill = r.get("resolve_skill")
            want_task = r.get("resolve_task")
            eid = int((prop or {}).get("errorId") or 0)
            row = conn.execute("SELECT id, task_id, skill_id, resolved FROM user_errors WHERE id=?",
                               (eid,)).fetchone() if eid else None
            before = r.get("resolved_before") or 0
            after = conn.execute("SELECT COUNT(*) FROM user_errors WHERE user_id=? AND subject=? AND resolved=1",
                                 (uid, "profile_math")).fetchone()[0]
            # Чужих строк сида трогать нельзя: считаем ТОЛЬКО строки этого юзера.
            ok = bool(row) and row["skill_id"] == want_skill and after == before + 1
            if want_task:
                ok = ok and str(row["task_id"]) == want_task
            r["resolved_ok"] = ok
            if not ok:
                r["issues"].append(
                    f"resolve_error закрыл id={eid} skill={row['skill_id'] if row else None} "
                    f"(ждали {want_skill}, задание {want_task}); resolved {before}→{after}")
            notes.append((f"resolve_error → id={eid} skill={row['skill_id'] if row else None} "
                          f"(ждали {want_skill}), resolved {before}→{after}", ok))
        if r["key"] == "resolve_ambiguous" and r.get("pending"):
            # Просьба неоднозначная: закрыть можно ЛЮБУЮ ошибку названной темы —
            # вот это и проверяем (навык, а не конкретное задание).
            eid = int((prop or {}).get("errorId") or 0)
            row = conn.execute("SELECT skill_id FROM user_errors WHERE id=?", (eid,)).fetchone() if eid else None
            ok = bool(row) and row["skill_id"] == r.get("resolve_skill")
            r["no_wrong_action"] = ok
            if not ok:
                r["issues"].append(f"неоднозначная просьба закрыта вне темы: id={eid} "
                                   f"skill={row['skill_id'] if row else None}")
            notes.append((f"неоднозначная просьба закрыла id={eid} skill="
                          f"{row['skill_id'] if row else None} (тема {r.get('resolve_skill')})", ok))
        if r["key"] == "profile_action" and r.get("confirm_http") == 200:
            row = conn.execute("SELECT goal_id FROM user_subjects WHERE user_id=? AND subject=?",
                               (users["math"], "profile_math")).fetchone()
            ok = bool(row) and row["goal_id"] == r.get("expect_goal")
            r["goal_ok"] = ok
            if not ok:
                r["issues"].append(f"update_profile: goal_id={row['goal_id'] if row else None}, "
                                   f"ждали {r.get('expect_goal')}")
            notes.append((f"update_profile → goal_id {row['goal_id'] if row else None} "
                          f"(ждали {r.get('expect_goal')})", ok))
        if r["key"] == "reset_guard":
            uid = users["math"]
            before = r.get("errors_open_before")
            after = conn.execute("SELECT COUNT(*) FROM user_errors WHERE user_id=? AND subject=? AND resolved=0",
                                 (uid, "profile_math")).fetchone()[0]
            ok = before is not None and after == before
            if not ok:
                r["issues"].append(f"reset_progress БЕЗ подтверждения изменил данные: открытых ошибок {before} → {after}")
            notes.append((f"reset_progress без подтверждения не тронул данные ({before} → {after})", ok))
    return notes


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="номера сценариев через запятую")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--report", default="/tmp/opencode/stress-report.md")
    ap.add_argument("--dump-json", default="")
    args = ap.parse_args()
    setup_env()

    only = {int(x) for x in args.only.split(",") if x.strip().isdigit()}
    todo = [s for s in SCENARIOS if (not only or s["id"] in only)]
    if not todo:
        print("нет сценариев по --only")
        return 2

    results = []
    with tempfile.TemporaryDirectory(prefix="ege-agent-stress-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai, agent = server._AI, server._AGENT
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        # Мок-провайдер для DRY: всегда «инструмент + финальный текст».
        if DRY:
            state = {"n": 0}

            def mock_chat(messages, tools, **kw):
                state["n"] += 1
                if state["n"] % 2:
                    return {"text": "", "tool_calls": [{"id": f"m{state['n']}", "name": "fold_web",
                                                        "arguments": {"op": "profile"}}]}
                return {"text": "Ответ по данным.", "tool_calls": []}

            def mock_plain(messages, **kw):
                state["n"] += 1
                return "Ответ по данным."

            ai.chat_with_tools = mock_chat
            ai.chat = mock_plain
            ai.reset_ai_rate()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        clients = {"math": Client("10.7.0.1"), "russian": Client("10.7.0.2")}
        users = {}
        seed_numbers = set()
        skill_names = {}
        ctx = {}
        for who, subject, name, seed_fn in (("math", "profile_math", "Аня", seed_math),
                                           ("russian", "russian", "Дима", seed_russian)):
            st, body = clients[who].request(base, "POST", "/api/profile/claim",
                                            {"subject": subject, "onboarded": True, "name": name})
            if st != 200:
                print(f"claim {who} -> {st} {body}")
                return 2
            conn = server.connect()
            try:
                # claim не отдаёт users.id — берём его из своей базы по имени.
                row = conn.execute("SELECT id FROM users WHERE name=? ORDER BY id DESC LIMIT 1", (name,)).fetchone()
                users[who] = int(row["id"]) if row else None
                if not users[who]:
                    print(f"не нашли users.id после claim {who}")
                    return 2
                ctx[who] = seed_fn(conn, int(users[who]))
                for tbl, where, params in (
                        ("user_stats", "user_id=? AND subject=?", (users[who], subject)),
                        ("user_progress", "user_id=? AND subject=?", (users[who], subject)),
                        ("user_errors", "user_id=? AND subject=?", (users[who], subject)),
                        ("task_attempts", "user_id=? AND subject=?", (users[who], subject)),
                        ("daily_progress", "user_id=? AND subject=?", (users[who], subject)),
                        ("activity_history", "user_id=? AND subject=?", (users[who], subject)),
                ):
                    for row in conn.execute(f"SELECT * FROM {tbl} WHERE {where}", params):
                        for v in tuple(row):
                            if isinstance(v, (int, float)) and not isinstance(v, bool):
                                seed_numbers.add(int(v))
                for r in conn.execute("SELECT id, name FROM skills WHERE subject=?", (subject,)):
                    skill_names[r["id"]] = r["name"]
            finally:
                conn.close()

        # Подстановки в тексты сценариев берутся из каталога/сида: реальные id
        # заданий и настоящие названия навыков вместо выдуманных строк.
        math_skills = ctx["math"]["skills"]
        deriv_skill = next((s for s, n in math_skills.items() if "производ" in (n or "").lower()), None)
        any_task = next((t for s in math_skills for t in ctx["math"]["by_skill"][s]["tasks"]), "")
        fmt = {"task": any_task,
               "skill": sorted(math_skills)[0],
               "deriv_skill": deriv_skill or sorted(math_skills)[0],
               "deriv": (math_skills.get(deriv_skill) or "ошибкам").split("—")[-1].strip() or "ошибкам"}
        # Тема ПЕРВОГО задания производных: в сиде на неё ровно одна открытая
        # ошибка, поэтому просьба однозначна и действие обязано быть вызвано.
        deriv_task = ""
        if deriv_skill:
            tasks = ctx["math"]["by_skill"].get(deriv_skill, {}).get("tasks") or []
            if tasks:
                c2 = server.connect()
                try:
                    row = c2.execute("SELECT topic FROM tasks WHERE id=?", (tasks[0],)).fetchone()
                finally:
                    c2.close()
                deriv_task = (row["topic"] if row else "") or tasks[0]
        fmt["deriv_task"] = deriv_task or fmt["deriv"]
        fmt["deriv_task_id"] = (tasks[0] if deriv_skill and (tasks := ctx["math"]["by_skill"]
                                 .get(deriv_skill, {}).get("tasks") or []) else "") or ""
        for sc in todo:
            try:
                sc["text"] = sc["text"].format(**fmt)
            except (KeyError, IndexError):
                pass
            for key in ("resolve_skill", "resolve_task"):
                if key in sc and sc[key]:
                    try:
                        sc[key] = str(sc[key]).format(**fmt)
                    except (KeyError, IndexError):
                        pass

        def baseline_for(sc: dict) -> dict:
            """Снимок БД до хода: без него нельзя доказать, что действие что-то изменило."""
            if not (sc.get("resolve_skill") or sc.get("expect_pending")):
                return {}
            conn = server.connect()
            try:
                uid = users[sc["subject"]]
                return {"resolved_before": conn.execute(
                    "SELECT COUNT(*) FROM user_errors WHERE user_id=? AND subject=? AND resolved=1",
                    (uid, "profile_math" if sc["subject"] == "math" else "russian")).fetchone()[0],
                    "errors_open_before": conn.execute(
                    "SELECT COUNT(*) FROM user_errors WHERE user_id=? AND subject=? AND resolved=0",
                    (uid, "profile_math" if sc["subject"] == "math" else "russian")).fetchone()[0]}
            finally:
                conn.close()

        print(f"=== СТРЕСС ИИ ({'DRY/мок' if DRY else 'ЖИВОЙ провайдер'}) ===")
        print(f"база: temp, сценариев: {len(todo)}, повторов: {args.repeat}")
        print(f"подстановки: task={fmt['task']} skill={fmt['skill']} "
              f"deriv={fmt['deriv_skill']} («{fmt['deriv']}»)")
        for rep in range(args.repeat):
            for sc in todo:
                r = run_scenario(clients[sc["subject"]], base, sc, seed_numbers,
                                 skill_names, DRY, baseline_for(sc))
                r["rep"] = rep + 1
                results.append(r)
                flag = "OK " if not r["issues"] else "!! "
                print(f"{flag}[{sc['id']:>2}] {sc['key']:<18} {r.get('http', '-')} "
                      f"{r.get('seconds', '-')}s tools={[t['tool'] for t in r['tools']] or '-'}"
                      + (f" cost={r.get('cost')}" if r.get("cost") is not None else ""))
                for note in r.get("note") or []:
                    print(f"      · {note}")
                for issue in r["issues"]:
                    print(f"      - {issue}")
                sys.stdout.flush()

        conn = server.connect()
        try:
            db_notes = verify_db_state(conn, results, users)
        finally:
            conn.close()
        httpd.shutdown()

    # ---- отчёт ----
    bad = [r for r in results if r["issues"]]
    lines = [f"# Стресс ИИ — {'DRY (мок)' if DRY else 'живой провайдер'}",
             f"сценариев: {len(results)}, с замечаниями: {len(bad)}", ""]
    for note, ok in db_notes:
        lines.append(f"- {'OK' if ok else '!!'} {note}")
    lines.append("")
    for r in results:
        lines.append(f"## [{r['id']}] {r['key']} (повтор {r.get('rep')}) — {r.get('goal', '')}")
        lines.append(f"- вопрос: «{r['text']}»")
        lines.append(f"- HTTP {r.get('http')} {r.get('seconds')}s, шаги: "
                     f"{[(t['tool'], t.get('args')) for t in r['tools']] or 'НЕТ'}")
        if r.get("pending"):
            lines.append(f"- действие ждёт подтверждения: да (confirm HTTP {r.get('confirm_http')}"
                         f"{', ошибка: ' + str(r['confirm_error']) if r.get('confirm_error') else ''})")
        if r.get("suggests"):
            lines.append(f"- кнопки-продолжения: {[s.get('label') for s in r['suggests']]}")
        else:
            lines.append("- кнопки-продолжения: НЕТ")
        if r.get("confirm_final"):
            lines.append(f"- текст после подтверждения: {r['confirm_final'][:400]}")
        for key in ("resolved_ok", "goal_ok"):
            if key in r:
                lines.append(f"- {key}: {r[key]}")
        lines.append(f"- ответ:\n\n> {(r['answer'] or '(пусто)').strip()[:1200]}\n")
        if r["issues"]:
            lines.append("**Замечания:**")
            lines += [f"  - {i}" for i in r["issues"]]
        lines.append("")
    report = "\n".join(lines)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(report, encoding="utf-8")
    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== ИТОГ: {len(results) - len(bad)}/{len(results)} сценариев без замечаний ===")
    for note, ok in db_notes:
        if not ok:
            print("!! " + note)
    print(f"отчёт: {args.report}")
    return 1 if (bad or any(not ok for _, ok in db_notes)) else 0


if __name__ == "__main__":
    sys.exit(main())
