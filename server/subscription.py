"""Подписка ege easy Plus: тариф, сроки, платежи, продление.

Самодостаточный модуль (только stdlib): схема SQLite, чтение статуса и
транзакционные мутаторы. Ничего не знает про HTTP, провайдеров ИИ и
админку — сервер вызывает его из route-обработчиков.

Модель:
  * тариф один — ``plus``; период ``month`` (календарный месяц: 7 окт →
    7 ноя при любой длине месяца, 199₽) или ``year`` (+12 календарных
    месяцев, 1590₽, −33% к помесячной оплате). Цены переопределяются
    окружением, а длительности — только явными EGE_PLUS_{MONTH,YEAR}_SEC
    в секундах (нужны тестам с короткими сроками; по умолчанию календарь);
    (см. EGE_PLUS_* ниже): тесты и деплой меняют их без правки кода;
  * активна = status в (active, cancelled) И expires_at_ms > now.
    ``cancelled`` — это «не продлевать»: доступ до конца срока живёт.
    Просрочка не пишется лениво: expired-строка читается неактивной сама
    по себе, а перевёрстку статуса делает subscription_refresh() в тех
    местах, где запись безопасна (статус, покупка, админка);
  * продление = успешный платёж: expires растёт от max(now, expires)
    (продления складываются, а не перезаписываются);
  * отмена подписки биллингом НЕ является: сброс «весь прогресс»
    (admin_reset) таблицы подписки не трогает, удаление аккаунта сносит
    всё каскадом (FK ON DELETE CASCADE);
  * users.subscription — зеркало для глаз («plus»/NULL), best-effort:
    лимиты его НЕ читают, источником правды всегда остаётся таблица
    subscriptions.

Провайдеры оплаты:
  * ``manual`` — ручной грант/отзыв из админки (платёж 0₽ для аудита);
  * ``mock`` — учебный шлюз для превью и тестов: checkout создаёт
    pending-платёж, confirm/webhook его подтверждают. Включён только при
    EGE_SUBSCRIPTION_MOCK=1, иначе confirm отвечает отказом, а не
    «успешной оплатой»;
  * ``platega`` — настоящий шлюз (см. раздел Platega в конце файла):
    checkout заводит счёт в шлюзе и отдаёт ссылку на оплату, confirm
    опрашивает живой статус, callback подтверждает по заголовкам
    X-MerchantId/X-Secret. Активен при заданных EGE_PLATEGA_MERCHANT_ID
    и EGE_PLATEGA_SECRET — тогда checkout по умолчанию идёт через него;
  * настоящий шлюз подключается сюда же: checkout создаёт pending с
    provider_payment_id шлюза, а POST /api/subscription/webhook
    подтверждает его по HMAC-подписи (EGE_SUBSCRIPTION_WEBHOOK_SECRET).
    Повтор вебхука идемпотентен: уже подтверждённый платёж не продлевает
    срок дважды.

Все мутаторы присоединяются к уже открытой транзакции, а если её нет —
открывают свою (BEGIN IMMEDIATE + commit/rollback). Поэтому их можно звать
и из route-обработчиков на свежем соединении, и напрямую поверх прямых
INSERT (тесты, скрипты) — второй BEGIN никого не рвёт.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from calendar import monthrange as _monthrange
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from pathlib import Path as _Path

try:
    import importlib.util as _ilu

    _ledger_spec = _ilu.spec_from_file_location(
        "ege_sub_quota_ledger", _Path(__file__).resolve().parent / "quota_ledger.py")
    if _ledger_spec is not None and _ledger_spec.loader is not None:
        _ledger_mod = _ilu.module_from_spec(_ledger_spec)
        _ledger_spec.loader.exec_module(_ledger_mod)
    else:
        _ledger_mod = None
except Exception:
    _ledger_mod = None

_QL = _ledger_mod

PLAN_PLUS = "plus"

PERIOD_MONTH = "month"
PERIOD_YEAR = "year"
PERIODS = (PERIOD_MONTH, PERIOD_YEAR)

STATUS_PENDING = "pending"
STATUS_ACTIVE = "active"
STATUS_CANCELLED = "cancelled"
STATUS_EXPIRED = "expired"
STATUS_PAST_DUE = "past_due"

PAY_PENDING = "pending"
PAY_SUCCEEDED = "succeeded"
PAY_FAILED = "failed"
PAY_REFUNDED = "refunded"
PAY_CANCELLED = "cancelled"

PROVIDER_MANUAL = "manual"
PROVIDER_MOCK = "mock"
PROVIDER_PLATEGA = "platega"
# Оплата промокодом на 100%: денег нет, шлюз не задействован — в истории
# видно, что Plus выдан по коду, а не куплен. В оборот не входит
# (как manual): средний чек считают только настоящие платежи.
PROVIDER_PROMO = "promo"

# Уровни Plus: проверки сочинений 5 -> 10 в день, запросы к ИИ 10 -> 50.
PLUS_ESSAY_LIMIT = 10
PLUS_AGENT_LIMIT = 50

# Публичный id платежа: 10 символов A–Z/a–z/0–9, как public_id тредов
# ИИ (та же узнаваемая форма). Последовательные INTEGER id наружу
# не отдаём: они перечисляются (1, 2, 3…) и выдают масштаб биллинга.
# На входе принимаем обе формы (public_id — основная, int — легаси),
# но только со сверкой владельца. Проверка владельца при этом остаётся —
# public_id это второй слой защиты, а не замена ей.
PAY_PUBLIC_ID_LEN = 10
PAY_PUBLIC_ID_ALPHABET = ("ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                          "abcdefghijklmnopqrstuvwxyz"
                          "0123456789")


def _new_payment_public_id() -> str:
    """Свежий кандидат в public_id. Только цифры не допускаем: HTTP-слой
    приводит цифровые строки к int (легаси-форма id), и такой public_id
    уехал бы не в ту ветку разбора."""
    while True:
        cand = "".join(secrets.choice(PAY_PUBLIC_ID_ALPHABET)
                        for _ in range(PAY_PUBLIC_ID_LEN))
        if not cand.isdigit():
            return cand


def is_payment_public_id(raw) -> bool:
    return (isinstance(raw, str) and len(raw) == PAY_PUBLIC_ID_LEN
            and all(c in PAY_PUBLIC_ID_ALPHABET for c in raw))


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(float(os.environ.get(name) or default)))
    except (TypeError, ValueError):
        return default


def plus_price_kopecks(period: str) -> int:
    if period == PERIOD_YEAR:
        return _env_int("EGE_PLUS_PRICE_YEAR_KOP", 159000)
    return _env_int("EGE_PLUS_PRICE_MONTH_KOP", 19900)


def _add_calendar_months(base_ms: int, months: int) -> int:
    """Прибавить календарные месяцы к моменту (UTC, без DST-сюрпризов):
    7 окт + 1 мес = 7 ноя, 31 янв + 1 мес = 28 фев (кламп к концу месяца),
    29 фев 2024 + 12 мес = 28 фев 2025. Время суток сохраняется."""
    try:
        base = int(base_ms)
    except (TypeError, ValueError):
        base = NOW_MS()
    dt = _datetime.fromtimestamp(base / 1000, tz=_timezone.utc)
    total = dt.month - 1 + int(months)
    year, month = dt.year + total // 12, total % 12 + 1
    day = min(dt.day, _monthrange(year, month)[1])
    return int(dt.replace(year=year, month=month, day=day).timestamp() * 1000)


def _env_seconds(name: str) -> int | None:
    """Явный оверрайд длительности в секундах (для тестов). None — не задан,
    действует календарь. Пустая строка — тоже «не задан»."""
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return None
    try:
        return max(1, int(float(str(raw).strip())))
    except (TypeError, ValueError):
        return None


def plus_period_ms(period: str, base_ms: int | None = None) -> int:
    """Длительность периода в мс от базы: календарный месяц / 12 месяцев
    (7 окт → 7 ноя независимо от длины месяца — как у всех сервисов).
    Явные EGE_PLUS_{MONTH,YEAR}_SEC переключают на фиксированные секунды
    (нужны тестам с короткими сроками)."""
    if period == PERIOD_YEAR:
        sec = _env_seconds("EGE_PLUS_YEAR_SEC")
        if sec is not None:
            return sec * 1000
        base = int(base_ms) if base_ms is not None else NOW_MS()
        return _add_calendar_months(base, 12) - base
    sec = _env_seconds("EGE_PLUS_MONTH_SEC")
    if sec is not None:
        return sec * 1000
    base = int(base_ms) if base_ms is not None else NOW_MS()
    return _add_calendar_months(base, 1) - base


def subscription_mock_enabled() -> bool:
    return (os.environ.get("EGE_SUBSCRIPTION_MOCK") or "").strip() == "1"


def webhook_secret() -> str:
    return (os.environ.get("EGE_SUBSCRIPTION_WEBHOOK_SECRET") or "").strip()


def agent_requires_plus() -> bool:
    """Флаг будущего «ИИ только по подписке».

    Выключен по умолчанию: текущие бесплатные пользователи ничего не
    теряют, Plus только поднимает потолки. Когда продукт будет готов
    закрыть ИИ для бесплатного тарифа — один флаг, без правок
    кода: endpoints начнут отвечать 403 SUBSCRIPTION_REQUIRED.
    """
    return (os.environ.get("EGE_AGENT_REQUIRES_PLUS") or "").strip() == "1"


def now_ms() -> int:
    return int(time.time() * 1000)


NOW_MS = now_ms

_SCHEMA_DONE: set[str] = set()


def _db_key(conn: sqlite3.Connection) -> str:
    # Ключ — путь файла БД. Пустой путь (чистый :memory:) — это отдельная база
    # на каждое соединение: там memo корректно только в пределах соединения.
    try:
        rows = conn.execute("PRAGMA database_list").fetchall()
        if rows and rows[0][2]:
            return str(rows[0][2])
        return f"memory:{id(conn)}"
    except sqlite3.Error:
        return f"memory:{id(conn)}"


def ensure_subscription_schema(conn: sqlite3.Connection) -> None:
    key = _db_key(conn)
    if key in _SCHEMA_DONE:
        return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          plan TEXT NOT NULL DEFAULT 'plus',
          status TEXT NOT NULL DEFAULT 'active',
          period TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
          provider TEXT NOT NULL DEFAULT 'manual',
          external_id TEXT UNIQUE,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS subscription_payments (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
          amount_kopecks INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'RUB',
          period TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          provider TEXT NOT NULL DEFAULT 'manual',
          provider_payment_id TEXT UNIQUE,
          idempotency_key TEXT UNIQUE,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at_ms INTEGER NOT NULL,
          paid_at_ms INTEGER,
          promo_code TEXT
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sub_payments_user"
                 " ON subscription_payments(user_id)")
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(subscription_payments)")}
        if "public_id" not in cols:
            conn.execute("ALTER TABLE subscription_payments ADD COLUMN public_id TEXT")
        if "promo_code" not in cols:
            conn.execute("ALTER TABLE subscription_payments ADD COLUMN promo_code TEXT")
    except sqlite3.Error:
        pass
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_payments_public"
                 " ON subscription_payments(public_id)")
    # Правило «один код — один раз на аккаунт» читает колонку promo_code:
    # у строк, заведённых до неё, код лежит в payload_json.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sub_payments_promo"
                 " ON subscription_payments(promo_code, user_id)")
    _backfill_payment_public_ids(conn)
    _backfill_payment_promo_codes(conn)
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        if "subscription" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN subscription TEXT")
    except sqlite3.Error:
        pass
    # DDL в autocommit применяется сам; коммит нужен только чтобы закрыть
    # неявную транзакцию первого касания — чужую не трогаем.
    if not conn.in_transaction:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    _SCHEMA_DONE.add(key)


def _row_to_dict(row) -> dict | None:
    if row is None:
        return None
    try:
        return dict(row)
    except (TypeError, ValueError):
        return None


def _backfill_payment_public_ids(conn: sqlite3.Connection) -> None:
    """Выдать public_id строкам, заведённым до колонки. Идемпотентно:
    трогает только NULL. Присоединяется к чужой транзакции, как остальные
    мутаторы (коммит/откат за вызывателем); свою неявную — коммитит сам,
    иначе финальный `if not in_transaction` в ensure решит, что писать
    нечего, и close откатит UPDATE."""
    try:
        rows = conn.execute("SELECT id FROM subscription_payments"
                            " WHERE public_id IS NULL").fetchall()
    except sqlite3.Error:
        return
    if not rows:
        return
    own = not conn.in_transaction
    try:
        for (pid,) in rows:
            for _ in range(20):
                try:
                    conn.execute("UPDATE subscription_payments SET public_id=?"
                                 " WHERE id=? AND public_id IS NULL",
                                 (_new_payment_public_id(), int(pid)))
                    break
                except sqlite3.IntegrityError:
                    continue
        if own:
            conn.commit()
    except Exception:
        if own:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        raise


def _backfill_payment_promo_codes(conn: sqlite3.Connection) -> None:
    """Проставить promo_code строкам, заведённым до колонки: код уже лежит
    в payload_json, переносим его колонкой, чтобы правило «один код — один
    раз на аккаунт» видело старые активации. Идемпотентно (только NULL),
    транзакция — как у _backfill_payment_public_ids."""
    try:
        rows = conn.execute("SELECT id, payload_json FROM subscription_payments"
                            " WHERE promo_code IS NULL"
                            " AND payload_json LIKE '%\"promo\"%'").fetchall()
    except sqlite3.Error:
        return
    updates: list[tuple[str, int]] = []
    for r in rows:
        try:
            data = json.loads(r["payload_json"] or "{}")
        except (TypeError, ValueError):
            continue
        code = str((data or {}).get("promo") or "").strip().upper()
        if code and PROMO_CODE_RE.match(code):
            updates.append((code, int(r["id"])))
    if not updates:
        return
    own = not conn.in_transaction
    try:
        for code, pid in updates:
            conn.execute("UPDATE subscription_payments SET promo_code=?"
                         " WHERE id=? AND promo_code IS NULL", (code, pid))
        if own:
            conn.commit()
    except Exception:
        if own:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        raise


def _insert_payment(conn: sqlite3.Connection, user_id: int, amount: int,
                    period: str, provider: str, provider_payment_id: str,
                    key: str | None, now_ms: int) -> tuple[int, str]:
    """Вставить pending-платёж, вернуть (id, public_id). Коллизия public_id
    (UNIQUE) практически невозможна, но обрабатывается повтором, а не 500:
    неуникальным здесь бывает только чужой ключ — а он отфильтрован раньше."""
    for _ in range(20):
        public_id = _new_payment_public_id()
        try:
            cur = conn.execute("""INSERT INTO subscription_payments
                            (user_id, subscription_id, amount_kopecks, currency, period,
                             status, provider, provider_payment_id, idempotency_key,
                             public_id, payload_json, created_at_ms, paid_at_ms)
                            VALUES (?,NULL,?,'RUB',?, 'pending',?,?,?, ?, '{}',?,NULL)""",
                         (int(user_id), amount, period, provider,
                          provider_payment_id, key, public_id, now_ms))
            return int(cur.lastrowid), public_id
        except sqlite3.IntegrityError:
            continue
    raise ValueError("не удалось завести платёж")
    if row is None:
        return None
    try:
        return dict(row)
    except (TypeError, ValueError):
        return None


def _begin(conn: sqlite3.Connection) -> bool:
    """True — транзакцию открыли мы (её же и закроем); False — присоединились
    к уже открытой (коммит/откат за вызывателем)."""
    if conn.in_transaction:
        return False
    conn.execute("BEGIN IMMEDIATE")
    return True


def _end(conn: sqlite3.Connection, own: bool, ok: bool) -> None:
    if not own:
        return
    try:
        conn.commit() if ok else conn.rollback()
    except sqlite3.Error:
        pass


class PaymentConflictError(ValueError):
    """Идемпотентный конфликт (ключ использован завершённым платежом).
    HTTP-маппинг — 409, а не 400: запрос понятен, состояние не позволяет."""


def ensure_ai_usage_table(conn: sqlite3.Connection) -> None:
    """Бакеты ai_usage для доливки при активации. Та же форма, что в
    ensure_ai_usage_schema сервера (включая снос несовместимой древней
    таблицы-журнала: состояние цепочки из голых событий не восстановить,
    худшее последствие — кому-то лимит вернётся чуть раньше). Только
    CREATE без DROP здесь нельзя: confirm мог быть первым запросом в
    жизни базы, и INSERT упал бы с «no such table»."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(ai_usage)")]
    if cols and "owner" not in cols:
        conn.execute("DROP TABLE ai_usage")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ai_usage (
          owner TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          timer_ms INTEGER,
          anchor_ms INTEGER
        )""")
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(ai_usage)")]
        if cols and "anchor_ms" not in cols:
            conn.execute("ALTER TABLE ai_usage ADD COLUMN anchor_ms INTEGER")
            conn.execute("UPDATE ai_usage SET anchor_ms=timer_ms"
                         " WHERE anchor_ms IS NULL AND timer_ms IS NOT NULL")
    except sqlite3.Error:
        pass


def get_subscription(conn: sqlite3.Connection, user_id: int) -> dict | None:
    ensure_subscription_schema(conn)
    try:
        row = conn.execute("SELECT * FROM subscriptions WHERE user_id=?",
                           (int(user_id),)).fetchone()
    except sqlite3.Error:
        return None
    return _row_to_dict(row)


def subscription_active(conn: sqlite3.Connection, user_id: int,
                        now_ms: int | None = None) -> bool:
    """Чистое чтение, без записи: безопасно внутри чужих транзакций."""
    sub = get_subscription(conn, user_id)
    if not sub:
        return False
    if sub.get("plan") != PLAN_PLUS:
        return False
    if sub.get("status") not in (STATUS_ACTIVE, STATUS_CANCELLED):
        return False
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    try:
        return int(sub.get("expires_at_ms") or 0) > now_ms
    except (TypeError, ValueError):
        return False


def agent_access_allowed(conn: sqlite3.Connection, user_id: int,
                         now_ms: int | None = None) -> bool:
    """Доступен ли раздел ИИ. Пока флаг выключен — всем
    зарегистрированным, как раньше; с флагом — только Plus."""
    if not agent_requires_plus():
        return True
    return subscription_active(conn, user_id, now_ms)


def subscription_status(conn: sqlite3.Connection, user_id: int,
                        now_ms: int | None = None) -> dict:
    """Публичный срез для GET /api/subscription/status. Лениво переворачивает
    истекший статус (запись — только здесь, не в hot path лимитов)."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    sub = get_subscription(conn, user_id)
    active = subscription_active(conn, user_id, now_ms)
    if sub and not active and sub.get("status") in (STATUS_ACTIVE, STATUS_CANCELLED):
        subscription_refresh(conn, user_id, now_ms)
        sub = get_subscription(conn, user_id)
    if not sub:
        # Строки нет — бесплатный без истории. Доступ ИИ решает флаг:
        # пока EGE_AGENT_REQUIRES_PLUS выключен — всем (как раньше), с флагом
        # у бесплатного доступа нет. Хардкодить True здесь нельзя: turns уже
        # отвечает 403, а статус врал бы фронту «доступ открыт».
        return {"ok": True, "plan": None, "active": False, "status": None,
                "period": None, "startedAt": None, "expiresAt": None,
                "cancelAtPeriodEnd": False,
                "limits": {"essay": None, "agent": None,
                           "agentAccess": agent_access_allowed(conn, user_id, now_ms)}}
    return {"ok": True, "plan": sub.get("plan"), "active": active,
            "status": sub.get("status"), "period": sub.get("period"),
            "startedAt": sub.get("started_at_ms"), "expiresAt": sub.get("expires_at_ms"),
            "cancelAtPeriodEnd": bool(sub.get("cancel_at_period_end")),
            "limits": {"essay": PLUS_ESSAY_LIMIT if active else None,
                       "agent": PLUS_AGENT_LIMIT if active else None,
                       "agentAccess": agent_access_allowed(conn, user_id, now_ms)}}


def subscription_refresh(conn: sqlite3.Connection, user_id: int,
                         now_ms: int | None = None) -> dict:
    """Перевести истекшую подписку в expired + погасить зеркало.
    Присоединяется к чужой транзакции или открывает свою (см. _begin)."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    own = _begin(conn)
    try:
        sub = get_subscription(conn, user_id)
        if (sub and sub.get("status") in (STATUS_ACTIVE, STATUS_CANCELLED)
                and int(sub.get("expires_at_ms") or 0) <= now_ms):
            conn.execute("UPDATE subscriptions SET status=?, updated_at_ms=? WHERE user_id=?",
                         (STATUS_EXPIRED, now_ms, int(user_id)))
            _sync_mirror(conn, user_id, None)
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return subscription_status(conn, user_id, now_ms)


def _sync_mirror(conn: sqlite3.Connection, user_id: int, value: str | None) -> None:
    try:
        conn.execute("UPDATE users SET subscription=? WHERE id=?", (value, int(user_id)))
    except sqlite3.Error:
        pass


def _top_up_buckets(conn: sqlite3.Connection, user_id: int, essay_limit: int,
                    agent_limit: int, now_ms: int,
                    *, reason: str = "subscription:topup",
                    actor: int | None = None) -> None:
    """Долить карманы до полного при активации: «лимиты уже увеличены».
    Трогаем только аккаунтные бакеты (u:/agent:); device-бакеты антиабуза
    не трогаем сознательно — иначе одна покупка отмывала бы ферму.
    Только вверх: грант админа выше Plus покупка не срезает (лимит считается
    как max, остаток обязан ему соответствовать).

    Каждую доливку пишем в журнал квот (kind topup): кто, какой бакет,
    было → стало. Без журнала доливка была невидимой прибавкой."""
    ensure_ai_usage_table(conn)
    try:
        log_actor = int(actor) if actor is not None else int(user_id)
    except (TypeError, ValueError):
        log_actor = int(user_id)
    for owner, level in ((f"u:{int(user_id)}", int(essay_limit)),
                         (f"agent:{int(user_id)}", int(agent_limit))):
        try:
            row = conn.execute("SELECT count FROM ai_usage WHERE owner=?",
                               (owner,)).fetchone()
            was = int(row["count"]) if row else None
        except (sqlite3.Error, TypeError, ValueError, KeyError, IndexError):
            was = None
        cur = conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms)"
                           " VALUES (?,?,NULL)", (owner, level))
        if cur.rowcount and _QL is not None:
            try:
                _QL.log_event(conn, owner=owner, kind="init", reason=reason,
                              delta=level, count_before=None,
                              count_after=level, limit=level,
                              actor=log_actor, now_ms=now_ms)
            except Exception:
                pass
        cur = conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL, anchor_ms=NULL"
                           " WHERE owner=? AND count<?",
                           (level, owner, level))
        if cur.rowcount and _QL is not None and was is not None:
            try:
                _QL.log_event(conn, owner=owner, kind="topup", reason=reason,
                              delta=level - was, count_before=was,
                              count_after=level, limit=level,
                              actor=log_actor, now_ms=now_ms)
            except Exception:
                pass


def _activate_row(conn: sqlite3.Connection, user_id: int, period: str,
                  provider: str, now_ms: int, essay_limit: int,
                  agent_limit: int, external_id: str | None = None,
                  *, reason: str = "subscription:purchase",
                  actor: int | None = None) -> dict:
    """Создать/продлить строку подписки. Продления складываются:
    expires растёт от max(now, expires) на календарный период (месяц — то
    же число следующего месяца, год — +12 месяцев), а не перезаписывается."""
    ensure_subscription_schema(conn)
    sub = get_subscription(conn, user_id)
    if sub and sub.get("status") in (STATUS_ACTIVE, STATUS_CANCELLED):
        base = max(int(sub.get("expires_at_ms") or 0), now_ms)
        started = int(sub.get("started_at_ms") or now_ms)
    else:
        base = started = now_ms
    expires = base + plus_period_ms(period, base)
    if sub:
        conn.execute("""UPDATE subscriptions SET plan=?, status=?, period=?,
                        started_at_ms=?, expires_at_ms=?, cancel_at_period_end=0,
                        provider=?, external_id=COALESCE(?, external_id),
                        updated_at_ms=? WHERE user_id=?""",
                     (PLAN_PLUS, STATUS_ACTIVE, period, started, expires,
                      provider, external_id, now_ms, int(user_id)))
        sub_id = int(sub["id"])
    else:
        cur = conn.execute("""INSERT INTO subscriptions
                        (user_id, plan, status, period, started_at_ms, expires_at_ms,
                         cancel_at_period_end, provider, external_id,
                         created_at_ms, updated_at_ms)
                        VALUES (?,?,?,?,?,?,0,?,?,?,?)""",
                     (int(user_id), PLAN_PLUS, STATUS_ACTIVE, period, started,
                      expires, provider, external_id, now_ms, now_ms))
        sub_id = int(cur.lastrowid)
    _sync_mirror(conn, user_id, PLAN_PLUS)
    _top_up_buckets(conn, user_id, essay_limit, agent_limit, now_ms,
                    reason=reason, actor=actor)
    return {"subscriptionId": sub_id, "expiresAt": expires, "startedAt": started}


def create_checkout(conn: sqlite3.Connection, user_id: int, period: str,
                    provider: str = PROVIDER_MOCK,
                    idempotency_key: str | None = None,
                    promo_code: str | None = None) -> dict:
    """Создать pending-платёж. С идемпотентным ключом повтор возвращает тот
    же платёж, а не заводит дубль. Своя транзакция. С промокодом на 100%
    счёта не будет — Plus активируется сразу (redeem_promo)."""
    ensure_subscription_schema(conn)
    ensure_promo_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    if provider not in (PROVIDER_MOCK, PROVIDER_MANUAL, PROVIDER_PLATEGA):
        raise ValueError("provider не поддерживается")
    if idempotency_key is not None and not isinstance(idempotency_key, str):
        raise ValueError("idempotency_key должен быть строкой")
    key = (idempotency_key or "").strip() or None
    if key and len(key) > 128:
        raise ValueError("idempotency_key слишком длинный")
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    now_ms = NOW_MS()
    promo = None
    discount = 0
    amount = plus_price_kopecks(period)
    if promo_code is not None and str(promo_code).strip():
        quote = promo_quote(conn, str(promo_code), period, int(user_id))
        promo, discount, amount = quote["code"], quote["discountKopecks"], quote["finalKopecks"]
    if amount == 0 and promo:
        return redeem_promo(conn, int(user_id), promo, period)
    own = _begin(conn)
    try:
        if key:
            row = conn.execute("SELECT * FROM subscription_payments WHERE idempotency_key=?",
                               (key,)).fetchone()
            existing = _row_to_dict(row)
            if existing:
                if int(existing.get("user_id") or 0) != int(user_id):
                    raise ValueError("idempotency_key занят другим пользователем")
                if existing.get("status") != PAY_PENDING:
                    # Ключ отработал своё на завершённом платеже: вернуть его
                    # как «новый» значило бы показать оплаченный счёт к оплате
                    # (а confirm ответил бы already без продления). Честный
                    # 409: следующая покупка — с новым ключом.
                    raise PaymentConflictError("idempotency_key уже использован "
                                               "для завершённого платежа")
                _end(conn, own, True)
                return _payment_payload(existing)
        if promo:
            # С одним кодом у человека — максимум один счёт: второй дал бы
            # вторую активацию по тому же коду. Уже использован — отказ ещё
            # на quote выше; висящий неоплаченный — честная просьба сначала
            # завершить или отменить его (проверка внутри транзакции, поэтому
            # два параллельных клика не создают два счёта).
            row = conn.execute("SELECT 1 FROM subscription_payments"
                               " WHERE user_id=? AND promo_code=? AND status=?"
                               " LIMIT 1",
                               (int(user_id), promo, PAY_PENDING)).fetchone()
            if row:
                raise ValueError("У тебя уже есть неоплаченный счёт с этим "
                                 "промокодом — заверши или отмени его")
        if provider == PROVIDER_PLATEGA:
            # Шлюз требует id транзакции строго в формате UUID — общий
            # `platega_<hex>` сюда не годится, а повторное использование id
            # шлюз отвергает («already exists»), поэтому свежий UUID на счёт.
            provider_payment_id = str(uuid.uuid4())
        else:
            provider_payment_id = f"{provider}_{secrets.token_hex(12)}"
        pid, public_id = _insert_payment(conn, int(user_id), amount, period,
                                         provider, provider_payment_id, key, now_ms)
        if promo:
            conn.execute("UPDATE subscription_payments SET payload_json=?,"
                         " promo_code=? WHERE id=?",
                         (json.dumps({"promo": promo,
                                      "discountKopecks": discount},
                                     ensure_ascii=False), promo, pid))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    out = {"ok": True, "paymentId": public_id, "providerPaymentId": provider_payment_id,
           "amountKopecks": amount, "currency": "RUB", "period": period,
           "status": PAY_PENDING, "provider": provider, "mock": provider == PROVIDER_MOCK}
    if promo:
        out["promo"] = promo
        out["discountKopecks"] = discount
    return out


def confirm_payment(conn: sqlite3.Connection, payment_ref: int | str,
                    provider: str = PROVIDER_MOCK,
                    essay_limit: int = PLUS_ESSAY_LIMIT,
                    agent_limit: int = PLUS_AGENT_LIMIT,
                    expected_user_id: int | None = None) -> dict:
    """Подтвердить платёж и активировать/продлить подписку. Повторный вызов
    по тому же платежу — идемпотентный no-op (срок дважды не растёт).
    Mock-подтверждения запрещены без EGE_SUBSCRIPTION_MOCK=1.
    С expected_user_id чужой платёж неотличим от несуществующего (404):
    без проверки любой вошедший подтверждал бы чужой pending и активировал
    чужую подписку. Ссылка — public_id (10 символов, как у тредов
    ИИ): последовательные INTEGER id наружу не отдаём и в первую
    очередь не принимаем. Легаси-форма (int id) оставлена для совместимости
    и тоже требует владельца."""
    ensure_subscription_schema(conn)
    if provider == PROVIDER_MOCK and not subscription_mock_enabled():
        raise PermissionError("mock-оплата выключена (EGE_SUBSCRIPTION_MOCK=1)")
    if isinstance(payment_ref, bool):
        # JSON true/false — тоже int для isinstance: платёж №1 по `true`
        # подтверждать нельзя.
        raise ValueError("нужен paymentId")
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        if isinstance(payment_ref, int) or str(payment_ref).isdigit():
            # Легаси-форма: INTEGER id. Перечислима (1, 2, 3…), поэтому
            # без expected_user_id её принимает только внутренний вызов.
            if expected_user_id is None:
                raise KeyError("payment not found")
            row = conn.execute("SELECT * FROM subscription_payments WHERE id=?",
                               (int(payment_ref),)).fetchone()
        elif is_payment_public_id(payment_ref):
            row = conn.execute("SELECT * FROM subscription_payments WHERE public_id=?",
                               (payment_ref,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM subscription_payments WHERE provider_payment_id=?",
                               (str(payment_ref),)).fetchone()
        pay = _row_to_dict(row)
        if not pay:
            raise KeyError("payment not found")
        if (expected_user_id is not None
                and int(pay.get("user_id") or 0) != int(expected_user_id)):
            raise KeyError("payment not found")
        if pay.get("provider") != provider:
            raise ValueError("provider не совпадает с платежом")
        if pay.get("status") == PAY_SUCCEEDED:
            _end(conn, own, True)
            sub = get_subscription(conn, int(pay["user_id"]))
            return {"ok": True, "already": True,
                    "paymentId": pay.get("public_id"), "status": PAY_SUCCEEDED,
                    "expiresAt": (sub or {}).get("expires_at_ms")}
        if pay.get("status") != PAY_PENDING:
            raise ValueError(f"платёж уже {pay.get('status')}, подтвердить нельзя")
        # Сумму с текущим тарифом НЕ сверяем сознательно: она зафиксирована
        # в момент checkout (серверная запись, не ввод пользователя), и смена
        # цены между созданием и подтверждением не должна ронять честно
        # оплаченный счёт. Сумму, заявленную шлюзом, проверяет
        # webhook_recurring — там деньги реально приходят снаружи.
        conn.execute("UPDATE subscription_payments SET status=?, paid_at_ms=? WHERE id=?",
                     (PAY_SUCCEEDED, now_ms, int(pay["id"])))
        _consume_payment_promo(conn, pay)
        act = _activate_row(conn, int(pay["user_id"]), str(pay.get("period")),
                            provider, now_ms, essay_limit, agent_limit)
        conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                     (act["subscriptionId"], int(pay["id"])))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "already": False, "paymentId": pay.get("public_id"),
            "status": PAY_SUCCEEDED, **act}


def _payment_payload(pay: dict) -> dict:
    out = {"ok": True, "paymentId": pay.get("public_id"),
           "providerPaymentId": pay.get("provider_payment_id"),
           "amountKopecks": int(pay.get("amount_kopecks") or 0),
           "currency": pay.get("currency") or "RUB",
           "period": pay.get("period"), "status": pay.get("status"),
           "provider": pay.get("provider"),
           "mock": pay.get("provider") == PROVIDER_MOCK}
    try:
        data = _payload_data(pay) or {}
    except Exception:
        data = {}
    if data.get("promo"):
        out["promo"] = data["promo"]
        out["discountKopecks"] = int(data.get("discountKopecks") or 0)
    return out


def webhook_signature_valid(provider_payment_id: str, status: str,
                            signature: str) -> bool:
    secret = webhook_secret()
    if not secret:
        return False
    body = f"{provider_payment_id}.{status}".encode("utf-8")
    expect = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    # compare_digest на str падает TypeError при не-ASCII (кривая подпись
    # обязана давать 403, а не рвать соединение): сравниваем байты.
    try:
        given = (signature or "").strip().lower().encode("utf-8")
    except (AttributeError, ValueError):
        return False
    return hmac.compare_digest(expect.encode("ascii"), given)


def webhook_payment(conn: sqlite3.Connection, provider_payment_id: str,
                    status: str, period: str | None = None,
                    essay_limit: int = PLUS_ESSAY_LIMIT,
                    agent_limit: int = PLUS_AGENT_LIMIT) -> dict:
    """Входящий вебхук шлюза (подпись уже проверена вызывателем).
    Работает только по известному provider_payment_id из нашего checkout:
    подтверждает pending или возвращает идемпотентный успех. Повтор
    подтверждённого платежа срок дважды не продлевает."""
    ensure_subscription_schema(conn)
    if not provider_payment_id or not isinstance(provider_payment_id, str):
        raise ValueError("нужен provider_payment_id")
    if status not in (PAY_SUCCEEDED, PAY_FAILED, PAY_CANCELLED):
        raise ValueError("неизвестный статус вебхука")
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        pay = _row_to_dict(conn.execute(
            "SELECT * FROM subscription_payments WHERE provider_payment_id=?",
            (provider_payment_id,)).fetchone())
        if not pay:
            # Рекуррент шлюза без нашего checkout сюда не попадает: без user_id
            # платёж не к кому привязать (см. webhook_recurring для будущей
            # провайдерской привязки). Честный 404, а не выдуманная запись.
            raise KeyError("payment not found")
        if pay and pay.get("status") == PAY_SUCCEEDED:
            _end(conn, own, True)
            sub = get_subscription(conn, int(pay["user_id"]))
            return {"ok": True, "already": True, "paymentId": int(pay["id"]),
                    "expiresAt": (sub or {}).get("expires_at_ms")}
        if pay:
            if status == PAY_SUCCEEDED:
                if period not in PERIODS:
                    period = str(pay.get("period"))
                if period not in PERIODS:
                    raise ValueError("у платежа нет периода для продления")
                conn.execute("UPDATE subscription_payments SET status=?, paid_at_ms=? WHERE id=?",
                             (PAY_SUCCEEDED, now_ms, int(pay["id"])))
                _consume_payment_promo(conn, pay)
                act = _activate_row(conn, int(pay["user_id"]), period, str(pay.get("provider")),
                                    now_ms, essay_limit, agent_limit,
                                    reason="subscription:webhook")
                conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                             (act["subscriptionId"], int(pay["id"])))
                _end(conn, own, True)
                return {"ok": True, "already": False, "paymentId": int(pay["id"]), **act}
            conn.execute("UPDATE subscription_payments SET status=? WHERE id=?",
                         (status, int(pay["id"])))
            _end(conn, own, True)
            return {"ok": True, "paymentId": int(pay["id"]), "status": status}
    except Exception:
        _end(conn, own, False)
        raise


def webhook_recurring(conn: sqlite3.Connection, user_id: int, provider_payment_id: str,
                      period: str, amount_kopecks: int, provider: str = "gateway",
                      essay_limit: int = PLUS_ESSAY_LIMIT,
                      agent_limit: int = PLUS_AGENT_LIMIT) -> dict:
    """Рекуррентный платёж шлюза по известной подписке: новый provider id,
    продление срока. Идемпотентен по provider_payment_id."""
    ensure_subscription_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    if int(amount_kopecks) != plus_price_kopecks(period):
        raise ValueError("сумма платежа не совпадает с тарифом")
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    if conn.execute("SELECT id FROM subscription_payments WHERE provider_payment_id=?",
                    (provider_payment_id,)).fetchone():
        # Дубль рекуррента: записи нет, откатывать нечего — сразу идемпотентный путь.
        return confirm_payment(conn, provider_payment_id, provider,
                               essay_limit, agent_limit)
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        pid = None
        public_id = ""
        for _ in range(20):
            public_id = _new_payment_public_id()
            try:
                cur = conn.execute("""INSERT INTO subscription_payments
                                (user_id, subscription_id, amount_kopecks, currency, period,
                                 status, provider, provider_payment_id, idempotency_key,
                                 public_id, payload_json, created_at_ms, paid_at_ms)
                                VALUES (?,NULL,?,'RUB',?, 'succeeded',?,?,NULL,?,'{}',?,?)""",
                             (int(user_id), int(amount_kopecks), period, provider,
                              provider_payment_id, public_id, now_ms, now_ms))
                pid = int(cur.lastrowid)
                break
            except sqlite3.IntegrityError:
                continue
        if pid is None:
            raise ValueError("не удалось записать платёж")
        act = _activate_row(conn, int(user_id), period, provider, now_ms,
                            essay_limit, agent_limit,
                            reason="subscription:recurring")
        conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                     (act["subscriptionId"], pid))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "already": False, "paymentId": public_id, **act}


def cancel_subscription(conn: sqlite3.Connection, user_id: int,
                        now_ms: int | None = None) -> dict:
    """Отмена продления: доступ живёт до конца оплаченного срока."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    own = _begin(conn)
    try:
        sub = get_subscription(conn, user_id)
        if not sub or not subscription_active(conn, user_id, now_ms):
            raise ValueError("активной подписки нет")
        conn.execute("""UPDATE subscriptions SET status=?, cancel_at_period_end=1,
                        updated_at_ms=? WHERE user_id=?""",
                     (STATUS_CANCELLED, now_ms, int(user_id)))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return subscription_status(conn, user_id, now_ms)


def resume_subscription(conn: sqlite3.Connection, user_id: int,
                        now_ms: int | None = None) -> dict:
    """Вернуть автопродление до конца срока (флаг cancel снимается)."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    own = _begin(conn)
    try:
        sub = get_subscription(conn, user_id)
        if not sub or sub.get("status") != STATUS_CANCELLED:
            raise ValueError("нет отменённой подписки для возобновления")
        if int(sub.get("expires_at_ms") or 0) <= now_ms:
            raise ValueError("срок уже истёк — нужна новая оплата")
        conn.execute("""UPDATE subscriptions SET status=?, cancel_at_period_end=0,
                        updated_at_ms=? WHERE user_id=?""",
                     (STATUS_ACTIVE, now_ms, int(user_id)))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return subscription_status(conn, user_id, now_ms)


def admin_grant(conn: sqlite3.Connection, user_id: int, period: str,
                essay_limit: int = PLUS_ESSAY_LIMIT,
                agent_limit: int = PLUS_AGENT_LIMIT,
                note: str = "", actor: int | None = None) -> dict:
    """Ручная выдача Plus из админки (оплата 0₽ provider=manual — для аудита
    в истории видно, что это грант, а не деньги)."""
    ensure_subscription_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        act = _activate_row(conn, int(user_id), period, PROVIDER_MANUAL,
                            now_ms, essay_limit, agent_limit,
                            reason="subscription:grant", actor=actor)
        for _ in range(20):
            try:
                conn.execute("""INSERT INTO subscription_payments
                                (user_id, subscription_id, amount_kopecks, currency, period,
                                 status, provider, provider_payment_id, idempotency_key,
                                 public_id, payload_json, created_at_ms, paid_at_ms)
                                VALUES (?,?,0,'RUB',?, 'succeeded','manual',NULL,NULL,?,?,?,?)""",
                             (int(user_id), act["subscriptionId"], period,
                              _new_payment_public_id(),
                              json.dumps({"note": str(note)[:200]}, ensure_ascii=False),
                              now_ms, now_ms))
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise ValueError("не удалось записать платёж")
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return subscription_status(conn, user_id, now_ms)


def admin_revoke(conn: sqlite3.Connection, user_id: int,
                 now_ms: int | None = None) -> dict:
    """Мгновенный отзыв: срок обнуляется, зеркало гаснет. История платежей
    при этом НЕ трогается — деньги остаются в аудите."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    own = _begin(conn)
    try:
        if not get_subscription(conn, user_id):
            raise ValueError("подписки нет")
        conn.execute("""UPDATE subscriptions SET status=?, expires_at_ms=?,
                        cancel_at_period_end=0, updated_at_ms=? WHERE user_id=?""",
                     (STATUS_EXPIRED, now_ms, now_ms, int(user_id)))
        _sync_mirror(conn, user_id, None)
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return subscription_status(conn, user_id, now_ms)


def admin_refund(conn: sqlite3.Connection, user_id: int,
                 payment_id: int | str | None = None,
                 now_ms: int | None = None) -> dict:
    """Возврат денег: помечает платёж refunded и гасит подписку (возврат без
    отзыва доступа — это подарок, а не возврат). Без payment_id берётся
    последний успешный платёж; явный id (INTEGER легаси или public_id)
    обязан быть succeeded — повторный возврат того же платежа невозможен.
    История хранит refunded вечно: деньги видны в аудите как возвращённые,
    а не как доход."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    public_ref: str | None = None
    if payment_id is not None:
        if isinstance(payment_id, bool):
            raise ValueError("paymentId должен быть числом")
        if isinstance(payment_id, str) and not payment_id.isdigit():
            if not is_payment_public_id(payment_id):
                raise ValueError("paymentId должен быть числом")
            public_ref = payment_id
            payment_id = None
        else:
            try:
                payment_id = int(payment_id)
            except (TypeError, ValueError):
                raise ValueError("paymentId должен быть числом")
    own = _begin(conn)
    try:
        if payment_id is None and public_ref is None:
            row = conn.execute("""SELECT * FROM subscription_payments
                                  WHERE user_id=? AND status=?
                                  ORDER BY id DESC LIMIT 1""",
                               (int(user_id), PAY_SUCCEEDED)).fetchone()
        elif public_ref is not None:
            row = conn.execute("SELECT * FROM subscription_payments"
                               " WHERE public_id=? AND user_id=?",
                               (public_ref, int(user_id))).fetchone()
        else:
            row = conn.execute("SELECT * FROM subscription_payments WHERE id=? AND user_id=?",
                               (payment_id, int(user_id))).fetchone()
        pay = _row_to_dict(row)
        if not pay:
            raise ValueError("успешных платежей для возврата нет" if payment_id is None
                             else "платёж не найден")
        if pay.get("status") != PAY_SUCCEEDED:
            raise ValueError("вернуть можно только успешный платёж")
        conn.execute("UPDATE subscription_payments SET status=? WHERE id=?",
                     (PAY_REFUNDED, int(pay["id"])))
        if get_subscription(conn, user_id):
            conn.execute("""UPDATE subscriptions SET status=?, expires_at_ms=?,
                            cancel_at_period_end=0, updated_at_ms=? WHERE user_id=?""",
                         (STATUS_EXPIRED, now_ms, now_ms, int(user_id)))
            _sync_mirror(conn, user_id, None)
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    out = subscription_status(conn, user_id, now_ms)
    out["refund"] = {"paymentId": int(pay["id"]),
                     "amountKopecks": int(pay.get("amount_kopecks") or 0)}
    return out


def payment_history(conn: sqlite3.Connection, user_id: int, limit: int = 50,
                    offset: int = 0) -> dict:
    """История платежей пользователя: свои записи, новые сверху."""
    ensure_subscription_schema(conn)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise ValueError("limit должен быть числом")
    try:
        offset = int(offset)
    except (TypeError, ValueError):
        raise ValueError("offset должен быть числом")
    if not 1 <= limit <= 200:
        raise ValueError("limit должен быть 1..200")
    if not 0 <= offset <= 1_000_000_000:
        raise ValueError("offset вне диапазона")
    rows = conn.execute("""SELECT id, public_id, amount_kopecks, currency, period, status,
                                  provider, provider_payment_id, created_at_ms, paid_at_ms
                           FROM subscription_payments WHERE user_id=?
                           ORDER BY id DESC LIMIT ? OFFSET ?""",
                        (int(user_id), limit, offset)).fetchall()
    total = conn.execute("SELECT COUNT(*) AS c FROM subscription_payments WHERE user_id=?",
                         (int(user_id),)).fetchone()
    items = [{"id": r["id"], "publicId": r["public_id"],
              "amountKopecks": r["amount_kopecks"],
              "currency": r["currency"], "period": r["period"], "status": r["status"],
              "provider": r["provider"],
              "providerPaymentId": r["provider_payment_id"],
              "createdAt": r["created_at_ms"], "paidAt": r["paid_at_ms"]}
             for r in rows]
    return {"ok": True, "payments": items,
            "total": int(total["c"]) if total else 0,
            "limit": limit, "offset": offset}


# ---------------------------------------------------------------------------
# Лист ожидания запуска оплаты («Напомнить о запуске», исторический).
#
# Договор для истории: до подключения провайдера купить Plus было нельзя, и кнопка «Напомнить о запуске» на
# /subscription записывает сюда user_id нажавшего. Когда провайдер
# подключат, админ ОДИН РАЗ выполняет выдачу всем из списка:
#
#   curl -b admin-cookie -X POST /api/admin/subscription/waitlist \
#     -H 'Content-Type: application/json' \
#     -d '{"action":"grant","period":"month"}'
#
# Каждый из списка получает месяц Plus как ручной грант (платёж 0₽
# provider=manual с пометкой launch-waitlist — в истории платежей видно,
# что это подарок за ожидание, а не деньги). Повтор безопасен: уже
# получившие помечены granted_at_ms и пропускаются, новым нажавшим после
# выдачи грант дойдёт следующим запуском. Никакой автоматики «если
# провайдер есть, то раздать» нет осознанно: выдача — решение человека,
# а не следствие флага.
# ---------------------------------------------------------------------------

def ensure_plus_waitlist(conn: sqlite3.Connection) -> None:
    """Таблица листа ожидания. Один user_id — одна строка (повторный клик —
    no-op, а не дубль). Удаление аккаунта сносит строку каскадом."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plus_waitlist (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          created_at_ms INTEGER NOT NULL,
          granted_at_ms INTEGER
        )""")
    if not conn.in_transaction:
        try:
            conn.commit()
        except sqlite3.Error:
            pass


def join_launch_waitlist(conn: sqlite3.Connection, user_id: int) -> dict:
    """Записать «напомнить о запуске». Идемпотентно: повтор возвращает ту же
    запись. Присоединяется к чужой транзакции или открывает свою."""
    ensure_plus_waitlist(conn)
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        conn.execute("INSERT OR IGNORE INTO plus_waitlist (user_id, created_at_ms, granted_at_ms)"
                     " VALUES (?,?,NULL)", (int(user_id), now_ms))
        row = conn.execute("SELECT user_id, created_at_ms, granted_at_ms FROM plus_waitlist"
                           " WHERE user_id=?", (int(user_id),)).fetchone()
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "joined": True, "joinedAt": int(row["created_at_ms"]),
            "granted": row["granted_at_ms"] is not None}


def launch_waitlist_joined(conn: sqlite3.Connection, user_id: int) -> bool:
    """В списке ли (для подсветки кнопки). Чистое чтение, без записи."""
    try:
        ensure_plus_waitlist(conn)
        return conn.execute("SELECT 1 FROM plus_waitlist WHERE user_id=?",
                            (int(user_id),)).fetchone() is not None
    except sqlite3.Error:
        return False


def launch_waitlist_stats(conn: sqlite3.Connection) -> dict:
    """Сколько в списке, скольким уже выдали. Для админки перед выдачей."""
    ensure_plus_waitlist(conn)
    try:
        total = conn.execute("SELECT COUNT(*) AS c FROM plus_waitlist").fetchone()
        granted = conn.execute("SELECT COUNT(*) AS c FROM plus_waitlist"
                               " WHERE granted_at_ms IS NOT NULL").fetchone()
    except sqlite3.Error:
        return {"ok": True, "total": 0, "pending": 0, "granted": 0}
    total_n = int(total["c"]) if total else 0
    granted_n = int(granted["c"]) if granted else 0
    return {"ok": True, "total": total_n, "granted": granted_n,
            "pending": total_n - granted_n}


def grant_launch_waitlist(conn: sqlite3.Connection, period: str = PERIOD_MONTH,
                          note: str = "launch-waitlist") -> dict:
    """Выдать месяц Plus всем невыданным из листа ожидания (см. договор выше).

    Каждому — обычный admin_grant (строка подписки + доливка карманов +
    платёж 0₽ manual с пометкой), затем отметка granted_at_ms. Продления
    складываются как обычно: у кого уже есть Plus, месяц добавится сверху.
    Удалённые аккаунты пропускаются молча (CASCADE их уже унёс, но между
    SELECT и грантом аккаунт могли снести — сверяем наличие)."""
    ensure_plus_waitlist(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    now_ms = NOW_MS()
    own = _begin(conn)
    granted: list[int] = []
    try:
        rows = conn.execute("SELECT user_id FROM plus_waitlist"
                            " WHERE granted_at_ms IS NULL ORDER BY user_id").fetchall()
        for r in rows:
            uid = int(r["user_id"])
            if not conn.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone():
                continue
            admin_grant(conn, uid, period, note=str(note)[:200])
            conn.execute("UPDATE plus_waitlist SET granted_at_ms=? WHERE user_id=?",
                         (now_ms, uid))
            granted.append(uid)
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "granted": granted, "grantedCount": len(granted),
            "period": period}


# ---------------------------------------------------------------------------
# Поощрения: массовая выдача Plus и промокоды на скидку.
#
# Замена устаревшего листа ожидания в админке («Напомнить о запуске»):
# вместо одной кнопки «выдать всем ждущим» — два гибких инструмента:
#   * массовая выдача: месяц/год Plus списку аккаунтов с пометкой-поводом
#     (розыгрыш, условие, компенсация) + пресет «ждущие из старого листа»;
#   * промокоды: скидка в % или рублях на месяц/год/любой тариф, с лимитом
#     использований и сроком. Код на 100% активирует Plus сразу без шлюза.
# Правила простые и честные: скидка применяется к счёту в момент checkout
# (запись сервера, не ввод пользователя), повторная проверка при активации
# не урезает уже оплаченное — платёж чтут, даже если код тем временем
# исчерпался; счётчик использований растёт только при успешной активации,
# брошенные счета код не сжигают.
# ---------------------------------------------------------------------------

PROMO_KINDS = ("percent", "fixed")
PROMO_PERIODS = (PERIOD_MONTH, PERIOD_YEAR, "any")
PROMO_CODE_RE = re.compile(r"^[A-Z0-9]{4,16}$")
BONUS_BATCH_MAX = 500


def ensure_promo_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS promo_codes (
          code TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          value INTEGER NOT NULL,
          period TEXT NOT NULL DEFAULT 'any',
          max_uses INTEGER,
          used_count INTEGER NOT NULL DEFAULT 0,
          expires_at_ms INTEGER,
          active INTEGER NOT NULL DEFAULT 1,
          note TEXT NOT NULL DEFAULT '',
          created_at_ms INTEGER NOT NULL
        )""")
    if not conn.in_transaction:
        try:
            conn.commit()
        except sqlite3.Error:
            pass


def promo_normalize(raw) -> str:
    code = str(raw or "").strip().upper()
    if not PROMO_CODE_RE.match(code):
        raise ValueError("код — 4–16 символов A–Z/0–9")
    return code


def promo_create(conn: sqlite3.Connection, code: str, kind: str, value: int,
                 period: str = "any", max_uses: int | None = None,
                 expires_at_ms: int | None = None, note: str = "") -> dict:
    """Завести промокод. value: percent — 1–100, fixed — копейки (от 100).
    max_uses/expires_at_ms — None значит «без ограничения»."""
    ensure_promo_schema(conn)
    code = promo_normalize(code)
    kind = str(kind or "").strip().lower()
    if kind not in PROMO_KINDS:
        raise ValueError("kind должен быть percent или fixed")
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError("value должен быть числом")
    if kind == "percent" and not 1 <= value <= 100:
        raise ValueError("percent — от 1 до 100")
    if kind == "fixed" and value < 100:
        raise ValueError("fixed — минимум 100 копеек (1 ₽)")
    period = str(period or "any").strip().lower()
    if period not in PROMO_PERIODS:
        raise ValueError("period должен быть month, year или any")
    if max_uses is not None:
        try:
            max_uses = int(max_uses)
        except (TypeError, ValueError):
            raise ValueError("max_uses должен быть числом")
        if max_uses < 1:
            raise ValueError("max_uses — минимум 1")
    else:
        max_uses = None
    if expires_at_ms is not None:
        try:
            expires_at_ms = int(expires_at_ms)
        except (TypeError, ValueError):
            raise ValueError("expires_at_ms должен быть числом")
        if expires_at_ms <= NOW_MS():
            raise ValueError("срок уже прошёл — код истёк бы сразу")
    else:
        expires_at_ms = None
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        try:
            conn.execute("""INSERT INTO promo_codes
                            (code, kind, value, period, max_uses, used_count,
                             expires_at_ms, active, note, created_at_ms)
                            VALUES (?,?,?,?,?,0,?,?,?,?)""",
                         (code, kind, value, period, max_uses, expires_at_ms,
                          1, str(note or "")[:200], now_ms))
        except sqlite3.IntegrityError:
            raise ValueError("такой код уже есть")
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return promo_get(conn, code)


def promo_get(conn: sqlite3.Connection, code: str) -> dict:
    ensure_promo_schema(conn)
    code = promo_normalize(code)
    row = conn.execute("SELECT * FROM promo_codes WHERE code=?", (code,)).fetchone()
    pay = _row_to_dict(row)
    if not pay:
        raise KeyError("promo not found")
    return {"code": pay["code"], "kind": pay["kind"], "value": int(pay["value"]),
            "period": pay["period"],
            "maxUses": pay["max_uses"] if pay["max_uses"] is None else int(pay["max_uses"]),
            "used": int(pay["used_count"] or 0),
            "expiresAt": pay["expires_at_ms"], "active": bool(pay["active"]),
            "note": pay["note"] or ""}


def promo_list(conn: sqlite3.Connection) -> list[dict]:
    ensure_promo_schema(conn)
    try:
        rows = conn.execute("SELECT * FROM promo_codes ORDER BY created_at_ms DESC"
                            ).fetchall()
    except sqlite3.Error:
        return []
    out = []
    for r in rows:
        d = _row_to_dict(r) or {}
        try:
            out.append(promo_get(conn, str(d.get("code") or "")))
        except (KeyError, ValueError):
            continue
    return out


def promo_set_active(conn: sqlite3.Connection, code: str, active: bool) -> dict:
    ensure_promo_schema(conn)
    code = promo_normalize(code)
    own = _begin(conn)
    try:
        cur = conn.execute("UPDATE promo_codes SET active=? WHERE code=?",
                           (1 if active else 0, code))
        if not cur.rowcount:
            raise KeyError("promo not found")
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return promo_get(conn, code)


def promo_delete(conn: sqlite3.Connection, code: str) -> dict:
    """Удалить НЕиспользованный код (чистка опечаток и ошибочных условий).
    Код с историей (used_count>0) не удаляем: платежи ссылаются на него,
    честнее выключить — иначе статистика кодов теряла бы факты."""
    ensure_promo_schema(conn)
    code = promo_normalize(code)
    own = _begin(conn)
    try:
        row = conn.execute("SELECT used_count FROM promo_codes WHERE code=?",
                           (code,)).fetchone()
        if not row:
            raise KeyError("promo not found")
        if int(row["used_count"] or 0) > 0:
            raise ValueError("код уже использовался — его можно только выключить")
        conn.execute("DELETE FROM promo_codes WHERE code=?", (code,))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "code": code, "deleted": True}


def promo_used_by_user(conn: sqlite3.Connection, code: str,
                       user_id: int) -> bool:
    """Активировал ли этот аккаунт код (status succeeded). Не бросает:
    колонки может не быть в древней базе — тогда считаем «нет»."""
    try:
        code = promo_normalize(code)
        row = conn.execute("SELECT 1 FROM subscription_payments"
                           " WHERE user_id=? AND promo_code=? AND status=?"
                           " LIMIT 1",
                           (int(user_id), code, PAY_SUCCEEDED)).fetchone()
        return row is not None
    except (sqlite3.Error, TypeError, ValueError):
        return False


def promo_pending_by_user(conn: sqlite3.Connection, code: str,
                          user_id: int) -> bool:
    """Есть ли у аккаунта неоплаченный счёт с этим кодом. Не бросает."""
    try:
        code = promo_normalize(code)
        row = conn.execute("SELECT 1 FROM subscription_payments"
                           " WHERE user_id=? AND promo_code=? AND status=?"
                           " LIMIT 1",
                           (int(user_id), code, PAY_PENDING)).fetchone()
        return row is not None
    except (sqlite3.Error, TypeError, ValueError):
        return False


def promo_quote(conn: sqlite3.Connection, code: str, period: str,
                user_id: int | None = None) -> dict:
    """Сколько будет стоить тариф с промокодом. Ошибки — человеческим текстом
    для окна оплаты (код не найден / выключен / истёк / исчерпан / не тот
    тариф). С user_id — ещё и личное правило: один код аккаунту даётся один
    раз, повторная активация невозможна (ошибка до создания счёта)."""
    ensure_promo_schema(conn)
    ensure_subscription_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    try:
        code = promo_normalize(code)
    except ValueError:
        raise ValueError("Промокод не найден")
    row = conn.execute("SELECT * FROM promo_codes WHERE code=?", (code,)).fetchone()
    promo = _row_to_dict(row)
    if not promo:
        raise ValueError("Промокод не найден")
    if not promo.get("active"):
        raise ValueError("Промокод выключен")
    if promo.get("expires_at_ms") and int(promo["expires_at_ms"]) <= NOW_MS():
        raise ValueError("Срок промокода истёк")
    if promo.get("max_uses") is not None and int(promo.get("used_count") or 0) >= int(promo["max_uses"]):
        raise ValueError("Промокод исчерпан")
    if str(promo.get("period") or "any") not in ("any", period):
        raise ValueError("Промокод не для этого тарифа")
    if user_id is not None and promo_used_by_user(conn, code, int(user_id)):
        raise ValueError("Ты уже использовал этот промокод")
    price = plus_price_kopecks(period)
    if str(promo.get("kind")) == "percent":
        discount = price * int(promo.get("value") or 0) // 100
    else:
        discount = int(promo.get("value") or 0)
    # Скидка — до целых рублей: шлюз выставляет счета в рублях, и копеечный
    # остаток уронил бы создание счёта («тариф не представим»). Округляем
    # ЦЕНУ вниз — скидка получается вверх, в пользу ученика.
    final = max(0, price - discount)
    final = (final // 100) * 100
    discount = price - final
    return {"code": code, "kind": promo["kind"], "value": int(promo.get("value") or 0),
            "period": period, "priceKopecks": price,
            "discountKopecks": price - final, "finalKopecks": final}


def promo_consume(conn: sqlite3.Connection, code: str) -> None:
    """Засчитать использование при успешной активации. Проверка лимита —
    дело quote в момент checkout (платёж чтут, даже если код тем временем
    исчерпался); здесь только счётчик. Присоединяется к чужой транзакции."""
    ensure_promo_schema(conn)
    try:
        code = promo_normalize(code)
    except ValueError:
        return
    conn.execute("UPDATE promo_codes SET used_count=used_count+1 WHERE code=?",
                 (code,))


def _consume_payment_promo(conn: sqlite3.Connection, pay: dict) -> None:
    """Списать промокод платежа при его успешной активации (mock, platega,
    вебхуки — все идут сюда). Без кода в платеже — no-op."""
    try:
        code = (_payload_data(pay) or {}).get("promo")
    except Exception:
        return
    if code:
        promo_consume(conn, code)


def redeem_promo(conn: sqlite3.Connection, user_id: int, code: str,
                 period: str) -> dict:
    """Активация кодом на 100%: счёта и шлюза нет — Plus включается сразу.
    Проверка лимита, правило «один код — один раз на аккаунт» и списание —
    в одной транзакции: два одновременных вызова на последний раз single-use
    кода (или на одного человека) дают одну активацию и одну честную ошибку."""
    ensure_subscription_schema(conn)
    ensure_promo_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    now_ms = NOW_MS()
    own = _begin(conn)
    try:
        quote = promo_quote(conn, code, period, int(user_id))
        if quote["finalKopecks"] != 0:
            raise ValueError("промокод не покрывает всё — оформи счёт со скидкой")
        promo_consume(conn, quote["code"])
        act = _activate_row(conn, int(user_id), period, PROVIDER_PROMO,
                            now_ms, PLUS_ESSAY_LIMIT, PLUS_AGENT_LIMIT,
                            reason="subscription:promo")
        for _ in range(20):
            try:
                cur = conn.execute("""INSERT INTO subscription_payments
                                (user_id, subscription_id, amount_kopecks, currency, period,
                                 status, provider, provider_payment_id, idempotency_key,
                                 public_id, payload_json, created_at_ms, paid_at_ms, promo_code)
                                VALUES (?,?,0,'RUB',?, 'succeeded','promo',NULL,NULL,?,?,?,?,?)""",
                                   (int(user_id), act["subscriptionId"], period,
                                    _new_payment_public_id(),
                                    json.dumps({"promo": quote["code"]}, ensure_ascii=False),
                                    now_ms, now_ms, quote["code"]))
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise ValueError("не удалось записать платёж")
        conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                     (act["subscriptionId"], int(cur.lastrowid)))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "paymentId": None, "amountKopecks": 0,
            "discountKopecks": quote["discountKopecks"], "promo": quote["code"],
            "period": period, "status": PAY_SUCCEEDED, "provider": PROVIDER_PROMO,
            **act}


def admin_bonus(conn: sqlite3.Connection, refs, period: str, note: str = "",
                include_waitlist: bool = False,
                actor: int | None = None) -> dict:
    """Массовая выдача Plus: розыгрыш, условие, компенсация — любой повод
    в note (видно в истории платежей). refs — account_id («a7k29x») или
    числовые id; include_waitlist добавляет ждущих из старого листа ожидания
    (их же помечает выданными, чтобы статистика листа осталась честной).
    Каждому — обычный admin_grant: продления складываются, повтор безопасен."""
    ensure_subscription_schema(conn)
    ensure_plus_waitlist(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    note = str(note or "").strip()[:200] or "bonus"
    raws: list[str] = []
    for r in (refs or []):
        text = str(r or "").strip()
        if text and text not in raws:
            raws.append(text)
    if len(raws) > BONUS_BATCH_MAX:
        raise ValueError(f"получателей больше {BONUS_BATCH_MAX} — разбей на части")
    now_ms = NOW_MS()
    own = _begin(conn)
    granted: list[dict] = []
    skipped: list[dict] = []
    try:
        if include_waitlist:
            rows = conn.execute("SELECT user_id FROM plus_waitlist"
                                " WHERE granted_at_ms IS NULL ORDER BY user_id").fetchall()
            for r in rows:
                try:
                    acc = conn.execute("SELECT account_id FROM users WHERE id=?",
                                       (int(r["user_id"]),)).fetchone()
                except sqlite3.Error:
                    acc = None
                if acc and acc["account_id"] and str(acc["account_id"]) not in raws:
                    raws.append(str(acc["account_id"]))
            # Лимит проверяем и ПОСЛЕ слияния с листом: иначе 400 явных плюс
            # вся очередь в сумме могли бы превысить пачку.
            if len(raws) > BONUS_BATCH_MAX:
                raise ValueError(f"получателей больше {BONUS_BATCH_MAX} — разбей на части")
        pending_wait = {int(r["user_id"]) for r in
                        conn.execute("SELECT user_id FROM plus_waitlist"
                                     " WHERE granted_at_ms IS NULL").fetchall()}
        for ref in raws:
            uid = None
            if ref.isdigit():
                row = conn.execute("SELECT id, account_id FROM users WHERE id=?",
                                   (int(ref),)).fetchone()
            else:
                row = conn.execute("SELECT id, account_id FROM users WHERE account_id=?",
                                   (ref,)).fetchone()
            if not row:
                skipped.append({"ref": ref, "reason": "не найден"})
                continue
            uid = int(row["id"])
            admin_grant(conn, uid, period, note=note, actor=actor)
            if uid in pending_wait:
                conn.execute("UPDATE plus_waitlist SET granted_at_ms=? WHERE user_id=?",
                             (now_ms, uid))
            granted.append({"ref": ref, "userId": uid,
                            "accountId": row["account_id"]})
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "granted": granted, "grantedCount": len(granted),
            "skipped": skipped, "skippedCount": len(skipped),
            "period": period, "note": note}


def subscription_overview(conn: sqlite3.Connection, free_essay: int = 5,
                          free_agent: int = 10) -> dict:
    """Сводка для раздела «Подписка» в админке: люди, деньги, очередь.
    Чистое чтение (кроме ensure схем): безопасно дёргать хоть каждую минуту.

    Деньги считаются только по настоящим платежам (provider не manual/promo):
    ручные гранты и промо-активации — 0₽ и в оборот/средний чек не входят,
    иначе один грант ронял бы средний чек почти до нуля. Возвраты —
    отдельными числами: оборот НЕ уменьшается на возвраты (видно и то,
    и другое)."""
    ensure_subscription_schema(conn)
    ensure_plus_waitlist(conn)
    now_ms = NOW_MS()

    def one(sql, *args):
        try:
            return conn.execute(sql, args).fetchone()
        except sqlite3.Error:
            return None

    def num(row, key="c"):
        try:
            return int((row or {})[key] or 0)
        except (TypeError, ValueError, KeyError):
            return 0

    users_total = num(one("SELECT COUNT(*) AS c FROM users"))
    try:
        onboarded = num(one("SELECT COUNT(DISTINCT user_id) AS c FROM user_subjects"
                            " WHERE onboarded=1"))
    except sqlite3.Error:
        onboarded = 0
    subs_active = num(one("SELECT COUNT(*) AS c FROM subscriptions"
                          " WHERE status IN ('active','cancelled') AND expires_at_ms>?",
                          now_ms))
    subs_no_renew = num(one("SELECT COUNT(*) AS c FROM subscriptions"
                            " WHERE status='cancelled' AND expires_at_ms>?",
                            now_ms))
    subs_expired = num(one("SELECT COUNT(*) AS c FROM subscriptions WHERE status='expired'"))

    money = one("SELECT COUNT(*) AS c, COALESCE(SUM(amount_kopecks),0) AS s"
                " FROM subscription_payments"
                " WHERE status='succeeded' AND provider NOT IN ('manual','promo')") or {}
    try:
        paid_count, revenue = int(money["c"] or 0), int(money["s"] or 0)
    except (TypeError, ValueError, KeyError):
        paid_count, revenue = 0, 0
    grants = num(one("SELECT COUNT(*) AS c FROM subscription_payments"
                     " WHERE status='succeeded' AND provider='manual'"))
    refunds = one("SELECT COUNT(*) AS c, COALESCE(SUM(amount_kopecks),0) AS s"
                  " FROM subscription_payments WHERE status='refunded'") or {}
    try:
        refund_count, refund_sum = int(refunds["c"] or 0), int(refunds["s"] or 0)
    except (TypeError, ValueError, KeyError):
        refund_count, refund_sum = 0, 0
    pending_count = num(one("SELECT COUNT(*) AS c FROM subscription_payments"
                            " WHERE status='pending'"))

    waitlist = launch_waitlist_stats(conn)
    promo_rows = promo_list(conn)
    promo_used = 0
    promo_active = 0
    for pr in promo_rows:
        try:
            promo_used += int(pr.get("used") or 0)
        except (TypeError, ValueError):
            pass
        if pr.get("active"):
            promo_active += 1

    recent = []
    try:
        rows = conn.execute("""SELECT p.amount_kopecks, p.currency, p.period, p.status,
                                      p.provider, p.created_at_ms, p.paid_at_ms,
                                      u.account_id
                               FROM subscription_payments p
                               LEFT JOIN users u ON u.id = p.user_id
                               ORDER BY p.id DESC LIMIT 10""").fetchall()
        for r in rows:
            recent.append({"accountId": r["account_id"],
                           "amountKopecks": r["amount_kopecks"],
                           "currency": r["currency"] or "RUB",
                           "period": r["period"], "status": r["status"],
                           "provider": r["provider"],
                           "createdAt": r["created_at_ms"],
                           "paidAt": r["paid_at_ms"]})
    except sqlite3.Error:
        pass

    return {"ok": True,
            "users": {"total": users_total, "onboarded": onboarded,
                      "plusActive": subs_active,
                      "plusSharePct": round(100 * subs_active / max(1, users_total), 1)},
            "subs": {"active": subs_active, "noRenew": subs_no_renew,
                     "expired": subs_expired},
            "money": {"revenueKopecks": revenue, "paidCount": paid_count,
                      "avgCheckKopecks": (revenue // paid_count) if paid_count else 0,
                      "manualGrants": grants,
                      "refundedCount": refund_count,
                      "refundedKopecks": refund_sum,
                      "pendingCount": pending_count},
            "waitlist": {"total": waitlist["total"], "pending": waitlist["pending"],
                         "granted": waitlist["granted"]},
            "promos": {"total": len(promo_rows), "active": promo_active,
                       "usedTotal": promo_used, "list": promo_rows},
            "config": {"priceMonthKopecks": plus_price_kopecks(PERIOD_MONTH),
                       "priceYearKopecks": plus_price_kopecks(PERIOD_YEAR),
                       "plusEssay": PLUS_ESSAY_LIMIT, "plusAgent": PLUS_AGENT_LIMIT,
                       "freeEssay": free_essay, "freeAgent": free_agent,
                       "agentRequiresPlus": agent_requires_plus()},
            "recent": recent}


# ---------------------------------------------------------------------------
# Platega — настоящий платёжный шлюз (https://app.platega.io, только stdlib).
#
# Поток:
#   * checkout: заводим локальный pending (тот же create_checkout, но
#     provider=platega и provider_payment_id — свежий UUID: шлюз требует id
#     транзакции строго в этом формате), затем ОДИН POST
#     /transaction/process — шлюз возвращает ссылку на оплату (redirect),
#     её кладём в payload_json платежа и отдаём фронту (paymentUrl).
#     Повтор с тем же idempotencyKey денег не трогает: если ссылка уже
#     сохранена — возвращаем её без нового вызова шлюза.
#   * ученик платит на стороне Platega (карты нам не попадают — как и
#     требует приватность); шлюз зовёт наш POST /api/subscription/webhook
#     с заголовками X-MerchantId/X-Secret и телом
#     {id, amount, currency, status, paymentMethod}: CONFIRMED активирует
#     (сумма сверяется со счётом), CANCELED гасит pending без активации.
#     Ответ нужен за 60 с, иначе шлюз повторит ещё 3 раза каждые 5 минут —
#     обработчик только локальная БД, идемпотентен с обеих сторон.
#   * возврат из платёжной страницы (return/failedUrl) — на manage-страницу
#     с ?pay=ok|fail: фронт сам добивает confirm (он для platega опрашивает
#     живой статус GET /transaction/{id} и активирует только CONFIRMED).
#
# Сеть — ровно по одному вызову без ретраев: долбёжка шлюза карается
# рейт-лимитом. Ошибка шлюза/сети — PlategaError (HTTP 503), а не выдуманный
# успех: деньги активируются только по факту от шлюза.
#
# Конфиг окружения:
#   EGE_PLATEGA_MERCHANT_ID / EGE_PLATEGA_SECRET — обязательные;
#   EGE_PLATEGA_METHOD — 2 (СБП/QR), 10 (карты МИР) или 12 (международный);
#   EGE_PLATEGA_BASE_URL — по умолчанию https://app.platega.io;
#   EGE_PLATEGA_TIMEOUT_SEC — таймаут одного вызова (5..30, по умолч. 15).
# ---------------------------------------------------------------------------

PLATEGA_METHODS = (2, 10, 12)


class PlategaError(RuntimeError):
    """Шлюз недоступен или отклонил запрос. HTTP-маппинг — 503."""


def platega_config() -> dict | None:
    """Конфиг шлюза из окружения. None — не настроен (checkout честно
    отвечает 503 с текстом про недоступность оплаты)."""
    merchant = (os.environ.get("EGE_PLATEGA_MERCHANT_ID") or "").strip()
    secret = (os.environ.get("EGE_PLATEGA_SECRET") or "").strip()
    if not merchant or not secret:
        return None
    try:
        method = int((os.environ.get("EGE_PLATEGA_METHOD") or "2").strip())
    except (TypeError, ValueError):
        method = 2
    if method not in PLATEGA_METHODS:
        method = 2
    base = (os.environ.get("EGE_PLATEGA_BASE_URL")
            or "https://app.platega.io").strip().rstrip("/")
    if not base.lower().startswith(("http://", "https://")):
        base = "https://app.platega.io"
    timeout = _env_int("EGE_PLATEGA_TIMEOUT_SEC", 15, 5)
    return {"merchant_id": merchant, "secret": secret, "base": base,
            "method": method, "timeout": min(30, timeout)}


def platega_enabled() -> bool:
    return platega_config() is not None


def _platega_error_text(raw: str) -> str:
    """Человеческий текст из ответа шлюза ({"message": ...}), обрезанный."""
    try:
        data = json.loads(raw or "")
        msg = str((data or {}).get("message") or "").strip()
        return msg[:200] if msg else ""
    except (ValueError, TypeError, AttributeError):
        return (raw or "")[:200]


def _platega_http(cfg: dict, method: str, path: str,
                  body: dict | None = None) -> dict:
    """Один вызов API шлюза. Без ретраев: повторный платёж заводит дубли."""
    url = cfg["base"] + path
    data = (json.dumps(body, ensure_ascii=False).encode("utf-8")
            if body is not None else None)
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json",
                 "Accept": "application/json",
                 "X-MerchantId": cfg["merchant_id"],
                 "X-Secret": cfg["secret"]})
    try:
        with urllib.request.urlopen(req, timeout=cfg["timeout"]) as resp:
            raw = resp.read(65536)
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read(2048).decode("utf-8", "replace")
        except Exception:
            detail = ""
        raise PlategaError(_platega_error_text(detail)
                           or f"шлюз ответил HTTP {exc.code}")
    except Exception as exc:
        raise PlategaError(f"шлюз недоступен ({type(exc).__name__})")
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        raise PlategaError("шлюз вернул не-JSON")
    if not isinstance(parsed, dict):
        raise PlategaError("шлюз вернул не-объект")
    return parsed


def platega_create_transaction(cfg: dict, txn_id: str, amount_rub: int,
                               description: str, return_url: str,
                               failed_url: str, payload: str) -> dict:
    """Создать транзакцию в шлюзе. Один вызов — один счёт."""
    resp = _platega_http(cfg, "POST", "/transaction/process", {
        "paymentMethod": cfg["method"], "id": txn_id,
        "paymentDetails": {"amount": int(amount_rub), "currency": "RUB"},
        "description": str(description)[:200],
        "return": return_url, "failedUrl": failed_url,
        "payload": str(payload)[:128]})
    redirect = resp.get("redirect")
    if not redirect or not isinstance(redirect, str):
        raise PlategaError("шлюз не вернул ссылку на оплату")
    return {"redirect": redirect,
            "status": str(resp.get("status") or "PENDING"),
            "transactionId": str(resp.get("transactionId") or txn_id)}


def platega_fetch_status(cfg: dict, txn_id: str) -> str:
    """Живой статус транзакции: PENDING/CONFIRMЕD/EXPIRED/CANCELED/FAILED."""
    resp = _platega_http(cfg, "GET", "/transaction/" + str(txn_id))
    return str(resp.get("status") or "").strip().upper()


def _payload_data(pay: dict) -> dict:
    try:
        data = json.loads(pay.get("payload_json") or "{}")
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def create_platega_checkout(conn: sqlite3.Connection, user_id: int,
                            period: str,
                            idempotency_key: str | None = None,
                            return_url: str = "",
                            failed_url: str = "",
                            promo_code: str | None = None) -> dict:
    """Настоящий checkout: локальный pending + счёт в шлюзе.

    Идемпотентен по ключу вместе с базовым create_checkout; ссылку шлюза
    создаёт один раз и хранит в payload_json: повтор отдаёт сохранённую
    без нового вызова. Счёт в шлюзе не создан (сеть легла) — pending живёт
    для повтора тем же ключом, деньги никуда не ушли. Счёт выставляется на
    записанную в платеже сумму (уже со скидкой, если был промокод);
    код на 100% шлюза не касается — Plus уже активен."""
    cfg = platega_config()
    if cfg is None:
        raise PermissionError("оплата не настроена")
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    created = create_checkout(conn, int(user_id), period,
                              PROVIDER_PLATEGA, idempotency_key, promo_code)
    if created.get("status") == PAY_SUCCEEDED:
        return created
    amount_kop = int(created.get("amountKopecks") or 0)
    if amount_kop <= 0 or amount_kop % 100:
        raise ValueError("тариф не представим в рублях для шлюза")
    row = conn.execute("SELECT * FROM subscription_payments WHERE public_id=?",
                       (created["paymentId"],)).fetchone()
    pay = _row_to_dict(row)
    if not pay:
        raise KeyError("payment not found")
    stored = _payload_data(pay)
    if stored.get("paymentUrl"):
        created["paymentUrl"] = stored["paymentUrl"]
        return created
    made = platega_create_transaction(
        cfg, str(pay.get("provider_payment_id")), amount_kop // 100,
        f"ege easy Plus · {'год' if period == PERIOD_YEAR else 'месяц'}",
        return_url, failed_url, str(created["paymentId"]))
    stored["paymentUrl"] = made["redirect"]
    stored["plategaStatus"] = made["status"]
    own = _begin(conn)
    try:
        conn.execute("UPDATE subscription_payments SET payload_json=? WHERE id=?",
                     (json.dumps(stored, ensure_ascii=False)[:4000],
                      int(pay["id"])))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    created["paymentUrl"] = made["redirect"]
    return created


def _resolve_payment(conn: sqlite3.Connection, payment_ref,
                     expected_user_id: int | None = None) -> dict | None:
    """Найти платёж по int id (только с владельцем), public_id или
    provider_payment_id. Владельца НЕ проверяет — это дело вызывателя."""
    ensure_subscription_schema(conn)
    if isinstance(payment_ref, bool):
        return None
    if isinstance(payment_ref, int) or str(payment_ref).isdigit():
        if expected_user_id is None:
            return None
        row = conn.execute("SELECT * FROM subscription_payments WHERE id=?",
                           (int(payment_ref),)).fetchone()
    elif is_payment_public_id(payment_ref):
        row = conn.execute("SELECT * FROM subscription_payments WHERE public_id=?",
                           (payment_ref,)).fetchone()
    elif isinstance(payment_ref, str) and payment_ref.strip():
        row = conn.execute("SELECT * FROM subscription_payments"
                           " WHERE provider_payment_id=?",
                           (payment_ref.strip(),)).fetchone()
    else:
        return None
    return _row_to_dict(row)


def _confirm_platega(conn: sqlite3.Connection, pay: dict) -> dict:
    """Подтверждение platega-платежа: только по живому статусу шлюза.
    CONFIRMED — активация (продления складываются, как у mock);
    CANCELED/EXPIRED/FAILED — строка гасится, клиенту честный текст;
    PENDING — «оплата ещё не прошла», срока не двигаем."""
    cfg = platega_config()
    if cfg is None:
        raise PermissionError("оплата не настроена")
    if pay.get("status") == PAY_SUCCEEDED:
        sub = get_subscription(conn, int(pay["user_id"]))
        return {"ok": True, "already": True,
                "paymentId": pay.get("public_id"), "status": PAY_SUCCEEDED,
                "expiresAt": (sub or {}).get("expires_at_ms")}
    if pay.get("status") != PAY_PENDING:
        raise ValueError(f"платёж уже {pay.get('status')}, подтвердить нельзя")
    live = platega_fetch_status(cfg, str(pay.get("provider_payment_id")))
    now_ms = NOW_MS()
    if live == "CONFIRMED":
        own = _begin(conn)
        try:
            conn.execute("UPDATE subscription_payments SET status=?, paid_at_ms=?"
                         " WHERE id=?",
                         (PAY_SUCCEEDED, now_ms, int(pay["id"])))
            _consume_payment_promo(conn, pay)
            act = _activate_row(conn, int(pay["user_id"]), str(pay.get("period")),
                                PROVIDER_PLATEGA, now_ms,
                                PLUS_ESSAY_LIMIT, PLUS_AGENT_LIMIT)
            conn.execute("UPDATE subscription_payments SET subscription_id=?"
                         " WHERE id=?", (act["subscriptionId"], int(pay["id"])))
            _end(conn, own, True)
        except Exception:
            _end(conn, own, False)
            raise
        return {"ok": True, "already": False, "paymentId": pay.get("public_id"),
                "status": PAY_SUCCEEDED, **act}
    if live in ("CANCELED", "EXPIRED", "FAILED"):
        own = _begin(conn)
        try:
            conn.execute("UPDATE subscription_payments SET status=? WHERE id=?",
                         (PAY_CANCELLED if live == "CANCELED" else PAY_FAILED,
                          int(pay["id"])))
            _end(conn, own, True)
        except Exception:
            _end(conn, own, False)
            raise
        raise ValueError("платёж отменён" if live == "CANCELED"
                         else "срок оплаты истёк")
    raise ValueError("оплата ещё не прошла")


def cancel_pending_payment(conn: sqlite3.Connection, user_id: int,
                           payment_ref) -> dict:
    """Отменить свой неоплаченный счёт (передумал / дубль / завис).
    Только чужой pending и только владелец: чужой неотличим от
    несуществующего (404). Повторная отмена своего счёта — идемпотентный
    успех (already), а не 400: двойной клик и повтор вебхука не должны
    выглядеть ошибкой. Успешный/возвращённый трогать нельзя —
    это деньги, их путь только через админский возврат."""
    ensure_subscription_schema(conn)
    pay = _resolve_payment(conn, payment_ref, user_id)
    if not pay:
        raise KeyError("payment not found")
    if int(pay.get("user_id") or 0) != int(user_id):
        raise KeyError("payment not found")
    if pay.get("status") == PAY_CANCELLED:
        return {"ok": True, "already": True, "paymentId": pay.get("public_id"),
                "status": PAY_CANCELLED}
    if pay.get("status") != PAY_PENDING:
        raise ValueError("отменить можно только неоплаченный счёт")
    own = _begin(conn)
    try:
        conn.execute("UPDATE subscription_payments SET status=? WHERE id=?",
                     (PAY_CANCELLED, int(pay["id"])))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "paymentId": pay.get("public_id"),
            "status": PAY_CANCELLED}


def confirm_resolved(conn: sqlite3.Connection, payment_ref,
                     expected_user_id: int | None = None) -> dict:
    """Подтвердить платёж любого провайдера по его строке: mock — как раньше
    (только с EGE_SUBSCRIPTION_MOCK=1), platega — по живому статусу шлюза.
    Чужой платёж неотличим от несуществующего (404), как у confirm_payment."""
    pay = _resolve_payment(conn, payment_ref, expected_user_id)
    if not pay:
        raise KeyError("payment not found")
    if (expected_user_id is not None
            and int(pay.get("user_id") or 0) != int(expected_user_id)):
        raise KeyError("payment not found")
    provider = str(pay.get("provider") or "")
    if provider == PROVIDER_MOCK:
        return confirm_payment(conn, payment_ref, PROVIDER_MOCK,
                               PLUS_ESSAY_LIMIT, PLUS_AGENT_LIMIT,
                               expected_user_id)
    if provider == PROVIDER_PLATEGA:
        return _confirm_platega(conn, pay)
    raise ValueError("такой платёж подтвердить нельзя")


def platega_webhook_auth(given_merchant: str, given_secret: str) -> bool:
    """Сверка заголовков callback (X-MerchantId/X-Secret) с нашим конфигом.
    Байтами через compare_digest: кривая подпись — False, а не исключение."""
    cfg = platega_config()
    if cfg is None:
        return False
    try:
        mid_ok = hmac.compare_digest(
            cfg["merchant_id"].encode("ascii"),
            (given_merchant or "").strip().encode("ascii"))
        sec_ok = hmac.compare_digest(
            cfg["secret"].encode("ascii"),
            (given_secret or "").strip().encode("ascii"))
    except (AttributeError, ValueError, UnicodeEncodeError):
        return False
    return bool(mid_ok and sec_ok)


def _platega_amount_kop(amount) -> int | None:
    if isinstance(amount, bool):
        return None
    try:
        return int(round(float(str(amount).strip().replace(",", ".")) * 100))
    except (TypeError, ValueError, OverflowError):
        return None


def platega_webhook(conn: sqlite3.Connection, txn_id: str, status: str,
                    amount=None, currency=None) -> dict:
    """Входящий callback шлюза (авторизация уже проверена вызывателем).
    Сети не требует: находит наш pending по id транзакции, сверяет сумму
    со счётом и активирует. Повтор CONFIRMED — идемпотентный no-op;
    опоздавший CANCELED по уже успешному платежу доступ НЕ гасит
    (возвраты — только через админку)."""
    ensure_subscription_schema(conn)
    if not isinstance(txn_id, str) or not txn_id.strip():
        raise ValueError("нужен id транзакции")
    status = str(status or "").strip().upper()
    if status not in ("CONFIRMED", "CANCELED"):
        raise ValueError("неизвестный статус вебхука")
    pay = _row_to_dict(conn.execute(
        "SELECT * FROM subscription_payments WHERE provider_payment_id=?",
        (txn_id.strip(),)).fetchone())
    if not pay or str(pay.get("provider") or "") != PROVIDER_PLATEGA:
        raise KeyError("payment not found")
    if currency is not None and str(currency or "").strip().upper() not in ("RUB", "RUR"):
        raise ValueError("валюта платежа не RUB")
    if amount is not None:
        try:
            have = int(pay.get("amount_kopecks") or 0)
        except (TypeError, ValueError):
            have = 0
        want = _platega_amount_kop(amount)
        # Шлюз кладёт свою комиссию поверх номинала (5₽ → 5.35, 199₽ →
        # 212.93), поэтому требуем не копейку в копейку, а диапазон:
        # не меньше счёта и не выше счёта +25%. Недоплата и чужой счёт
        # по-прежнему не активируют.
        if want is None or want < have or want * 100 > have * 125:
            raise ValueError("сумма платежа не совпадает со счётом")
    now_ms = NOW_MS()
    if pay.get("status") == PAY_SUCCEEDED:
        sub = get_subscription(conn, int(pay["user_id"]))
        return {"ok": True, "already": True, "paymentId": pay.get("public_id"),
                "status": PAY_SUCCEEDED,
                "expiresAt": (sub or {}).get("expires_at_ms")}
    if status == "CONFIRMED":
        if pay.get("status") != PAY_PENDING:
            raise ValueError(f"платёж уже {pay.get('status')}, подтвердить нельзя")
        own = _begin(conn)
        try:
            conn.execute("UPDATE subscription_payments SET status=?, paid_at_ms=?"
                         " WHERE id=?",
                         (PAY_SUCCEEDED, now_ms, int(pay["id"])))
            _consume_payment_promo(conn, pay)
            act = _activate_row(conn, int(pay["user_id"]), str(pay.get("period")),
                                PROVIDER_PLATEGA, now_ms,
                                PLUS_ESSAY_LIMIT, PLUS_AGENT_LIMIT,
                                reason="subscription:platega")
            conn.execute("UPDATE subscription_payments SET subscription_id=?"
                         " WHERE id=?", (act["subscriptionId"], int(pay["id"])))
            _end(conn, own, True)
        except Exception:
            _end(conn, own, False)
            raise
        return {"ok": True, "already": False, "paymentId": pay.get("public_id"),
                "status": PAY_SUCCEEDED, **act}
    own = _begin(conn)
    try:
        if pay.get("status") == PAY_PENDING:
            conn.execute("UPDATE subscription_payments SET status=? WHERE id=?",
                         (PAY_CANCELLED, int(pay["id"])))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "paymentId": pay.get("public_id"), "status": PAY_CANCELLED}
