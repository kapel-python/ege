#!/usr/bin/env python3
"""Журнал начислений/трат квот (сочинения + ходы ИИ + котлы устройств).

ОДНА таблица `quota_ledger` на оба продукта: механика зарядки общая
(server/chain_quota.py), бакеты общие (ai_usage), владельцы различаются
только префиксом (`u:` — сочинения, `agent:` — ходы ИИ, `k:/n:` и `ak:/an:` —
котлы устройства). Каждая строка — одно изменение бакета: сколько было,
сколько стало, кто и почему.

Что хранится в строке (всё нужное для разбора «почему у меня 8 из 10»):
  owner         — бакет (`agent:1037`, `u:1037`, `ak:<hmac>`, ...);
  user_id       — владелец аккаунтного бакета (у котлов NULL: котёл общий);
  kind          — spend | refund | accrue | init | admin | topup | bonus |
                  cap | chain_start;
  reason        — контекст: 'agent:turn', 'essay:check', 'agent:status',
                  'admin:ai_limit', 'subscription:grant', ...;
  delta         — подписанное изменение (+3, -1);
  count_before / count_after — остаток до и после;
  quota_limit   — действовавший потолок;
  timer_ms / anchor_ms — состояние цепочки ПОСЛЕ изменения (по ним видно,
                  когда следующий тик);
  actor_user_id — кто вызвал изменение (ученик — свой id, админ — свой;
                  у refund котлов — тот, чья неудача вернула жетон);
  meta_json     — пара мелочей: номер тика, полный/неполный, payload админа.

Как писать: только через log_event()/log_catch_up() и только ВНУТРИ
транзакции вызывателя (до его commit): откат вызывателя (пустой котёл,
неудача) стирает и строку журнала — фантомных записей нет. Функции
никогда не бросают: журнал вспомогательный, ход/проверка из-за него
падать не должны.

Чтение: read_entries() — последние записи по пользователю (свои бакеты +
то, что он нагрел/вернул в котлах) или по конкретному owner (для админа:
так видно, КТО выел общий котёл). Хранится только диагностика: сырых
кук/IP здесь нет (в owner лежат те же HMAC, что в ai_usage).

Удержание: не больше LEDGER_KEEP_PER_OWNER строк на бакет и не старше
LEDGER_TTL_DAYS — чистка при каждой записи (два дешёвых DELETE рядом
с INSERT, отдельных фоновых потоков нет).
"""
from __future__ import annotations

import json
import sqlite3
import time

# Сколько последних записей храним на бакет: хватает на месяцы обычных
# трат (10 ходов/день = 300 строк/мес с тиками), а ферму с тысячами
# записей всё равно режем — ей журнал не положен.
LEDGER_KEEP_PER_OWNER = 2000
# Старше полугода записи не нужны: цепочка живёт сутки, споры — недели.
LEDGER_TTL_DAYS = 180

KINDS = frozenset({
    "spend",       # резерв жетона (ход ИИ / проверка сочинения)
    "refund",      # возврат при неуспехе
    "accrue",      # ленивая зарядка тиками (+N к остатку)
    "init",        # бакет заведён (первое появление, карман полон)
    "admin",       # ручная правка из карточки пользователя
    "topup",       # доливка при покупке/гранте Plus (только вверх)
    "bonus",       # бонусный жетон за долгое ожидание
    "cap",         # остаток срезан к пониженному потолку
    "chain_start",  # цепочка стартовала на «призраке» (остаток без таймера)
})


def ensure_quota_ledger_schema(conn: sqlite3.Connection) -> None:
    """Таблица журнала + индексы. Идемпотентно, без коммита (за вызывателем)."""
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS quota_ledger (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at_ms INTEGER NOT NULL,
              owner TEXT NOT NULL,
              user_id INTEGER,
              kind TEXT NOT NULL,
              reason TEXT NOT NULL DEFAULT '',
              delta INTEGER NOT NULL DEFAULT 0,
              count_before INTEGER,
              count_after INTEGER,
              quota_limit INTEGER,
              timer_ms INTEGER,
              anchor_ms INTEGER,
              actor_user_id INTEGER,
              meta_json TEXT NOT NULL DEFAULT '{}')""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_quota_ledger_owner"
                     " ON quota_ledger(owner, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_quota_ledger_user"
                     " ON quota_ledger(user_id, created_at_ms)")
    except sqlite3.Error:
        pass


def owner_user_id(owner: str) -> int | None:
    """Аккаунт из владельца бакета: agent:<id> / u:<id>. У котлов — None."""
    try:
        text = str(owner or "")
    except Exception:
        return None
    if text.startswith("agent:") or (text.startswith("u:")
                                     and not text.startswith("u_")):
        try:
            value = int(text.split(":", 1)[1])
        except (TypeError, ValueError, IndexError):
            return None
        return value if value > 0 else None
    return None


def product_of(owner: str) -> str:
    """Продукт бакета человеческими словами (для чтения журнала)."""
    text = str(owner or "")
    if text.startswith("agent:"):
        return "agent"
    if text.startswith("u:"):
        return "essay"
    if text.startswith("ak:"):
        return "device_cookie"
    if text.startswith("an:"):
        return "device_net"
    if text.startswith("k:"):
        return "essay_cookie"
    if text.startswith("n:"):
        return "essay_net"
    return "unknown"


def _prune(conn: sqlite3.Connection, owner: str, now_ms: int) -> None:
    """Кап по числу + возрасту на бакет. Не бросает."""
    try:
        conn.execute(
            "DELETE FROM quota_ledger WHERE owner=? AND id NOT IN "
            "(SELECT id FROM quota_ledger WHERE owner=? "
            "ORDER BY id DESC LIMIT ?)",
            (owner, owner, LEDGER_KEEP_PER_OWNER))
    except sqlite3.Error:
        pass
    try:
        cutoff = int(now_ms) - LEDGER_TTL_DAYS * 86400 * 1000
        conn.execute("DELETE FROM quota_ledger WHERE owner=? AND created_at_ms<?",
                     (owner, cutoff))
    except sqlite3.Error:
        pass


def log_event(conn: sqlite3.Connection, *, owner: str, kind: str,
              reason: str = "", delta: int = 0,
              count_before: int | None = None,
              count_after: int | None = None,
              limit: int | None = None,
              timer_ms: int | None = None,
              anchor_ms: int | None = None,
              actor: int | None = None,
              meta: dict | None = None,
              now_ms: int | None = None) -> int | None:
    """Записать строку журнала. Возвращает id строки или None.

    Никогда не бросает и ничего не коммитит: вызывается внутри транзакции
    менятеля бакета, откат стирает и запись. Неизвестный kind не пишем
    (опечатка в вызывателе не должна мусорить в таблицу).
    """
    if kind not in KINDS:
        return None
    try:
        text_owner = str(owner or "")
    except Exception:
        return None
    if not text_owner:
        return None
    try:
        moment = int(now_ms) if now_ms is not None else int(time.time() * 1000)
    except (TypeError, ValueError):
        moment = int(time.time() * 1000)
    try:
        clean_delta = int(delta)
    except (TypeError, ValueError):
        clean_delta = 0
    try:
        meta_blob = json.dumps(dict(meta or {}), ensure_ascii=False)[:2000]
    except (TypeError, ValueError):
        meta_blob = "{}"
    try:
        ensure_quota_ledger_schema(conn)
        cur = conn.execute(
            "INSERT INTO quota_ledger(created_at_ms, owner, user_id, kind, reason,"
            " delta, count_before, count_after, quota_limit, timer_ms, anchor_ms,"
            " actor_user_id, meta_json)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (moment, text_owner, owner_user_id(text_owner), kind,
             str(reason or "")[:128], clean_delta, count_before, count_after,
             limit, timer_ms, anchor_ms, actor, meta_blob))
        row_id = int(cur.lastrowid)
    except (sqlite3.Error, TypeError, ValueError):
        return None
    _prune(conn, text_owner, moment)
    return row_id


def log_catch_up(conn: sqlite3.Connection, info: dict | None, *,
                 owner: str, limit: int, reason: str,
                 actor: int | None = None,
                 now_ms: int | None = None) -> int | None:
    """Залогировать итог chain_quota.catch_up(). info — его возврат
    (None = ничего не изменилось, писать нечего). Маппинг:
    accrue → kind accrue, cap → kind cap, chain_start → kind chain_start."""
    if not isinstance(info, dict) or not info.get("applied"):
        return None
    applied = str(info.get("applied") or "")
    mapping = {"accrue": "accrue", "cap": "cap", "chain_start": "chain_start"}
    kind = mapping.get(applied)
    if kind is None:
        return None
    meta = {"ticks_total": info.get("ticks_total"),
            "ticks_done": info.get("ticks_done"),
            "full": bool(info.get("full"))} if applied == "accrue" else None
    try:
        delta = int(info.get("inc", 0) or 0)
    except (TypeError, ValueError):
        delta = 0
    if applied == "cap":
        try:
            delta = int(info.get("count_after", 0) or 0) - int(info.get("count_before", 0) or 0)
        except (TypeError, ValueError):
            delta = 0
    # Состояние цепочки после изменения: catch_up пишет timer/anchor,
    # забираем их из базы, а не из арифметики в голове.
    timer_after = anchor_after = None
    try:
        row = conn.execute("SELECT timer_ms, anchor_ms FROM ai_usage WHERE owner=?",
                           (str(owner),)).fetchone()
        if row:
            timer_after = row["timer_ms"] if row["timer_ms"] is not None else None
            try:
                anchor_after = row["anchor_ms"]
            except (KeyError, IndexError):
                anchor_after = None
    except sqlite3.Error:
        pass
    return log_event(conn, owner=owner, kind=kind, reason=reason,
                     delta=delta,
                     count_before=info.get("count_before"),
                     count_after=info.get("count_after"),
                     limit=limit, timer_ms=timer_after,
                     anchor_ms=anchor_after, actor=actor, meta=meta,
                     now_ms=now_ms)


def read_entries(conn: sqlite3.Connection, *, user_id: int | None = None,
                 owner: str | None = None, limit: int = 100,
                 offset: int = 0) -> list[dict]:
    """Последние записи: по пользователю (свои бакеты + его следы в котлах)
    или по конкретному бакету. Новые первыми."""
    try:
        want = max(1, min(500, int(limit)))
    except (TypeError, ValueError):
        want = 100
    try:
        skip = max(0, min(1_000_000, int(offset)))
    except (TypeError, ValueError):
        skip = 0
    try:
        if owner:
            rows = conn.execute(
                "SELECT * FROM quota_ledger WHERE owner=? "
                "ORDER BY id DESC LIMIT ? OFFSET ?",
                (str(owner), want, skip)).fetchall()
        elif user_id is not None:
            rows = conn.execute(
                "SELECT * FROM quota_ledger "
                "WHERE user_id=? OR actor_user_id=? "
                "ORDER BY id DESC LIMIT ? OFFSET ?",
                (int(user_id), int(user_id), want, skip)).fetchall()
        else:
            return []
    except (sqlite3.Error, TypeError, ValueError):
        return []
    out = []
    for row in rows:
        try:
            item = dict(row)
        except (TypeError, ValueError):
            continue
        item["product"] = product_of(item.get("owner"))
        out.append(item)
    return out


def read_buckets(conn: sqlite3.Connection, owners: list[str]) -> dict:
    """Текущее состояние бакетов {owner: {count, timer_ms, anchor_ms} | None}."""
    states: dict = {}
    for raw in owners or []:
        text = str(raw or "")
        if not text:
            continue
        try:
            row = conn.execute("SELECT count, timer_ms, anchor_ms FROM ai_usage"
                               " WHERE owner=?", (text,)).fetchone()
        except sqlite3.Error:
            row = None
        if row is None:
            states[text] = None
            continue
        try:
            anchor = row["anchor_ms"]
        except (KeyError, IndexError):
            anchor = None
        states[text] = {"count": row["count"], "timer_ms": row["timer_ms"],
                        "anchor_ms": anchor,
                        "product": product_of(text)}
    return states
