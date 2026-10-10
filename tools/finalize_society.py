#!/usr/bin/env python3
"""Финальная чистка каталога обществознания после импорта.

Что делает:
  1) убирает шаблонный рубричный «мусор» из решений части 2 («Ответы на
     вопросы могут быть даны в иных формулировках…» и родственные обороты) —
     это инструкция источника, а не часть модельного ответа;
  2) заменяет реальным заданием единственный оставшийся самописный аналог
     (`soc16_p2`) и дубликаты-двойники, у которых совпадает текст с другим
     заданием. id сохраняем: на p1–p5 ссылаются миссии, на p1 — диагностика.

Важно: 29 задач с источником «Демоверсия ЕГЭ-2026/2027» — это официальные
ФИПИ-демо, они не дубликаты и не аналоги, их не трогаем.

    python3 tools/finalize_society.py --analyze
    python3 tools/finalize_society.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_society as part1          # noqa: E402
import apply_society_part2 as part2    # noqa: E402
import apply_society_figures as figs   # noqa: E402
import figure_import                   # noqa: E402

CATALOG = ROOT / "server" / "catalog_society.json"
OUT_DIR = ROOT / "tools" / "out"

# Шаблонные обороты рубрики, которые источник дописывает в блок пояснения.
BOILERPLATE = [
    re.compile(r"Элементы ответа могут быть (?:даны|представлены)[^.]*\.\s*"),
    re.compile(r"Ответы на вопрос\w* могут быть (?:даны|представлены)[^.]*\.\s*"),
    re.compile(r"Объяснения могут быть приведены[^.]*\.\s*"),
    re.compile(r"Условия могут быть представлены[^.]*\.\s*"),
]

# id -> (линия, режим); replace содержимое, сохраняя id и «шапку» задачи.
TARGETS = [
    ("soc01_p7", 1, "auto"),
    ("soc02_p47", 2, "auto"),
    ("soc05_p52", 5, "auto"),
    ("soc16_p2", 16, "auto"),
    ("soc09_p96", 9, "figure"),
    ("soc22_p77", 22, "self"),
    ("soc23_p29", 23, "self"),
    ("soc23_p44", 23, "self"),
    ("soc24_p75", 24, "self"),
]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def clean_boilerplate(text: str) -> str:
    out = text or ""
    for rx in BOILERPLATE:
        out = rx.sub("", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out or (text or "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    by_id = {t["id"]: t for t in tasks}
    assets = {a["id"]: a for a in data.get("visualAssets", [])}
    audit = data.get("visualAudit")
    statuses = audit.setdefault("taskStatuses", {}) if isinstance(audit, dict) else {}

    # 1) рубричный мусор
    cleaned = 0
    for t in tasks:
        new_sol = clean_boilerplate(t.get("solution") or "")
        new_ans = clean_boilerplate(t.get("answer") or "")
        if new_sol != (t.get("solution") or "") or new_ans != (t.get("answer") or ""):
            cleaned += 1
            if not args.analyze:
                t["solution"] = new_sol
                t["answer"] = new_ans

    # 2) замена аналога и дублей
    target_ids = {tid for tid, _, _ in TARGETS}
    present = {norm(t.get("text")) for t in tasks if t["id"] not in target_ids}
    used_src = {t.get("sourceId") for t in tasks}
    new_assets: list[dict] = []
    report: list[str] = []
    dropped: list[str] = []

    for tid, n, kind in TARGETS:
        old = by_id.get(tid)
        if not old:
            report.append(f"{tid}: НЕТ в каталоге")
            continue
        raw_path = OUT_DIR / f"soc_{n:02d}.json"
        raw = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else []

        if kind == "self":
            pool = [r for r in raw if part2.usable(r, n)]
        elif kind == "figure":
            pool = [r for r in raw if r.get("images")]
        else:
            pool = [r for r in raw if part1.usable(r)]

        chosen = None
        for r in pool:
            sid = f"sdamgia-{r['src_id']}"
            if sid in used_src:
                continue
            cond = re.sub(r"(?m)^(\s*)A\)", r"\1А)", (r.get("condition") or "").strip())
            if norm(cond) in present:
                continue
            chosen = r
            break
        if not chosen:
            # Дубль, который нечем заменить: в источнике просто нет других
            # уникальных заданий этой линии. Удаляем, чтобы не показывать
            # одно и то же дважды.
            dropped.append(tid)
            by_id.pop(tid, None)
            report.append(f"{tid}: дубль без замены — удалён (потолок линии {n})")
            continue

        if args.analyze:
            report.append(f"{tid} ← линия {n} pid={chosen['src_id']} ({kind})")
            continue

        if kind == "figure":
            entry = figure_import.import_task("soc", str(chosen["src_id"]), 2.5, figures_only=True)
            if not entry:
                report.append(f"{tid}: рисунок не импортировался (pid={chosen['src_id']})")
                continue
            by_id[tid] = figs.build(old, n, chosen, tid, "auto", entry["id"])
            statuses[tid] = "visual-provided"
            if entry["id"] not in assets:
                assets[entry["id"]] = figs.build_asset(n, entry)
                new_assets.append(figs.build_asset(n, entry))
        elif kind == "self":
            by_id[tid] = part2.build(old, n, chosen, tid)
        else:
            by_id[tid] = part1.task_from_source(old, n, chosen, tid)

        used_src.add(f"sdamgia-{chosen['src_id']}")
        present.add(norm(by_id[tid].get("text")))
        report.append(f"{tid} ← линия {n} pid={chosen['src_id']} ({kind})")

    for line in report:
        print(line)
    print(f"\nрубричный мусор вычищен у {cleaned} заданий; заменено "
          f"{sum(1 for l in report if '←' in l)}; удалено дублей {len(dropped)}: {dropped}")

    if args.analyze:
        return 0

    data["tasks"] = sorted(by_id.values(), key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    if new_assets:
        data.setdefault("visualAssets", [])
        data["visualAssets"].extend(new_assets)
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"записано: заданий {len(data['tasks'])}, ассетов {len(data.get('visualAssets', []))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())