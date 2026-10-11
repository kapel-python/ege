#!/usr/bin/env python3
"""Проверка условий заданий профильной математики (строгое правило банка).

Где по эталону ЕГЭ формула, а у нас был бы текст или дыра, — такое задание
не берём. Решениям словесные формулы разрешены (объяснение учителя), поэтому
проверяем ТОЛЬКО условие — строго по тегам <img>, а не подстрокой по HTML.

Для каждой записи выгрузки выясняем по живой странице:
  * cond_n   — сколько картинок в условии;
  * figure   — есть настоящий рисунок (чертёж/график, get_file в src);
  * cond_tex — есть формула-картинка (class="tex" или /formula/ в теге).

Отбор в apply_profile_topup.py: текст = cond_n == 0; чертёж = figure
без cond_tex. Старый кэш несовместим — скрипт начинает заново.

    python3 tools/classify_math_figures.py --analyze
    python3 tools/classify_math_figures.py --lines 1-10
    python3 tools/classify_math_figures.py --workers 5
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

import sdamgia_import as S  # noqa: E402

OUT_DIR = ROOT / "tools" / "out"
CACHE = OUT_DIR / "math_figclass.json"
BASE = S.SUBJECTS["math"]

IMG_RE = re.compile(r"<img\b[^>]*>")


def tag_src(tag: str) -> str:
    m = re.search(r'src="([^"]*)"', tag)
    return m.group(1) if m else ""


def scan_page(pid: str) -> dict:
    """Состав условия по живой странице: точные счётчики по тегам."""
    page = S.get(BASE, f"/problem?id={pid}")
    anchor = S.SOL_ANCHOR_RE.search(page)
    head = page[:anchor.start()] if anchor else page
    m = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    seg = head[m.end():] if m else head
    tags = IMG_RE.findall(seg)
    fig_n = tex_n = 0
    for t in tags:
        src = tag_src(t)
        if "get_file" in src:
            fig_n += 1
        elif 'class="tex"' in t or "/formula/" in src:
            tex_n += 1
    time.sleep(0.2)
    return {"fig_n": fig_n, "tex_n": tex_n, "cond_n": len(tags),
            "figure": fig_n > 0, "cond_tex": tex_n > 0}


def parse_lines(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--lines", default=None, help="напр. 1-10 или 1,2,14")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    wanted = parse_lines(args.lines)

    cache: dict = {}
    if CACHE.exists():
        try:
            loaded = json.loads(CACHE.read_text(encoding="utf-8"))
            # Берём только записи нового формата (со счётчиками).
            cache = {k: v for k, v in loaded.items()
                     if isinstance(v, dict) and "fig_n" in v}
        except (OSError, ValueError):
            cache = {}

    pending: list[tuple[int, str]] = []
    for n in range(1, 21):
        if wanted is not None and n not in wanted:
            continue
        path = OUT_DIR / f"math_{n:02d}.json"
        if not path.exists():
            continue
        for r in json.loads(path.read_text(encoding="utf-8")):
            if f"{n}:{r['src_id']}" not in cache:
                pending.append((n, str(r["src_id"])))

    print(f"в кэше {len(cache)}, предстоит скачать {len(pending)} "
          f"(потоков: {args.workers})")
    if args.analyze:
        return 0

    done = 0

    def job(item: tuple[int, str]) -> tuple[str, dict]:
        n, pid = item
        try:
            return f"{n}:{pid}", scan_page(pid)
        except Exception as exc:
            print(f"  FAIL {n}:{pid}: {exc}")
            # Непроверенное — в банк не идёт: tex как будто есть.
            return f"{n}:{pid}", {"figure": False, "cond_tex": True, "cond_n": -1}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for key, flags in pool.map(job, pending):
            cache[key] = flags
            done += 1
            if done % 100 == 0:
                CACHE.write_text(json.dumps(cache, ensure_ascii=False) + "\n",
                                 encoding="utf-8")
                print(f"  ... {done}/{len(pending)}")

    CACHE.write_text(json.dumps(cache, ensure_ascii=False) + "\n", encoding="utf-8")
    figs = sum(1 for v in cache.values() if v.get("figure") and not v.get("cond_tex"))
    clean = sum(1 for v in cache.values() if v.get("cond_n") == 0)
    print(f"готово: {len(cache)}, условий без картинок {clean}, "
          f"чистых чертежей {figs}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
