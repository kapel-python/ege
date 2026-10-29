#!/usr/bin/env python3
"""Единая теория: интерактивный урок равен обычному (разницы ноль).

Офлайн, temp-БД: _mastery_from_inputs, _compute_forecast, lesson_get (+link),
find_topics (список ilessons), project_info (база знаний), fold_web(skills)
и _plan_has_ilesson из server/agent.py считают оба формата одинаково:
закрыт любой — вся теория 40, второй сверху ничего не добавляет.
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
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)) if detail else ''}")


spec = importlib.util.spec_from_file_location("ege_agent_ilesson_theory", ROOT / "server" / "agent.py")
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
conn.execute("CREATE TABLE ilessons(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, subtitle TEXT, xp INT, metadata_json TEXT)")
conn.execute("CREATE TABLE completed_lessons(user_id INT, subject TEXT, lesson_id TEXT)")
conn.execute("CREATE TABLE completed_ilessons(user_id INT, subject TEXT, ilesson_id TEXT)")
conn.execute("CREATE TABLE tasks(id TEXT PRIMARY KEY, skill_id TEXT)")
conn.execute("CREATE TABLE task_attempts(id INTEGER PRIMARY KEY, user_id INT, subject TEXT, task_id TEXT, skill_id TEXT, correct INT, hint_level INT, created_at INT)")
conn.execute("CREATE TABLE diagnostics(id INTEGER PRIMARY KEY, user_id INT, task_id TEXT, correct INT, created_at INT, subject TEXT)")
now = int(time.time() * 1000)
SUBJ = "profile_math"
# Реальные id из весов profile_math (иначе _compute_forecast не скорит):
# n01 — только классика, n14 — только интерактив, n02 — практика без теории.
conn.execute("INSERT INTO users(id,name,created_at) VALUES(1,'Ученик',?)", (now,))
conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded) VALUES(1,'profile_math',1)")
conn.execute("INSERT INTO skills VALUES('n01_planimetry','Планиметрия','profile_math',1)")
conn.execute("INSERT INTO skills VALUES('n14_trig_eq','Тригонометрия','profile_math',2)")
conn.execute("INSERT INTO skills VALUES('n02_vectors','Векторы','profile_math',3)")
conn.execute("INSERT INTO lessons VALUES('lc-n01','n01_planimetry','Классика','{}')")
conn.execute("INSERT INTO ilessons VALUES('v-t1','n14_trig_eq','Визуал','sub',30,?)",
             ('{"scenes": [{"title": "S1", "text": "идея первая"}, {"title": "S2", "text": "идея вторая"}]}',))
conn.commit()

moment = int(time.time() * 1000)

# --- Освоение: любой формат закрывает теорию целиком ---
data = agent._forecast_inputs(conn, 1, SUBJ, moment)
check("inputs carry ilessons", data["ilessons"].get("n14_trig_eq") == ["v-t1"], data["ilessons"])
check("mastery: untouched is 0", agent._mastery_from_inputs("n14_trig_eq", data, moment) == 0)
check("mastery: classic-only skill untouched is 0", agent._mastery_from_inputs("n01_planimetry", data, moment) == 0)

conn.execute("INSERT INTO completed_ilessons VALUES(1,'profile_math','v-t1')")
conn.commit()
data = agent._forecast_inputs(conn, 1, SUBJ, moment)
check("mastery: interactive-only -> 40", agent._mastery_from_inputs("n14_trig_eq", data, moment) == 40,
      agent._mastery_from_inputs("n14_trig_eq", data, moment))
check("theory_done via interactive", agent._theory_done("n14_trig_eq", data) is True)

conn.execute("INSERT INTO completed_lessons VALUES(1,'profile_math','lc-n01')")
conn.commit()
data = agent._forecast_inputs(conn, 1, SUBJ, moment)
check("mastery: classic -> 40", agent._mastery_from_inputs("n01_planimetry", data, moment) == 40)

# Оба формата на одной теме — всё равно 40, не 80.
conn.execute("INSERT INTO lessons VALUES('lc-n14','n14_trig_eq','Классика-14','{}')")
conn.execute("INSERT INTO completed_lessons VALUES(1,'profile_math','lc-n14')")
conn.commit()
data = agent._forecast_inputs(conn, 1, SUBJ, moment)
check("mastery: both formats still 40", agent._mastery_from_inputs("n14_trig_eq", data, moment) == 40,
      agent._mastery_from_inputs("n14_trig_eq", data, moment))

# --- Порог и покрытие считают интерактив ---
fc = agent._compute_forecast(conn, 1, SUBJ, moment)
check("forecast: ilesson counts toward lesson gate",
      fc.get("doneLessons") == 2 and fc.get("totalLessons") == 2,
      {k: fc.get(k) for k in ("doneLessons", "totalLessons", "covered")})
check("forecast: ilesson skill covered", fc.get("covered", 0) >= 2, fc.get("covered"))

# Полная доступность: третьей теме даём практику (3 верных, mastery 25).
for i in range(3):
    conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
                 " VALUES(1,'profile_math',?,'n02_vectors',1,0,?)", (f"pv{i}", now - i * 60000))
conn.commit()
fc = agent._compute_forecast(conn, 1, SUBJ, moment)
check("forecast available with ilesson theory", fc.get("available") is True, {k: fc.get(k) for k in ("available", "premature", "mid")})
mid_with_ilesson = fc.get("mid")

# Та же картина, но n14 закрыт классикой вместо интерактива: mid обязан совпасть.
conn.execute("DELETE FROM completed_ilessons WHERE user_id=1 AND subject='profile_math'")
conn.commit()
data2 = agent._forecast_inputs(conn, 1, SUBJ, moment)
check("mastery: classic instead of interactive also 40",
      agent._mastery_from_inputs("n14_trig_eq", data2, moment) == 40)
fc2 = agent._compute_forecast(conn, 1, SUBJ, moment)
check("forecast mid equal for either format", fc2.get("available") is True and fc2.get("mid") == mid_with_ilesson,
      (fc2.get("mid"), mid_with_ilesson))

# --- lesson_get отдаёт интерактив ---
conn.execute("INSERT INTO completed_ilessons VALUES(1,'profile_math','v-t1')")
# n15 — только интерактив без классики: фолбэк по skillId.
conn.execute("INSERT INTO skills VALUES('n15_stereometry','Стереометрия','profile_math',4)")
conn.execute("INSERT INTO ilessons VALUES('v-t2','n15_stereometry','Визуал-15','sub',30,?)",
             ('{"scenes": [{"title": "S1", "text": "стерео идея"}]}',))
conn.commit()
out = agent.lesson_get(conn, 1, SUBJ, {"skillId": "n15_stereometry"})
check("lesson_get by skill falls back to interactive",
      out.get("format") == "interactive" and out.get("lessonId") == "v-t2" and "стерео идея" in out.get("text", ""),
      {k: out.get(k) for k in ("format", "lessonId")})
check("lesson_get interactive has student link",
      str(out.get("link", "")).endswith("/dashboard#/ilesson/n15_stereometry?seo_subject=profile_math"),
      out.get("link"))
out = agent.lesson_get(conn, 1, SUBJ, {"lessonId": "v-t1"})
check("lesson_get by ilesson id works", out.get("format") == "interactive" and out.get("skill") == "n14_trig_eq")
out = agent.lesson_get(conn, 1, SUBJ, {"skillId": "n01_planimetry"})
check("lesson_get classic unchanged", out.get("lessonId") == "lc-n01" and "format" not in out, out.get("lessonId"))
check("lesson_get classic has student link",
      str(out.get("link", "")).endswith("/dashboard#/lesson/lc-n01?seo_subject=profile_math"),
      out.get("link"))

# --- find_topics видит интерактивы отдельным списком ---
# Поиску нужна полная форма tasks (topic/exam_number/difficulty) —
# пересоздаём пустую: банк для этих проверок не нужен.
conn.execute("DROP TABLE tasks")
conn.execute("""CREATE TABLE tasks(id TEXT PRIMARY KEY, skill_id TEXT, topic TEXT,
                exam_number TEXT, difficulty INT, statement TEXT, answer TEXT,
                explanation TEXT, hint TEXT, task_type TEXT, metadata_json TEXT)""")
conn.commit()
r = agent.find_topics(conn, 1, SUBJ, {"skillId": "n15_stereometry"})
got_i = r.get("ilessons", [])
check("find_topics pinned: ilesson listed separately",
      [x["id"] for x in got_i] == ["v-t2"] and all(x.get("format") == "interactive" for x in got_i),
      [(x["id"], x.get("format")) for x in got_i])
r = agent.find_topics(conn, 1, SUBJ, {"query": "визуал"})
check("find_topics query hits ilesson title",
      any(x["id"] == "v-t2" for x in r.get("ilessons", [])),
      [(x["id"], x.get("match")) for x in r.get("ilessons", [])])
r = agent.find_topics(conn, 1, SUBJ, {"query": "абракадабра несуществующая"})
check("find_topics garbage: ilessons empty too", r.get("ilessons") == [] and r.get("found") == 0)

# --- project_info знает про интерактивы ---
info = agent.project_info(conn, 1, SUBJ, {"topic": "что за интерактивный урок"})
check("knowledge: interactive section matched",
      "Интерактивные уроки" in str(info.get("matched", "")) and "БЕТА" in info.get("text", ""),
      info.get("matched"))
info_all = agent.project_info(conn, 1, SUBJ, {})
check("knowledge: full text carries interactive", "Интерактивный урок" in info_all.get("text", ""))

# --- fold_web skills: lessonDone через интерактив ---
got = agent.fold_web(conn, 1, SUBJ, {"op": "skills"})
by_id = {s["id"]: s for s in got.get("skills", [])}
check("fold skills: ilesson marks lessonDone",
      by_id.get("n14_trig_eq", {}).get("lessonDone") is True and by_id.get("n14_trig_eq", {}).get("mastery") == 40,
      {k: by_id.get("n14_trig_eq", {}).get(k) for k in ("lessonDone", "mastery")})
check("fold skills: classic still lessonDone", by_id.get("n01_planimetry", {}).get("lessonDone") is True)
check("fold skills: untouched theory false", by_id.get("n02_vectors", {}).get("lessonDone") is False)

# --- план знает про интерактив ---
check("plan has ilesson flag", agent._plan_has_ilesson(conn, "n14_trig_eq") is True)
check("plan no ilesson flag", agent._plan_has_ilesson(conn, "n01_planimetry") is False)

conn.close()
os.unlink(path)
print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
