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
import gzip
import hashlib
import hmac
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
from secrets import choice, token_hex, token_urlsafe
from urllib.parse import urlparse

try:
    import fcntl
except ImportError:  # pragma: no cover - the supported deployment target is Unix
    fcntl = None

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("EGE_DB_PATH", str(ROOT / "server" / "ege.sqlite3")))
CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"
CATALOG_BASIC_PATH = Path(__file__).resolve().parent / "catalog_basic.json"
SCRIPT_PATH = Path(__file__).resolve()
MAX_NAME_LENGTH = 60
# Public account identifier shown in the UI (e.g. "a7k29x") — distinct from the
# internal `users.id` primary key. Never exposed as a way to look up or spoof
# the internal id; it only ever maps forward, account_id -> user, in the DB.
ACCOUNT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
ACCOUNT_ID_LENGTH = 6
ACCOUNT_ID_MAX_ATTEMPTS = 25
# Static-file allowlist guardrails: anything under these top-level directories,
# any dot-prefixed path and these file types are never served over HTTP. The DB
# file alone (session tokens!) makes this a hard requirement, not a nicety.
BLOCKED_STATIC_DIRS = {"server", ".git", "deploy", "test", "hermes-webui"}
BLOCKED_STATIC_SUFFIXES = {".py", ".sqlite3", ".db", ".service", ".md", ".txt"}
# Публичные SEO/мета-файлы, которым разрешено жить под заблокированными
# суффиксами (.txt): robots.txt и llms.txt отдаются статикой. sitemap.xml
# отдаётся динамически из do_GET (абсолютные URL от хоста запроса, см.
# public_base_url), поэтому физического файла в корне нет осознанно.
PUBLIC_STATIC_FILES = {"robots.txt", "llms.txt", "site.webmanifest", "favicon.svg"}
MAX_BODY_BYTES = 10 * 1024 * 1024
# Server-side caps for client-controlled collections. The client caps these
# itself (taskAttempts 5000, timeline 40, ...) — these are anti-abuse ceilings
# with headroom, so a crafted payload can't turn one PUT into a DB write storm.
MAX_COUNTER_VALUE = 10**9
MAX_TASK_ATTEMPTS = 20000
MAX_ERRORS = 5000
MAX_TIMELINE = 200
MAX_LESSON_ATTEMPTS = 5000
MAX_LESSON_ERROR_HISTORY = 1000
MAX_DIAGNOSTICS = 2000
MAX_DAILY_HISTORY = 400
MAX_BOSSES = 500
MAX_TIMELINE_TEXT = 1000
MAX_FORECAST_HISTORY = 500
MAX_ACTIVITY_DAYS = 2000
MAX_STATE_DICT = 2000

# ---------------------------------------------------------------------------
# Multi-subject model.
#
# Предмет — сущность первого класса: весь пользовательский прогресс, каталог
# и прогнозы разрешаются строго в рамках одного subject. Новый предмет
# добавляется одной записью в SUBJECTS + контентом в каталоге (навыки/задания
# с subject=<id>), без ветвлений вида `if basic_math` по коду: все системы
# читают конфиг через subject_config()/resolve_subject(), а не хардкод.
# ---------------------------------------------------------------------------
DEFAULT_SUBJECT = "profile_math"

# Веса навыков в первичных баллах ЕГЭ-2026 (профиль) и шкала перевода в
# тестовые — конфиг прогноза профильной математики. Лежит здесь (а не только
# в js), чтобы subjects-пейлоад отдавал его клиентам из одного места.
SKILL_EGE_WEIGHTS_PROFILE = {
    "n01_planimetry": 1, "n02_vectors": 1, "n03_stereometry": 1, "n04_probability": 1,
    "n05_prob_theorems": 1, "n06_random_var": 1, "n07_equations": 1, "n08_expressions": 1,
    "n09_derivative": 1, "n10_applied": 1, "n11_word_problems": 1, "n12_functions": 1,
    "n14_trig_eq": 2, "n15_stereometry": 3, "n13_financial": 2, "n18_planimetry": 2,
    "n16_inequality": 3, "n17_optimization": 4, "n19_parameter": 2, "n20_numbers": 2,
}
TOTAL_EGE_PRIMARY_PROFILE = 32
PRIMARY_TO_TEST_PROFILE = [
    0, 6, 12, 17, 22, 27, 34, 40, 46, 52, 58, 64, 70, 72, 74, 76, 78,
    80, 82, 84, 86, 88, 90, 92, 94, 95, 96, 97, 98, 99, 100, 100, 100,
]

# Прогноз базовой математики: экзамен состоит из 21 задания с кратким
# ответом, каждое даёт 1 первичный балл (максимум 21), итог — оценка 2–5
# (7+ баллов — «3», 12+ — «4», 17+ — «5»). Стобалльной шкалы у базы нет,
# поэтому «тестовый» результат совпадает с первичным: шкала тождественная.
# Прогноз отвечает на вопрос «сколько заданий решу», а не «сколько баллов
# из 100 получу» — копировать профильную шкалу сюда было бы неверно.
SKILL_EGE_WEIGHTS_BASIC = {
    "b01_wordcalc": 1, "b02_units": 1, "b03_tables": 1, "b04_formulas": 1,
    "b05_probability": 1, "b06_choice": 1, "b07_functions": 1, "b08_logic": 1,
    "b09_grid": 1, "b10_practplan": 1, "b11_practstereo": 1, "b12_planimetry": 1,
    "b13_stereometry": 1, "b14_fractions": 1, "b15_percent": 1, "b16_expressions": 1,
    "b17_equations": 1, "b18_inequalities": 1, "b19_integers": 1,
    "b20_wordprob": 1, "b21_nonstandard": 1,
}
TOTAL_EGE_PRIMARY_BASIC = 21
PRIMARY_TO_TEST_BASIC = list(range(TOTAL_EGE_PRIMARY_BASIC + 1))

SUBJECTS: dict[str, dict] = {
    "profile_math": {
        "id": "profile_math",
        "title": "Профильная математика",
        "short": "Профиль",
        # ready: полный цикл (каталог, диагностика, прогноз). empty: предмет
        # существует, контент ещё не подключён — UI показывает заглушку.
        "status": "ready",
        "forecast": {
            "weights": SKILL_EGE_WEIGHTS_PROFILE,
            "total": TOTAL_EGE_PRIMARY_PROFILE,
            "scale": PRIMARY_TO_TEST_PROFILE,
        },
        # Что реально входит в курс предмета (для честных подписей в UI:
        # «Полный курс» — только там, где есть и уроки, и практика, и прогноз).
        "features": {"lessons": True, "practice": True, "forecast": True},
    },
    "basic_math": {
        "id": "basic_math",
        "title": "Базовая математика",
        "short": "База",
        "status": "ready",
        "forecast": {
            "weights": SKILL_EGE_WEIGHTS_BASIC,
            "total": TOTAL_EGE_PRIMARY_BASIC,
            "scale": PRIMARY_TO_TEST_BASIC,
        },
        # Уроки есть для части навыков (остальные считаются полностью из
        # практики — та же механика, что у профильных тем без урока).
        # Остальной цикл полный: диагностика, тренировки, боссы, прогноз.
        "features": {"lessons": True, "practice": True, "forecast": True},
    },
}
SUBJECT_IDS = tuple(SUBJECTS.keys())


def subject_ids() -> tuple:
    """Все известные id предметов (порядок = порядок показа в UI)."""
    return SUBJECT_IDS


def is_known_subject(value) -> bool:
    return isinstance(value, str) and value in SUBJECTS


def resolve_subject(value) -> str:
    """Неизвестный/пустой subject -> DEFAULT_SUBJECT. Никогда не бросает."""
    if is_known_subject(value):
        return value
    return DEFAULT_SUBJECT


def subjects_payload() -> list:
    """Публичное описание предметов для каталога/онбординга."""
    return [
        {"id": sid, "title": SUBJECTS[sid]["title"], "short": SUBJECTS[sid]["short"],
         "status": SUBJECTS[sid]["status"], "forecast": SUBJECTS[sid]["forecast"],
         "features": SUBJECTS[sid].get("features", {})}
        for sid in SUBJECT_IDS
    ]

# ---------------------------------------------------------------------------
# Admin access
#
# The admin password is never stored or transmitted in plaintext: the server
# keeps only a PBKDF2-SHA256 hash (override via EGE_ADMIN_PASSWORD_HASH).
# A successful login creates a server-side admin session row bound to the
# internal users.id of the *current* account; the browser receives only a
# random opaque token in an HttpOnly cookie. Verification on every admin API
# call re-resolves the user from the normal ege_session cookie and requires a
# matching, unexpired admin_sessions row — so a cookie copied from another
# account grants nothing, and deleting the account cascades away its admin
# sessions. This is deliberately separate from the user session system:
# holding an ege_session never implies admin rights.
# ---------------------------------------------------------------------------
ADMIN_PASSWORD_HASH = os.environ.get(
    "EGE_ADMIN_PASSWORD_HASH",
    "pbkdf2_sha256$210000$242cb1880b2d6030889b3de36a87baa4$7c5cd007d7f3345e97fb8e2abf42f9b4e85327f7f6049cd8542b1cfa5e70f968",
)
ADMIN_COOKIE_NAME = "ege_admin"
ADMIN_SESSION_DAYS = 30
ADMIN_SESSION_MAX_AGE = ADMIN_SESSION_DAYS * 86400
# Brute-force guard for the password endpoint: per client IP, in memory.
ADMIN_LOGIN_MAX_FAILURES = 10
ADMIN_LOGIN_WINDOW_SEC = 15 * 60
_admin_login_failures: dict[str, list[float]] = {}
_admin_login_lock = threading.Lock()
SERVER_STARTED_AT = dt.datetime.now(dt.timezone.utc)

# ---------------------------------------------------------------------------
# User accounts (registration / login)
#
# The anonymous "guest" profile IS a users row: public endpoints resolve the
# caller from the ege_session cookie via user_for() and mint a row on first
# visit. Registering therefore does NOT create a new user — it attaches an
# email + password hash to the CURRENT row, so every piece of learning data
# (stats, progress, attempts, streak, achievements) stays put, keyed by the
# same users.id. Login re-binds the browser session row to an existing
# account; logout deletes that session row server-side and clears the cookie,
# so a stale token afterwards resolves to a fresh guest, never to an account.
# Sessions live in user_sessions (many per account, one per device), with a
# server-side expiry; the cookie only ever carries an opaque random token.
# ---------------------------------------------------------------------------
AUTH_SESSION_DAYS = 365
AUTH_SESSION_MAX_AGE = AUTH_SESSION_DAYS * 86400
AUTH_PASSWORD_MIN_LENGTH = 8
AUTH_PASSWORD_MAX_LENGTH = 72
AUTH_LOGIN_MAX_FAILURES = 10
AUTH_LOGIN_WINDOW_SEC = 15 * 60
_auth_login_failures: dict[str, list[float]] = {}
_auth_login_lock = threading.Lock()
AUTH_SCHEMA_DONE: set[str] = set()


def normalize_email(value) -> str | None:
    """Lowercased/stripped email or None when unusable. Never raises."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    if not cleaned or len(cleaned) > 254 or "@" not in cleaned:
        return None
    local, _, domain = cleaned.rpartition("@")
    if not local or not domain or "." not in domain or " " in cleaned:
        return None
    return cleaned


def hash_password(password: str) -> str:
    """PBKDF2-SHA256 with a per-password salt; only this ever touches the DB."""
    salt = token_hex(16)
    iterations = 210000
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${dk.hex()}"


def verify_password(candidate: str, stored: str | None) -> bool:
    """Constant-time check of a plaintext against a stored PBKDF2 hash."""
    if not stored or not isinstance(candidate, str):
        return False
    try:
        algo, iterations, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", candidate.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def auth_login_allowed(ip: str) -> bool:
    now = time.time()
    with _auth_login_lock:
        recent = [t for t in _auth_login_failures.get(ip, []) if now - t < AUTH_LOGIN_WINDOW_SEC]
        _auth_login_failures[ip] = recent
        return len(recent) < AUTH_LOGIN_MAX_FAILURES


def auth_login_failed(ip: str) -> None:
    with _auth_login_lock:
        _auth_login_failures.setdefault(ip, []).append(time.time())


def auth_login_success(ip: str) -> None:
    with _auth_login_lock:
        _auth_login_failures.pop(ip, None)


def ensure_auth_schema(conn: sqlite3.Connection) -> None:
    """Идемпотентная миграция под аккаунты: email/password_hash у users и
    отдельная таблица серверных сессий (несколько на аккаунт — по одной на
    устройство/браузер). Старые session_token переносятся в user_sessions,
    чтобы существующие гостевые профили пережили апгрейд без потери данных."""
    key = _db_key(conn)
    if key in AUTH_SCHEMA_DONE:
        return
    conn.executescript(SCHEMA)
    if "email" not in _table_columns(conn, "users"):
        conn.execute("ALTER TABLE users ADD COLUMN email TEXT")
    if "password_hash" not in _table_columns(conn, "users"):
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
    if "registered_at" not in _table_columns(conn, "users"):
        conn.execute("ALTER TABLE users ADD COLUMN registered_at TEXT")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      device_name TEXT,
      device_type TEXT,
      last_seen_at INTEGER)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)")
    # Существующие БД: таблица создана старой версией без device-колонок.
    _us_cols = _table_columns(conn, "user_sessions")
    if "device_name" not in _us_cols:
        conn.execute("ALTER TABLE user_sessions ADD COLUMN device_name TEXT")
    if "device_type" not in _us_cols:
        conn.execute("ALTER TABLE user_sessions ADD COLUMN device_type TEXT")
    if "last_seen_at" not in _us_cols:
        conn.execute("ALTER TABLE user_sessions ADD COLUMN last_seen_at INTEGER")
    # UNIQUE допускает множество NULL: незарегистрированные гости не мешают.
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
    expiry = int(time.time() * 1000) + AUTH_SESSION_MAX_AGE * 1000
    conn.execute(
        "INSERT INTO user_sessions(user_id, token, created_at, expires_at) "
        "SELECT id, session_token, created_at, ? FROM users "
        "WHERE session_token IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM user_sessions WHERE token = users.session_token)",
        (expiry,))
    # Сырой User-Agent никогда не храним: только человекочитаемое название и
    # тип + метка последней активности. Старые строки получают нейтральный
    # дефолт без персональных данных.
    try:
        now_ms = int(time.time() * 1000)
        conn.execute("UPDATE user_sessions SET device_name='Браузер' WHERE device_name IS NULL")
        conn.execute("UPDATE user_sessions SET device_type='desktop' WHERE device_type IS NULL")
        conn.execute("UPDATE user_sessions SET last_seen_at=? WHERE last_seen_at IS NULL", (now_ms,))
    except sqlite3.Error:
        pass
    conn.commit()
    AUTH_SCHEMA_DONE.add(key)


def parse_device_info(user_agent: str | None) -> tuple[str, str]:
    """Человекочитаемое (название, тип) по User-Agent без хранения сырого UA.

    Точную модель вернуть можно лишь когда она есть в самом UA (редкие
    Android-аппараты); во всех остальных случаях — понятное обобщённое
    название: iPhone / iPad / Windows PC / MacBook / Android-смартфон.
    Тип — один из: phone, tablet, laptop, desktop.
    """
    try:
        ua = str(user_agent or "")[:512]
    except Exception:
        ua = ""
    low = ua.lower()
    if "iphone" in low:
        return ("iPhone", "phone")
    if "ipad" in low:
        return ("iPad", "tablet")
    if "android" in low:
        # Планшеты на Android обычно без маркера Mobile.
        if "mobile" not in low:
            return ("Android-планшет", "tablet")
        return ("Android-смартфон", "phone")
    if "windows" in low:
        return ("Windows PC", "desktop")
    if "macintosh" in low or "mac os x" in low:
        return ("MacBook", "laptop")
    if "cros" in low or "chromebook" in low:
        return ("Chromebook", "laptop")
    if "linux" in low:
        return ("Linux PC", "desktop")
    if "mobile" in low:
        return ("Смартфон", "phone")
    if "tablet" in low:
        return ("Планшет", "tablet")
    return ("Браузер", "desktop")


def request_device_info(handler) -> tuple[str, str]:
    """Название/тип текущего устройства по заголовку запроса. Сырой UA за
    пределы этого вызова не уходит и нигде не хранится."""
    try:
        ua = handler.headers.get("User-Agent", "")
    except Exception:
        ua = ""
    return parse_device_info(ua)


def session_row_for(conn: sqlite3.Connection, token: str | None, device: tuple[str, str] | None = None):
    """Живая сессия по токену или None. Просроченная удаляется лениво.

    Попутно обновляет last_seen_at (троттлинг ~60с) и человекочитаемое
    название устройства, если оно изменилось. Сырой User-Agent сюда не
    передаётся — только распарсенная пара (название, тип)."""
    if not token:
        return None
    row = conn.execute(
        "SELECT us.id AS session_pk, us.expires_at, u.id AS user_id, "
        "us.device_name AS device_name, us.device_type AS device_type, "
        "us.last_seen_at AS last_seen_at "
        "FROM user_sessions us JOIN users u ON u.id = us.user_id WHERE us.token = ?",
        (token,)).fetchone()
    if not row:
        return None
    if int(row["expires_at"]) <= int(time.time() * 1000):
        conn.execute("DELETE FROM user_sessions WHERE id=?", (row["session_pk"],))
        conn.commit()
        return None
    try:
        now_ms = int(time.time() * 1000)
        try:
            last_int = int(row["last_seen_at"]) if row["last_seen_at"] is not None else 0
        except (TypeError, ValueError):
            last_int = 0
        updates: list[str] = []
        args: list = []
        if not last_int or now_ms - last_int > 60_000:
            updates.append("last_seen_at=?")
            args.append(now_ms)
        if device:
            dname, dtype = device
            try:
                stored_name = row["device_name"]
            except (KeyError, IndexError, TypeError):
                stored_name = None
            try:
                stored_type = row["device_type"]
            except (KeyError, IndexError, TypeError):
                stored_type = None
            if stored_name != dname:
                updates.append("device_name=?")
                args.append(dname)
            if stored_type != dtype:
                updates.append("device_type=?")
                args.append(dtype)
        if updates:
            args.append(row["session_pk"])
            conn.execute(f"UPDATE user_sessions SET {', '.join(updates)} WHERE id=?", args)
            conn.commit()
    except sqlite3.Error:
        pass
    return row


def create_user_session(conn: sqlite3.Connection, user_id: int, device: tuple[str, str] | None = None) -> tuple[str, int]:
    token = token_urlsafe(32)
    expires_at = int(time.time() * 1000) + AUTH_SESSION_MAX_AGE * 1000
    name, dtype = device if device else ("Браузер", "desktop")
    now_ms = int(time.time() * 1000)
    try:
        conn.execute(
            "INSERT INTO user_sessions(user_id, token, created_at, expires_at, device_name, device_type, last_seen_at) VALUES (?,?,?,?,?,?,?)",
            (user_id, token, now_iso(), expires_at, name, dtype, now_ms),
        )
    except sqlite3.Error:
        # Старая схема без device-колонок (двойная защита к миграции выше).
        conn.execute(
            "INSERT INTO user_sessions(user_id, token, created_at, expires_at) VALUES (?,?,?,?)",
            (user_id, token, now_iso(), expires_at),
        )
    return token, expires_at


def rotate_user_session(conn: sqlite3.Connection, old_token: str | None, user_id: int, device: tuple[str, str] | None = None) -> tuple[str, int]:
    """Login/register: инвалидирует предъявленный токен и выдаёт новый,
    привязанный к тому же (register) или целевому (login) аккаунту. Старый
    токен после этого неизвестен серверу — повторная отправка старой куки
    минтит нового гостя. Другие сессии аккаунта не трогаем никогда: вход
    второго устройства не должен завершать первое. Дедупликация по паре
    (device_name, device_type) здесь невозможна — значений всего несколько
    («Windows PC», «iPhone», «Браузер», ...) и два разных физических
    устройства одной модели неразличимы; автоудаление «дублей» убивало живые
    чужие сессии. Повторный вход с того же устройства без старой куки может
    оставить вторую строку в «Устройствах» — она снимается вручную через
    отзыв, это косметика, а не повод инвалидировать чужой токен."""
    if old_token:
        conn.execute("DELETE FROM user_sessions WHERE token=?", (old_token,))
    token, expires_at = create_user_session(conn, user_id, device)
    return token, expires_at


def auth_devices_payload(conn: sqlite3.Connection, user_id: int, current_pk: int | None) -> list:
    """Список активных сессий аккаунта без токенов и сырого UA: только id
    строки (для отзыва), человекочитаемое название/тип и метки времени."""
    now_ms = int(time.time() * 1000)
    rows = conn.execute(
        "SELECT id, device_name, device_type, created_at, last_seen_at "
        "FROM user_sessions WHERE user_id=? AND expires_at>? "
        "ORDER BY last_seen_at DESC, id DESC",
        (user_id, now_ms),
    ).fetchall()
    devices = []
    for r in rows:
        try:
            sid = int(r["id"])
        except (TypeError, ValueError):
            continue
        devices.append({
            "id": sid,
            "name": r["device_name"] or "Браузер",
            "type": r["device_type"] or "desktop",
            "createdAt": timestamp_value(r["created_at"]),
            "lastSeenAt": int(r["last_seen_at"]) if r["last_seen_at"] is not None else timestamp_value(r["created_at"]),
            "current": bool(current_pk is not None and sid == int(current_pk)),
        })
    return devices


def auth_user_payload(conn: sqlite3.Connection, user_id: int) -> dict | None:
    """Публичный профиль аккаунта для auth-эндпоинтов. registered = есть хеш."""
    row = conn.execute(
        "SELECT name, account_id, email, password_hash FROM users WHERE id=?", (user_id,)
    ).fetchone()
    if not row:
        return None
    return {"name": row["name"], "accountId": row["account_id"], "email": row["email"],
            "registered": bool(row["password_hash"])}


def auth_state_payload(conn: sqlite3.Connection, user_id: int) -> dict:
    """Auth-срез для bootstrap: фронт рисует «Гостевой профиль» или email."""
    row = conn.execute(
        "SELECT email, password_hash FROM users WHERE id=?", (user_id,)).fetchone()
    registered = bool(row and row["password_hash"])
    return {"registered": registered, "email": row["email"] if registered else None}


def verify_admin_password(candidate: str) -> bool:
    """Constant-time check of the plaintext against the stored PBKDF2 hash."""
    try:
        algo, iterations, salt_hex, hash_hex = ADMIN_PASSWORD_HASH.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", candidate.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def admin_login_allowed(ip: str) -> bool:
    now = time.time()
    with _admin_login_lock:
        recent = [t for t in _admin_login_failures.get(ip, []) if now - t < ADMIN_LOGIN_WINDOW_SEC]
        _admin_login_failures[ip] = recent
        return len(recent) < ADMIN_LOGIN_MAX_FAILURES


def admin_login_failed(ip: str) -> None:
    with _admin_login_lock:
        _admin_login_failures.setdefault(ip, []).append(time.time())


def admin_login_success(ip: str) -> None:
    with _admin_login_lock:
        _admin_login_failures.pop(ip, None)


def create_admin_session(conn: sqlite3.Connection, user_id: int) -> tuple[str, int]:
    """One live admin session per account: a re-login refreshes, not stacks."""
    conn.execute("DELETE FROM admin_sessions WHERE user_id=?", (user_id,))
    token = token_urlsafe(32)
    expires_at = int(time.time() * 1000) + ADMIN_SESSION_MAX_AGE * 1000
    conn.execute(
        "INSERT INTO admin_sessions(user_id, token, created_at, expires_at) VALUES (?,?,?,?)",
        (user_id, token, now_iso(), expires_at),
    )
    conn.commit()
    return token, expires_at


def existing_user_for(conn: sqlite3.Connection, handler: BaseHTTPRequestHandler) -> int | None:
    """Resolve the user from the ege_session cookie WITHOUT creating an
    account. Admin endpoints must not mint anonymous users for unauthenticated
    probes — unlike /api/bootstrap, where account creation is the normal flow."""
    ensure_auth_schema(conn)
    row = session_row_for(conn, cookie_value(handler, "ege_session"), request_device_info(handler))
    return row["user_id"] if row else None


def admin_session_user(conn: sqlite3.Connection, user_id: int, admin_token: str | None) -> dict | None:
    """Return the live admin session for this exact user, or None."""
    if not admin_token:
        return None
    row = conn.execute(
        "SELECT id, expires_at FROM admin_sessions WHERE user_id=? AND token=?",
        (user_id, admin_token),
    ).fetchone()
    if not row:
        return None
    if int(row["expires_at"]) <= int(time.time() * 1000):
        conn.execute("DELETE FROM admin_sessions WHERE id=?", (row["id"],))
        conn.commit()
        return None
    return {"id": row["id"], "expiresAt": int(row["expires_at"])}


def cookie_value(handler: BaseHTTPRequestHandler, name: str) -> str | None:
    jar = cookies.SimpleCookie(handler.headers.get("Cookie", ""))
    morsel = jar.get(name)
    return morsel.value if morsel else None


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
  account_id TEXT UNIQUE,
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
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', skill_id TEXT NOT NULL REFERENCES skills(id),
  progress INTEGER NOT NULL DEFAULT 0, solved INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, time_sec REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, subject, skill_id)
);
CREATE TABLE IF NOT EXISTS task_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', task_id TEXT NOT NULL REFERENCES tasks(id),
  skill_id TEXT NOT NULL REFERENCES skills(id), correct INTEGER NOT NULL, hint_level INTEGER NOT NULL, seconds REAL NOT NULL,
  closes_task_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', task_id TEXT NOT NULL REFERENCES tasks(id),
  skill_id TEXT NOT NULL REFERENCES skills(id), topic TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'major', client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lesson_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', lesson_id TEXT NOT NULL REFERENCES lessons(id),
  completed INTEGER NOT NULL, first_completion INTEGER NOT NULL, xp INTEGER NOT NULL, wrong_attempts INTEGER NOT NULL, duration_sec REAL NOT NULL, created_at TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lesson_step_errors (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', lesson_id TEXT NOT NULL REFERENCES lessons(id), step_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id), count INTEGER NOT NULL, last_at TEXT NOT NULL, types_json TEXT NOT NULL,
  PRIMARY KEY(user_id, subject, lesson_id, step_id)
);
CREATE TABLE IF NOT EXISTS lesson_error_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', lesson_id TEXT NOT NULL REFERENCES lessons(id),
  step_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES skills(id), error_type TEXT NOT NULL, created_at TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lesson_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', lesson_id TEXT NOT NULL REFERENCES lessons(id),
  session_json TEXT NOT NULL, PRIMARY KEY(user_id, subject, lesson_id)
);
CREATE TABLE IF NOT EXISTS completed_lessons (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', lesson_id TEXT NOT NULL REFERENCES lessons(id), completed_at TEXT NOT NULL,
  PRIMARY KEY(user_id, subject, lesson_id)
);
CREATE TABLE IF NOT EXISTS user_missions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', mission_id TEXT NOT NULL REFERENCES missions(id), progress INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT, PRIMARY KEY(user_id, subject, mission_id)
);
CREATE TABLE IF NOT EXISTS user_bosses (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', boss_id TEXT NOT NULL REFERENCES bosses(id), defeated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, subject, boss_id)
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', achievement_id TEXT NOT NULL REFERENCES achievements(id), unlocked_at TEXT NOT NULL,
  PRIMARY KEY(user_id, subject, achievement_id)
);
CREATE TABLE IF NOT EXISTS activity_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, activity_date TEXT NOT NULL, solved INTEGER NOT NULL, correct INTEGER NOT NULL, xp INTEGER NOT NULL,
  PRIMARY KEY(user_id, activity_date)
);
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT 'profile_math',
  activity_date TEXT NOT NULL, solved INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', created_at TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT 'profile_math', task_id TEXT NOT NULL REFERENCES tasks(id), correct INTEGER NOT NULL, created_at TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_xp_adjustments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return str(int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000))


def public_base_url(handler) -> str:
    """Абсолютный базовый URL сайта для sitemap.xml/robots.txt.

    Домен заранее неизвестен (локальная разработка + произвольный деплой),
    поэтому: явный EGE_PUBLIC_URL > заголовки обратного прокси >
    Host запроса > localhost по умолчанию. Никогда не бросает."""
    try:
        env = (os.environ.get("EGE_PUBLIC_URL") or "").strip().rstrip("/")
        if env:
            return env
        headers = handler.headers
        host = (headers.get("X-Forwarded-Host") or headers.get("Host") or "").split(",")[0].strip()
        if not host:
            return "http://localhost:2026"
        proto = (headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        if proto not in ("http", "https"):
            proto = "https" if os.environ.get("EGE_ADMIN_COOKIE_SECURE") == "1" else "http"
        return f"{proto}://{host}"
    except Exception:
        return "http://localhost:2026"


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


def generate_account_id() -> str:
    return "".join(choice(ACCOUNT_ID_ALPHABET) for _ in range(ACCOUNT_ID_LENGTH))


def assign_account_id(conn: sqlite3.Connection, user_id: int) -> str:
    """Generate and store a unique public Account ID for an existing user row.

    Collisions are only possible against the unique index, never silently
    accepted: on a clash the statement is rejected and a fresh id is tried.
    """
    for _ in range(ACCOUNT_ID_MAX_ATTEMPTS):
        candidate = generate_account_id()
        try:
            conn.execute("UPDATE users SET account_id=? WHERE id=?", (candidate, user_id))
            return candidate
        except sqlite3.IntegrityError:
            continue
    raise RuntimeError("could not allocate a unique account id")


def account_id_for(conn: sqlite3.Connection, user_id: int) -> str | None:
    row = conn.execute("SELECT account_id FROM users WHERE id=?", (user_id,)).fetchone()
    return row["account_id"] if row else None


class StateConflictError(Exception):
    """A state snapshot was based on an older per-subject version."""

    def __init__(self, expected_version: int, current_version: int):
        self.expected_version = expected_version
        self.current_version = current_version
        super().__init__(f"state version conflict: expected {expected_version}, current {current_version}")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    ensure_user_indexes(conn)
    return conn


# Все таблицы прогресса читаются/пишутся строго по user_id (read_state делает
# ~15 SELECT ... WHERE user_id=? на каждый bootstrap, write_state — массовые
# DELETE ... WHERE user_id=? на каждый save). Без индексов это full scan
# каждой таблицы на каждый запрос — главная серверная причина медленных
# bootstrap/save у активных пользователей. IF NOT EXISTS делает вызов дешёвым.
USER_ID_INDEXES = (
    ("user_stats", "user_stats"), ("user_progress", "user_progress"),
    ("user_hint_levels", "user_hint_levels"), ("user_errors", "user_errors"),
    ("task_attempts", "task_attempts"), ("lesson_attempts", "lesson_attempts"),
    ("lesson_step_errors", "lesson_step_errors"),
    ("lesson_error_history", "lesson_error_history"),
    ("lesson_sessions", "lesson_sessions"),
    ("completed_lessons", "completed_lessons"),
    ("user_missions", "user_missions"), ("user_bosses", "user_bosses"),
    ("user_achievements", "user_achievements"),
    ("activity_history", "activity_history"), ("activity_events", "activity_events"),
    ("forecast_history", "forecast_history"),
    ("daily_progress", "daily_progress"), ("timeline", "timeline"),
    ("diagnostics", "diagnostics"), ("user_xp_adjustments", "user_xp_adjustments"),
)


def ensure_user_indexes(conn: sqlite3.Connection) -> None:
    for suffix, table in USER_ID_INDEXES:
        try:
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{suffix}_user_id ON {table}(user_id)")
        except sqlite3.Error:
            pass


# ---------------------------------------------------------------------------
# Multi-subject storage migration.
#
# Каждый предмет живёт в своих строках: все пользовательские таблицы несут
# колонку subject ('profile_math' по умолчанию — существующие данные
# автоматически относятся к профилю, ничего не переезжает и не теряется).
# Таблицы, чей PRIMARY KEY раньше был только (user_id[, ...]) без учёта
# предмета (user_stats, user_hint_levels, activity_history, forecast_history,
# daily_progress), пересоздаются с subject в ключе — иначе вторая строка
# предмета упёрлась бы в конфликт. Остальные таблицы ключ уже разносят по
# id каталога (skill/task/lesson), уникальным в рамках предмета, поэтому им
# достаточно обычной колонки + индекса.
# Профиль внутри предмета (onboarded/self_level/goal) хранит user_subjects;
# колонки users.* остаются и дублируют профиль предмета profile_math ради
# совместимости прямых чтений БД. Имя (name) — глобальное свойство
# пользователя, в user_subjects не дублируется.
# ---------------------------------------------------------------------------
SUBJECT_SIMPLE_TABLES = (
    "user_progress", "task_attempts", "user_errors", "lesson_attempts",
    "lesson_step_errors", "lesson_error_history", "lesson_sessions",
    "completed_lessons", "user_missions", "user_bosses", "user_achievements",
    "timeline", "diagnostics", "user_xp_adjustments",
)

# table -> (new DDL, columns to copy from the old table in order)
_SUBJECT_PK_REBUILDS = {
    "user_stats": (
        """CREATE TABLE user_stats_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          xp INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
          last_active_date TEXT, total_solved INTEGER NOT NULL DEFAULT 0,
          total_correct INTEGER NOT NULL DEFAULT 0,
          total_time_sec REAL NOT NULL DEFAULT 0, hints_used INTEGER NOT NULL DEFAULT 0,
          correct_series INTEGER NOT NULL DEFAULT 0,
          best_series INTEGER NOT NULL DEFAULT 0, errors_resolved INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id, subject))""",
        ("user_id", "xp", "streak", "last_active_date", "total_solved",
         "total_correct", "total_time_sec", "hints_used", "correct_series",
         "best_series", "errors_resolved"),
    ),
    "user_hint_levels": (
        """CREATE TABLE user_hint_levels_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          level INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id, subject, level))""",
        ("user_id", "level", "used_count"),
    ),
    "activity_history": (
        """CREATE TABLE activity_history_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          activity_date TEXT NOT NULL, solved INTEGER NOT NULL,
          correct INTEGER NOT NULL, xp INTEGER NOT NULL,
          PRIMARY KEY(user_id, subject, activity_date))""",
        ("user_id", "activity_date", "solved", "correct", "xp"),
    ),
    "forecast_history": (
        """CREATE TABLE forecast_history_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          snapshot_date TEXT NOT NULL, low INTEGER NOT NULL,
          high INTEGER NOT NULL, mid INTEGER NOT NULL,
          PRIMARY KEY(user_id, subject, snapshot_date))""",
        ("user_id", "snapshot_date", "low", "high", "mid"),
    ),
    "daily_progress": (
        """CREATE TABLE daily_progress_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          progress_date TEXT NOT NULL, solved INTEGER NOT NULL,
          done INTEGER NOT NULL, task_ids_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(user_id, subject, progress_date))""",
        ("user_id", "progress_date", "solved", "done", "task_ids_json"),
    ),
}

_SUBJECT_SCHEMA_DONE: set[str] = set()


def _table_sql(conn: sqlite3.Connection, table: str) -> str:
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        return row["sql"] if row and row["sql"] else ""
    except sqlite3.Error:
        return ""


def _pk_has_subject(conn: sqlite3.Connection, table: str) -> bool:
    """True, когда PRIMARY KEY таблицы уже включает subject.

    Старые БД получили колонку subject через ALTER TABLE, но ключ остался
    (user_id, X): вторая запись предмета упёрлась бы в конфликт и затёрла бы
    первую. Проверяем именно DDL ключа, а не наличие колонки.
    """
    sql = _table_sql(conn, table).replace('"', "").replace("`", "").replace("[", "").replace("]", "")
    low = " ".join(sql.split()).lower()
    return "primary key(user_id, subject" in low or "primary key (user_id, subject" in low


# Пересоздание мутабельных таблиц с subject в PRIMARY KEY. Данные сохраняются
# (INSERT OR IGNORE из старой таблицы, subject по умолчанию — профиль).
_MUTABLE_PK_REBUILDS = {
    "user_progress": (
        """CREATE TABLE user_progress_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          skill_id TEXT NOT NULL REFERENCES skills(id),
          progress INTEGER NOT NULL DEFAULT 0, solved INTEGER NOT NULL DEFAULT 0,
          correct INTEGER NOT NULL DEFAULT 0, time_sec REAL NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id, subject, skill_id))""",
        ("user_id", "subject", "skill_id", "progress", "solved", "correct", "time_sec"),
    ),
    "lesson_step_errors": (
        """CREATE TABLE lesson_step_errors_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          lesson_id TEXT NOT NULL REFERENCES lessons(id), step_id TEXT NOT NULL,
          skill_id TEXT NOT NULL REFERENCES skills(id), count INTEGER NOT NULL,
          last_at TEXT NOT NULL, types_json TEXT NOT NULL,
          PRIMARY KEY(user_id, subject, lesson_id, step_id))""",
        ("user_id", "subject", "lesson_id", "step_id", "skill_id", "count", "last_at", "types_json"),
    ),
    "lesson_sessions": (
        """CREATE TABLE lesson_sessions_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          lesson_id TEXT NOT NULL REFERENCES lessons(id),
          session_json TEXT NOT NULL, PRIMARY KEY(user_id, subject, lesson_id))""",
        ("user_id", "subject", "lesson_id", "session_json"),
    ),
    "completed_lessons": (
        """CREATE TABLE completed_lessons_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          lesson_id TEXT NOT NULL REFERENCES lessons(id), completed_at TEXT NOT NULL,
          PRIMARY KEY(user_id, subject, lesson_id))""",
        ("user_id", "subject", "lesson_id", "completed_at"),
    ),
    "user_missions": (
        """CREATE TABLE user_missions_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          mission_id TEXT NOT NULL REFERENCES missions(id), progress INTEGER NOT NULL DEFAULT 0,
          completed_at TEXT, PRIMARY KEY(user_id, subject, mission_id))""",
        ("user_id", "subject", "mission_id", "progress", "completed_at"),
    ),
    "user_bosses": (
        """CREATE TABLE user_bosses_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          boss_id TEXT NOT NULL REFERENCES bosses(id), defeated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, subject, boss_id))""",
        ("user_id", "subject", "boss_id", "defeated_at"),
    ),
    "user_achievements": (
        """CREATE TABLE user_achievements_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          achievement_id TEXT NOT NULL REFERENCES achievements(id), unlocked_at TEXT NOT NULL,
          PRIMARY KEY(user_id, subject, achievement_id))""",
        ("user_id", "subject", "achievement_id", "unlocked_at"),
    ),
}

# Append-сущности с client-generated ID: один стабильный ключ на запись.
# Повторная отправка того же PUT/PATCH (даблклик, ретрай, таймаут) делает
# upsert по (user_id, subject, client_id), а не вставку новой строки.
IDEMPOTENT_APPEND_TABLES = (
    "task_attempts", "timeline", "lesson_attempts",
    "lesson_error_history", "diagnostics", "user_errors",
)
_IDEMPOTENT_UNIQUE_INDEX = {
    "task_attempts": "idx_task_attempts_user_subject_client",
    "timeline": "idx_timeline_user_subject_client",
    "lesson_attempts": "idx_lesson_attempts_user_subject_client",
    "lesson_error_history": "idx_lesson_error_history_user_subject_client",
    "diagnostics": "idx_diagnostics_user_subject_client",
    "user_errors": "idx_user_errors_user_subject_client",
}


def _stable_client_id(value) -> str | None:
    """Стабильный client-generated ID из payload, если клиент его прислал.

    Генерируется ОДИН раз на клиенте в момент создания сущности и
    переиспользуется при ретраях — никогда не генерируется заново на каждое
    сохранение. Сервер случайных ID не выдумывает.
    """
    if not isinstance(value, dict):
        return None
    for key in ("id", "clientId", "client_id"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            # Целочисленные server-side id ошибок (AUTOINCREMENT) — не путать
            # со строковыми UUID клиента.
            text = candidate.strip()
            if key == "id" and text.isdigit():
                continue
            return text[:128]
    return None


def _fallback_client_id(kind: str, parts: list) -> str:
    """Детерминированный ключ для legacy-payload без stable ID.

    Совпадает с прежней SELECT-дедупликацией по естественным полям, поэтому
    повтор старого клиента без UUID даёт тот же ключ и не плодит дубликаты.
    """
    safe = ["" if p is None else str(p) for p in parts]
    return ("natural:" + kind + ":" + "|".join(safe))[:512]


def _ensure_error_kind_column(conn: sqlite3.Connection) -> None:
    """Колонка вида ошибки для существующих БД (новые получают её из SCHEMA)."""
    if "kind" not in _table_columns(conn, "user_errors"):
        conn.execute("ALTER TABLE user_errors ADD COLUMN kind TEXT NOT NULL DEFAULT 'major'")


def _normalize_error_kind(value) -> str:
    """Вид ошибки: 'minor' — решено, но неидеально; всё остальное — 'major'.

    Старые записи и payload без kind считаются полными ошибками, поэтому
    расширение обратно совместимо в обе стороны.
    """
    return "minor" if str(value or "").strip().lower() == "minor" else "major"


def _serialize_error_row(row) -> dict:
    keys = row.keys()
    kind = _normalize_error_kind(row["kind"]) if "kind" in keys and row["kind"] else "major"
    return {"id": row["id"], "clientId": row["client_id"], "taskId": row["task_id"], "skill": row["skill_id"], "sub": row["topic"],
            "ts": timestamp_value(row["created_at"]), "resolved": bool(row["resolved"]), "kind": kind}


def _ensure_mutable_subject_pks(conn: sqlite3.Connection) -> None:
    # Пересоздание таблиц временно отключает FK-проверки: копируемые строки
    # заведомо приняты действующим сервером, а legacy-мусор (прогресс по
    # удалённому навыку) не должен ронять миграцию и терять остальные данные.
    # PRAGMA foreign_keys вне транзакции only: сначала фиксируем накопленное
    # (все шаги идемпотентны — частичная миграция безопасно продолжается).
    try:
        conn.commit()
    except sqlite3.Error:
        pass
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
    except sqlite3.Error:
        pass
    try:
        for table, (ddl, cols) in _MUTABLE_PK_REBUILDS.items():
            columns = _table_columns(conn, table)
            if not columns:
                continue
            if "subject" in columns and _pk_has_subject(conn, table):
                continue
            has_subject = "subject" in columns
            conn.execute(ddl)
            copy_cols = [c for c in cols if c in columns]
            if has_subject and set(copy_cols) >= set(cols):
                names = ", ".join(cols)
                conn.execute(f"INSERT OR IGNORE INTO {table}_new ({names}) SELECT {names} FROM {table}")
            else:
                # Старая таблица без subject: все строки относятся к профилю.
                rest_old = [c for c in cols if c != "subject" and c in columns]
                if rest_old:
                    names_new = ["user_id", "subject"] + [c for c in rest_old if c != "user_id"]
                    select = ["user_id", f"'{DEFAULT_SUBJECT}'"] + [c for c in rest_old if c != "user_id"]
                    conn.execute(f"INSERT OR IGNORE INTO {table}_new ({', '.join(names_new)}) "
                                 f"SELECT {', '.join(select)} FROM {table}")
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"ALTER TABLE {table}_new RENAME TO {table}")
            try:
                conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_user_subject ON {table}(user_id, subject)")
            except sqlite3.Error:
                pass
    finally:
        try:
            conn.execute("PRAGMA foreign_keys=ON")
        except sqlite3.Error:
            pass


def _backfill_append_client_ids(conn: sqlite3.Connection) -> None:
    """Выдаёт существующим строкам детерминированные client_id и вешает UNIQUE.

    Не теряет данные: каждая строка получает ключ от своих естественных полей
    (та же семантика, что у прежних SELECT-проверок); коллизии готовых
    дублей разруливаются суффиксом #<id>. Новые вставки идут через
    INSERT ... ON CONFLICT(user_id, subject, client_id) DO NOTHING — повторы
    безопасны даже при гонке, без DELETE+INSERT.
    """
    for table in IDEMPOTENT_APPEND_TABLES:
        columns = _table_columns(conn, table)
        if not columns:
            continue
        if "subject" not in columns:
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN subject TEXT NOT NULL DEFAULT '{DEFAULT_SUBJECT}'")
            except sqlite3.Error:
                pass
            columns = _table_columns(conn, table)
        if "client_id" not in columns:
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN client_id TEXT NOT NULL DEFAULT ''")
            except sqlite3.Error:
                pass
            columns = _table_columns(conn, table)
        if table == "task_attempts" and "closes_task_id" in columns:
            try:
                conn.execute("UPDATE task_attempts SET closes_task_id='' WHERE closes_task_id IS NULL")
            except sqlite3.Error:
                pass
        # Backfill пустых client_id детерминированными ключами.
        try:
            rows = list(conn.execute(f"SELECT * FROM {table} WHERE client_id='' OR client_id IS NULL"))
        except sqlite3.Error:
            continue
        seen: set[tuple] = set()
        try:
            existing = {tuple(r) for r in conn.execute(
                f"SELECT user_id, subject, client_id FROM {table} WHERE client_id!=''")}
        except sqlite3.Error:
            existing = set()
        for row in rows:
            row = dict(row)
            uid, subj = row.get("user_id"), row.get("subject") or DEFAULT_SUBJECT
            if table == "task_attempts":
                try:
                    seconds_norm = str(float(row.get("seconds") or 0))
                except (TypeError, ValueError):
                    seconds_norm = "0.0"
                fallback = _fallback_client_id("attempt", [
                    row.get("task_id"), row.get("skill_id"), row.get("correct"),
                    row.get("hint_level"), seconds_norm,
                    row.get("closes_task_id") or "", row.get("created_at")])
            elif table == "timeline":
                fallback = _fallback_client_id("timeline", [row.get("created_at"), row.get("text")])
            elif table == "lesson_attempts":
                fallback = _fallback_client_id("lesson_attempt", [row.get("lesson_id"), row.get("created_at")])
            elif table == "lesson_error_history":
                fallback = _fallback_client_id("lesson_error", [
                    row.get("lesson_id"), row.get("step_id"),
                    row.get("error_type"), row.get("created_at")])
            elif table == "diagnostics":
                fallback = _fallback_client_id("diagnostic", [row.get("task_id"), row.get("created_at")])
            else:  # user_errors
                fallback = _fallback_client_id("error", [
                    row.get("task_id"), row.get("skill_id"), row.get("created_at")])
            candidate = fallback
            if (uid, subj, candidate) in existing or (uid, subj, candidate) in seen:
                candidate = f"{fallback}#{row.get('id')}"
            seen.add((uid, subj, candidate))
            try:
                conn.execute(f"UPDATE {table} SET client_id=? WHERE id=?", (candidate, row.get("id")))
            except sqlite3.Error:
                pass
        index = _IDEMPOTENT_UNIQUE_INDEX[table]
        try:
            conn.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS {index} ON {table}(user_id, subject, client_id)")
        except sqlite3.Error:
            pass


def _table_columns(conn: sqlite3.Connection, table: str) -> set:
    try:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _db_key(conn: sqlite3.Connection) -> str:
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
        return row["file"] or ":memory:" if row else ":memory:"
    except sqlite3.Error:
        return ":memory:"


def ensure_subject_schema(conn: sqlite3.Connection) -> None:
    """Идемпотентная миграция под мультипредметность. Дешёвая при повторе."""
    key = _db_key(conn)
    if key in _SUBJECT_SCHEMA_DONE:
        return
    conn.executescript(SCHEMA)
    # Каталог: предметная принадлежность навыков и категорий. Старые строки —
    # профиль по умолчанию; у базовой математики своих строк пока нет.
    for table in ("skills", "topics"):
        if "subject" not in _table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN subject TEXT NOT NULL DEFAULT '{DEFAULT_SUBJECT}'")
    # Пользователь: текущий предмет + пер-профильные предметные профили.
    if "current_subject" not in _table_columns(conn, "users"):
        conn.execute(f"ALTER TABLE users ADD COLUMN current_subject TEXT NOT NULL DEFAULT '{DEFAULT_SUBJECT}'")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_subjects (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL, onboarded INTEGER NOT NULL DEFAULT 0,
      self_level TEXT, goal_id TEXT, state_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(user_id, subject))""")
    # Backfill: существующие аккаунты уже прошли онбординг профиля.
    conn.execute(f"""INSERT OR IGNORE INTO user_subjects(user_id, subject, onboarded, self_level, goal_id)
      SELECT id, '{DEFAULT_SUBJECT}', onboarded, self_level, goal_id FROM users""")
    # Таблицы с точным ключом по предмету — пересоздание с subject в PK.
    for table, (ddl, cols) in _SUBJECT_PK_REBUILDS.items():
        columns = _table_columns(conn, table)
        if "subject" in columns:
            continue
        copy_cols = [c for c in cols if c in columns]
        conn.execute(ddl)
        if copy_cols:
            # Явная вставка: user_id + дефолтный subject + остальные колонки.
            rest = ", ".join(copy_cols[1:])
            conn.execute(f"INSERT OR IGNORE INTO {table}_new (user_id, subject, {rest}) "
                         f"SELECT user_id, '{DEFAULT_SUBJECT}', {rest} FROM {table}")
        conn.execute(f"DROP TABLE {table}")
        conn.execute(f"ALTER TABLE {table}_new RENAME TO {table}")
    # Остальные пользовательские таблицы — обычная колонка + индекс.
    for table in SUBJECT_SIMPLE_TABLES:
        if "subject" not in _table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN subject TEXT NOT NULL DEFAULT '{DEFAULT_SUBJECT}'")
        try:
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_user_subject ON {table}(user_id, subject)")
        except sqlite3.Error:
            pass
    # Мини-ошибки: вид ошибки ('major' — задание не решено, 'minor' — решено,
    # но неидеально). Существующие БД получают колонку на месте, новые — из
    # SCHEMA. Отсутствующий kind всегда читается как 'major', поэтому старые
    # записи и старые клиенты остаются полными ошибками без миграции данных.
    _ensure_error_kind_column(conn)
    # Activity is now event-sourced. Existing daily aggregates are preserved
    # and backfilled once as seed events, so no historical graph disappears.
    conn.execute("""CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT 'profile_math', activity_date TEXT NOT NULL,
      solved INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0,
      xp INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, event_key TEXT NOT NULL DEFAULT '')""")
    if "event_key" not in _table_columns(conn, "activity_events"):
        conn.execute("ALTER TABLE activity_events ADD COLUMN event_key TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_user_subject_key ON activity_events(user_id, subject, event_key)")
    conn.execute("""INSERT OR IGNORE INTO activity_events(user_id, subject, activity_date, solved, correct, xp, created_at, event_key)
      SELECT h.user_id, h.subject, h.activity_date, h.solved, h.correct, h.xp, h.activity_date || ':legacy', 'legacy:' || h.activity_date
      FROM activity_history h""")
    # OCC: добавляем state_version в user_subjects для защиты от stale writes
    if "state_version" not in _table_columns(conn, "user_subjects"):
        try:
            conn.execute("ALTER TABLE user_subjects ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1")
        except sqlite3.Error:
            pass
    # Системная идемпотентность: subject в PK мутабельных таблиц + стабильные
    # client_id с UNIQUE для append-сущностей. Миграции идемпотентны, данные
    # сохраняются (пересоздание через INSERT OR IGNORE, backfill ключей).
    _ensure_mutable_subject_pks(conn)
    _backfill_append_client_ids(conn)
    conn.commit()
    _SUBJECT_SCHEMA_DONE.add(key)


def install_catalog(conn: sqlite3.Connection) -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    conn.executescript(SCHEMA)
    ensure_subject_schema(conn)
    # Existing SQLite files need the new daily selection column migrated in place.
    daily_columns = {row["name"] for row in conn.execute("PRAGMA table_info(daily_progress)")}
    if "task_ids_json" not in daily_columns:
        conn.execute("ALTER TABLE daily_progress ADD COLUMN task_ids_json TEXT NOT NULL DEFAULT '[]'")
    # Existing accounts predate the display-name step; they keep a NULL name
    # until the user sets one, rather than being forced through onboarding again.
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "name" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN name TEXT")
    # Existing accounts predate the account_id column; ALTER TABLE cannot add a
    # UNIQUE column in place, so the constraint is added as a separate unique
    # index and every account missing an id gets one assigned right away
    # (not lazily), so the column is effectively always populated.
    if "account_id" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN account_id TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id)")
    for row in conn.execute("SELECT id FROM users WHERE account_id IS NULL"):
        assign_account_id(conn, row["id"])
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
    # Базовая математика: отдельный файл-источник. Грузится в те же таблицы
    # со subject='basic_math', поэтому в API отдаётся тем же кодом, что профиль
    # (catalog_payload): полноценный предмет, а не надстройка.
    # achievements/visualAssets/visualAudit — общие, их не трогаем.
    if CATALOG_BASIC_PATH.exists():
        basic = json.loads(CATALOG_BASIC_PATH.read_text(encoding="utf-8"))
        for cat in basic.get("categories", []):
            conn.execute("INSERT OR IGNORE INTO topics(id, subject_id, name, short, subject) VALUES (?, 'math', ?, ?, 'basic_math')",
                         (cat["id"], cat["name"], cat.get("short")))
        for skill in basic.get("skills", []):
            conn.execute("""INSERT OR IGNORE INTO skills(id, topic_id, level_id, name, display_order, ege, subject)
                           VALUES (?, ?, 'basic', ?, ?, ?, 'basic_math')""",
                         (skill["id"], skill["cat"], skill["name"], skill["order"], skill.get("ege")))
        for task in basic.get("tasks", []):
            metadata = dict(task)
            for key in ("id", "skill", "sub", "num", "diff", "text", "answer", "hint", "solution"):
                metadata.pop(key, None)
            conn.execute("""INSERT INTO tasks
              (id, skill_id, topic, exam_number, difficulty, statement, answer, explanation, hint, task_type, metadata_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id,topic=excluded.topic,exam_number=excluded.exam_number,difficulty=excluded.difficulty,statement=excluded.statement,answer=excluded.answer,explanation=excluded.explanation,hint=excluded.hint,task_type=excluded.task_type,metadata_json=excluded.metadata_json""", (
                task["id"], task["skill"], task["sub"], task.get("num"), task["diff"], task["text"], task["answer"],
                task["solution"], task.get("hint") or (task.get("hints") or [None])[0], task.get("type", "short_answer"), json.dumps(metadata, ensure_ascii=False)))
        for lesson in basic.get("lessons", []):
            conn.execute("INSERT INTO lessons(id, skill_id, title, xp, metadata_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id,title=excluded.title,xp=excluded.xp,metadata_json=excluded.metadata_json",
                         (lesson["id"], lesson["skill"], lesson["title"], lesson.get("xp", 0), json.dumps(lesson, ensure_ascii=False)))
        for mission in basic.get("missions", []):
            conn.execute("INSERT INTO missions(id, skill_id, title, description, xp, difficulty) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id,title=excluded.title,description=excluded.description,xp=excluded.xp,difficulty=excluded.difficulty",
                         (mission["id"], mission["skill"], mission["title"], mission["desc"], mission["xp"], mission["diff"]))
        for boss in basic.get("bosses", []):
            conn.execute("INSERT OR IGNORE INTO bosses(id, topic_id, title, description, task_count, xp, unlock_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (boss["id"], boss["cat"], boss["title"], boss["desc"], boss["size"], boss["xp"], boss["unlockAt"]))
        # Синхронизация состава: файл — источник истины. INSERT OR IGNORE выше
        # не удаляет миссии/боссов/уроки, убранные из файла, и не урезает
        # mission_tasks ужатых миссий — чистим orphan-строки строго в пределах
        # subject='basic_math', профильные данные не трогаем.
        basic_skill_ids = [s["id"] for s in basic.get("skills", [])]
        basic_cat_ids = [c["id"] for c in basic.get("categories", [])]
        if basic_skill_ids:
            keep_lessons = [le["id"] for le in basic.get("lessons", [])]
            if keep_lessons:
                conn.execute(
                    f"DELETE FROM lessons WHERE skill_id IN ({','.join('?' * len(basic_skill_ids))}) AND id NOT IN ({','.join('?' * len(keep_lessons))})",
                    (*basic_skill_ids, *keep_lessons))
            else:
                conn.execute(
                    f"DELETE FROM lessons WHERE skill_id IN ({','.join('?' * len(basic_skill_ids))})",
                    basic_skill_ids)
            keep_missions = [m["id"] for m in basic.get("missions", [])]
            if keep_missions:
                conn.execute(
                    f"DELETE FROM missions WHERE skill_id IN ({','.join('?' * len(basic_skill_ids))}) AND id NOT IN ({','.join('?' * len(keep_missions))})",
                    (*basic_skill_ids, *keep_missions))
                # Ужатые миссии: пересобрать связи точно по файлу.
                conn.execute(
                    f"DELETE FROM mission_tasks WHERE mission_id IN ({','.join('?' * len(keep_missions))})",
                    keep_missions)
                for mission in basic.get("missions", []):
                    for order, task_id in enumerate(mission.get("tasks", [])):
                        conn.execute("INSERT INTO mission_tasks(mission_id, task_id, display_order) VALUES (?, ?, ?)",
                                     (mission["id"], task_id, order))
            else:
                conn.execute(
                    f"DELETE FROM missions WHERE skill_id IN ({','.join('?' * len(basic_skill_ids))})",
                    basic_skill_ids)
        if basic_cat_ids:
            keep_bosses = [b["id"] for b in basic.get("bosses", [])]
            if keep_bosses:
                conn.execute(
                    f"DELETE FROM bosses WHERE topic_id IN ({','.join('?' * len(basic_cat_ids))}) AND id NOT IN ({','.join('?' * len(keep_bosses))})",
                    (*basic_cat_ids, *keep_bosses))
            else:
                conn.execute(
                    f"DELETE FROM bosses WHERE topic_id IN ({','.join('?' * len(basic_cat_ids))})",
                    basic_cat_ids)
        conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('daily:basic_math', ?)", (json.dumps(basic.get("daily", _empty_daily()), ensure_ascii=False),))
        conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('diagnosticTasks:basic_math', ?)", (json.dumps(basic.get("diagnosticTasks", []), ensure_ascii=False),))
        if basic.get("goals"):
            conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('goals:basic_math', ?)", (json.dumps(basic["goals"], ensure_ascii=False),))
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
    # Предметные копии конфигов: новый предмет подключается своими ключами
    # `daily:<subject>` / `diagnosticTasks:<subject>`, legacy-ключи остаются
    # фолбэком. Пустым предметам контент не выдумываем — кладём честное пусто.
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('daily:profile_math', ?)", (json.dumps(catalog["daily"], ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('goals:profile_math', ?)", (json.dumps(catalog["goals"], ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('diagnosticTasks:profile_math', ?)", (json.dumps(catalog["diagnosticTasks"], ensure_ascii=False),))
    if not CATALOG_BASIC_PATH.exists():
        conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('daily:basic_math', ?)", (json.dumps(_empty_daily(), ensure_ascii=False),))
        conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('diagnosticTasks:basic_math', ?)", (json.dumps([], ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('visualAssets', ?)", (json.dumps(catalog.get("visualAssets", []), ensure_ascii=False),))
    conn.execute("INSERT OR REPLACE INTO app_config(key, value_json) VALUES ('visualAudit', ?)", (json.dumps(catalog.get("visualAudit", {}), ensure_ascii=False),))
    conn.commit()
    _CATALOG_CACHE["generation"] += 1
    invalidate_catalog_cache()


def task_has_missing_visual(item: dict) -> bool:
    """Задание требует обязательный официальный рисунок, которого нет в сборке.
    Такое задание физически нерешаемо — оно остаётся в каталоге для аудита,
    но никогда не выдаётся обычному пользователю (зеркало DataAPI.taskHasMissingVisual)."""
    vis = item.get("visual")
    return bool(vis and vis.get("required") and not vis.get("assetId"))


def _subject_config(conn: sqlite3.Connection, key: str, subject: str, default, allow_legacy: bool = True):
    """Конфиг предмета: сначала `key:subject`, затем legacy `key` (если разрешён)."""
    row = conn.execute("SELECT value_json FROM app_config WHERE key=?", (f"{key}:{subject}",)).fetchone()
    if row:
        return json.loads(row["value_json"])
    if allow_legacy:
        row = conn.execute("SELECT value_json FROM app_config WHERE key=?", (key,)).fetchone()
        if row:
            return json.loads(row["value_json"])
    return default


def _empty_daily() -> dict:
    return {"skill": "", "target": 0, "xp": 0, "title": ""}


def _build_catalog_payload(conn: sqlite3.Connection, subject: str) -> dict:
    subject = resolve_subject(subject)
    skill_rows = list(conn.execute(
        "SELECT id, name, topic_id, display_order, ege FROM skills WHERE subject=? ORDER BY topic_id, display_order",
        (subject,)))
    skill_subject = {r["id"]: subject for r in skill_rows}
    skills = [{"id": r["id"], "name": r["name"], "cat": r["topic_id"], "order": r["display_order"], "ege": r["ege"]}
              for r in skill_rows]
    categories = [dict(r) for r in conn.execute("SELECT id, name, short FROM topics WHERE subject=? ORDER BY rowid", (subject,))]
    tasks = []
    blocked_ids = set()
    for r in conn.execute("SELECT * FROM tasks ORDER BY id"):
        if skill_subject.get(r["skill_id"]) != subject:
            continue
        meta = json.loads(r["metadata_json"] or "{}")
        item = {"id": r["id"], "skill": r["skill_id"], "sub": r["topic"], "num": r["exam_number"], "diff": r["difficulty"],
                "text": r["statement"], "answer": r["answer"], "hint": r["hint"], "solution": r["explanation"]}
        item.update(meta)
        # Нерешаемые задачи (обязательный рисунок отсутствует) не отдаются
        # обычному пользователю вообще — ни в каталоге, ни косвенно. Админ
        # получает их отдельным /api/admin/blocked-tasks.
        if task_has_missing_visual(item):
            blocked_ids.add(r["id"])
            continue
        tasks.append(item)
    lesson_rows = list(conn.execute("SELECT skill_id, metadata_json FROM lessons ORDER BY id"))
    lessons = [json.loads(r["metadata_json"]) for r in lesson_rows
               if skill_subject.get(r["skill_id"]) == subject]
    # Один запрос вместо N+1 (по одному SELECT на миссию): каталог собирается
    # на каждый bootstrap, и лишний round-trip в SQLite на миссию — чистое
    # время ожидания безо всякой пользы.
    mission_task_rows: dict[str, list] = {}
    for x in conn.execute("SELECT mission_id, task_id FROM mission_tasks ORDER BY mission_id, display_order"):
        mission_task_rows.setdefault(x["mission_id"], []).append(x["task_id"])
    topic_ids = {c["id"] for c in categories}
    missions = []
    for r in conn.execute("SELECT * FROM missions ORDER BY id"):
        if skill_subject.get(r["skill_id"]) != subject:
            continue
        tasks_for_mission = [tid for tid in mission_task_rows.get(r["id"], []) if tid not in blocked_ids]
        missions.append({"id": r["id"], "title": r["title"], "desc": r["description"], "skill": r["skill_id"], "tasks": tasks_for_mission, "xp": r["xp"], "diff": r["difficulty"]})
    bosses = [{"id": r["id"], "title": r["title"], "cat": r["topic_id"], "desc": r["description"], "size": r["task_count"], "xp": r["xp"], "unlockAt": r["unlock_at"]}
              for r in conn.execute("SELECT * FROM bosses ORDER BY id") if r["topic_id"] in topic_ids]
    achievements = [{"id": r["id"], "name": r["name"], "desc": r["description"], "icon": r["icon"]}
                    for r in conn.execute("SELECT * FROM achievements ORDER BY rowid")]
    daily = _subject_config(conn, "daily", subject, _empty_daily())
    # Цели — шкала конкретного предмета: чужие баллы не подсовываем.
    # Legacy-фолбэк оставлен только профилю (его ключи писались до предметов).
    goals = _subject_config(conn, "goals", subject, [], subject == DEFAULT_SUBJECT)
    diagnostics = _subject_config(conn, "diagnosticTasks", subject, [])
    config = {r["key"]: json.loads(r["value_json"]) for r in conn.execute("SELECT key, value_json FROM app_config")}
    return {"subjects": subjects_payload(), "subject": subject, "forecast": SUBJECTS[subject]["forecast"],
            "categories": categories, "skills": skills, "tasks": tasks, "lessons": lessons, "missions": missions,
            "bosses": bosses, "achievements": achievements, "daily": daily, "goals": goals,
            "diagnosticTasks": diagnostics, "visualAssets": config.get("visualAssets", []),
            "visualAudit": config.get("visualAudit", {})}


# Кэш каталога в памяти процесса: полный payload собирается из SQLite на
# каждый bootstrap (~20 SQL-запросов), хотя меняется только при
# install_catalog (старт сервера). Ключ — mtime catalog.json + generation,
# который растёт при каждом install_catalog в этом процессе. Пейлоады лежат
# отдельно на предмет — предметы не пересекаются по данным.
_CATALOG_CACHE: dict = {"key": None, "payloads": {}, "generation": 0}


def _catalog_cache_key() -> tuple:
    try:
        mtime = CATALOG_PATH.stat().st_mtime_ns
    except OSError:
        mtime = 0
    try:
        basic_mtime = CATALOG_BASIC_PATH.stat().st_mtime_ns
    except OSError:
        basic_mtime = 0
    return (mtime, basic_mtime, _CATALOG_CACHE["generation"])


def catalog_payload(conn: sqlite3.Connection, subject: str | None = None) -> dict:
    """Полный каталог предмета (совместимость: /api/bootstrap и тесты). Кэшируется."""
    subject = resolve_subject(subject)
    key = _catalog_cache_key()
    if _CATALOG_CACHE["key"] != key:
        _CATALOG_CACHE["key"] = key
        _CATALOG_CACHE["payloads"] = {}
    cached = _CATALOG_CACHE["payloads"].get(subject)
    if cached is None:
        cached = _build_catalog_payload(conn, subject)
        _CATALOG_CACHE["payloads"][subject] = cached
    return cached


def invalidate_catalog_cache() -> None:
    _CATALOG_CACHE["key"] = None
    _CATALOG_CACHE["payloads"] = {}


def catalog_summary_payload(conn: sqlite3.Connection, subject: str | None = None) -> dict:
    """Лёгкий каталог для первой отрисовки (~20 КБ вместо ~280 КБ).

    Задачи — только заглушки id/skill (счётчики и выборки по теме работают,
    тексты/ответы/разборы не грузятся). Уроки — мета без шагов.
    Тяжёлые visualAssets/visualAudit едут вместе с полными задачами.
    """
    full = catalog_payload(conn, subject)
    return {
        "subjects": full["subjects"], "subject": full["subject"], "forecast": full["forecast"],
        "categories": full["categories"], "skills": full["skills"],
        "missions": full["missions"], "bosses": full["bosses"],
        "achievements": full["achievements"], "daily": full["daily"],
        "goals": full["goals"], "diagnosticTasks": full["diagnosticTasks"],
        "tasks": [{"id": t["id"], "skill": t["skill"], "sub": t.get("sub"),
                   "num": t.get("num"), "diff": t.get("diff"), "_stub": True}
                  for t in full["tasks"]],
        "lessons": [{"id": le["id"], "skill": le["skill"], "title": le["title"],
                     "xp": le.get("xp", 0),
                     "stepsCount": len(le.get("steps") or []), "_meta": True}
                    for le in full["lessons"]],
    }


def catalog_tasks_payload(conn: sqlite3.Connection, subject: str | None = None) -> dict:
    """Полные задачи + визуальные ассеты (ленивая подгрузка)."""
    full = catalog_payload(conn, subject)
    return {"tasks": full["tasks"], "visualAssets": full["visualAssets"],
            "visualAudit": full["visualAudit"]}


def catalog_lessons_payload(conn: sqlite3.Connection, subject: str | None = None) -> dict:
    """Полные уроки с шагами (ленивая подгрузка)."""
    return {"lessons": catalog_payload(conn, subject)["lessons"]}


def _plural_ru(count: int, one: str, few: str, many: str) -> str:
    """Русская плюрализация для счётчиков публичного статуса. Никогда не бросает."""
    try:
        n = abs(int(count))
    except (TypeError, ValueError):
        n = 0
    last_two = n % 100
    last = n % 10
    if last == 1 and last_two != 11:
        return one
    if 2 <= last <= 4 and not 12 <= last_two <= 14:
        return few
    return many


def _status_file_mtime_ms(path: Path) -> int:
    try:
        return int(path.stat().st_mtime * 1000)
    except OSError:
        return 0


def _build_public_status(conn: sqlite3.Connection) -> dict:
    """Честный публичный срез для страницы /status.

    Только SELECT, без заведения аккаунта и миграций: недоступная таблица —
    это «сервис недоступен», а не повод что-то чинить за пользователя.
    Наружу уходят лишь имена предметов/тем и счётчики каталога — никаких
    текстов заданий, ответов, пользовательских данных, путей или env.
    """
    now_ms = int(time.time() * 1000)
    try:
        conn.execute("SELECT 1").fetchone()
        db_ok = True
    except sqlite3.Error:
        db_ok = False
    try:
        # Только факт доступности хранилища сессий — без подсчёта чужих сессий.
        conn.execute("SELECT 1 FROM user_sessions LIMIT 1").fetchone()
        auth_ok = True
    except sqlite3.Error:
        auth_ok = False

    subjects: list[dict] = []
    total_skills = total_tasks = total_lessons = total_missions = total_bosses = 0
    diagnostics_any = False
    for sid in SUBJECT_IDS:
        info = SUBJECTS[sid]
        try:
            skill_rows = list(conn.execute(
                "SELECT id, name, topic_id, ege FROM skills WHERE subject=? ORDER BY display_order", (sid,)))
        except sqlite3.Error:
            skill_rows = []
        try:
            categories = [dict(id=r["id"], name=r["name"], short=r["short"])
                          for r in conn.execute("SELECT id, name, short FROM topics WHERE subject=? ORDER BY rowid", (sid,))]
        except sqlite3.Error:
            categories = []
        cat_ids = {c["id"] for c in categories}
        # Доступные задания = все минус нерешаемые без официального рисунка
        # (тот же предикат, что прячет их от учеников в каталоге).
        available_by_skill: dict[str, int] = {}
        blocked_by_skill: dict[str, int] = {}
        visuals_by_skill: dict[str, int] = {}
        skill_ids = {r["id"] for r in skill_rows}
        try:
            task_rows = list(conn.execute(
                "SELECT t.id, t.skill_id, t.metadata_json FROM tasks t "
                "JOIN skills s ON s.id=t.skill_id WHERE s.subject=?", (sid,)))
        except sqlite3.Error:
            task_rows = []
        diag_task_ids: set[str] = set()
        try:
            diag_list = _subject_config(conn, "diagnosticTasks", sid, [], sid == DEFAULT_SUBJECT)
            if isinstance(diag_list, list):
                diag_task_ids = {str(x) for x in diag_list if isinstance(x, str)}
        except (sqlite3.Error, ValueError, TypeError):
            diag_task_ids = set()
        task_skill: dict[str, str] = {}
        subj_tasks = subj_blocked = subj_visuals = 0
        for tr in task_rows:
            try:
                meta = json.loads(tr["metadata_json"] or "{}")
            except (ValueError, TypeError):
                meta = {}
            if not isinstance(meta, dict):
                meta = {}
            item = {"id": tr["id"]}
            item.update(meta)
            task_skill[str(tr["id"])] = str(tr["skill_id"])
            if task_has_missing_visual(item):
                blocked_by_skill[str(tr["skill_id"])] = blocked_by_skill.get(str(tr["skill_id"]), 0) + 1
                subj_blocked += 1
                continue
            available_by_skill[str(tr["skill_id"])] = available_by_skill.get(str(tr["skill_id"]), 0) + 1
            subj_tasks += 1
            if meta.get("mathVisual"):
                visuals_by_skill[str(tr["skill_id"])] = visuals_by_skill.get(str(tr["skill_id"]), 0) + 1
                subj_visuals += 1
        diag_skills = {task_skill[tid] for tid in diag_task_ids if tid in task_skill}
        if diag_task_ids:
            diagnostics_any = True
        try:
            lesson_rows = list(conn.execute(
                "SELECT l.skill_id AS skill_id, l.metadata_json AS metadata_json FROM lessons l "
                "JOIN skills s ON s.id=l.skill_id WHERE s.subject=?", (sid,)))
        except sqlite3.Error:
            lesson_rows = []
        lesson_by_skill: dict[str, dict] = {}
        for lr in lesson_rows:
            try:
                lesson_meta = json.loads(lr["metadata_json"] or "{}")
            except (ValueError, TypeError):
                lesson_meta = {}
            steps = lesson_meta.get("steps") if isinstance(lesson_meta, dict) else None
            lesson_by_skill[str(lr["skill_id"])] = {
                "title": lesson_meta.get("title") if isinstance(lesson_meta, dict) else None,
                "steps": len(steps) if isinstance(steps, list) else 0,
            }
        try:
            mission_rows = list(conn.execute(
                "SELECT m.skill_id AS skill_id FROM missions m "
                "JOIN skills s ON s.id=m.skill_id WHERE s.subject=?", (sid,)))
        except sqlite3.Error:
            mission_rows = []
        missions_by_skill: dict[str, int] = {}
        for mr in mission_rows:
            missions_by_skill[str(mr["skill_id"])] = missions_by_skill.get(str(mr["skill_id"]), 0) + 1
        subj_missions = len(mission_rows)
        subj_bosses = 0
        try:
            for br in conn.execute("SELECT topic_id FROM bosses"):
                if br["topic_id"] in cat_ids:
                    subj_bosses += 1
        except sqlite3.Error:
            subj_bosses = 0
        skills: list[dict] = []
        for sr in skill_rows:
            skid = str(sr["id"])
            tasks_n = available_by_skill.get(skid, 0)
            lesson = lesson_by_skill.get(skid)
            if tasks_n > 0:
                skill_status = "available"
            elif lesson:
                # Теория есть, а практика временно недоступна (например, все
                # задания темы ждут официальный рисунок) — показываем честно.
                skill_status = "limited"
            else:
                skill_status = "empty"
            skills.append({
                "id": skid,
                "name": sr["name"],
                "ege": sr["ege"],
                "category": sr["topic_id"],
                "status": skill_status,
                "tasks": tasks_n,
                "blockedTasks": blocked_by_skill.get(skid, 0),
                "lesson": bool(lesson),
                "lessonTitle": (lesson or {}).get("title"),
                "lessonSteps": (lesson or {}).get("steps", 0),
                "practice": tasks_n > 0,
                "missions": missions_by_skill.get(skid, 0),
                "visuals": visuals_by_skill.get(skid, 0),
                "inDiagnostics": skid in diag_skills,
            })
        subj_lessons = len(lesson_rows)
        if info.get("status") != "ready" or not skills:
            subject_status = "empty"
        elif all(s["status"] == "available" for s in skills):
            subject_status = "available"
        elif subj_tasks > 0:
            subject_status = "partial"
        else:
            subject_status = "empty"
        for c in categories:
            c["skills"] = sum(1 for s in skills if s["category"] == c["id"])
        subjects.append({
            "id": sid,
            "title": info.get("title", sid),
            "short": info.get("short", sid),
            "status": subject_status,
            "features": dict(info.get("features", {})),
            "categories": categories,
            "skills": skills,
            "counts": {
                "skills": len(skills),
                "tasks": subj_tasks,
                "blockedTasks": subj_blocked,
                "lessons": subj_lessons,
                "missions": subj_missions,
                "bosses": subj_bosses,
                "diagnostics": len(diag_task_ids),
                "visuals": subj_visuals,
            },
        })
        total_skills += len(skills)
        total_tasks += subj_tasks
        total_lessons += subj_lessons
        total_missions += subj_missions
        total_bosses += subj_bosses
    content_updated = max(_status_file_mtime_ms(CATALOG_PATH), _status_file_mtime_ms(CATALOG_BASIC_PATH))
    services = [
        {"id": "api", "label": "API", "ok": True, "detail": "Отвечает"},
        {"id": "database", "label": "База данных", "ok": db_ok,
         "detail": "Доступна" if db_ok else "Не удалось проверить"},
        {"id": "auth", "label": "Авторизация", "ok": auth_ok,
         "detail": "Доступна" if auth_ok else "Не удалось проверить"},
        {"id": "tasks", "label": "Задания", "ok": db_ok and total_tasks > 0,
         "detail": f"Доступно: {total_tasks} {_plural_ru(total_tasks, 'задание', 'задания', 'заданий')}"
                   if db_ok and total_tasks > 0 else "Не удалось проверить"},
        {"id": "lessons", "label": "Уроки", "ok": db_ok and total_lessons > 0,
         "detail": f"{total_lessons} {_plural_ru(total_lessons, 'урок', 'урока', 'уроков')}"
                   if db_ok and total_lessons > 0 else "Не удалось проверить"},
        {"id": "diagnostics", "label": "Диагностика", "ok": db_ok and diagnostics_any,
         "detail": "Доступна" if db_ok and diagnostics_any else "Не удалось проверить"},
    ]
    overall = "ok" if all(s["ok"] for s in services) else "degraded"
    return {
        "ok": overall == "ok",
        "now": now_ms,
        "overall": overall,
        "services": services,
        "subjects": subjects,
        "totals": {"subjects": len(subjects), "skills": total_skills, "tasks": total_tasks,
                   "lessons": total_lessons, "missions": total_missions, "bosses": total_bosses},
        "contentUpdatedAt": content_updated or None,
    }


def public_status_payload(conn: sqlite3.Connection) -> dict:
    """Обёртка без исключений: статус-страница показывает деградацию, а не 500."""
    try:
        return _build_public_status(conn)
    except Exception:
        return {
            "ok": False, "now": int(time.time() * 1000), "overall": "unknown",
            "services": [
                {"id": "api", "label": "API", "ok": True, "detail": "Отвечает"},
                {"id": "database", "label": "База данных", "ok": False, "detail": "Не удалось проверить"},
            ],
            "subjects": [],
            "totals": {"subjects": 0, "skills": 0, "tasks": 0, "lessons": 0, "missions": 0, "bosses": 0},
            "contentUpdatedAt": None,
        }


# Мягкий антиспам для публичного /api/status: лимит щедрый (60 запросов в
# минуту с IP), обычный пользователь — даже с частым ручным обновлением —
# его никогда не заметит. Превышение отдаёт 429 с Retry-After, а не данные:
# страница при этом показывает уже загруженное, а не ошибку. Тот же in-memory
# паттерн скользящего окна, что у login-guard выше.
STATUS_RATE_MAX = 60
STATUS_RATE_WINDOW_SEC = 60.0
_status_hits: dict[str, list[float]] = {}
_status_lock = threading.Lock()


def status_rate_ok(ip: str) -> bool:
    """True, если с IP ещё можно отдавать статус. Никогда не бросает."""
    try:
        now = time.time()
        key = str(ip or "?")
        with _status_lock:
            recent = [t for t in _status_hits.get(key, []) if now - t < STATUS_RATE_WINDOW_SEC]
            if len(recent) >= STATUS_RATE_MAX:
                _status_hits[key] = recent
                return False
            recent.append(now)
            _status_hits[key] = recent
            return True
    except Exception:
        return True


def current_subject_for(conn: sqlite3.Connection, user_id: int) -> str:
    """Текущий предмет пользователя. Неизвестное значение чинится в дефолт."""
    cols = _table_columns(conn, "users")
    if "current_subject" not in cols:
        return DEFAULT_SUBJECT
    row = conn.execute("SELECT current_subject FROM users WHERE id=?", (user_id,)).fetchone()
    return resolve_subject(row["current_subject"] if row else None)


def ensure_subject_rows(conn: sqlite3.Connection, user_id: int, subject: str) -> None:
    """Лениво заводит пер-предметные строки: профиль и счётчики."""
    subject = resolve_subject(subject)
    cols = _table_columns(conn, "users")
    if "current_subject" in cols:
        cur = conn.execute("SELECT current_subject FROM users WHERE id=?", (user_id,)).fetchone()
        if not cur or not is_known_subject(cur["current_subject"]):
            conn.execute("UPDATE users SET current_subject=? WHERE id=?", (subject, user_id))
    row = conn.execute("SELECT onboarded FROM users WHERE id=?", (user_id,)).fetchone()
    if row:
        if subject == DEFAULT_SUBJECT:
            # Существующие аккаунты уже прошли онбординг профиля — переносим.
            conn.execute(
                "INSERT OR IGNORE INTO user_subjects(user_id, subject, onboarded, self_level, goal_id)"
                " SELECT id, ?, onboarded, self_level, goal_id FROM users WHERE id=?",
                (subject, user_id))
        else:
            # Новый предмет всегда начинается с чистого профиля, даже если
            # в users.onboarded уже стоит флаг другого предмета.
            conn.execute(
                "INSERT OR IGNORE INTO user_subjects(user_id, subject, onboarded, self_level, goal_id)"
                " VALUES (?, ?, 0, NULL, NULL)",
                (user_id, subject))
    conn.execute("INSERT OR IGNORE INTO user_stats(user_id, subject) VALUES (?, ?)", (user_id, subject))


def set_current_subject(conn: sqlite3.Connection, user_id: int, subject: str) -> str:
    if not is_known_subject(subject):
        raise ValueError("unknown subject")
    ensure_subject_schema(conn)
    conn.execute("UPDATE users SET current_subject=? WHERE id=?", (subject, user_id))
    ensure_subject_rows(conn, user_id, subject)
    conn.commit()
    return subject


def user_for(conn: sqlite3.Connection, handler: BaseHTTPRequestHandler) -> tuple[int, str | None]:
    ensure_subject_schema(conn)
    ensure_auth_schema(conn)
    token_value = cookie_value(handler, "ege_session")
    row = session_row_for(conn, token_value, request_device_info(handler))
    if row:
        ensure_subject_rows(conn, row["user_id"], current_subject_for(conn, row["user_id"]))
        conn.commit()
        return row["user_id"], None
    cur = conn.execute("INSERT INTO users(session_token, created_at) VALUES (?, ?)", (token_urlsafe(32), now_iso()))
    user_id = cur.lastrowid
    assign_account_id(conn, user_id)
    conn.execute("INSERT INTO user_stats(user_id) VALUES (?)", (user_id,))
    ensure_subject_rows(conn, user_id, DEFAULT_SUBJECT)
    # users.session_token — legacy-колонка; пишем туда же стартовый токен,
    # чтобы бэкфилл ensure_auth_schema не поднимал её обратно как новую сессию.
    new_token, _ = create_user_session(conn, user_id, request_device_info(handler))
    conn.execute("UPDATE users SET session_token=? WHERE id=?", (new_token, user_id))
    conn.commit()
    return user_id, new_token


def default_state(conn: sqlite3.Connection, user_id: int, subject: str | None = None) -> dict:
    subject = resolve_subject(subject)
    skills = {r["id"]: {"progress": 0, "solved": 0, "correct": 0, "timeSec": 0} for r in conn.execute("SELECT id FROM skills WHERE subject=?", (subject,))}
    return {"version": 4, "subject": subject, "stateVersion": 1, "onboarded": False, "goal": None, "selfLevel": None, "name": None, "xp": 0, "streak": 0, "lastActiveDate": None,
            "totalSolved": 0, "totalCorrect": 0, "totalTimeSec": 0, "hintsUsed": 0, "hintLevels": {"1": 0, "2": 0, "3": 0},
            "correctSeries": 0, "bestSeries": 0, "errorsResolved": 0, "bossesDefeated": [], "missionsDone": {}, "missionProgress": {},
            "achievements": {}, "errors": [], "lessonStepErrors": {}, "lessonErrorHistory": [], "lessonSessions": {},
            "completedLessons": {}, "lessonAttempts": [], "taskAttempts": [], "diagnostics": [], "forecastHistory": [],
            "xpAdjustments": [], "activity": {},
            "timeline": [], "daily": {"date": None, "solved": 0, "done": False, "taskIds": []}, "dailyHistory": [], "skillStats": skills}


def read_state(conn: sqlite3.Connection, user_id: int, subject: str | None = None) -> dict:
    ensure_subject_schema(conn)
    subject = resolve_subject(subject if is_known_subject(subject) else current_subject_for(conn, user_id))
    ensure_subject_rows(conn, user_id, subject)
    state = default_state(conn, user_id, subject)
    state["subject"] = subject
    user = conn.execute("SELECT onboarded, self_level, goal_id, name FROM users WHERE id=?", (user_id,)).fetchone()
    prof = conn.execute("SELECT onboarded, self_level, goal_id, state_version FROM user_subjects WHERE user_id=? AND subject=?", (user_id, subject)).fetchone()
    if prof is not None:
        state.update({"onboarded": bool(prof["onboarded"]), "selfLevel": prof["self_level"], "goal": prof["goal_id"], "stateVersion": prof["state_version"]})
    elif user:
        state.update({"onboarded": bool(user["onboarded"]), "selfLevel": user["self_level"], "goal": user["goal_id"]})
    if user:
        state["name"] = user["name"]
    stats = conn.execute("SELECT * FROM user_stats WHERE user_id=? AND subject=?", (user_id, subject)).fetchone()
    if stats:
        state.update({"xp": stats["xp"], "streak": stats["streak"], "lastActiveDate": stats["last_active_date"], "totalSolved": stats["total_solved"],
                      "totalCorrect": stats["total_correct"], "totalTimeSec": stats["total_time_sec"], "hintsUsed": stats["hints_used"],
                      "correctSeries": stats["correct_series"], "bestSeries": stats["best_series"], "errorsResolved": stats["errors_resolved"]})
    state["hintLevels"] = {str(i): 0 for i in range(1, 4)}
    for r in conn.execute("SELECT level, used_count FROM user_hint_levels WHERE user_id=? AND subject=?", (user_id, subject)): state["hintLevels"][str(r["level"])] = r["used_count"]
    for r in conn.execute("SELECT * FROM user_progress WHERE user_id=? AND subject=?", (user_id, subject)):
        state["skillStats"][r["skill_id"]] = {"progress": r["progress"], "solved": r["solved"], "correct": r["correct"], "timeSec": r["time_sec"]}
    for r in conn.execute("SELECT * FROM user_errors WHERE user_id=? AND subject=? ORDER BY id DESC", (user_id, subject)):
        state["errors"].append({"id": r["id"], "clientId": r["client_id"] if "client_id" in r.keys() else None, "taskId": r["task_id"], "skill": r["skill_id"], "sub": r["topic"], "ts": timestamp_value(r["created_at"]), "resolved": bool(r["resolved"]),
                                "kind": (_normalize_error_kind(r["kind"]) if "kind" in r.keys() and r["kind"] else "major")})
    for r in conn.execute("SELECT * FROM task_attempts WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT 5000", (user_id, subject)):
        keys = r.keys()
        state["taskAttempts"].append({"id": r["client_id"] if "client_id" in keys and r["client_id"] else None, "taskId": r["task_id"], "skill": r["skill_id"], "correct": bool(r["correct"]), "hintLevel": r["hint_level"], "seconds": r["seconds"], "closesTaskId": r["closes_task_id"] or None, "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT * FROM lesson_step_errors WHERE user_id=? AND subject=?", (user_id, subject)):
        state["lessonStepErrors"][f'{r["lesson_id"]}:{r["step_id"]}'] = {"count": r["count"], "skill": r["skill_id"], "ts": timestamp_value(r["last_at"]), "types": json.loads(r["types_json"])}
    for r in conn.execute("SELECT lesson_id, step_id, skill_id, error_type, created_at, client_id FROM lesson_error_history WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT 200", (user_id, subject)):
        state["lessonErrorHistory"].append({"id": r["client_id"] or None, "lessonId": r["lesson_id"], "stepId": r["step_id"], "skill": r["skill_id"], "type": r["error_type"], "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT lesson_id, session_json FROM lesson_sessions WHERE user_id=? AND subject=?", (user_id, subject)): state["lessonSessions"][r["lesson_id"]] = json.loads(r["session_json"])
    for r in conn.execute("SELECT lesson_id, completed_at FROM completed_lessons WHERE user_id=? AND subject=?", (user_id, subject)): state["completedLessons"][r["lesson_id"]] = {"ts": timestamp_value(r["completed_at"])}
    for r in conn.execute("SELECT * FROM lesson_attempts WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT 1000", (user_id, subject)):
        keys = r.keys()
        state["lessonAttempts"].append({"id": r["client_id"] if "client_id" in keys and r["client_id"] else None, "lessonId": r["lesson_id"], "completed": bool(r["completed"]), "firstCompletion": bool(r["first_completion"]), "xp": r["xp"], "wrongAttempts": r["wrong_attempts"], "durationSec": r["duration_sec"], "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT * FROM user_missions WHERE user_id=? AND subject=?", (user_id, subject)):
        state["missionProgress"][r["mission_id"]] = r["progress"]
        if r["completed_at"]: state["missionsDone"][r["mission_id"]] = {"ts": timestamp_value(r["completed_at"])}
    state["bossesDefeated"] = [r["boss_id"] for r in conn.execute("SELECT boss_id FROM user_bosses WHERE user_id=? AND subject=?", (user_id, subject))]
    for r in conn.execute("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id=? AND subject=?", (user_id, subject)): state["achievements"][r["achievement_id"]] = {"ts": timestamp_value(r["unlocked_at"])}
    for r in conn.execute("SELECT * FROM activity_history WHERE user_id=? AND subject=?", (user_id, subject)): state["activity"][r["activity_date"]] = {"solved": r["solved"], "correct": r["correct"], "xp": r["xp"]}
    state["forecastHistory"] = [dict(date=r["snapshot_date"], low=r["low"], high=r["high"], mid=r["mid"]) for r in conn.execute("SELECT * FROM forecast_history WHERE user_id=? AND subject=? ORDER BY snapshot_date", (user_id, subject))]
    state["xpAdjustments"] = [{"amount": r["amount"], "reason": r["reason"], "ts": timestamp_value(r["created_at"])} for r in conn.execute("SELECT * FROM user_xp_adjustments WHERE user_id=? AND subject=? ORDER BY id", (user_id, subject))]
    daily_rows = list(conn.execute("SELECT * FROM daily_progress WHERE user_id=? AND subject=? ORDER BY progress_date DESC", (user_id, subject)))
    state["dailyHistory"] = []
    for daily in daily_rows:
        try:
            task_ids = json.loads(daily["task_ids_json"] or "[]")
        except (TypeError, json.JSONDecodeError):
            task_ids = []
        state["dailyHistory"].append({"date": daily["progress_date"], "solved": daily["solved"], "done": bool(daily["done"]), "taskIds": task_ids})
    if daily_rows: state["daily"] = state["dailyHistory"][0].copy()
    state["timeline"] = [{"id": r["client_id"] if "client_id" in r.keys() and r["client_id"] else None, "ts": timestamp_value(r["created_at"]), "text": r["text"]} for r in conn.execute("SELECT created_at, text, client_id FROM timeline WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT 40", (user_id, subject))]
    state["diagnostics"] = [{"id": r["client_id"] if "client_id" in r.keys() and r["client_id"] else None, "taskId": r["task_id"], "correct": bool(r["correct"]), "ts": timestamp_value(r["created_at"])} for r in conn.execute("SELECT * FROM diagnostics WHERE user_id=? AND subject=? ORDER BY id DESC", (user_id, subject))]
    return state


def bump_state_versions(conn: sqlite3.Connection, user_id: int, subject: str | None = None) -> None:
    """Invalidate client snapshots after trusted out-of-band state mutations."""
    if subject is None:
        conn.execute("UPDATE user_subjects SET state_version=state_version+1 WHERE user_id=?", (user_id,))
    else:
        ensure_subject_rows(conn, user_id, subject)
        conn.execute("UPDATE user_subjects SET state_version=state_version+1 WHERE user_id=? AND subject=?", (user_id, subject))


def claim_state_version(conn: sqlite3.Connection, user_id: int, subject: str, expected_version: int | None) -> int:
    """Atomically reserve the next version before a full state rewrite."""
    if not isinstance(expected_version, int) or isinstance(expected_version, bool) or expected_version < 1:
        raise ValueError("expectedVersion must be a positive integer")
    changed = conn.execute(
        "UPDATE user_subjects SET state_version=state_version+1 "
        "WHERE user_id=? AND subject=? AND state_version=?",
        (user_id, subject, expected_version),
    ).rowcount
    if changed != 1:
        row = conn.execute(
            "SELECT state_version FROM user_subjects WHERE user_id=? AND subject=?",
            (user_id, subject),
        ).fetchone()
        raise StateConflictError(expected_version, int(row["state_version"]) if row else 1)
    return expected_version + 1


def append_attempt_events(conn: sqlite3.Connection, user_id: int, subject: str, events: list) -> int:
    """Append immutable task attempts; duplicate client events are idempotent.

    Каждая попытка несёт стабильный client-generated ID (поле id/clientId,
    генерируется один раз на клиенте при создании). Повторная отправка того же
    PUT/POST делает upsert по (user_id, subject, client_id), а не новую строку:
    одинаковый ID = та же запись. Legacy-payload без ID получает
    детерминированный ключ от естественных полей (та же семантика, что раньше
    давал SELECT), поэтому ретрай не плодит дубликаты и при гонке — UNIQUE на
    уровне БД, а не проверка-then-вставка.
    """
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills WHERE subject=?", (subject,))}
    valid_tasks = {r["id"] for r in conn.execute(
        "SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject=?", (subject,)
    )}
    inserted = 0
    for event in events:
        if not isinstance(event, dict) or event.get("taskId") not in valid_tasks or event.get("skill") not in valid_skills:
            continue
        try:
            hint = int(event.get("hintLevel", 0))
            seconds = float(event.get("seconds", 0))
            created = str(event.get("ts") or now_iso())
        except (TypeError, ValueError):
            continue
        closes_raw = event.get("closesTaskId")
        closes = closes_raw if isinstance(closes_raw, str) else ""
        correct = int(bool(event.get("correct")))
        try:
            seconds_norm = str(float(seconds))
        except (TypeError, ValueError):
            seconds_norm = "0.0"
        client_id = _stable_client_id(event) or _fallback_client_id("attempt", [
            event["taskId"], event["skill"], correct, hint, seconds_norm, closes, created])
        cur = conn.execute(
            "INSERT INTO task_attempts(user_id,subject,task_id,skill_id,correct,hint_level,seconds,closes_task_id,created_at,client_id)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
            (user_id, subject, event["taskId"], event["skill"], correct, hint, seconds, closes, created, client_id),
        )
        if cur.rowcount:
            inserted += 1
    return inserted


def append_timeline_events(conn: sqlite3.Connection, user_id: int, subject: str, events: list) -> int:
    """Append immutable timeline entries; retries are idempotent (upsert по client_id)."""
    inserted = 0
    for event in events:
        if not isinstance(event, dict):
            continue
        text = event.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        created = str(event.get("ts") or now_iso())
        text = text[:MAX_TIMELINE_TEXT]
        client_id = _stable_client_id(event) or _fallback_client_id("timeline", [created, text])
        cur = conn.execute(
            "INSERT INTO timeline(user_id,subject,created_at,text,client_id) VALUES(?,?,?,?,?)"
            " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
            (user_id, subject, created, text, client_id))
        if cur.rowcount:
            inserted += 1
    return inserted


def refresh_derived_stats(conn: sqlite3.Connection, user_id: int, subject: str) -> None:
    """Recompute trusted aggregates from durable domain records after a write."""
    state = read_state(conn, user_id, subject)
    derived = derive_stats(conn, state, user_id)
    prev = conn.execute("SELECT streak, last_active_date FROM user_stats WHERE user_id=? AND subject=?", (user_id, subject)).fetchone()
    conn.execute("""INSERT INTO user_stats(user_id,subject,xp,streak,last_active_date,total_solved,total_correct,total_time_sec,hints_used,correct_series,best_series,errors_resolved)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id,subject) DO UPDATE SET xp=excluded.xp,streak=excluded.streak,last_active_date=excluded.last_active_date,total_solved=excluded.total_solved,total_correct=excluded.total_correct,total_time_sec=excluded.total_time_sec,hints_used=excluded.hints_used,correct_series=excluded.correct_series,best_series=MAX(user_stats.best_series,excluded.best_series),errors_resolved=excluded.errors_resolved""",
                 (user_id, subject, int(derived["xp"]), int(prev["streak"] if prev else 0), prev["last_active_date"] if prev else None, int(derived["totalSolved"]), int(derived["totalCorrect"]), float(sum(float(a.get("seconds") or 0) for a in state.get("taskAttempts") or [] if isinstance(a, dict))), int(derived["hintsUsed"]), int(derived["correctSeries"]), int(derived["bestSeries"]), int(derived["errorsResolved"])))


def domain_write(conn: sqlite3.Connection, user_id: int, payload: dict, operation) -> tuple[str, int, object]:
    """CAS boundary shared by independently persisted user-state domains."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    subject = resolve_subject(payload.get("subject") if is_known_subject(payload.get("subject")) else current_subject_for(conn, user_id))
    expected = payload.get("expectedVersion", payload.get("expected_version"))
    conn.execute("BEGIN IMMEDIATE")
    ensure_subject_rows(conn, user_id, subject)
    next_version = claim_state_version(conn, user_id, subject, expected)
    result = operation(subject)
    refresh_derived_stats(conn, user_id, subject)
    conn.commit()
    return subject, next_version, result


def patch_skill_progress(conn: sqlite3.Connection, user_id: int, subject: str, skill_id: str, value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("progress must be an object")
    skill = conn.execute("SELECT id FROM skills WHERE id=? AND subject=?", (skill_id, subject)).fetchone()
    if not skill:
        raise ValueError("unknown skill")
    try:
        progress = int(value.get("progress", 0))
        solved = int(value.get("solved", 0))
        correct = int(value.get("correct", 0))
        time_sec = float(value.get("timeSec", 0))
    except (TypeError, ValueError):
        raise ValueError("invalid progress values")
    if not 0 <= progress <= 100 or solved < 0 or correct < 0 or correct > solved or time_sec < 0:
        raise ValueError("invalid progress values")
    conn.execute(
        "INSERT INTO user_progress(user_id,subject,skill_id,progress,solved,correct,time_sec) VALUES(?,?,?,?,?,?,?) "
        "ON CONFLICT(user_id,subject,skill_id) DO UPDATE SET progress=MAX(user_progress.progress,excluded.progress), "
        "solved=MAX(user_progress.solved,excluded.solved), correct=MAX(user_progress.correct,excluded.correct), "
        "time_sec=MAX(user_progress.time_sec,excluded.time_sec)",
        (user_id, subject, skill_id, progress, solved, correct, time_sec),
    )
    return {"skill": skill_id, "progress": progress, "solved": solved, "correct": correct, "timeSec": time_sec}


def create_error(conn: sqlite3.Connection, user_id: int, subject: str, value: dict) -> dict:
    """Создать ошибку как сущность со стабильным client-generated ID.

    Одинаковый clientId = та же запись (upsert, не дубль). Повтор POST после
    таймаута/даблклика возвращает ту же строку. Legacy без clientId — ключ от
    естественных полей (taskId+skill+ts), как раньше.

    Дополнительно — upsert по task_id среди ОТКРЫТЫХ ошибок: на одно задание
    висит не больше одной открытой записи. Повторный POST по тому же заданию
    (ретрай с новым clientId, дубль в локальном состоянии, две вкладки)
    обновляет открытую запись, а не вставляет строку. Severity при этом
    только растёт (minor→major): повторный провал не теряется, а downgrade
    не затирает полную ошибку. Закрытые строки — история, их не трогаем.
    """
    if not isinstance(value, dict):
        raise ValueError("error must be an object")
    task_id, skill_id = value.get("taskId"), value.get("skill")
    valid = conn.execute(
        "SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE t.id=? AND s.id=? AND s.subject=?",
        (task_id, skill_id, subject),
    ).fetchone()
    if not valid:
        raise ValueError("unknown task or skill")
    created = str(value.get("ts") or now_iso())
    topic = str(value.get("sub") or "")[:200]
    kind = _normalize_error_kind(value.get("kind"))
    client_id = _stable_client_id(value) or _fallback_client_id("error", [task_id, skill_id, created])
    _ensure_error_kind_column(conn)
    open_row = conn.execute(
        "SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors "
        "WHERE user_id=? AND subject=? AND task_id=? AND resolved=0 ORDER BY id LIMIT 1",
        (user_id, subject, task_id),
    ).fetchone()
    if open_row is not None:
        if kind == "major" and _normalize_error_kind(open_row["kind"]) == "minor":
            conn.execute("UPDATE user_errors SET kind='major' WHERE id=?", (open_row["id"],))
            open_row = conn.execute(
                "SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors WHERE id=?",
                (open_row["id"],),
            ).fetchone()
        return _serialize_error_row(open_row)
    conn.execute(
        "INSERT INTO user_errors(user_id,subject,task_id,skill_id,topic,created_at,resolved,kind,client_id)"
        " VALUES(?,?,?,?,?,?,0,?,?)"
        " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
        (user_id, subject, task_id, skill_id, topic, created, kind, client_id),
    )
    row = conn.execute(
        "SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors "
        "WHERE user_id=? AND subject=? AND client_id=? LIMIT 1",
        (user_id, subject, client_id),
    ).fetchone()
    return _serialize_error_row(row)


def patch_error_resolved(conn: sqlite3.Connection, user_id: int, subject: str, error_id, resolved: object = None, kind: object = None) -> dict:
    """Идемпотентное обновление флага resolved и вида ошибки по стабильному ID.

    error_id — server-side integer id либо client-generated UUID (clientId):
    одинаковый ID обновляет ту же запись. Повтор PATCH с тем же значением —
    тот же результат (строка ищется SELECT-ом, а не по rowcount UPDATE-а,
    поэтому повтор не превращается в 404).

    kind — апгрейд severity для синхронизации повторного провала
    (minor→major); downgrade major→minor никогда не применяется, чтобы
    чужая вкладка не затирала полную ошибку. Старые клиенты шлют только
    resolved — для них поведение прежнее.
    """
    if resolved is not None and not isinstance(resolved, bool):
        raise ValueError("resolved must be boolean")
    new_kind = _normalize_error_kind(kind) if kind is not None else None
    if resolved is None and new_kind is None:
        raise ValueError("nothing to update")
    _ensure_error_kind_column(conn)
    row = None
    try:
        numeric = int(error_id)
        is_numeric = str(error_id).strip().isdigit()
    except (TypeError, ValueError):
        numeric, is_numeric = None, False
    if is_numeric:
        row = conn.execute("SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors WHERE id=? AND user_id=? AND subject=?",
                           (numeric, user_id, subject)).fetchone()
    if row is None and isinstance(error_id, str) and error_id.strip():
        row = conn.execute("SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors WHERE client_id=? AND user_id=? AND subject=?",
                           (error_id.strip()[:128], user_id, subject)).fetchone()
    if row is None:
        raise KeyError("error not found")
    updates, params = [], []
    if resolved is not None:
        updates.append("resolved=?")
        params.append(int(resolved))
    if new_kind == "major" and _normalize_error_kind(row["kind"]) == "minor":
        updates.append("kind='major'")
    if updates:
        params.append(row["id"])
        conn.execute(f"UPDATE user_errors SET {', '.join(updates)} WHERE id=?", params)
        row = conn.execute("SELECT id, task_id, skill_id, topic, created_at, resolved, client_id, kind FROM user_errors WHERE id=?", (row["id"],)).fetchone()
    return _serialize_error_row(row)


def patch_settings(conn: sqlite3.Connection, user_id: int, subject: str, value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("settings must be an object")
    current = conn.execute("SELECT onboarded, self_level, goal_id FROM user_subjects WHERE user_id=? AND subject=?", (user_id, subject)).fetchone()
    onboarded = int(bool(value["onboarded"])) if "onboarded" in value else int(current["onboarded"])
    self_level = value.get("selfLevel", current["self_level"])
    goal = value.get("goal", current["goal_id"])
    name_value = value.get("name") if "name" in value else conn.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()["name"]
    if self_level is not None and self_level not in SELF_LEVELS:
        raise ValueError("invalid selfLevel")
    if goal is not None:
        # Список целей строго предмета регистрации: профильная g60 для базы
        # (или базовая g4 для профиля) отклоняется 400-й. Единственный
        # резолвер конфига — _subject_config (тот же путь, что у каталога).
        goal_ids = {g.get("id") for g in _subject_config(conn, "goals", subject, [], subject == DEFAULT_SUBJECT) or []}
        if not goal_ids:
            # У предмета нет шкалы целей (контент готовится) — хранить нечего и
            # отклонять всю настройку из-за необязательного ориентира нельзя:
            # иначе регистрация на таком предмете не сохраняется вовсе.
            goal = None
        elif goal not in goal_ids:
            raise ValueError("unknown goal")
    conn.execute("UPDATE user_subjects SET onboarded=?, self_level=?, goal_id=? WHERE user_id=? AND subject=?", (onboarded, self_level, goal, user_id, subject))
    conn.execute("UPDATE users SET name=? WHERE id=?", (sanitize_name(name_value), user_id))
    if subject == DEFAULT_SUBJECT:
        conn.execute("UPDATE users SET onboarded=?, self_level=?, goal_id=? WHERE id=?", (onboarded, self_level, goal, user_id))
    return {"onboarded": bool(onboarded), "selfLevel": self_level, "goal": goal, "name": sanitize_name(name_value)}


def patch_state_domains(conn: sqlite3.Connection, user_id: int, subject: str, domains: dict) -> dict:
    """Upsert mutable state domains without touching immutable event history."""
    if not isinstance(domains, dict):
        raise ValueError("domains must be an object")
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills WHERE subject=?", (subject,))}
    lesson_ids = {r["id"] for r in conn.execute("SELECT l.id FROM lessons l JOIN skills s ON s.id=l.skill_id WHERE s.subject=?", (subject,))}
    mission_ids = {r["id"] for r in conn.execute("SELECT m.id FROM missions m JOIN skills s ON s.id=m.skill_id WHERE s.subject=?", (subject,))}
    changed = []
    if "lessonAttempts" in domains and isinstance(domains["lessonAttempts"], list):
        for item in domains["lessonAttempts"]:
            if not isinstance(item, dict) or item.get("lessonId") not in lesson_ids:
                continue
            try:
                xp = int(item.get("xp", 0)); wrong = int(item.get("wrongAttempts", 0)); duration = float(item.get("durationSec", 0)); created = str(item.get("ts") or now_iso())
            except (TypeError, ValueError):
                continue
            client_id = _stable_client_id(item) or _fallback_client_id("lesson_attempt", [item["lessonId"], created])
            conn.execute("INSERT INTO lesson_attempts(user_id,subject,lesson_id,completed,first_completion,xp,wrong_attempts,duration_sec,created_at,client_id) VALUES(?,?,?,?,?,?,?,?,?,?)"
                         " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
                         (user_id, subject, item["lessonId"], int(bool(item.get("completed", True))), int(bool(item.get("firstCompletion"))), xp, wrong, duration, created, client_id))
        changed.append("lessonAttempts")
    if "lessonErrorHistory" in domains and isinstance(domains["lessonErrorHistory"], list):
        for item in domains["lessonErrorHistory"]:
            if not isinstance(item, dict) or item.get("lessonId") not in lesson_ids or item.get("skill") not in valid_skills:
                continue
            created = str(item.get("ts") or now_iso())
            step_id, error_type = str(item.get("stepId") or ""), str(item.get("type") or "")
            client_id = _stable_client_id(item) or _fallback_client_id("lesson_error", [item["lessonId"], step_id, error_type, created])
            conn.execute("INSERT INTO lesson_error_history(user_id,subject,lesson_id,step_id,skill_id,error_type,created_at,client_id) VALUES(?,?,?,?,?,?,?,?)"
                         " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
                         (user_id, subject, item["lessonId"], step_id, item["skill"], error_type, created, client_id))
        changed.append("lessonErrorHistory")
    if "diagnostics" in domains and isinstance(domains["diagnostics"], list):
        valid_tasks = {r["id"] for r in conn.execute("SELECT t.id FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject=?", (subject,))}
        for item in domains["diagnostics"]:
            if not isinstance(item, dict) or item.get("taskId") not in valid_tasks:
                continue
            created = str(item.get("ts") or now_iso())
            client_id = _stable_client_id(item) or _fallback_client_id("diagnostic", [item["taskId"], created])
            conn.execute("INSERT INTO diagnostics(user_id,subject,task_id,correct,created_at,client_id) VALUES(?,?,?,?,?,?)"
                         " ON CONFLICT(user_id,subject,client_id) DO NOTHING",
                         (user_id, subject, item["taskId"], int(bool(item.get("correct"))), created, client_id))
        changed.append("diagnostics")
    if "lessonStepErrors" in domains and isinstance(domains["lessonStepErrors"], dict):
        for key, item in domains["lessonStepErrors"].items():
            if not isinstance(key, str) or ":" not in key or not isinstance(item, dict):
                continue
            lesson_id, step_id = key.split(":", 1)
            if lesson_id in lesson_ids and item.get("skill") in valid_skills:
                try: count = int(item.get("count", 0))
                except (TypeError, ValueError): continue
                conn.execute("INSERT INTO lesson_step_errors(user_id,subject,lesson_id,step_id,skill_id,count,last_at,types_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,subject,lesson_id,step_id) DO UPDATE SET count=MAX(lesson_step_errors.count,excluded.count), last_at=MAX(lesson_step_errors.last_at,excluded.last_at), types_json=excluded.types_json", (user_id, subject, lesson_id, step_id, item["skill"], count, str(item.get("ts") or now_iso()), json.dumps(item.get("types") or {}, ensure_ascii=False)))
        changed.append("lessonStepErrors")
    if "deletedLessonStepErrors" in domains and isinstance(domains["deletedLessonStepErrors"], list):
        for key in domains["deletedLessonStepErrors"]:
            if not isinstance(key, str) or ":" not in key:
                continue
            lesson_id, step_id = key.split(":", 1)
            if lesson_id in lesson_ids:
                conn.execute("DELETE FROM lesson_step_errors WHERE user_id=? AND subject=? AND lesson_id=? AND step_id=?", (user_id, subject, lesson_id, step_id))
        changed.append("deletedLessonStepErrors")
    if "lessonSessions" in domains and isinstance(domains["lessonSessions"], dict):
        for lesson_id, value in domains["lessonSessions"].items():
            if lesson_id in lesson_ids and isinstance(value, dict):
                conn.execute("INSERT INTO lesson_sessions(user_id,subject,lesson_id,session_json) VALUES(?,?,?,?) ON CONFLICT(user_id,subject,lesson_id) DO UPDATE SET session_json=excluded.session_json", (user_id, subject, lesson_id, json.dumps(value, ensure_ascii=False)))
        changed.append("lessonSessions")
    if "deletedLessonSessions" in domains and isinstance(domains["deletedLessonSessions"], list):
        for lesson_id in domains["deletedLessonSessions"]:
            if isinstance(lesson_id, str) and lesson_id in lesson_ids:
                conn.execute("DELETE FROM lesson_sessions WHERE user_id=? AND subject=? AND lesson_id=?", (user_id, subject, lesson_id))
        changed.append("deletedLessonSessions")
    if "completedLessons" in domains and isinstance(domains["completedLessons"], dict):
        for lesson_id, value in domains["completedLessons"].items():
            if lesson_id in lesson_ids:
                ts = value.get("ts") if isinstance(value, dict) else None
                conn.execute("INSERT OR IGNORE INTO completed_lessons(user_id,subject,lesson_id,completed_at) VALUES(?,?,?,?)", (user_id, subject, lesson_id, ts or now_iso()))
        changed.append("completedLessons")
    if "missionProgress" in domains and isinstance(domains["missionProgress"], dict):
        done = domains.get("missionsDone") if isinstance(domains.get("missionsDone"), dict) else {}
        for mission_id, value in domains["missionProgress"].items():
            if mission_id not in mission_ids:
                continue
            try: progress = int(value)
            except (TypeError, ValueError): continue
            existing = conn.execute("SELECT progress, completed_at FROM user_missions WHERE user_id=? AND subject=? AND mission_id=?", (user_id, subject, mission_id)).fetchone()
            prior = int(existing["progress"]) if existing else 0
            entry = done.get(mission_id)
            completed = entry.get("ts") if isinstance(entry, dict) else (existing["completed_at"] if existing else None)
            conn.execute("INSERT INTO user_missions(user_id,subject,mission_id,progress,completed_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,subject,mission_id) DO UPDATE SET progress=MAX(user_missions.progress,excluded.progress), completed_at=COALESCE(user_missions.completed_at,excluded.completed_at)", (user_id, subject, mission_id, max(prior, progress), completed))
        changed.append("missionProgress")
    if "achievements" in domains and isinstance(domains["achievements"], dict):
        valid = {r["id"] for r in conn.execute("SELECT id FROM achievements")}
        for achievement_id, value in domains["achievements"].items():
            if achievement_id in valid:
                ts = value.get("ts") if isinstance(value, dict) else None
                conn.execute("INSERT OR IGNORE INTO user_achievements(user_id,subject,achievement_id,unlocked_at) VALUES(?,?,?,?)", (user_id, subject, achievement_id, ts or now_iso()))
        changed.append("achievements")
    if "bossesDefeated" in domains and isinstance(domains["bossesDefeated"], list):
        valid = {r["id"] for r in conn.execute("SELECT b.id FROM bosses b JOIN topics t ON t.id=b.topic_id WHERE t.subject=?", (subject,))}
        for boss_id in domains["bossesDefeated"]:
            if isinstance(boss_id, str) and boss_id in valid:
                conn.execute("INSERT OR IGNORE INTO user_bosses(user_id,subject,boss_id,defeated_at) VALUES(?,?,?,?)", (user_id, subject, boss_id, now_iso()))
        changed.append("bossesDefeated")
    if "daily" in domains and isinstance(domains["daily"], dict):
        daily = domains["daily"]
        if isinstance(daily.get("date"), str):
            ids = daily.get("taskIds") if isinstance(daily.get("taskIds"), list) else []
            conn.execute("INSERT INTO daily_progress(user_id,subject,progress_date,solved,done,task_ids_json) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,subject,progress_date) DO UPDATE SET solved=MAX(daily_progress.solved,excluded.solved), done=MAX(daily_progress.done,excluded.done), task_ids_json=CASE WHEN daily_progress.task_ids_json='[]' THEN excluded.task_ids_json ELSE daily_progress.task_ids_json END", (user_id, subject, daily["date"], int(daily.get("solved", 0)), int(bool(daily.get("done"))), json.dumps(ids, ensure_ascii=False)))
        changed.append("daily")
    if "activity" in domains and isinstance(domains["activity"], dict):
        for day, value in domains["activity"].items():
            if not isinstance(day, str) or not isinstance(value, dict):
                continue
            try:
                solved = int(value.get("solved", 0)); correct = int(value.get("correct", 0)); xp = int(value.get("xp", 0))
            except (TypeError, ValueError):
                continue
            prior = conn.execute("SELECT solved, correct, xp FROM activity_history WHERE user_id=? AND subject=? AND activity_date=?", (user_id, subject, day)).fetchone()
            old_solved, old_correct, old_xp = (int(prior["solved"]), int(prior["correct"]), int(prior["xp"])) if prior else (0, 0, 0)
            delta = (max(0, solved - old_solved), max(0, correct - old_correct), max(0, xp - old_xp))
            if any(delta):
                key = f"activity:{day}:{solved}:{correct}:{xp}"
                conn.execute("INSERT OR IGNORE INTO activity_events(user_id,subject,activity_date,solved,correct,xp,created_at,event_key) VALUES(?,?,?,?,?,?,?,?)", (user_id, subject, day, *delta, now_iso(), key))
            conn.execute("INSERT INTO activity_history(user_id,subject,activity_date,solved,correct,xp) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,subject,activity_date) DO UPDATE SET solved=MAX(activity_history.solved,excluded.solved), correct=MAX(activity_history.correct,excluded.correct), xp=MAX(activity_history.xp,excluded.xp)", (user_id, subject, day, solved, correct, xp))
        changed.append("activity")
    if "forecastHistory" in domains and isinstance(domains["forecastHistory"], list):
        for item in domains["forecastHistory"]:
            if not isinstance(item, dict) or not isinstance(item.get("date"), str):
                continue
            try: low, high, mid = int(item["low"]), int(item["high"]), int(item["mid"])
            except (KeyError, TypeError, ValueError): continue
            conn.execute("INSERT INTO forecast_history(user_id,subject,snapshot_date,low,high,mid) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,subject,snapshot_date) DO UPDATE SET low=excluded.low,high=excluded.high,mid=excluded.mid", (user_id, subject, item["date"], low, high, mid))
        changed.append("forecastHistory")
    if "hintLevels" in domains and isinstance(domains["hintLevels"], dict):
        # Уровни помощи — монотонный счётчик использований (как progress):
        # одинаковый payload = тот же результат (MAX), ретрай безопасен.
        for level_key, used in domains["hintLevels"].items():
            try:
                level = int(level_key)
                used_count = int(used)
            except (TypeError, ValueError):
                continue
            if level < 1 or used_count < 0 or used_count > MAX_COUNTER_VALUE:
                continue
            conn.execute("INSERT INTO user_hint_levels(user_id,subject,level,used_count) VALUES(?,?,?,?)"
                         " ON CONFLICT(user_id,subject,level) DO UPDATE SET used_count=MAX(user_hint_levels.used_count,excluded.used_count)",
                         (user_id, subject, level, used_count))
        changed.append("hintLevels")
    return changed


# ---------------------------------------------------------------------------
# Единая формула XP за практику (зеркало js/state.js attemptXp).
# Попытка (посещение задания) платит минимум всегда, верный ответ — бонус.
# ---------------------------------------------------------------------------
XP_ATTEMPT_BASE = 6
XP_ATTEMPT_PER_DIFF = 2
XP_CORRECT_BASE = 10
XP_CORRECT_PER_DIFF = 5
XP_ERROR_RESOLVED = 15
XP_LEVEL_MILESTONE = 50


def attempt_xp(diff: int, correct: bool, hint_level: int, already_mastered: bool) -> int:
    """XP за одну попытку по заданию. Всегда > 0: минимум платится за сам факт
    попытки, чтобы завершённая практика никогда не давала +0 XP."""
    diff = max(1, min(5, int(diff)))
    total = XP_ATTEMPT_BASE + diff * XP_ATTEMPT_PER_DIFF
    if not correct or hint_level >= 3:
        return total
    if already_mastered:
        return total
    bonus = XP_CORRECT_BASE + diff * XP_CORRECT_PER_DIFF
    if hint_level == 1:
        bonus = round(bonus * 0.6)
    elif hint_level >= 2:
        bonus = round(bonus * 0.3)
    return total + bonus


def level_from_xp(xp: int) -> dict:
    """Mirror of the client's xpForLevel formula (400 + 120·(n−1) per level)."""
    remaining = max(0, int(xp))
    level = 1
    need = 400 + 120 * (level - 1)
    while remaining >= need:
        remaining -= need
        level += 1
        need = 400 + 120 * (level - 1)
    return {"level": level, "intoLevel": remaining, "need": need, "xp": max(0, int(xp))}


def _levels_crossed(xp_from: int, xp_to: int) -> int:
    """Сколько уровневых порогов пересечено при росте XP из xp_from в xp_to.
    Нужно для milestone-бонусов в derive_stats."""
    if xp_to <= xp_from:
        return 0
    return level_from_xp(xp_to)["level"] - level_from_xp(xp_from)["level"]


def _derive_skill_progress_value(solved: int, correct: int, lesson_done: float, lesson_total: int, task_count: int = 0) -> int:
    """Мастерство навыка 0–100: теория 40 + практика 60. Зеркало клиентского
    skillProgress() для отображения.

    Теория: доля завершённых уроков (lesson_done может быть дробным — открытый
    урок даёт шаги/всего), вес 40. Практика: покрытие банка × точность, где
    знаменатель покрытия — реальное число решаемых заданий темы (task_count),
    а не фиксированные 10. Полная по-задачная модель с качеством решения
    (доля 60/N за задание, скидки за подсказки/разбор/неверные попытки/долгое
    выполнение/показ решения, зачёт
    лучшего решения один раз — защита от фарма повторами) живёт на клиенте
    (skillPracticeDetail в js/state.js) и считается по истории taskAttempts;
    здешний агрегат — её оценка при отсутствии детальной истории. Живая
    истина прогресса хранится в user_progress и обновляется только через
    patch_skill_progress (MAX-слияние клиентского значения)."""
    try:
        solved = max(0, int(solved)); correct = max(0, int(correct))
        lesson_done = max(0.0, float(lesson_done)); lesson_total = max(0, int(lesson_total))
        task_count = max(0, int(task_count))
    except (TypeError, ValueError):
        return 0
    theory_weight = 40 if lesson_total else 0
    practice_weight = 100 - theory_weight
    theory = (lesson_done / lesson_total) * theory_weight if lesson_total else 0
    accuracy = (correct / solved) if solved else 0
    volume_cap = task_count if task_count > 0 else 10
    practice = min(1, solved / volume_cap) * accuracy * practice_weight
    return int(round(min(100, theory + practice)))


def _derive_streak(activity_dates: set, today_str: str | None = None) -> tuple[int, str | None]:
    """Серия подряд идущих дней с активностью + последняя активная дата.
    Считается только здесь из derived-дат активности; клиент streak не шлёт."""
    if not activity_dates:
        return 0, None
    days = sorted(d for d in activity_dates if isinstance(d, str) and len(d) == 10)
    if not days:
        return 0, None
    last = days[-1]
    streak = 1
    for i in range(len(days) - 2, -1, -1):
        try:
            cur = dt.date.fromisoformat(days[i + 1])
            prev = dt.date.fromisoformat(days[i])
        except ValueError:
            break
        if (cur - prev).days == 1:
            streak += 1
        else:
            break
    return streak, last


def admin_blocked_tasks(conn: sqlite3.Connection) -> list[dict]:
    """Полный аудит физически нерешаемых задач: визуал required без assetId.
    Возвращает только admin-эндпоинт; обычный /api/bootstrap их скрывает."""
    # Собираем сырые записи из каталога (SQLite-catalog уже установлен)
    tasks = []
    for r in conn.execute("SELECT * FROM tasks ORDER BY id"):
        item = {"id": r["id"], "skill": r["skill_id"], "sub": r["topic"], "num": r["exam_number"],
                "diff": r["difficulty"], "text": r["statement"], "answer": r["answer"],
                "hint": r["hint"], "solution": r["explanation"]}
        item.update(json.loads(r["metadata_json"] or "{}"))
        if not task_has_missing_visual(item):
            continue
        skill = conn.execute("SELECT name, topic_id FROM skills WHERE id=?", (item["skill"],)).fetchone()
        topic = conn.execute("SELECT name FROM topics WHERE id=?", (skill["topic_id"],)).fetchone() if skill else None
        # где встречается эта задача
        missions_for_task = [mr["mission_id"] for mr in conn.execute(
            "SELECT mission_id FROM mission_tasks WHERE task_id=?", (item["id"],))]
        # схема/шаблон восстановления
        is_lesson = bool(conn.execute("SELECT 1 FROM lessons WHERE metadata_json LIKE ?", (f"%{item['id']}%",)).fetchone())
        # есть ли визуал/рисунок
        has_text = bool((item.get("text") or "").strip())
        has_answer = bool((item.get("answer") or "").strip())
        has_solution = bool((item.get("solution") or "").strip())
        visual = item.get("visual") or {}
        reason = visual.get("note") or "Официальный рисунок обязателен, но отсутствует в сборке."
        # восстановимость: без официального рисунка — нельзя
        restorable = "нельзя восстановить без официальных данных"  # визуал required без asset — всегда так
        tasks.append({
            "id": item["id"], "num": item["num"], "diff": item["diff"],
            "skill": item["skill"], "skillName": skill["name"] if skill else item["skill"],
            "topic": topic["name"] if topic else "", "sub": item["sub"],
            "text": item["text"][:500], "answer": item["answer"], "hasText": has_text,
            "hasAnswer": has_answer, "hasSolution": has_solution, "hasVisual": False,
            "visualNote": visual.get("note", ""), "requiredVisual": True,
            "missions": missions_for_task, "inLesson": is_lesson,
            "source": item.get("source", ""), "sourceId": item.get("sourceId", ""),
            "reason": reason, "fieldsMissing": ["официальный рисунок"],
            "restorable": restorable,
            "templateHint": "Обязательные поля: text, answer, solution, sub, num, diff, skill, source/sourceId. Для восстановления нужен официальный рисунок с координатами/формой кривой.",
            "canRestore": False, "needsManual": True,
        })
    return tasks


def admin_overview(conn: sqlite3.Connection, days: int = 14) -> dict:
    def one(sql, *args):
        return conn.execute(sql, args).fetchone()
    today_msk = today()
    yesterday_msk = (dt.datetime.now(ZoneInfo("Europe/Moscow")) - dt.timedelta(days=1)).date().isoformat()

    users_total = one("SELECT COUNT(*) AS c FROM users")["c"]
    onboarded = one("SELECT COUNT(*) AS c FROM users WHERE onboarded=1")["c"]
    named = one("SELECT COUNT(*) AS c FROM users WHERE name IS NOT NULL AND name != ''")["c"]
    created = [r["created_at"] for r in conn.execute("SELECT created_at FROM users")]
    day_ms = 86400000
    now_ms = int(time.time() * 1000)
    def registered_since(ms: int) -> int:
        n = 0
        for c in created:
            try:
                if int(c) >= ms:
                    n += 1
            except (TypeError, ValueError):
                continue
        return n
    new_today = registered_since(now_ms - day_ms)
    new_week = registered_since(now_ms - 7 * day_ms)

    active_today = one("SELECT COUNT(DISTINCT user_id) AS c FROM activity_history WHERE activity_date=?", today_msk)["c"]
    active_week_row = conn.execute(
        "SELECT COUNT(DISTINCT user_id) AS c FROM activity_history WHERE activity_date >= ?",
        ((dt.datetime.now(ZoneInfo("Europe/Moscow")) - dt.timedelta(days=6)).date().isoformat(),),
    ).fetchone()
    active_week = active_week_row["c"]
    active_ever = one("SELECT COUNT(*) AS c FROM user_stats WHERE total_solved > 0")["c"]

    stats = one("""SELECT COALESCE(SUM(xp),0) AS xp, COALESCE(SUM(total_solved),0) AS solved,
                   COALESCE(SUM(total_correct),0) AS correct, COALESCE(SUM(total_time_sec),0) AS time_sec,
                   COALESCE(SUM(hints_used),0) AS hints, COALESCE(MAX(streak),0) AS best_streak,
                   COALESCE(AVG(NULLIF(xp,0)),0) AS avg_xp FROM user_stats""")
    # created_at хранится строкой миллисекундных меток одинаковой длины,
    # поэтому лексикографическое сравнение корректно.
    attempts_today = one("SELECT COUNT(*) AS c FROM task_attempts WHERE created_at >= ?", str(now_ms - day_ms))["c"]
    open_errors = one("SELECT COUNT(*) AS c FROM user_errors WHERE resolved=0")["c"]
    completed_lessons = one("SELECT COUNT(*) AS c FROM completed_lessons")["c"]
    lessons_total = one("SELECT COUNT(*) AS c FROM lessons")["c"]
    missions_done = one("SELECT COUNT(*) AS c FROM user_missions WHERE completed_at IS NOT NULL")["c"]
    bosses_defeated = one("SELECT COUNT(*) AS c FROM user_bosses")["c"]

    # Activity for the last `days` Moscow days (allowed: 1/7/14/30, default 14):
    # solved/correct/xp/users per date.
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 14
    if days not in (1, 7, 14, 30):
        days = 14
    start_date = (dt.datetime.now(ZoneInfo("Europe/Moscow")) - dt.timedelta(days=days - 1)).date()
    activity_rows = {r["activity_date"]: dict(r) for r in conn.execute(
        "SELECT activity_date, SUM(solved) AS solved, SUM(correct) AS correct, SUM(xp) AS xp, COUNT(DISTINCT user_id) AS users "
        "FROM activity_history WHERE activity_date >= ? GROUP BY activity_date", (start_date.isoformat(),))}
    activity = []
    for i in range(days):
        d = (start_date + dt.timedelta(days=i)).isoformat()
        row = activity_rows.get(d)
        activity.append({"date": d, "solved": row["solved"] if row else 0, "correct": row["correct"] if row else 0,
                         "xp": row["xp"] if row else 0, "users": row["users"] if row else 0})

    # XP leaders (top 5) — real accounts only.
    leaders = []
    for r in conn.execute("""SELECT u.id, u.account_id, u.name, s.xp, s.total_solved, s.total_correct, s.streak
                             FROM user_stats s JOIN users u ON u.id = s.user_id
                             WHERE s.total_solved > 0 ORDER BY s.xp DESC LIMIT 5"""):
        leaders.append({"id": r["id"], "accountId": r["account_id"], "name": r["name"], "xp": r["xp"],
                        "level": level_from_xp(r["xp"])["level"], "solved": r["total_solved"],
                        "correct": r["total_correct"], "streak": r["streak"]})

    # Per-skill aggregate mastery across all users who touched the skill.
    skills = []
    for r in conn.execute("""SELECT sk.id, sk.name, sk.topic_id, t.name AS topic_name,
                                    COUNT(up.user_id) AS users, COALESCE(SUM(up.solved),0) AS solved,
                                    COALESCE(SUM(up.correct),0) AS correct, COALESCE(AVG(NULLIF(up.progress,0)),0) AS avg_progress
                             FROM skills sk
                             LEFT JOIN topics t ON t.id = sk.topic_id
                             LEFT JOIN user_progress up ON up.skill_id = sk.id
                             GROUP BY sk.id ORDER BY sk.display_order"""):
        skills.append({"id": r["id"], "name": r["name"], "topic": r["topic_name"], "users": r["users"],
                       "solved": r["solved"], "correct": r["correct"], "avgProgress": round(r["avg_progress"], 1)})

    catalog = {
        "tasks": one("SELECT COUNT(*) AS c FROM tasks")["c"],
        "lessons": lessons_total,
        "missions": one("SELECT COUNT(*) AS c FROM missions")["c"],
        "bosses": one("SELECT COUNT(*) AS c FROM bosses")["c"],
        "skills": one("SELECT COUNT(*) AS c FROM skills")["c"],
        "achievements": one("SELECT COUNT(*) AS c FROM achievements")["c"],
    }

    solved = stats["solved"] or 0
    system = {
        "serverTime": now_iso(),
        "startedAt": int(SERVER_STARTED_AT.timestamp() * 1000),
        "uptimeSec": int(time.time() - SERVER_STARTED_AT.timestamp()),
        "python": sys.version.split()[0],
        "dbPath": str(DB_PATH),
        "dbSizeBytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
        "schemaVersion": one("PRAGMA user_version")["user_version"] if one("PRAGMA user_version") else 0,
        "adminSessions": one("SELECT COUNT(*) AS c FROM admin_sessions WHERE expires_at > ?", int(time.time() * 1000))["c"],
        "xpAdjustments": one("SELECT COUNT(*) AS c FROM user_xp_adjustments")["c"],
    }

    return {
        "users": {"total": users_total, "onboarded": onboarded, "named": named, "newToday": new_today,
                  "newWeek": new_week, "activeToday": active_today, "activeWeek": active_week,
                  "activeEver": active_ever, "avgXp": round(stats["avg_xp"], 1), "bestStreak": stats["best_streak"]},
        "learning": {"xpTotal": stats["xp"], "solvedTotal": solved, "correctTotal": stats["correct"],
                     "accuracy": round(100 * stats["correct"] / solved, 1) if solved else None,
                     "timeSecTotal": round(stats["time_sec"]), "hintsUsed": stats["hints"],
                     "attemptsToday": attempts_today, "openErrors": open_errors,
                     "completedLessons": completed_lessons, "missionsDone": missions_done,
                     "bossesDefeated": bosses_defeated},
        "activity": activity,
        "leaders": leaders,
        "skills": skills,
        "catalog": catalog,
        "system": system,
    }


def admin_users_list(conn: sqlite3.Connection, query: str | None) -> list[dict]:
    rows = conn.execute("""SELECT u.id, u.account_id, u.name, u.created_at, u.onboarded, u.self_level, u.goal_id,
                                  COALESCE(s.xp,0) AS xp, COALESCE(s.streak,0) AS streak, s.last_active_date,
                                  COALESCE(s.total_solved,0) AS total_solved, COALESCE(s.total_correct,0) AS total_correct
                           FROM users u LEFT JOIN user_stats s ON s.user_id = u.id
                           ORDER BY u.id""").fetchall()
    result = []
    q = (query or "").strip().lower()
    for r in rows:
        item = {
            "id": r["id"], "accountId": r["account_id"], "name": r["name"],
            "createdAt": timestamp_value(r["created_at"]), "onboarded": bool(r["onboarded"]),
            "selfLevel": r["self_level"], "goal": r["goal_id"],
            "xp": r["xp"], "level": level_from_xp(r["xp"])["level"], "streak": r["streak"],
            "lastActiveDate": r["last_active_date"], "solved": r["total_solved"], "correct": r["total_correct"],
        }
        if q:
            haystack = " ".join(str(x) for x in (item["accountId"], item["name"], item["id"], item["selfLevel"], item["goal"]) if x).lower()
            if q not in haystack:
                continue
        result.append(item)
    return result


def admin_user_detail(conn: sqlite3.Connection, user_id: int) -> dict | None:
    ensure_subject_schema(conn)
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not user:
        return None
    stats = conn.execute("SELECT * FROM user_stats WHERE user_id=?", (user_id,)).fetchone()
    xp = stats["xp"] if stats else 0
    detail = {
        "id": user["id"], "accountId": user["account_id"], "name": user["name"],
        "createdAt": timestamp_value(user["created_at"]), "onboarded": bool(user["onboarded"]),
        "selfLevel": user["self_level"], "goal": user["goal_id"],
        "stats": {
            "xp": xp, "level": level_from_xp(xp), "streak": stats["streak"] if stats else 0,
            "lastActiveDate": stats["last_active_date"] if stats else None,
            "totalSolved": stats["total_solved"] if stats else 0,
            "totalCorrect": stats["total_correct"] if stats else 0,
            "accuracy": round(100 * stats["total_correct"] / stats["total_solved"], 1) if stats and stats["total_solved"] else None,
            "totalTimeSec": round(stats["total_time_sec"]) if stats else 0,
            "hintsUsed": stats["hints_used"] if stats else 0,
            "correctSeries": stats["correct_series"] if stats else 0,
            "bestSeries": stats["best_series"] if stats else 0,
            "errorsResolved": stats["errors_resolved"] if stats else 0,
        },
        "counts": {
            "skillsTouched": conn.execute("SELECT COUNT(*) AS c FROM user_progress WHERE user_id=? AND solved>0", (user_id,)).fetchone()["c"],
            "skillsTotal": conn.execute("SELECT COUNT(*) AS c FROM skills").fetchone()["c"],
            "lessonsCompleted": conn.execute("SELECT COUNT(*) AS c FROM completed_lessons WHERE user_id=?", (user_id,)).fetchone()["c"],
            "lessonsTotal": conn.execute("SELECT COUNT(*) AS c FROM lessons").fetchone()["c"],
            "missionsDone": conn.execute("SELECT COUNT(*) AS c FROM user_missions WHERE user_id=? AND completed_at IS NOT NULL", (user_id,)).fetchone()["c"],
            "bossesDefeated": conn.execute("SELECT COUNT(*) AS c FROM user_bosses WHERE user_id=?", (user_id,)).fetchone()["c"],
            "achievements": conn.execute("SELECT COUNT(*) AS c FROM user_achievements WHERE user_id=?", (user_id,)).fetchone()["c"],
            "openErrors": conn.execute("SELECT COUNT(*) AS c FROM user_errors WHERE user_id=? AND resolved=0", (user_id,)).fetchone()["c"],
            "attempts": conn.execute("SELECT COUNT(*) AS c FROM task_attempts WHERE user_id=?", (user_id,)).fetchone()["c"],
        },
        "xpAdjustments": [{"amount": r["amount"], "reason": r["reason"], "ts": timestamp_value(r["created_at"])}
                          for r in conn.execute("SELECT * FROM user_xp_adjustments WHERE user_id=? ORDER BY id DESC", (user_id,))],
        "skills": [],
        "errors": [],
        "timeline": [],
        "recentAttempts": [],
        "activity": [],
        "achievements": [],
        "adminSessions": conn.execute(
            "SELECT COUNT(*) AS c FROM admin_sessions WHERE user_id=? AND expires_at > ?",
            (user_id, int(time.time() * 1000))).fetchone()["c"],
    }
    for r in conn.execute("""SELECT up.skill_id, up.progress, up.solved, up.correct, up.time_sec, sk.name, t.name AS topic
                             FROM user_progress up JOIN skills sk ON sk.id=up.skill_id LEFT JOIN topics t ON t.id=sk.topic_id
                             WHERE up.user_id=? AND (up.solved>0 OR up.progress>0) ORDER BY up.progress DESC, up.solved DESC""", (user_id,)):
        detail["skills"].append({"id": r["skill_id"], "name": r["name"], "topic": r["topic"], "progress": r["progress"],
                                 "solved": r["solved"], "correct": r["correct"], "timeSec": round(r["time_sec"])})
    task_titles = {r["id"]: r["exam_number"] for r in conn.execute("SELECT id, exam_number FROM tasks")}
    for r in conn.execute("""SELECT e.id, e.task_id, e.skill_id, e.topic, e.created_at, e.resolved, e.kind, sk.name AS skill_name
                             FROM user_errors e LEFT JOIN skills sk ON sk.id=e.skill_id
                             WHERE e.user_id=? ORDER BY e.id DESC LIMIT 100""", (user_id,)):
        detail["errors"].append({"id": r["id"], "taskId": r["task_id"], "examNumber": task_titles.get(r["task_id"]),
                                 "skill": r["skill_name"] or r["skill_id"], "topic": r["topic"],
                                 "ts": timestamp_value(r["created_at"]), "resolved": bool(r["resolved"]),
                                 "kind": (_normalize_error_kind(r["kind"]) if "kind" in r.keys() and r["kind"] else "major")})
    for r in conn.execute("SELECT created_at, text FROM timeline WHERE user_id=? ORDER BY id DESC LIMIT 40", (user_id,)):
        detail["timeline"].append({"ts": timestamp_value(r["created_at"]), "text": r["text"]})
    skill_names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM skills")}
    for r in conn.execute("""SELECT a.task_id, a.skill_id, a.correct, a.hint_level, a.seconds, a.created_at
                             FROM task_attempts a WHERE a.user_id=? ORDER BY a.id DESC LIMIT 50""", (user_id,)):
        detail["recentAttempts"].append({"taskId": r["task_id"], "examNumber": task_titles.get(r["task_id"]),
                                         "skill": skill_names.get(r["skill_id"], r["skill_id"]),
                                         "correct": bool(r["correct"]), "hintLevel": r["hint_level"],
                                         "seconds": round(r["seconds"]), "ts": timestamp_value(r["created_at"])})
    for r in conn.execute("SELECT activity_date, solved, correct, xp FROM activity_history WHERE user_id=? ORDER BY activity_date DESC LIMIT 60", (user_id,)):
        detail["activity"].append({"date": r["activity_date"], "solved": r["solved"], "correct": r["correct"], "xp": r["xp"]})
    for r in conn.execute("""SELECT ua.achievement_id, ua.unlocked_at, a.name, a.icon, a.description
                             FROM user_achievements ua LEFT JOIN achievements a ON a.id=ua.achievement_id
                             WHERE ua.user_id=? ORDER BY ua.unlocked_at DESC""", (user_id,)):
        detail["achievements"].append({"id": r["achievement_id"], "name": r["name"], "icon": r["icon"],
                                       "description": r["description"], "ts": timestamp_value(r["unlocked_at"])})
    return detail


def resolve_admin_target(conn: sqlite3.Connection, ref: str) -> int | None:
    """Resolve an admin API user reference: the public Account ID or the
    internal numeric id. Anything else is None (never a partial match)."""
    ref = (ref or "").strip()
    if not ref:
        return None
    row = conn.execute("SELECT id FROM users WHERE account_id=?", (ref,)).fetchone()
    if row:
        return row["id"]
    if ref.isdigit():
        row = conn.execute("SELECT id FROM users WHERE id=?", (int(ref),)).fetchone()
        if row:
            return row["id"]
    return None


SELF_LEVELS = {"zero", "base", "confident"}


def admin_update_profile(conn: sqlite3.Connection, user_id: int, payload: dict) -> dict:
    """Edit the profile fields an admin may legitimately correct. Only
    name/selfLevel/goal are accepted; keys absent from the payload are kept."""
    user = conn.execute("SELECT name, self_level, goal_id FROM users WHERE id=?", (user_id,)).fetchone()
    if not user:
        raise KeyError("user not found")
    name, self_level, goal = user["name"], user["self_level"], user["goal_id"]
    if "name" in payload:
        raw = payload["name"]
        if raw is not None and not isinstance(raw, str):
            raise ValueError("name must be a string or null")
        name = sanitize_name(raw) if raw is not None else None
    if "selfLevel" in payload:
        value = payload["selfLevel"]
        if value is not None and value not in SELF_LEVELS:
            raise ValueError("selfLevel must be one of: zero, base, confident (or null)")
        self_level = value
    if "goal" in payload:
        value = payload["goal"]
        if value is not None:
            # Правка админом идёт в профиль основного предмета — цели берём
            # через тот же резолвер конфига, без третьей копии SQL.
            goal_ids = {g.get("id") for g in _subject_config(conn, "goals", DEFAULT_SUBJECT, [], True) or []}
            if value not in goal_ids:
                raise ValueError(f"unknown goal: {value}")
        goal = value
    conn.execute("UPDATE users SET name=?, self_level=?, goal_id=? WHERE id=?", (name, self_level, goal, user_id))
    bump_state_versions(conn, user_id, DEFAULT_SUBJECT)
    conn.commit()
    return {"id": user_id, "name": name, "selfLevel": self_level, "goal": goal}


def admin_grant_xp(conn: sqlite3.Connection, user_id: int, amount: int, reason: str) -> dict:
    """Manual XP correction through the same append-only audit log the client's
    grantXp uses: derive_stats always adds these rows to the derived XP, and a
    client sync can never wipe them. Negative amounts deduct."""
    amount = int(amount)
    if not -100000 <= amount <= 100000 or amount == 0:
        raise ValueError("amount must be a non-zero integer within ±100000")
    reason = " ".join(str(reason or "").split())[:200] or "admin"
    conn.execute("BEGIN")
    grant_subject = current_subject_for(conn, user_id)
    conn.execute("INSERT INTO user_xp_adjustments(user_id, subject, amount, reason, created_at) VALUES (?,?,?,?,?)",
                 (user_id, grant_subject, amount, f"admin: {reason}", now_iso()))
    stats = conn.execute("SELECT xp FROM user_stats WHERE user_id=? AND subject=?", (user_id, grant_subject)).fetchone()
    new_xp = max(0, (stats["xp"] if stats else 0) + amount)
    conn.execute("""INSERT INTO user_stats(user_id, subject, xp) VALUES(?,?,?)
                    ON CONFLICT(user_id, subject) DO UPDATE SET xp=excluded.xp""", (user_id, grant_subject, new_xp))
    conn.execute("INSERT INTO timeline(user_id, subject, created_at, text) VALUES (?,?,?,?)",
                 (user_id, grant_subject, now_iso(), f"Админ-корректировка XP: {amount:+d} ({reason})"))
    bump_state_versions(conn, user_id, grant_subject)
    conn.commit()
    return {"xp": new_xp, "level": level_from_xp(new_xp), "amount": amount, "reason": reason}


def admin_reset(conn: sqlite3.Connection, user_id: int, target: str) -> dict:
    """Targeted resets. Each clears only the named state; 'all-progress'
    wipes learning history but keeps the account row itself."""
    if not conn.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone():
        raise KeyError("user not found")
    groups = {
        "streak": {
            "tables": [],
            "stats": "UPDATE user_stats SET streak=0, correct_series=0 WHERE user_id=?",
            "label": "Серия дней сброшена",
        },
        "errors": {
            "tables": ["user_errors", "lesson_step_errors", "lesson_error_history"],
            "stats": "UPDATE user_stats SET errors_resolved=0 WHERE user_id=?",
            "label": "Ошибки и история ошибок очищены",
        },
        "daily": {
            "tables": ["daily_progress"],
            "stats": None,
            "label": "Ежедневная подборка сброшена",
        },
        "forecast": {
            "tables": ["forecast_history"],
            "stats": None,
            "label": "История прогноза очищена",
        },
        "all-progress": {
            "tables": ["user_progress", "user_hint_levels", "user_errors", "task_attempts", "lesson_attempts",
                       "lesson_step_errors", "lesson_error_history", "lesson_sessions", "completed_lessons",
                       "user_missions", "user_bosses", "user_achievements", "activity_history",
                       "forecast_history", "daily_progress", "timeline", "diagnostics"],
            "stats": "UPDATE user_stats SET xp=0, streak=0, last_active_date=NULL, total_solved=0, total_correct=0, total_time_sec=0, hints_used=0, correct_series=0, best_series=0, errors_resolved=0 WHERE user_id=?",
            "label": "Весь прогресс сброшен",
        },
    }
    if target not in groups:
        raise ValueError(f"unknown reset target: {target}")
    group = groups[target]
    conn.execute("BEGIN")
    for table in group["tables"]:
        conn.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
    if group["stats"]:
        conn.execute(group["stats"], (user_id,))
    if target == "all-progress":
        # XP is derived from events plus the adjustment log; wiping events
        # while leaving grants would resurrect XP from nothing. Keep per-subject
        # rows and advance their versions: recreating them at version 1 could
        # let a very old version-1 tab write after a reset.
        conn.execute("DELETE FROM user_xp_adjustments WHERE user_id=?", (user_id,))
        conn.execute("UPDATE users SET onboarded=0, self_level=NULL, goal_id=NULL WHERE id=?", (user_id,))
        conn.execute("UPDATE user_subjects SET onboarded=0, self_level=NULL, goal_id=NULL WHERE user_id=?", (user_id,))
        conn.execute("INSERT INTO timeline(user_id, subject, created_at, text) VALUES (?,?,?,?)",
                     (user_id, current_subject_for(conn, user_id), now_iso(), "Админ сбросил весь прогресс аккаунта"))
    bump_state_versions(conn, user_id)
    conn.commit()
    return {"ok": True, "target": target, "message": group["label"]}


def admin_delete_user(conn: sqlite3.Connection, user_id: int, actor_id: int) -> dict:
    if user_id == actor_id:
        raise ValueError("cannot delete the account that holds this admin session")
    user = conn.execute("SELECT account_id FROM users WHERE id=?", (user_id,)).fetchone()
    if not user:
        raise KeyError("user not found")
    conn.execute("BEGIN")
    # ON DELETE CASCADE clears stats, progress, attempts and admin sessions.
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    conn.execute("INSERT INTO admin_audit(actor_user_id, action, target_user_id, detail, created_at) VALUES (?,?,?,?,?)",
                 (actor_id, "delete-user", user_id, user["account_id"] or "", now_iso()))
    conn.commit()
    return {"ok": True, "deleted": user_id, "accountId": user["account_id"]}


def admin_audit(conn: sqlite3.Connection, actor_id: int, action: str, target_id: int | None, detail: str = "") -> None:
    conn.execute("INSERT INTO admin_audit(actor_user_id, action, target_user_id, detail, created_at) VALUES (?,?,?,?,?)",
                 (actor_id, action, target_id, detail[:200], now_iso()))
    conn.commit()


def admin_audit_list(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("""SELECT a.id, a.actor_user_id, a.action, a.target_user_id, a.detail, a.created_at,
                                  u1.account_id AS actor_account, u2.account_id AS target_account
                           FROM admin_audit a
                           LEFT JOIN users u1 ON u1.id = a.actor_user_id
                           LEFT JOIN users u2 ON u2.id = a.target_user_id
                           ORDER BY a.id DESC LIMIT 200""").fetchall()
    return [{"id": r["id"], "actorId": r["actor_user_id"], "actorAccount": r["actor_account"],
             "action": r["action"], "targetId": r["target_user_id"], "targetAccount": r["target_account"],
             "detail": r["detail"], "ts": timestamp_value(r["created_at"])} for r in rows]


def _daily_xp(conn: sqlite3.Connection, subject: str | None = None) -> int:
    subject = resolve_subject(subject)
    row = conn.execute("SELECT value_json FROM app_config WHERE key=?", (f"daily:{subject}",)).fetchone()
    if row:
        return int(json.loads(row["value_json"]).get("xp", 0))
    row = conn.execute("SELECT value_json FROM app_config WHERE key='daily'").fetchone()
    if not row: return 0
    return int(json.loads(row["value_json"]).get("xp", 0))


def _msk_date_key(ts) -> str | None:
    """Московская дата (YYYY-MM-DD) для миллисекундной метки — зеркало
    dateKeyForTimestamp из js/state.js. Нечисловые метки дают None."""
    try:
        ms = int(ts)
    except (TypeError, ValueError):
        return None
    try:
        return dt.datetime.fromtimestamp(ms / 1000, tz=ZoneInfo("Europe/Moscow")).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _lesson_steps_caps(conn: sqlite3.Connection) -> dict:
    """Легитимный максимум XP за шаги каждого урока = сумма step.xp из
    каталога. Присланный сверху steps_xp обрезается этим потолком."""
    caps = {}
    for r in conn.execute("SELECT id, metadata_json FROM lessons"):
        try:
            steps = json.loads(r["metadata_json"] or "{}").get("steps") or []
            caps[r["id"]] = sum(int(st.get("xp") or 0) for st in steps if isinstance(st, dict))
        except (ValueError, TypeError):
            caps[r["id"]] = 0
    return caps


def derive_stats(conn: sqlite3.Connection, state: dict, user_id: int | None = None) -> dict:
    """Recompute the XP-bearing counters from the submitted, catalog-backed
    event data instead of trusting the plain numbers the client sends for
    them (xp/totalSolved/... are otherwise ordinary JSON fields in the PUT
    body — nothing else in the payload constrains them, so they can be set
    to anything, e.g. from the browser console). Mirrors the client's own
    xp formula (see recordAnswer in js/state.js) but only pays out "answer"
    xp once per task, so resubmitting an already-solved task for XP has no
    effect here even if the client-side guard is bypassed."""
    derive_subject = resolve_subject(state.get("subject") if isinstance(state, dict) else None)
    # Все XP-источники - строго в рамках предмета снапшота: чужие id
    # (например, уроки профиля в снапшоте базы) не платят.
    subj_skills = {r["id"] for r in conn.execute("SELECT id FROM skills WHERE subject=?", (derive_subject,))}
    tasks = {r["id"]: r["difficulty"] for r in conn.execute(
        "SELECT t.id AS id, t.difficulty AS difficulty FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject=?", (derive_subject,))}
    lessons_xp = {r["id"]: r["xp"] for r in conn.execute(
        "SELECT l.id AS id, l.xp AS xp FROM lessons l JOIN skills s ON s.id=l.skill_id WHERE s.subject=?", (derive_subject,))}
    missions_xp = {r["id"]: r["xp"] for r in conn.execute(
        "SELECT m.id AS id, m.xp AS xp FROM missions m JOIN skills s ON s.id=m.skill_id WHERE s.subject=?", (derive_subject,))}
    bosses_xp = {r["id"]: r["xp"] for r in conn.execute(
        "SELECT b.id AS id, b.xp AS xp FROM bosses b JOIN topics t ON t.id=b.topic_id WHERE t.subject=?", (derive_subject,))}
    daily_xp = _daily_xp(conn, derive_subject)

    def _attempt_sort_key(a) -> int:
        # Смешанные типы ts (строка + число) раньше роняли сортировку через
        # TypeError вне except-блоков do_PUT — save обрывался без JSON-ошибки.
        try:
            return int(a.get("ts") or 0)
        except (TypeError, ValueError, AttributeError):
            return 0

    attempts = sorted(
        (a for a in (state.get("taskAttempts") or []) if isinstance(a, dict) and a.get("taskId") in tasks),
        key=_attempt_sort_key,
    )

    xp = 0
    total_solved = 0
    total_correct = 0
    hints_used = 0
    correct_series = 0
    best_series = 0
    solved_once = set()  # полный бонус за верное решение — один раз; повтор даёт только минимум попытки

    for a in attempts:
        # Числовой мусор в одной попытке (hintLevel="abc") раньше ронял весь
        # derive через ValueError — запись скипается, как в write_state.
        try:
            hint_level = int(a.get("hintLevel") or 0)
        except (TypeError, ValueError):
            continue
        total_solved += 1
        if hint_level > 0:
            hints_used += 1
        is_correct = bool(a.get("correct")) and hint_level < 3
        task_id = a.get("taskId")
        already_mastered = task_id in solved_once
        # Попытка платит минимум всегда — практика никогда не даёт +0 XP.
        xp += attempt_xp(tasks.get(task_id, 1), is_correct, hint_level, already_mastered)
        if is_correct:
            total_correct += 1
            correct_series += 1
            best_series = max(best_series, correct_series)
            solved_once.add(task_id)
        else:
            correct_series = 0

    errors_resolved = 0
    # Бонус за закрытую ошибку платится один раз на задание и только если оно
    # реально подтверждено верным решением. Подтверждение — это correct-попытка
    # либо по самому заданию, либо (умное повторение: reviewQueueForErrors
    # подбирает ДРУГОЕ задание той же подтемы, связь — errorMap/closesTaskId,
    # клиент закрывает исходную ошибку в recordAnswer) верная попытка с
    # closesTaskId исходного задания. Иначе флаг resolved:true в payload
    # рисует +15 XP из ничего за каждую запись.
    closed_via_review = set()
    for a in attempts:
        if not isinstance(a, dict):
            continue
        try:
            _hl = int(a.get("hintLevel") or 0)
        except (TypeError, ValueError):
            continue
        closes = a.get("closesTaskId")
        if bool(a.get("correct")) and _hl < 3 and isinstance(closes, str) and closes in tasks:
            closed_via_review.add(closes)
    counted_err_tasks = set()
    for e in state.get("errors") or []:
        if not isinstance(e, dict):
            continue
        task_id = e.get("taskId")
        if (e.get("resolved") and task_id in tasks
                and (task_id in solved_once or task_id in closed_via_review)
                and task_id not in counted_err_tasks):
            counted_err_tasks.add(task_id)
            errors_resolved += 1
            xp += XP_ERROR_RESOLVED

    # Daily-бонус платится только за дни, где решение подтверждено историей
    # попыток: distinct correct-попыток по taskIds этого дня (московская дата)
    # не меньше длины подборки — зеркало ensureDailyChallenge/recordAnswer
    # (done = solved >= taskIds.length). Голый флаг done:true без попыток
    # раньше давал +daily_xp за каждую выдуманную дату.
    correct_by_date: dict[str, set] = {}
    for a in attempts:
        try:
            _hl = int(a.get("hintLevel") or 0)
        except (TypeError, ValueError):
            continue
        if bool(a.get("correct")) and _hl < 3:
            d = _msk_date_key(a.get("ts"))
            if d:
                correct_by_date.setdefault(d, set()).add(a.get("taskId"))
    dates_done = set()
    for entry in (list(state.get("dailyHistory") or []) + [state.get("daily") or {}]):
        if not isinstance(entry, dict):
            continue
        if not (entry.get("done") and entry.get("date")):
            continue
        task_ids = entry.get("taskIds")
        if not isinstance(task_ids, list) or not task_ids:
            continue
        solved = len(set(task_ids) & correct_by_date.get(entry["date"], set()))
        if solved >= len(task_ids):
            dates_done.add(entry["date"])
    xp += daily_xp * len(dates_done)

    # Анти-фарм по урокам считаем по completedLessons (PK user_id+lesson_id,
    # физически не может содержать дубль), а не по флагу firstCompletion в
    # lessonAttempts — его можно подделать повторной отправкой payload.
    completed_lessons = set((state.get("completedLessons") or {}).keys())
    for lesson_id in completed_lessons:
        if lesson_id in lessons_xp:
            xp += lessons_xp[lesson_id]
    # XP за шаги уроков: берём из первой попытки с firstCompletion, но только
    # если урок реально завершён по completedLessons. Сумма обрезана потолком
    # из каталога (сумма step.xp) — присланный сверху steps_xp без потолка
    # рисовал произвольный XP. Повторные попытки шагов не платят.
    steps_caps = _lesson_steps_caps(conn)
    steps_counted = set()
    for item in state.get("lessonAttempts") or []:
        if not isinstance(item, dict):
            continue
        lesson_id = item.get("lessonId")
        if (item.get("firstCompletion") and lesson_id in completed_lessons
                and lesson_id not in steps_counted):
            try:
                steps_xp = int(item.get("xp", 0)) - int(lessons_xp.get(lesson_id, 0))
            except (TypeError, ValueError):
                steps_xp = 0
            steps_xp = max(0, min(steps_xp, steps_caps.get(lesson_id, 0)))
            xp += steps_xp
            steps_counted.add(lesson_id)

    missions_done = state.get("missionsDone") if isinstance(state.get("missionsDone"), dict) else {}
    for mission_id in missions_done.keys():
        xp += missions_xp.get(mission_id, 0)

    # Нехешируемый мусор в списке раньше ронял set() через TypeError вне
    # except-блоков do_PUT. Итерируем безопасно, чужое игнорим.
    seen_boss_ids = set()
    for boss_id in (state.get("bossesDefeated") or []):
        if not isinstance(boss_id, str) or boss_id in seen_boss_ids:
            continue
        seen_boss_ids.add(boss_id)
        xp += bosses_xp.get(boss_id, 0)

    # Manual XP adjustments (admin grants). The persisted log is the ONLY
    # source: write_state refuses to insert new rows from a client payload,
    # so anything the payload claims here is untrusted and ignored.
    # Гранты - тоже в разрезе предмета: иначе награда профиля удвоится в базе.
    if user_id is not None:
        for amount, reason, created_at in conn.execute("SELECT amount, reason, created_at FROM user_xp_adjustments WHERE user_id=? AND subject=?", (user_id, derive_subject)):
            xp += int(amount)

    # Milestone-бонус за каждый достигнутый уровень. Бонус входит в итоговый XP,
    # поэтому после добавления уровень может подняться ещё на шаг — ищем
    # неподвижную точку: xp = pure + (level(xp)-1)*50 (не более ~5 итераций).
    pure = xp
    xp_with_bonus = pure
    for _ in range(10):
        lv = level_from_xp(xp_with_bonus)["level"]
        cand = pure + (lv - 1) * XP_LEVEL_MILESTONE
        if cand == xp_with_bonus:
            break
        xp_with_bonus = cand
    xp = xp_with_bonus

    return {
        "xp": xp, "totalSolved": total_solved, "totalCorrect": total_correct,
        "hintsUsed": hints_used, "correctSeries": correct_series, "bestSeries": best_series,
        "errorsResolved": errors_resolved,
    }


def apply_derived_stats(conn: sqlite3.Connection, user_id: int, state: dict) -> None:
    """Overwrite the client-sent xp/totals in `state` with server-derived ones.
    Cumulative counters are clamped to never drop below what is already
    persisted, so a client that only synced a recent, size-capped slice of
    its full history (taskAttempts is capped at 5000 entries client-side)
    never regresses a long-time user's real, previously-saved totals."""
    derived = derive_stats(conn, state, user_id)
    clamp_subject = resolve_subject(state.get("subject") if isinstance(state, dict) else None)
    prev = conn.execute(
        "SELECT xp, total_solved, total_correct, hints_used, best_series, errors_resolved FROM user_stats WHERE user_id=? AND subject=?",
        (user_id, clamp_subject),
    ).fetchone()
    for key, col in (
        ("xp", "xp"), ("totalSolved", "total_solved"), ("totalCorrect", "total_correct"),
        ("hintsUsed", "hints_used"), ("bestSeries", "best_series"), ("errorsResolved", "errors_resolved"),
    ):
        state[key] = max(derived[key], prev[col] if prev else 0)
    state["correctSeries"] = derived["correctSeries"]


def validate_state(conn: sqlite3.Connection, state: dict) -> None:
    if not isinstance(state, dict): raise ValueError("state must be an object")
    if state.get("subject") is not None and not is_known_subject(state.get("subject")): raise ValueError("unknown subject")
    name = state.get("name")
    if name is not None and not isinstance(name, str): raise ValueError("invalid name")
    if isinstance(name, str) and len(name.strip()) > MAX_NAME_LENGTH: raise ValueError("name too long")
    for key in ("xp", "streak", "totalSolved", "totalCorrect", "hintsUsed", "correctSeries", "bestSeries", "errorsResolved"):
        value = state.get(key, 0)
        if not isinstance(value, (int, float)) or not isinstance(value, int) and value != int(value): raise ValueError(f"invalid {key}")
        if not 0 <= value <= MAX_COUNTER_VALUE: raise ValueError(f"invalid {key}")
    # totalTimeSec — единственное дробное поле (сумма секунд с долями), остальные — целые счётчики
    tv = state.get("totalTimeSec", 0)
    if not isinstance(tv, (int, float)): raise ValueError("invalid totalTimeSec")
    if not 0 <= float(tv) <= MAX_COUNTER_VALUE: raise ValueError("invalid totalTimeSec")
    if state.get("totalCorrect", 0) > state.get("totalSolved", 0): raise ValueError("correct answers exceed attempts")
    # Unbounded client-controlled collections are a DB-bloat vector: a single
    # PUT can otherwise write millions of rows that then load on every
    # bootstrap. The app itself caps these client-side; the caps below are
    # generous headroom over those client caps, not tighter semantics.
    for key, cap in (("taskAttempts", MAX_TASK_ATTEMPTS), ("errors", MAX_ERRORS), ("timeline", MAX_TIMELINE),
                     ("lessonAttempts", MAX_LESSON_ATTEMPTS), ("lessonErrorHistory", MAX_LESSON_ERROR_HISTORY),
                     ("diagnostics", MAX_DIAGNOSTICS), ("dailyHistory", MAX_DAILY_HISTORY),
                     ("forecastHistory", MAX_FORECAST_HISTORY)):
        value = state.get(key, [])
        if not isinstance(value, list): raise ValueError(f"{key} must be an array")
        if len(value) > cap: raise ValueError(f"{key} too large")
    for key in ("skillStats", "lessonStepErrors", "lessonSessions", "completedLessons", "missionProgress",
                "missionsDone", "achievements", "activity", "hintLevels"):
        if state.get(key) is not None and not isinstance(state.get(key), dict): raise ValueError(f"{key} must be an object")
        if isinstance(state.get(key), dict) and len(state[key]) > MAX_STATE_DICT: raise ValueError(f"{key} too large")
    if isinstance(state.get("activity"), dict) and len(state["activity"]) > MAX_ACTIVITY_DAYS:
        raise ValueError("activity too large")
    if not isinstance(state.get("bossesDefeated", []), list): raise ValueError("bossesDefeated must be an array")
    if len(state.get("bossesDefeated") or []) > MAX_BOSSES: raise ValueError("bossesDefeated too large")
    valid_skills = {r["id"] for r in conn.execute("SELECT id FROM skills")}
    # skillStats позаписно не валидируем: битые значения отбрасывает
    # write_state, а отклонение всего PUT из-за одной записи — тот самый
    # класс багов «ломают сохранение» (см. taskAttempts ниже).
    valid_tasks = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
    for item in state.get("taskAttempts") or []:
        # Одна битая попытка из тысяч раньше отклоняла весь PUT целиком —
        # теперь такие записи пропускаются (write_state/derive фильтруют так же).
        if not isinstance(item, dict):
            continue
        if item.get("skill") not in valid_skills:
            continue
        # taskId может ссылаться на удалённую/заблокированную задачу из старой
        # истории — не отклоняем весь PUT, просто игнорируем её при подсчёте XP
        # и не пишем в БД (write_state фильтрует так же). Строгая проверка
        # ломала сохранение уроков у пользователей с legacy-историей.
        if item.get("taskId") not in valid_tasks:
            continue
        # skill уже проверен выше; taskId — lenient
    if not isinstance(state.get("errors", []), list): raise ValueError("errors must be an array")
    if not isinstance(state.get("xpAdjustments", []), list): raise ValueError("xpAdjustments must be an array")
    for adj in state.get("xpAdjustments") or []:
        if not isinstance(adj, dict) or not isinstance(adj.get("amount", 0), (int, float)): raise ValueError("invalid xp adjustment")


class Handler(BaseHTTPRequestHandler):
    server_version = "EGECore/1.0"

    def send_json(self, payload: dict, status: int = 200, token: str | None = None, admin_cookie: str | None = None, clear_session: bool = False):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        # Каталог и состояние — самый тяжёлый JSON (~280 КБ): gzip сжимает
        # его в ~4 раза. Клиенты без Accept-Encoding получают как раньше.
        encoding = None
        accept = self.headers.get("Accept-Encoding", "") or ""
        if len(data) > 1024 and "gzip" in accept.lower():
            data = gzip.compress(data, compresslevel=5)
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_security_headers()
        if token: self.send_header("Set-Cookie", self.session_cookie_attrs(token))
        elif clear_session: self.send_header("Set-Cookie", self.session_cookie_clear_attrs())
        if admin_cookie: self.send_header("Set-Cookie", admin_cookie)
        if encoding: self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def read_json(self):
        # A client can declare an absurd Content-Length and make a handler
        # thread block on a body that never arrives; refuse oversized or
        # malformed bodies outright (state snapshots are far below this cap).
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            raise ValueError("invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        if length < 0:
            raise ValueError("invalid Content-Length")
        return json.loads(self.rfile.read(length) or b"{}")

    # ------------------------------------------------------------------
    # Admin session middleware
    #
    # Every /api/admin/* call goes through this: the *user* is resolved from
    # the regular ege_session cookie WITHOUT creating an account
    # (existing_user_for returns None for unknown cookies — unlike user_for,
    # which mints an anonymous account on public endpoints), and admin rights
    # a live admin_sessions row matching BOTH that user id AND the opaque
    # ege_admin cookie token. Consequences: a stolen/copied ege_admin cookie
    # presented by another account resolves to a different user id and fails;
    # deleting an account cascades its admin sessions; logout clears the row
    # and the cookie. Frontend state is never consulted for authorization.
    # ------------------------------------------------------------------
    def session_cookie_attrs(self, value: str) -> str:
        # Тот же Secure-механизм, что у admin cookie: по HTTP ничего не
        # меняется, под HTTPS токен сессии перестаёт летать открытым текстом.
        secure = "; Secure" if os.environ.get("EGE_ADMIN_COOKIE_SECURE") == "1" or self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"ege_session={value}; Path=/; SameSite=Lax; HttpOnly; Max-Age={AUTH_SESSION_MAX_AGE}{secure}"

    def session_cookie_clear_attrs(self) -> str:
        """Logout: выкидываем токен и из браузера, и из серверной таблицы."""
        secure = "; Secure" if os.environ.get("EGE_ADMIN_COOKIE_SECURE") == "1" or self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"ege_session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0{secure}"

    def admin_cookie_attrs(self, value: str | None, max_age: int) -> str:
        secure = "; Secure" if os.environ.get("EGE_ADMIN_COOKIE_SECURE") == "1" or self.headers.get("X-Forwarded-Proto") == "https" else ""
        if value is None:
            return f"{ADMIN_COOKIE_NAME}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0{secure}"
        return f"{ADMIN_COOKIE_NAME}={value}; Path=/; SameSite=Lax; HttpOnly; Max-Age={max_age}{secure}"

    def require_admin(self, conn: sqlite3.Connection) -> tuple[int, dict] | None:
        """Return (user_id, session) when the caller holds a live admin
        session; otherwise send 401 and return None. Probes never create an
        account: admin rights exist only for an already-signed-in user."""
        user_id = existing_user_for(conn, self)
        if user_id is None:
            self.send_json({"error": "No admin session", "login": True}, 401)
            return None
        session = admin_session_user(conn, user_id, cookie_value(self, ADMIN_COOKIE_NAME))
        if not session:
            self.send_json({"error": "No admin session", "login": True}, 401)
            return None
        return user_id, session

    # ------------------------------------------------------------------
    # User accounts: register / login / logout
    #
    # Register attaches an email + password hash to the CURRENT guest row
    # (user_for), so all learning data survives — same users.id. Login
    # re-binds the browser's session row to the account identified by email;
    # the abandoned guest row stays orphaned in the DB, exactly like a lost
    # cookie today, and is never merged. Logout deletes the session row and
    # clears the cookie; afterwards the old token resolves to nothing and any
    # request mints a fresh guest — auto-login cannot resurrect the account.
    # Identity always comes from the server-side session; the frontend never
    # supplies a user id and never sees the password.
    # ------------------------------------------------------------------
    def handle_auth_register(self, conn: sqlite3.Connection) -> None:
        ip = self.client_address[0] if self.client_address else "?"
        if not auth_login_allowed(ip):
            self.send_json({"error": "Слишком много попыток. Повторите через несколько минут."}, 429)
            return
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        if not isinstance(payload, dict):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        email = normalize_email(payload.get("email"))
        if not email:
            self.send_json({"error": "Введите корректный email"}, 400)
            return
        password = payload.get("password")
        if not isinstance(password, str) or not AUTH_PASSWORD_MIN_LENGTH <= len(password) <= AUTH_PASSWORD_MAX_LENGTH:
            self.send_json({"error": f"Пароль — от {AUTH_PASSWORD_MIN_LENGTH} до {AUTH_PASSWORD_MAX_LENGTH} символов"}, 400)
            return
        user_id, _ = user_for(conn, self)  # текущий гость; привязываем именно его
        current = conn.execute("SELECT email FROM users WHERE id=?", (user_id,)).fetchone()
        if current and current["email"]:
            self.send_json({"error": "Этот аккаунт уже зарегистрирован"}, 409)
            return
        if conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
            auth_login_failed(ip)
            self.send_json({"error": "Этот email уже зарегистрирован"}, 409)
            return
        name = sanitize_name(payload.get("name"))
        # Гард email IS NULL в самом UPDATE: при конкурентной регистрации
        # второй запрос уже не сматчит строку (первый закоммитил) и честно
        # получит 409 вместо мнимого 200 с перезаписанным чужим результатом.
        try:
            cur = conn.execute(
                "UPDATE users SET email=?, password_hash=?, registered_at=?, name=COALESCE(?, name) "
                "WHERE id=? AND email IS NULL",
                (email, hash_password(password), now_iso(), name, user_id),
            )
            if cur.rowcount != 1:
                conn.rollback()
                self.send_json({"error": "Этот аккаунт уже зарегистрирован"}, 409)
                return
            new_token, _ = rotate_user_session(conn, cookie_value(self, "ege_session"), user_id, request_device_info(self))
            conn.commit()
        except sqlite3.IntegrityError:
            # Гонка двух разных гостей за один email: unique-индекс отверг
            # вторую запись — честный 409 вместо 500.
            conn.rollback()
            auth_login_failed(ip)
            self.send_json({"error": "Этот email уже зарегистрирован"}, 409)
            return
        auth_login_success(ip)
        self.send_json({"ok": True, "user": auth_user_payload(conn, user_id)}, token=new_token)

    def handle_auth_login(self, conn: sqlite3.Connection) -> None:
        ip = self.client_address[0] if self.client_address else "?"
        if not auth_login_allowed(ip):
            self.send_json({"error": "Слишком много попыток. Повторите через несколько минут."}, 429)
            return
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        if not isinstance(payload, dict):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        email = normalize_email(payload.get("email"))
        password = payload.get("password")
        if not email or not isinstance(password, str) or not password:
            self.send_json({"error": "Введите email и пароль"}, 400)
            return
        row = conn.execute("SELECT id, password_hash FROM users WHERE email=?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            # Одинаковый текст для несуществующего email и неверного пароля:
            # не подсвечиваем, какие адреса зарегистрированы.
            auth_login_failed(ip)
            self.send_json({"error": "Неверный email или пароль"}, 401)
            return
        account_id = row["id"]
        # Вход всегда ведёт через явный выбор предмета на клиенте: один
        # аккаунт может открываться с разных устройств, поэтому frontend не
        # угадывает current_subject, а показывает пикер и присылает subject
        # сюда (или следующим вызовом POST /api/subject). Переданный
        # известный предмет применяем атомарно к сессии; без него ничего не
        # меняем — старые клиенты, refresh и авто-логин ведут себя как раньше.
        requested = payload.get("subject")
        if is_known_subject(requested):
            set_current_subject(conn, account_id, requested)
        new_token, _ = rotate_user_session(conn, cookie_value(self, "ege_session"), account_id, request_device_info(self))
        conn.commit()
        auth_login_success(ip)
        self.send_json({"ok": True, "user": auth_user_payload(conn, account_id),
                        "requireSubjectChoice": True,
                        "subjects": subjects_payload(),
                        "subject": current_subject_for(conn, account_id)}, token=new_token)

    def handle_auth_logout(self, conn: sqlite3.Connection) -> None:
        # Logout must work even with an invalid/absent cookie: drop whatever
        # session row this token had and clear the cookie. Never mint a user.
        ensure_auth_schema(conn)
        token = cookie_value(self, "ege_session")
        if token:
            conn.execute("DELETE FROM user_sessions WHERE token=?", (token,))
            conn.commit()
        self.send_json({"ok": True}, clear_session=True)

    def handle_auth_devices_list(self, conn: sqlite3.Connection) -> None:
        # Раздел «Устройства» в профиле: все активные серверные сессии
        # текущего аккаунта. Никогда не минтит пользователя и не отдаёт
        # токены/сырой User-Agent — только id строки, название, тип и время.
        ensure_auth_schema(conn)
        token = cookie_value(self, "ege_session")
        row = session_row_for(conn, token, request_device_info(self))
        if not row:
            self.send_json({"error": "Требуется вход"}, 401)
            return
        try:
            conn.execute("DELETE FROM user_sessions WHERE user_id=? AND expires_at<=?",
                         (row["user_id"], int(time.time() * 1000)))
            conn.commit()
        except sqlite3.Error:
            pass
        self.send_json({"devices": auth_devices_payload(conn, row["user_id"], row["session_pk"])})

    def handle_auth_device_revoke(self, conn: sqlite3.Connection, session_id: str) -> None:
        # Отзыв одной сессии. Чужой аккаунт недоступен: несовпадение user_id
        # отвечает тем же 404, что и несуществующий id. Отзыв текущей сессии
        # эквивалентен logout — чистим и куку. Остальные сессии не трогаем.
        ensure_auth_schema(conn)
        token = cookie_value(self, "ege_session")
        row = session_row_for(conn, token, request_device_info(self))
        if not row:
            self.send_json({"error": "Требуется вход"}, 401)
            return
        try:
            target_id = int(str(session_id).strip())
        except (TypeError, ValueError):
            self.send_json({"error": "Неизвестное устройство"}, 404)
            return
        target = conn.execute("SELECT id, user_id FROM user_sessions WHERE id=?", (target_id,)).fetchone()
        if not target or int(target["user_id"]) != int(row["user_id"]):
            self.send_json({"error": "Неизвестное устройство"}, 404)
            return
        conn.execute("DELETE FROM user_sessions WHERE id=?", (target_id,))
        conn.commit()
        if int(target_id) == int(row["session_pk"]):
            self.send_json({"ok": True, "current": True}, clear_session=True)
        else:
            self.send_json({"ok": True, "current": False})

    def handle_admin_login(self, conn: sqlite3.Connection) -> None:
        ip = self.client_address[0] if self.client_address else "?"
        if not admin_login_allowed(ip):
            self.send_json({"error": "Слишком много попыток. Повторите через несколько минут."}, 429)
            return
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        password = payload.get("password")
        if not isinstance(password, str) or not password:
            self.send_json({"error": "Введите пароль"}, 400)
            return
        if not verify_admin_password(password):
            admin_login_failed(ip)
            self.send_json({"error": "Неверный пароль"}, 401)
            return
        admin_login_success(ip)
        user_id, token = user_for(conn, self)
        admin_token, expires_at = create_admin_session(conn, user_id)
        admin_audit(conn, user_id, "admin-login", user_id)
        self.send_json(
            {"ok": True, "expiresAt": expires_at, "user": {"id": user_id, "accountId": account_id_for(conn, user_id), "name": conn.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()["name"]}},
            token=token,
            admin_cookie=self.admin_cookie_attrs(admin_token, ADMIN_SESSION_MAX_AGE),
        )

    def handle_admin_logout(self, conn: sqlite3.Connection) -> None:
        # Logout must work even with an invalid cookie: clear what we can,
        # and never create an account just to log out.
        user_id = existing_user_for(conn, self)
        admin_token = cookie_value(self, ADMIN_COOKIE_NAME)
        if user_id is not None and admin_token:
            conn.execute("DELETE FROM admin_sessions WHERE user_id=? AND token=?", (user_id, admin_token))
            conn.commit()
            admin_audit(conn, user_id, "admin-logout", user_id)
        self.send_json({"ok": True}, admin_cookie=self.admin_cookie_attrs(None, 0))

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ("/api/auth/register", "/api/auth/login", "/api/auth/logout"):
            conn = connect()
            try:
                if path == "/api/auth/register": self.handle_auth_register(conn)
                elif path == "/api/auth/login": self.handle_auth_login(conn)
                else: self.handle_auth_logout(conn)
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError, sqlite3.Error, json.JSONDecodeError) as exc:
                try: conn.rollback()
                except sqlite3.Error: pass
                self.send_json({"error": f"Request failed: {exc}"}, 400)
            finally: conn.close()
            return
        if path == "/api/admin/login" or path == "/api/admin/logout":
            conn = connect()
            try:
                if path == "/api/admin/login": self.handle_admin_login(conn)
                else: self.handle_admin_logout(conn)
            except (ValueError, KeyError, sqlite3.Error) as exc:
                self.send_json({"error": f"Request failed: {exc}"}, 400)
            finally: conn.close()
            return
        if path.startswith("/api/admin/users/"):
            # POST /api/admin/users/<ref>/<action>
            parts = path.split("/")
            if len(parts) == 6 and parts[5] in ("xp", "reset", "delete"):
                conn = connect()
                try:
                    auth = self.require_admin(conn)
                    if not auth: return
                    actor_id, _ = auth
                    target_id = resolve_admin_target(conn, parts[4])
                    if target_id is None:
                        self.send_json({"error": "Пользователь не найден"}, 404); return
                    try:
                        payload = self.read_json()
                    except (json.JSONDecodeError, ValueError):
                        self.send_json({"error": "Некорректный JSON"}, 400); return
                    action = parts[5]
                    if action == "xp":
                        result = admin_grant_xp(conn, target_id, payload.get("amount", 0), payload.get("reason", ""))
                        admin_audit(conn, actor_id, "grant-xp", target_id, f"{result['amount']:+d} {result['reason']}")
                    elif action == "reset":
                        result = admin_reset(conn, target_id, str(payload.get("target", "")))
                        admin_audit(conn, actor_id, "reset", target_id, result["target"])
                    else:
                        result = admin_delete_user(conn, target_id, actor_id)
                    self.send_json(result)
                except (ValueError, KeyError, sqlite3.Error) as exc:
                    try: conn.rollback()
                    except sqlite3.Error: pass
                    status = 404 if isinstance(exc, KeyError) else 400
                    self.send_json({"error": str(exc)}, status)
                finally: conn.close()
                return
        if path == "/api/errors":
            conn = connect()
            try:
                user_id, token = user_for(conn, self)
                payload = self.read_json()
                subject, version, error = domain_write(conn, user_id, payload,
                    lambda sub: create_error(conn, user_id, sub, payload.get("error")))
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "error": error}, token=token)
            except StateConflictError as exc:
                conn.rollback()
                self.send_json({"error": "State conflict", "expectedVersion": exc.expected_version,
                                "currentVersion": exc.current_version}, 409)
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError, sqlite3.Error, json.JSONDecodeError) as exc:
                conn.rollback(); self.send_json({"error": f"Error was not saved: {exc}"}, 400)
            finally: conn.close()
            return
        if path.startswith("/api/events/"):
            conn = connect()
            try:
                user_id, token = user_for(conn, self)
                payload = self.read_json()
                events = payload.get("events") if isinstance(payload, dict) else None
                if not isinstance(events, list):
                    raise ValueError("events must be an array")
                if len(events) > MAX_TASK_ATTEMPTS:
                    raise ValueError("too many events")
                if path == "/api/events/attempts":
                    subject, version, inserted = domain_write(conn, user_id, payload,
                        lambda sub: append_attempt_events(conn, user_id, sub, events))
                elif path == "/api/events/timeline":
                    subject, version, inserted = domain_write(conn, user_id, payload,
                        lambda sub: append_timeline_events(conn, user_id, sub, events))
                else:
                    self.send_json({"error": "Not found"}, 404); return
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "inserted": inserted}, token=token)
            except StateConflictError as exc:
                conn.rollback()
                self.send_json({"error": "State conflict", "expectedVersion": exc.expected_version,
                                "currentVersion": exc.current_version}, 409)
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError, sqlite3.Error, json.JSONDecodeError) as exc:
                conn.rollback(); self.send_json({"error": f"Events were not saved: {exc}"}, 400)
            finally: conn.close()
            return
        if path == "/api/subject":
            # Переключение текущего предмета. Возвращает ЛЁГКИЙ каталог
            # (summary, как bootstrap-lite) + состояние нового предмета —
            # клиент просто перерисовывается, ничего не мержит. Тяжёлые
            # тексты заданий и шаги уроков догружаются лениво через
            # /api/catalog-tasks + /api/catalog-lessons (см. ensureDetails),
            # поэтому клик по предмету не виснет на синхронном скачивании
            # и парсинге ~300 КБ полного каталога.
            conn = connect()
            try:
                user_id, token = user_for(conn, self)
                try:
                    payload = self.read_json()
                except (json.JSONDecodeError, ValueError):
                    self.send_json({"error": "Некорректный JSON"}, 400); return
                wanted = payload.get("subject")
                if not is_known_subject(wanted):
                    self.send_json({"error": "Неизвестный предмет"}, 400); return
                subject = set_current_subject(conn, user_id, wanted)
                self.send_json({"ok": True, "subject": subject,
                                "catalog": catalog_summary_payload(conn, subject),
                                "state": read_state(conn, user_id, subject),
                                "accountId": account_id_for(conn, user_id),
                                "auth": auth_state_payload(conn, user_id)}, token=token)
            except (ValueError, KeyError, sqlite3.Error) as exc:
                try: conn.rollback()
                except sqlite3.Error: pass
                self.send_json({"error": f"Request failed: {exc}"}, 400)
            finally: conn.close()
            return
        self.send_json({"error": "Not found"}, 404)

    def do_GET(self):
        path = urlparse(self.path).path
        # Каноникализация хоста: www-дубль склеиваем 301-м редиректом на apex
        # (www.egeeasy.ru -> egeeasy.ru). Без этого поисковик видит две копии
        # каждой страницы и размывает вес между ними. Правило общее (любой
        # www.* -> apex), поэтому переживёт смену домена; localhost, IP и
        # пустой Host не затрагиваются. Location протокол-независимый (//...),
        # чтобы не ломать схему за обратным прокси: http->https уже делает
        # внешний фронтенд.
        host = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip().lower()
        bare = host.split(":")[0]
        if bare.startswith("www.") and "." in bare[4:]:
            apex = bare[4:] + (":" + host.rsplit(":", 1)[1] if ":" in host else "")
            self.send_response(301)
            self.send_header("Location", "//" + apex + self.path)
            self.send_security_headers()
            self.end_headers()
            return
        if path.startswith("/api/admin"):
            conn = connect()
            try:
                if path == "/api/admin/session":
                    # Status probe for the /admin page: never creates an
                    # account or a session, only reports a live one.
                    user_id = existing_user_for(conn, self)
                    session = admin_session_user(conn, user_id, cookie_value(self, ADMIN_COOKIE_NAME)) if user_id is not None else None
                    if session:
                        user = conn.execute("SELECT name, account_id FROM users WHERE id=?", (user_id,)).fetchone()
                        self.send_json({"admin": True, "expiresAt": session["expiresAt"],
                                        "user": {"id": user_id, "accountId": user["account_id"], "name": user["name"]}})
                    else:
                        self.send_json({"admin": False}, 401)
                    return
                auth = self.require_admin(conn)
                if not auth: return
                user_id, _ = auth
                parsed = urlparse(self.path)
                if path == "/api/admin/overview":
                    from urllib.parse import parse_qs
                    days = parse_qs(parsed.query).get("days", [None])[0]
                    self.send_json(admin_overview(conn, days if days is not None else 14)); return
                if path == "/api/admin/users":
                    from urllib.parse import parse_qs
                    query = parse_qs(parsed.query).get("q", [None])[0]
                    self.send_json({"users": admin_users_list(conn, query)}); return
                if path == "/api/admin/audit":
                    self.send_json({"entries": admin_audit_list(conn)}); return
                if path == "/api/admin/blocked-tasks":
                    self.send_json({"tasks": admin_blocked_tasks(conn)}); return
                parts = path.split("/")
                if len(parts) == 5 and parts[3] == "users":
                    target_id = resolve_admin_target(conn, parts[4])
                    if target_id is None:
                        self.send_json({"error": "Пользователь не найден"}, 404); return
                    detail = admin_user_detail(conn, target_id)
                    if detail is None:
                        self.send_json({"error": "Пользователь не найден"}, 404); return
                    self.send_json({"user": detail}); return
                self.send_json({"error": "Not found"}, 404); return
            except (ValueError, KeyError, sqlite3.Error) as exc:
                self.send_json({"error": f"Request failed: {exc}"}, 500)
            finally: conn.close()
        if path.startswith("/api/"):
            conn = connect()
            try:
                from urllib.parse import parse_qs
                query = parse_qs(urlparse(self.path).query)
                req_subject = query.get("subject", [None])[0]
                # Read-only срезы каталога не заводят аккаунт: каждая такая
                # выдача раньше писала строку в users (спам-аккаунты раздувают
                # БД, а rows без активности висят навсегда).
                if path == "/api/catalog-tasks": self.send_json(catalog_tasks_payload(conn, req_subject)); return
                if path == "/api/catalog-lessons": self.send_json(catalog_lessons_payload(conn, req_subject)); return
                # Публичный срез для страницы /status: аккаунт не заводится,
                # ничего не пишется — только безопасные счётчики каталога.
                # Мягкий лимит 60/мин с IP: живые пользователи его не замечают,
                # а спам отсекается честным 429 (страница покажет уже
                # загруженные данные, а не ошибку).
                if path == "/api/status":
                    ip = self.client_address[0] if self.client_address else "?"
                    if not status_rate_ok(ip):
                        body = json.dumps({"error": "Слишком много запросов. Попробуй через несколько секунд.",
                                           "retryAfter": 10}, ensure_ascii=False).encode("utf-8")
                        self.send_response(429)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Robots-Tag", "noindex, nofollow")
                        self.send_security_headers()
                        self.send_header("Retry-After", "10")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers(); self.wfile.write(body); return
                    self.send_json(public_status_payload(conn)); return
                # Auth-проба не создаёт аккаунт: отвечаем тем, кто уже есть.
                if path == "/api/auth/session":
                    auth_uid = existing_user_for(conn, self)
                    self.send_json({"user": auth_user_payload(conn, auth_uid) if auth_uid is not None else None}); return
                # Устройства: только свои активные сессии, без минта аккаунта.
                if path == "/api/auth/devices":
                    try:
                        self.handle_auth_devices_list(conn)
                    except (ValueError, KeyError, sqlite3.Error) as exc:
                        try: conn.rollback()
                        except sqlite3.Error: pass
                        self.send_json({"error": f"Request failed: {exc}"}, 400)
                    return
                user_id, token = user_for(conn, self)
                if path == "/api/subjects":
                    self.send_json({"subjects": subjects_payload(), "current": current_subject_for(conn, user_id)}, token=token); return
                # Каталог и состояние всегда одного предмета: без ?subject -
                # current_subject пользователя (переживает перезагрузку),
                # с ?subject - явно запрошенный. Разводить их нельзя: иначе
                # клиент получит чужие задания с чужим прогрессом.
                if path == "/api/bootstrap" or path == "/api/bootstrap-lite":
                    eff = req_subject if is_known_subject(req_subject) else current_subject_for(conn, user_id)
                    catalog = catalog_summary_payload(conn, eff) if path == "/api/bootstrap-lite" else catalog_payload(conn, eff)
                    self.send_json({"catalog": catalog, "state": read_state(conn, user_id, eff), "accountId": account_id_for(conn, user_id),
                                    "auth": auth_state_payload(conn, user_id)}, token=token); return
                self.send_json({"error": "Not found"}, 404); return
            finally: conn.close()
        if path == '/':
            file_path = ROOT / "main.html"
        elif path == '/dashboard':
            file_path = ROOT / "index.html"
        elif path == '/admin':
            file_path = ROOT / "admin.html"
        elif path == '/status':
            file_path = ROOT / "status.html"
        elif path == "/sitemap.xml":
            # Карта сайта строится на лету: <loc> обязаны быть абсолютными,
            # а домен зависит от деплоя — берём его из хоста запроса
            # (EGE_PUBLIC_URL в приоритете, см. public_base_url).
            # В sitemap — только публичный лендинг; /dashboard, /admin
            # и /api/* закрыты от индексации и в robots.txt, и мета-тегами.
            base = public_base_url(self)
            lastmod = today()
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                f'  <url><loc>{base}/</loc><lastmod>{lastmod}</lastmod>'
                '<changefreq>weekly</changefreq><priority>1.0</priority></url>\n'
                '</urlset>'
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/xml; charset=utf-8")
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_security_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        else:
            file_path = (ROOT / path.lstrip("/")).resolve() if path != "/" else ROOT / "index.html"
        # Static hosting must never leak the server tree: the SQLite file holds
        # every live session token, .git exposes history/remotes, and server/
        # contains the backend itself. Only the public web surface is served.
        try:
            rel = file_path.relative_to(ROOT)
        except ValueError:
            self.send_error(403); return
        suffix = file_path.suffix.lower()
        if suffix in BLOCKED_STATIC_SUFFIXES and file_path.name not in PUBLIC_STATIC_FILES:
            self.send_error(404); return
        if any(part.startswith(".") or part in BLOCKED_STATIC_DIRS for part in rel.parts[:-1]) or (rel.parts and rel.parts[-1].startswith(".")):
            self.send_error(404); return
        if not file_path.is_file(): self.send_error(404); return
        content_type = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon"}.get(file_path.suffix, "application/octet-stream")
        data = file_path.read_bytes()
        # ETag по хешу содержимого: повторные заходы отдают 304 без тела.
        # Раньше стоял безусловный no-cache без валидатора — каждый reload
        # заново качал ~1.5 МБ JS (jsxgraph 947 КБ + katex 269 КБ + app 141 КБ).
        etag = f'"{hashlib.sha1(data).hexdigest()[:27]}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304); self.send_header("ETag", etag); self.end_headers(); return
        # Вендорные библиотеки и шрифты меняются почти никогда — долгий кэш.
        # HTML — всегда свежий. Наш js/css: revalidate через ETag (304 без тела,
        # если не менялся) — правки видны сразу после обычного reload, ручной
        # бамп ?v= в HTML больше не нужен для корректности.
        if suffix in (".html",):
            cache_control = "no-cache"
        elif rel.parts and rel.parts[0] in ("vendor", "assets"):
            cache_control = "public, max-age=31536000, immutable"
        else:
            cache_control = "no-cache"
        accept = self.headers.get("Accept-Encoding", "") or ""
        encoding = None
        # Текстовую статику жмём: jsxgraph 969 КБ -> ~250 КБ, app.js в ~4 раза.
        if len(data) > 1024 and "gzip" in accept.lower() and suffix in (".js", ".css", ".html", ".json", ".svg", ".ttf", ".txt", ".xml", ".webmanifest"):
            data = gzip.compress(data, compresslevel=5)
            encoding = "gzip"
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Cache-Control", cache_control); self.send_header("ETag", etag); self.send_security_headers()
        # Приватные зоны не индексируются: дублируем meta robots HTTP-заголовком,
        # чтобы и прямые запросы /index.html и /admin.html были закрыты.
        if path in ("/dashboard", "/admin") or file_path.name in ("index.html", "admin.html", "status.html"):
            self.send_header("X-Robots-Tag", "noindex, nofollow")
        if encoding: self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_PATCH(self):
        path = urlparse(self.path).path
        conn = connect()
        try:
            user_id, token = user_for(conn, self)
            payload = self.read_json()
            if path.startswith("/api/progress/"):
                skill_id = path.rsplit("/", 1)[-1]
                subject, version, progress = domain_write(conn, user_id, payload,
                    lambda sub: patch_skill_progress(conn, user_id, sub, skill_id, payload.get("progress")))
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "progress": progress}, token=token)
                return
            if path == "/api/state-domains":
                subject, version, changed = domain_write(conn, user_id, payload,
                    lambda sub: patch_state_domains(conn, user_id, sub, payload.get("domains")))
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "changed": changed}, token=token)
                return
            if path == "/api/settings":
                subject, version, settings = domain_write(conn, user_id, payload,
                    lambda sub: patch_settings(conn, user_id, sub, payload.get("settings")))
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "settings": settings}, token=token)
                return
            if path.startswith("/api/errors/"):
                error_id = path.rsplit("/", 1)[-1]
                if not error_id:
                    raise ValueError("invalid error id")
                # Стабильный ID: integer server id либо client-generated UUID.
                try:
                    error_key = int(error_id) if error_id.strip().isdigit() else error_id.strip()[:128]
                except (TypeError, ValueError, AttributeError):
                    raise ValueError("invalid error id")
                subject, version, error = domain_write(conn, user_id, payload,
                    lambda sub: patch_error_resolved(conn, user_id, sub, error_key, payload.get("resolved"), payload.get("kind")))
                self.send_json({"ok": True, "subject": subject, "stateVersion": version, "error": error}, token=token)
                return
            self.send_json({"error": "Not found"}, 404)
        except StateConflictError as exc:
            conn.rollback()
            self.send_json({"error": "State conflict", "expectedVersion": exc.expected_version,
                            "currentVersion": exc.current_version}, 409)
        except (ValueError, KeyError, TypeError, AttributeError, OverflowError, sqlite3.Error, json.JSONDecodeError) as exc:
            conn.rollback(); self.send_json({"error": f"Patch was not saved: {exc}"}, 400)
        finally: conn.close()

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/admin/users/"):
            # PUT /api/admin/users/<ref>/profile
            parts = path.split("/")
            if len(parts) == 6 and parts[5] == "profile":
                conn = connect()
                try:
                    auth = self.require_admin(conn)
                    if not auth: return
                    actor_id, _ = auth
                    target_id = resolve_admin_target(conn, parts[4])
                    if target_id is None:
                        self.send_json({"error": "Пользователь не найден"}, 404); return
                    try:
                        payload = self.read_json()
                    except (json.JSONDecodeError, ValueError):
                        self.send_json({"error": "Некорректный JSON"}, 400); return
                    result = admin_update_profile(conn, target_id, payload)
                    admin_audit(conn, actor_id, "update-profile", target_id, json.dumps({k: v for k, v in payload.items() if k in ("name", "selfLevel", "goal")}, ensure_ascii=False))
                    self.send_json(result)
                except (ValueError, KeyError, sqlite3.Error) as exc:
                    try: conn.rollback()
                    except sqlite3.Error: pass
                    status = 404 if isinstance(exc, KeyError) else 400
                    self.send_json({"error": str(exc)}, status)
                finally: conn.close()
                return
            self.send_json({"error": "Not found"}, 404); return
        if path == "/api/state":
            # Полные снапшоты были источником DELETE+INSERT всех таблиц и
            # могли терять чужую историю. Клиент использует доменные endpoints:
            # events/*, progress/*, errors/*, settings и state-domains.
            self.send_json({"error": "Full state snapshots are retired; use domain endpoints"}, 410); return

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/admin"):
            # No DELETE admin endpoints exist; require the session anyway so
            # probing returns 401, not a misleading 404/405 difference.
            conn = connect()
            try:
                if not self.require_admin(conn): return
                self.send_json({"error": "Not found"}, 404)
            finally: conn.close()
            return
        if path.startswith("/api/auth/devices/"):
            # DELETE /api/auth/devices/<id> — отзыв одной сессии аккаунта.
            session_id = path.rsplit("/", 1)[-1]
            conn = connect()
            try:
                try:
                    self.handle_auth_device_revoke(conn, session_id)
                except (ValueError, KeyError, sqlite3.Error) as exc:
                    try: conn.rollback()
                    except sqlite3.Error: pass
                    self.send_json({"error": f"Request failed: {exc}"}, 400)
            finally: conn.close()
            return
        if path != "/api/state": self.send_json({"error": "Not found"}, 404); return
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
