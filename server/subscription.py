"""Подписка ege easy Plus: тариф, сроки, платежи, продление.

Самодостаточный модуль (только stdlib): схема SQLite, чтение статуса и
транзакционные мутаторы. Ничего не знает про HTTP, провайдеров ИИ и
админку — сервер вызывает его из route-обработчиков.

Модель:
  * тариф один — ``plus``; период ``month`` (30 суток, 99₽) или ``year``
    (365 суток, 990₽). Цены и длительности переопределяются окружением
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
import secrets
import sqlite3
import time

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

# Уровни Plus: проверки сочинений 5 -> 20 в день, ходы наставника 10 -> 40.
PLUS_ESSAY_LIMIT = 20
PLUS_AGENT_LIMIT = 40


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(float(os.environ.get(name) or default)))
    except (TypeError, ValueError):
        return default


def plus_price_kopecks(period: str) -> int:
    if period == PERIOD_YEAR:
        return _env_int("EGE_PLUS_PRICE_YEAR_KOP", 99000)
    return _env_int("EGE_PLUS_PRICE_MONTH_KOP", 9900)


def plus_period_ms(period: str) -> int:
    if period == PERIOD_YEAR:
        return _env_int("EGE_PLUS_YEAR_SEC", 365 * 24 * 3600) * 1000
    return _env_int("EGE_PLUS_MONTH_SEC", 30 * 24 * 3600) * 1000


def subscription_mock_enabled() -> bool:
    return (os.environ.get("EGE_SUBSCRIPTION_MOCK") or "").strip() == "1"


def webhook_secret() -> str:
    return (os.environ.get("EGE_SUBSCRIPTION_WEBHOOK_SECRET") or "").strip()


def agent_requires_plus() -> bool:
    """Флаг будущего «наставник только по подписке».

    Выключен по умолчанию: текущие бесплатные пользователи ничего не
    теряют, Plus только поднимает потолки. Когда продукт будет готов
    закрыть наставника для бесплатного тарифа — один флаг, без правок
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
          paid_at_ms INTEGER
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sub_payments_user"
                 " ON subscription_payments(user_id)")
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
          timer_ms INTEGER
        )""")


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
    """Доступен ли раздел наставника. Пока флаг выключен — всем
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
        return {"ok": True, "plan": None, "active": False, "status": None,
                "period": None, "startedAt": None, "expiresAt": None,
                "cancelAtPeriodEnd": False,
                "limits": {"essay": None, "agent": None, "agentAccess": True}}
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
                    agent_limit: int, now_ms: int) -> None:
    """Долить карманы до полного при активации: «лимиты уже увеличены».
    Трогаем только аккаунтные бакеты (u:/agent:); device-бакеты антиабуза
    не трогаем сознательно — иначе одна покупка отмывала бы ферму."""
    ensure_ai_usage_table(conn)
    conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms)"
                 " VALUES (?,?,NULL)", (f"u:{int(user_id)}", essay_limit))
    conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL WHERE owner=?",
                 (essay_limit, f"u:{int(user_id)}"))
    conn.execute("INSERT OR IGNORE INTO ai_usage (owner, count, timer_ms)"
                 " VALUES (?,?,NULL)", (f"agent:{int(user_id)}", agent_limit))
    conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL WHERE owner=?",
                 (agent_limit, f"agent:{int(user_id)}"))


def _activate_row(conn: sqlite3.Connection, user_id: int, period: str,
                  provider: str, now_ms: int, essay_limit: int,
                  agent_limit: int, external_id: str | None = None) -> dict:
    """Создать/продлить строку подписки. Продления складываются:
    expires растёт от max(now, expires), а не перезаписывается."""
    ensure_subscription_schema(conn)
    sub = get_subscription(conn, user_id)
    duration = plus_period_ms(period)
    if sub and sub.get("status") in (STATUS_ACTIVE, STATUS_CANCELLED):
        base = max(int(sub.get("expires_at_ms") or 0), now_ms)
        expires = base + duration
        started = int(sub.get("started_at_ms") or now_ms)
    else:
        started, expires = now_ms, now_ms + duration
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
    _top_up_buckets(conn, user_id, essay_limit, agent_limit, now_ms)
    return {"subscriptionId": sub_id, "expiresAt": expires, "startedAt": started}


def create_checkout(conn: sqlite3.Connection, user_id: int, period: str,
                    provider: str = PROVIDER_MOCK,
                    idempotency_key: str | None = None) -> dict:
    """Создать pending-платёж. С идемпотентным ключом повтор возвращает тот
    же платёж, а не заводит дубль. Своя транзакция."""
    ensure_subscription_schema(conn)
    if period not in PERIODS:
        raise ValueError("period должен быть month или year")
    if provider not in (PROVIDER_MOCK, PROVIDER_MANUAL):
        raise ValueError("provider не поддерживается")
    if idempotency_key is not None and not isinstance(idempotency_key, str):
        raise ValueError("idempotency_key должен быть строкой")
    key = (idempotency_key or "").strip() or None
    if key and len(key) > 128:
        raise ValueError("idempotency_key слишком длинный")
    if not conn.execute("SELECT id FROM users WHERE id=?", (int(user_id),)).fetchone():
        raise KeyError("user not found")
    now_ms = NOW_MS()
    amount = plus_price_kopecks(period)
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
        provider_payment_id = f"{provider}_{secrets.token_hex(12)}"
        cur = conn.execute("""INSERT INTO subscription_payments
                        (user_id, subscription_id, amount_kopecks, currency, period,
                         status, provider, provider_payment_id, idempotency_key,
                         payload_json, created_at_ms, paid_at_ms)
                        VALUES (?,NULL,?,'RUB',?, 'pending',?,?,?, '{}',?,NULL)""",
                     (int(user_id), amount, period, provider,
                      provider_payment_id, key, now_ms))
        pid = int(cur.lastrowid)
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "paymentId": pid, "providerPaymentId": provider_payment_id,
            "amountKopecks": amount, "currency": "RUB", "period": period,
            "status": PAY_PENDING, "provider": provider, "mock": provider == PROVIDER_MOCK}


def confirm_payment(conn: sqlite3.Connection, payment_ref: int | str,
                    provider: str = PROVIDER_MOCK,
                    essay_limit: int = PLUS_ESSAY_LIMIT,
                    agent_limit: int = PLUS_AGENT_LIMIT) -> dict:
    """Подтвердить платёж и активировать/продлить подписку. Повторный вызов
    по тому же платежу — идемпотентный no-op (срок дважды не растёт).
    Mock-подтверждения запрещены без EGE_SUBSCRIPTION_MOCK=1."""
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
            row = conn.execute("SELECT * FROM subscription_payments WHERE id=?",
                               (int(payment_ref),)).fetchone()
        else:
            row = conn.execute("SELECT * FROM subscription_payments WHERE provider_payment_id=?",
                               (str(payment_ref),)).fetchone()
        pay = _row_to_dict(row)
        if not pay:
            raise KeyError("payment not found")
        if pay.get("provider") != provider:
            raise ValueError("provider не совпадает с платежом")
        if pay.get("status") == PAY_SUCCEEDED:
            _end(conn, own, True)
            sub = get_subscription(conn, int(pay["user_id"]))
            return {"ok": True, "already": True,
                    "paymentId": int(pay["id"]), "status": PAY_SUCCEEDED,
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
        act = _activate_row(conn, int(pay["user_id"]), str(pay.get("period")),
                            provider, now_ms, essay_limit, agent_limit)
        conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                     (act["subscriptionId"], int(pay["id"])))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "already": False, "paymentId": int(pay["id"]),
            "status": PAY_SUCCEEDED, **act}


def _payment_payload(pay: dict) -> dict:
    return {"ok": True, "paymentId": int(pay["id"]),
            "providerPaymentId": pay.get("provider_payment_id"),
            "amountKopecks": int(pay.get("amount_kopecks") or 0),
            "currency": pay.get("currency") or "RUB",
            "period": pay.get("period"), "status": pay.get("status"),
            "provider": pay.get("provider"),
            "mock": pay.get("provider") == PROVIDER_MOCK}


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
                act = _activate_row(conn, int(pay["user_id"]), period, str(pay.get("provider")),
                                    now_ms, essay_limit, agent_limit)
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
        cur = conn.execute("""INSERT INTO subscription_payments
                        (user_id, subscription_id, amount_kopecks, currency, period,
                         status, provider, provider_payment_id, idempotency_key,
                         payload_json, created_at_ms, paid_at_ms)
                        VALUES (?,NULL,?,'RUB',?, 'succeeded',?,?,NULL,'{}',?,?)""",
                     (int(user_id), int(amount_kopecks), period, provider,
                      provider_payment_id, now_ms, now_ms))
        pid = int(cur.lastrowid)
        act = _activate_row(conn, int(user_id), period, provider, now_ms,
                            essay_limit, agent_limit)
        conn.execute("UPDATE subscription_payments SET subscription_id=? WHERE id=?",
                     (act["subscriptionId"], pid))
        _end(conn, own, True)
    except Exception:
        _end(conn, own, False)
        raise
    return {"ok": True, "already": False, "paymentId": pid, **act}


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
                note: str = "") -> dict:
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
                            now_ms, essay_limit, agent_limit)
        conn.execute("""INSERT INTO subscription_payments
                        (user_id, subscription_id, amount_kopecks, currency, period,
                         status, provider, provider_payment_id, idempotency_key,
                         payload_json, created_at_ms, paid_at_ms)
                        VALUES (?,?,0,'RUB',?, 'succeeded','manual',NULL,NULL,?,?,?)""",
                     (int(user_id), act["subscriptionId"], period,
                      json.dumps({"note": str(note)[:200]}, ensure_ascii=False),
                      now_ms, now_ms))
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
                 payment_id: int | None = None,
                 now_ms: int | None = None) -> dict:
    """Возврат денег: помечает платёж refunded и гасит подписку (возврат без
    отзыва доступа — это подарок, а не возврат). Без payment_id берётся
    последний успешный платёж; явный id обязан быть succeeded — повторный
    возврат того же платежа невозможен. История хранит refunded вечно:
    деньги видны в аудите как возвращённые, а не как доход."""
    ensure_subscription_schema(conn)
    now_ms = int(now_ms) if now_ms is not None else NOW_MS()
    if payment_id is not None:
        if isinstance(payment_id, bool):
            raise ValueError("paymentId должен быть числом")
        try:
            payment_id = int(payment_id)
        except (TypeError, ValueError):
            raise ValueError("paymentId должен быть числом")
    own = _begin(conn)
    try:
        if payment_id is None:
            row = conn.execute("""SELECT * FROM subscription_payments
                                  WHERE user_id=? AND status=?
                                  ORDER BY id DESC LIMIT 1""",
                               (int(user_id), PAY_SUCCEEDED)).fetchone()
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
    rows = conn.execute("""SELECT id, amount_kopecks, currency, period, status,
                                  provider, provider_payment_id, created_at_ms, paid_at_ms
                           FROM subscription_payments WHERE user_id=?
                           ORDER BY id DESC LIMIT ? OFFSET ?""",
                        (int(user_id), limit, offset)).fetchall()
    total = conn.execute("SELECT COUNT(*) AS c FROM subscription_payments WHERE user_id=?",
                         (int(user_id),)).fetchone()
    items = [{"id": r["id"], "amountKopecks": r["amount_kopecks"],
              "currency": r["currency"], "period": r["period"], "status": r["status"],
              "provider": r["provider"],
              "providerPaymentId": r["provider_payment_id"],
              "createdAt": r["created_at_ms"], "paidAt": r["paid_at_ms"]}
             for r in rows]
    return {"ok": True, "payments": items,
            "total": int(total["c"]) if total else 0,
            "limit": limit, "offset": offset}
