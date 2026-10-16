#!/usr/bin/env python3
"""Импорт рисунков РЕШЕНИЙ (get_file в блоке решения, не условия).

Живой факт (матпрофиль): ссылки «см. рис. N» / «Рис. N» в solution указывают
на настоящие чертежи источника, которых в банке не было. Методика та же для
всех предметов: survey tools/survey_solution_figures.py --subject <s>,
импорт сюда же с тем же --subject. Поле solutionAssets и рендер
(solutionFiguresHtml в js/app.js) — общие для всех каталогов.

    python3 tools/import_solution_figures.py --analyze
    python3 tools/import_solution_figures.py --subject bio --analyze
    python3 tools/import_solution_figures.py --subject inf --limit 20 --workers 3
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
from survey_solution_figures import SUBJECT_CATALOGS  # noqa: E402

SCALE = 2.5
# Подпись семейства в alt/description ассета.
SUBJECT_LABEL = {
    "math": "профиль №", "mathb": "база №", "bio": "биология №",
    "his": "история №", "inf": "информатика №", "rus": "русский №",
    "soc": "общество №", "oge": "ОГЭ-математика №",
    "bio_oge": "ОГЭ-биология №", "hist_oge": "ОГЭ-история №",
    "inf_oge": "ОГЭ-информатика №", "soc_oge": "ОГЭ-общество №",
}


def file_id(src: str) -> str:
    """id файла источника из '/get_file?id=NNN' (без query-хвостов)."""
    tail = src.split("get_file?id=", 1)[1]
    return "".join(ch for ch in tail if ch.isdigit())


def asset_id_for(prefix: str, fid: str) -> str:
    return f"{prefix}-sol{fid}"


def fetch_single(base: str, url: str, tmp_raw: Path, tmp_png: Path) -> tuple[int, int] | None:
    """Скачать один рисунок решения, подготовить PNG. Вернуть (w,h) или None."""
    try:
        # Часть старых решений лежит на зеркале urok.sdamgia.ru — без
        # Referer оно отвечает 403 (живой случай get_file?id=32072).
        data = FI.get(url, referer=f"{base}/problem?id=0")
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
    # n01_.. (профиль), b01_.. (база), o01_/ob01_/oh01_/oi01_/os01_.. (ОГЭ),
    # bio01_/h01_/inf01_/soc01_/r01_.. (ЕГЭ-предметы).
    m = re.match(r"(?:n|b|o|ob|oh|oi|os|bio|h|inf|soc|r)0*(\d+)_", task_id)
    return int(m.group(1)) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", default="math", choices=sorted(SUBJECT_CATALOGS))
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--lines", default=None, help="напр. 14-19 или 15,18")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    wanted = parse_lines(args.lines)

    base = S.SUBJECTS[args.subject]
    catalog_path = ROOT / "server" / SUBJECT_CATALOGS[args.subject]
    solfig_path = ROOT / "tools" / "out" / f"{args.subject}_solfig.json"
    outdir = ROOT / "assets" / FI.ASSET_DIR[args.subject]
    prefix = args.subject
    label = SUBJECT_LABEL[args.subject]

    data = json.loads(catalog_path.read_text(encoding="utf-8"))
    solfig: dict = json.loads(solfig_path.read_text(encoding="utf-8"))
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
        # Рисунок, уже показанный в условии (тот же get_file), повторно не
        # вывозим: он и так виден через visual.assetId (живой случай — био №20).
        cond = set(rec.get("cond_files") or [])
        files = [s for s in files if s not in cond]
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
                need_files.append((fid, FI.abs_url(base, src)))
    have = sum(1 for fid, _u in need_files if (outdir / f"{asset_id_for(prefix, fid)}.png").exists())
    print(f"[{args.subject}] заданий с рисунками решений: {len(plan)}, файлов: {len(need_files)}, "
          f"уже на диске: {have}")
    if args.analyze:
        per_line: dict[int, int] = {}
        for t, _files in plan:
            ln = line_of(t.get("id") or "")
            per_line[ln or 0] = per_line.get(ln or 0, 0) + 1
        for ln in sorted(per_line):
            print(f"  линия {ln:2}: заданий {per_line[ln]}")
        return 0

    outdir.mkdir(parents=True, exist_ok=True)
    results: dict[str, tuple[int, int] | None] = {}

    def job(item: tuple[str, str]) -> tuple[str, tuple[int, int] | None]:
        fid, url = item
        final = outdir / f"{asset_id_for(prefix, fid)}.png"
        if final.exists():
            try:
                size = FI._png_size(final)
                if size[0] > 0 and size[1] > 0:
                    return fid, size
            except Exception:  # noqa: BLE001
                pass
        tmp_raw = outdir / f".raw-sol-{fid}"
        tmp_png = outdir / f".crop-sol-{fid}.png"
        size = fetch_single(base, url, tmp_raw, tmp_png)
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
            aid = asset_id_for(prefix, fid)
            size = results.get(fid)
            if not size:
                # Рисунок не скачался — пропускаем именно его, остальные цепляем.
                continue
            ids.append(aid)
            if aid not in assets:
                final = outdir / f"{aid}.png"
                digest = hashlib.md5(final.read_bytes()).hexdigest()[:10]
                w, h = size
                ln = line_of(t.get("id") or "")
                assets[aid] = {
                    "id": aid,
                    "src": f"{final.relative_to(ROOT)}?v={digest}",
                    "type": "image",
                    "alt": f"Рисунок к решению ({label}{ln})",
                    "width": w,
                    "height": h,
                    "ratio": (w / h if h else 1.0),
                    "source": f"рисунок решения источника: {FI.abs_url(base, src)}",
                    "sourceId": aid,
                    "taskId": None,
                    "description": f"Рисунок решения источника к заданию ({label}{ln})",
                }
                new_assets += 1
        if ids:
            if t.get("solutionAssets") != ids:
                t["solutionAssets"] = ids
                linked += 1

    data["visualAssets"] = sorted(assets.values(), key=lambda a: a.get("id") or "")
    catalog_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"связано заданий: {linked}, новых ассетов: {new_assets}, "
          f"всего ассетов: {len(data['visualAssets'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
