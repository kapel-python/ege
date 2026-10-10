#!/usr/bin/env python3
"""Короткая подпись темы вместо обрезанной фразы из условия.

В каталогах базовой математики (исторически), а также в добавленных заданиях
общества, информатики и биологии поле sub склеивалось из первой строки условия
и в миссиях выглядело как обрывок текста задания. Русский каталог хранит
короткую подпись темы — приводим все каталоги к тому же виду.

Правило: sub считается «мусорным», если он длиннее 45 символов или начинается
так же, как текст задания. Такому заданию проставляем подпись темы — имя скилла
без номера («№8 — Логика: анализ утверждений» → «Логика: анализ утверждений»).
Осмысленные короткие подписи не трогаем.

    python3 tools/fix_sub.py --analyze
    python3 tools/fix_sub.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGS = [
    ROOT / "server" / "catalog.json",
    ROOT / "server" / "catalog_basic.json",
    ROOT / "server" / "catalog_society.json",
    ROOT / "server" / "catalog_informatics.json",
    ROOT / "server" / "catalog_biology.json",
]
MAX_SUB = 45


def topic_name(skill_name: str) -> str:
    """«№8 — Логика: анализ утверждений» -> «Логика: анализ утверждений»."""
    name = re.sub(r"^\s*№\s*\d+\s*[—–-]\s*", "", str(skill_name or "")).strip()
    return name or "Задание"


def is_junk(sub: str, text: str) -> bool:
    s = (sub or "").strip()
    if not s:
        return True
    if len(s) > MAX_SUB:
        return True
    t = (text or "").strip()
    return len(s) >= 20 and t.startswith(s[:20])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    total = 0
    for path in CATALOGS:
        data = json.loads(path.read_text(encoding="utf-8"))
        names = {s.get("id"): topic_name(s.get("name") or s.get("title"))
                 for s in data.get("skills", [])}
        fixed = 0
        for t in data.get("tasks", []):
            if is_junk(t.get("sub"), t.get("text")):
                label = names.get(t.get("skill"), "")
                if label and label != (t.get("sub") or "").strip():
                    t["sub"] = label
                    fixed += 1
        if fixed:
            print(f"{path.relative_to(ROOT)}: подписей исправлено {fixed}")
        else:
            print(f"{path.relative_to(ROOT)}: чисто")
        total += fixed
        if not args.analyze:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nвсего исправлено: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())