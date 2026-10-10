#!/usr/bin/env python3
"""Замена самописных «аналогов» в информатике на реальные задания источника.

Правила (те же, что для базы/профиля/русского):
  * меняем ТОЛЬКО тестовую часть; уроки/миссии/боссы не трогаем, id задач
    сохраняем (infNN_p1..p5), чтобы связанные сущности не разъехались;
  * тему с рисунками inf01_graph не трогаем: там уже есть восстановленные
    SVG-схемы (assets/informatics/inf-graph-p*.svg), а источник отдаёт графы
    растром — наш рендер их не покажет;
  * из источника берём только задания без картинок (images == 0) и без ссылок
    на отсутствующий рисунок; для №18 (Робот) требуем таблицу данных или
    явные координаты стен в тексте;
  * ответы источника с разделителем «&» (два числа) приводим к пробелу —
    так уже оформлены нынешние задания, движок при проверке пробелы стирает;
  * схема полей не меняется (без visual, без новых ключей).

    python3 tools/apply_informatics.py --analyze
    python3 tools/apply_informatics.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_informatics.json"
OUT_DIR = ROOT / "tools" / "out"

ANALOG_RE = re.compile(r"тренировочный вариант", re.I)
# Единая система: столько заданий держим в каждой теме. Поднять до 30 —
# поменять одну константу и прогнать добор заново.
TARGET = 15
FIG_RE = re.compile(
    r"на\s+рисунк|изображ[её]н\w*\s+на|показан\w*\s+на|см\.\s*рисун"
    r"|привед[её]н\w*\s+на\s+рисунк", re.I)
WALL_RE = re.compile(r"стен", re.I)
COORD_RE = re.compile(r"\(\d+\s*,\s*\d+\)")
KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint", "hints",
             "solution", "type", "check", "points", "source", "sourceId"]


def usable(r: dict, line: int) -> bool:
    if r.get("images"):
        return False
    text = r.get("condition") or ""
    if FIG_RE.search(text):
        return False
    if line == 18 and WALL_RE.search(text):
        # стены Робота должны быть заданы явно (таблица/координаты),
        # иначе поле без рисунка нерешаемо
        if not (r.get("tables") or COORD_RE.search(text)):
            return False
    ans = (r.get("answer") or "").strip()
    if not ans or "|" in ans:
        return False
    return True


def clean(text: str) -> str:
    return (text or "").strip()


def hints_from(solution: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = "Прочитай условие и ответь на поставленный вопрос."
        return generic, [generic]
    return parts[0], parts[:3]


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def skill_by_line(data: dict) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for s in data.get("skills", []):
        found = re.search(r"№\s*(\d+)", str(s.get("name") or "") + " " + str(s.get("id") or ""))
        if found:
            mapping[int(found.group(1))] = s["id"]
    return mapping


def task_from_source(old: dict, n: int, raw: dict, new_id: str | None = None) -> dict:
    answer = re.sub(r"\s*&\s*", " ", (raw["answer"] or "").strip().strip("."))
    text = clean(raw["condition"])
    hint, hints = hints_from(raw.get("solution") or "")
    task = {
        "id": new_id or old["id"],
        "skill": old["skill"],
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": answer,
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": "short_answer",
        "check": "auto",
        "points": 1,
        "source": f"Решу ЕГЭ (СДАМ ГИА), информатика, задание №{n}, {raw['url']}",
        "sourceId": f"sdamgia-{raw['src_id']}",
    }
    return {k: task[k] for k in KEY_ORDER}


def next_suffix(group: list[dict]) -> int:
    best = 0
    for t in group:
        m = re.search(r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def topup(data: dict, skills: dict[int, str], target: int = TARGET) -> list[dict]:
    """Добрать темы до target новыми id (кроме рисунков №1).
    Существующие задания не трогаем; берём только неиспользованные sourceId."""
    tasks = data["tasks"]
    added: list[dict] = []
    for n in range(1, 28):
        skill = skills.get(n)
        if not skill:
            continue
        if skill == "inf01_graph":
            print(f"№{n:2} {skill:16} пропуск (рисунки-SVG)")
            continue
        group = sorted([t for t in tasks if t["skill"] == skill], key=lambda t: t["id"])
        need = target - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:16} уже {len(group)} — ок")
            continue
        used = {t.get("sourceId") for t in group}
        path = OUT_DIR / f"inf_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r, n) and f"sdamgia-{r['src_id']}" not in used]
        k = next_suffix(group)
        take = pool[:need]
        for r in take:
            new_id = f"inf{n:02d}_p{k}"
            k += 1
            added.append(task_from_source(group[0], n, r, new_id))
        print(f"№{n:2} {skill:16} было {len(group)}, добрано {len(take)}"
              f"{'' if len(take) == need else ' (не хватило пула!)'}")
    return added


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--topup", action="store_true",
                    help="только добрать темы до TARGET, ничего не заменяя")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    skills = skill_by_line(data)
    by_id = {t["id"]: t for t in tasks}

    summary = []
    new_by_id: dict[str, dict] = {}
    for n in range(1, 28):
        skill = skills.get(n)
        if not skill:
            continue
        if skill == "inf01_graph":
            summary.append((n, skill, 0, "рисунки-SVG уже есть — не трогаем"))
            continue
        group = sorted([t for t in tasks if t["skill"] == skill], key=lambda t: t["id"])
        analogs = [t for t in group if ANALOG_RE.search(t.get("source") or "")]
        path = OUT_DIR / f"inf_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r, n)]
        take = min(len(analogs), len(pool))
        note = "ок" if take == len(analogs) and analogs else f"частично {take}/{len(analogs)}"
        summary.append((n, skill, take, note))
        for old_t, r in zip(analogs[:take], pool[:take]):
            new_by_id[old_t["id"]] = task_from_source(old_t, n, r)

    for n, skill, take, note in summary:
        print(f"№{n:2} {skill:16} замен {take} — {note}")

    if args.analyze:
        return 0

    if args.topup:
        added = topup(data, skills)
        data["tasks"] = tasks + added
        data["tasks"].sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
        CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"добрано: {len(added)}; всего: {len(data['tasks'])}")
        return 0

    data["tasks"] = [new_by_id.get(t["id"], t) for t in tasks]
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    left = sum(1 for t in data["tasks"] if ANALOG_RE.search(t.get("source") or ""))
    print(f"заменено: {len(new_by_id)}; осталось аналогов: {left}; всего: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())