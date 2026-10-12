#!/usr/bin/env python3
"""Добор «рисовальных» тем ОГЭ-истории реальными заданиями с рисунками.

Текстовый apply_oge_hist.py брал только задания без наглядности, поэтому
№8–14 (карты, иллюстрации, схемы, культура с изображениями) остались locked
с нулём заданий. Этот шаг закрывает их как apply_oge_math_figures.py:
тянет задания источника с настоящим рисунком (get_file), скачивает фигуру
в assets/oge_history через figure_import, прописывает visual.assetId +
visualAssets (+?v= хеш), снимает locked со скиллов и создаёт им миссии.

    python3 tools/apply_oge_hist_figures.py --analyze   # что добавится
    python3 tools/apply_oge_hist_figures.py             # импорт + запись
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_oge_hist  # noqa: E402
import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_oge_history.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 100
SCALE = 2.5
# Линия -> skill. Только locked-визуальные; текстовые ведёт apply_oge_hist.
FIGURE_LINES = {
    8: "oh08_map",
    9: "oh09_map2",
    10: "oh10_map3",
    11: "oh11_images",
    12: "oh12_scheme",
    13: "oh13_culture",
    14: "oh14_culture2",
}


def build_asset(n: int, entry: dict) -> dict:
    ratio = round(entry["width"] / entry["height"], 4) if entry["height"] else 1.0
    return {
        "id": entry["id"],
        "src": entry["file"],
        "type": "image",
        "alt": f"Рисунок к заданию (ОГЭ, история, №{n})",
        "width": 640,
        "ratio": ratio,
        "source": f"рисунок источника: {entry['urls'][0] if entry['urls'] else ''}",
    }


def next_id(group: list[dict], prefix: str) -> int:
    import re
    best = 0
    for t in group:
        m = re.match(re.escape(prefix) + r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--scale", type=float, default=SCALE)
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    existing_assets = {a["id"]: a for a in data.get("visualAssets", [])}
    existing_missions = {m["id"] for m in data.get("missions", [])}
    added, new_assets, new_missions = [], [], []
    unlocked: list[str] = []

    for n, skill in FIGURE_LINES.items():
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        need = TARGET - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:20} уже {len(group)} — ок")
            unlocked.append(skill)
            continue
        used = {t.get("sourceId") for t in group}
        raw = json.loads((OUT_DIR / f"hist_oge_{n:02d}.json").read_text(encoding="utf-8")) \
            if (OUT_DIR / f"hist_oge_{n:02d}.json").exists() else []
        candidates = [r for r in raw
                      if r.get("has_figure") and f"sdamgia-{r['src_id']}" not in used
                      and apply_oge_hist.norm_variants(r.get("answer") or "")]
        k = next_id(group, f"oh{n:02d}")
        taken = 0
        for r in candidates:
            if taken >= need:
                break
            pid = str(r["src_id"])
            if args.analyze:
                entry = {"id": f"hist_oge-src{pid}", "file": "?",
                         "urls": [], "width": 0, "height": 0}
            else:
                from io import StringIO
                buf = StringIO()
                old = sys.stderr
                sys.stderr = buf
                try:
                    entry = figure_import.import_task(
                        "hist_oge", pid, args.scale, figures_only=True,
                        no_inline_formulas=True)
                    if entry is None:
                        entry = figure_import.import_task(
                            "hist_oge", pid, args.scale, figures_only=False,
                            no_inline_formulas=False)
                finally:
                    sys.stderr = old
                if not entry:
                    continue
            task = apply_oge_hist.task_from_source(n, k, r, skill)
            task["visual"] = {"assetId": entry["id"]}
            added.append(task)
            if entry["id"] not in existing_assets:
                new_assets.append((n, entry))
                existing_assets[entry["id"]] = True
            k += 1
            taken += 1
            print(f"№{n:2} {skill:20} + {task['id']} (src {pid})")
        if taken:
            unlocked.append(skill)
        if taken < need:
            print(f"№{n:2} {skill:20} не хватило: добрано {taken} из {need}")

    if args.analyze:
        print(f"\nдобавилось бы: {len(added)}")
        return 0

    # Разблокировка навыков: фигуры есть — тема открыта.
    for skill in unlocked:
        for s in data["skills"]:
            if s.get("id") == skill:
                s.pop("status", None)
                s.pop("locked", None)
                s.pop("comingSoon", None)
    # Миссии новым темам (первые 3 id, как в apply_oge_hist).
    by_skill: dict[str, list[dict]] = {}
    for t in tasks + added:
        by_skill.setdefault(t["skill"], []).append(t)
    for n, skill in FIGURE_LINES.items():
        if skill not in unlocked:
            continue
        mid = f"m-{skill}"
        if mid in existing_missions:
            continue
        group = sorted(by_skill.get(skill, []), key=lambda t: t["id"])[:3]
        if not group:
            continue
        name = next(s["name"] for s in data["skills"] if s["id"] == skill)
        new_missions.append({
            "id": mid, "skill": skill,
            "title": f"Практика: {name}",
            "desc": f"Все задания №{n} из банка истории ОГЭ.",
            "tasks": [t["id"] for t in group],
            "xp": 40, "diff": 1,
        })
    data["missions"] = data.get("missions", []) + new_missions
    data["tasks"] = tasks + added
    data["tasks"].sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    assets = []
    for n, entry in new_assets:
        a = build_asset(n, entry)
        f = ROOT / a["src"].split("?", 1)[0]
        if f.exists():
            a["src"] = f"{a['src']}?v={hashlib.md5(f.read_bytes()).hexdigest()[:10]}"
        assets.append(a)
    data.setdefault("visualAssets", [])
    data["visualAssets"].extend(assets)
    audit = data.get("visualAudit")
    if isinstance(audit, dict):
        audit.setdefault("taskStatuses", {})
        for t in added:
            audit["taskStatuses"][t["id"]] = "visual-provided"
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    print(f"\nдобрано заданий: {len(added)}; новых рисунков: {len(assets)}; "
          f"миссий: {len(new_missions)}; всего: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
