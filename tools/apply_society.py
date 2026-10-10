#!/usr/bin/env python3
"""Замена оставшихся аналогов тестовой части обществознания (№1–16).

Правила:
  * 29 задач, уже заменённых дословными демо ФИПИ-2027/2026 (проверены
    tools/verify_society_fipi.py: ключи 1-в-1, лексика 96–100%), не трогаем;
  * темы с готовыми рисунками (№9 опросы, №16 слайд p2, №21 графики) не
    трогаем: источник отдаёт диаграммы растром;
  * тренажёры части 2 (№17–20, №22–25, check/selfCheck) не трогаем;
  * остальным аналогам (p3–p5 обычных тем, p3–p5 темы №16) подставляем реальные
    задания источника без картинок и без ссылок на рисунок; id сохраняем;
  * ответы с вариантами «a|b» кладём в accept (движок его понимает);
  * набор ключей каждой задачи сохраняем (accept — только при вариантах).

    python3 tools/apply_society.py --analyze
    python3 tools/apply_society.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_society.json"
OUT_DIR = ROOT / "tools" / "out"

ANALOG_RE = re.compile(r"тренировочный вариант", re.I)
# Единая система: столько заданий держим в каждой теме. Поднять до 30 —
# поменять одну константу и прогнать добор заново.
TARGET = 15
FIG_RE = re.compile(
    r"на\s+рисунк|на\s+диаграмм|на\s+график|изображ[её]н|показан\w*\s+на"
    r"|см\.\s*рисун", re.I)
# Темы тестовой части, которые берём (№9 и №21 — только рисунки, пропуск).
SKIP_SKILLS = {"soc09_diagram", "soc21_graph"}
BASE_KEYS = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint", "hints",
             "solution", "type", "points", "source", "sourceId"]


def usable(r: dict) -> bool:
    if r.get("images"):
        return False
    if FIG_RE.search(r.get("condition") or ""):
        return False
    ans = (r.get("answer") or "").strip()
    if not ans or not re.fullmatch(r"[0-9|]+", ans):
        return False
    return True


def hints_from(solution: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = "Прочитай условие и выбери верные позиции."
        return generic, [generic]
    return parts[0], parts[:3]


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def task_from_source(old: dict, n: int, raw: dict, new_id: str | None = None) -> dict:
    alts = [x.strip() for x in (raw["answer"] or "").split("|") if x.strip()]
    text = (raw["condition"] or "").strip()
    text = re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)
    hint, hints = hints_from(raw.get("solution") or "")
    task = {
        "id": new_id or old["id"],
        "skill": old["skill"],
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": alts[0],
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": "short_answer",
        "points": 1,
        "source": f"Решу ЕГЭ (СДАМ ГИА), обществознание, задание №{n}, {raw['url']}",
        "sourceId": f"sdamgia-{raw['src_id']}",
    }
    out = {k: task[k] for k in BASE_KEYS if k in task}
    # прочие ключи старой задачи (check/selfCheck/visual) сохраняем как были
    for k, v in old.items():
        if k not in out:
            out[k] = v
    if len(alts) > 1:
        out["accept"] = alts
    return out


def next_suffix(group: list[dict]) -> int:
    best = 0
    for t in group:
        m = re.search(r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def topup(data: dict, target: int = TARGET) -> list[dict]:
    """Добрать тестовые темы (№1–16, кроме рисунков) до target новыми id.
    Существующие задания не трогаем; берём только неиспользованные sourceId."""
    tasks = data["tasks"]
    added: list[dict] = []
    for n in range(1, 17):
        skill = f"soc{n:02d}_" + {
            1: "concepts", 2: "society", 3: "match", 4: "situ", 5: "econ",
            6: "factors", 7: "market", 8: "socrel", 9: "diagram", 10: "polity",
            11: "party", 12: "rights", 13: "fed", 14: "law", 15: "tax",
            16: "slide"}[n]
        if skill in SKIP_SKILLS:
            print(f"№{n:2} {skill:16} пропуск (рисунки)")
            continue
        group = sorted([t for t in tasks if t["skill"] == skill], key=lambda t: t["id"])
        need = target - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:16} уже {len(group)} — ок")
            continue
        used = {t.get("sourceId") for t in group}
        path = OUT_DIR / f"soc_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r) and f"sdamgia-{r['src_id']}" not in used]
        k = next_suffix(group)
        take = pool[:need]
        for r in take:
            new_id = f"soc{n:02d}_p{k}"
            k += 1
            added.append(task_from_source(group[0], n, r, new_id))
        print(f"№{n:2} {skill:16} было {len(group)}, добрано {len(take)}"
              f"{'' if len(take) == need else f' (не хватило пула!)'}")
    return added


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--topup", action="store_true",
                    help="только добрать темы до TARGET, ничего не заменяя")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    summary = []
    new_by_id: dict[str, dict] = {}

    for n in range(1, 17):
        skill = f"soc{n:02d}_" + {
            1: "concepts", 2: "society", 3: "match", 4: "situ", 5: "econ",
            6: "factors", 7: "market", 8: "socrel", 9: "diagram", 10: "polity",
            11: "party", 12: "rights", 13: "fed", 14: "law", 15: "tax",
            16: "slide"}[n]
        group = sorted([t for t in tasks if t["skill"] == skill], key=lambda t: t["id"])
        if skill in SKIP_SKILLS:
            summary.append((n, skill, 0, "рисунки — не трогаем"))
            continue
        analogs = [t for t in group
                   if ANALOG_RE.search(t.get("source") or "") and "visual" not in t]
        path = OUT_DIR / f"soc_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r)]
        take = min(len(analogs), len(pool))
        summary.append((n, skill, take,
                        "ок" if take == len(analogs) else f"частично {take}/{len(analogs)}"))
        for old_t, r in zip(analogs[:take], pool[:take]):
            new_by_id[old_t["id"]] = task_from_source(old_t, n, r)

    for n, skill, take, note in summary:
        print(f"№{n:2} {skill:16} замен {take} — {note}")

    if args.analyze:
        return 0

    if args.topup:
        added = topup(data)
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