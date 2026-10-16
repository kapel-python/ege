#!/usr/bin/env python3
"""Survey solution-блоков: какие get_file лежат в решении (строгая методика
по тегам <img>, та же что для матпрофиля).

Кэш: tools/out/<subject>_solfig.json  {src_id: {sol_files, cond_files, sol_tex}}
Запуск: python3 tools/survey_solution_figures.py --subject bio [--workers 5]
Дефолт --subject math = каталог профиля (кэш math_solfig.json, как раньше).
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

# Предмет survey -> файл каталога (ключи SUBJECTS из sdamgia_import).
SUBJECT_CATALOGS = {
    "math": "catalog.json",
    "mathb": "catalog_basic.json",
    "bio": "catalog_biology.json",
    "his": "catalog_history.json",
    "inf": "catalog_informatics.json",
    "rus": "catalog_russian.json",
    "soc": "catalog_society.json",
    "oge": "catalog_oge_math.json",
    "bio_oge": "catalog_oge_biology.json",
    "hist_oge": "catalog_oge_history.json",
    "inf_oge": "catalog_oge_informatics.json",
    "soc_oge": "catalog_oge_society.json",
}
IMG_RE = re.compile(r"<img\b[^>]*>")
SRC_RE = re.compile(r'src="([^"]*)"')


def scan(base: str, pid: str) -> dict:
    page = S.get(base, f"/problem?id={pid}")
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
    ap.add_argument("--subject", default="math", choices=sorted(SUBJECT_CATALOGS))
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    base = S.SUBJECTS[args.subject]
    cache_path = ROOT / "tools" / "out" / f"{args.subject}_solfig.json"
    data = json.loads((ROOT / "server" / SUBJECT_CATALOGS[args.subject]).read_text(encoding="utf-8"))
    pids: list[str] = []
    for t in data["tasks"]:
        sid = str(t.get("sourceId") or "")
        if sid.startswith("sdamgia-") and sid not in pids:
            pids.append(sid.split("-", 1)[1])
    # tasks may repeat sourceIds; dedupe
    pids = sorted(set(pids))
    cache: dict = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except ValueError:
            cache = {}
    pending = [p for p in pids if p not in cache]
    if args.limit:
        pending = pending[:args.limit]
    print(f"[{args.subject}] всего src {len(pids)}, в кэше {len(cache)}, скачать {len(pending)}")

    def job(pid):
        try:
            return pid, scan(base, pid)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {pid}: {exc}")
            return pid, {"sol_files": None, "cond_files": None, "sol_tex": -1}

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for pid, rec in pool.map(job, pending):
            cache[pid] = rec
            done += 1
            if done % 100 == 0:
                cache_path.write_text(json.dumps(cache, ensure_ascii=False) + "\n", encoding="utf-8")
                print(f"  ... {done}/{len(pending)}")
    cache_path.write_text(json.dumps(cache, ensure_ascii=False) + "\n", encoding="utf-8")
    with_sol = sum(1 for v in cache.values() if v.get("sol_files"))
    print(f"готово: {len(cache)}, решений с get_file: {with_sol}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
