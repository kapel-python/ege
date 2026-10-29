#!/usr/bin/env python3
"""find_topics одним точным вызовом вместо перебора формулировок.

Живой случай (apghyv): «дай задание 32 из 100 по стереометрии» стоило 3
find_topics («стереометрия» → «задание 32» → «пирамида объём»), а «посложнее»
— ещё 3 («сечение призмы цилиндра конуса шара» + дважды про «№15»,
который модель выдумала). Теперь всё кладётся в один вызов: exam (номер),
skillId (тема), difficultyMin/Max и harderThan/easierThan (сложность),
offset/limit (позиция в банке + position/bankTotal в ответе).

Офлайн, temp-БД: фильтры, строгость сравнений, порядок и пейджинг банка,
ошибки для починки моделью, байтовая совместимость старого query-поиска
и сквозной ход «1 поиск + 1 открытие» через run_cycle.
"""
from __future__ import annotations

import importlib.util
import json
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


spec = importlib.util.spec_from_file_location("ege_agent_find_test", ROOT / "server" / "agent.py")
assert spec and spec.loader
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

fd, path = tempfile.mkstemp(suffix=".sqlite3")
os.close(fd)
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
conn.execute("CREATE TABLE skills(id TEXT PRIMARY KEY, name TEXT, subject TEXT, display_order INT)")
conn.execute("CREATE TABLE lessons(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, metadata_json TEXT)")
conn.execute("CREATE TABLE missions(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, description TEXT, xp INT, difficulty INT)")
conn.execute("""CREATE TABLE tasks(id TEXT PRIMARY KEY, skill_id TEXT, topic TEXT,
                exam_number TEXT, difficulty INT, statement TEXT, answer TEXT,
                explanation TEXT, hint TEXT, task_type TEXT, metadata_json TEXT)""")
conn.execute("INSERT INTO skills VALUES('st_stereo','Стереометрия','math',1)")
conn.execute("INSERT INTO skills VALUES('st_deriv','Производная','math',2)")
conn.execute("INSERT INTO missions VALUES('m-st_stereo','st_stereo','Практика','',10,1)")
conn.execute("INSERT INTO missions VALUES('m-st_deriv','st_deriv','Практика','',10,1)")
conn.execute("INSERT INTO lessons VALUES('les_stereo','st_stereo','Объём', '{}')")
# Банк стереометрии: 12 заданий, сложности 1–4, два номера, три с битым рисунком.
for i in range(1, 13):
    diff = ((i - 1) % 4) + 1
    exam = "№15" if i % 3 == 0 else "№3"
    meta = {"visual": {"required": True}} if i in (4, 8, 12) else {}
    conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                 (f"s{i}", "st_stereo", f"Пирамида задача {i}", exam, diff,
                  f"Условие {i}", str(i), "", "", "short_answer", json.dumps(meta)))
# Ловушка цифр: «27» в теме, но номер — №1 (exam=27 её брать не должен).
conn.execute("""INSERT INTO tasks VALUES('trap','st_stereo','Шар в 27 раз больше','№1',2,
                'S','A','','','short_answer','{}')""")
conn.execute("""INSERT INTO tasks VALUES('d1','st_deriv','Касательная','№9',2,
                'S','A','','','short_answer','{}')""")

# 1. Старый query-поиск — как был (форма, порядок, без позиций).
r = agent.find_topics(conn, 1, "math", {"query": "пирамида"})
ids = [t["id"] for t in r["tasks"]]
check("legacy: форма и ключи", all(set(t) >= {"id", "topic", "exam", "difficulty", "match"} for t in r["tasks"]),
      str(ids[:4]))
check("legacy: побайтовый порядок", ids == sorted(ids), str(ids[:5]))
check("legacy: без позиций", all("position" not in t for t in r["tasks"]))
check("legacy: битый рисунок в поиске есть (не банк)", "s4" in ids)

# 2. exam — точный номер, без ложных «27 в тексте».
r = agent.find_topics(conn, 1, "math", {"exam": "15"})
got = [t["id"] for t in r["tasks"]]
check("exam=15 только №15", got and all(t["exam"] == "№15" for t in r["tasks"]), str(got))
check("exam=15 без ловушки", "trap" not in got)
r = agent.find_topics(conn, 1, "math", {"exam": "задание 27"})
check("exam=27 честно пуст (ловушка не матч)", r["tasks"] == [], str([t["id"] for t in r["tasks"]]))
check("exam echo в applied", r.get("applied", {}).get("exam") == [27], str(r.get("applied")))

# 3. skillId — только своя тема + банк с позициями, битые вне банка.
r = agent.find_topics(conn, 1, "math", {"skillId": "st_stereo", "limit": 20})
got = r["tasks"]
check("skillId: только своя тема", got and all(t["skillName"] == "Стереометрия" for t in got))
check("skillId: bankTotal без битых", all(t["bankTotal"] == 10 for t in got), str(got[0]))
check("skillId: позиции по порядку", [t["position"] for t in got] == list(range(1, len(got) + 1)))
check("skillId: ловушка на своём месте", [t["id"] for t in got].index("trap") == 9,
      str([t["id"] for t in got]))
r = agent.find_topics(conn, 1, "math", {"skillId": "st_stereo", "offset": 9, "limit": 3})
check("offset=9: 32-е место механики", [t["id"] for t in r["tasks"]] == ["trap"]
      and r["tasks"][0]["position"] == 10, str([(t["id"], t["position"]) for t in r["tasks"]]))
try:
    agent.find_topics(conn, 1, "math", {"skillId": "нетакой"})
    check("чужой skillId", False, "ошибки не было")
except ValueError as e:
    check("чужой skillId чинится списком", "st_stereo" in str(e), str(e)[:60])

# 4. Сложность: границы, строгость, порядок.
r = agent.find_topics(conn, 1, "math", {"query": "пирамида", "difficultyMin": 3})
got = [(t["id"], t["difficulty"]) for t in r["tasks"]]
check("difficultyMin=3 фильтр", got and all(d >= 3 for _, d in got), str(got))
check("difficultyMin=3 сначала трудные", [d for _, d in got] == sorted([d for _, d in got], reverse=True), str(got))
r = agent.find_topics(conn, 1, "math", {"query": "пирамида", "difficultyMax": 2})
got_max = [(t["id"], t["difficulty"]) for t in r["tasks"]]
check("difficultyMax=2 фильтр", got_max and all(d <= 2 for _, d in got_max), str(got_max[:4]))
r = agent.find_topics(conn, 1, "math", {"query": "пирамида", "harderThan": "s1"})
ref_d = 1  # s1: ((1-1)%4)+1
got = [(t["id"], t["difficulty"]) for t in r["tasks"]]
check("harderThan строго сложнее", got and all(d > ref_d for _, d in got), str(got))
r = agent.find_topics(conn, 1, "math", {"query": "пирамида", "easierThan": "s3"})
got_easy = [(t["id"], t["difficulty"]) for t in r["tasks"]]
check("easierThan строго легче", got_easy and all(d < 3 for _, d in got_easy), str(got_easy))
for bad in ({"difficultyMin": 9}, {"difficultyMin": "сложно"}, {"difficultyMin": 3, "difficultyMax": 2},
            {"harderThan": "нетакого"}, {"easierThan": "нетакого"}):
    try:
        agent.find_topics(conn, 1, "math", {"query": "пирамида", **bad})
        check(f"граница {bad}", False, "ошибки не было")
    except ValueError:
        check(f"граница {bad}", True)

# 5. Пустые/бессмысленные вызовы — ошибка, а не молчание.
for bad in ({}, {"query": "  "}, {"offset": 5}, {"exam": "без цифр"}, {"offset": -2}, {"limit": "много"}):
    try:
        agent.find_topics(conn, 1, "math", bad)
        check(f"пустой {bad}", False, "ошибки не было")
    except ValueError:
        check(f"пустой {bad}", True)

# 6. Свалка синонимов по-прежнему честно пуста (AND-семантика держится).
r = agent.find_topics(conn, 1, "math", {"query": "сечение призмы цилиндра конуса шара"})
check("кухонная свалка не дампит каталог", r["found"] == 0 and r["tasks"] == [])

# 6a. База без таблицы ilessons (старая): ключ есть, пуст, падений нет.
r = agent.find_topics(conn, 1, "math", {"query": "пирамида"})
check("без ilessons-таблицы поиск жив", r.get("ilessons") == [], str(r.get("ilessons")))
r = agent.find_topics(conn, 1, "math", {"skillId": "st_stereo", "limit": 5})
check("без ilessons-таблицы пин жив", r.get("ilessons") == [], str(r.get("ilessons")))

# 6b. Позиция без темы: автопин живого банка с пометкой (а не пустого).
conn.execute("INSERT INTO skills VALUES('st_empty','Стереометрия пустая','math',0)")
r = agent.find_topics(conn, 1, "math", {"query": "стереометрия", "offset": 9, "limit": 2})
check("автопин: живой банк, а не пустой", r.get("applied", {}).get("autoPinned") is True
      and r.get("applied", {}).get("skillId") == "st_stereo"
      and [t["id"] for t in r["tasks"]] == ["trap"], str(r.get("applied")))
check("автопин: пометка в note", "взял" in r["note"] and "лучшее совпадение" in r["note"])

# 7. Сквозной ход: 1 поиск + 1 открытие (было 3+1).
script = [
    {"text": None, "tool_calls": [{"id": "c1", "name": "find_topics",
                                   "arguments": {"query": "пирамида", "harderThan": "s1"}}]},
    {"text": None, "tool_calls": [{"id": "c2", "name": "task_get", "arguments": {"taskId": "s3"}}]},
    {"text": "Держи задачу.", "tool_calls": []},
]
n = {"i": 0}


def fake_chat(messages, tools, budget):
    assert any(t.get("function", {}).get("name") == "find_topics" for t in tools)
    assert any(t.get("function", {}).get("name") == "task_get" for t in tools)
    item = script[min(n["i"], len(script) - 1)]
    n["i"] += 1
    return item


steps, final, pending = agent.run_cycle(conn, 1, "math", [], fake_chat)
check("цикл: ровно 2 шага", [s["name"] for s in steps] == ["find_topics", "task_get"], str([s["name"] for s in steps]))
check("цикл: ссылка в открытии", steps[1].get("result", {}).get("link", "").endswith("?task=s3&seo_subject=math"),
      str(steps[1].get("result", {}).get("link")))
check("цикл: финал без confirm", final == "Держи задачу." and pending is None)

conn.close()
try:
    Path(path).unlink()
except OSError:
    pass
print(f"\n{checks - failures}/{checks} passed")
raise SystemExit(1 if failures else 0)
