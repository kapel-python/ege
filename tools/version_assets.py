#!/usr/bin/env python3
"""Версия в URL каждого рисунка: ?v=<хеш содержимого>.

Сервер отдаёт assets с Cache-Control: immutable, max-age=1 год. Когда файл
перегенерируют (чистка вотермарки, обрезка полей), имя не меняется — браузер
годами держит старую картинку, и правки «не видны». Хеш в query меняет URL
ровно тогда, когда меняется файл.

    python3 tools/version_assets.py
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGS = ["catalog.json", "catalog_basic.json", "catalog_society.json",
            "catalog_informatics.json", "catalog_biology.json",
            "catalog_russian.json"]


def main() -> int:
    for name in CATALOGS:
        path = ROOT / "server" / name
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = 0
        for asset in data.get("visualAssets", []) or []:
            src = str(asset.get("src") or "")
            if not src:
                continue
            base = src.split("?", 1)[0]
            f = ROOT / base
            if not f.exists():
                continue
            digest = hashlib.md5(f.read_bytes()).hexdigest()[:10]
            new_src = f"{base}?v={digest}"
            if asset.get("src") != new_src:
                asset["src"] = new_src
                changed += 1
        if changed:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8")
        print(f"{name}: обновлено URL {changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
