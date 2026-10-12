#!/usr/bin/env python3
"""Добор legacy-заданий части 2 истории (понятия, аргументы, тезисы).

Новые пулы prob20/prob22 мелкие (по 16 заданий), а legacy-блоки
3996x-3998x и 5391x-5395x содержат формат «раскройте смысл понятия + факт»
(экзамен №19) россыпью с другими жанрами. Идём по диапазонам id подряд,
классифицируем жанр и складываем в пулы. Идемпотентно (слияние по src_id).

    python3 tools/harvest_history_legacy.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import sdamgia_import as S  # noqa: E402

BASE = S.SUBJECTS["his"]
OUT_DIR = ROOT / "tools" / "out"

RANGES = [(39900, 40150), (53700, 54200)]


def genre(cond: str) -> str | None:
    c = (cond or "").lower()
    if "раскройте смысл понятия" in c:
        return "terms"
    if "тезис" in c:
        return "thesis"
    if "аргумент" in c:
        return "args"
    if "вспомните смысл понятия" in c:
        return "termsq"
    return None


def load(name: str) -> dict:
    p = OUT_DIR / name
    if not p.exists():
        return {}
    try:
        return {str(it.get("src_id")): it for it in json.loads(p.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {}


def main() -> int:
    terms = load("his_legacy_terms.json")
    args = load("his_legacy_args.json")
    thesis = load("his_legacy_thesis.json")
    termsq = load("his_legacy_termsq.json")
    store = {"terms": terms, "args": args, "thesis": thesis, "termsq": termsq}
    files = {"terms": "his_legacy_terms.json", "args": "his_legacy_args.json",
             "thesis": "his_legacy_thesis.json", "termsq": "his_legacy_termsq.json"}
    n_new = 0
    for lo, hi in RANGES:
        for pid in range(lo, hi + 1):
            pid = str(pid)
            if pid in terms or pid in args or pid in thesis:
                continue
            try:
                r = S.parse_problem(BASE, pid)
            except Exception:
                continue
            g = genre(r.get("condition") or "")
            if g:
                store[g][pid] = r
                n_new += 1
                print(f"  {pid} {g} :: {(r.get('condition') or '')[:80]!r}", flush=True)
            time.sleep(0.15)
    for g, name in files.items():
        (OUT_DIR / name).write_text(
            json.dumps(list(store[g].values()), ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8")
        print(f"{name}: {len(store[g])}")
    print(f"новых: {n_new}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
