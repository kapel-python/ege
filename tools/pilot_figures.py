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
    (outdir / f"manifest-line{args.line}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"манифест: {len(manifest)} файлов")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())