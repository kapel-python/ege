#!/usr/bin/env python3
"""Заморозка и восстановление серии: статусы, бесплатная оттайка, лимит 3/мес.

Офлайн, temp-БД, без HTTP: активная серия из activity_history, frozen при
пропуске ровно 1 дня (P>=2), lost при 2+ днях, бесплатная оттайка учёбой в
замороженный день (auto-мост, лимит цел), платное восстановление кнопкой
(manual-мосты, 3 раза в месяц на предмет, мосты в длину не считаются),
серия в 1 день не морозится, изоляция лимита по предметам.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import os
import sqlite3
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

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


SERVER = load("ege_server_streak_test", "server/server.py")

A = "profile_math"
B = "russian"


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, created_at INT DEFAULT 0)")
    conn.execute("CREATE TABLE user_subjects(user_id INT, subject TEXT, onboarded INT DEFAULT 0,"
                 " self_level TEXT, goal_id TEXT, state_version INT DEFAULT 0, PRIMARY KEY(user_id,subject))")
    conn.execute("CREATE TABLE user_stats(user_id INT, subject TEXT, xp INT DEFAULT 0, streak INT DEFAULT 0,"
                 " last_active_date TEXT, total_solved INT DEFAULT 0, total_correct INT DEFAULT 0,"
                 " total_time_sec REAL DEFAULT 0, hints_used INT DEFAULT 0, correct_series INT DEFAULT 0,"
                 " best_series INT DEFAULT 0, errors_resolved INT DEFAULT 0, PRIMARY KEY(user_id,subject))")
    conn.execute("CREATE TABLE activity_history(user_id INT, subject TEXT, activity_date TEXT,"
                 " solved INT, correct INT, xp INT, PRIMARY KEY(user_id,subject,activity_date))")
    conn.execute("INSERT INTO users(id, name, created_at) VALUES (1, 'U', 0)")
    conn.commit()
    SERVER.ensure_streak_schema(conn)
    conn.commit()
    return conn, path


def msk_today() -> dt.date:
    return dt.datetime.now(ZoneInfo("Europe/Moscow")).date()


def day(offset: int) -> str:
    return (msk_today() + dt.timedelta(days=offset)).isoformat()


def study(conn, uid, subject, date_s, solved=3):
    conn.execute("INSERT OR REPLACE INTO activity_history(user_id,subject,activity_date,solved,correct,xp)"
                 " VALUES(?,?,?,?,?,?)", (uid, subject, date_s, solved, solved, solved * 10))
    conn.commit()


TODAY = msk_today().isoformat()

# --- 1. Три дня подряд включая сегодня — active 3 ---
conn, path = fresh_db()
for off in (-2, -1, 0):
    study(conn, 1, A, day(off))
st = SERVER.streak_status(conn, 1, A, TODAY)
check("active 3 дня", st["status"] == "active" and st["streak"] == 3, str({k: st[k] for k in ("status", "streak")}))
disp, last = SERVER.streak_display_for_write(conn, 1, A)
check("write active 3", disp == 3 and last == TODAY, f"{disp} {last}")

# --- 2. Пропуск ровно 1 дня (last = сегодня-2, P=3) — frozen ---
conn, path = fresh_db()
for off in (-4, -3, -2):
    study(conn, 1, A, day(off))
st = SERVER.streak_status(conn, 1, A, TODAY)
check("frozen при 1 пропуске", st["status"] == "frozen" and st["streak"] == 3 and st["frozenValue"] == 3,
      str({k: st[k] for k in ("status", "streak", "frozenValue")}))
check("frozen: restore не предлагается", st["canRestore"] is False, str(st["canRestore"]))

# --- 3. Пропуск 2 дней (last = сегодня-3) — lost, можно восстановить ---
conn, path = fresh_db()
for off in (-5, -4, -3):
    study(conn, 1, A, day(off))
st = SERVER.streak_status(conn, 1, A, TODAY)
check("lost при 2 пропусках", st["status"] == "lost" and st["streak"] == 0 and st["frozenValue"] == 3,
      str({k: st[k] for k in ("status", "streak", "frozenValue")}))
check("lost: лимит 3/3", st["canRestore"] is True and st["restoresLeft"] == 3 and st["restoresUsed"] == 0,
      str({k: st[k] for k in ("canRestore", "restoresLeft", "restoresUsed")}))

# --- 4. Восстановление: active 3, last = вчера, журнал +1 ---
conn.execute("BEGIN IMMEDIATE")
st2 = SERVER.streak_restore(conn, 1, A, TODAY)
conn.commit()
check("restore active 3", st2["status"] == "active" and st2["streak"] == 3, str({k: st2[k] for k in ("status", "streak")}))
check("restore: lastActiveDate — реальная учёба", st2["lastActiveDate"] == day(-3), str(st2["lastActiveDate"]))
row = conn.execute("SELECT streak, last_active_date FROM user_stats WHERE user_id=1 AND subject=?", (A,)).fetchone()
check("user_stats после restore", int(row["streak"]) == 3 and row["last_active_date"] == day(-1),
      f"{row['streak']} {row['last_active_date']}")
check("журнал +1", st2["restoresUsed"] == 1 and st2["restoresLeft"] == 2,
      str({k: st2[k] for k in ("restoresUsed", "restoresLeft")}))
bridges = SERVER._streak_bridge_dates(conn, 1, A)
check("мосты покрыли пропуск", bridges == {day(-2), day(-1)}, str(sorted(bridges)))
kinds = {r["bridge_date"]: r["kind"] for r in
         conn.execute("SELECT bridge_date, kind FROM streak_bridges WHERE user_id=1 AND subject=?", (A,))}
check("мосты manual", all(v == "manual" for v in kinds.values()), str(kinds))

# --- 5. Повторный restore при живой серии — отказ, лимит не тратится ---
try:
    conn.execute("BEGIN IMMEDIATE")
    SERVER.streak_restore(conn, 1, A, TODAY)
    conn.commit()
    check("restore при active запрещён", False, "не кинул")
except SERVER.StreakRestoreError as exc:
    try:
        conn.rollback()
    except sqlite3.Error:
        pass
    check("restore при active запрещён", exc.code == "STREAK_ACTIVE", exc.code)
st3 = SERVER.streak_status(conn, 1, A, TODAY)
check("лимит не потрачен отказом", st3["restoresUsed"] == 1, str(st3["restoresUsed"]))

# --- 6. Учёба после restore: серия продолжается 3 -> 4 без раздувания ---
study(conn, 1, A, TODAY)
disp, last = SERVER.streak_display_for_write(conn, 1, A)
check("после restore учёба даёт 4", disp == 4 and last == TODAY, f"{disp} {last}")

# --- 7. Бесплатная оттайка: frozen + учёба сегодня = P+1, auto-мост ---
conn, path = fresh_db()
for off in (-4, -3, -2):
    study(conn, 1, A, day(off))
study(conn, 1, A, day(0))
disp, last = SERVER.streak_display_for_write(conn, 1, A)
check("оттайка даёт 4", disp == 4 and last == TODAY, f"{disp} {last}")
kinds = {r["bridge_date"]: r["kind"] for r in
         conn.execute("SELECT bridge_date, kind FROM streak_bridges WHERE user_id=1 AND subject=?", (A,))}
check("auto-мост за вчера", kinds.get(day(-1)) == "auto", str(kinds))
st4 = SERVER.streak_status(conn, 1, A, TODAY)
check("оттайка не тратит лимит", st4["restoresUsed"] == 0 and st4["status"] == "active", str(st4["status"]))

# --- 8. Серия в 1 день не морозится ---
conn, path = fresh_db()
study(conn, 1, A, day(-2))
st = SERVER.streak_status(conn, 1, A, TODAY)
check("P=1 не frozen", st["status"] == "lost" and st["streak"] == 0, str({k: st[k] for k in ("status", "streak")}))
check("P=1 нечего спасать", st["canRestore"] is False and st["frozenValue"] == 0, str(st["frozenValue"]))

# --- 9. Новый пользователь: тишина, без модалок ---
conn, path = fresh_db()
st = SERVER.streak_status(conn, 1, A, TODAY)
check("пусто = lost 0", st["status"] == "lost" and st["streak"] == 0 and st["canRestore"] is False,
      str({k: st[k] for k in ("status", "streak", "canRestore")}))

# --- 10. Лимит 3/мес: четвёртое восстановление — 429-гейт ---
conn, path = fresh_db()
for off in (-5, -4, -3):
    study(conn, 1, A, day(off))
mk = SERVER.streak_month_key(TODAY)
for i in range(3):
    conn.execute("INSERT INTO streak_restores(user_id,subject,month_key,created_at,restored_value)"
                 " VALUES(?,?,?,?,?)", (1, A, mk, "t", 3))
conn.commit()
st = SERVER.streak_status(conn, 1, A, TODAY)
check("лимит исчерпан виден", st["restoresLeft"] == 0 and st["canRestore"] is False, str(st["restoresLeft"]))
try:
    conn.execute("BEGIN IMMEDIATE")
    SERVER.streak_restore(conn, 1, A, TODAY)
    conn.commit()
    check("4-й restore запрещён", False, "не кинул")
except SERVER.StreakRestoreError as exc:
    try:
        conn.rollback()
    except sqlite3.Error:
        pass
    check("4-й restore запрещён", exc.code == "RESTORE_LIMIT", exc.code)

# --- 11. Лимит на предмет: траты в A не трогают B ---
stB = SERVER.streak_status(conn, 1, B, TODAY)
check("предмет B с чистым лимитом", stB["restoresUsed"] == 0 and stB["restoresLeft"] == 3,
      str({k: stB[k] for k in ("restoresUsed", "restoresLeft")}))

# --- 12. Вчера занимался — active, серия цела ---
conn, path = fresh_db()
for off in (-3, -2, -1):
    study(conn, 1, A, day(off))
st = SERVER.streak_status(conn, 1, A, TODAY)
check("вчера = active 3", st["status"] == "active" and st["streak"] == 3, str({k: st[k] for k in ("status", "streak")}))

# --- 13. refresh_streak пишет display (не падает, мост-устойчив) ---
conn, path = fresh_db()
for off in (-2, -1, 0):
    study(conn, 1, A, day(off))
s, last = SERVER.refresh_streak(conn, 1, A)
conn.commit()
check("refresh_streak 3", s == 3 and last == TODAY, f"{s} {last}")

print(f"\nchecks={checks} failures={failures}")
raise SystemExit(1 if failures else 0)
