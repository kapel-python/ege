#!/usr/bin/env python3
"""Учебный план: гибкий черновик, proposal/apply, гейты закрытия тем.

Офлайн, temp-БД: периоды режутся по неделям + хвост днями (день/неделя/
месяц/год — решает days), proposal строг (чужой skillId, не сумма дней —
ValueError для починки моделью), apply пишет план и гасит предыдущий,
закрытие темы — только по времени ИЛИ освоению ≥ 75, полный обход
переводит план в done.
"""
from __future__ import annotations

import importlib.util
import json
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
# Основной пользователь — Plus: план от ИИ без подписки не создаётся
# (гейт проверяется ниже отдельным бесплатным пользователем).
assert agent._SUB is not None
agent._SUB.admin_grant(conn, 1, "month", note="тест: план от ИИ — Plus")
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
check("draft topics are light (no lesson/task bulk)",
      all(set(t.keys()) <= {"skillId", "name"} for p in d30["periods"] for t in p["topics"]))
d90 = agent.plan_draft(conn, 1, "profile_math", {"days": 90})
p90 = agent._tool_payload(d90)
b90 = json.loads(p90)
check("90-day draft fits context whole",
      len(p90) <= 4000 and "error" not in b90
      and len(b90.get("periods", [])) == len(d90["periods"]))
b365 = json.loads(agent._tool_payload(
    agent.plan_draft(conn, 1, "profile_math", {"days": 365})))
check("365-day draft degrades to partial, not error", "truncated" in b365)

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
st6d = agent.study_plan_state(conn, 1, "profile_math")
check("threshold rides along state", st6d["active"]["masteredAt"] == 75)
# --- 6. Окно темы — конец периода; замок периода — время ИЛИ завершение ---
prop6 = agent.propose_action(conn, 1, "profile_math", "plan_apply",
                             {"days": 14, "periods": [{"days": 7, "skillIds": ["sk_a"]},
                                                       {"days": 7, "skillIds": ["sk_b"]}]})
agent.apply_action(conn, 1, "profile_math", "plan_apply", prop6)
st6 = agent.study_plan_state(conn, 1, "profile_math")
pa, pb = st6["active"]["periods"]
check("periods share one window each",
      pa["topics"][0]["availableAt"] == st6["active"]["startsAt"] + 7 * 86400000
      and pb["topics"][0]["availableAt"] == st6["active"]["startsAt"] + 14 * 86400000)
check("future period locked, current open",
      pa["locked"] is False and pb["locked"] is True)
check("lesson lever present",
      pa["topics"][0]["lessonDone"] is False and pa["topics"][0]["lessonBonus"] == 40,
      str({k: pa["topics"][0][k] for k in ("lessonDone", "lessonBonus")}))
for i in range(12):
    conn.execute("INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,created_at)"
                 " VALUES(1,'profile_math',?,?,1,0,?)", (f"mz{i}", "sk_a", now - i * 60000))
conn.execute("CREATE TABLE IF NOT EXISTS completed_lessons(user_id INT, subject TEXT, lesson_id TEXT)")
conn.execute("INSERT INTO completed_lessons VALUES(1,'profile_math','les_a')")
conn.commit()
agent.study_plan_close_topic(conn, 1, "profile_math", "sk_a")
st6c = agent.study_plan_state(conn, 1, "profile_math")
check("completion unlocks next period early",
      st6c["active"]["periods"][1]["locked"] is False)
agent.apply_action(conn, 1, "profile_math", "plan_apply", prop6)
conn.execute("UPDATE study_plans SET starts_at_ms=? WHERE status='active'", (now - 10 * 86400000,))
conn.commit()
st6b = agent.study_plan_state(conn, 1, "profile_math")
pa6, pb6 = st6b["active"]["periods"]
check("time unlocks future period",
      pb6["locked"] is False and pa6["topics"][0]["closeable"] is True)

# --- 7. plan_get: текущий план для модели ---
check("plan_get in registry",
      "plan_get" in [t["function"]["name"] for t in agent.AGENT_TOOLS]
      and "plan_get" in agent.READ_TOOLS,
      str([t["function"]["name"] for t in agent.AGENT_TOOLS]))
empty_get = agent.plan_get(conn, 1, "russian", {})
check("plan_get empty", empty_get["hasPlan"] is False and empty_get["periods"] == []
      and "plan_draft" in empty_get["note"], str(empty_get)[:160])
check("plan_get dispatch",
      agent.execute_read_tool(conn, 1, "russian", "plan_get", {})["hasPlan"] is False)
full_get = agent.plan_get(conn, 1, "profile_math", {})
st_cur = agent.study_plan_state(conn, 1, "profile_math")
check("plan_get full",
      full_get["hasPlan"] is True and full_get["days"] == st_cur["active"]["days"]
      and full_get["progress"] == st_cur["active"]["progress"]
      and len(full_get["periods"]) == len(st_cur["active"]["periods"])
      and all(set(t) >= {"skillId", "name", "state", "mastery"}
              for p in full_get["periods"] for t in p["topics"]),
      str(full_get["progress"]))
try:
    re_prop = agent.propose_action(conn, 1, "profile_math", "plan_apply",
                                   {"days": full_get["days"], "title": full_get["title"],
                                    "periods": full_get["periods"]})
    check("plan_get periods feed plan_apply", re_prop["days"] == full_get["days"]
          and len(re_prop["periods"]) == len(full_get["periods"]))
except ValueError as exc:
    check("plan_get periods feed plan_apply", False, str(exc)[:120])
check("plan_get step human",
      agent.describe_step("plan_get", {}, full_get).startswith("Смотрю текущий план")
      and "sk_" not in agent.describe_step("plan_get", {}, full_get)
      and agent.describe_step("plan_get", {}, empty_get) == "Проверяю текущий учебный план")
ctx_empty = agent.turn_context(conn, 1, "russian")
ctx_full = agent.turn_context(conn, 1, "profile_math")
check("context no plan", "Учебного плана пока нет, но он есть в другом предмете" in ctx_empty
      and "Профильная математика" in ctx_empty, " | ".join(ctx_empty.splitlines()[-2:]))
check("context has plan",
      "Учебный план есть:" in ctx_full and "plan_get" in ctx_full, " | ".join(ctx_full.splitlines()[-3:]))
big = dict(full_get)
big["periods"] = full_get["periods"] * 30
pay = agent._tool_payload(big)
try:
    parsed = json.loads(pay)
    check("plan_get payload trims valid",
          len(pay) <= 4000 and isinstance(parsed.get("periods"), list)
          and parsed.get("truncated", {}).get("field") == "periods")
except ValueError:
    check("plan_get payload trims valid", False, pay[:80])
# --- 8. План в соседнем предмете: «у меня есть план?» без уточнения ---
# Живой случай: план в обществе, вопрос из математики → «плана нет — чистый
# лист» при живом плане. plan_get и контекст обязаны назвать другой предмет.
conn.execute("INSERT INTO study_plans(user_id,subject,title,days_total,starts_at_ms,status,created_at_ms,periods_json)"
             " VALUES(1,'russian','План Р',7,?,'active',?,?)",
             (now, now, json.dumps([{"index": 0, "label": "Неделя 1", "days": 7,
                                          "topics": [{"skillId": "sk_a", "name": "Альфа"}]}])))
rid = conn.execute("SELECT id FROM study_plans WHERE user_id=1 AND subject='russian'").fetchone()["id"]
conn.execute("INSERT INTO study_plan_topics(plan_id,period_idx,skill_id,state) VALUES(?,?,?,'open')",
             (rid, 0, "sk_a"))
conn.commit()
other_get = agent.plan_get(conn, 1, "society", {})
check("plan_get other subject",
      other_get["hasPlan"] is False and other_get.get("otherSubject") is True
      and any(p["subject"] == "russian" and p["subjectTitle"] == "Русский язык"
              and p["progress"] == {"closed": 0, "total": 1}
              for p in (other_get.get("otherPlans") or []))
      and "школе" in other_get["note"] and "План Р" in other_get["note"],
      str(other_get.get("otherPlans")))
check("plan_get current wins",
      "otherPlans" not in full_get and full_get["hasPlan"] is True)
ctx_other = agent.turn_context(conn, 1, "society")
check("context other subject",
      "есть в другом предмете" in ctx_other and "Русский язык" in ctx_other,
      " | ".join(ctx_other.splitlines()[-3:-1]))

# --- 9. План от ИИ: создание только с Plus ---
# Бесплатный (id 2): инструментов создания плана у модели нет, а прямой вызов
# упирается в жёсткую проверку. plan_get (просмотр) остаётся бесплатным.
conn.execute("INSERT INTO users(id,name,created_at) VALUES(2,'Ф',?)", (now - 86400000,))
conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded) VALUES(2,'profile_math',1)")
conn.commit()
check("доступ к плану: Plus true, бесплатный false",
      agent.plan_access_allowed(conn, 1) is True and agent.plan_access_allowed(conn, 2) is False)
for call_name, fn in (
    ("plan_draft", lambda: agent.execute_read_tool(conn, 2, "profile_math", "plan_draft", {"days": 7})),
    ("plan_apply (propose)", lambda: agent.propose_action(
        conn, 2, "profile_math", "plan_apply",
        {"days": 7, "periods": [{"days": 7, "skillIds": ["sk_a"]}]})),
    ("plan_apply (apply)", lambda: agent.apply_action(conn, 2, "profile_math", "plan_apply", {})),
):
    try:
        fn()
        check(f"бесплатный: {call_name} отклонён", False, "вызов прошёл")
    except ValueError as exc:
        check(f"бесплатный: {call_name} отклонён с текстом про Plus",
              "Plus" in str(exc), str(exc)[:120])
check("бесплатный: plan_get доступен",
      agent.execute_read_tool(conn, 2, "russian", "plan_get", {})["hasPlan"] is False)
ctx_free = agent.turn_context(conn, 2, "profile_math")
check("бесплатный: контекст говорит про Plus и plan_draft",
      "Тариф ученика: бесплатный" in ctx_free and "plan_draft" in ctx_free,
      ctx_free[-160:])
check("Plus: в контексте нет строки про бесплатный тариф",
      "Тариф ученика: бесплатный" not in agent.turn_context(conn, 1, "profile_math"))
seen = {}


def capture(messages, tools, budget=None):
    seen["tools"] = [t.get("function", {}).get("name") for t in tools]
    return {"text": "ок", "tool_calls": []}


agent.run_cycle(conn, 2, "profile_math", [{"role": "user", "content": "план"}], capture,
                deadline=time.monotonic() + 10)
check("бесплатный: модель не получает plan_draft/plan_apply",
      "plan_draft" not in seen["tools"] and "plan_apply" not in seen["tools"]
      and "plan_get" in seen["tools"], str(seen["tools"]))
agent.run_cycle(conn, 1, "profile_math", [{"role": "user", "content": "план"}], capture,
                deadline=time.monotonic() + 10)
check("Plus: модель получает инструменты плана",
      "plan_draft" in seen["tools"] and "plan_apply" in seen["tools"], str(seen["tools"]))

conn.close()
os.unlink(path)
print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
