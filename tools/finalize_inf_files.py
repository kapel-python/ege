#!/usr/bin/env python3
"""Раскладка скачанных файлов СДАМ ГИА по assets + привязка к заданиям.

Вход: tools/out/inf_files.json (манифест fetch_inf_files.py) +
tools/out/inf_raw/*.
Выход:
  * assets/informatics/inf-file-<src_id>[-k].<ext> (дедуп по sha256:
    одинаковое содержимое — один файл, остальные ссылаются на него);
  * server/catalog_informatics.json: task["files"] = [{assetId, name}] +
    записи visualAssets {id, src, type: "file", ...};
  * tools/version_assets.py уже покрывает catalog_informatics.json —
    прогон дописывает ?v=<хеш>.

Файлы без вложения в источнике или с проваленной проверкой не подключаются
(задание остаётся как было + строка NOFILE/FAIL в отчёте stdout).

    python3 tools/finalize_inf_files.py [--write]
Без --write — только отчёт (что будет подключено, вес, дубли).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_informatics.json"
MANIFEST = ROOT / "tools" / "out" / "inf_files.json"
RAW_DIR = ROOT / "tools" / "out" / "inf_raw"
ASSETS = ROOT / "assets" / "informatics"

SKILLS = ["inf09_sheet", "inf17_sequence", "inf22_processes",
          "inf24_strings", "inf26_sort", "inf27_data"]


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    by_src: dict[str, list[dict]] = {}
    for t in data["tasks"]:
        if t.get("skill") not in SKILLS:
            continue
        sid = str(t.get("sourceId") or "")
        if sid.startswith("sdamgia-"):
            by_src.setdefault(sid.split("-", 1)[1], []).append(t)

    assets = {a.get("id"): a for a in data.get("visualAssets", []) if isinstance(a, dict)}
    sha_to_name: dict[str, str] = {}
    for a in data.get("visualAssets", []):
        p = ROOT / str(a.get("src") or "").split("?", 1)[0]
        if p.exists():
            sha_to_name.setdefault(sha256_file(p), p.name)

    per_skill: dict[str, int] = {}
    nofile: list[str] = []
    total_bytes = 0
    planned: list[tuple[dict, list[dict]]] = []

    for src_id in sorted(by_src, key=int):
        tasks = by_src[src_id]
        entry = manifest.get(src_id) or {}
        files = entry.get("files") or []
        live = [f for f in files if (RAW_DIR / f["file"]).exists()]
        if not live:
            for t in tasks:
                if not t.get("files"):
                    nofile.append(f"{t['id']}/src{src_id} ({entry.get('error', 'no-file')})")
            continue
        refs = []
        for k, f in enumerate(live):
            raw = RAW_DIR / f["file"]
            digest = sha256_file(raw)
            if digest in sha_to_name:
                name = sha_to_name[digest]
            else:
                ext = Path(f.get("name") or raw.name).suffix.lower() or raw.suffix.lower() or ".bin"
                base = f"inf-file-{src_id}" + (f"-{k}" if len(live) > 1 else "")
                name = base + ext
                sha_to_name[digest] = name
            refs.append({"assetId": Path(name).stem, "name": f.get("name") or name,
                         "raw": raw, "bytes": raw.stat().st_size})
        planned.append((tasks, refs))

    for tasks, refs in planned:
        pass  # привязка и вес — ниже, после дедупа

    # дедуп по содержимому
    seen_sha: dict[str, dict] = {}
    for _, refs in planned:
        for a in refs:
            d = sha256_file(a["raw"])
            seen_sha.setdefault(d, a)
    total_bytes = sum(a["bytes"] for a in seen_sha.values())
    big = sorted(((a["raw"].name, a["bytes"]) for a in seen_sha.values() if a["bytes"] > 8 * 1024 * 1024),
                 key=lambda x: -x[1])

    # сколько заданий будет подключено
    conn_tasks = sum(len(tasks) for tasks, _ in planned)
    print(f"src с файлами: {len(planned)}; заданий к подключению: {conn_tasks}")
    print(f"уникальных файлов: {len(seen_sha)}; вес: {total_bytes / 1024 / 1024:.1f} МБ")
    print(f"файлов >8МБ (лимит STATIC_MAX_BYTES): {len(big)}")
    for n, b in big[:20]:
        print(f"  BIG {b / 1024 / 1024:.1f}МБ {n}")
    print(f"без файла: {len(nofile)}")
    for n in nofile[:60]:
        print(f"  NOFILE {n}")

    if not args.write:
        print("(dry-run; --write для записи)")
        return 0

    ASSETS.mkdir(parents=True, exist_ok=True)
    for digest, name in sha_to_name.items():
        if not name.startswith("inf-file-"):
            continue
        dest = ASSETS / name
        if not dest.exists():
            rep = seen_sha.get(digest)
            if rep is None:
                print(f"WARN: нет содержимого для {name}", flush=True)
                continue
            dest.write_bytes(rep["raw"].read_bytes())
    # привязка
    for tasks, refs in planned:
        for t in tasks:
            if t.get("files"):
                continue
            t["files"] = [{"assetId": r["assetId"], "name": r["name"]} for r in refs]
            per_skill[t["skill"]] = per_skill.get(t["skill"], 0) + 1
    for digest, name in sha_to_name.items():
        stem = Path(name).stem
        if stem in assets or not name.startswith("inf-file-"):
            continue
        rep = seen_sha.get(digest)
        assets[stem] = {"id": stem, "src": f"assets/informatics/{name}",
                        "type": "file",
                        "alt": f"Файл данных к заданию ({name})",
                        "name": (rep["name"] if rep else name),
                        "size": (rep["bytes"] if rep else 0),
                        "source": "sdamgia-inf-files",
                        "sourceId": stem.replace("inf-file-", "sdamgia-")}
    data["visualAssets"] = sorted(list(assets.values()), key=lambda a: str(a.get("id")))
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"подключено заданий: {per_skill}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
