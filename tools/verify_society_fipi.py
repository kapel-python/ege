#!/usr/bin/env python3
"""Строгая проверка 29 замен в обществознании по официальным демо ФИПИ.

Для каждой заменённой задачи сверяем два независимых признака:
  1. ответ совпадает с официальным ключом демоверсии (таблица «Номер задания /
     Правильный ответ» в PDF; для заданий 1, 9, 12 порядок цифр не важен);
  2. distinctive-лексика текста (слова длиной 6+ без каркасных слов) покрыта
     текстом демо-PDF — вёрстка PDF в две колонки рвёт фразы, поэтому ищем
     мешком слов, а не подстрокой.

    python3 tools/verify_society_fipi.py
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIPI = Path("/tmp/opencode/fipi")

STOP = set("""ниже приведён перечень которые каждого первому столбцу подберите
соответствующую позицию второго запишите таблицу цифры которыми указаны
выберите верные суждения которые стране найдите приведённом списке черты
качеств человека которые характеризуют установите соответствие между каждой
позиции данной первого второй используя обществоведческие знания укажите
ответа ответ ответьте”?“«»—–- 1234567890""".split())

ORDER_FREE_2027 = {1, 9, 12}


def flat(s: str) -> str:
    return re.sub(r"\s+", "", s.lower())


def distinctive(text: str) -> list[str]:
    words = re.findall(r"[а-яёa-z]{6,}", text.lower())
    return [w for w in words if w not in STOP]


def parse_keys(path: Path) -> dict[int, str]:
    txt = path.read_text(encoding="utf-8")
    keys: dict[int, str] = {}
    # Таблица ключей в две колонки: за цифрами может идти текст правой колонки,
    # поэтому якоря на конец строки нет. Строки вариантов ("1) ...", "3 2 3 1")
    # под шаблон не подходят: после номера там скобка или одиночные цифры.
    for m in re.finditer(r"(?m)^\s*(\d{1,2})\s+(\d{2,6})(?!\d)", txt):
        n = int(m.group(1))
        if 1 <= n <= 16 and n not in keys:
            keys[n] = m.group(2)
    return keys


def key_equal(a: str, b: str, order_free: bool) -> bool:
    a = re.sub(r"\s+", "", a or "")
    b = re.sub(r"\s+", "", b or "")
    if order_free:
        return sorted(a) == sorted(b)
    return a == b


def main() -> int:
    cur = json.loads((ROOT / "server" / "catalog_society.json").read_text(encoding="utf-8"))
    old = json.loads(subprocess.check_output(
        ["git", "show", "HEAD:server/catalog_society.json"], cwd=ROOT))
    bold = {t["id"]: t for t in old["tasks"]}
    changed = sorted([t for t in cur["tasks"] if t != bold.get(t["id"])],
                     key=lambda x: x["id"])
    keys = {2027: parse_keys(FIPI / "demo_2027.txt"),
            2026: parse_keys(FIPI / "demo_2026.txt")}
    flats = {2027: flat((FIPI / "demo_2027.txt").read_text(encoding="utf-8")),
             2026: flat((FIPI / "demo_2026.txt").read_text(encoding="utf-8"))}
    print(f"ключи 2027: {len(keys[2027])}, ключи 2026: {len(keys[2026])}")

    fails = 0
    for t in changed:
        m = re.match(r"soc(\d+)_", t["id"])
        n = int(m.group(1))
        src = t.get("source") or ""
        year = 2027 if "2027" in src else 2026
        official = keys[year].get(n, "?")
        key_ok = key_equal(t.get("answer", ""), official,
                           year == 2027 and n in ORDER_FREE_2027)
        toks = distinctive(t["text"])
        hit = sum(1 for w in toks if w in flats[year])
        cov = hit / max(1, len(toks))
        lex_ok = cov >= 0.70
        status = "OK " if (key_ok and lex_ok) else "FAIL"
        if status == "FAIL":
            fails += 1
        missing = [w for w in toks if w not in flats[year]][:6]
        print(f"  {status} {t['id']} демо-{year} №{n}: ключ {t.get('answer')!r} vs офиц. {official} "
              f"{'=' if key_ok else '!'}; лексика {hit}/{len(toks)}={cov:.0%} "
              f"{'' if lex_ok else '| нет: ' + ','.join(missing)}")
    print(f"\nитог: {len(changed) - fails}/{len(changed)} подтверждено")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())