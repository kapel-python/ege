#!/usr/bin/env python3
"""Добор «рисовальных» тем обществознания реальными заданиями с рисунками.

№9 (диаграммы опросов) — часть 1, автопроверка; №21 (графики спроса и
предложения) — часть 2, самопроверка. У обоих заданий источник отдаёт рисунок
настоящим файлом (get_file), поэтому тянем его в assets/society и прописываем
visual.assetId + запись в visualAssets.

Правила:
  * №9: существующие пять настоящих диаграмм не трогаем, добираем до TARGET;
  * №21: пять самописных «тренажёров с описанным текстом» заменяем настоящими
    (сохраняя id — на них ссылаются миссии);
  * инлайновые формулы источника к рисунку не относим;
  * у задания может быть несколько картинок — figure_import склеивает их в PNG.

    python3 tools/apply_society_figures.py --analyze
    python3 tools/apply_society_figures.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_society.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 100

# линия -> (skill, режим проверки)
FIGURE = {
    9: ("soc09_diagram", "auto"),
    21: ("soc21_graph", "self"),
}
ANALOG_RE = re.compile(r"тренировочный вариант|тренажёр|описан текстом|формат демоверсии", re.I)

HINT1 = "Внимательно прочитай данные рисунка и отвечай по каждому пункту отдельно."
HINT2 = "Сверь числа/надписи на рисунке с условием и не путай рост и падение."


def next_suffix(group: list[dict]) -> int:
    best = 0
    for t in group:
        m = re.search(r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def build_asset(n: int, entry: dict) -> dict:
    ratio = round(entry["width"] / entry["height"], 4) if entry["height"] else 1.0
    return {
        "id": entry["id"],
        "src": entry["file"],
        "type": "image",
        "alt": f"Рисунок к заданию (общество №{n})",
        "width": 640,
        "ratio": ratio,
        "source": f"рисунок источника: {entry['urls'][0] if entry['urls'] else ''}",
    }


def build(old: dict, n: int, raw: dict, new_id: str, mode: str, asset_id: str) -> dict:
    text = (raw["condition"] or "").strip()
    solution = (raw["solution"] or "").strip()
    answer = (raw["answer"] or "").strip()
    task = {
        "id": new_id,
        "skill": old["skill"],
        "sub": old.get("sub") or f"№{n}",
        "num": old.get("num") or f"№{n}",
        "diff": old.get("diff", 1),
        "text": text,
        "hint": HINT1,
        "hints": [HINT1, HINT2, solution],
        "solution": solution,
        "type": "short_answer",
        "points": old.get("points", 1),
        "source": f"Решу ЕГЭ (СДАМ ГИА), обществознание, задание №{n}, {raw['url']}",
        "sourceId": f"sdamgia-{raw['src_id']}",
        "visual": {"assetId": asset_id},
    }
    if mode == "self":
        task["answer"] = solution
        task["check"] = "self"
        task["selfCheck"] = True
    else:
        alts = [x.strip() for x in answer.split("|") if x.strip()]
        task["answer"] = alts[0] if alts else answer
        if len(alts) > 1:
            task["accept"] = alts
    return task


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--scale", type=float, default=2.5)
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    by_id = {t["id"]: t for t in tasks}
    existing_assets = {a["id"]: a for a in data.get("visualAssets", [])}
    audit = data.get("visualAudit")
    statuses = audit.setdefault("taskStatuses", {}) if isinstance(audit, dict) else {}

    new_tasks: list[dict] = []
    new_assets: list[dict] = []
    replaced_ids: set[str] = set()
    report: list[str] = []

    for n, (skill, mode) in FIGURE.items():
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        raw_path = OUT_DIR / f"soc_{n:02d}.json"
        raw = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else []
        cand = [r for r in raw if r.get("images")]
        used = {t.get("sourceId") for t in group}

        # замена самописных аналогов на настоящие (id сохраняем)
        analogs = [t for t in group if ANALOG_RE.search(t.get("source") or "")]
        avail = [r for r in cand if f"sdamgia-{r['src_id']}" not in used]
        ci = 0
        for old_t in analogs:
            if ci >= len(avail):
                break
            r = avail[ci]
            pid = str(r["src_id"])
            if args.analyze:
                entry = {"id": f"soc-src{pid}", "file": "?", "urls": [], "width": 0, "height": 0}
            else:
                from io import StringIO
                buf = StringIO()
                saved = sys.stderr
                sys.stderr = buf
                try:
                    entry = figure_import.import_task("soc", pid, args.scale, figures_only=True)
                finally:
                    sys.stderr = saved
                if not entry:
                    continue
            by_id[old_t["id"]] = build(old_t, n, r, old_t["id"], mode, entry["id"])
            statuses[old_t["id"]] = "visual-provided"
            replaced_ids.add(old_t["id"])
            if entry["id"] not in existing_assets:
                new_assets.append(build_asset(n, entry))
                existing_assets[entry["id"]] = True
            ci += 1

        # добор до TARGET
        used = {t.get("sourceId") for t in group} | {f"sdamgia-{r['src_id']}" for r in avail[:ci]}
        pool = [r for r in cand if f"sdamgia-{r['src_id']}" not in used]
        k = next_suffix(group)
        taken = 0
        for r in pool:
            if len(group) + taken >= TARGET:
                break
            pid = str(r["src_id"])
            if args.analyze:
                entry = {"id": f"soc-src{pid}", "file": "?", "urls": [], "width": 0, "height": 0}
            else:
                from io import StringIO
                buf = StringIO()
                saved = sys.stderr
                sys.stderr = buf
                try:
                    entry = figure_import.import_task("soc", pid, args.scale, figures_only=True)
                finally:
                    sys.stderr = saved
                if not entry:
                    continue
            new_id = f"soc{n:02d}_p{k}"
            task = build(group[0], n, r, new_id, mode, entry["id"])
            new_tasks.append(task)
            statuses[new_id] = "visual-provided"
            if entry["id"] not in existing_assets:
                new_assets.append(build_asset(n, entry))
                existing_assets[entry["id"]] = True
            k += 1
            taken += 1
        total = len(group) + taken
        report.append(f"№{n:2} {skill:14} было {len(group):3}, замен {ci}, "
                      f"добрано {taken:3} → {total:3}"
                      f"{'' if total >= TARGET else ' (потолок источника)'}")

    for line in report:
        print(line)

    if args.analyze:
        print(f"\nдобавилось бы {len(new_tasks)} заданий, новых рисунков {len(new_assets)}")
        return 0

    # дедупликация: by_id уже содержит замены; добавим только добор
    data["tasks"] = sorted(list(by_id.values()) + new_tasks,
                           key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    data.setdefault("visualAssets", [])
    data["visualAssets"].extend(new_assets)
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nзаменено {len(replaced_ids)}; добрано {len(new_tasks)}; "
          f"новых рисунков {len(new_assets)}; всего заданий {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())