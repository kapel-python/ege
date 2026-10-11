#!/usr/bin/env python3
"""Ударение (задание №4) в актуальном формате ЕГЭ.

С 2016 года задание №4 — не «найди одно слово с ошибкой», а «укажите варианты
ответов, в которых ВЕРНО выделена ударная буква»; верных вариантов от двух до
четырёх, ответ — последовательность цифр в порядке возрастания (например 135).

История: раньше в каталоге лежали самописные «аналоги» старого формата, и в
`r04_3` все пять вариантов были верны — задания не существовало. Сейчас все 15
заданий линии №4 — реальные задания с Решу ЕГЭ, а ответ взят из блока ответа
источника. Тест это фиксирует:

  1) у задания ровно пять нумерованных вариантов;
  2) ответ — возрастающая подстрока «1..5» длиной 2–4 (непустой, не все пять);
  3) в каждом варианте помечен ударный гласный;
  4) ответ совпадает с ключом источника (пришпилен по id задания);
  5) текст без мягких переносов/узких пробелов источника.

Отдельно проверяются мини-задания урока `lesson_r04` — они по-прежнему
одноответные, и для них сверка идёт с таблицей норм (каждая позиция, кроме
ответа, обязана совпадать с нормой; ответ — отличаться ровно в одном).
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_russian.json"

# Ключи источника (Решу ЕГЭ, id задания) для 15 заданий линии №4 в проде.
SOURCE_KEYS = {
    "58083": "134",
    "45364": "15",
    "56934": "245",
    "45333": "34",
    "55128": "145",
    "45349": "135",
    "45367": "345",
    "66797": "1245",
    "50206": "145",
    "45345": "345",
    "56933": "123",
    "45353": "125",
    "45363": "145",
    "52952": "12",
    "45368": "245",
    "45059": "24",
    "45323": "23",
    "49129": "23",
    "56930": "1235",
    "58358": "145",
    "45324": "1245",
    "60921": "14",
    "45358": "25",
    "45336": "125",
    "45320": "14",
    "52547": "235",
    "50441": "14",
    "65170": "1234",
    "56108": "245",
    "56929": "345",
    "45361": "134",
    "45340": "125",
    "45357": "345",
    "56525": "34",
    "51852": "15",
    "54171": "25",
    "56931": "125",
    "45331": "124",
    "60948": "125",
    "45322": "345",
    "45359": "235",
    "57069": "23",
    "46286": "135",
    "53298": "25",
    "53325": "235",
    "45365": "345",
    "50293": "125",
    "45327": "23",
    "61489": "135",
    "45325": "124",
    "54212": "15",
    "45344": "134",
    "45360": "245",
    "45337": "2345",
    "56498": "135",
    "56081": "134",
    "45341": "145",
    "45356": "345",
    "45338": "125",
    "51825": "34",
    "52520": "123",
    "45318": "134",
    "45354": "2345",
    "45366": "123",
    "59267": "15",
    "45350": "245",
    "45321": "123",
    "51513": "245",
    "46257": "24",
    "57534": "345",
    "48124": "45",
    "45352": "145",
    "56935": "245",
    "56932": "145",
    "60237": "125",
    "59240": "13",
    "45317": "134",
    "48152": "245",
    "61517": "134",
    "45335": "135",
    "45348": "123",
    "45334": "134",
    "49986": "1235",
    "59899": "23",
    "49156": "145",
    "57506": "125",
    "50320": "125",
    "60210": "25",
    "59868": "13",
    "54089": "124",
    "45355": "125",
    "45362": "12",
    "52979": "13",
    "59298": "124",
    "45351": "2345",
    "49957": "145",
    "59669": "125",
    "45319": "1234",
    "57102": "24",
    "45347": "124"}

# Норма словника для одноответных мини-заданий урока: слово без знака ударения
# -> индекс ударного гласного (0-based).
NORMS = {
    "оптовый": 3, "кухонный": 1, "сверлит": 5, "тортов": 1,
    "договор": 5, "квартал": 5, "цемент": 3, "банты": 1,
    "вручит": 4, "закрепит": 6, "углубить": 5, "углубит": 5,
    "зайдет": 4, "позвонишь": 6, "начав": 3, "занятый": 1, "сливовый": 2,
}

WORD_RE = re.compile(r"[А-Яа-яЁё]+")
OPTION_RE = re.compile(r"^\s*([1-5])\)\s*(.+?)\s*$")


def plain(word: str) -> str:
    return word.lower().replace("ё", "е")


def marked_index(word: str) -> int | None:
    lower = word.lower()
    for i, ch in enumerate(word):
        if ch in "Ёё":
            return lower.index("ё")
        if ch.isupper() and unicodedata.category(ch) == "Lu":
            if lower[i] in "аеиоуыэюя":
                return i
    return None


def options_of(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.split("\n"):
        m = OPTION_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def main() -> int:
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    fails = 0

    def t(name: str, cond: bool):
        nonlocal fails
        print(("ok  " if cond else "FAIL") + " " + name)
        if not cond:
            fails += 1

    tasks = [x for x in data.get("tasks", []) if x.get("skill") == "r04"]
    t("заданий №4 ровно 100", len(tasks) == 100)
    t("все задания №4 — короткий ответ с цифровым ответом",
      all(x.get("type") == "short_answer" and x.get("valueType") == "цифра" for x in tasks))

    for task in tasks:
        label = task["id"]
        text, answer = task["text"], str(task["answer"])
        opts = options_of(text)

        t(f"{label}: пять нумерованных вариантов", [n for n, _ in opts] == ["1", "2", "3", "4", "5"])
        t(f"{label}: ответ — возрастающая подстрока 1..5", bool(re.fullmatch(r"[1-5]+", answer))
          and list(answer) == sorted(set(answer)))
        t(f"{label}: верных вариантов от двух до четырёх", 2 <= len(answer) <= 4)
        t(f"{label}: каждый вариант размечен (помечен ударный гласный)",
          all(marked_index(w) is not None for _, w in opts))

        pid = re.search(r"id=(\d+)", task.get("source") or "")
        key = SOURCE_KEYS.get(pid.group(1)) if pid else None
        t(f"{label}: ответ совпадает с ключом источника "
          f"({pid.group(1) if pid else 'нет id'})", key is not None and key == answer)

        clean = all(ch not in text for ch in "\u00ad\u202f\xa0")
        t(f"{label}: в тексте нет мягких переносов и узких пробелов", clean)

    # Мини-задания урока остаются одноответными — проверяем по таблице норм.
    lesson = next((x for x in data.get("lessons", []) if x.get("id") == "lesson_r04"), None)
    t("урок lesson_r04 найден", lesson is not None)
    if lesson:
        for step in lesson.get("steps", []):
            if step.get("type") not in ("ACTION", "VALIDATION"):
                continue
            rows = [w for w in WORD_RE.findall(step.get("text") or "") if marked_index(w)]
            if len(rows) < 3:
                continue
            label = f"урок {step['id']}"
            answer = step.get("answer") or ""
            hits, deviations = 0, []
            for row in rows:
                norm = NORMS.get(plain(row))
                if norm is None:
                    t(f"{label}: вариант {row!r} есть в таблице норм", False)
                    continue
                idx = marked_index(row)
                if idx is None:
                    t(f"{label}: у варианта {row!r} помечен ударный гласный", False)
                    continue
                if idx == norm:
                    hits += 1
                else:
                    deviations.append(row)
            t(f"{label}: ровно один вариант противоречит норме", len(deviations) == 1)
            t(f"{label}: противоречит норме вариант-ответ {answer!r}",
              len(deviations) == 1 and plain(deviations[0]) == plain(answer))
            t(f"{label}: прочие варианты — норма", hits == len(rows) - 1)

    print("RUSSIAN-ORTHOEPY " + ("OK" if fails == 0 else f"FAILURES={fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())