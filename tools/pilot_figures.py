#!/usr/bin/env python3
"""Пилот: импорт картинок источника в assets (проверка возможности).

Для заданных id заданий скачивает картинки из условия, проверяет:
  * ровно ожидаемое число картинок;
  * SVG без <script> и внешних ссылок, либо растровый PNG/JPEG/GIF/WebP;
  * вменяемый размер (SVG viewBox/width-height, растр — габариты).
Чистые файлы кладёт в assets/<subject>/, рядом пишет manifest.json
(src_id -> файл, размеры, исходный URL). Каталог НЕ трогает.

    python3 tools/pilot_figures.py soc 9 9424 13950 8147 11243 8372
"""
from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "Mozilla/5.0 (compatible; ege-content-import/1.0)"
TIMEOUT = 40
MAX_BYTES = 2_000_000

BASES = {
    "soc": "https://soc-ege.sdamgia.ru",
    "bio": "https://bio-ege.sdamgia.ru",
    "inf": "https://inf-ege.sdamgia.ru",
    "mathb": "https://mathb-ege.sdamgia.ru",
    "math": "https://math-ege.sdamgia.ru",
    "rus": "https://rus-ege.sdamgia.ru",
}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def condition_images(base: str, pid: str) -> list[str]:
    page = get(f"{base}/problem?id={pid}").decode("utf-8", "replace")
    anchor = re.search(r'id="soltb\d+"', page)
    head = page[:anchor.start()] if anchor else page
    m = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    if not m:
        raise RuntimeError(f"{pid}: нет блока условия")
    seg = head[m.end():]
    return re.findall(r'<img[^>]*src="([^"]+)"[^>]*>', seg)


def abs_url(base: str, src: str) -> str:
    src = html.unescape(src)
    if src.startswith(("http://", "https://")):
        return src
    return base + (src if src.startswith("/") else "/" + src)


def check_svg(data: bytes) -> dict:
    txt = data.decode("utf-8", errors="ignore")[:20000]
    if "<script" in txt.lower():
        raise ValueError("SVG содержит <script>")
    ext = re.findall(r'xlink:href="(?!#)([^"]+)"', txt)
    ext += re.findall(r'(?:href|src)="(https?://[^"]+)"', txt)
    if ext:
        raise ValueError(f"SVG ссылается наружу: {ext[:3]}")
    w = re.search(r'<svg[^>]*\bwidth="([\d.]+)', txt)
    h = re.search(r'<svg[^>]*\bheight="([\d.]+)', txt)
    vb = re.search(r'viewBox="([\d.\s-]+)"', txt)
    return {"kind": "svg",
            "width": float(w.group(1)) if w else None,
            "height": float(h.group(1)) if h else None,
            "viewBox": vb.group(1) if vb else None}


def check_raster(data: bytes) -> dict:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        import struct
        w, h = struct.unpack(">II", data[16:24])
        return {"kind": "png", "width": w, "height": h}
    if data[:2] == b"\xff\xd8":
        return {"kind": "jpeg", "width": None, "height": None}
    if data[:6] in (b"GIF87a", b"GIF89a"):
        import struct
        w, h = struct.unpack("<HH", data[6:10])
        return {"kind": "gif", "width": w, "height": h}
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return {"kind": "webp", "width": None, "height": None}
    raise ValueError("неизвестный формат картинки")


def strip_watermark_mark(svg: str) -> tuple[str, int]:
    """Удаляет узел вотермарки: ровно один <g> с fill-opacity:0.4, содержащий
    только <path> (глифы логотипа «решуегэ.рф», 10 контуров). Всё остальное —
    отказ: молча резать чужие узлы нельзя."""
    nodes = list(re.finditer(r"<g\b[^>]*fill-opacity:0\.4[^>]*>", svg))
    if len(nodes) != 1:
        raise ValueError(f"узлов вотермарки: {len(nodes)}, нужен ровно 1")
    start = nodes[0].start()
    depth = 0
    pos = start
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
    n_paths = len(re.findall(r"<path\b", block))
    return svg[:start] + svg[end:], n_paths


CHROME = next(
    (Path(p) / "chrome-headless-shell" for p in (
        "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64",
        "/root/.cache/ms-playwright/chromium-1243/chrome-linux64",
    ) if (Path(p) / "chrome-headless-shell").exists()
    or (Path(p) / "chrome").exists()),
    None)


def rasterize(svg_path: Path, scale: float) -> Path:
    """SVG -> PNG через headless Chrome (шрифт Times-метрик: Liberation Serif).
    Пустые белые поля обрезаются. Возвращает путь к PNG; SVG удаляется."""
    if CHROME is None:
        raise RuntimeError("нет headless Chrome для растеризации")
    out = svg_path.with_suffix(".png")
    w = int(float(re.search(r'width="([\d.]+)', svg_path.read_text(encoding="utf-8", errors="ignore")).group(1)) * scale)
    h = int(float(re.search(r'height="([\d.]+)', svg_path.read_text(encoding="utf-8", errors="ignore")).group(1)) * scale)
    subprocess.run([str(CHROME), "--headless", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--force-device-scale-factor=" + str(scale),
                    "--window-size=" + str(w + 2) + "," + str(h + 2),
                    "--default-background-color=FFFFFFFF",
                    "--screenshot=" + str(out), svg_path.resolve().as_uri()],
                   check=True, capture_output=True, timeout=180)
    if not out.exists() or out.stat().st_size < 500:
        raise RuntimeError("растеризация не дала файла")
    png = out.read_bytes()
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("получился не PNG")
    # Обрезка однотонных белых полей: в исходных PDF/Illustrator вокруг
    # диаграммы часто остаётся пустое место, из-за него рисунок выглядел
    # мелким в карточке. Возвращаем размеры содержимого.
    from PIL import Image, ImageChops
    im = Image.open(out).convert("RGB")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    diff = ImageChops.difference(im, bg).convert("L")
    bbox = diff.point(lambda p: 255 if p > 8 else 0).getbbox()
    if bbox:
        pad = 6
        bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad))
        im = im.crop(bbox)
        im.save(out, optimize=True)
    svg_path.unlink()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("subject", choices=sorted(BASES))
    ap.add_argument("line", type=int)
    ap.add_argument("pids", nargs="+")
    ap.add_argument("--expect", type=int, default=1,
                    help="сколько картинок ждём в условии")
    ap.add_argument("--strip-watermark", action="store_true",
                    help="вырезать узел вотермарки (fill-opacity:0.4); "
                         "происхождение остаётся в манифесте и карточке ассета")
    ap.add_argument("--rasterize", type=float, default=0, metavar="SCALE",
                    help="превратить чистый SVG в PNG (масштаб, например 2.5): "
                         "подписи в SVG набраны Times New Roman, которого нет "
                         "на телефонах — системный шрифт шире и текст вылезает "
                         "за край. PNG рендерится одинаково везде.")
    args = ap.parse_args()

    base = BASES[args.subject]
    outdir = ROOT / "assets" / ("society" if args.subject == "soc" else args.subject)
    outdir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}

    for pid in args.pids:
        try:
            srcs = condition_images(base, pid)
        except Exception as exc:
            print(f"  FAIL {pid}: {exc}")
            continue
        if len(srcs) != args.expect:
            print(f"  FAIL {pid}: картинок {len(srcs)}, ждали {args.expect}")
            continue
        for k, src in enumerate(srcs):
            url = abs_url(base, src)
            try:
                data = get(url)
            except Exception as exc:
                print(f"  FAIL {pid}[{k}]: скачать: {exc}")
                continue
            if len(data) > MAX_BYTES:
                print(f"  FAIL {pid}[{k}]: {len(data)} байт — слишком большой")
                continue
            try:
                info = check_svg(data) if b"<svg" in data[:2000].lower() else check_raster(data)
            except ValueError as exc:
                print(f"  FAIL {pid}[{k}]: {exc}")
                continue
            ext = {"svg": "svg", "png": "png", "jpeg": "jpg",
                   "gif": "gif", "webp": "webp"}[info["kind"]]
            if args.strip_watermark:
                if info["kind"] != "svg":
                    print(f"  FAIL {pid}[{k}]: чистка только для SVG")
                    continue
                try:
                    txt = data.decode("utf-8", errors="ignore")
                    txt, n_rm = strip_watermark_mark(txt)
                    data = txt.encode("utf-8")
                except ValueError as exc:
                    print(f"  FAIL {pid}[{k}]: вотермарка: {exc}")
                    continue
                try:
                    import xml.dom.minidom
                    xml.dom.minidom.parseString(data)
                except Exception as exc:
                    print(f"  FAIL {pid}[{k}]: SVG сломан после чистки: {exc}")
                    continue
                print(f"  (вырезано контуров вотермарки: {n_rm})", end=" ")
            name = f"{args.subject}-src{pid}{'' if args.expect == 1 else f'-{k}'}.{ext}"
            (outdir / name).write_bytes(data)
            manifest[f"{pid}:{k}"] = {"file": str((outdir / name).relative_to(ROOT)),
                                      "url": url, "bytes": len(data), **info}
            print(f"  ok   {pid}[{k}]: {info['kind']} {info.get('width')}x{info.get('height')} "
                  f"{len(data) // 1024} КБ -> {name}")
            if args.rasterize and info["kind"] == "svg":
                # Растр не зависит от шрифтов устройства: подписи в SVG набраны
                # Times New Roman, на телефоне его нет — текст вылезал за край.
                try:
                    png = rasterize(outdir / name, args.rasterize)
                    from PIL import Image
                    with Image.open(png) as im:
                        png_size = im.size
                    key = f"{pid}:{k}"
                    manifest[key]["file"] = str(png.relative_to(ROOT))
                    manifest[key]["kind"] = "png"
                    manifest[key]["svg"] = str((outdir / name).relative_to(ROOT))
                    manifest[key]["width"] = info["width"]
                    manifest[key]["height"] = info["height"]
                    manifest[key]["pngWidth"] = png_size[0]
                    manifest[key]["pngHeight"] = png_size[1]
                    print(f"       -> растр {png.stat().st_size // 1024} КБ (шрифтозависимость снята)")
                except Exception as exc:
                    print(f"  FAIL {pid}[{k}]: растеризация: {exc}")
    (outdir / f"manifest-line{args.line}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"манифест: {len(manifest)} файлов")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())