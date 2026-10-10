#!/usr/bin/env python3
"""Массовый импорт рисунков источника в assets (обобщение pilot_figures).

Отличие от пилота: умеет брать не один заданный id, а пачку из выгрузки
(`tools/out/<subj>_NN.json`), чинит три реальные проблемы источника:

  * PNG-формулы иногда приходят gzip-ом без заголовка Content-Encoding —
    распаковываем по магии \\x1f\\x8b;
  * у SVG от Adobe Illustrator размеры бывают с единицами (`width="116px"`)
    или только viewBox — берём размер из viewBox, единицы срезаем;
  * у задания бывает несколько картинок (4 графика в задании на соответствие) —
    склеиваем их в один вертикальный PNG с подписями А) Б) В) Г), потому что
    движок показывает на задание ровно один `visual.assetId`.

Каталог этот скрипт НЕ трогает: кладёт файлы в assets/<dir>/ и печатает
манифест в stdout (его использует apply_basic_figures.py).

    python3 tools/figure_import.py mathb 12 509620 514394 506340
"""
from __future__ import annotations

import argparse
import gzip
import html
import json
import re
import struct
import subprocess
import sys
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

UA = "Mozilla/5.0 (compatible; ege-content-import/1.0)"
TIMEOUT = 40
RETRIES = 3
MAX_BYTES = 3_000_000

BASES = {
    "soc": "https://soc-ege.sdamgia.ru",
    "bio": "https://bio-ege.sdamgia.ru",
    "inf": "https://inf-ege.sdamgia.ru",
    "mathb": "https://mathb-ege.sdamgia.ru",
    "math": "https://math-ege.sdamgia.ru",
    "rus": "https://rus-ege.sdamgia.ru",
}
# Каталоги ассетов (в каталоге base-математика ссылается на assets/basic,
# поэтому имя каталога не совпадает с кодом предмета).
ASSET_DIR = {"soc": "society", "bio": "biology", "inf": "informatics",
             "mathb": "basic", "math": "math", "rus": "russian"}

CHROME = next(
    (Path(p) / "chrome-headless-shell" for p in (
        "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64",
        "/root/.cache/ms-playwright/chromium-1243/chrome-linux64",
    ) if (Path(p) / "chrome-headless-shell").exists()
    or (Path(p) / "chrome").exists()),
    None)


def get(url: str) -> bytes:
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
            if len(data) > 2 and data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            return data
        except (urllib.error.URLError, OSError, gzip.BadGzipFile) as exc:
            last = exc
            import time
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"не удалось скачать {url}: {last}")


def get_text(url: str) -> str:
    return get(url).decode("utf-8", "replace")


def condition_images(base: str, pid: str) -> list[str]:
    page = get_text(f"{base}/problem?id={pid}")
    anchor = re.search(r'id="soltb\d+"', page)
    head = page[:anchor.start()] if anchor else page
    m = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    if not m:
        raise RuntimeError(f"{pid}: нет блока условия")
    seg = head[m.end():]
    srcs = []
    for found in re.findall(r'<img[^>]*src="([^"]+)"[^>]*>', seg):
        if found not in srcs:
            srcs.append(found)
    return srcs


def abs_url(base: str, src: str, page_base: str | None = None) -> str:
    src = html.unescape(src)
    if src.startswith(("http://", "https://")):
        return src
    return base + (src if src.startswith("/") else "/" + src)


def is_svg(data: bytes) -> bool:
    return b"<svg" in data[:4000].lower()


def strip_watermark_mark(svg: str) -> tuple[str, int]:
    """Убирает узлы вотермарки: <g fill-opacity:0.4>, внутри только <path>.

    Обычно метка одна, но у части заданий (например, источник склеивает два
    изображения) их две — прежняя версия требовала ровно один узел и роняла
    импорт такого задания. Теперь убираем все метки, каждую проверяя на то,
    что внутри лежат только контуры.
    """
    nodes = list(re.finditer(r"<g\b[^>]*fill-opacity:0\.4[^>]*>", svg))
    if not nodes:
        return svg, 0
    removed = 0
    # Идём с конца: удаление верхнего узла не сдвигает позиции предыдущих.
    for node in reversed(nodes):
        start = node.start()
        depth = 0
        end = None
        for m in re.finditer(r"<g\b[^>]*>|</g>", svg[start:]):
            if m.group(0).startswith("</"):
                if depth == 1:
                    end = start + m.end()
                    break
                depth -= 1
            else:
                depth += 1
        if end is None:
            raise ValueError("не закрыт узел вотермарки")
        block = svg[start:end]
        inner = re.sub(r"^<g\b[^>]*>", "", block)
        inner = re.sub(r"</g>\s*$", "", inner)
        rest = re.sub(r"<path\b[^>]*/>|<path\b.*?</path>", "", inner, flags=re.S)
        if rest.strip():
            raise ValueError(f"внутри вотермарки не только контуры: {rest[:80]!r}")
        svg = svg[:start] + svg[end:]
        removed += len(re.findall(r"<path\b", block))
    return svg, removed


def _num(pattern: str, txt: str) -> float | None:
    m = re.search(pattern, txt)
    return float(m.group(1)) if m else None


def rasterize_svg(svg_bytes: bytes, out: Path, scale: float, expand: float = 1.0) -> None:
    """SVG -> PNG через headless Chrome. Шрифты Times заменяются Liberation Serif;
    `expand` расширяет холст вправо (легенды источника вылезают за viewBox)."""
    if CHROME is None:
        raise RuntimeError("нет headless Chrome для растеризации")
    txt = svg_bytes.decode("utf-8", errors="ignore")
    # Формулы источника отдают атрибуты в одинарных кавычках (width='13.6pt'),
    # рисунки Illustrator — в двойных. Корневой тег приводим к двойным.
    txt = re.sub(r"<svg\b[^>]*>", lambda m: m.group(0).replace("'", '"'), txt, count=1)

    w0 = _num(r'<svg[^>]*\bwidth="([\d.]+)', txt)
    h0 = _num(r'<svg[^>]*\bheight="([\d.]+)', txt)
    vb = re.search(r'viewBox="([\d.\s-]+)"', txt)
    if w0 is None and vb:
        parts = vb.group(1).split()
        if len(parts) == 4:
            w0, h0 = float(parts[2]), float(parts[3])
    if w0 is None or h0 is None or w0 <= 0 or h0 <= 0:
        raise RuntimeError("SVG без вменяемых размеров")
    w1 = w0 * expand
    txt = re.sub(r'(<svg[^>]*\bwidth=")[\d.]+(?:px|pt|em)?(")', lambda m: m.group(1) + f"{w1:.2f}" + m.group(2), txt, count=1)
    txt = re.sub(r'(<svg[^>]*\bheight=")[\d.]+(?:px|pt|em)?(")', lambda m: m.group(1) + f"{h0:.2f}" + m.group(2), txt, count=1)
    if vb:
        parts = vb.group(1).split()
        if len(parts) == 4:
            vb_w = float(parts[2])
            new_w = vb_w * expand
            txt = re.sub(r'(<svg[^>]*\bviewBox=")[^"]+(")',
                         lambda m: m.group(1) + f"{parts[0]} {parts[1]} {new_w:.2f} {float(parts[3]):.2f}" + m.group(2), txt, count=1)
    tmp_svg = out.with_suffix(".tmp.svg")
    tmp_svg.write_text(txt, encoding="utf-8")
    cw, ch = int(w1 * scale) + 40, int(h0 * scale) + 40
    png = out.with_suffix(".tmp.png")
    subprocess.run([str(CHROME), "--headless", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--force-device-scale-factor=" + str(scale),
                    "--window-size=" + str(cw) + "," + str(ch),
                    "--default-background-color=FFFFFFFF",
                    "--screenshot=" + str(png), tmp_svg.resolve().as_uri()],
                   check=True, capture_output=True, timeout=180)
    tmp_svg.unlink(missing_ok=True)
    if not png.exists() or png.stat().st_size < 300:
        raise RuntimeError("растеризация не дала файла")
    return png


def crop_white(src: Path, dst: Path, pad: int = 6) -> tuple[int, int]:
    from PIL import Image, ImageChops
    im = Image.open(src).convert("RGB")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    diff = ImageChops.difference(im, bg).convert("L")
    bbox = diff.point(lambda p: 255 if p > 8 else 0).getbbox()
    if bbox:
        bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad))
        im = im.crop(bbox)
    im.save(dst, optimize=True)
    src.unlink(missing_ok=True)
    return im.size


def raster_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", data[6:10])
    return None, None


def stitch(images: list[Path], out: Path) -> tuple[int, int]:
    """Склеить несколько рисунков вертикально с подписями А) Б) В) Г)."""
    from PIL import Image, ImageDraw, ImageFont
    crops = [Image.open(p).convert("RGB") for p in images]
    gap, margin, label_w = 24, 16, 64
    width = max(c.width for c in crops) + label_w + margin * 2
    height = sum(c.height for c in crops) + gap * (len(crops) - 1) + margin * 2
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
    except Exception:
        font = ImageFont.load_default()
    labels = "АБВГДЕЖЗ"
    y = margin
    for i, c in enumerate(crops):
        canvas.paste(c, (margin + label_w, y))
        draw.text((margin, y + c.height // 2 - 18), f"{labels[i]})", fill=(20, 20, 20), font=font)
        y += c.height + gap
    canvas.save(out, optimize=True)
    for p in images:
        p.unlink(missing_ok=True)
    return canvas.size


def import_task(subject: str, pid: str, scale: float = 2.5,
                expect: int | None = None, figures_only: bool = False,
                no_inline_formulas: bool = False) -> dict | None:
    """Скачать и подготовить рисунки задания. Возвращает запись манифеста или
    None, если рисунков нет/их число не совпало с ожиданием.

    `figures_only` отбрасывает инлайновые формулы источника
    (ege.sdamgia.ru/formula/...): у математики они вставлены прямо в текст и
    к рисунку не относятся.
    `no_inline_formulas` отбрасывает задание целиком, если в условии есть хоть
    одна инлайновая формула: её текст потерян, и задание становится нерешаемым
    (например, пустые варианты 1)–4) из формул)."""
    base = BASES[subject]
    outdir = ROOT / "assets" / ASSET_DIR[subject]
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        srcs = condition_images(base, pid)
    except Exception as exc:
        print(f"  FAIL {pid}: страница: {exc}", file=sys.stderr)
        return None
    if no_inline_formulas and any("/formula/" in s for s in srcs):
        return None
    if figures_only:
        srcs = [s for s in srcs if "get_file" in s]
    if not srcs:
        return None
    if expect is not None and len(srcs) != expect:
        print(f"  SKIP {pid}: картинок {len(srcs)}, ждали {expect}", file=sys.stderr)
        return None

    singles: list[Path] = []
    urls: list[str] = []
    for k, src in enumerate(srcs):
        url = abs_url(base, src)
        urls.append(url)
        try:
            data = get(url)
        except Exception as exc:
            print(f"  FAIL {pid}[{k}]: скачать: {exc}", file=sys.stderr)
            for p in singles:
                p.unlink(missing_ok=True)
            return None
        if len(data) > MAX_BYTES:
            print(f"  FAIL {pid}[{k}]: {len(data)} байт — слишком большой", file=sys.stderr)
            for p in singles:
                p.unlink(missing_ok=True)
            return None
        raw = outdir / f".raw-{subject}-src{pid}-{k}"
        raw.write_bytes(data)
        png = outdir / f".crop-{subject}-src{pid}-{k}.png"
        try:
            if is_svg(data):
                svg = data.decode("utf-8", errors="ignore")
                svg, removed = strip_watermark_mark(svg)
                # Легенду/надписи Illustrator может выносить за viewBox —
                # расширяем холст только у «рисунков», не у формул.
                expand = 1.0 if "<text" not in svg else 1.6
                tmp = rasterize_svg(svg.encode("utf-8"), raw.with_suffix(".png"), scale, expand)
                crop_white(tmp, png)
                raw.unlink(missing_ok=True)
            else:
                from PIL import Image
                im = Image.open(raw).convert("RGB")
                w, h = im.size
                # Мелкие формулы-растры не трогаем, крупные обрезаем по белому.
                if w * h > 200000:
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    from PIL import ImageChops
                    diff = ImageChops.difference(im, bg).convert("L")
                    bbox = diff.point(lambda p: 255 if p > 8 else 0).getbbox()
                    if bbox:
                        im = im.crop(bbox)
                im.save(png, optimize=True)
                raw.unlink(missing_ok=True)
        except Exception as exc:
            print(f"  FAIL {pid}[{k}]: обработка: {exc}", file=sys.stderr)
            raw.unlink(missing_ok=True)
            for p in singles:
                p.unlink(missing_ok=True)
            return None
        singles.append(png)

    if len(singles) == 1:
        final = outdir / f"{subject}-src{pid}.png"
        singles[0].replace(final)
        w = _png_size(final)[0]
        h = _png_size(final)[1]
        entry = {"file": str(final.relative_to(ROOT)), "kind": "png",
                 "urls": urls, "width": w, "height": h}
    else:
        final = outdir / f"{subject}-src{pid}.png"
        w, h = stitch(singles, final)
        entry = {"file": str(final.relative_to(ROOT)), "kind": "stitched",
                 "urls": urls, "width": w, "height": h, "parts": len(srcs)}
    return {"id": f"{subject}-src{pid}", **entry}


def _png_size(p: Path) -> tuple[int, int]:
    from PIL import Image
    with Image.open(p) as im:
        return im.size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("subject", choices=sorted(BASES))
    ap.add_argument("line", type=int)
    ap.add_argument("pids", nargs="*")
    ap.add_argument("--from-out", action="store_true",
                    help="взять id с рисунками из tools/out/<subj>_NN.json")
    ap.add_argument("--scale", type=float, default=2.5)
    args = ap.parse_args()

    pids = list(args.pids)
    if args.from_out:
        path = ROOT / "tools" / "out" / f"{args.subject}_{args.line:02d}.json"
        for r in json.loads(path.read_text(encoding="utf-8")):
            if r.get("images"):
                pids.append(str(r["src_id"]))
    manifest = {}
    for pid in pids:
        entry = import_task(args.subject, pid, args.scale)
        if entry:
            manifest[entry["id"]] = entry
            print(f"  ok   {pid}: {entry['kind']} {entry['width']}x{entry['height']} -> {entry['file']}")
        else:
            print(f"  --   {pid}: без рисунка/ошибка")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())