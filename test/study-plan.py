#!/usr/bin/env python3
"""Учебный план: гибкий черновик, proposal/apply, гейты закрытия тем.

Офлайн, temp-БД: периоды режутся по неделям + хвост днями (день/неделя/
месяц/год — решает days), proposal строг (чужой skillId, не сумма дней —
ValueError для починки моделью), apply пишет план и гасит предыдущий,
закрытие темы — только по времени ИЛИ освоению ≥ 60, полный обход
переводит план в done.
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


spec = importlib.util.spec_from_file_location("ege_agent_plan_test", ROOT / "server" / "agent.py")
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
conn.execute("CREATE TABLE lessons(id TEXT PRIMARY KEY, skill_id TEXT, title TEXT, metadata_json TEXT)")
conn.execute("CREATE TABLE tasks(id TEXT PRIMARY KEY, skill_id TEXT, topic TEXT)")
conn.execute("CREATE TABLE task_attempts(id INTEGER PRIMARY KEY, user_id INT, subject TEXT, task_id TEXT, skill_id TEXT, correct INT, hint_level INT, created_at INT)")
conn.execute("CREATE TABLE user_errors(id INTEGER PRIMARY KEY, user_id INT, subject TEXT, task_id TEXT, skill_id TEXT, topic TEXT, resolved INT, client_id TEXT)")
now = int(time.time() * 1000)
conn.execute("INSERT INTO users(id,name,created_at) VALUES(1,'У',?)", (now - 10 * 86400000,))
conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded) VALUES(1,'profile_math',1)")
conn.execute("INSERT INTO skills VALUES('sk_a','Альфа','profile_math',1)")
conn.execute("INSERT INTO skills VALUES('sk_b','Бета','profile_math',2)")
conn.execute("INSERT INTO skills VALUES('sk_c','Гамма','profile_math',3)")
conn.execute("INSERT INTO skills VALUES('n19_parameter','Параметр','profile_math',4)")
conn.execute("INSERT INTO skills VALUES('n20_numbers','Числа','profile_math',5)")
conn.execute("INSERT INTO skills VALUES('n15_stereometry','Стереометрия','profile_math',6)")
conn.execute("INSERT INTO lessons VALUES('les_a','sk_a','Урок А',NULL)")
conn.execute("INSERT INTO tasks VALUES('t_a1','sk_a','Тема А-1')")
conn.execute("INSERT INTO tasks VALUES('t_a2','sk_a','Тема А-2')")
conn.commit()

# --- 1. Черновик: горизонты ---
d1 = agent.plan_draft(conn, 1, "profile_math", {"days": 1})
check("day: one period", len(d1["periods"]) == 1 and d1["periods"][0]["days"] == 1 and d1["days"] == 1,
      str([(p["label"], p["days"]) for p in d1["periods"]]))
d7 = agent.plan_draft(conn, 1, "profile_math", {"days": 7})
check("week: one Неделя", len(d7["periods"]) == 1 and d7["periods"][0]["label"] == "Неделя 1")
d10 = agent.plan_draft(conn, 1, "profile_math", {"days": 10})
check("10 days: week+tail", [p["days"] for p in d10["periods"]] == [7, 3]
      and d10["periods"][0]["label"] == "Неделя 1", str([(p["label"], p["days"]) for p in d10["periods"]]))
d30 = agent.plan_draft(conn, 1, "profile_math", {"days": 30})
check("month: 4 weeks + 2 days", [p["days"] for p in d30["periods"]] == [7, 7, 7, 7, 2])
check("legacy weeks compat", agent.plan_draft(conn, 1, "profile_math", {"weeks": 2})["days"] == 14)
check("cap 365", agent.plan_draft(conn, 1, "profile_math", {"days": 9999})["days"] == 365)
check("topics carry lesson+tasks",
      agent._plan_lesson_for_skill(conn, "profile_math", "sk_a") == "les_a"
      and agent._plan_tasks_for_skill(conn, 1, "profile_math", "sk_a", 2) == ["t_a1", "t_a2"])

# --- 2. Proposal: строгая проверка ---
prop = agent.propose_action(conn, 1, "profile_math", "plan_apply",
                            {"days": d7["days"], "title": d7["title"], "periods": d7["periods"]})
check("proposal ok", prop["action"] == "plan_apply" and len(prop["periods"]) == 1
      and prop["periods"][0]["topicIds"] and "Применяю план" in prop["label"], str(prop["label"]))
for bad_args, why in [
    ({"days": 7, "periods": []}, "empty"),
    ({"days": 7, "periods": [{"days": 5, "skillIds": ["sk_a"]}]}, "sum mismatch"),
    ({"days": 7, "periods": [{"days": 7, "skillIds": ["nope"]}]}, "bad skill"),
    ({"days": 7, "periods": [{"days": 7, "skillIds": []}]}, "no topics"),
    ({"days": 9999, "periods": [{"days": 7, "skillIds": ["sk_a"]}]}, "bad days"),
]:
    try:
        agent.propose_action(conn, 1, "profile_math", "plan_apply", bad_args)
        check(f"reject {why}", False)
    except ValueError as exc:
        check(f"reject {why}", True, str(exc)[:80])

# --- 3. Apply + замена предыдущего ---
res = agent.apply_action(conn, 1, "profile_math", "plan_apply", prop)
check("applied", res["days"] == 7 and res["planId"] > 0, str(res))
st = agent.study_plan_state(conn, 1, "profile_math")
check("state active", st["active"] is not None and st["active"]["progress"] == {"closed": 0, "total": 2},
      str(st["active"]["progress"] if st["active"] else None))
first_sid = st["active"]["periods"][0]["topics"][0]["skillId"]
check("fresh topic locked", st["active"]["periods"][0]["topics"][0]["closeable"] is False)
prop2 = agent.propose_action(conn, 1, "profile_math", "plan_apply",
                             {"days": 1, "periods": [{"days": 1, "skillIds": ["sk_b"]}]})
check("replace warning", "заменит текущий" in prop2["label"], prop2["label"])
agent.apply_action(conn, 1, "profile_math", "plan_apply", prop2)
st2 = agent.study_plan_state(conn, 1, "profile_math")
check("second apply replaces", st2["active"]["days"] == 1
      and conn.execute("SELECT COUNT(*) c FROM study_plans WHERE status='replaced'").fetchone()["c"] == 1)
only_sid = st2["active"]["periods"][0]["topics"][0]["skillId"]

# --- 4. Гейты закрытия: время и освоение ---
try:
    agent.study_plan_close_topic(conn, 1, "profile_math", only_sid)
    check("locked rejects", False)
except agent.PlanStateError as exc:
    check("locked rejects", exc.code == "LOCKED", exc.code)
# Освоение открывает раньше времени: 12 свежих верных = 100 ≥ 60.
for i in range(12):
    conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
                 " VALUES(1,'profile_math',?,?,1,0,?)", (f"mx{i}", only_sid, now - i * 60000))
conn.commit()
st3 = agent.study_plan_state(conn, 1, "profile_math")
t3 = st3["active"]["periods"][0]["topics"][0]
check("mastered opens early", t3["closeable"] is True and "mastered" in t3["closeReasons"] and t3["mastery"] >= 60,
      str({k: t3[k] for k in ("closeable", "closeReasons", "mastery")}))
out = agent.study_plan_close_topic(conn, 1, "profile_math", only_sid)
check("close advances", out.get("closed") == only_sid and out["active"] is None,
      str(out.get("active")))
check("plan done", conn.execute("SELECT status FROM study_plans ORDER BY id DESC LIMIT 1").fetchone()[0] == "done")
try:
    agent.study_plan_close_topic(conn, 1, "profile_math", only_sid)
    check("no plan after done", False)
except agent.PlanStateError as exc:
    check("no plan after done", exc.code == "NO_PLAN", exc.code)

# --- 5. Временной гейт без освоения ---
prop3 = agent.propose_action(conn, 1, "profile_math", "plan_apply",
                             {"days": 2, "periods": [{"days": 2, "skillIds": ["sk_c"]}]})
agent.apply_action(conn, 1, "profile_math", "plan_apply", prop3)
conn.execute("UPDATE study_plans SET starts_at_ms=? WHERE status='active'", (now - 10 * 86400000,))
conn.commit()
st5 = agent.study_plan_state(conn, 1, "profile_math")
t5 = st5["active"]["periods"][0]["topics"][0]
check("time opens without mastery", t5["closeable"] is True and "time" in t5["closeReasons"]
      and t5["mastered"] is False)
try:
    agent.study_plan_close_topic(conn, 1, "profile_math", "sk_a")
    check("foreign skill rejects", False)
except agent.PlanStateError as exc:
    check("foreign skill rejects", exc.code == "NOT_IN_PLAN", exc.code)

check("threshold is 75", agent.TOPIC_MASTERED_AT == 75)
conn.close()
os.unlink(path)
print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
