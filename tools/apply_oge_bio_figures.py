#!/usr/bin/env python3
"""Добор «рисовальных» тем ОГЭ-биологии реальными заданиями с рисунками.

Текстовый apply_oge_bio.py брал только задания без настоящих рисунков,
поэтому 9 линий остались locked с нулём заданий: №1 (фото), №4 (графики),
№13 (фото морфологии), №14/16 (схемы), №19–21 (фрагменты экосистем),
№22 (рисунки приборов, часть 2). Этот шаг закрывает их как
apply_oge_math_figures.py для математики ОГЭ: тянет задания источника
с настоящим рисунком (get_file), скачивает фигуру в assets/oge_biology
через figure_import, прописывает visual.assetId + visualAssets (+?v= хеш),
снимает locked со скиллов и создаёт им миссии.

Навык разблокируется, только если фигурами реально закрыт (взято > 0);
иначе остаётся locked с честным капом (см. отчёт).

    python3 tools/apply_oge_bio_figures.py --analyze   # что добавится
    python3 tools/apply_oge_bio_figures.py             # импорт + запись
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_oge_bio  # noqa: E402
import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_oge_biology.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 100
SCALE = 2.5
# Линия -> skill. Только locked-рисовальные; текстовые держит apply_oge_bio.
FIGURE_LINES = {
    1: "ob01_science", 4: "ob04_graphics", 13: "ob13_morph",
    14: "ob14_humanfeat", 16: "ob16_humanstruct", 19: "ob19_ecodesc",
    20: "ob20_foodchain", 21: "ob21_biorel", 22: "ob22_biorole",
}


def build_asset(n: int, entry: dict) -> dict:
    ratio = round(entry["width"] / entry["height"], 4) if entry["height"] else 1.0
    return {
        "id": entry["id"],
        "src": entry["file"],
        "type": "image",
        "alt": f"Рисунок к заданию (биология ОГЭ №{n})",
        "width": 640,
        "ratio": ratio,
        "source": f"рисунок источника: {entry['urls'][0] if entry['urls'] else ''}",
    }


def next_id(group: list[dict], prefix: str) -> int:
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
    opened: list[str] = []

    for n, skill in FIGURE_LINES.items():
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        need = TARGET - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:20} уже {len(group)} — ок")
            opened.append(skill)
            continue
        used = {t.get("sourceId") for t in group}
        path = OUT_DIR / f"bio_oge_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        part2 = n in apply_oge_bio.PART2_LINES
        candidates = [r for r in raw
                      if r.get("has_figure")
                      and f"sdamgia-{r['src_id']}" not in used
                      and ((r.get("solution") or "").strip() if part2
                           else (r.get("answer") or "").strip())]
        k = next_id(group, f"ob{n:02d}")
        taken = 0
        for r in candidates:
            if taken >= need:
                break
            pid = str(r["src_id"])
            if args.analyze:
                entry = {"id": f"oge-src{pid}", "file": "?",
                         "urls": [], "width": 0, "height": 0}
            else:
                from io import StringIO
                buf = StringIO()
                old = sys.stderr
                sys.stderr = buf
                try:
                    entry = figure_import.import_task(
                        "bio_oge", pid, args.scale, figures_only=True,
                        no_inline_formulas=True)
                    if entry is None:
                        entry = figure_import.import_task(
                            "bio_oge", pid, args.scale, figures_only=False,
                            no_inline_formulas=False)
                finally:
                    sys.stderr = old
                if not entry:
                    print(f"№{n:2} {skill:20} src {pid}: без фигуры — пропуск")
                    continue
            try:
                task = apply_oge_bio.task_from_source(n, k, r, skill)
            except ValueError as exc:
                print(f"№{n:2} {skill:20} src {pid}: {exc} — пропуск")
                continue
            task["visual"] = {"assetId": entry["id"]}
            added.append(task)
            if entry["id"] not in existing_assets:
                new_assets.append((n, entry))
                existing_assets[entry["id"]] = True
            k += 1
            taken += 1
            print(f"№{n:2} {skill:20} + {task['id']} (src {pid})")
        if taken < need:
            print(f"№{n:2} {skill:20} не хватило: добрано {taken} из {need}")
        if taken > 0:
            opened.append(skill)

    if args.analyze:
        print(f"\nдобавилось бы: {len(added)}")
        return 0

    # Разблокировка навыков: фигуры есть — тема открыта. Без фигур — locked.
    for skill in opened:
        for s in data["skills"]:
            if s.get("id") == skill:
                s.pop("status", None)
                s.pop("locked", None)
                s.pop("comingSoon", None)
    # Миссии новым темам (первые 3 id, как в apply_oge_bio).
    by_skill: dict[str, list[dict]] = {}
    for t in tasks + added:
        by_skill.setdefault(t["skill"], []).append(t)
    for n, skill in FIGURE_LINES.items():
        if skill not in opened:
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
            "desc": f"Все задания №{n} из банка биологии ОГЭ.",
            "tasks": [t["id"] for t in group],
            "xp": 40, "diff": 2 if n in apply_oge_bio.PART2_LINES else 1,
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
          f"миссий: {len(new_missions)}; открыто навыков: {len(opened)}; "
          f"всего: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
