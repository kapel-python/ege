#!/usr/bin/env python3
"""Журнал квот quota_ledger: пишется всё нужное для разбора лимитов.

Офлайн, temp-БД, без HTTP: трата/возврат/начисление тиками/админка/
доливка Plus/бонус — каждая меняет бакет и оставляет строку
(spend/refund/accrue/admin/topup/bonus/cap/init), откат не оставляет
ничего, чтение отдаёт записи и состояние бакетов.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ["EGE_DB_PATH"] = str(ROOT / "nonexistent-test-only.sqlite3")

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


QL = load("ege_ql_test", "server/quota_ledger.py")
AGENT = load("ege_agent_ql_test", "server/agent.py")
SERVER = load("ege_server_ql_test", "server/server.py")
SUB = load("ege_sub_ql_test", "server/subscription.py")

WINDOW_MS = 8 * 3600 * 1000


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn, path


def seed(conn, uid=1, name="U"):
    now = int(time.time() * 1000)
    conn.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, created_at INT DEFAULT 0)")
    conn.execute("CREATE TABLE user_subjects(user_id INT, subject TEXT, onboarded INT DEFAULT 0, self_level TEXT, goal_id TEXT, state_version INT DEFAULT 0, PRIMARY KEY(user_id,subject))")
    conn.execute("INSERT INTO users(id, name, created_at) VALUES (?,?,?)", (uid, name, now - 10 * 86400000))
    conn.execute("INSERT INTO user_subjects(user_id, subject, onboarded) VALUES (?,?,1)", (uid, "profile_math"))
    conn.commit()


def rows(conn, where="", args=()):
    return conn.execute("SELECT * FROM quota_ledger " + where + " ORDER BY id", args).fetchall()


def only(conn):
    all_rows = rows(conn)
    return [dict(r) for r in all_rows]


# --- 1. Траты и возврат ходов ИИ ---
conn, path = fresh_db()
seed(conn)
check("spend ok", AGENT.agent_quota_reserve(conn, 1) is True)
check("spend again", AGENT.agent_quota_reserve(conn, 1) is True)
got = only(conn)
spends = [r for r in got if r["kind"] == "spend" and r["owner"] == "agent:1"]
check("two spend rows", len(spends) == 2, str(len(spends)))
check("spend chain 10->9->8", spends[0]["count_before"] == 10 and spends[0]["count_after"] == 9
      and spends[1]["count_before"] == 9 and spends[1]["count_after"] == 8, str([(s["count_before"], s["count_after"]) for s in spends]))
check("spend reason/actor", all(s["reason"] == "agent:turn" and s["actor_user_id"] == 1 for s in spends))
check("spend delta/limit", all(s["delta"] == -1 and s["quota_limit"] == 10 for s in spends))
AGENT.agent_quota_refund(conn, 1, reason="agent:turn_fail")
got = only(conn)
refs = [r for r in got if r["kind"] == "refund"]
check("refund row", len(refs) == 1 and refs[0]["delta"] == 1
      and refs[0]["count_before"] == 8 and refs[0]["count_after"] == 9
      and refs[0]["reason"] == "agent:turn_fail", str([(r["count_before"], r["count_after"]) for r in refs]))

# --- 2. Начисление тиком через чтение статуса ---
conn.execute("UPDATE ai_usage SET count=5, timer_ms=?, anchor_ms=? WHERE owner='agent:1'",
             (int(time.time() * 1000) - 9 * 3600000,) * 2)
conn.commit()
before_n = len(only(conn))
st = AGENT.agent_quota_status(conn, 1)
check("status sees 8", st["remaining"] == 8, str(st))
new_rows = only(conn)[before_n:]
acc = [r for r in new_rows if r["kind"] == "accrue"]
check("accrue row +3", len(acc) == 1 and acc[0]["delta"] == 3
      and acc[0]["count_before"] == 5 and acc[0]["count_after"] == 8
      and acc[0]["reason"] == "agent:status", str([(r["delta"], r["count_before"], r["count_after"]) for r in acc]))

# --- 3. Откат не пишет строк ---
conn.execute("UPDATE ai_usage SET count=0 WHERE owner='agent:1'")
conn.commit()
n0 = len(only(conn))
check("reserve fails on empty", AGENT.agent_quota_reserve(conn, 1) is False)
check("no rows on rollback", len(only(conn)) == n0, f"{n0}->{len(only(conn))}")

# --- 4. Админка пишет admin с было/стало и actor ---
res = AGENT.admin_agent_quota_set(conn, 1, {"remaining": 3}, actor=777)
check("admin set remaining", res["remaining"] == 3, str(res))
adm = [r for r in only(conn) if r["kind"] == "admin"]
check("admin row", len(adm) == 1 and adm[0]["count_after"] == 3
      and adm[0]["actor_user_id"] == 777
      and adm[0]["reason"] == "admin:agent_quota", str([(r["count_before"], r["count_after"], r["actor_user_id"]) for r in adm]))
check("admin meta has payload", "remaining" in str(adm[0]["meta_json"]))

# --- 5. Сочинения: трата/возврат/статус через server.py ---
check("essay spend", SERVER.ai_usage_try_reserve(conn, 1, None, None) is not None)
esp = [r for r in only(conn) if r["owner"] == "u:1" and r["kind"] == "spend"]
check("essay spend row 5->4", len(esp) == 1 and esp[0]["count_before"] == 5
      and esp[0]["count_after"] == 4 and esp[0]["reason"] == "essay:check", str(esp))
SERVER.ai_usage_refund(conn, ["u:1"], reason="essay:check_fail")
erf = [r for r in only(conn) if r["owner"] == "u:1" and r["kind"] == "refund"]
check("essay refund row", len(erf) == 1 and erf[0]["count_after"] == 5
      and erf[0]["actor_user_id"] == 1, str(erf))

# --- 6. Срез потолка (cap) ---
conn.execute("UPDATE ai_usage SET count=9, timer_ms=?, anchor_ms=? WHERE owner='u:1'",
             (int(time.time() * 1000),) * 2)
conn.commit()
n0 = len(only(conn))
SERVER.admin_ai_limit_set(conn, 1, {"limit": 5}, actor=777)
caps = [r for r in only(conn)[n0:] if r["kind"] == "cap"]
check("cap row 9->5", len(caps) == 1 and caps[0]["count_before"] == 9
      and caps[0]["count_after"] == 5 and caps[0]["reason"] == "admin:ai_limit", str(caps))
adm2 = [r for r in only(conn)[n0:] if r["kind"] == "admin"]
check("admin summary after cap", len(adm2) == 1 and adm2[0]["actor_user_id"] == 777)

# --- 7. Доливка Plus ---
n0 = len(only(conn))
SUB._top_up_buckets(conn, 1, 10, 50, int(time.time() * 1000),
                     reason="subscription:grant", actor=777)
tops = [r for r in only(conn)[n0:] if r["kind"] == "topup"]
check("topup u+agent", {r["owner"] for r in tops} == {"u:1", "agent:1"}
      and all(r["reason"] == "subscription:grant" and r["actor_user_id"] == 777 for r in tops),
      str([(r["owner"], r["count_before"], r["count_after"]) for r in tops]))
check("topup only up", all(r["delta"] >= 0 for r in tops))

# --- 8. Бонус за долгое ожидание ---
conn.execute("UPDATE ai_usage SET count=4, timer_ms=?, anchor_ms=? WHERE owner='u:1'",
             (int(time.time() * 1000),) * 2)
conn.commit()
bonus = SERVER.ai_timeout_bonus_grant(conn, 1)
bon = [r for r in only(conn) if r["kind"] == "bonus"]
check("bonus granted+logged", bonus.get("granted") is True and len(bon) == 1
      and bon[0]["delta"] == 1 and bon[0]["count_after"] == 5, str(bonus))

# --- 9. Чтение: по пользователю, по бакету, состояние ---
entries = QL.read_entries(conn, user_id=1, limit=200)
check("read by user non-empty", len(entries) >= 10, str(len(entries)))
check("entries newest first", all(entries[i]["id"] >= entries[i + 1]["id"] for i in range(len(entries) - 1)))
check("entries carry product", all(e["product"] in ("agent", "essay") for e in entries))
by_owner = QL.read_entries(conn, owner="agent:1", limit=200)
check("read by owner", len(by_owner) >= 5 and all(e["owner"] == "agent:1" for e in by_owner))
states = QL.read_buckets(conn, ["agent:1", "u:1", "nope:1"])
check("bucket states", states["agent:1"]["count"] == 50 and states["u:1"]["count"] == 5
      and states["nope:1"] is None, str(states))
check("admin_quota_log shape", SERVER.admin_quota_log(conn, 1)["ok"] is True
      and len(SERVER.admin_quota_log(conn, 1)["buckets"]) == 2
      and len(SERVER.admin_quota_log(conn, 1)["entries"]) > 0)
try:
    SERVER.admin_quota_log(conn, 999999)
    check("unknown user KeyError", False)
except KeyError:
    check("unknown user KeyError", True)

# --- 10. Журнал не ломает квоту: битый kind, пустой owner ---
check("bad kind ignored", QL.log_event(conn, owner="agent:1", kind="oops") is None)
check("empty owner ignored", QL.log_event(conn, owner="", kind="spend") is None)
check("ledger table exists", conn.execute(
    "SELECT COUNT(*) c FROM quota_ledger").fetchone()["c"] > 0)

# --- 10a. Чужое авторство обезличивается, а не удаляется ---
conn.execute("INSERT INTO users(id,name,created_at) VALUES(2,'V',0)")
SUB._top_up_buckets(conn, 1, 10, 50, int(time.time() * 1000),
                     reason="subscription:grant", actor=2)
QL.delete_user_traces(conn, 2)
kept = [r for r in QL.read_entries(conn, owner="u:1", limit=500)
        if r["kind"] == "topup" and r["actor_user_id"] is None]
check("actor anonymized, row kept", len(kept) >= 1, str(len(kept)))

# --- 10b. Удаление аккаунта уносит следы ---
QL.delete_user_traces(conn, 1)
left = QL.read_entries(conn, user_id=1, limit=500)
check("own rows gone", len(left) == 0, str(len(left)))
conn.close()
os.unlink(path)
print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
