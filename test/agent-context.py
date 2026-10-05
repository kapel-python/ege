#!/usr/bin/env python3
"""Стартовый контекст хода ИИ: предмет словами, имя, компактный прогноз.

Офлайн, temp-БД: turn_system кладёт в system предмет человеческим
названием (без кода вроде profile_math), имя ученика и свежий прогноз —
чтобы модель не тратила вызовы fold_web ради имени/предмета/прогноза.
Неизвестный предмет и пустая база — без падений.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
import time
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


spec = importlib.util.spec_from_file_location("ege_agent_ctx_test", ROOT / "server" / "agent.py")
assert spec and spec.loader
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

fd, path = tempfile.mkstemp(suffix=".sqlite3")
os.close(fd)
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
agent.ensure_agent_schema(conn)
conn.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, created_at INT DEFAULT 0)")
conn.execute("CREATE TABLE user_subjects(user_id INT, subject TEXT, onboarded INT DEFAULT 0, self_level TEXT, goal_id TEXT, state_version INT DEFAULT 0, PRIMARY KEY(user_id,subject))")
conn.execute("CREATE TABLE skills(id TEXT PRIMARY KEY, name TEXT, subject TEXT, display_order INT)")
conn.execute("CREATE TABLE user_progress(user_id INT, subject TEXT, skill_id TEXT, solved INT, correct INT, progress INT)")
conn.execute("CREATE TABLE lessons(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, metadata_json TEXT)")
conn.execute("CREATE TABLE completed_lessons(user_id INT, subject TEXT, lesson_id TEXT)")
conn.execute("CREATE TABLE task_attempts(id INTEGER PRIMARY KEY, user_id INT, subject TEXT, task_id TEXT, skill_id TEXT, correct INT, hint_level INT, created_at INT)")
conn.execute("CREATE TABLE diagnostics(id INTEGER PRIMARY KEY, user_id INT, task_id TEXT, correct INT, created_at INT, subject TEXT)")
now = int(time.time() * 1000)
conn.execute("INSERT INTO users(id,name,created_at) VALUES(1,'Стёпа',?)", (now - 10 * 86400000,))
conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded,self_level,goal_id) VALUES(1,'profile_math',1,'base','g80')")
conn.execute("INSERT INTO skills VALUES('n09_derivative','Производная','profile_math',1)")
conn.execute("INSERT INTO skills VALUES('n19_parameter','Параметр','profile_math',2)")
conn.execute("INSERT INTO skills VALUES('n20_numbers','Числа','profile_math',3)")
conn.execute("INSERT INTO skills VALUES('n15_stereometry','Стереометрия','profile_math',4)")
conn.execute("INSERT INTO user_progress VALUES(1,'profile_math','n09_derivative',10,8,0)")
conn.commit()

sys_text = agent.turn_system(conn, 1, "profile_math")
check("subject plain words", "Профильная математика" in sys_text, sys_text[-400:])
check("no raw subject id", "profile_math" not in sys_text)
check("student name quoted", "«Стёпа»" in sys_text)
check("forecast line", "Прогноз:" in sys_text and "Что подтянуть:" in sys_text,
      str([ln for ln in sys_text.splitlines() if ln.startswith("Прогноз")]))
check("forecast numbers match dashboard formula",
      "Прогноз: сейчас ~6 из 100, разброс 0–18." in sys_text)
check("base prompt intact", sys_text.startswith(agent.AGENT_SYSTEM))
check("context marker", "КОНТЕКСТ ХОДА" in sys_text)

ru = agent.turn_system(conn, 1, "russian")
check("russian title", "Русский язык" in ru and "russian" not in ru.split("КОНТЕКСТ")[1])

unknown = agent.turn_system(conn, 1, "nope_subject")
check("unknown subject no crash", "КОНТЕКСТ ХОДА" in unknown and unknown.startswith(agent.AGENT_SYSTEM))

noname = agent.turn_system(conn, 999, "basic_math")
check("missing user no crash", "Базовая математика" in noname and "Ученик:" not in noname)

check("title fallback map", agent.subject_title("society") == "Обществознание")
check("title empty safe", agent.subject_title("") == "" and agent.subject_title(None) == "")

msgs = agent.build_messages(sys_text, [], "привет")
check("system carries context", msgs[0]["role"] == "system" and "Профильная математика" in msgs[0]["content"])

# --- Формула как в браузере: теория, затухание, диагностика, насыщение ---
conn.execute("INSERT INTO users(id,name,created_at) VALUES(2,'У',?)", (now - 10 * 86400000,))
conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded) VALUES(2,'profile_math',1)")
conn.execute("INSERT INTO skills VALUES('sA','Теория','profile_math',10)")
conn.execute("INSERT INTO skills VALUES('sB','Диагностика','profile_math',11)")
conn.execute("INSERT INTO skills VALUES('sC','Давность','profile_math',12)")
conn.execute("INSERT INTO lessons VALUES('lA','sA','Урок А','{}')")
conn.execute("INSERT INTO completed_lessons VALUES(2,'profile_math','lA')")
for i in range(12):
    conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
                 " VALUES(2,'profile_math',?,?,1,0,?)", (f"tA{i}", "sA", now - i * 60000))
conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
             " VALUES(2,'profile_math','tB','sB',1,0,?)", (now,))
conn.execute("INSERT INTO diagnostics(user_id,task_id,correct,created_at,subject)"
             " VALUES(2,'tB',1,?,'profile_math')", (now,))
conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
             " VALUES(2,'profile_math','tC','sC',1,0,?)", (now - 90 * 86400000,))
conn.commit()
check("theory 40 + saturated practice = 100",
      agent._skill_mastery(conn, 2, "profile_math", "sA") == 100)
check("diagnostic counts double",
      agent._skill_mastery(conn, 2, "profile_math", "sB") == 17,
      str(agent._skill_mastery(conn, 2, "profile_math", "sB")))
check("90-day-old attempt decayed",
      agent._skill_mastery(conn, 2, "profile_math", "sC") == 1,
      str(agent._skill_mastery(conn, 2, "profile_math", "sC")))

conn.execute("ALTER TABLE skills ADD COLUMN locked INT DEFAULT 0")
conn.execute("INSERT INTO skills VALUES('x1','Закрытая','profile_math',13,1)")
got = agent._weighted_skills(conn, "profile_math", {"x1": 3, "n09_derivative": 1})
check("locked out, unlocked in",
      [s for s, _ in got] == ["n09_derivative"], str(got))

# --- Синхрон с браузерной формулой: константы обязаны совпадать ---
# Дублирование формулы (Python) и оригинала (js/state.js) честно опасно
# ровно одним: кто-то поменяет константу в одном месте и забудет второе.
# Этот тест читает константы из JS и сверяет — разъехались, тест красный.
import re as _re
_state_js = (ROOT / "js" / "state.js").read_text(encoding="utf-8")


def _js_const(name):
    m = _re.search(rf"const\s+{name}\s*=\s*(\d+)", _state_js)
    return int(m.group(1)) if m else None


check("DECAY synced with js", agent.FORECAST_DECAY_DAYS == _js_const("FORECAST_DECAY_DAYS"),
      f"py={agent.FORECAST_DECAY_DAYS} js={_js_const('FORECAST_DECAY_DAYS')}")
check("VOLUME synced with js", agent.FORECAST_FULL_VOLUME == _js_const("FORECAST_FULL_VOLUME"),
      f"py={agent.FORECAST_FULL_VOLUME} js={_js_const('FORECAST_FULL_VOLUME')}")
check("DIAG weight synced with js", agent.FORECAST_DIAGNOSTIC_WEIGHT == _js_const("FORECAST_DIAGNOSTIC_WEIGHT"),
      f"py={agent.FORECAST_DIAGNOSTIC_WEIGHT} js={_js_const('FORECAST_DIAGNOSTIC_WEIGHT')}")
m = _re.search(r"theoryWeight\s*=\s*lessons\.length\s*\?\s*(\d+)", _state_js)
check("THEORY weight synced with js", agent.FORECAST_THEORY_WEIGHT == (int(m.group(1)) if m else None),
      f"py={agent.FORECAST_THEORY_WEIGHT}")

conn.close()
os.unlink(path)
print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
