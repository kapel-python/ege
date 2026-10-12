#!/usr/bin/env python3
"""Польза подсказок (rescue-rate) по реальным попыткам из прод-БД.

Подсказка существует, чтобы спасать попытку: открыли уровень — следующая
попытка стала верной. Метрика на попытку из task_attempts:
  rescue(skill, level) = correct / attempts среди попыток с hint_level=level.
Уровень 3 исключён: показ ответа по построению засчитывается как неверный
(recordAnswer), это не «неспасение», а другой исход. Пропуски исключены.

Флаги (информационные, не провал): уровень с ≥15 попытками и rescue < 35%,
а также уровень 2 не лучше уровня 1 при ≥15 попытках на каждом — вторая
ступень лестницы тогда не работает.

Живой случай: r22 — провалы даже со всеми открытыми подсказками. Если
rescue уровней темы около нуля, лестницу надо чинить (процедура,
частичное раскрытие), а не добавлять ещё одну общую фразу.

Только чтение: база открывается в режиме ro, живой сервер не трогаем.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "server" / "ege.sqlite3"

MIN_ATTEMPTS = 15
WEAK_RATE = 0.35


def main() -> int:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT subject, skill_id, hint_level,"
        " COUNT(*) AS n, SUM(correct) AS ok"
        " FROM task_attempts"
        " WHERE skipped = 0 AND hint_level IN (1, 2)"
        " GROUP BY subject, skill_id, hint_level"
    ).fetchall()
    con.close()

    by_skill: dict[tuple[str, str], dict[int, tuple[int, int]]] = {}
    for r in rows:
        by_skill.setdefault((r["subject"], r["skill_id"]), {})[int(r["hint_level"])] = (
            int(r["n"]), int(r["ok"] or 0))

    total_n = total_ok = 0
    flags: list[str] = []
    print(f"навыков с попытками с подсказками: {len(by_skill)}")
    for (subject, skill), levels in sorted(by_skill.items()):
        parts = []
        for lvl in (1, 2):
            n, ok = levels.get(lvl, (0, 0))
            total_n += n
            total_ok += ok
            rate = ok / n if n else None
            parts.append(f"L{lvl}: {ok}/{n}" + (f"={rate:.0%}" if rate is not None else ""))
            if n >= MIN_ATTEMPTS and rate is not None and rate < WEAK_RATE:
                flags.append(f"{subject}/{skill} L{lvl}: rescue {rate:.0%} на {n} попытках")
        n1, ok1 = levels.get(1, (0, 0))
        n2, ok2 = levels.get(2, (0, 0))
        if n1 >= MIN_ATTEMPTS and n2 >= MIN_ATTEMPTS and (ok2 / n2) <= (ok1 / n1):
            flags.append(f"{subject}/{skill}: L2 ({ok2}/{n2}) не лучше L1 ({ok1}/{n1})")
        if any(v[0] >= MIN_ATTEMPTS for v in levels.values()):
            print(f"  {subject:12s} {skill:18s} " + "  ".join(parts))

    print(f"ИТОГО: {total_ok}/{total_n} спасено"
          + (f"={total_ok / total_n:.0%}" if total_n else ""))
    if flags:
        print("ТРЕБУЕТ ВНИМАНИЯ (слабая ступень — чинить лестницу, не добавлять фразы):")
        for f in flags:
            print(f"  ! {f}")
    else:
        print("слабых ступеней нет")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
