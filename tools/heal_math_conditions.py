#!/usr/bin/env python3
"""Лечение условий заданий-картинок профиля: убрать словесные вставки формул.

Выгрузка линий 3+ шла кодом, подставлявшим словесный alt формул прямо
в условие. У заданий-картинок формула и так лежит картинкой — слова
дублируют её и нарушают правило «условие как на экзамене». Перекачиваем
условия БЕЗ подмены (дыры вместо формул — как в линиях 1–2, честно
и единообразно), картинки/ответы/решения не трогаем.

    python3 tools/heal_math_conditions.py --analyze
    python3 tools/heal_math_conditions.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_profile as base  # noqa: E402
import sdamgia_import as S  # noqa: E402
from apply_profile_topup import tidy  # noqa: E402

CATALOG = ROOT / "server" / "catalog.json"
BASE = S.SUBJECTS["math"]

MARK = re.compile(r"числитель:|знаменатель:|конец дроби|начало аргумента|"
                  r"конец совокупности|новая строка|вектор |логарифм по основанию")


def plain_condition(pid: str) -> str:
    """Условие страницы без словесной подмены формул (картинки — дыры)."""
    page = S.get(BASE, f"/problem?id={pid}")
    anchor = S.SOL_ANCHOR_RE.search(page)
    if not anchor:
        raise RuntimeError("нет блока решения")
    head = page[:anchor.start()]
    cut = head.rfind("<a ")
    if cut != -1:
        head = head[:cut]
    body = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    if not body:
        raise RuntimeError("нет блока условия")
    text = S.strip_markup(head[body.end():])
    pm = re.search(r'id="text\d+"', page)
    if pm:
        passage = S.strip_markup(S.extract_div(page, pm))
        if passage:
            text = passage + "\n\n" + text
    return tidy(base.clean(text))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = [t for t in data["tasks"]
             if (t.get("visual") or {}).get("assetId")
             and MARK.search(t.get("text") or "")
             and (t.get("sourceId") or "").startswith("sdamgia-")]
    print(f"лечить условий: {len(tasks)}")
    if args.analyze:
        return 0

    def job(t: dict) -> tuple[str, str | None]:
        pid = t["sourceId"].replace("sdamgia-", "")
        try:
            return t["id"], plain_condition(pid)
        except Exception as exc:
            print(f"  FAIL {t['id']}: {exc}")
            return t["id"], None

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for tid, text in pool.map(job, tasks):
            if text:
                next(t for t in data["tasks"] if t["id"] == tid)["text"] = text
            done += 1
            if done % 100 == 0:
                print(f"  ... {done}/{len(tasks)}")

    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    left = sum(1 for t in data["tasks"]
               if (t.get("visual") or {}).get("assetId") and MARK.search(t.get("text") or ""))
    print(f"записано, осталось со вставками: {left}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
