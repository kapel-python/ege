#!/usr/bin/env python3
"""Естественный порядок заданий внутри темы.

Задания добавлялись пачками с id вида b08_p1 … p15, но массив сортировался как
строки: p1, p10, p11, …, p15, p2, p3 — из-за этого практика в миссии шла в
странном порядке, а подписи ошибок («задание N из M») врали. Сортируем задачи
внутри каждой темы по числовому суффиксу. Содержимое заданий не меняется.

    python3 tools/sort_tasks.py --analyze
    python3 tools/sort_tasks.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGS = ["catalog.json", "catalog_basic.json", "catalog_society.json",
            "catalog_informatics.json", "catalog_biology.json",
            "catalog_russian.json"]


def natural(task: dict) -> tuple:
    tid = str(task.get("id") or "")
    m = re.match(r"^(.*?)(\d+)$", tid)
    if not m:
        return (tid, 0)
    return (m.group(1), int(m.group(2)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    for name in CATALOGS:
        path = ROOT / "server" / name
        data = json.loads(path.read_text(encoding="utf-8"))
        tasks = data.get("tasks")
        if not isinstance(tasks, list):
            continue
        groups: dict[str, list[dict]] = {}
        order: list[str] = []
        for t in tasks:
            sk = str(t.get("skill") or "")
            if sk not in groups:
                groups[sk] = []
                order.append(sk)
            groups[sk].append(t)
        moved = 0
        for sk in groups:
            before = [t.get("id") for t in groups[sk]]
            groups[sk].sort(key=natural)
            after = [t.get("id") for t in groups[sk]]
            if before != after:
                moved += 1
        if not moved:
            print(f"{name}: порядок уже естественный")
            continue
        # темы остаются в исходном порядке, задания внутри отсортированы
        data["tasks"] = [t for sk in order for t in groups[sk]]
        print(f"{name}: переупорядочено тем {moved}")
        if not args.analyze:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())