#!/usr/bin/env python3
"""Прямая ссылка ИИ на задание практики: task_get.link + инструмент task_link.

Офлайн, temp-БД: task_get при открытии задания сразу отдаёт `link`
(миссия навыка + ?task=), новый read-инструмент task_link возвращает ту же
ссылку без условия/разбора (id уже есть из errors/attempts), у сочинений
и заданий без миссии ссылки нет — честная ошибка словами, адрес модель
сама не собирает (инструмент — единственный источник), шаг ленты
человеческий, wiring реестра полный (AGENT_TOOLS/READ_TOOLS/execute/health),
а правило 5f2 в промпте требует кнопку после каждого открытого задания.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


spec = importlib.util.spec_from_file_location("ege_agent_task_link_test", ROOT / "server" / "agent.py")
assert spec and spec.loader
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

os.environ["EGE_PUBLIC_URL"] = "https://lemmago.ru"

fd, path = tempfile.mkstemp(suffix=".sqlite3")
os.close(fd)
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
conn.execute("CREATE TABLE skills(id TEXT PRIMARY KEY, name TEXT, subject TEXT, display_order INT)")
conn.execute("CREATE TABLE missions(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, description TEXT, xp INT, difficulty INT)")
conn.execute("""CREATE TABLE tasks(id TEXT PRIMARY KEY, skill_id TEXT, topic TEXT,
                exam_number TEXT, difficulty INT, statement TEXT, answer TEXT,
                explanation TEXT, hint TEXT, task_type TEXT, metadata_json TEXT)""")
conn.execute("INSERT INTO skills VALUES('n09_derivative','№9 — Производная','profile_math',1)")
conn.execute("INSERT INTO skills VALUES('russian_essay','Сочинение','russian',1)")
conn.execute("INSERT INTO skills VALUES('lonely','Без миссии','profile_math',2)")
conn.execute("INSERT INTO missions VALUES('m-n09_derivative','n09_derivative','Практика','',10,1)")
conn.execute("INSERT INTO missions VALUES('russian_essay_practice','russian_essay','Сочинение','',10,1)")
conn.execute("""INSERT INTO tasks VALUES('n09_a5','n09_derivative','График производной','№9',1,
                'Условие','1','Разбор','Подсказка','short_answer','{}')""")
conn.execute("""INSERT INTO tasks VALUES('re_1_1','russian_essay','Текст №1','№27',1,
                'Напиши сочинение','', '', '', 'long_text','{}')""")
conn.execute("""INSERT INTO tasks VALUES('orphan_1','lonely','Сирота','№1',1,
                'Условие','1','','','short_answer','{}')""")

# 1. task_get отдаёт ссылку сразу при открытии
out = agent.task_get(conn, 1, "profile_math", {"taskId": "n09_a5"})
check("task_get.link точный",
      out.get("link") == "https://lemmago.ru/dashboard#/practice/m-n09_derivative?task=n09_a5",
      str(out.get("link")))
check("task_get.missionId", out.get("missionId") == "m-n09_derivative")
check("task_get условие цело", out.get("statement") == "Условие" and out.get("answer") == "1")

# 2. task_link — та же ссылка без условия
info = agent.task_link(conn, 1, "profile_math", {"taskId": "n09_a5"})
check("task_link.link совпадает с task_get", info.get("link") == out.get("link"), str(info))
check("task_link без спойлеров",
      "statement" not in info and "answer" not in info and "explanation" not in info)
check("task_link несёт тему", bool(info.get("topic")))

# 3. Сочинение: ссылки нет — честная ошибка, а не битая кнопка
try:
    agent.task_link(conn, 1, "russian", {"taskId": "re_1_1"})
    check("essay без ссылки", False, "ошибки не было")
except ValueError as e:
    check("essay без ссылки", "практики" in str(e), str(e)[:60])
essay_out = agent.task_get(conn, 1, "russian", {"taskId": "re_1_1"})
check("task_get сочинения без link", "link" not in essay_out)

# 4. Задание без миссии: тоже честно
try:
    agent.task_link(conn, 1, "profile_math", {"taskId": "orphan_1"})
    check("orphan без ссылки", False, "ошибки не было")
except ValueError:
    check("orphan без ссылки", True)

# 5. Несуществующий id и пустой: ошибка для починки моделью
for bad in ("nope_nope", "", "  "):
    try:
        agent.task_link(conn, 1, "profile_math", {"taskId": bad})
        check(f"битый id {bad!r}", False, "ошибки не было")
    except ValueError:
        check(f"битый id {bad!r}", True)

# 6. Wiring: реестр, исполнение, подсказки, лента, health
names = [t["function"]["name"] for t in agent.AGENT_TOOLS]
check("task_link в AGENT_TOOLS", "task_link" in names)
check("task_link в READ_TOOLS", "task_link" in agent.READ_TOOLS)
check("execute_read_tool ведёт task_link",
      agent.execute_read_tool(conn, 1, "profile_math", "task_link", {"taskId": "n09_a5"})["link"]
      == out["link"])
hint = agent._hints_for_tool(conn, "profile_math", "task_link", {"taskId": "zzz"})
check("подсказка починки без самопала",
      "task_link" in str(hint.get("hint")) and "не собирай" in str(hint.get("hint")),
      str(hint.get("hint"))[:70])
step = agent.describe_step("task_link", {"taskId": "n09_a5"}, info)
check("шаг ленты человеческий", "task_link" not in step and "n09_a5" not in step, step[:60])
check("health без missing", agent.public_agent_health()["missing"] == [],
      str(agent.public_agent_health()["missing"]))

# 7. База ссылок — env, иначе канон
os.environ["EGE_PUBLIC_URL"] = "https://example.test/"
mine = agent.task_link(conn, 1, "profile_math", {"taskId": "n09_a5"})["link"]
check("база из EGE_PUBLIC_URL", mine.startswith("https://example.test/"), mine)
del os.environ["EGE_PUBLIC_URL"]
canon = agent.task_link(conn, 1, "profile_math", {"taskId": "n09_a5"})["link"]
check("канон без env", canon.startswith("https://lemmago.ru/"), canon)

# 8. Промпт требует кнопку после каждого открытого задания
check("промпт 5f2: кнопка обязательна", "5f2" in agent.AGENT_SYSTEM
      and "ЗАДАНИЕ В ТРЕНАЖЁРЕ" in agent.AGENT_SYSTEM)
check("промпт 5f2: самопал запрещён", "НИКОГДА не собирай" in agent.AGENT_SYSTEM
      or "не собирай" in agent.AGENT_SYSTEM)

conn.close()
try:
    Path(path).unlink()
except OSError:
    pass
print(f"\n{checks - failures}/{checks} passed")
raise SystemExit(1 if failures else 0)
