#!/usr/bin/env python3
"""Чистка визуала обществознания: убрать ссылки на несуществующие рисунки.

После перехода «SVG -> PNG» (коммит 980148c) семь синтетических SVG были
удалены, но каталог продолжал на них ссылаться: 96 заданий №16 висели на
`assets/society/soc-law-crime.svg`, которого нет. Сами задания №16 — текстовые
(анализ ситуации со «слайдом», рисунок не нужен), поэтому корректный фикс —
снять с них visual и вычистить осиротевшие visualAssets.

Скрипт идемпотентен: снимает visual у заданий, чей файл рисунка отсутствует,
затем удаляет неиспользуемые записи visualAssets и связанные статусы аудита.

    python3 tools/fix_society_visuals.py --dry
    python3 tools/fix_society_visuals.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_society.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    assets = data.get("visualAssets", [])

    existing = {a["id"] for a in assets if (ROOT / a["src"].split("?")[0]).exists()}
    missing = {a["id"] for a in assets if a["id"] not in existing}
    print(f"visualAssets: {len(assets)}, файлов нет: {len(missing)} -> {sorted(missing)}")

    stripped = []
    for t in tasks:
        aid = (t.get("visual") or {}).get("assetId")
        if aid and aid not in existing:
            stripped.append((t["id"], aid))
            t.pop("visual", None)

    used = {((t.get("visual") or {}).get("assetId")) for t in tasks}
    keep_assets = [a for a in assets if a["id"] in used]
    dropped_assets = [a["id"] for a in assets if a["id"] not in used]

    audit = data.get("visualAudit")
    dropped_status = []
    if isinstance(audit, dict):
        old = audit.get("taskStatuses") if isinstance(audit.get("taskStatuses"), dict) else {}
        dropped_status = [tid for tid in old if tid not in {t["id"] for t in tasks}]
        # Нормализуем статусы к каноническим значениям аудита: задание с
        # реальным рисунком — visual-provided, без рисунка — не перечисляем
        # (действует defaultStatus = text-only). Раньше здесь встречалось
        # постороннее «published».
        canonical = {}
        for t in tasks:
            aid = (t.get("visual") or {}).get("assetId")
            if aid and aid in existing:
                canonical[t["id"]] = "visual-provided"
            elif (t.get("visual") or {}).get("required"):
                canonical[t["id"]] = "visual-required"
        audit["taskStatuses"] = canonical

    print(f"снято visual у заданий: {len(stripped)}"
          f"{' (напр. ' + ', '.join(t for t, _ in stripped[:4]) + ')' if stripped else ''}")
    print(f"осиротевших visualAssets: {len(dropped_assets)} -> {dropped_assets}")
    print(f"снято статусов аудита: {len(dropped_status)}")

    if args.dry:
        return 0

    data["visualAssets"] = keep_assets
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"записано: заданий {len(tasks)}, visualAssets {len(keep_assets)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())