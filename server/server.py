#!/usr/bin/env python3
"""Small production backend for EGE CORE.

The browser talks only to this service. SQLite is the source of truth for the
account, learning history and progress; catalog content is installed into the
same database on first start.
"""
from __future__ import annotations

import atexit
import datetime as dt
import errno
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from zoneinfo import ZoneInfo
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import urlparse

try:
    import fcntl
except ImportError:  # pragma: no cover - the supported deployment target is Unix
    fcntl = None

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("EGE_DB_PATH", str(ROOT / "server" / "ege.sqlite3")))
CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"
SCRIPT_PATH = Path(__file__).resolve()
MAX_NAME_LENGTH = 60


def runtime_pid_path() -> Path:
    """Return the pid file path, allowing systemd and manual runs to share it."""
    return Path(os.environ.get("EGE_PID_FILE", str(ROOT / ".ege-2026.pid")))


def runtime_lock_path() -> Path:
    return Path(os.environ.get("EGE_LOCK_FILE", f"{runtime_pid_path()}.lock"))


def _pid_record(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError, UnicodeError):
        return None
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        # Accept a plain pid left by an older development process.
        value = {"pid": raw.splitlines()[0]}
    if not isinstance(value, dict):
        return None
    try:
        pid = int(value.get("pid", 0))
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    return {"pid": pid, "script": value.get("script")}


def _proc_cmdline(pid: int) -> list[str]:
    try:
        data = Path(f"/proc/{pid}/cmdline").read_bytes()
    except (FileNotFoundError, OSError):
        return []
    return [part.decode("utf-8", "replace") for part in data.split(b"\0") if part]


def _same_server_process(pid: int, record: dict | None = None) -> bool:
    """Verify a pid belongs to this script before sending it a signal."""
    if pid <= 0 or pid == os.getpid():
        return False
    recorded_script = (record or {}).get("script")
    if recorded_script:
        try:
            if Path(recorded_script).resolve() != SCRIPT_PATH:
                return False
        except OSError:
            return False
    args = _proc_cmdline(pid)
    if not args:
        return False
    cwd = None
    try:
        cwd = Path(os.readlink(f"/proc/{pid}/cwd"))
    except OSError:
        pass
    for arg in args[1:]:
        if not arg or arg.startswith("-") or not arg.endswith(".py"):
            continue
        candidate = Path(arg)
        if not candidate.is_absolute() and cwd is not None:
            candidate = cwd / candidate
        try:
            if candidate.resolve() == SCRIPT_PATH:
                return True
        except OSError:
            continue
    return False


def _listening_socket_inodes(port: int) -> set[str]:
    """Return socket inodes listening on a port in the current network namespace."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text(encoding="ascii").splitlines()[1:]
        except (FileNotFoundError, OSError, UnicodeError):
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":  # TCP_LISTEN
                continue
            try:
                if int(fields[1].rsplit(":", 1)[1], 16) == port:
                    inodes.add(fields[9])
            except (IndexError, ValueError):
                continue
    return inodes


def _process_listens_on_port(pid: int, port: int) -> bool:
    inodes = _listening_socket_inodes(port)
    if not inodes:
        return False
    try:
        descriptors = Path(f"/proc/{pid}/fd").iterdir()
    except OSError:
        return False
    for descriptor in descriptors:
        try:
            target = os.readlink(descriptor)
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]") and target[8:-1] in inodes:
            return True
    return False


def _server_processes(port: int) -> list[int]:
    """Find legacy instances that predate the pid lock and own this port."""
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return []
    result = []
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if _same_server_process(pid) and _process_listens_on_port(pid, port):
            result.append(pid)
    return result


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop_process(pid: int, timeout: float) -> None:
    """Ask the previous process to stop, escalating only after a timeout."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_exists(pid):
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return


class ServerInstance:
    """A filesystem lock and pid record for safe manual restarts."""

    def __init__(self) -> None:
        self.pid_path = runtime_pid_path()
        self.lock_path = runtime_lock_path()
        self._handle = None
        self._released = False

    @staticmethod
    def _lock(handle, non_blocking: bool = True) -> bool:
        if fcntl is None:
            raise RuntimeError("file locking is unavailable on this platform")
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if non_blocking else 0)
        try:
            fcntl.flock(handle.fileno(), flags)
            return True
        except OSError as exc:
            if non_blocking and exc.errno in (errno.EACCES, errno.EAGAIN):
                return False
            raise

    def _write_pid(self) -> None:
        self.pid_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.pid_path.with_name(f".{self.pid_path.name}.{os.getpid()}.tmp")
        temp_path.write_text(json.dumps({"pid": os.getpid(), "script": str(SCRIPT_PATH)}), encoding="utf-8")
        os.replace(temp_path, self.pid_path)

    def _wait_for_lock(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._lock(self._handle):
                return True
            time.sleep(0.05)
        return False

    def acquire(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.lock_path.open("a+")
        try:
            if not self._lock(self._handle):
                record = _pid_record(self.pid_path)
                pid = record["pid"] if record else 0
                if not record or not _same_server_process(pid, record):
                    raise RuntimeError(
                        f"another process owns {self.lock_path}; refusing to terminate an unknown process"
                    )
                timeout = float(os.environ.get("EGE_STOP_TIMEOUT", "8"))
                print(f"Stopping previous EGE CORE process (pid {pid})", file=sys.stderr, flush=True)
                _stop_process(pid, timeout)
                if not self._wait_for_lock(timeout):
                    raise RuntimeError(f"previous EGE CORE process (pid {pid}) did not release its lock")
            self._write_pid()
        except Exception:
            self._handle.close()
            self._handle = None
            raise
        atexit.register(self.release)

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            record = _pid_record(self.pid_path)
            if record and record.get("pid") == os.getpid():
                self.pid_path.unlink(missing_ok=True)
        except OSError:
            pass
        if self._handle is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._handle.close()
                self._handle = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()


def _running_under_supervisor() -> bool:
    # INVOCATION_ID is supplied by systemd; EGE_SUPERVISED also makes the unit
    # explicit and keeps this behavior predictable in other supervisors.
    return bool(os.environ.get("INVOCATION_ID") or os.environ.get("EGE_SUPERVISED") == "1")


def restart_active_systemd_unit() -> bool:
    """Restart the installed unit when a manual launch targets a live service."""
    if _running_under_supervisor() or os.environ.get("EGE_DISABLE_SYSTEMD") == "1":
        return False
    systemctl = shutil.which("systemctl")
    if not systemctl:
        return False
    unit = os.environ.get("EGE_SYSTEMD_UNIT", "ege-2026.service")
    try:
        status = subprocess.run(
            [systemctl, "is-active", "--quiet", unit],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if status.returncode != 0:
        return False
    try:
        result = subprocess.run(
            [systemctl, "restart", unit],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"could not restart {unit}: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"systemd refused to restart {unit}{suffix}")
    print(f"Restart requested for active systemd unit {unit}; exiting launcher", flush=True)
    return True


def create_http_server(host: str, port: int) -> ThreadingHTTPServer:
    """Bind the port, replacing only a legacy instance of this script."""
    try:
        return ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        legacy = _server_processes(port)
        if not legacy:
            raise RuntimeError(
                f"cannot bind {host}:{port}; the port is occupied by an unknown process"
            ) from exc
        timeout = float(os.environ.get("EGE_STOP_TIMEOUT", "8"))
        for pid in legacy:
            print(f"Stopping legacy EGE CORE process (pid {pid})", file=sys.stderr, flush=True)
            _stop_process(pid, timeout)
        time.sleep(0.1)
        try:
            return ThreadingHTTPServer((host, port), Handler)
        except OSError as retry_exc:
            raise RuntimeError(f"cannot bind {host}:{port} after stopping the old process") from retry_exc

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  onboarded INTEGER NOT NULL DEFAULT 0,
  self_level TEXT,
  goal_id TEXT,
  name TEXT
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
  task_ids_json TEXT NOT NULL DEFAULT '[]',
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
    return dt.datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()


def sanitize_name(value) -> str | None:
    """Collapse whitespace and cap length; anything unusable becomes NULL."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned[:MAX_NAME_LENGTH] or None


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def install_catalog(conn: sqlite3.Connection) -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    conn.executescript(SCHEMA)
    # Existing SQLite files need the new daily selection column migrated in place.
    daily_columns = {row["name"] for row in conn.execute("PRAGMA table_info(daily_progress)")}
    if "task_ids_json" not in daily_columns:
        conn.execute("ALTER TABLE daily_progress ADD COLUMN task_ids_json TEXT NOT NULL DEFAULT '[]'")
    # Existing accounts predate the display-name step; they keep a NULL name
    # until the user sets one, rather than being forced through onboarding again.
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "name" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN name TEXT")
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
        conn.execute("""INSERT INTO tasks
          (id, skill_id, topic, exam_number, difficulty, statement, answer, explanation, hint, task_type, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id,topic=excluded.topic,exam_number=excluded.exam_number,difficulty=excluded.difficulty,statement=excluded.statement,answer=excluded.answer,explanation=excluded.explanation,hint=excluded.hint,task_type=excluded.task_type,metadata_json=excluded.metadata_json""", (
            task["id"], task["skill"], task["sub"], task.get("num"), task["diff"], task["text"], task["answer"],
            task["solution"], task.get("hint") or (task.get("hints") or [None])[0], task.get("type", "short_answer"), json.dumps(metadata, ensure_ascii=False)))
    for lesson in catalog["lessons"]:
        conn.execute("INSERT INTO lessons(id, skill_id, title, xp, metadata_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id,title=excluded.title,xp=excluded.xp,metadata_json=excluded.metadata_json",
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
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('visualAssets', ?)", (json.dumps(catalog.get("visualAssets", []), ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('visualAudit', ?)", (json.dumps(catalog.get("visualAudit", {}), ensure_ascii=False),))
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
            "diagnosticTasks": config["diagnosticTasks"], "visualAssets": config.get("visualAssets", []),
            "visualAudit": config.get("visualAudit", {})}


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
    return {"version": 4, "onboarded": False, "goal": None, "selfLevel": None, "name": None, "xp": 0, "streak": 0, "lastActiveDate": None,
            "totalSolved": 0, "totalCorrect": 0, "totalTimeSec": 0, "hintsUsed": 0, "hintLevels": {"1": 0, "2": 0, "3": 0},
            "correctSeries": 0, "bestSeries": 0, "errorsResolved": 0, "bossesDefeated": [], "missionsDone": {}, "missionProgress": {},
            "achievements": {}, "errors": [], "lessonStepErrors": {}, "lessonErrorHistory": [], "lessonSessions": {},
            "completedLessons": {}, "lessonAttempts": [], "taskAttempts": [], "diagnostics": [], "forecastHistory": [], "activity": {},
            "timeline": [], "daily": {"date": None, "solved": 0, "done": False, "taskIds": []}, "dailyHistory": [], "skillStats": skills}


def read_state(conn: sqlite3.Connection, user_id: int) -> dict:
    state = default_state(conn, user_id)
    user = conn.execute("SELECT onboarded, self_level, goal_id, name FROM users WHERE id=?", (user_id,)).fetchone()
    stats = conn.execute("SELECT * FROM user_stats WHERE user_id=?", (user_id,)).fetchone()
    if user:
        state.update({"onboarded": bool(user["onboarded"]), "selfLevel": user["self_level"], "goal": user["goal_id"], "name": user["name"]})
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
    daily_rows = list(conn.execute("SELECT * FROM daily_progress WHERE user_id=? ORDER BY progress_date DESC", (user_id,)))
    state["dailyHistory"] = []
    for daily in daily_rows:
        try:
            task_ids = json.loads(daily["task_ids_json"] or "[]")
        except (TypeError, json.JSONDecodeError):
            task_ids = []
        state["dailyHistory"].append({"date": daily["progress_date"], "solved": daily["solved"], "done": bool(daily["done"]), "taskIds": task_ids})
    if daily_rows: state["daily"] = state["dailyHistory"][0].copy()
    state["timeline"] = [{"ts": timestamp_value(r["created_at"]), "text": r["text"]} for r in conn.execute("SELECT created_at, text FROM timeline WHERE user_id=? ORDER BY id DESC LIMIT 40", (user_id,))]
    state["diagnostics"] = [{"taskId": r["task_id"], "correct": bool(r["correct"]), "ts": timestamp_value(r["created_at"])} for r in conn.execute("SELECT * FROM diagnostics WHERE user_id=? ORDER BY id DESC", (user_id,))]
    return state


def write_state(conn: sqlite3.Connection, user_id: int, state: dict) -> None:
    # The API accepts only a state snapshot produced by the application logic;
    # all durable collections are written to their normalized tables in one transaction.
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills")}
    conn.execute("UPDATE users SET onboarded=?, self_level=?, goal_id=?, name=? WHERE id=?",
                 (int(bool(state.get("onboarded"))), state.get("selfLevel"), state.get("goal"), sanitize_name(state.get("name")), user_id))
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
    valid_task_ids = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
    for item in s.get("taskAttempts") or []:
        if item.get("taskId") in valid_task_ids:
            conn.execute("INSERT INTO task_attempts(user_id,task_id,skill_id,correct,hint_level,seconds,closes_task_id,created_at) VALUES(?,?,?,?,?,?,?,?)", (user_id, item["taskId"], item.get("skill", ""), int(bool(item.get("correct"))), int(item.get("hintLevel", 0)), float(item.get("seconds", 0)), item.get("closesTaskId"), item.get("ts") or now_iso()))
    for item in s.get("errors") or []:
        if item.get("taskId") in valid_task_ids:
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
    daily_records = {}
    for item in s.get("dailyHistory") or []:
        if item.get("date"): daily_records[item["date"]] = item
    daily = s.get("daily") or {}
    if daily.get("date"): daily_records[daily["date"]] = daily
    for progress_date, item in daily_records.items():
        selected_task_ids = [str(task_id) for task_id in (item.get("taskIds") or [])]
        conn.execute("INSERT INTO daily_progress(user_id,progress_date,solved,done,task_ids_json) VALUES(?,?,?,?,?)",
                     (user_id,progress_date,int(item.get("solved",0)),int(bool(item.get("done"))),json.dumps(selected_task_ids,ensure_ascii=False)))
    for item in s.get("timeline") or []: conn.execute("INSERT INTO timeline(user_id,created_at,text) VALUES(?,?,?)", (user_id,item.get("ts") or now_iso(),item.get("text", "")))
    for item in s.get("diagnostics") or []:
        if item.get("taskId") in valid_task_ids: conn.execute("INSERT INTO diagnostics(user_id,task_id,correct,created_at) VALUES(?,?,?,?)", (user_id,item["taskId"],int(bool(item.get("correct"))),item.get("ts") or now_iso()))


def validate_state(conn: sqlite3.Connection, state: dict) -> None:
    if not isinstance(state, dict): raise ValueError("state must be an object")
    name = state.get("name")
    if name is not None and not isinstance(name, str): raise ValueError("invalid name")
    if isinstance(name, str) and len(name.strip()) > MAX_NAME_LENGTH: raise ValueError("name too long")
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
        content_type = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf"}.get(file_path.suffix, "application/octet-stream")
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
    def run_server() -> int:
        # A manual invocation becomes a restart request when systemd already
        # owns the service.  The service itself is marked as supervised, so it
        # never recursively restarts itself.
        if restart_active_systemd_unit():
            return 0

        # ВАЖНО: Порт 2026 — это постоянный порт для EGE CORE (ЕГЭ-2026/2027)
        host = os.environ.get("EGE_HOST", "0.0.0.0")
        port = int(os.environ.get("EGE_PORT", "2026"))
        with ServerInstance():
            conn = connect()
            try:
                install_catalog(conn)
            finally:
                conn.close()
            httpd = create_http_server(host, port)
            httpd.daemon_threads = True
            stopping = threading.Event()

            def stop_server(signum, _frame):
                if stopping.is_set():
                    return
                stopping.set()
                print(f"EGE CORE stopping (signal {signum})", flush=True)
                # shutdown() must run outside the serve_forever thread.
                threading.Thread(target=httpd.shutdown, daemon=True).start()

            previous_handlers = {
                signal.SIGINT: signal.getsignal(signal.SIGINT),
                signal.SIGTERM: signal.getsignal(signal.SIGTERM),
            }
            signal.signal(signal.SIGINT, stop_server)
            signal.signal(signal.SIGTERM, stop_server)
            print(
                f"EGE CORE listening on http://{host}:{port} "
                f"(pid {os.getpid()}, code mtime {SCRIPT_PATH.stat().st_mtime_ns}, SQLite: {DB_PATH})",
                flush=True,
            )
            try:
                httpd.serve_forever(poll_interval=0.5)
            finally:
                httpd.server_close()
                for sig, handler in previous_handlers.items():
                    signal.signal(sig, handler)
        return 0

    try:
        raise SystemExit(run_server())
    except (RuntimeError, ValueError) as exc:
        print(f"EGE CORE startup failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
