#!/usr/bin/env python3
"""Пересборка каталога русского по выгрузкам источника (tools/out/rus_NN.json).

Каталог собирается не «на глаз», а из ответов и решений источника:
  * формат ответа определяется по самим данным — «слово», «цифра» или
    «последовательность цифр» (таблица-бланк). Это важно: движок рисует поле
    ввода или таблицу именно по valueType + меткам строк «А) …» в тексте;
  * если источник допускает несколько написаний ответа (a|b), первое идёт в
    answer, остальные — в accept (движок их уже умеет проверять);
  * финальный шаг урока настраивается под реальный формат линии.

    python3 tools/apply_russian.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_russian.py             # переписать server/catalog_russian.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_russian.json"
OUT_DIR = ROOT / "tools" / "out"

MATCHING_RE = re.compile(r"соответстви|под каждой буквой|под каждой точкой", re.I)
LABEL_RE = re.compile(r"(?:^|\n)\s*([А-ЯA-Z])\)\s")
KEY_ORDER = ["answer", "accept", "diff", "hint", "hints", "id", "num", "points",
             "skill", "solution", "source", "sub", "text", "type", "valueType"]


def letter_labels(text: str) -> str:
    labels = []
    for m in LABEL_RE.finditer(text):
        if not labels or labels[-1] != m.group(1):
            labels.append(m.group(1))
    return "".join(labels)


def classify(text: str, answer: str) -> str:
    if re.fullmatch(r"[1-9]+", answer):
        labels = letter_labels(text)
        if MATCHING_RE.search(text) and len(labels) == len(answer):
            return "последовательность цифр"
        return "цифра"
    return "словосочетание" if " " in answer else "слово"


def load_line(n: int) -> list[dict]:
    path = OUT_DIR / f"rus_{n:02d}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_text(text: str) -> str:
    text = text.strip()
    # «|» в условии источника — маркер выделения, таблиц в русском нет: убираем,
    # иначе рендер примет строку с пайпом за таблицу.
    text = text.replace("|", "")
    # Источник иногда ставит в метке строки латинскую A) вместо кириллической
    # А) — правим на кириллицу, чтобы бланк читался однородно.
    text = re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)
    return text


def normalize_solution(text: str) -> str:
    text = text.replace("|", "")
    text = re.sub(r"^(?:Пояснение\s*\([^)]*\)\.\s*|"
                  r"[Тт]акже\s+[Пп]равило\s+ниже\)\.\s*|Пояснение\.\s*)", "", text.strip())
    return text.strip()


def task_from_source(n: int, idx: int, raw: dict, sub: str) -> dict:
    parts = (raw["answer"] or "").split("|")
    answer = parts[0].strip()
    alts = [p.strip() for p in parts[1:] if p.strip()]
    text = normalize_text(raw["condition"])
    value_type = classify(text, answer)
    hints = {
        "цифра": ["Перечитай формулировку: она прямо говорит, что записывать — номера ответов.",
                  "Отметь все подходящие варианты, а не первый найденный.",
                  "Запиши номера по возрастанию, без пробелов."],
        "последовательность цифр": ["Определи ответ для каждой буквы отдельно.",
                                    "Каждая цифра идёт в свою клетку — под своей буквой.",
                                    "Проверь, что номера не повторяются, если в условии не сказано иначе."],
        "слово": ["Определи, какое именно слово требует формулировка.",
                  "Запиши слово в той форме, которую требует задание.",
                  "Проверь написание и форму по правилу темы."],
        "словосочетание": ["Определи нужную единицу по формулировке задания.",
                           "Запиши ответ одним словосочетанием, как просят.",
                           "Проверь форму и написание."],
    }[value_type]
    task = {
        "answer": answer,
        "diff": 1,
        "hint": "Прочитай условие до конца и примени правило темы.",
        "hints": hints,
        "id": f"r{n:02d}_{idx}",
        "num": f"№{n}",
        "points": 1,
        "skill": f"r{n:02d}",
        "solution": normalize_solution(raw["solution"]) or "См. пояснение источника по ссылке.",
        "source": f"Решу ЕГЭ (СДАМ ГИА), задание №{n}, {raw['url']}",
        "sub": sub,
        "text": text,
        "type": "short_answer",
        "valueType": value_type,
    }
    if alts:
        task["accept"] = alts
    return {k: task[k] for k in KEY_ORDER if k in task}


def lesson_hint_text(value_type: str, n: int) -> str:
    if value_type == "последовательность цифр":
        return (f"Реши настоящее задание №{n} из банка. Формат ответа: заполни таблицу — "
                "под каждой буквой свой номер.")
    if value_type == "цифра":
        return (f"Реши настоящее задание №{n} из банка. Формат ответа: запиши номера ответов "
                "подряд без пробелов.")
    if value_type == "словосочетание":
        return (f"Реши настоящее задание №{n} из банка. Формат ответа: запиши словосочетание "
                "из условия.")
    return f"Реши настоящее задание №{n} из банка. Формат ответа: запиши слово."


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    lessons = {l["id"]: l for l in data.get("lessons", [])}
    by_skill = {}
    summary = []

    for n in range(1, 27):
        raw = load_line(n)[:15]
        skill = f"r{n:02d}"
        lesson = lessons.get(f"lesson_{skill}")
        sub = (lesson or {}).get("title") or f"№{n}"
        tasks = [task_from_source(n, i, r, sub) for i, r in enumerate(raw, 1)]
        by_skill[skill] = tasks
        kinds = {}
        for t in tasks:
            kinds[t["valueType"]] = kinds.get(t["valueType"], 0) + 1
        summary.append((skill, len(tasks), kinds))
        if tasks and lesson:
            dom = max(kinds, key=kinds.get)
            for step in lesson.get("steps", []):
                if step.get("type") == "INDEPENDENT_TASK":
                    step["text"] = lesson_hint_text(dom, n)

    for skill, count, kinds in summary:
        flag = "OK " if count == 15 else "!! "
        print(f"{flag}{skill}: {count} заданий  {kinds}")

    if args.analyze:
        return 0

    ready = {s: t for s, t in by_skill.items() if len(t) == 15}
    missing = [s for s in by_skill if s not in ready]
    if missing:
        print("НЕ ГОТОВЫ линии:", ", ".join(missing))
    # Заменяем только те линии, что полностью загружены: частичную линию
    # оставлять нельзя (нельзя смешивать реальные задания с аналогами).
    kept = [t for t in data["tasks"] if t.get("skill") not in ready]
    rebuilt = []
    for n in range(1, 27):
        skill = f"r{n:02d}"
        rebuilt.extend(ready.get(skill, []))
    data["tasks"] = kept + rebuilt
    # порядок: тестовая часть по линиям, затем сочинения
    data["tasks"].sort(key=lambda t: (
        1 if t.get("skill") == "russian_essay_source" else 0,
        t.get("skill") or "", t.get("id") or ""))

    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    short = [t for t in data["tasks"] if t.get("type") == "short_answer"]
    print(f"записано: всего {len(data['tasks'])}, коротких {len(short)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())