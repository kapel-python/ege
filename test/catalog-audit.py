#!/usr/bin/env python3
"""Регрессия: каталог обществознания чист по аудиту импорта.

Импортёр умеет падать «тихо» (потерять решение части 2, выбросить рисунок с
двумя метками-вотермарками, подмешать чужую линию). Поэтому после каждого
импорта прогоняем tools/audit_catalog_import.py: дубли текста, самописные
аналоги, остатки вёрстки, битые/лишние рисунки и форматы ответов не должны
накапливаться незамеченными.

    python3 test/catalog-audit.py
"""
from __future__ import annotations

import importlib.util

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_audit():
    path = ROOT / "tools" / "audit_catalog_import.py"
    spec = importlib.util.spec_from_file_location("ege_catalog_audit", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    audit = load_audit()
    hard, soft = audit.audit_catalog(ROOT / "server" / "catalog_society.json")
    for line in hard:
        print("FAIL " + line)
    for line in soft:
        print("warn " + line)
    print("ok   каталог обществознания: "
          f"{'жёстких проблем нет' if not hard else str(len(hard)) + ' проблем'}")
    print("CATALOG-AUDIT OK" if not hard else "CATALOG-AUDIT FAIL")
    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())