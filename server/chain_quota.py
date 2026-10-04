#!/usr/bin/env python3
"""Общая цепочка лимитов: треть запаса за 8-часовой тик, полный — за 24 часа.

ЕДИНСТВЕННАЯ реализация для обоих продуктовых бюджетов: проверки сочинений
(`u:`/`k:`/`n:`-бакеты в server.py) и ходы наставника (`agent:`-бакеты в
agent.py) буквально вызывают `catch_up`/`count_at`/`cum` отсюда — дублей нет.
Какой бы ни был лимит (5, 10, 25, 500), механика одна: первая трата из
полного кармана ставит якорь (`anchor_ms`), дальше каждые 8 часов
возвращается треть запаса с кумулятивным округлением, полный карман — за
24 часа от якоря при любом лимите.

Почему общий модуль, а не копия: server.py грузит agent.py через importlib
по пути файла (оба — топ-уровневые модули, не пакет), поэтому agent не может
импортировать server и наоборот. Этот файл зависит только от stdlib и ни от
кого не импортируется сам — цикла нет, обе стороны грузят его тем же приёмом
по пути файла. Состояния внутри нет (чистые функции + SQL), поэтому двойная
загрузка в одном процессе безвредна.

Схема строки `ai_usage`: `count` — жетоны в кармане, `timer_ms` — граница
отыгранных тиков (NULL = карман полон, цепочки нет), `anchor_ms` — якорь
цепочки, момент первой траты (NULL = цепочки нет).
"""
from __future__ import annotations

import sqlite3

# Тиков 8-часового окна до полного кармана: 24 ч / 8 ч. Делитель общий для
# всех лимитов: за тик возвращается round(limit/3) — обычное округление
# (5 → 2, 10 → 3, 25 → 8). Делитель 3 хорош тем, что limit*n/3 при целом
# limit никогда не даёт ровно .5 (остатки только 1/3 и 2/3), поэтому
# банковское округление Python здесь совпадает с обычным: спора «3.5 → 3
# или 4» на этих числах не бывает.
FULL_TICKS = 3


def cum(n: int, limit: int) -> int:
    """Сколько жетонов положено за n тиков от якоря (без капа сверху).

    Кумулятивное округление: cum(n) = round(limit*n/3). Приращение тика —
    cum(total) − cum(done) (для 25: 8, 9, 8 — в сумме ровно лимит), поэтому
    полный карман сходится за 3 тика при любом лимите, а не «примерно».
    Кап до limit делает вызыватель через MIN."""
    try:
        n = int(n)
        limit = int(limit)
    except (TypeError, ValueError):
        return 0
    if n <= 0 or limit <= 0:
        return 0
    return int(round(limit * n / 3.0))


def _cell(row, name: str, index: int, default=None):
    """Поле строки: по имени (sqlite3.Row) или по позиции (кортеж)."""
    try:
        return row[name]
    except (KeyError, IndexError, TypeError):
        pass
    try:
        return row[index]
    except (IndexError, TypeError, KeyError):
        return default


def ensure_anchor_col(conn: sqlite3.Connection) -> None:
    """Колонка якоря цепочки. Без коммита: вызывается и внутри чужих
    транзакций (reserve/status уже открыли свою через INSERT)."""
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(ai_usage)")]
    except sqlite3.Error:
        return
    if cols and "anchor_ms" not in cols:
        try:
            conn.execute("ALTER TABLE ai_usage ADD COLUMN anchor_ms INTEGER")
        except sqlite3.Error:
            pass


def catch_up(conn: sqlite3.Connection, owner: str, now_ms: int,
             limit: int, window_ms: int) -> None:
    """Ленивая зарядка третями: за каждый созревший 8-часовой тик от якоря —
    треть запаса (см. cum). Идемпотентно, без коммита (коммит за вызывателем,
    чья транзакция уже открыта первым INSERT)."""
    ensure_anchor_col(conn)
    try:
        row = conn.execute("SELECT count, timer_ms, anchor_ms FROM ai_usage"
                           " WHERE owner=?", (owner,)).fetchone()
    except sqlite3.Error:
        return
    if not row:
        return
    try:
        count = int(_cell(row, "count", 0))
    except (TypeError, ValueError):
        return
    timer = _cell(row, "timer_ms", 1)
    anchor = _cell(row, "anchor_ms", 2)
    if timer is None:
        if count < limit:
            # Призрак (частичный остаток без таймера): запускаем цепочку
            # сейчас, иначе такой карман не зарядился бы никогда.
            try:
                conn.execute("UPDATE ai_usage SET timer_ms=?, anchor_ms=? WHERE owner=?",
                             (now_ms, now_ms, owner))
            except sqlite3.Error:
                pass
        return
    if anchor is None:
        # Цепочка от старой версии (был только timer_ms): якорем считаем его.
        try:
            conn.execute("UPDATE ai_usage SET anchor_ms=? WHERE owner=?",
                         (int(timer), owner))
        except sqlite3.Error:
            return
        anchor = int(timer)
    try:
        anchor = int(anchor)
        timer = int(timer)
    except (TypeError, ValueError):
        return
    if count > limit:
        # Потолок снизили: срезаем к новому, цепочка гаснет.
        try:
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL, anchor_ms=NULL"
                         " WHERE owner=?", (limit, owner))
        except sqlite3.Error:
            pass
        return
    if now_ms < anchor or window_ms <= 0:
        return
    if timer < anchor:
        timer = anchor
    total = (now_ms - anchor) // window_ms
    done = (timer - anchor) // window_ms
    if total <= done:
        orig_timer = _cell(row, "timer_ms", 1)
        if timer != orig_timer:
            try:
                conn.execute("UPDATE ai_usage SET timer_ms=? WHERE owner=?",
                             (timer, owner))
            except sqlite3.Error:
                pass
        return
    inc = cum(total, limit) - cum(done, limit)
    if inc <= 0 and count < limit:
        inc = 1  # лимит 1: cum(1) = 0, но стоять тик без жетона нельзя
    if inc <= 0:
        return
    new_count = min(limit, count + inc)
    try:
        if new_count >= limit:
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=NULL, anchor_ms=NULL"
                         " WHERE owner=?", (new_count, owner))
        else:
            conn.execute("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                         (new_count, anchor + total * window_ms, owner))
    except sqlite3.Error:
        pass


def count_at(state, t_ms: int, now_ms: int, limit: int, window_ms: int) -> int:
    """Проекция бакета (count, timer, anchor) на момент t_ms: чистая функция,
    ничего не пишет. Таймер-призрак (count < limit, но timer NULL) считаем
    стартующим сейчас — такой строки быть не должно, но пусть лечится."""
    count = state[0]
    timer_ms = state[1]
    anchor_ms = state[2] if len(state) > 2 else None
    if count >= limit:
        return count
    if limit <= 0:
        return count
    if timer_ms is None or anchor_ms is None:
        start = now_ms
        if t_ms < start or window_ms <= 0:
            return count
        total = (t_ms - start) // window_ms
        if total <= 0:
            return count
        inc = cum(total, limit)
        if inc <= 0:
            inc = 1
        return min(limit, count + inc)
    if window_ms <= 0 or t_ms < anchor_ms:
        return count
    done = (timer_ms - anchor_ms) // window_ms if timer_ms >= anchor_ms else 0
    total = (t_ms - anchor_ms) // window_ms
    if total <= done:
        return min(limit, count)
    inc = cum(total, limit) - cum(done, limit)
    if inc <= 0:
        inc = 1
    return min(limit, count + inc)
