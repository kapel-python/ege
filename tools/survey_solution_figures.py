#!/usr/bin/env python3
"""Survey solution-блоков матпрофиля: какие get_file лежат в решении.

Кэш: tools/out/math_solfig.json  {src_id: {sol_files:[...], cond_files:[...], sol_tex:int}}
Запуск: python3 tools/survey_solution_figures.py [--workers 5]
"""
from __future__ import annotations

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdamgia_import as S  # noqa: E402

CACHE = ROOT / "tools" / "out" / "math_solfig.json"
BASE = S.SUBJECTS["math"]
IMG_RE = re.compile(r"<img\b[^>]*>")
SRC_RE = re.compile(r'src="([^"]*)"')


def scan(pid: str) -> dict:
    page = S.get(BASE, f"/problem?id={pid}")
    anchor = S.SOL_ANCHOR_RE.search(page)
    head = page[:anchor.start()] if anchor else page
    m = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    cond_seg = head[m.end():] if m else head
    sol = S._solution_block(page, anchor.start()) if anchor else ""
    def files(seg):
        out = []
        for t in IMG_RE.findall(seg):
            ms = SRC_RE.search(t)
            src = ms.group(1) if ms else ""
            if "get_file" in src and src not in out:
                out.append(src)
        return out
    tex = sum(1 for t in IMG_RE.findall(sol)
              if 'class="tex"' in t or "/formula/" in (SRC_RE.search(t).group(1) if SRC_RE.search(t) else ""))
    time.sleep(0.15)
    return {"sol_files": files(sol), "cond_files": files(cond_seg), "sol_tex": tex}


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    data = json.loads((ROOT / "server" / "catalog.json").read_text(encoding="utf-8"))
    pids: list[str] = []
    for t in data["tasks"]:
        sid = str(t.get("sourceId") or "")
        if sid.startswith("sdamgia-") and sid not in pids:
            pids.append(sid.split("-", 1)[1])
    # tasks may repeat sourceIds; dedupe
    pids = sorted(set(pids))
    cache: dict = {}
    if CACHE.exists():
        try:
            cache = json.loads(CACHE.read_text(encoding="utf-8"))
        except ValueError:
            cache = {}
    pending = [p for p in pids if p not in cache]
    if args.limit:
        pending = pending[:args.limit]
    print(f"всего src {len(pids)}, в кэше {len(cache)}, скачать {len(pending)}")

    def job(pid):
        try:
            return pid, scan(pid)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {pid}: {exc}")
            return pid, {"sol_files": None, "cond_files": None, "sol_tex": -1}

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for pid, rec in pool.map(job, pending):
            cache[pid] = rec
            done += 1
            if done % 100 == 0:
                CACHE.write_text(json.dumps(cache, ensure_ascii=False) + "\n", encoding="utf-8")
                print(f"  ... {done}/{len(pending)}")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False) + "\n", encoding="utf-8")
    with_sol = sum(1 for v in cache.values() if v.get("sol_files"))
    print(f"готово: {len(cache)}, решений с get_file: {with_sol}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
