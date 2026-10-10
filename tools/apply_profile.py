#!/usr/bin/env python3
"""Замена самописных «аналогов» в профильном каталоге на реальные задания.

Правила (те же, что для базы/русского):
  * меняем ТОЛЬКО тестовую (короткий ответ, часть 1) часть предмета;
  * «развёрнутые» темы (№14–20, extended_answer) не трогаем;
  * официальные задания (демо/openbank) и задания с рисунками сохраняем — там
    уже всё верно; рисунки источника растровые и часто по несколько на задание,
    наш рендер их не покажет;
  * вместо каждого аналога берём реальное задание источника без картинок
    (images == 0) и без ссылок на отсутствующий рисунок;
  * источник — Решу ЕГЭ (СДАМ ГИА), профиль: https://math-ege.sdamgia.ru.

    python3 tools/apply_profile.py --analyze   # сводка, ничего не пишет
    python3 tools/apply_profile.py             # переписать server/catalog.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog.json"
OUT_DIR = ROOT / "tools" / "out"

ANALOG_RE = re.compile(r"analog", re.I)
FIG_RE = re.compile(
    r"на\s+рисунк|на\s+график|на\s+диаграмм|на\s+схем|изображ[её]н"
    r"|показан\w*\s+на\s+рисунк|см\.\s*рисун", re.I)
DECIMAL_RE = re.compile(r"[+-]?\d+[.,]\d+")
INTEGER_RE = re.compile(r"[+-]?\d+")
KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint", "hints",
             "solution", "type", "sourceId", "status", "example", "points",
             "valueType", "source"]


def classify(answer: str) -> str | None:
    a = answer.strip().strip(".")
    if INTEGER_RE.fullmatch(a):
        return "целое число"
    if DECIMAL_RE.fullmatch(a):
        return "конечная десятичная дробь"
    return None


def clean(text: str) -> str:
    text = (text or "").strip()
    return re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)


def hints_from(solution: str, answer: str) -> tuple[str, list[str]]:
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


def usable(r: dict) -> bool:
    """Годится ли задание источника: без картинок, без ссылок на рисунок,
    ответ — число/десятичная дробь (в профиле нет поля accept для вариантов)."""
    if r.get("images"):
        return False
    if FIG_RE.search(r.get("condition") or ""):
        return False
    if "|" in (r.get("answer") or ""):
        return False
    return classify(r.get("answer") or "") is not None


def task_from_source(new_id: str, n: int, idx: int, raw: dict, skill: str) -> dict:
    answer = (raw["answer"] or "").strip().strip(".")
    text = clean(raw["condition"])
    value_type = classify(answer) or "целое число"
    hint, hints = hints_from(raw.get("solution") or "", answer)
    task = {
        "id": new_id,
        "skill": skill,
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": answer,
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": "short_answer",
        "sourceId": f"sdamgia-{raw['src_id']}",
        "status": "sdamgia",
        "example": idx,
        "points": 1,
        "valueType": value_type,
        "source": f"Решу ЕГЭ (СДАМ ГИА), профиль, задание №{n}, {raw['url']}",
    }
    return {k: task[k] for k in KEY_ORDER}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    skills = skill_by_line(data)
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)

    replacements: dict[str, list[dict]] = {}
    summary = []

    for n in range(1, 22):
        skill = skills.get(n)
        if not skill or skill not in by_skill:
            continue
        group = by_skill[skill]
        if any(t.get("type") != "short_answer" for t in group):
            summary.append((n, skill, 0, 0, "развёрнутая — не трогаем"))
            continue
        analogs = sorted([t for t in group if ANALOG_RE.search(t.get("status") or "")],
                         key=lambda t: t["id"])
        if not analogs:
            summary.append((n, skill, 0, 0, "аналогов нет"))
            continue
        path = OUT_DIR / f"math_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r)]
        take = min(len(analogs), len(pool))
        note = "ок" if take == len(analogs) else f"частично {take}/{len(analogs)}"
        summary.append((n, skill, len(analogs), len(pool), note))
        if take == 0:
            continue
        new_tasks = [task_from_source(a["id"], n, i, r, skill)
                     for i, (a, r) in enumerate(zip(analogs[:take], pool[:take]), 1)]
        replacements[skill] = new_tasks

    for n, skill, n_an, n_pool, note in summary:
        print(f"№{n:2} {skill:18} аналогов {n_an:2}, источник {n_pool:2} — {note}")

    if args.analyze:
        return 0

    # Подменяем аналоговые задания, официальные (в т.ч. с рисунками) остаются.
    replaced_ids = {t["id"] for ts in replacements.values() for t in ts}
    kept = [t for t in tasks if t["id"] not in replaced_ids]
    merged = kept + [t for ts in replacements.values() for t in ts]
    merged.sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    data["tasks"] = merged

    audit = data.get("visualAudit")
    if isinstance(audit, dict) and isinstance(audit.get("taskStatuses"), dict):
        for tid in replaced_ids:
            audit["taskStatuses"][tid] = "text-only"

    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    left = sum(1 for t in data["tasks"] if ANALOG_RE.search(t.get("status") or ""))
    print(f"заменено аналогов: {len(replaced_ids)}; осталось аналогов в базе тестов: "
          f"{sum(1 for t in data['tasks'] if ANALOG_RE.search(t.get('status') or '') and t.get('type')=='short_answer')}"
          f" (+ развёрнутые: {sum(1 for t in data['tasks'] if ANALOG_RE.search(t.get('status') or '') and t.get('type')!='short_answer')})")
    print(f"всего заданий: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())