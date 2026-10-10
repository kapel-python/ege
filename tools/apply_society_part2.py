#!/usr/bin/env python3
"""Добор тренажёров части 2 обществознания (№17–20, №22–25) до TARGET=100.

Зачем: эти линии в каталоге держались на пяти самописных «тренажёрах
формата демоверсии». Источник отдаёт настоящие задания с официальным
модельным ответом (блок «Пояснение»); их и ставим.

Часть 2 не проверяется автоматически: у задания нет машинного ключа, ученик
решает письменно и сверяется (check:"self", см. server._task_check_mode).
Поэтому в answer/solution кладём официальный модельный ответ источника, а не
ключ, а сам источник остаётся в source/sourceId.

    python3 tools/apply_society_part2.py --analyze   # что и сколько заменится
    python3 tools/apply_society_part2.py             # запись каталога
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_society.json"
OUT_DIR = ROOT / "tools" / "out"

TARGET = 100
# Линии части 2, у которых нет рисунка (№21 — график, его ведёт
# apply_society_figures.py).
PART2 = {
    17: "soc17_text",
    18: "soc18_terms",
    19: "soc19_cases",
    20: "soc20_judge",
    22: "soc22_task",
    23: "soc23_const",
    24: "soc24_plan",
    25: "soc25_reason",
}
# Самописные тренажёры источник не отдаёт: их содержимое заменяем настоящим.
ANALOG_RE = re.compile(r"тренировочный вариант|тренажёр|формат демоверсии", re.I)

HINT1 = "Внимательно перечитай задание и отвечай на каждый пункт отдельно, по существу вопроса."
HINT2 = ("По каждому пункту приведи конкретику: факт из текста или пример из курса, "
         "а не общие слова.")


def line_ok(n: int, text: str) -> bool:
    """Задание соответствует своей линии? Источник иногда подмешивает в набор
    чужую линию (видели задание-план №24 среди текстовых №17)."""
    low = (text or "").lower()
    plan = "составьте сложный план" in low
    if n in (17, 18, 19, 20):
        return not plan
    if n == 24:
        return plan
    return True


def usable(raw: dict, n: int) -> bool:
    """Кандидат части 2: есть условие, есть официальный модельный ответ и нет рисунка."""
    if raw.get("images"):
        return False
    if not (raw.get("condition") or "").strip():
        return False
    if not (raw.get("solution") or "").strip():
        return False
    # self-задание не должно содержать призыв вписать готовый ответ.
    if "ответ запишите" in (raw.get("condition") or "").lower():
        return False
    if not line_ok(n, raw.get("condition") or ""):
        return False
    return True


def next_suffix(group: list[dict]) -> int:
    best = 0
    for t in group:
        m = re.search(r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def build(old: dict, n: int, raw: dict, new_id: str) -> dict:
    solution = (raw["solution"] or "").strip()
    text = (raw["condition"] or "").strip()
    return {
        "id": new_id,
        "skill": old["skill"],
        "sub": old.get("sub") or f"№{n}",
        "num": old.get("num") or f"№{n}",
        "diff": old.get("diff", 2),
        "text": text,
        "answer": solution,
        "hint": HINT1,
        "hints": [HINT1, HINT2, solution],
        "solution": solution,
        "type": "short_answer",
        "points": old.get("points", 2),
        "check": "self",
        "selfCheck": True,
        "source": f"Решу ЕГЭ (СДАМ ГИА), обществознание, задание №{n}, {raw['url']}",
        "sourceId": f"sdamgia-{raw['src_id']}",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    by_id = {t["id"]: t for t in tasks}
    replaced = 0
    added: list[dict] = []

    for n, skill in PART2.items():
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        raw_path = OUT_DIR / f"soc_{n:02d}.json"
        raw = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else []
        pool = [r for r in raw if usable(r, n)]
        if not pool:
            print(f"№{n:2} {skill:14} НЕТ сырья ({raw_path.name})")
            continue

        used = {t.get("sourceId") for t in group}
        avail = [r for r in pool if f"sdamgia-{r['src_id']}" not in used]
        ai = 0

        # 0) чиним уже записанные задания, попавшие не в свою линию
        repaired = 0
        for t in group:
            sid = t.get("sourceId") or ""
            if sid.startswith("sdamgia-") and not line_ok(n, t.get("text") or ""):
                if ai >= len(avail):
                    break
                r = avail[ai]
                ai += 1
                by_id[t["id"]] = build(t, n, r, t["id"])
                repaired += 1

        # 1) меняем самописные аналоги на настоящие, сохраняя id (миссии ссылаются на них)
        analogs = [t for t in group if ANALOG_RE.search(t.get("source") or "")]
        repl = 0
        for old_t in analogs:
            if ai >= len(avail):
                break
            r = avail[ai]
            ai += 1
            by_id[old_t["id"]] = build(old_t, n, r, old_t["id"])
            repl += 1
            replaced += 1

        # 2) добираем новые id до TARGET
        k = next_suffix(group)
        taken = 0
        while ai < len(avail) and len(group) + taken < TARGET:
            r = avail[ai]
            ai += 1
            added.append(build(group[0], n, r, f"soc{n:02d}_p{k}"))
            k += 1
            taken += 1
        total = len(group) + taken
        note = "" if total >= TARGET else " (потолок источника)"
        print(f"№{n:2} {skill:14} было {len(group):3}, починено {repaired}, "
              f"замен {repl}, добрано {taken:3} → {total:3}{note}")

    if args.analyze:
        print(f"\nзаменилось бы {replaced}, добавилось бы {len(added)}")
        return 0

    data["tasks"] = list(by_id.values()) + added
    data["tasks"].sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nзаменено: {replaced}; добрано: {len(added)}; всего заданий: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())