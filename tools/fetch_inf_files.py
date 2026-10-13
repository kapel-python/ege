#!/usr/bin/env python3
"""Скачать файлы данных СДАМ ГИА для заданий информатики с внешним файлом.

Навыки: inf09_sheet, inf17_sequence, inf22_processes, inf24_strings,
inf26_sort, inf27_data. src_id берётся из поля sourceId каталога
(sdamgia-<src_id>), страница https://inf-ege.sdamgia.ru/problem?id=<src_id>
содержит вложения /get_file?id=<fid> в теле условия (до маркера решения).

Идемпотентность: манифест tools/out/inf_files.json вида
  src_id -> {fids, files: [{fid, file, name, bytes, sha, contentType}]}
Повторный запуск докачивает только отсутствующее. Вежливость: пауза ≥0.3с
между запросами, ретраи с бэкоффом.

Файлы данных — только <a href="/get_file?id=N"> в теле условия:
бот-иконки 116160/116164 (сайдбар) и <img> из разбора решения — мусор.

    python3 tools/fetch_inf_files.py [--limit N] [--only src_id,...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_informatics.json"
OUT_DIR = ROOT / "tools" / "out"
RAW_DIR = OUT_DIR / "inf_raw"
MANIFEST = OUT_DIR / "inf_files.json"

SKILLS = ["inf09_sheet", "inf17_sequence", "inf22_processes",
          "inf24_strings", "inf26_sort", "inf27_data"]
JUNK_FIDS = {"116160", "116164"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EGE-study/1.0 (educational content sync)"
PAUSE = 0.35


def http_get(url: str, referer: str | None = None) -> tuple[bytes, dict]:
    last = None
    for attempt in range(4):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        if referer:
            req.add_header("Referer", referer)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (403, 429, 500, 502, 503, 504):
                time.sleep(2 ** attempt + 1)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = exc
            time.sleep(2 ** attempt + 1)
    raise RuntimeError(f"GET failed {url}: {last}")


def statement_fids(html: str) -> list[str]:
    """fid вложений из тела условия (до блока решения), без мусора."""
    # Тело условия — первый div.pbody; решение начинается с id="sol<id>".
    m = re.search(r'id="sol\d+"', html)
    head = html[:m.start()] if m else html
    # На всякий случай режем и по маркеру <!--np--> перед решением.
    head = head.split("<!--np-->")[0]
    fids = re.findall(r'<a\s+href="/get_file\?id=(\d+)"', head)
    seen, out = set(), []
    for f in fids:
        if f in JUNK_FIDS or f in seen:
            continue
        seen.add(f)
        out.append(f)
    return out


def disp_filename(headers: dict) -> str:
    cd = ""
    for k, v in headers.items():
        if k.lower() == "content-disposition":
            cd = v
            break
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd)
    return (m.group(1).strip() if m else "").strip() or "file.bin"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    wanted: list[tuple[str, str]] = []  # (task_id, src_id)
    for t in data["tasks"]:
        if t.get("skill") not in SKILLS:
            continue
        sid = str(t.get("sourceId") or "")
        m = re.fullmatch(r"sdamgia-(\d+)", sid)
        if m:
            wanted.append((t["id"], m.group(1)))
    wanted.sort(key=lambda x: x[1])
    if args.only:
        only = set(args.only.split(","))
        wanted = [w for w in wanted if w[1] in only or w[0] in only]
    if args.limit:
        wanted = wanted[:args.limit]
    print(f"tasks: {len(wanted)}")

    manifest: dict = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    new_files = 0
    no_file: list[str] = []
    for i, (task_id, src_id) in enumerate(wanted):
        entry = manifest.get(src_id)
        if entry and entry.get("files") and all((RAW_DIR / f["file"]).exists() for f in entry["files"]):
            continue
        page_url = f"https://inf-ege.sdamgia.ru/problem?id={src_id}"
        try:
            html_b, _ = http_get(page_url, referer="https://inf-ege.sdamgia.ru/")
            html = html_b.decode("utf-8", errors="replace")
            fids = statement_fids(html)
        except Exception as exc:
            print(f"[{i+1}/{len(wanted)}] {task_id} src={src_id}: PAGE FAIL {exc}", flush=True)
            manifest.setdefault(src_id, {"taskIds": [], "fids": [], "files": [], "error": str(exc)[:200]})
            if task_id not in manifest[src_id].setdefault("taskIds", []):
                manifest[src_id]["taskIds"].append(task_id)
            time.sleep(PAUSE)
            continue
        if not fids:
            print(f"[{i+1}/{len(wanted)}] {task_id} src={src_id}: NO FILE", flush=True)
            no_file.append(f"{task_id}/src{src_id}")
            manifest[src_id] = {"taskIds": [task_id], "fids": [], "files": [], "error": "no-file-link"}
            time.sleep(PAUSE)
            continue
        files = []
        for k, fid in enumerate(fids):
            try:
                blob, headers = http_get(f"https://inf-ege.sdamgia.ru/get_file?id={fid}", referer=page_url)
            except Exception as exc:
                print(f"[{i+1}/{len(wanted)}] {task_id} src={src_id} fid={fid}: FILE FAIL {exc}", flush=True)
                time.sleep(PAUSE)
                continue
            if len(blob) < 10 or b"<html" in blob[:500].lower() and len(blob) < 2000:
                print(f"[{i+1}/{len(wanted)}] {task_id} src={src_id} fid={fid}: SUSPICIOUS {len(blob)}b", flush=True)
            name = disp_filename(headers)
            ext = Path(name).suffix.lower() or ".bin"
            raw_name = f"{src_id}-{k}_{fid}{ext}"
            (RAW_DIR / raw_name).write_bytes(blob)
            files.append({"fid": fid, "file": raw_name, "name": name,
                          "bytes": len(blob),
                          "sha": hashlib.sha256(blob).hexdigest()[:16],
                          "contentType": str(headers.get("Content-Type") or headers.get("content-type") or "")})
            new_files += 1
            time.sleep(PAUSE)
        print(f"[{i+1}/{len(wanted)}] {task_id} src={src_id}: fids={fids} files={len(files)}", flush=True)
        entry = manifest.setdefault(src_id, {"taskIds": [], "fids": [], "files": []})
        entry["fids"] = fids
        entry["files"] = files
        entry.pop("error", None)
        if task_id not in entry.setdefault("taskIds", []):
            entry["taskIds"].append(task_id)
        time.sleep(PAUSE)
        if (i + 1) % 25 == 0:
            MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"done: new files={new_files}, no-file={len(no_file)}")
    for n in no_file[:40]:
        print("  NOFILE", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
