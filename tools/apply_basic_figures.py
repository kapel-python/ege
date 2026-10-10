#!/usr/bin/env python3
"""Добор «рисовальных» тем базовой математики реальными заданиями с рисунками.

Раньше apply_basic.py брал из источника ТОЛЬКО задания без картинок (images==0),
поэтому рисовальные темы так и застряли на 10–13 заданиях. Этот шаг закрывает
их: тянет задания источника, у которых есть настоящий рисунок (get_file),
скачивает фигуру в assets/basic, прописывает в каталог visual.assetId и
visualAssets, и добавляет задание.

Правила:
  * трогаем только темы ниже TARGET (15) из списка FIGURE_SKILLS;
  * официальные задания ФИПИ и уже добавленные не трогаем;
  * инлайновые формулы источника (ege.sdamgia.ru/formula/...) к рисунку не
    относим — берём только get_file-рисунки;
  * у задания может быть несколько фигур (4 графика) — склеиваем в один PNG;
  * схема задачи та же, что у apply_basic (плюс visual).

    python3 tools/apply_basic_figures.py --analyze   # что и сколько добавится
    python3 tools/apply_basic_figures.py             # импорт + запись каталога
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_basic  # noqa: E402
import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_basic.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 15
# Темы, которые без рисунка не решить: их и добираем картинками.
FIGURE_SKILLS = {
    "b07_functions": 7, "b09_grid": 9, "b10_practplan": 10,
    "b11_practstereo": 11, "b12_planimetry": 12, "b13_stereometry": 13,
}


def line_of_skill(skill: str) -> int:
    return int(skill[1:3])


def build_asset(subject: str, n: int, entry: dict) -> dict:
    ratio = round(entry["width"] / entry["height"], 4) if entry["height"] else 1.0
    return {
        "id": entry["id"],
        "src": entry["file"],
        "type": "image",
        "alt": f"Рисунок к заданию (база №{n})",
        "width": 640,
        "ratio": ratio,
        "source": f"рисунок источника: {entry['urls'][0] if entry['urls'] else ''}",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--scale", type=float, default=2.5)
    ap.add_argument("--only", default="",
                    help="ограничить одну тему, например b12_planimetry")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    existing_assets = {a["id"]: a for a in data.get("visualAssets", [])}

    added: list[dict] = []
    new_assets: list[dict] = []

    for skill, n in FIGURE_SKILLS.items():
        if args.only and skill != args.only:
            continue
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        need = TARGET - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:20} уже {len(group)} — ок")
            continue
        used = {t.get("sourceId") for t in group}
        raw_path = OUT_DIR / f"mathb_{n:02d}.json"
        raw = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else []
        candidates = [r for r in raw
                      if r.get("images") and f"sdamgia-{r['src_id']}" not in used]
        sub = group[0].get("sub") if group else f"№{n}"
        k = apply_basic.next_suffix(group, f"b{n:02d}")
        taken = 0
        for r in candidates:
            if taken >= need:
                break
            pid = str(r["src_id"])

            if args.analyze:
                entry = {"id": f"mathb-src{pid}", "file": "?",
                         "urls": [], "width": 0, "height": 0}
            else:
                from io import StringIO
                buf = StringIO()
                old = sys.stderr
                sys.stderr = buf
                try:
                    entry = figure_import.import_task("mathb", pid, args.scale,
                                                      figures_only=True,
                                                      no_inline_formulas=True)
                finally:
                    sys.stderr = old
                if not entry:
                    continue
            task = apply_basic.task_from_source(n, k, r, skill)
            task["sub"] = sub
            task["visual"] = {"assetId": entry["id"]}
            added.append(task)
            if entry["id"] not in existing_assets:
                new_assets.append(build_asset("mathb", n, entry))
                existing_assets[entry["id"]] = True
            k += 1
            taken += 1
            print(f"№{n:2} {skill:20} + {task['id']} (src {pid}, фигур {len(entry['urls'])})")
        if taken < need:
            print(f"№{n:2} {skill:20} не хватило: добрано {taken} из {need}")

    if args.analyze:
        print(f"\nдобавилось бы: {len(added)}; тем затронуто: {len(new_assets)}")
        return 0

    data["tasks"] = tasks + added
    data["tasks"].sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    data.setdefault("visualAssets", [])
    data["visualAssets"].extend(new_assets)
    audit = data.get("visualAudit")
    if isinstance(audit, dict):
        audit.setdefault("taskStatuses", {})
        for t in added:
            audit["taskStatuses"][t["id"]] = "visual-provided"
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    print(f"\nдобрано заданий: {len(added)}; новых рисунков: {len(new_assets)}; "
          f"всего заданий: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())