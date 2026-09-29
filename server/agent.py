#!/usr/bin/env python3
"""ИИ-наставник: инструменты, цикл и квота.

Агент работает циклом tool-calling: модель получает список инструментов,
сама решает какие вызвать, получает результат и решает дальше, пока не
наберёт достаточно данных для ответа. Транспорт — ai.chat_with_tools
(OpenAI-совместимый tools), этот модуль — определения инструментов и сам цикл.

Инструментов немного, каждый со своей зоной:
  чтение (без подтверждения):
    fold_web(op=...) — весь срез прогресса по операциям: progress, profile,
      skills, errors, attempts, daily, history, forecast;
    lesson_get — текст урока по скиллу/уроку;
    task_get — условие задания;
    essay_history — сочинения с баллами;
    plan_draft — детерминированный черновик плана по прогнозу;
  действия (только с подтверждением ученика):
    update_profile — имя/уровень/цель;
    resolve_error — отметить ошибку «разобрался»;
    reset_progress — полный сброс прогресса предмета.

Почему нет остальных из исходного списка: push_task не существует в системе
(«домашки» как сущности нет — план отдаётся текстом через plan_draft, а не
записью в БД), goal_set слит в update_profile (цель — поле профиля, отдельный
инструмент плодил бы гонки двух писателей), essay_recheck не заводится
отдельным инструментом осознанно: перепроверка тратит суточную квоту
сочинений и является явным выбором ученика на ege-result.html (флаг
recheck:true всегда идёт через модель за жетон); агент объясняет и показывает
историю через essay_history, но не тратит чужую квоту из чата.

Квота хода: один ход (не шаг) — один жетон. Своя суточная цепочка
EGE_AGENT_QUOTA_MAX (по умолчанию 10) с окном 8 часов — та же механика, что у
ai_usage, но отдельный owner `agent:<user_id>` в той же таблице ai_usage
(таблица общая, бакеты не пересекаются по префиксу). Плюс общая сетка
ai.ai_take по пользователю и IP от скриптов — это всплеск за минуту
(60/мин на аккаунт), а не «много за день»: единственный счётчик, который
видит ученик, — квота ходов. Потолок хода — кодом: MAX_TOOL_STEPS шагов,
TURN_TIMEOUT_SEC секунд на весь ход. Жетон резервируется транзакцией до вызова
модели и возвращается при любом неуспехе.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

# ---------------------------------------------------------------------------
# Лимиты хода
# ---------------------------------------------------------------------------
AGENT_QUOTA_MAX_DEFAULT = 10
AGENT_QUOTA_WINDOW_DEFAULT_SEC = 8 * 3600
AGENT_TEXT_MIN = 1
AGENT_TEXT_MAX = 2000
MAX_TOOL_STEPS = 10
TURN_TIMEOUT_SEC = 90.0
# Потолок шагов не должен отдавать ученику отказ: сначала один вызов БЕЗ
# инструментов (короткий ответ по уже собранным данным), и только если время
# хода кончилось или модель снова полезла в инструменты — эта честная просьба.
LONG_TURN_TEXT = "Собрал часть данных, но ход получился слишком длинным. Уточни вопрос — отвечу короче."
# Столько секунд бюджета хода оставляем на один вызов модели: меньше — вызов
# заведомо не вернётся, и мы сожгли бы остаток хода впустую. Лучше честно
# закончить ход тем, что уже собрано (см. run_cycle).
TURN_CALL_FLOOR_SEC = 5.0


class AgentInputError(ValueError):
    """Детерминированная ошибка инструментов (не найден урок/задание,
    цель не из шкалы, неизвестная операция): повторять бессмысленно —
    сервер маппит её в 400, а не в 502."""


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(float(os.environ.get(name) or default)))
    except (TypeError, ValueError):
        return default


def agent_quota_max() -> int:
    return _env_int("EGE_AGENT_QUOTA_MAX", AGENT_QUOTA_MAX_DEFAULT)


def agent_quota_window_ms() -> int:
    return _env_int("EGE_AGENT_QUOTA_WINDOW_SEC", AGENT_QUOTA_WINDOW_DEFAULT_SEC) * 1000


# ---------------------------------------------------------------------------
# Системный промпт (русский, жёсткие правила + сценарии)
# ---------------------------------------------------------------------------
AGENT_SYSTEM = (
    "Ты — ИИ-наставник ege easy. Отвечаешь по-русски, по делу, без длинных текстов.\n"
    "ЖЁСТКИЕ ПРАВИЛА:\n"
    "1. Все числа (баллы, прогноз, ошибки, попытки) — только из инструментов. Ничего не выдумывай.\n"
    "2. Перед ответом про прогресс сначала вызови инструмент (fold_web). Нет данных — так и скажи.\n"
    "3. На вопрос «какой у меня балл/прогноз» вызови fold_web(op=\"forecast\").\n"
    "4. Обращайся к ученику по имени из profile, род глаголов не угадывай: если пол неочевиден — нейтральные формулировки.\n"
    "5. Отвечай коротко: вывод + 1-3 конкретных шага. Не пересказывай сырые JSON инструментов.\n"
    "5a. Форматируй ответ markdown: **жирный** для главного, `код` для названий, "
    "- списки для перечислений, короткие абзацы. Таблицы не нужны.\n"
    "6. Действия (смена профиля, разбор ошибки, сброс) — только через инструменты действий; они сами попросят подтверждение.\n"
    "СЦЕНАРИИ:\n"
    "- «где я ошибаюсь» → fold_web(op=\"errors\"), затем task_get для 1-2 заданий.\n"
    "- «какой прогноз / что поднять» → fold_web(op=\"forecast\"), назови top-gains.\n"
    "- «разбери задание» → fold_web(op=\"attempts\", taskId=...) + task_get.\n"
    "- «план на неделю» → plan_draft, затем коротко перескажи.\n"
    "- «поменяй цель/уровень» → update_profile (потребует подтверждения).\n"
    "Если инструментов недостаточно — ответь честно, что данных нет."
)


# ---------------------------------------------------------------------------
# Спецификации инструментов (OpenAI function calling)
# ---------------------------------------------------------------------------
def _tool(name: str, description: str, parameters: dict, *, action: bool = False) -> dict:
    # action — только серверный маркер (ACTION_TOOLS ниже); в wire его не кладём:
    # лишний x-action ронял строгий closerouter 400-м, а gptunnel молча терпел.
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": parameters}}


AGENT_TOOLS: list = [
    _tool("fold_web",
          "Срез прогресса ученика. op: progress|profile|skills|errors|attempts|daily|history|forecast.",
          {"type": "object",
           "properties": {
               "op": {"type": "string", "enum": ["progress", "profile", "skills", "errors",
                                                "attempts", "daily", "history", "forecast"]},
               "taskId": {"type": "string", "description": "для attempts: конкретное задание"},
               "limit": {"type": "integer", "minimum": 1, "maximum": 50},
               "days": {"type": "integer", "minimum": 1, "maximum": 90},
           },
           "required": ["op"], "additionalProperties": False}),
    _tool("lesson_get", "Текст урока по скиллу или уроку.",
          {"type": "object", "properties": {
              "skillId": {"type": "string"}, "lessonId": {"type": "string"}},
           "additionalProperties": False}),
    _tool("task_get", "Условие задания по id.",
          {"type": "object", "properties": {"taskId": {"type": "string"}},
           "required": ["taskId"], "additionalProperties": False}),
    _tool("essay_history", "Мои сочинения с баллами и пометками.",
          {"type": "object", "properties": {
              "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
           "additionalProperties": False}),
    _tool("plan_draft", "Черновик плана подготовки на основе прогноза.",
          {"type": "object", "properties": {
              "weeks": {"type": "integer", "minimum": 1, "maximum": 8}},
           "additionalProperties": False}),
    _tool("update_profile", "Изменить имя/уровень/цель. Требует подтверждения ученика.",
          {"type": "object", "properties": {
              "name": {"type": "string", "maxLength": 60},
              "selfLevel": {"type": "string"},
              "goal": {"type": "string"}},
           "additionalProperties": False}, action=True),
    _tool("resolve_error", "Отметить ошибку разобранной. Требует подтверждения.",
          {"type": "object", "properties": {
              "errorId": {"type": "string"}, "taskId": {"type": "string"}},
           "additionalProperties": False}, action=True),
    _tool("reset_progress", "Полный сброс прогресса предмета. Требует подтверждения.",
          {"type": "object", "properties": {}, "additionalProperties": False}, action=True),
]

ACTION_TOOLS = frozenset({"update_profile", "resolve_error", "reset_progress"})
READ_TOOLS = frozenset({"fold_web", "lesson_get", "task_get", "essay_history", "plan_draft"})


def is_action_tool(name: str) -> bool:
    return str(name or "") in ACTION_TOOLS


# ---------------------------------------------------------------------------
# Схема: треды, сообщения, поле подписки
# ---------------------------------------------------------------------------
_AGENT_SCHEMA_DONE: set[str] = set()


def _db_key(conn: sqlite3.Connection) -> str:
    try:
        return str(getattr(conn, "database", "") or id(conn))
    except Exception:
        return str(id(conn))


def ensure_agent_schema(conn: sqlite3.Connection) -> None:
    """Треды/сообщения агента + поле подписки (задел, подписки пока нет)."""
    key = _db_key(conn)
    if key in _AGENT_SCHEMA_DONE:
        try:
            conn.execute("SELECT id FROM agent_threads LIMIT 1")
            conn.execute("SELECT id FROM agent_messages LIMIT 1")
            return
        except sqlite3.Error:
            pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT 'profile_math',
          title TEXT NOT NULL DEFAULT 'Новый чат',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL)""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
          content TEXT NOT NULL DEFAULT '',
          tool_name TEXT,
          tool_args_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'done',
          result_json TEXT NOT NULL DEFAULT '{}',
          seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_threads_user ON agent_threads(user_id, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_seq ON agent_messages(thread_id, seq)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_messages_tool_status ON agent_messages(thread_id, status)")
    # Поле под будущую подписку: раздел бесплатен для всех зарегистрированных,
    # подписки в проекте пока нет. NULL/'' = бесплатный доступ.
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        if "subscription" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN subscription TEXT")
    except sqlite3.Error:
        pass
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(ai_usage)")}
        if not cols or "owner" not in cols:
            conn.execute("DROP TABLE IF EXISTS ai_usage")
            conn.execute("CREATE TABLE IF NOT EXISTS ai_usage (owner TEXT PRIMARY KEY, count INTEGER NOT NULL, timer_ms INTEGER)")
    except sqlite3.Error:
        pass
    if "ai_usage" not in {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        conn.execute("CREATE TABLE IF NOT EXISTS ai_usage (owner TEXT PRIMARY KEY, count INTEGER NOT NULL, timer_ms INTEGER)")
    conn.commit()
    _AGENT_SCHEMA_DONE.add(key)


def thread_title_for(text: str) -> str:
    """Детерминированный заголовок: первые 60 символов, без обращения к модели."""
    clean = " ".join(str(text or "").split())
    return clean[:60] if clean else "Новый чат"


# ---------------------------------------------------------------------------
# Квота хода: цепочка 8 часов на owner `agent:<user_id>`
# ---------------------------------------------------------------------------
def _agent_owner(user_id: int) -> str:
    return f"agent:{int(user_id)}"


def _quota_catch_up(conn: sqlite3.Connection, owner: str, now_ms: int, limit: int, window_ms: int) -> None:
    conn.execute("""
        UPDATE ai_usage SET
          count = MIN(?, count + (? - timer_ms) / ?),
          timer_ms = CASE WHEN count + (? - timer_ms) / ? >= ?
                           THEN NULL
                           ELSE timer_ms + ((? - timer_ms) / ?) * ? END
        WHERE owner = ? AND timer_ms IS NOT NULL AND ? >= timer_ms + ?""",
        (limit, now_ms, window_ms, now_ms, window_ms, limit,
         now_ms, window_ms, window_ms, owner, now_ms, window_ms))


# Персональный потолок ходов, который ставит админ из карточки пользователя.
# Живёт в agent_user_limits (переживает рестарт), ровно как ai_user_limits у
# проверок сочинений. Отдельная таблица нужна потому, что ручной
# UPDATE ai_usage.count выше общего потолка доживает только до первого тика
# цепочки: _quota_catch_up делает MIN(limit, ...) и срезает грант обратно к
# EGE_AGENT_QUOTA_MAX. Без строки действует общий потолок.
AGENT_USER_LIMIT_MIN = 0
AGENT_USER_LIMIT_MAX = 1000

_AGENT_USER_LIMIT_SCHEMA_DONE: set[str] = set()


def ensure_agent_user_limit_schema(conn: sqlite3.Connection) -> None:
    key = _db_key(conn)
    if key in _AGENT_USER_LIMIT_SCHEMA_DONE:
        return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_user_limits (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          max_limit INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          updated_by INTEGER
        )""")
    conn.commit()
    _AGENT_USER_LIMIT_SCHEMA_DONE.add(key)


def agent_custom_limit(conn: sqlite3.Connection, user_id: int) -> int | None:
    """Персональный потолок ходов пользователя или None (действует общий)."""
    try:
        ensure_agent_user_limit_schema(conn)
        row = conn.execute("SELECT max_limit FROM agent_user_limits WHERE user_id=?",
                           (user_id,)).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    try:
        value = int(row["max_limit"])
    except (TypeError, ValueError):
        return None
    if AGENT_USER_LIMIT_MIN <= value <= AGENT_USER_LIMIT_MAX:
        return value
    return None


def agent_effective_limit(conn: sqlite3.Connection, user_id: int) -> int:
    """Потолок ходов, который реально действует на пользователя."""
    custom = agent_custom_limit(conn, user_id)
    return custom if custom is not None else agent_quota_max()


def agent_quota_status(conn: sqlite3.Connection, user_id: int, now_ms: int | None = None) -> dict:
    ensure_agent_schema(conn)
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    limit = agent_effective_limit(conn, user_id)
    window_ms = agent_quota_window_ms()
    owner = _agent_owner(user_id)
    conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms) VALUES (?,?,NULL)",
                 (owner, limit))
    _quota_catch_up(conn, owner, now_ms, limit, window_ms)
    row = conn.execute("SELECT count, timer_ms FROM ai_usage WHERE owner=?", (owner,)).fetchone()
    conn.commit()
    count = int(row["count"]) if row else limit
    timer = int(row["timer_ms"]) if row and row["timer_ms"] is not None else None
    if count >= limit:
        return {"ok": True, "limit": limit, "remaining": count,
                "resetInSec": None, "windowSec": window_ms // 1000}
    start = timer if timer is not None else now_ms
    reset_ms = start + window_ms
    return {"ok": True, "limit": limit, "remaining": max(0, count),
            "resetInSec": max(1, (reset_ms - now_ms + 999) // 1000),
            "windowSec": window_ms // 1000}


def agent_quota_reserve(conn: sqlite3.Connection, user_id: int) -> bool:
    """Списать один ход. True — списано, False — квота пуста."""
    ensure_agent_schema(conn)
    now_ms = int(time.time() * 1000)
    limit = agent_effective_limit(conn, user_id)
    window_ms = agent_quota_window_ms()
    owner = _agent_owner(user_id)
    conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms) VALUES (?,?,NULL)",
                 (owner, limit))
    _quota_catch_up(conn, owner, now_ms, limit, window_ms)
    cur = conn.execute("""
        UPDATE ai_usage SET count = count - 1,
          timer_ms = CASE WHEN timer_ms IS NULL THEN ? ELSE timer_ms END
        WHERE owner = ? AND count > 0""", (now_ms, owner))
    if cur.rowcount == 0:
        conn.rollback()
        return False
    conn.commit()
    return True


def agent_quota_refund(conn: sqlite3.Connection, user_id: int) -> None:
    ensure_agent_schema(conn)
    limit = agent_effective_limit(conn, user_id)
    owner = _agent_owner(user_id)
    try:
        conn.execute("""
            UPDATE ai_usage SET count = MIN(?, count + 1),
              timer_ms = CASE WHEN count + 1 >= ? THEN NULL ELSE timer_ms END
            WHERE owner = ?""", (limit, limit, owner))
        conn.commit()
    except sqlite3.Error:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass


# ---------------------------------------------------------------------------
# Ручное управление квотой агента из админки (тела бакетов — его дело,
# server.py вызывает эти функции и кладёт результат в карточку пользователя)
# ---------------------------------------------------------------------------
def admin_agent_quota_status(conn: sqlite3.Connection, user_id: int) -> dict:
    """Состояние квоты агента для карточки админа: остаток, потолки, таймер."""
    if not conn.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone():
        raise KeyError("user not found")
    st = agent_quota_status(conn, user_id)
    return {
        "limit": int(st["limit"]),
        "remaining": int(st["remaining"]),
        "resetInSec": st["resetInSec"],
        "windowSec": int(st["windowSec"]),
        "globalLimit": agent_quota_max(),
        "customLimit": agent_custom_limit(conn, user_id),
    }


def admin_agent_quota_set(conn: sqlite3.Connection, user_id: int, payload: dict) -> dict:
    """Ручное управление квотой ходов агента из админки.

    payload: {"limit": int|null, "remaining": int|null, "refill": bool}.
    Семантика ровно как у essay-овского admin_ai_limit_set: limit null — снять
    персональный потолок; remaining выше потолка — потолок поднимается сам
    (иначе грант срезала бы ближайшая зарядка MIN(limit, ...)); refill — долить
    до полного. Частичный остаток (< потолка) запускает таймер цепочки сейчас,
    иначе строка с timer NULL никогда бы не заряжалась.
    """
    if not conn.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone():
        raise KeyError("user not found")
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    has_limit = "limit" in payload
    has_remaining = "remaining" in payload
    refill = payload.get("refill") is True
    raw_limit = payload.get("limit")
    raw_remaining = payload.get("remaining")
    if not has_limit and not has_remaining and not refill:
        raise ValueError("нужны limit, remaining или refill")
    ensure_agent_user_limit_schema(conn)
    now_ms = int(time.time() * 1000)
    window_ms = agent_quota_window_ms()
    conn.execute("BEGIN")
    try:
        if has_limit:
            if raw_limit is None:
                conn.execute("DELETE FROM agent_user_limits WHERE user_id=?", (user_id,))
            else:
                try:
                    new_limit = int(raw_limit)
                except (TypeError, ValueError):
                    raise ValueError("limit должен быть целым числом или null")
                if not AGENT_USER_LIMIT_MIN <= new_limit <= AGENT_USER_LIMIT_MAX:
                    raise ValueError(f"limit должен быть {AGENT_USER_LIMIT_MIN}..{AGENT_USER_LIMIT_MAX}")
                conn.execute(
                    "INSERT INTO agent_user_limits(user_id, max_limit, updated_at_ms, updated_by)"
                    " VALUES (?,?,?,NULL)"
                    " ON CONFLICT(user_id) DO UPDATE SET max_limit=excluded.max_limit,"
                    " updated_at_ms=excluded.updated_at_ms",
                    (user_id, new_limit, now_ms))
        eff = agent_effective_limit(conn, user_id)
        owner = _agent_owner(user_id)
        conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms)"
                     " VALUES (?,?,NULL)", (owner, eff))
        _quota_catch_up(conn, owner, now_ms, eff, window_ms)
        if refill:
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL WHERE owner=?",
                         (eff, owner))
        elif has_remaining:
            try:
                want = int(raw_remaining)
            except (TypeError, ValueError):
                raise ValueError("remaining должен быть целым числом")
            if not 0 <= want <= AGENT_USER_LIMIT_MAX:
                raise ValueError(f"remaining должен быть 0..{AGENT_USER_LIMIT_MAX}")
            if want > eff:
                # Грант выше потолка: поднимаем потолок, иначе MIN(limit)
                # в зарядке срежет его обратно к общему.
                eff = want
                conn.execute(
                    "INSERT INTO agent_user_limits(user_id, max_limit, updated_at_ms, updated_by)"
                    " VALUES (?,?,?,NULL)"
                    " ON CONFLICT(user_id) DO UPDATE SET max_limit=excluded.max_limit,"
                    " updated_at_ms=excluded.updated_at_ms",
                    (user_id, eff, now_ms))
            timer = None if want >= eff else now_ms
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                         (min(want, eff), timer, owner))
        else:
            # Менялся только потолок: остаток клампим, таймер чиним.
            row = conn.execute("SELECT count, timer_ms FROM ai_usage WHERE owner=?",
                               (owner,)).fetchone()
            count = int(row["count"]) if row else eff
            count = min(count, eff)
            if count >= eff:
                timer = None
            else:
                timer = row["timer_ms"] if row and row["timer_ms"] is not None else now_ms
                timer = int(timer)
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                         (count, timer, owner))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        raise
    return admin_agent_quota_status(conn, user_id)


# ---------------------------------------------------------------------------
# Чтение прогресса (прямой SQL, без импорта server.py — нет цикла импорта)
# ---------------------------------------------------------------------------
def _table_cols(conn: sqlite3.Connection, table: str) -> set:
    try:
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _forecast_weights(conn: sqlite3.Connection, subject: str) -> tuple[dict, int, list]:
    """Веса/шкала прогноза: сначала app_config (install_catalog), иначе subjects/*.json."""
    try:
        row = conn.execute("SELECT value_json FROM app_config WHERE key=?",
                           (f"forecast:{subject}",)).fetchone()
        if row:
            data = json.loads(row["value_json"])
            if isinstance(data, dict) and isinstance(data.get("weights"), dict):
                total = _safe_int(data.get("total"), 0)
                scale = data.get("scale")
                if total > 0 and isinstance(scale, list) and len(scale) == total + 1:
                    return dict(data["weights"]), total, list(scale)
    except (sqlite3.Error, ValueError, TypeError):
        pass
    # Файлы контракта предмета (без импорта registry — читаем JSON напрямую).
    try:
        from pathlib import Path as _Path
        subjects_dir = _Path(__file__).resolve().parent / "subjects"
        for path in sorted(subjects_dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if raw.get("id") != subject:
                continue
            fc = raw.get("forecast")
            if isinstance(fc, dict) and isinstance(fc.get("weights"), dict):
                total = _safe_int(fc.get("total"), 0)
                scale = fc.get("scale")
                if total > 0 and isinstance(scale, list) and len(scale) == total + 1:
                    return dict(fc["weights"]), total, list(scale)
    except Exception:
        pass
    return {}, 0, []


def _skill_mastery(conn: sqlite3.Connection, user_id: int, subject: str, skill_id: str) -> int:
    try:
        row = conn.execute("SELECT solved, correct FROM user_progress WHERE user_id=? AND subject=? AND skill_id=?",
                           (user_id, subject, skill_id)).fetchone()
    except sqlite3.Error:
        row = None
    if row and _safe_int(row["solved"]) > 0:
        acc = _safe_int(row["correct"]) / max(1, _safe_int(row["solved"]))
        vol = min(1.0, _safe_int(row["solved"]) / 10.0)
        return round(min(100, vol * acc * 100))
    return 0


def _compute_forecast(conn: sqlite3.Connection, user_id: int, subject: str) -> dict:
    weights, total, scale = _forecast_weights(conn, subject)
    if not weights or total <= 0 or not scale:
        return {"available": False, "mid": 0, "low": 0, "high": 0, "topGains": []}
    scored = []
    w_sum = 0.0
    w_mastery = 0.0
    for skill_id, w in weights.items():
        try:
            weight = float(w)
        except (TypeError, ValueError):
            continue
        if weight <= 0:
            continue
        m = _skill_mastery(conn, user_id, subject, str(skill_id))
        try:
            name_row = conn.execute("SELECT name FROM skills WHERE id=?", (str(skill_id),)).fetchone()
            name = str(name_row["name"]) if name_row and name_row["name"] else str(skill_id)
        except sqlite3.Error:
            name = str(skill_id)
        scored.append({"skillId": str(skill_id), "name": name, "weight": weight, "mastery": m})
        w_sum += weight
        w_mastery += weight * (m / 100.0)
    if w_sum <= 0:
        return {"available": False, "mid": 0, "low": 0, "high": 0, "topGains": []}
    primary = w_mastery / w_sum * total
    mid_idx = max(0, min(total, round(primary)))
    try:
        mid = int(scale[mid_idx])
    except (IndexError, TypeError, ValueError):
        mid = 0
    gains = sorted(scored, key=lambda s: (s["weight"] * (100 - s["mastery"]), s["weight"]),
                   reverse=True)[:3]
    return {"available": True, "mid": mid, "low": max(0, mid - 5), "high": mid + 5,
            "primary": round(primary, 2), "total": total,
            "topGains": [{"skillId": g["skillId"], "name": g["name"],
                          "mastery": g["mastery"]} for g in gains]}


def fold_web(conn: sqlite3.Connection, user_id: int, subject: str, args: dict) -> dict:
    """Главная читалка: вся база прогресса по операциям. Короткие результаты."""
    op = str((args or {}).get("op") or "").strip()
    limit = args.get("limit")
    try:
        limit = max(1, min(50, int(limit))) if limit is not None else 10
    except (TypeError, ValueError):
        limit = 10
    if op == "profile":
        prof = conn.execute("SELECT onboarded, self_level, goal_id FROM user_subjects WHERE user_id=? AND subject=?",
                            (user_id, subject)).fetchone()
        user = conn.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()
        return {"op": op, "name": (user["name"] if user else None),
                "onboarded": bool(prof["onboarded"]) if prof else False,
                "selfLevel": prof["self_level"] if prof else None,
                "goal": prof["goal_id"] if prof else None, "subject": subject}
    if op == "progress":
        stats = conn.execute("SELECT xp, streak, total_solved, total_correct, errors_resolved FROM user_stats WHERE user_id=? AND subject=?",
                             (user_id, subject)).fetchone()
        if not stats:
            return {"op": op, "xp": 0, "streak": 0, "solved": 0, "correct": 0, "errorsResolved": 0}
        return {"op": op, "xp": _safe_int(stats["xp"]), "streak": _safe_int(stats["streak"]),
                "solved": _safe_int(stats["total_solved"]), "correct": _safe_int(stats["total_correct"]),
                "errorsResolved": _safe_int(stats["errors_resolved"])}
    if op == "skills":
        rows = conn.execute("SELECT s.id, s.name, COALESCE(p.solved,0) AS solved, COALESCE(p.correct,0) AS correct, COALESCE(p.progress,0) AS progress"
                            " FROM skills s LEFT JOIN user_progress p ON p.skill_id=s.id AND p.user_id=? AND p.subject=?"
                            " WHERE s.subject=? ORDER BY s.display_order LIMIT 100",
                            (user_id, subject, subject)).fetchall()
        return {"op": op, "skills": [{"id": r["id"], "name": r["name"], "solved": _safe_int(r["solved"]),
                                      "correct": _safe_int(r["correct"]), "progress": _safe_int(r["progress"])}
                                     for r in rows]}
    if op == "errors":
        total = conn.execute("SELECT COUNT(*) AS c FROM user_errors WHERE user_id=? AND subject=?",
                             (user_id, subject)).fetchone()
        open_n = conn.execute("SELECT COUNT(*) AS c FROM user_errors WHERE user_id=? AND subject=? AND resolved=0",
                              (user_id, subject)).fetchone()
        by_skill = conn.execute("SELECT skill_id, COUNT(*) AS c FROM user_errors WHERE user_id=? AND subject=? AND resolved=0"
                                " GROUP BY skill_id ORDER BY c DESC LIMIT 10",
                                (user_id, subject)).fetchall()
        last = conn.execute("SELECT id, task_id, skill_id, resolved FROM user_errors WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT ?",
                            (user_id, subject, limit)).fetchall()
        return {"op": op, "total": _safe_int(total["c"]) if total else 0,
                "open": _safe_int(open_n["c"]) if open_n else 0,
                "bySkill": [{"skill": r["skill_id"], "count": _safe_int(r["c"])} for r in by_skill],
                "last": [{"id": r["id"], "taskId": r["task_id"], "skill": r["skill_id"],
                          "resolved": bool(r["resolved"])} for r in last]}
    if op == "attempts":
        task_id = str((args or {}).get("taskId") or "").strip()
        if task_id:
            rows = conn.execute("SELECT task_id, skill_id, correct, hint_level, created_at FROM task_attempts"
                                " WHERE user_id=? AND subject=? AND task_id=? ORDER BY id DESC LIMIT ?",
                                (user_id, subject, task_id, limit)).fetchall()
        else:
            rows = conn.execute("SELECT task_id, skill_id, correct, hint_level, created_at FROM task_attempts"
                                " WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT ?",
                                (user_id, subject, limit)).fetchall()
        return {"op": op, "taskId": task_id or None,
                "attempts": [{"taskId": r["task_id"], "skill": r["skill_id"],
                              "correct": bool(r["correct"]), "hint": _safe_int(r["hint_level"])} for r in rows]}
    if op == "daily":
        rows = conn.execute("SELECT progress_date, solved, done FROM daily_progress WHERE user_id=? AND subject=? ORDER BY progress_date DESC LIMIT 14",
                            (user_id, subject)).fetchall()
        return {"op": op, "days": [{"date": r["progress_date"], "solved": _safe_int(r["solved"]),
                                    "done": bool(r["done"])} for r in rows]}
    if op == "history":
        days = args.get("days")
        try:
            days = max(1, min(90, int(days))) if days is not None else 14
        except (TypeError, ValueError):
            days = 14
        rows = conn.execute("SELECT activity_date, solved, correct, xp FROM activity_history WHERE user_id=? AND subject=? ORDER BY activity_date DESC LIMIT ?",
                            (user_id, subject, days)).fetchall()
        if not rows:
            rows = conn.execute("SELECT activity_date, solved, correct, xp FROM activity_events WHERE user_id=? AND subject=? ORDER BY activity_date DESC LIMIT ?",
                                (user_id, subject, days)).fetchall()
        return {"op": op, "days": [{"date": r["activity_date"], "solved": _safe_int(r["solved"]),
                                    "correct": _safe_int(r["correct"]), "xp": _safe_int(r["xp"])} for r in rows]}
    if op == "forecast":
        data = _compute_forecast(conn, user_id, subject)
        data["op"] = op
        return data
    raise ValueError(f"unknown op: {op}")


def lesson_get(conn: sqlite3.Connection, user_id: int, subject: str, args: dict) -> dict:
    skill_id = str((args or {}).get("skillId") or "").strip()
    lesson_id = str((args or {}).get("lessonId") or "").strip()
    if lesson_id:
        row = conn.execute("SELECT l.id, l.title, l.skill_id, l.metadata_json FROM lessons l JOIN skills s ON s.id=l.skill_id"
                           " WHERE l.id=? AND s.subject=?", (lesson_id, subject)).fetchone()
        if not row:
            raise ValueError("урок не найден")
        meta = {}
        try:
            meta = json.loads(row["metadata_json"] or "{}")
        except (ValueError, TypeError):
            meta = {}
        steps = meta.get("steps") if isinstance(meta, dict) else None
        text = ""
        if isinstance(steps, list) and steps:
            parts = []
            for st in steps[:6]:
                if isinstance(st, dict):
                    parts.append(str(st.get("text") or st.get("title") or "")[:500])
            text = "\n\n".join(p for p in parts if p)[:2000]
        return {"lessonId": row["id"], "title": row["title"], "skill": row["skill_id"],
                "text": text or str(meta)[:2000]}
    if skill_id:
        rows = conn.execute("SELECT l.id, l.title FROM lessons l JOIN skills s ON s.id=l.skill_id"
                            " WHERE s.id=? AND s.subject=? ORDER BY l.id LIMIT 5",
                            (skill_id, subject)).fetchall()
        if not rows:
            raise ValueError("уроки по скиллу не найдены")
        first = rows[0]
        return lesson_get(conn, user_id, subject, {"lessonId": first["id"]})
    raise ValueError("нужен skillId или lessonId")


def task_get(conn: sqlite3.Connection, user_id: int, subject: str, args: dict) -> dict:
    task_id = str((args or {}).get("taskId") or "").strip()
    if not task_id:
        raise ValueError("нужен taskId")
    row = conn.execute("SELECT t.id, t.skill_id, t.topic, t.exam_number, t.statement, t.answer FROM tasks t"
                       " JOIN skills s ON s.id=t.skill_id WHERE t.id=? AND s.subject=?",
                       (task_id, subject)).fetchone()
    if not row:
        raise ValueError("задание не найдено")
    return {"taskId": row["id"], "skill": row["skill_id"], "topic": row["topic"],
            "exam": row["exam_number"], "statement": str(row["statement"])[:1500],
            "answer": str(row["answer"])[:200]}


def essay_history(conn: sqlite3.Connection, user_id: int, subject: str, args: dict) -> dict:
    limit = args.get("limit") if isinstance(args, dict) else None
    try:
        limit = max(1, min(20, int(limit))) if limit is not None else 5
    except (TypeError, ValueError):
        limit = 5
    if "essay_submissions" not in {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        return {"essays": []}
    rows = conn.execute("SELECT id, task_id, word_count, evaluation_status, evaluation_result, created_at"
                        " FROM essay_submissions WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT ?",
                        (user_id, subject, limit)).fetchall()
    out = []
    for r in rows:
        score = None
        try:
            if r["evaluation_result"]:
                blob = json.loads(r["evaluation_result"])
                score = blob.get("total_score")
        except (ValueError, TypeError, AttributeError):
            score = None
        out.append({"submissionId": int(r["id"]), "taskId": r["task_id"],
                    "words": _safe_int(r["word_count"]), "status": r["evaluation_status"],
                    "score": score})
    return {"essays": out}


def plan_draft(conn: sqlite3.Connection, user_id: int, subject: str, args: dict) -> dict:
    weeks = (args or {}).get("weeks", 1)
    try:
        weeks = max(1, min(8, int(weeks)))
    except (TypeError, ValueError):
        weeks = 1
    fc = _compute_forecast(conn, user_id, subject)
    gains = fc.get("topGains") or []
    if not gains:
        rows = conn.execute("SELECT skill_id, COUNT(*) AS c FROM user_errors WHERE user_id=? AND subject=? AND resolved=0"
                            " GROUP BY skill_id ORDER BY c DESC LIMIT 3", (user_id, subject)).fetchall()
        gains = [{"skillId": r["skill_id"], "name": r["skill_id"], "mastery": 0} for r in rows]
    plan = [{"week": w + 1, "focus": [g["skillId"] for g in gains[:2]],
             "tasks": f"Неделя {w + 1}: " + (", ".join(g.get('name') or g['skillId'] for g in gains[:2]) or "повторение")}
            for w in range(weeks)]
    return {"weeks": weeks, "forecast": fc.get("mid"), "plan": plan}


# ---------------------------------------------------------------------------
# Действия: сначала proposal (без записи), потом apply после подтверждения
# ---------------------------------------------------------------------------
SELF_LEVELS = {"zero", "base", "confident"}


def propose_action(conn: sqlite3.Connection, user_id: int, subject: str, name: str, args: dict) -> dict:
    """Проверить аргументы действия и вернуть человекочитаемое предложение."""
    args = dict(args or {})
    if name == "update_profile":
        patch = {}
        if "name" in args and args["name"] is not None:
            clean = " ".join(str(args["name"]).split())[:60]
            if not clean:
                raise ValueError("пустое имя")
            patch["name"] = clean
        if "selfLevel" in args and args["selfLevel"] is not None:
            if str(args["selfLevel"]) not in SELF_LEVELS:
                raise ValueError("неизвестный уровень")
            patch["selfLevel"] = str(args["selfLevel"])
        if "goal" in args and args["goal"] is not None:
            goal = str(args["goal"]).strip()[:64]
            if not goal:
                raise ValueError("пустая цель")
            # Цель проверяем по шкале предмета, если она есть в app_config.
            try:
                cfg = conn.execute("SELECT value_json FROM app_config WHERE key=?",
                                   (f"goals:{subject}",)).fetchone()
                goals = json.loads(cfg["value_json"]) if cfg else None
                if isinstance(goals, list) and goals:
                    ids = {g.get("id") for g in goals if isinstance(g, dict)}
                    if goal not in ids:
                        raise ValueError("цель не из шкалы предмета")
            except (sqlite3.Error, ValueError, TypeError) as exc:
                if isinstance(exc, ValueError) and "шкалы" in str(exc):
                    raise
            patch["goal"] = goal
        if not patch:
            raise ValueError("нечего менять")
        bits = ", ".join(f"{k}={v}" for k, v in patch.items())
        return {"action": name, "patch": patch, "label": f"Меняю профиль: {bits}"}
    if name == "resolve_error":
        error_id = str(args.get("errorId") or "").strip()
        task_id = str(args.get("taskId") or "").strip()
        row = None
        if error_id:
            try:
                numeric = int(error_id) if error_id.isdigit() else None
            except (TypeError, ValueError):
                numeric = None
            if numeric is not None:
                row = conn.execute("SELECT id, task_id FROM user_errors WHERE id=? AND user_id=? AND subject=?",
                                   (numeric, user_id, subject)).fetchone()
            if row is None:
                row = conn.execute("SELECT id, task_id FROM user_errors WHERE client_id=? AND user_id=? AND subject=?",
                                   (error_id[:128], user_id, subject)).fetchone()
        elif task_id:
            row = conn.execute("SELECT id, task_id FROM user_errors WHERE task_id=? AND user_id=? AND subject=? AND resolved=0 ORDER BY id LIMIT 1",
                               (task_id, subject, user_id)).fetchone()
        if row is None:
            raise ValueError("ошибка не найдена")
        return {"action": name, "errorId": int(row["id"]),
                "label": f"Отмечаю ошибку по заданию {row['task_id']} разобранной"}
    if name == "reset_progress":
        return {"action": name, "label": "Сбрасываю весь прогресс предмета"}
    raise ValueError(f"неизвестное действие: {name}")


def apply_action(conn: sqlite3.Connection, user_id: int, subject: str, name: str, proposal: dict) -> dict:
    if name == "update_profile":
        patch = proposal.get("patch") or {}
        if "name" in patch:
            conn.execute("UPDATE users SET name=? WHERE id=?", (patch["name"], user_id))
        cur = conn.execute("SELECT onboarded, self_level, goal_id FROM user_subjects WHERE user_id=? AND subject=?",
                           (user_id, subject)).fetchone()
        if cur is None:
            conn.execute("INSERT OR IGNORE INTO user_subjects(user_id, subject, onboarded) VALUES (?,?,0)",
                         (user_id, subject))
            cur = {"onboarded": 0, "self_level": None, "goal_id": None}
        self_level = patch.get("selfLevel", cur["self_level"] if isinstance(cur, dict) else cur["self_level"])
        goal = patch.get("goal", cur["goal_id"] if isinstance(cur, dict) else cur["goal_id"])
        conn.execute("UPDATE user_subjects SET self_level=?, goal_id=? WHERE user_id=? AND subject=?",
                     (self_level, goal, user_id, subject))
        try:
            conn.execute("UPDATE users SET onboarded=CASE WHEN EXISTS(SELECT 1 FROM user_subjects us WHERE us.user_id=users.id AND us.onboarded=1) THEN 1 ELSE 0 END WHERE id=?",
                         (user_id,))
        except sqlite3.Error:
            pass
        conn.commit()
        try:
            conn.execute("UPDATE user_subjects SET state_version=state_version+1 WHERE user_id=? AND subject=?",
                         (user_id, subject))
            conn.commit()
        except sqlite3.Error:
            pass
        return {"updated": patch}
    if name == "resolve_error":
        error_id = int(proposal.get("errorId") or 0)
        if error_id <= 0:
            raise ValueError("битое предложение")
        cur = conn.execute("UPDATE user_errors SET resolved=1 WHERE id=? AND user_id=? AND subject=?",
                           (error_id, user_id, subject))
        if cur.rowcount == 0:
            raise ValueError("ошибка не найдена")
        conn.commit()
        return {"errorId": error_id, "resolved": True}
    if name == "reset_progress":
        for table in ("user_progress", "task_attempts", "user_errors", "lesson_attempts",
                      "lesson_step_errors", "lesson_error_history", "lesson_sessions",
                      "completed_lessons", "user_missions", "user_bosses", "user_achievements",
                      "timeline", "diagnostics", "daily_progress", "activity_history",
                      "activity_events", "forecast_history", "essay_submissions",
                      "essay_checks", "essay_check_history"):
            try:
                if table in {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
                    cols = _table_cols(conn, table)
                    if "subject" in cols:
                        conn.execute(f"DELETE FROM {table} WHERE user_id=? AND subject=?", (user_id, subject))
                    elif "user_id" in cols:
                        conn.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
            except sqlite3.Error:
                pass
        try:
            conn.execute("UPDATE user_subjects SET state_version=state_version+1 WHERE user_id=? AND subject=?",
                         (user_id, subject))
        except sqlite3.Error:
            pass
        conn.commit()
        return {"reset": True, "subject": subject}
    raise ValueError(f"неизвестное действие: {name}")


def execute_read_tool(conn: sqlite3.Connection, user_id: int, subject: str, name: str, args: dict) -> dict:
    if name == "fold_web":
        return fold_web(conn, user_id, subject, args)
    if name == "lesson_get":
        return lesson_get(conn, user_id, subject, args)
    if name == "task_get":
        return task_get(conn, user_id, subject, args)
    if name == "essay_history":
        return essay_history(conn, user_id, subject, args)
    if name == "plan_draft":
        return plan_draft(conn, user_id, subject, args)
    raise ValueError(f"неизвестный инструмент: {name}")


def describe_step(name: str, args: dict, result: dict | None = None) -> str:
    """Человеческая строка шага для ленты («Смотрю твои ошибки…»)."""
    args = args or {}
    if name == "fold_web":
        op = str(args.get("op") or "")
        if op == "forecast":
            mid = (result or {}).get("mid")
            return f"Смотрю прогноз — сейчас {mid}" if mid is not None else "Смотрю прогноз"
        if op == "errors":
            n = (result or {}).get("open")
            return f"Смотрю твои ошибки — {n} штук" if n is not None else "Смотрю твои ошибки"
        if op == "skills":
            n = len((result or {}).get("skills") or [])
            return f"Смотрю навыки — {n} тем"
        if op == "attempts":
            tid = args.get("taskId")
            return f"Смотрю попытки по заданию {tid}" if tid else "Смотрю последние попытки"
        if op == "profile":
            return "Смотрю твой профиль"
        if op == "progress":
            return "Смотрю общий прогресс"
        if op == "daily":
            return "Смотрю дни занятий"
        if op == "history":
            return "Смотрю историю за период"
        return "Смотрю прогресс"
    if name == "lesson_get":
        lid = args.get("lessonId") or args.get("skillId") or ""
        return f"Открываю урок {lid}" if lid else "Открываю урок"
    if name == "task_get":
        return f"Открываю задание {args.get('taskId') or ''}".strip()
    if name == "essay_history":
        return "Смотрю твои сочинения"
    if name == "plan_draft":
        return "Составляю черновик плана"
    if name == "update_profile":
        return "Меняю профиль (жду подтверждения)"
    if name == "resolve_error":
        return "Отмечаю ошибку разобранной (жду подтверждения)"
    if name == "reset_progress":
        return "Готовлю сброс прогресса (жду подтверждения)"
    return f"Вызываю {name}"


# ---------------------------------------------------------------------------
# Цикл хода: модель ↔ инструменты, пока не ответит текстом
# ---------------------------------------------------------------------------
def validate_turn_text(text) -> str:
    if not isinstance(text, str):
        raise ValueError("пустой вопрос")
    clean = text.strip()
    if len(clean) < AGENT_TEXT_MIN:
        raise ValueError("пустой вопрос")
    if len(clean) > AGENT_TEXT_MAX:
        raise ValueError(f"вопрос слишком длинный (максимум {AGENT_TEXT_MAX} символов)")
    return clean


def build_messages(system: str, history: list, user_text: str) -> list:
    """История треда → OpenAI messages. history: [{role,content,tool...}] (уже проверенные)."""
    messages = [{"role": "system", "content": system}]
    for item in history:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role == "user":
            messages.append({"role": "user", "content": str(item.get("content") or "")[:AGENT_TEXT_MAX]})
        elif role == "assistant":
            content = str(item.get("content") or "")
            calls = item.get("tool_calls") or []
            msg: dict = {"role": "assistant"}
            msg["content"] = content if content else None
            if calls:
                msg["tool_calls"] = [{"id": c.get("id") or "", "type": "function",
                                      "function": {"name": c.get("name") or "",
                                                   "arguments": json.dumps(c.get("arguments") or {},
                                                                           ensure_ascii=False)}}
                                     for c in calls]
            messages.append(msg)
        elif role == "tool":
            messages.append({"role": "tool", "tool_call_id": str(item.get("tool_call_id") or ""),
                             "content": str(item.get("content") or "")[:4000]})
    messages.append({"role": "user", "content": user_text})
    return messages


def run_cycle(conn: sqlite3.Connection, user_id: int, subject: str, messages: list,
              chat_fn, *, deadline: float | None = None) -> tuple[list, str | None, dict | None]:
    """Один проход модель↔инструменты. Возвращает (steps, final, pending).

    steps — [{name, args, label, kind}] для ленты; final — текст ответа либо
    None, если ход встал на подтверждение; pending — {tool, args, proposal}
    для confirm при действии, иначе None. Бросает AI* при сбое модели.

    chat_fn(messages, tools, budget) — budget это остаток времени хода в
    секундах: им вызов ограничивает себя, иначе 90-секундный потолок держался
    бы только «между шагами», а один зависший вызов провайдера растягивал ход
    ещё на EGE_AI_TIMEOUT_SEC (45 с) сверх него.
    """
    deadline = deadline if deadline is not None else (time.monotonic() + TURN_TIMEOUT_SEC)
    steps: list = []
    for _ in range(MAX_TOOL_STEPS + 1):
        budget = deadline - time.monotonic()
        if budget <= TURN_CALL_FLOOR_SEC:
            # Бюджета не осталось. Если что-то уже собрано — отдаём это (шаги
            # видны в ленте, текст честный), потому что отказ с потерей всего
            # хода хуже ответа «не успел». Нечего показать — 502 с бесплатным
            # повтором (жетон вернётся в finally).
            if steps:
                return steps, _summarize(chat_fn, messages, deadline), None
            raise TimeoutError("ход превысил 90 секунд")
        parsed = chat_fn(messages, AGENT_TOOLS, budget)
        text = parsed.get("text")
        calls = parsed.get("tool_calls") or []
        # Модель часто пишет реплику («Сейчас соберу…») и зовёт инструменты в
        # одном сообщении. Это не пол-ответа: вызовы главнее, реплику
        # переигрываем в том же assistant-сообщении (см. parse_tool_message).
        preamble = parsed.get("preamble")
        if text is not None and not calls:
            return steps, text, None
        if not calls:
            # Парсер ai.py такое уже отбраковал; страховка от чужого chat_fn.
            from importlib.util import spec_from_file_location as _s, module_from_spec as _m  # lazy
            raise ValueError("пустой ответ модели")
        if len(steps) + len(calls) > MAX_TOOL_STEPS:
            # Потолок кодом: длинный цикл обрываем ответом по собранным данным,
            # а не ошибкой — ученик звал «вызови всё», и отказ тут обиднее ответа.
            return steps, _summarize(chat_fn, messages, deadline), None
        for call in calls:
            name = str(call.get("name") or "")
            call_args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
            call_id = str(call.get("id") or "")
            if name in ACTION_TOOLS:
                try:
                    proposal = propose_action(conn, user_id, subject, name, call_args)
                except ValueError as exc:
                    raise AgentInputError(str(exc)) from exc
                label = proposal.get("label") or describe_step(name, call_args)
                steps.append({"name": name, "args": call_args, "label": label, "kind": "action",
                              "status": "needs_confirm", "call_id": call_id, "proposal": proposal})
                return steps, None, {"tool": name, "args": call_args, "proposal": proposal,
                                     "call_id": call_id}
            try:
                data = execute_read_tool(conn, user_id, subject, name, call_args)
            except ValueError as exc:
                raise AgentInputError(str(exc)) from exc
            label = describe_step(name, call_args, data)
            steps.append({"name": name, "args": call_args, "label": label, "kind": "read",
                          "status": "done", "call_id": call_id, "result": data})
            messages.append({"role": "assistant", "content": preamble or None,
                             "tool_calls": [{"id": call_id, "type": "function",
                                              "function": {"name": name, "arguments": json.dumps(call_args, ensure_ascii=False)}}]})
            messages.append({"role": "tool", "tool_call_id": call_id,
                             "content": json.dumps(data, ensure_ascii=False)[:4000]})
            # Реплика принадлежит первому вызову пачки: дальше в пачке она уже
            # была бы переигровкой того же сообщения.
            preamble = None
        # Продолжаем цикл: модель решает дальше с результатами инструментов.
    return steps, _summarize(chat_fn, messages, deadline), None


def _summarize(chat_fn, messages: list, deadline: float) -> str:
    """Финал по потолку шагов: один вызов БЕЗ инструментов — короткий ответ по
    уже собранным данным.

    Ничего не теряем: жетон хода уже потрачен, данные на руках, а ученику
    «собери всё» отказ вместо ответа. Время хода кончилось, модель снова
    полезла в инструменты или сломалось — тогда честная просьба уточнить.
    """
    budget = deadline - time.monotonic()
    if budget > TURN_CALL_FLOOR_SEC:
        # Последнее сообщение истории — результат инструмента, а вызова без
        # tools такой хвост у провайдеров не ждут: закрываем его короткой
        # репликой ученика («дальше не лезь, ответь»), а не молчанием.
        ask = list(messages) + [{"role": "user",
                                 "content": "Данных достаточно. Ответь коротко по тому, "
                                            "что уже собрано, и не вызывай новые инструменты."}]
        try:
            parsed = chat_fn(ask, [], budget) or {}
        except Exception:  # noqa: BLE001 — ответ без модели лучше 502
            return LONG_TURN_TEXT
        text = parsed.get("text")
        if text and not (parsed.get("tool_calls") or []):
            return str(text)[:8000]
    return LONG_TURN_TEXT
