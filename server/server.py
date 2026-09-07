#!/usr/bin/env python3
"""Small production backend for EGE CORE.

The browser talks only to this service. SQLite is the source of truth for the
account, learning history and progress; catalog content is installed into the
same database on first start.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("EGE_DB_PATH", str(ROOT / "server" / "ege.sqlite3")))
CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  onboarded INTEGER NOT NULL DEFAULT 0,
  self_level TEXT,
  goal_id TEXT
);
CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, short TEXT);
CREATE TABLE IF NOT EXISTS math_levels (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), name TEXT NOT NULL, short TEXT);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), level_id TEXT NOT NULL REFERENCES math_levels(id),
  name TEXT NOT NULL, display_order INTEGER NOT NULL, ege TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), topic TEXT NOT NULL, exam_number TEXT,
  difficulty INTEGER NOT NULL, statement TEXT NOT NULL, answer TEXT NOT NULL, explanation TEXT NOT NULL,
  hint TEXT, task_type TEXT NOT NULL DEFAULT 'short_answer', metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), title TEXT NOT NULL,
  xp INTEGER NOT NULL, metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id), title TEXT NOT NULL, description TEXT NOT NULL,
  xp INTEGER NOT NULL, difficulty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_tasks (
  mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT NOT NULL REFERENCES tasks(id), display_order INTEGER NOT NULL,
  PRIMARY KEY (mission_id, task_id)
);
CREATE TABLE IF NOT EXISTS bosses (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), title TEXT NOT NULL, description TEXT NOT NULL,
  task_count INTEGER NOT NULL, xp INTEGER NOT NULL, unlock_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_stats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, xp INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT, total_solved INTEGER NOT NULL DEFAULT 0, total_correct INTEGER NOT NULL DEFAULT 0,
  total_time_sec REAL NOT NULL DEFAULT 0, hints_used INTEGER NOT NULL DEFAULT 0, correct_series INTEGER NOT NULL DEFAULT 0,
  best_series INTEGER NOT NULL DEFAULT 0, errors_resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_hint_levels (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, level INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, level));
CREATE TABLE IF NOT EXISTS user_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, skill_id TEXT NOT NULL REFERENCES skills(id),
  progress INTEGER NOT NULL DEFAULT 0, solved INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, time_sec REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, skill_id)
);
CREATE TABLE IF NOT EXISTS task_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id),
  skill_id TEXT NOT NULL REFERENCES skills(id), correct INTEGER NOT NULL, hint_level INTEGER NOT NULL, seconds REAL NOT NULL,
  closes_task_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id),
  skill_id TEXT NOT NULL REFERENCES skills(id), topic TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lesson_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES lessons(id),
  completed INTEGER NOT NULL, first_completion INTEGER NOT NULL, xp INTEGER NOT NULL, wrong_attempts INTEGER NOT NULL, duration_sec REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson_step_errors (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES lessons(id), step_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id), count INTEGER NOT NULL, last_at TEXT NOT NULL, types_json TEXT NOT NULL,
  PRIMARY KEY(user_id, lesson_id, step_id)
);
CREATE TABLE IF NOT EXISTS lesson_error_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES lessons(id),
  step_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES skills(id), error_type TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES lessons(id),
  session_json TEXT NOT NULL, PRIMARY KEY(user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS completed_lessons (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES lessons(id), completed_at TEXT NOT NULL,
  PRIMARY KEY(user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS user_missions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mission_id TEXT NOT NULL REFERENCES missions(id), progress INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT, PRIMARY KEY(user_id, mission_id)
);
CREATE TABLE IF NOT EXISTS user_bosses (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, boss_id TEXT NOT NULL REFERENCES bosses(id), defeated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, boss_id)
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, achievement_id TEXT NOT NULL REFERENCES achievements(id), unlocked_at TEXT NOT NULL,
  PRIMARY KEY(user_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS activity_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, activity_date TEXT NOT NULL, solved INTEGER NOT NULL, correct INTEGER NOT NULL, xp INTEGER NOT NULL,
  PRIMARY KEY(user_id, activity_date)
);
CREATE TABLE IF NOT EXISTS forecast_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, snapshot_date TEXT NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL, mid INTEGER NOT NULL,
  PRIMARY KEY(user_id, snapshot_date)
);
CREATE TABLE IF NOT EXISTS daily_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, progress_date TEXT NOT NULL, solved INTEGER NOT NULL, done INTEGER NOT NULL,
  PRIMARY KEY(user_id, progress_date)
);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id), correct INTEGER NOT NULL, created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return str(int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000))


def timestamp_value(value):
    """Return the numeric timestamp expected by the existing UI."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value)
    if text.isdigit():
        return int(text)
    try:
        return int(dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return value


def today() -> str:
    return dt.date.today().isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def install_catalog(conn: sqlite3.Connection) -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    conn.executescript(SCHEMA)
    conn.execute("INSERT OR IGNORE INTO subjects(id, name, short) VALUES ('math', 'Математика', 'Математика')")
    conn.execute("INSERT OR IGNORE INTO math_levels(id, subject_id, name) VALUES ('basic', 'math', 'Базовый уровень')")
    conn.execute("INSERT OR IGNORE INTO math_levels(id, subject_id, name) VALUES ('profile', 'math', 'Профильный уровень')")
    for cat in catalog["categories"]:
        conn.execute("INSERT OR IGNORE INTO topics(id, subject_id, name, short) VALUES (?, 'math', ?, ?)", (cat["id"], cat["name"], cat.get("short")))
    for skill in catalog["skills"]:
        conn.execute("""INSERT OR IGNORE INTO skills(id, topic_id, level_id, name, display_order, ege)
                       VALUES (?, ?, 'profile', ?, ?, ?)""", (skill["id"], skill["cat"], skill["name"], skill["order"], skill.get("ege")))
    for task in catalog["tasks"]:
        metadata = dict(task)
        for key in ("id", "skill", "sub", "num", "diff", "text", "answer", "hint", "solution"):
            metadata.pop(key, None)
        conn.execute("""INSERT OR IGNORE INTO tasks
          (id, skill_id, topic, exam_number, difficulty, statement, answer, explanation, hint, task_type, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            task["id"], task["skill"], task["sub"], task.get("num"), task["diff"], task["text"], task["answer"],
            task["solution"], task.get("hint"), task.get("type", "short_answer"), json.dumps(metadata, ensure_ascii=False)))
    for lesson in catalog["lessons"]:
        conn.execute("INSERT OR IGNORE INTO lessons(id, skill_id, title, xp, metadata_json) VALUES (?, ?, ?, ?, ?)",
                     (lesson["id"], lesson["skill"], lesson["title"], lesson.get("xp", 0), json.dumps(lesson, ensure_ascii=False)))
    for mission in catalog["missions"]:
        conn.execute("INSERT OR IGNORE INTO missions(id, skill_id, title, description, xp, difficulty) VALUES (?, ?, ?, ?, ?, ?)",
                     (mission["id"], mission["skill"], mission["title"], mission["desc"], mission["xp"], mission["diff"]))
        for order, task_id in enumerate(mission["tasks"]):
            conn.execute("INSERT OR IGNORE INTO mission_tasks(mission_id, task_id, display_order) VALUES (?, ?, ?)", (mission["id"], task_id, order))
    for boss in catalog["bosses"]:
        conn.execute("INSERT OR IGNORE INTO bosses(id, topic_id, title, description, task_count, xp, unlock_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (boss["id"], boss["cat"], boss["title"], boss["desc"], boss["size"], boss["xp"], boss["unlockAt"]))
    for achievement in catalog["achievements"]:
        conn.execute("INSERT OR IGNORE INTO achievements(id, name, description, icon) VALUES (?, ?, ?, ?)",
                     (achievement["id"], achievement["name"], achievement["desc"], achievement["icon"]))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('daily', ?)", (json.dumps(catalog["daily"], ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('goals', ?)", (json.dumps(catalog["goals"], ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('diagnosticTasks', ?)", (json.dumps(catalog["diagnosticTasks"], ensure_ascii=False),))
    conn.commit()


def catalog_payload(conn: sqlite3.Connection) -> dict:
    categories = [dict(r) for r in conn.execute("SELECT id, name, short FROM topics ORDER BY rowid")]
    skills = [{"id": r["id"], "name": r["name"], "cat": r["topic_id"], "order": r["display_order"], "ege": r["ege"]}
              for r in conn.execute("SELECT id, name, topic_id, display_order, ege FROM skills ORDER BY topic_id, display_order")]
    tasks = []
    for r in conn.execute("SELECT * FROM tasks ORDER BY id"):
        item = {"id": r["id"], "skill": r["skill_id"], "sub": r["topic"], "num": r["exam_number"], "diff": r["difficulty"],
                "text": r["statement"], "answer": r["answer"], "hint": r["hint"], "solution": r["explanation"]}
        item.update(json.loads(r["metadata_json"] or "{}"))
        tasks.append(item)
    lessons = [json.loads(r["metadata_json"]) for r in conn.execute("SELECT metadata_json FROM lessons ORDER BY id")]
    missions = []
    for r in conn.execute("SELECT * FROM missions ORDER BY id"):
        tasks_for_mission = [x["task_id"] for x in conn.execute("SELECT task_id FROM mission_tasks WHERE mission_id=? ORDER BY display_order", (r["id"],))]
        missions.append({"id": r["id"], "title": r["title"], "desc": r["description"], "skill": r["skill_id"], "tasks": tasks_for_mission, "xp": r["xp"], "diff": r["difficulty"]})
    bosses = [{"id": r["id"], "title": r["title"], "cat": r["topic_id"], "desc": r["description"], "size": r["task_count"], "xp": r["xp"], "unlockAt": r["unlock_at"]}
              for r in conn.execute("SELECT * FROM bosses ORDER BY id")]
    achievements = [{"id": r["id"], "name": r["name"], "desc": r["description"], "icon": r["icon"]}
                    for r in conn.execute("SELECT * FROM achievements ORDER BY rowid")]
    config = {r["key"]: json.loads(r["value_json"]) for r in conn.execute("SELECT key, value_json FROM app_config")}
    return {"categories": categories, "skills": skills, "tasks": tasks, "lessons": lessons, "missions": missions,
            "bosses": bosses, "achievements": achievements, "daily": config["daily"], "goals": config["goals"],
            "diagnosticTasks": config["diagnosticTasks"]}


def user_for(conn: sqlite3.Connection, handler: BaseHTTPRequestHandler) -> tuple[int, str | None]:
    jar = cookies.SimpleCookie(handler.headers.get("Cookie", ""))
    token = jar.get("ege_session")
    token_value = token.value if token else None
    row = conn.execute("SELECT id FROM users WHERE session_token=?", (token_value,)).fetchone() if token_value else None
    if row:
        return row["id"], None
    new_token = token_urlsafe(32)
    cur = conn.execute("INSERT INTO users(session_token, created_at) VALUES (?, ?)", (new_token, now_iso()))
    user_id = cur.lastrowid
    conn.execute("INSERT INTO user_stats(user_id) VALUES (?)", (user_id,))
    conn.commit()
    return user_id, new_token


def default_state(conn: sqlite3.Connection, user_id: int) -> dict:
    skills = {r["id"]: {"progress": 0, "solved": 0, "correct": 0, "timeSec": 0} for r in conn.execute("SELECT id FROM skills")}
    return {"version": 4, "onboarded": False, "goal": None, "selfLevel": None, "xp": 0, "streak": 0, "lastActiveDate": None,
            "totalSolved": 0, "totalCorrect": 0, "totalTimeSec": 0, "hintsUsed": 0, "hintLevels": {"1": 0, "2": 0, "3": 0},
            "correctSeries": 0, "bestSeries": 0, "errorsResolved": 0, "bossesDefeated": [], "missionsDone": {}, "missionProgress": {},
            "achievements": {}, "errors": [], "lessonStepErrors": {}, "lessonErrorHistory": [], "lessonSessions": {},
            "completedLessons": {}, "lessonAttempts": [], "taskAttempts": [], "diagnostics": [], "forecastHistory": [], "activity": {},
            "timeline": [], "daily": {"date": None, "solved": 0, "done": False}, "skillStats": skills}


def read_state(conn: sqlite3.Connection, user_id: int) -> dict:
    state = default_state(conn, user_id)
    user = conn.execute("SELECT onboarded, self_level, goal_id FROM users WHERE id=?", (user_id,)).fetchone()
    stats = conn.execute("SELECT * FROM user_stats WHERE user_id=?", (user_id,)).fetchone()
    if user:
        state.update({"onboarded": bool(user["onboarded"]), "selfLevel": user["self_level"], "goal": user["goal_id"]})
    if stats:
        state.update({"xp": stats["xp"], "streak": stats["streak"], "lastActiveDate": stats["last_active_date"], "totalSolved": stats["total_solved"],
                      "totalCorrect": stats["total_correct"], "totalTimeSec": stats["total_time_sec"], "hintsUsed": stats["hints_used"],
                      "correctSeries": stats["correct_series"], "bestSeries": stats["best_series"], "errorsResolved": stats["errors_resolved"]})
    state["hintLevels"] = {str(i): 0 for i in range(1, 4)}
    for r in conn.execute("SELECT level, used_count FROM user_hint_levels WHERE user_id=?", (user_id,)): state["hintLevels"][str(r["level"])] = r["used_count"]
    for r in conn.execute("SELECT * FROM user_progress WHERE user_id=?", (user_id,)):
        state["skillStats"][r["skill_id"]] = {"progress": r["progress"], "solved": r["solved"], "correct": r["correct"], "timeSec": r["time_sec"]}
    for r in conn.execute("SELECT * FROM user_errors WHERE user_id=? ORDER BY id DESC", (user_id,)):
        state["errors"].append({"id": r["id"], "taskId": r["task_id"], "skill": r["skill_id"], "sub": r["topic"], "ts": timestamp_value(r["created_at"]), "resolved": bool(r["resolved"])})
    for r in conn.execute("SELECT * FROM task_attempts WHERE user_id=? ORDER BY id DESC LIMIT 5000", (user_id,)):
        state["taskAttempts"].append({"taskId": r["task_id"], "skill": r["skill_id"], "correct": bool(r["correct"]), "hintLevel": r["hint_level"], "seconds": r["seconds"], "closesTaskId": r["closes_task_id"], "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT * FROM lesson_step_errors WHERE user_id=?", (user_id,)):
        state["lessonStepErrors"][f'{r["lesson_id"]}:{r["step_id"]}'] = {"count": r["count"], "skill": r["skill_id"], "ts": timestamp_value(r["last_at"]), "types": json.loads(r["types_json"])}
    for r in conn.execute("SELECT lesson_id, step_id, skill_id, error_type, created_at FROM lesson_error_history WHERE user_id=? ORDER BY id DESC LIMIT 200", (user_id,)):
        state["lessonErrorHistory"].append({"lessonId": r["lesson_id"], "stepId": r["step_id"], "skill": r["skill_id"], "type": r["error_type"], "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT lesson_id, session_json FROM lesson_sessions WHERE user_id=?", (user_id,)): state["lessonSessions"][r["lesson_id"]] = json.loads(r["session_json"])
    for r in conn.execute("SELECT lesson_id, completed_at FROM completed_lessons WHERE user_id=?", (user_id,)): state["completedLessons"][r["lesson_id"]] = {"ts": timestamp_value(r["completed_at"])}
    for r in conn.execute("SELECT * FROM lesson_attempts WHERE user_id=? ORDER BY id DESC LIMIT 1000", (user_id,)):
        state["lessonAttempts"].append({"lessonId": r["lesson_id"], "completed": bool(r["completed"]), "firstCompletion": bool(r["first_completion"]), "xp": r["xp"], "wrongAttempts": r["wrong_attempts"], "durationSec": r["duration_sec"], "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT * FROM user_missions WHERE user_id=?", (user_id,)):
        state["missionProgress"][r["mission_id"]] = r["progress"]
        if r["completed_at"]: state["missionsDone"][r["mission_id"]] = {"ts": timestamp_value(r["completed_at"])}
    state["bossesDefeated"] = [r["boss_id"] for r in conn.execute("SELECT boss_id FROM user_bosses WHERE user_id=?", (user_id,))]
    for r in conn.execute("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id=?", (user_id,)): state["achievements"][r["achievement_id"]] = {"ts": timestamp_value(r["unlocked_at"])}
    for r in conn.execute("SELECT * FROM activity_history WHERE user_id=?", (user_id,)): state["activity"][r["activity_date"]] = {"solved": r["solved"], "correct": r["correct"], "xp": r["xp"]}
    state["forecastHistory"] = [dict(date=r["snapshot_date"], low=r["low"], high=r["high"], mid=r["mid"]) for r in conn.execute("SELECT * FROM forecast_history WHERE user_id=? ORDER BY snapshot_date", (user_id,))]
    daily = conn.execute("SELECT * FROM daily_progress WHERE user_id=? ORDER BY progress_date DESC LIMIT 1", (user_id,)).fetchone()
    if daily: state["daily"] = {"date": daily["progress_date"], "solved": daily["solved"], "done": bool(daily["done"])}
    state["timeline"] = [{"ts": timestamp_value(r["created_at"]), "text": r["text"]} for r in conn.execute("SELECT created_at, text FROM timeline WHERE user_id=? ORDER BY id DESC LIMIT 40", (user_id,))]
    state["diagnostics"] = [{"taskId": r["task_id"], "correct": bool(r["correct"]), "ts": timestamp_value(r["created_at"])} for r in conn.execute("SELECT * FROM diagnostics WHERE user_id=? ORDER BY id DESC", (user_id,))]
    return state


def write_state(conn: sqlite3.Connection, user_id: int, state: dict) -> None:
    # The API accepts only a state snapshot produced by the application logic;
    # all durable collections are written to their normalized tables in one transaction.
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills")}
    conn.execute("UPDATE users SET onboarded=?, self_level=?, goal_id=? WHERE id=?", (int(bool(state.get("onboarded"))), state.get("selfLevel"), state.get("goal"), user_id))
    s = state
    conn.execute("""INSERT INTO user_stats(user_id,xp,streak,last_active_date,total_solved,total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET xp=excluded.xp,streak=excluded.streak,last_active_date=excluded.last_active_date,total_solved=excluded.total_solved,total_correct=excluded.total_correct,total_time_sec=excluded.total_time_sec,hints_used=excluded.hints_used,correct_series=excluded.correct_series,best_series=excluded.best_series,errors_resolved=excluded.errors_resolved""",
                 (user_id, int(s.get("xp", 0)), int(s.get("streak", 0)), s.get("lastActiveDate"), int(s.get("totalSolved", 0)), int(s.get("totalCorrect", 0)), float(s.get("totalTimeSec", 0)), int(s.get("hintsUsed", 0)), int(s.get("correctSeries", 0)), int(s.get("bestSeries", 0)), int(s.get("errorsResolved", 0))))
    for table in ("user_progress", "user_hint_levels", "user_errors", "task_attempts", "lesson_attempts", "lesson_step_errors", "lesson_error_history", "lesson_sessions", "completed_lessons", "user_missions", "user_bosses", "user_achievements", "activity_history", "forecast_history", "daily_progress", "timeline", "diagnostics"):
        conn.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
    for skill_id, value in (s.get("skillStats") or {}).items():
        if skill_id in valid_skills:
            conn.execute("INSERT INTO user_progress VALUES (?,?,?,?,?,?)", (user_id, skill_id, int(value.get("progress", 0)), int(value.get("solved", 0)), int(value.get("correct", 0)), float(value.get("timeSec", 0))))
    for level, count in (s.get("hintLevels") or {}).items(): conn.execute("INSERT INTO user_hint_levels VALUES (?,?,?)", (user_id, int(level), int(count)))
    task_ids = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
    for item in s.get("taskAttempts") or []:
        if item.get("taskId") in task_ids:
            conn.execute("INSERT INTO task_attempts(user_id,task_id,skill_id,correct,hint_level,seconds,closes_task_id,created_at) VALUES(?,?,?,?,?,?,?,?)", (user_id, item["taskId"], item.get("skill", ""), int(bool(item.get("correct"))), int(item.get("hintLevel", 0)), float(item.get("seconds", 0)), item.get("closesTaskId"), item.get("ts") or now_iso()))
    for item in s.get("errors") or []:
        if item.get("taskId") in task_ids:
            conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved) VALUES(?,?,?,?,?,?)", (user_id, item["taskId"], item.get("skill", ""), item.get("sub", ""), item.get("ts") or now_iso(), int(bool(item.get("resolved")))))
    lesson_ids = {r["id"] for r in conn.execute("SELECT id FROM lessons")}
    for item in s.get("lessonAttempts") or []:
        if item.get("lessonId") in lesson_ids: conn.execute("INSERT INTO lesson_attempts(user_id,lesson_id,completed,first_completion,xp,wrong_attempts,duration_sec,created_at) VALUES(?,?,?,?,?,?,?,?)", (user_id,item["lessonId"],int(bool(item.get("completed", True))),int(bool(item.get("firstCompletion"))),int(item.get("xp",0)),int(item.get("wrongAttempts",0)),float(item.get("durationSec",0)),item.get("ts") or now_iso()))
    for key, item in (s.get("lessonStepErrors") or {}).items():
        lesson_id, step_id = key.split(":", 1)
        if lesson_id in lesson_ids: conn.execute("INSERT INTO lesson_step_errors VALUES(?,?,?,?,?,?,?)", (user_id,lesson_id,step_id,item.get("skill", ""),int(item.get("count",0)),item.get("ts") or now_iso(),json.dumps(item.get("types",{}),ensure_ascii=False)))
    for item in s.get("lessonErrorHistory") or []:
        if item.get("lessonId") in lesson_ids: conn.execute("INSERT INTO lesson_error_history(user_id,lesson_id,step_id,skill_id,error_type,created_at) VALUES(?,?,?,?,?,?)", (user_id,item["lessonId"],item["stepId"],item.get("skill", ""),item.get("type", ""),item.get("ts") or now_iso()))
    for lesson_id, item in (s.get("lessonSessions") or {}).items():
        if lesson_id in lesson_ids: conn.execute("INSERT INTO lesson_sessions VALUES(?,?,?)", (user_id,lesson_id,json.dumps(item,ensure_ascii=False)))
    for lesson_id, item in (s.get("completedLessons") or {}).items():
        if lesson_id in lesson_ids: conn.execute("INSERT INTO completed_lessons VALUES(?,?,?)", (user_id,lesson_id,item.get("ts") or now_iso()))
    mission_ids = {r["id"] for r in conn.execute("SELECT id FROM missions")}
    for mission_id, progress in (s.get("missionProgress") or {}).items():
        if mission_id in mission_ids: conn.execute("INSERT INTO user_missions(user_id,mission_id,progress,completed_at) VALUES(?,?,?,?)", (user_id,mission_id,int(progress or 0),(s.get("missionsDone") or {}).get(mission_id,{}).get("ts")))
    for boss_id in s.get("bossesDefeated") or []: conn.execute("INSERT INTO user_bosses VALUES(?,?,?)", (user_id,boss_id,now_iso()))
    for achievement_id, item in (s.get("achievements") or {}).items(): conn.execute("INSERT INTO user_achievements VALUES(?,?,?)", (user_id,achievement_id,item.get("ts") or now_iso()))
    for activity_date, value in (s.get("activity") or {}).items(): conn.execute("INSERT INTO activity_history VALUES(?,?,?,?,?)", (user_id,activity_date,int(value.get("solved",0)),int(value.get("correct",0)),int(value.get("xp",0))))
    for item in s.get("forecastHistory") or []: conn.execute("INSERT INTO forecast_history VALUES(?,?,?,?,?)", (user_id,item["date"],int(item["low"]),int(item["high"]),int(item["mid"])))
    daily = s.get("daily") or {}
    if daily.get("date"): conn.execute("INSERT INTO daily_progress VALUES(?,?,?,?)", (user_id,daily["date"],int(daily.get("solved",0)),int(bool(daily.get("done")))))
    for item in s.get("timeline") or []: conn.execute("INSERT INTO timeline(user_id,created_at,text) VALUES(?,?,?)", (user_id,item.get("ts") or now_iso(),item.get("text", "")))
    for item in s.get("diagnostics") or []:
        if item.get("taskId") in task_ids: conn.execute("INSERT INTO diagnostics(user_id,task_id,correct,created_at) VALUES(?,?,?,?)", (user_id,item["taskId"],int(bool(item.get("correct"))),item.get("ts") or now_iso()))


def validate_state(conn: sqlite3.Connection, state: dict) -> None:
    if not isinstance(state, dict): raise ValueError("state must be an object")
    for key in ("xp", "streak", "totalSolved", "totalCorrect", "totalTimeSec", "hintsUsed", "correctSeries", "bestSeries", "errorsResolved"):
        value = state.get(key, 0)
        if not isinstance(value, (int, float)) or value < 0: raise ValueError(f"invalid {key}")
    if state.get("totalCorrect", 0) > state.get("totalSolved", 0): raise ValueError("correct answers exceed attempts")
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills")}
    for skill_id, value in (state.get("skillStats") or {}).items():
        if skill_id not in valid_skills: raise ValueError(f"unknown skill: {skill_id}")
        if not isinstance(value, dict) or not 0 <= float(value.get("progress", 0)) <= 100: raise ValueError(f"invalid progress: {skill_id}")
    valid_tasks = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
    for item in state.get("taskAttempts") or []:
        if item.get("taskId") not in valid_tasks or item.get("skill") not in valid_skills: raise ValueError("invalid task attempt")
    if not isinstance(state.get("errors", []), list): raise ValueError("errors must be an array")


class Handler(BaseHTTPRequestHandler):
    server_version = "EGECore/1.0"

    def send_json(self, payload: dict, status: int = 200, token: str | None = None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if token: self.send_header("Set-Cookie", f"ege_session={token}; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0")); return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            conn = connect()
            try:
                user_id, token = user_for(conn, self)
                if path == "/api/bootstrap": self.send_json({"catalog": catalog_payload(conn), "state": read_state(conn, user_id)}, token=token); return
                self.send_json({"error": "Not found"}, 404); return
            finally: conn.close()
        if path == '/':
            file_path = ROOT / "main.html"
        elif path == '/dashboard':
            file_path = ROOT / "index.html"
        else:
            file_path = (ROOT / path.lstrip("/")).resolve() if path != "/" else ROOT / "index.html"
        if ROOT not in file_path.parents and file_path != ROOT: self.send_error(403); return
        if not file_path.is_file(): self.send_error(404); return
        content_type = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json"}.get(file_path.suffix, "application/octet-stream")
        data = file_path.read_bytes(); self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/state": self.send_json({"error": "Not found"}, 404); return
        conn = connect()
        try:
            user_id, token = user_for(conn, self)
            payload = self.read_json()
            validate_state(conn, payload)
            conn.execute("BEGIN"); write_state(conn, user_id, payload); conn.commit()
            self.send_json({"ok": True}, token=token)
        except (ValueError, KeyError, sqlite3.Error, json.JSONDecodeError) as exc:
            conn.rollback(); self.send_json({"error": f"State was not saved: {exc}"}, 400)
        finally: conn.close()

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/state": self.send_json({"error": "Not found"}, 404); return
        conn = connect()
        try:
            user_id, token = user_for(conn, self); conn.execute("DELETE FROM users WHERE id=?", (user_id,)); conn.commit()
            self.send_json({"ok": True}, token=token)
        finally: conn.close()

    def log_message(self, fmt, *args):
        if os.environ.get("EGE_QUIET") != "1": super().log_message(fmt, *args)


if __name__ == "__main__":
    conn = connect(); install_catalog(conn); conn.close()
    # ВАЖНО: Порт 2026 — это постоянный порт для EGE CORE (ЕГЭ-2026/2027)
    host = os.environ.get("EGE_HOST", "0.0.0.0")
    port = int(os.environ.get("EGE_PORT", "2026"))
    print(f"EGE CORE listening on http://{host}:{port} (SQLite: {DB_PATH})")
    print(f"Порт 2026 закреплён за этим проектом")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
