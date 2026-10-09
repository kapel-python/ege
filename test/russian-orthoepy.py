#!/usr/bin/env python3
"""Ударение (задание №4): в каждом задании ровно одна ошибка.

Живой случай: в `r04_3` были помечены как неверные варианты, которые на самом
деле норма (`слИвовый`, `кУхонный`, `тОрты`, `нарвалА`, `включЁнный` — все
верны по орфоэпическому словнику ФИПИ), то есть задания с единственным верным
ответом не существовало вовсе. Второй такой же случай — мини-задание урока
`r04_s7` (`грУшевый` — норма, а не ошибка).

Тест сверяет разметку задания с таблицей норм: каждая позиция, кроме ответа,
обязана совпадать с нормой, а ответ — отличаться от неё ровно в одном.
Ошибка «всё правильно» ловится сразу: расхождений с нормой ноль.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_russian.json"

# Норма словника: слово без знака ударения -> индекс ударного гласного (0-based).
NORMS = {
    "баловать": 5,   # баловАть
    "звонит": 4,     # звонИт
    "краны": 2,      # крАны
    "начав": 3,      # начАв
    "оптовый": 3,    # оптОвый
    "досуг": 3,      # досУг
    "каталог": 5,    # каталОг
    "красивее": 4,   # красИвее
    "средства": 2,   # срЕдства
    "занятый": 1,    # зАнятый
    "сливовый": 2,   # слИвовый
    "кухонный": 1,   # кУхонный
    "нарвала": 6,    # нарвалА
    "торты": 1,      # тОрты
    "брала": 4,      # бралА
    "клала": 2,      # клАла
    "лгала": 4,      # лгалА
    "начал": 1,      # нАчал
    "позвала": 6,    # позвалА
    "добела": 5,     # добелА
    "завидно": 3,    # завИдно
    "издревле": 4,   # издрЕвле
    "исчерпать": 3,  # исчЕрпать
    "облегчить": 6,  # облегчИть
    # слова мини-заданий урока lesson_r04
    "договор": 5,    # договОр
    "квартал": 5,    # квартАл
    "цемент": 3,     # цемЕнт
    "банты": 1,      # бАнты
    "вручит": 4,     # вручИт
    "закрепит": 6,   # закрепИт
    "углубить": 5,   # углубИть
    "углубит": 5,    # углубИт
    "сверлит": 5,    # сверлИт
    "тортов": 1,     # тОртов
    "зайдет": 4,     # зайдЁт
    "позвонишь": 6,  # позвонИшь
}

WORD_RE = re.compile(r"[А-Яа-яЁё]+")


def plain(word: str) -> str:
    """Слово без знака ударения и без ё-варианта, в нижнем регистре."""
    return word.lower().replace("ё", "е")


def marked_index(word: str) -> int | None:
    """Индекс ударного гласного по заглавной букве; ё считаем ударной."""
    lower = word.lower()
    for i, ch in enumerate(word):
        if ch in "Ёё":
            return lower.index("ё")
        if ch.isupper() and unicodedata.category(ch) == "Lu":
            if lower[i] in "аеиоуыэюя":
                return i
    return None


def options_of(text: str) -> list[str]:
    return [ln.strip() for ln in text.split("\n")
            if ln.strip() and not ln.strip().startswith("В одном")]


def main() -> int:
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    fails = 0

    def t(name: str, cond: bool):
        nonlocal fails
        print(("ok  " if cond else "FAIL") + " " + name)
        if not cond:
            fails += 1

    def check_variants(label: str, word_rows: list[str], answer: str):
        norm_hits, deviations = 0, []
        for row in word_rows:
            key = plain(row)
            norm = NORMS.get(key)
            if norm is None:
                t(f"{label}: вариант {row!r} есть в таблице норм", False)
                continue
            idx = marked_index(row)
            if idx is None:
                t(f"{label}: у варианта {row!r} помечен ударный гласный", False)
                continue
            if idx == norm:
                norm_hits += 1
            else:
                deviations.append(row)
        t(f"{label}: все варианты размечены (норма у {norm_hits} из {len(word_rows)})",
          norm_hits == len(word_rows) - 1)
        t(f"{label}: ровно один вариант противоречит норме", len(deviations) == 1)
        t(f"{label}: противоречащий норме вариант — это ответ {answer!r}",
          len(deviations) == 1 and plain(deviations[0]) == plain(answer))

    tasks = [x for x in data.get("tasks", []) if x.get("skill") == "r04"]
    t("задания №4 найдены", len(tasks) == 5)
    for task in tasks:
        check_variants(task["id"], options_of(task["text"]), task["answer"])

    lesson = next((x for x in data.get("lessons", []) if x.get("id") == "lesson_r04"), None)
    t("урок lesson_r04 найден", lesson is not None)
    if lesson:
        for step in lesson.get("steps", []):
            if step.get("type") not in ("ACTION", "VALIDATION"):
                continue
            rows = [w for w in WORD_RE.findall(step.get("text") or "") if marked_index(w)]
            if len(rows) < 3:
                continue
            check_variants(f"урок {step['id']}", rows, step.get("answer") or "")

    print("RUSSIAN-ORTHOEPY " + ("OK" if fails == 0 else f"FAILURES={fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())