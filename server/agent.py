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
import re
import sqlite3
import time

# ---------------------------------------------------------------------------
# Лимиты хода
# ---------------------------------------------------------------------------
AGENT_QUOTA_MAX_DEFAULT = 10
AGENT_QUOTA_WINDOW_DEFAULT_SEC = 8 * 3600
AGENT_TEXT_MIN = 1
AGENT_TEXT_MAX = 2000
# Потолок ТЕКСТА ответа (и оттуда — строки agent_messages). Шире прежних 8000
# осознанно: ответ несёт ещё и служебный блок ```suggest с кнопками в САМОМ
# КОНЦЕ, и рез ровно на 8000 отрывал его у длинного ответа — кнопок не было
# там, где они нужнее всего. Держится в согласии с ai.AI_REPLY_MAX (там режется
# ответ провайдера) — расхождение означало бы, что блок срезан ещё на приёме.
AGENT_REPLY_MAX = 9000
MAX_TOOL_STEPS = 10
TURN_TIMEOUT_SEC = 90.0
# Потолок шагов не должен отдавать ученику отказ: сначала один вызов БЕЗ
# инструментов (короткий ответ по уже собранным данным), и только если время
# хода кончилось или модель снова полезла в инструменты — эта честная просьба.
LONG_TURN_TEXT = ("Я закопался в твоих данных и не успел собрать всё в один ответ. "
                  "Спроси чуть конкретнее — отвечу толком.")
# Столько секунд бюджета хода оставляем на один вызов модели: меньше — вызов
# заведомо не вернётся, и мы сожгли бы остаток хода впустую. Лучше честно
# закончить ход тем, что уже собрано (см. run_cycle).
TURN_CALL_FLOOR_SEC = 5.0
# Финал по потолку шагов (_summarize) — не «шаг цикла», а ответ по уже
# собранным данным: ему даётся собственное окно сверх бюджета хода. Иначе
# честный ответ подменялся бы просьбой уточнить вопрос ровно в тот момент,
# когда все данные уже на руках. Худшее время хода — 90 + 15 с, клиент ждёт
# без таймаута, а окно подхвата после перемонтирования (300 с) с запасом.
TURN_SUMMARY_EXTRA_SEC = 15.0


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
    "Ты — ИИ-наставник «ege easy». Готовишь ученика к ЕГЭ и говоришь по-русски.\n"
    "ХАРАКТЕР И ЯЗЫК.\n"
    "- Ты живой человек, который рядом: спокойный, дружелюбный, на «ты», без канцелярита и без лести.\n"
    "- Пиши так, как пишешь другу: короткими фразами, обычными словами. Ты не справка и не робот — "
    "не начинай с «Конечно», «Разумеется», «Я готов помочь». Не пересказывай вопрос своими словами.\n"
    "- Никакого выпендрёжа и жаргона: «производная», «дискриминант», «К1», «прогноз» — можно, "
    "«суть», «изи», «мотивашка», смайлики пачками — нельзя. Один уместный эмодзи за ответ — предел.\n"
    "- Уважай человека без сюсюканья: не «молодец!», а «да, тут всё верно» или «смотри, где рассыпалось».\n"
    "- Если ошибся или чего-то нет — скажи прямо и по-человечески, а не «данные недоступны».\n"
    "ЖЁСТКИЕ ПРАВИЛА (их нарушать нельзя).\n"
    "1. Все числа (баллы, прогноз, ошибки, попытки, дни, XP) — только из инструментов. Ничего не выдумывай "
    "и не оценивай «на глаз». Нет данных — так и скажи.\n"
    "2. НИКОГДА не говори, что сейчас посмотришь, проверишь, глянешь, откроешь профиль или прогноз, — "
    "а потом не вызывай инструмент. Обещание посмотреть и есть вызов: сначала ВЫЗОВ, потом слова. "
    "Если просишь данные о прогрессе, профиле, ошибках, навыках, днях, попытках, сочинениях или плане — "
    "в этом же ответе вызывай инструмент, а текст оставляй на потом. Реплика «сейчас посмотрю» без вызова "
    "запрещена: это либо пустая болтовня, либо обман.\n"
    "2a. Порядок строгий: просьба ученика → инструмент(ы) → и только по результатам финальный ответ. "
    "Финальный ответ без единого вызова допустим лишь тогда, когда вопрос вообще не про его данные "
    "(«привет», «что такое логарифм», «объясни правило»). Сомневаешься — вызывай.\n"
    "3. На вопрос «какой у меня балл/прогноз/сколько наберу» — fold_web(op=\"forecast\"). "
    "«что подтянуть» — тоже forecast, назови top-gains.\n"
    "4. Обращайся к ученику по имени из fold_web(op=\"profile\"), если оно есть. Род глаголов не угадывай: "
    "неочевидно (унисекс, нерусское имя, прозвище) — нейтрально («ты справился», «у тебя получилось»).\n"
    "5. Коротко и по делу: вывод, потом 1–3 конкретных шага. 4–8 строк обычно хватает. "
    "Никогда не пересказывай сырые JSON инструментов и не показывай внутренние id без нужды.\n"
    "5a. Ответ форматируй markdown: **жирный** для главного, `код` для названий, списки для перечислений, "
    "короткие абзацы. Таблицы, заголовки и простыни не нужны.\n"
    "5b. Внутренние коды ученику лучше не показывать: вместо «задание re_3_4», «n01_planimetry», "
    "«fold_web», «lesson_get» говори словами, которые понимает человек — «задание на отрезки», "
    "«урок по производным», «твои ошибки». Код уместен, только если ученик сам его прислал или "
    "просит найти именно его, — и тогда рядом с человеческим названием.\n"
    "6. Действия (сменить уровень/цель/имя, отметить ошибку разобранной, сбросить прогресс) — только через "
    "инструменты действий: они сами попросят подтверждение, сам ничего не меняй и не обещай «сейчас поменяю».\n"
    "7. Если ученик грубит, злится или пишет «я тупой» — не морализируй и не читай лекций: признай сложность "
    "и предложи один маленький шаг. Никогда не унижай и не высмеивай.\n"
    "СЦЕНАРИИ (какой инструмент под какой вопрос).\n"
    "- «где я ошибаюсь / что у меня плохо» → fold_web(op=\"errors\"), при нужде task_get по 1–2 заданиям из last.\n"
    "- «какой прогноз / что поднять» → fold_web(op=\"forecast\"), назови top-gains из ответа.\n"
    "- «разбери задание N» → fold_web(op=\"attempts\", taskId=...) + task_get.\n"
    "- «как мои успехи / сколько решено / что пройдено» → fold_web(op=\"progress\"), при нужде skills.\n"
    "- «план на неделю» → plan_draft, затем коротко перескажи своими словами.\n"
    "- «посмотри профиль / кто я» → fold_web(op=\"profile\").\n"
    "- «что такое логарифм / объясни тему» → lesson_get, если есть подходящий skillId; иначе объясни сам.\n"
    "- «поменяй цель/уровень/имя» → update_profile (потребует подтверждения).\n"
    "- «отметь ошибку разобранной» → resolve_error (потребует подтверждения).\n"
    "Если инструментов для честного ответа не хватило — скажи это прямо и предложи, что спросить.\n"
    "КНОПКИ-ПРОДОЛЖЕНИЯ (обязательная часть контракта).\n"
    "В САМОМ КОНЦЕ ответа добавь служебный блок из 2–3 вариантов, что ученик может спросить дальше. "
    "Формат строго такой (язык блока — suggest, иначе он попадёт в текст):\n"
    "```suggest\n"
    '[{"label":"Что подтянуть","ask":"Что мне подтянуть в первую очередь? Посмотри мой прогноз и ошибки."},'
    '{"label":"Дай задачу","ask":"Дай мне одну задачу на слабую тему, чтобы проверить, ушла ли ошибка."}]\n'
    "```\n"
    "label — 2–4 слова для кнопки, ask — короткий живой вопрос от лица ученика (до 140 символов), "
    "конкретно по теме этого ответа, без нумерации и без «нажми». Блок идёт после всего текста, "
    "больше в ответе его никак не упоминай."
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
            # Порядок ЗНАЧЕНИЙ должен совпадать с порядком плейсхолдеров
            # (task_id, user_id, subject). Раньше здесь стояло
            # (task_id, subject, user_id): user_id получал предмет, а предмет —
            # user_id, и инструмент «разобрать ошибку по taskId» не наодил
            # ничего никогда. Хуже того, как только subject смог бы оказаться
            # числом, запрос выбрал бы ЧУЖУЮ ошибку, а apply_action (с верным
            # порядком) пометил бы её разобранной.
            row = conn.execute("SELECT id, task_id FROM user_errors WHERE task_id=? AND user_id=? AND subject=? AND resolved=0 ORDER BY id LIMIT 1",
                               (task_id, user_id, subject)).fetchone()
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


# ---------------------------------------------------------------------------
# Обещание вместо вызова инструмента
#
# Живой случай: «посмотри мой профиль» → модель отвечает «Сейчас посмотрю твой
# профиль» и НЕ зовёт fold_web. Ученик видит болтовню вместо данных, а ход
# считается успешным. Это не ошибка формата (текст без вызовов — легальный
# ответ), поэтому раньше такой ответ ещё и кэшировался.
#
# Лечится тремя шагами: (1) промпт запрещает обещать вместо вызова, (2) цикл
# ловит обещание и переспрашивает ОДИН раз жёстко, (3) если модель упрямится —
# сервер сам зовёт очевидный инструмент по вопросу и просит ответ по данным.
# Последний шаг делает отказ невозможным: данные придут из базы в любом случае.
# ---------------------------------------------------------------------------
# Глаголы-обещания. Ловим именно «сделаю потом»: «посмотрю», «проверю»,
# «сейчас глянем» и т.п. «Не могу посмотреть» под правило не попадает —
# это честный отказ, а не обещание.
PROMISE_RE = re.compile(
    r"(?:сейчас|щас|сейчас-сейчас|секунду|минуту|давай|давай-ка|сразу|уже)?\s*"
    r"(?:посмотрю|посмотрим|проверю|проверим|гляну|глянем|загляну|открою|откроем|"
    r"загружу|загрузим|соберу|соберём|изучу|посчитаю|подниму|подтяну|сверю|"
    r"обновлю|поменяю|изменю|составлю|подготовлю|посчитаю|"
    r"соберу\s+данные|собираю\s+данные|беру\s+данные)",
    re.IGNORECASE)

# Признаки того, что вопрос вообще про данные ученика (и без инструмента на
# него честно ответить нельзя). Только сущности данных, без местоимений:
# «мой вопрос про логарифмы» — не повод лезть в fold_web, а «мой профиль» —
# повод. Поэтому здесь нет голых «мой/мои/как дела».
DATA_ASK_RE = re.compile(
    r"(?:профил|прогресс|прогноз|балл|ошибк|ошиба|навык|статистик|попытк|"
    r"сочинени|эссе|план\s+подготовк|уровен|цел[ьия]|насколько\s+я|"
    r"сколько\s+(?:я|у\s+меня|реш|набр|балл)|у\s+меня\s+(?:прогресс|балл|ошибк|уровен|статистик))",
    re.IGNORECASE)

STALL_NUDGE = ("Стоп. Не пиши, что сейчас посмотришь, — вызови инструмент прямо сейчас, "
               "в этом же ответе, без текста. Данные ученика нужны для ответа.")

# Что вызвать, если модель так и не согласилась звать инструменты. Порядок
# важен: первое совпадение выигрывает, поэтому частное (сочинения, план) стоит
# перед общим (прогресс).
FALLBACK_TOOL_RULES: list = [
    (re.compile(r"(?:сочинени|эссе|к1|критери)", re.IGNORECASE), ("essay_history", {})),
    (re.compile(r"(?:план|расписани|график|недел)", re.IGNORECASE), ("plan_draft", {})),
    (re.compile(r"(?:прогноз|балл|сколько\s+набер|подтянуть|поднять|потян)", re.IGNORECASE),
     ("fold_web", {"op": "forecast"})),
    (re.compile(r"(?:профил|кто\s+я|как\s+меня|цел[ьия]|уровен)", re.IGNORECASE),
     ("fold_web", {"op": "profile"})),
    (re.compile(r"(?:ошибк|ошиба|разобра)", re.IGNORECASE), ("fold_web", {"op": "errors"})),
    (re.compile(r"(?:навык|тем[аыу]|урок)", re.IGNORECASE), ("fold_web", {"op": "skills"})),
]


def looks_like_promise(text: str) -> bool:
    """Текст похож на «сейчас посмотрю» без самого вызова?

    Только будущее время первого лица: обещание сделать. Прошедшее («посмотрел»)
    и инфинитив («объяснить») сюда не попадают — иначе под правило попал бы
    обычный ответ по данным («Смотри, что видно из твоих попыток»).
    """
    return bool(text) and bool(PROMISE_RE.search(str(text)))


# Маркеры «обещания вперёд»: рядом с глаголом действия должно стоять «сейчас»
# или конструкция «я посмотрю». Без них «посмотрю» в тексте — часть объяснения,
# а не заглушка вместо вызова.
_PROMISE_NOW_RE = re.compile(r"(?:сейчас|щас|секунду|минуту|давай|сразу|уже)\s*$",
                             re.IGNORECASE)


def is_empty_promise(text: str) -> bool:
    """Главная эвристика: ответ ТОЛЬКО обещает посмотреть и больше ничего не
    несёт (короткий, без цифр и без выводов) — значит вместо вызова.

    Важно: длинный ответ по данным с фразой «посмотрю» в середине сюда не
    попадает, иначе мы переспрашивали бы модель там, где она уже ответила.
    """
    body = str(text or "").strip()
    if not body or len(body) > 220:
        return False
    if not looks_like_promise(body):
        return False
    # Цифра в ответе — уже результат инструмента (баллы, попытки, проценты).
    if re.search(r"\d", body):
        return False
    # Несколько предложений — это уже объяснение, а не заглушка.
    return body.count(".") + body.count("!") + body.count("?") <= 2


def asks_for_data(text: str) -> bool:
    return bool(text) and bool(DATA_ASK_RE.search(str(text)))


def should_nudge(text: str, asked: str, steps: list, recently_read: bool) -> bool:
    """Нужно ли переспрашивать модель «вызови инструмент, а не обещай посмотреть».

    Два независимых повода, и оба узкие — иначе под переспрос попадёт обычный
    ответ по данным:
    1. Пустое обещание: ответ целиком из «сейчас посмотрю», без цифр и выводов
       (см. is_empty_promise).
    2. Данных вообще нет (ни шагов, ни чтения), а вопрос про них: самый частый
       живой случай — «посмотри мой профиль» → «Сейчас посмотрю твой профиль»
       без вызова fold_web. Здесь нужен и второй признак ответа — обещание в
       будущем времени, иначе «Привет! Чем помочь?» на вопрос про профиль тоже
       тянуло бы вызов инструмента (а это нормальный ответ).
    """
    if is_empty_promise(text):
        return True
    if steps or recently_read:
        return False
    return looks_like_promise(text) and asks_for_data(asked)


def fallback_tool_for(text: str) -> tuple[str, dict]:
    """Инструмент по вопросу, когда модель упорно не зовёт его сама."""
    clean = str(text or "")
    for pattern, call in FALLBACK_TOOL_RULES:
        if pattern.search(clean):
            return call[0], dict(call[1])
    return "fold_web", {"op": "progress"}


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
    stalls = 0
    # Вопрос ученика нужен для эвристик («это вообще про данные?») и для
    # запасного инструмента. Искать его в хвосте messages нельзя: после шага
    # последним сообщением идёт результат инструмента (JSON), а в resume после
    # подтверждения — вообще пустой хвост. Берём только настоящую реплику
    # ученика последним сообщением: у resume её нет, и навязывать ему
    # инструмент нельзя.
    _last = messages[-1] if messages else {}
    asked = str(_last.get("content") or "") if str(_last.get("role") or "") == "user" else ""
    # Вопрос про данные? Только тогда «сейчас посмотрю» — это заглушка вместо
    # вызова, и только тогда сервер имеет право позвать инструмент сам.
    asked_for_data = asks_for_data(asked)
    recently_read = False
    for _ in range(MAX_TOOL_STEPS + 1):
        budget = deadline - time.monotonic()
        if budget <= TURN_CALL_FLOOR_SEC:
            # Бюджета не осталось. Если что-то уже собрано — отдаём это (шаги
            # видны в ленте, текст честный), потому что отказ с потерей всего
            # хода хуже ответа «не успел». Нечего показать — 502 с бесплатным
            # повтором (жетон вернётся в finally).
            if steps:
                return steps, _summarize(chat_fn, messages), None
            raise TimeoutError("ход превысил 90 секунд")
        parsed = chat_fn(messages, AGENT_TOOLS, budget)
        text = parsed.get("text")
        calls = parsed.get("tool_calls") or []
        # Модель часто пишет реплику («Сейчас соберу…») и зовёт инструменты в
        # одном сообщении. Это не пол-ответа: вызовы главнее, реплику
        # переигрываем в том же assistant-сообщении (см. parse_tool_message).
        preamble = parsed.get("preamble")
        if text is not None and not calls:
            # Обещание посмотреть вместо вызова. Один раз переспрашиваем
            # жёстко, потом зовём инструмент сами — ученик не должен получать
            # «сейчас посмотрю» вместо цифр.
            if stalls == 0 and should_nudge(text, asked, steps, recently_read):
                stalls = 1
                messages.append({"role": "assistant", "content": text})
                messages.append({"role": "user", "content": STALL_NUDGE})
                continue
            if stalls == 1:
                # Модель уже получила жёсткую просьбу и всё равно не позвала
                # инструмент. Данные нужны — зовём сами и отвечаем по базе:
                # второй раз «посмотрю» без цифр ученик видеть не должен.
                # Только по вопросу ПРО данные: на «объясни логарифмы» смотреть
                # нечего, там инструмент не нужен и навязывать его нельзя.
                if (not steps and not recently_read and asked_for_data
                        and is_empty_promise(text)):
                    name, call_args = fallback_tool_for(asked)
                    forced = _force_read(conn, user_id, subject, name, call_args, messages, steps,
                                         chat_fn)
                    if forced:
                        return steps, forced, None
                return steps, _final_or_summary(chat_fn, messages, text), None
            return steps, text, None
        if not calls:
            # Парсер ai.py такое уже отбраковал; страховка от чужого chat_fn.
            if stalls == 0:
                stalls = 1
                messages.append({"role": "user", "content": STALL_NUDGE})
                continue
            if steps or recently_read:
                return steps, _summarize(chat_fn, messages), None
            raise ValueError("пустой ответ модели")
        if len(steps) + len(calls) > MAX_TOOL_STEPS:
            # Потолок кодом: длинный цикл обрываем ответом по собранным данным,
            # а не ошибкой — ученик звал «вызови всё», и отказ тут обиднее ответа.
            return steps, _summarize(chat_fn, messages), None
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
            recently_read = True
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
    return steps, _summarize(chat_fn, messages), None


def _force_read(conn: sqlite3.Connection, user_id: int, subject: str, name: str, call_args: dict,
                messages: list, steps: list, chat_fn) -> str | None:
    """Модель не зовёт инструмент — зовём сами, чтобы ответ опирался на базу.

    Последний рубеж стабильности: вопрос был про данные (это уже проверено
    вызывающим), значит и ответ обязан прийти из базы, а не из фантазии.
    Возвращает текст ответа по собранным данным либо None, если инструмент не
    отдал ничего (тогда решает вызывающий).

    messages ШТАТНО НЕ МУТИРУЕТСЯ: модель этот хвост уже не увидит (финал
    собирается из своей копии), а мутация ломала бы вызывающего.
    """
    try:
        data = execute_read_tool(conn, user_id, subject, name, call_args)
    except ValueError:
        return None
    label = describe_step(name, call_args, data)
    call_id = f"auto-{len(steps) + 1}"
    steps.append({"name": name, "args": call_args, "label": label, "kind": "read",
                  "status": "done", "call_id": call_id, "result": data})
    local = list(messages) + [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": call_id, "type": "function",
                         "function": {"name": name,
                                      "arguments": json.dumps(call_args, ensure_ascii=False)}}]},
        {"role": "tool", "tool_call_id": call_id,
         "content": json.dumps(data, ensure_ascii=False)[:4000]},
    ]
    return _summarize(chat_fn, local)


def _final_or_summary(chat_fn, messages: list, text: str) -> str:
    """Ответ модели либо (если он снова обещает вместо ответа) — по собранному."""
    if text and not is_empty_promise(text):
        return str(text)[:AGENT_REPLY_MAX]
    return _summarize(chat_fn, messages)


# ---------------------------------------------------------------------------
# Кнопки-продолжения после ответа
#
# Модель дописывает в конец ответа служебный блок ```suggest с 2-3 вариантами
# «что спросить дальше»: короткий label (для кнопки) и ask (готовый вопрос от
# лица ученика, уходит на сервер как обычный ход). Блок вырезается из текста
# и в ленту не попадает; клиент рисует по нему те же кнопки, что и раньше, — но
# уже контекстные, а не две заглушки.
#
# Если модель блок не дала (или дала мусор), варианты берём детерминированно по
# последнему шагу: кнопки — не украшение, а рабочий путь дальше, поэтому их
# отсутствие недопустимо.
# ---------------------------------------------------------------------------
SUGGEST_BLOCK_RE = re.compile(r"```\s*suggest\s*\n?(.*?)\n?```", re.DOTALL | re.IGNORECASE)
MAX_SUGGESTIONS = 3
# Потолок «вопроса» кнопки: короткий, иначе кнопка перестаёт быть кнопкой.
SUGGEST_ASK_MAX = 160


def _suggest_item(raw) -> dict | None:
    """Одна кнопка: {"label": str, "ask": str} либо None, если мусор."""
    if not isinstance(raw, dict):
        return None
    label = " ".join(str(raw.get("label") or raw.get("title") or "").split())[:40]
    ask = " ".join(str(raw.get("ask") or raw.get("text") or raw.get("question") or "").split())
    ask = ask[:SUGGEST_ASK_MAX]
    if not ask or len(ask) < 3:
        return None
    return {"label": label or ask[:28], "ask": ask}


def split_suggestions(text: str) -> tuple[str, list]:
    """Вырезать блок ```suggest из ответа. Возвращает (чистый текст, варианты).

    Блок может быть JSON-массивом (как просит промпт) либо построчным списком
    «label | ask» — модели иногда отвечают проще, и терять кнопки из-за этого
    нельзя. Всё непонятное молча отбрасываем: текст ответа важнее.
    """
    body = str(text or "")
    items: list = []
    match = SUGGEST_BLOCK_RE.search(body)
    if match:
        inner = match.group(1).strip()
        body = (body[:match.start()] + body[match.end():]).strip()
        parsed = None
        try:
            parsed = json.loads(inner)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            parsed = parsed.get("suggestions") or parsed.get("items") or []
        if isinstance(parsed, list):
            for raw in parsed:
                item = _suggest_item(raw)
                if item:
                    items.append(item)
        else:
            # Построчный режим — «label | ask». Строка без разделителя это
            # проза модели, а не подсказка: кнопка с целым предложением
            # выглядит мусором, поэтому её просто не берём (ниже подставится
            # запасной набор).
            for line in inner.splitlines():
                line = line.strip().lstrip("-*0123456789. ").strip()
                if not line or "|" not in line:
                    continue
                label, _, ask = line.partition("|")
                item = _suggest_item({"label": label.strip(), "ask": (ask or label).strip()})
                if item:
                    items.append(item)
    # Дубли по ask (модель любит повторить одну мысль двумя кнопками).
    seen: set[str] = set()
    unique: list = []
    for item in items:
        key = item["ask"].lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return body.strip(), unique[:MAX_SUGGESTIONS]


# Кнопки по умолчанию: какая тема была в последнем шаге, такой и следующий шаг.
FALLBACK_SUGGESTIONS: dict = {
    "errors": [{"label": "Разбери ошибку", "ask": "Разбери одну мою ошибку по шагам."},
               {"label": "Что подтянуть", "ask": "Что мне подтянуть в первую очередь?"}],
    "forecast": [{"label": "Что подтянуть", "ask": "Что мне подтянуть в первую очередь, чтобы вырос балл?"},
                 {"label": "Дай задачу", "ask": "Дай задачу по самой слабой теме."}],
    "plan_draft": [{"label": "Дай задачу", "ask": "Дай первую задачу из плана."},
                   {"label": "Короче план", "ask": "Сделай план на три дня, а не на неделю."}],
    "essay_history": [{"label": "Разбор сочинения", "ask": "Что мне исправить в сочинении?"},
                      {"label": "Критерии", "ask": "Объясни, за что снимают баллы в сочинении."}],
    "lesson_get": [{"label": "Проще", "ask": "Объясни то же самое проще, как для пятиклассника."},
                   {"label": "Дай задачу", "ask": "Дай задачу на эту тему, чтобы закрепить."}],
    "task_get": [{"label": "Разбери шаг", "ask": "Разбери решение этого задания по шагам."},
                 {"label": "Похожие", "ask": "Дай похожее задание, чтобы проверить себя."}],
    "profile": [{"label": "Что подтянуть", "ask": "Что мне подтянуть в первую очередь?"},
                {"label": "План на неделю", "ask": "Составь план подготовки на неделю."}],
}
DEFAULT_SUGGESTIONS: list = [
    {"label": "Что дальше?", "ask": "Что мне делать дальше? Посмотри мой прогресс."},
    {"label": "План на неделю", "ask": "Составь план подготовки на неделю."},
]


def default_suggestions(steps: list) -> list:
    """Кнопки, когда модель блок не дала: по последнему шагу хода."""
    for step in reversed(steps or []):
        name = str(step.get("name") or "")
        op = str((step.get("args") or {}).get("op") or "")
        key = op if name == "fold_web" and op in FALLBACK_SUGGESTIONS else name
        if key in FALLBACK_SUGGESTIONS:
            return [dict(item) for item in FALLBACK_SUGGESTIONS[key]]
    return [dict(item) for item in DEFAULT_SUGGESTIONS]


def _summarize(chat_fn, messages: list) -> str:
    """Финал по потолку шагов: один вызов БЕЗ инструментов — короткий ответ по
    уже собранным данным.

    Ничего не теряем: жетон хода уже потрачен, данные на руках, а ученику
    «собери всё» отказ вместо ответа. Время хода кончилось, модель снова
    полезла в инструменты или сломалось — тогда честная просьба уточнить.

    Окно у этого вызова своё (TURN_SUMMARY_EXTRA_SEC): бюджет хода к этому
    моменту обычно исчерпан, а финалу нужны секунды — иначе честный ответ
    подменялся бы просьбой уточнить вопрос ровно тогда, когда всё уже собрано.
    """
    deadline = time.monotonic() + TURN_SUMMARY_EXTRA_SEC
    for attempt in range(2):
        budget = deadline - time.monotonic()
        if budget <= TURN_CALL_FLOOR_SEC:
            break
        # Последнее сообщение истории — результат инструмента, а вызова без
        # tools такой хвост у провайдеров не ждут: закрываем его короткой
        # репликой ученика («дальше не лезь, ответь»), а не молчанием.
        ask = list(messages) + [{"role": "user",
                                 "content": "Данных достаточно. Ответь коротко по тому, "
                                            "что уже собрано, и не вызывай новые инструменты."}]
        if attempt:
            # Второй раз — жёстче: модель уже проигнорировала просьбу.
            ask.append({"role": "user",
                        "content": "Без вызовов инструментов. Только текст ответа."})
        try:
            parsed = chat_fn(ask, [], budget) or {}
        except Exception:  # noqa: BLE001 — ответ без модели лучше 502
            break
        text = parsed.get("text")
        if text and not (parsed.get("tool_calls") or []):
            return str(text)[:AGENT_REPLY_MAX]
    return LONG_TURN_TEXT
