#!/usr/bin/env python3
"""Импорт рисунков РЕШЕНИЙ матпрофиля (get_file в блоке решения, не условия).

Живой факт: ссылки «см. рис. N» / «Рис. N» в solution второй части (n14–n20
и часть линий 1–13) указывают на настоящие чертежи источника, которых в банке
не было, — клиент их вырезал (stripMissingFigures в js/app.js). Этот скрипт:

  * читает кэш survey tools/out/math_solfig.json
    (построитель: tools/survey_solution_figures.py);
  * качает get_file блока решения через механику tools/figure_import.py
    (SVG -> растр headless Chrome, чистка вотермарки, обрезка белого);
  * кладёт файлы assets/math/math-sol<FID>.png (имя по id файла источника —
    один чертёж, общий для нескольких заданий, качается один раз);
  * добавляет записи visualAssets и ставит заданию поле solutionAssets
    (массив id в порядке документа — Рис. 1..N). Старый клиент его игнорирует,
    новый рендерит под разбором; visual.assetId условия не трогаем.

    python3 tools/import_solution_figures.py --analyze
    python3 tools/import_solution_figures.py --lines 14-19
    python3 tools/import_solution_figures.py --limit 20 --workers 3
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import figure_import as FI  # noqa: E402
import sdamgia_import as S  # noqa: E402

CATALOG = ROOT / "server" / "catalog.json"
SOLFIG = ROOT / "tools" / "out" / "math_solfig.json"
OUTDIR = ROOT / "assets" / "math"
BASE = S.SUBJECTS["math"]
SCALE = 2.5


def file_id(src: str) -> str:
    """id файла источника из '/get_file?id=NNN' (без query-хвостов)."""
    tail = src.split("get_file?id=", 1)[1]
    return "".join(ch for ch in tail if ch.isdigit())


def asset_id_for(fid: str) -> str:
    return f"math-sol{fid}"


def fetch_single(url: str, tmp_raw: Path, tmp_png: Path) -> tuple[int, int] | None:
    """Скачать один рисунок решения, подготовить PNG. Вернуть (w,h) или None."""
    try:
        # Часть старых решений лежит на зеркале urok.sdamgia.ru — без
        # Referer оно отвечает 403 (живой случай get_file?id=32072).
        data = FI.get(url, referer=f"{BASE}/problem?id=0")
    except Exception as exc:  # noqa: BLE001
        print(f"  FAIL скачать {url}: {exc}")
        return None
    if len(data) > FI.MAX_BYTES:
        print(f"  FAIL {url}: {len(data)} байт — слишком большой")
        return None
    tmp_raw.write_bytes(data)
    try:
        if FI.is_svg(data):
            svg = data.decode("utf-8", errors="ignore")
            svg, _removed = FI.strip_watermark_mark(svg)
            expand = 1.0 if "<text" not in svg else 1.6
            tmp = FI.rasterize_svg(svg.encode("utf-8"), tmp_raw.with_suffix(".png"),
                                   SCALE, expand)
            size = FI.crop_white(tmp, tmp_png)
        else:
            from PIL import Image
            im = Image.open(tmp_raw).convert("RGB")
            if max(im.size) > FI.MAX_DIM:
                im.thumbnail((FI.MAX_DIM, FI.MAX_DIM), Image.LANCZOS)
            im.save(tmp_png, optimize=True)
            size = im.size
    except Exception as exc:  # noqa: BLE001
        print(f"  FAIL обработка {url}: {exc}")
        return None
    finally:
        tmp_raw.unlink(missing_ok=True)
    if size[0] <= 0 or size[1] <= 0:
        print(f"  FAIL {url}: вырожденный размер {size}")
        return None
    return size


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


def line_of(task_id: str) -> int | None:
    import re
    m = re.match(r"n(\d+)_", task_id)
    return int(m.group(1)) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--lines", default=None, help="напр. 14-19 или 15,18")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    wanted = parse_lines(args.lines)

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    solfig: dict = json.loads(SOLFIG.read_text(encoding="utf-8"))
    tasks: list[dict] = data["tasks"]
    assets: dict = {a["id"]: a for a in data.get("visualAssets", [])}

    # Задания каталога с рисунками решений (порядок детерминирован — по id).
    plan: list[tuple[dict, list[str]]] = []
    for t in sorted(tasks, key=lambda x: x.get("id") or ""):
        sid = str(t.get("sourceId") or "")
        if not sid.startswith("sdamgia-"):
            continue
        if wanted is not None and (line_of(t.get("id") or "") not in wanted):
            continue
        rec = solfig.get(sid.split("-", 1)[1]) or {}
        files = rec.get("sol_files") or []
        if files:
            plan.append((t, files))
    if args.limit:
        plan = plan[:args.limit]

    need_files: list[tuple[str, str]] = []
    seen: set[str] = set()
    for _t, files in plan:
        for src in files:
            fid = file_id(src)
            if fid and fid not in seen:
                seen.add(fid)
                need_files.append((fid, FI.abs_url(BASE, src)))
    have = sum(1 for fid, _u in need_files if (OUTDIR / f"{asset_id_for(fid)}.png").exists())
    print(f"заданий с рисунками решений: {len(plan)}, файлов: {len(need_files)}, "
          f"уже на диске: {have}")
    if args.analyze:
        per_line: dict[int, int] = {}
        for t, _files in plan:
            ln = line_of(t.get("id") or "")
            per_line[ln or 0] = per_line.get(ln or 0, 0) + 1
        for ln in sorted(per_line):
            print(f"  линия {ln:2}: заданий {per_line[ln]}")
        return 0

    OUTDIR.mkdir(parents=True, exist_ok=True)
    results: dict[str, tuple[int, int] | None] = {}

    def job(item: tuple[str, str]) -> tuple[str, tuple[int, int] | None]:
        fid, url = item
        final = OUTDIR / f"{asset_id_for(fid)}.png"
        if final.exists():
            try:
                size = FI._png_size(final)
                if size[0] > 0 and size[1] > 0:
                    return fid, size
            except Exception:  # noqa: BLE001
                pass
        tmp_raw = OUTDIR / f".raw-sol-{fid}"
        tmp_png = OUTDIR / f".crop-sol-{fid}.png"
        size = fetch_single(url, tmp_raw, tmp_png)
        time.sleep(0.2)
        if size is None:
            tmp_png.unlink(missing_ok=True)
            return fid, None
        tmp_png.replace(final)
        return fid, FI._png_size(final)

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for fid, size in pool.map(job, need_files):
            results[fid] = size
            done += 1
            if done % 50 == 0:
                print(f"  ... {done}/{len(need_files)}")

    ok = sum(1 for v in results.values() if v)
    print(f"скачано: {ok}/{len(need_files)}")

    # Связывание: новые записи visualAssets + solutionAssets заданий.
    linked = 0
    new_assets = 0
    for t, files in plan:
        ids: list[str] = []
        for src in files:
            fid = file_id(src)
            aid = asset_id_for(fid)
            size = results.get(fid)
            if not size:
                # Рисунок не скачался — пропускаем именно его, остальные цепляем.
                continue
            ids.append(aid)
            if aid not in assets:
                final = OUTDIR / f"{aid}.png"
                digest = hashlib.md5(final.read_bytes()).hexdigest()[:10]
                w, h = size
                ln = line_of(t.get("id") or "")
                assets[aid] = {
                    "id": aid,
                    "src": f"assets/math/{aid}.png?v={digest}",
                    "type": "image",
                    "alt": f"Рисунок к решению (профиль №{ln})",
                    "width": w,
                    "height": h,
                    "ratio": (w / h if h else 1.0),
                    "source": f"рисунок решения источника: {FI.abs_url(BASE, src)}",
                    "sourceId": aid,
                    "taskId": None,
                    "description": f"Рисунок решения источника к заданию профиля №{ln}",
                }
                new_assets += 1
        if ids:
            if t.get("solutionAssets") != ids:
                t["solutionAssets"] = ids
                linked += 1

    data["visualAssets"] = sorted(assets.values(), key=lambda a: a.get("id") or "")
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"связано заданий: {linked}, новых ассетов: {new_assets}, "
          f"всего ассетов: {len(data['visualAssets'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
