#!/usr/bin/env python3
"""Проверка 29 замен в обществознании: текст и ответ каждой заменённой задачи
должны дословно совпадать с заданием источника (Решу ЕГЭ, те же демо/банк ФИПИ).

    python3 tools/verify_society.py
"""
from __future__ import annotations

import difflib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "tools" / "out"


def norm(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def norm_ans(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").strip().strip("."))


def main() -> int:
    cur = json.loads((ROOT / "server" / "catalog_society.json").read_text(encoding="utf-8"))
    old = json.loads(subprocess.check_output(
        ["git", "show", "HEAD:server/catalog_society.json"], cwd=ROOT))
    bold = {t["id"]: t for t in old["tasks"]}
    changed = [t for t in cur["tasks"] if t != bold.get(t["id"])]
    print(f"заменённых задач: {len(changed)}")

    # пул источника по линиям
    pool: dict[int, list[dict]] = {}
    for n in range(1, 17):
        p = OUT_DIR / f"soc_{n:02d}.json"
        if p.exists():
            pool[n] = json.loads(p.read_text(encoding="utf-8"))
    print(f"линий источника загружено: {len(pool)}")

    ok, bad = 0, []
    for t in sorted(changed, key=lambda x: x["id"]):
        m = re.search(r"soc(\d+)_", t["id"])
        line = int(m.group(1)) if m else 0
        cand = pool.get(line, [])
        nt, na = norm(t["text"]), norm_ans(t.get("answer", ""))
        best, best_src = 0.0, None
        ans_match = False
        for r in cand:
            rtext = norm(r["condition"])
            ratio = difflib.SequenceMatcher(None, nt, rtext).ratio()
            if ratio > best:
                best = ratio
                best_src = r
            alts = [norm_ans(x) for x in (r["answer"] or "").split("|")]
            if na and na in alts:
                # ответ совпал — проверяем, что и текст близок
                if ratio >= 0.85:
                    ans_match = True
        # итог: текст почти дословно + ответ из источника
        if best >= 0.9 and ans_match:
            ok += 1
            print(f"  ok    {t['id']} совп. {best:.2f} src={best_src['src_id']} отв={t.get('answer')!r}")
        else:
            bad.append((t["id"], best, best_src["src_id"] if best_src else None,
                        t.get("answer"), best_src["answer"] if best_src else None))
            print(f"  ПРОВЕРИТЬ {t['id']} совп. {best:.2f} src={best_src['src_id'] if best_src else None} "
                  f"наш отв={t.get('answer')!r} ист.отв={best_src['answer'] if best_src else None!r}")
    print(f"\nитог: подтверждено {ok}/{len(changed)}, на ручную проверку {len(bad)}")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())