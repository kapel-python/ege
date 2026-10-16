#!/usr/bin/env python3
"""Рисунки решений (task.solutionAssets) во всех каталогах.

Живой факт: ссылки «см. рис. N» / «Рис. N» в solution — настоящие чертежи
источника (get_file в блоке решения, survey tools/out/<subject>_solfig.json),
а не формулы. Импортёр tools/import_solution_figures.py --subject <s> вывозит
их в assets/<dir>/<prefix>-sol<FID>.png и цепляет заданию полем solutionAssets
(порядок документа = Рис. 1..N). Старый клиент поле игнорирует, новый
рендерит под разбором (solutionFiguresHtml в js/app.js).

Тест фиксирует:
  1) в КАЖДОМ каталоге: каждый solutionAssets id есть в visualAssets своего
     каталога, файл на диске — валидный PNG, не вырожденный, размеры совпадают
     с записью, src несёт ?v=-хеш содержимого, source указывает на get_file;
  2) solutionAssets не пересекаются с visual.assetId условия;
  3) масштаб по каждому предмету (точные числа привязок);
  4) живой пример n15_p6 (sdamgia-519659) матпрофиля;
  5) клиент: solutionFiguresHtml вызывается в обоих путях показа разбора,
     stripMissingFigures умеет третий аргумент.

    python3 test/solution-figures.py
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog.json"
APP_JS = ROOT / "js" / "app.js"

# Точные числа привязок solutionAssets по каталогам (итог survey+импорта).
# Заполняется по мере обработки предметов; 0 = рисунков решений нет.
EXPECTED_LINKED = {
    "catalog.json": 424,
    "catalog_basic.json": 90,
    "catalog_biology.json": 20,
    "catalog_oge_informatics.json": 32,
}

SUBJECT_PREFIX = {
    "catalog.json": "math-sol",
    "catalog_basic.json": "mathb-sol",
    "catalog_biology.json": "bio-sol",
    "catalog_history.json": "his-sol",
    "catalog_informatics.json": "inf-sol",
    "catalog_russian.json": "rus-sol",
    "catalog_society.json": "soc-sol",
    "catalog_oge_math.json": "oge-sol",
    "catalog_oge_biology.json": "bio_oge-sol",
    "catalog_oge_history.json": "hist_oge-sol",
    "catalog_oge_informatics.json": "inf_oge-sol",
    "catalog_oge_society.json": "soc_oge-sol",
}


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def main() -> int:
    fails: list[str] = []

    def check(name: str, cond: bool, extra: str = "") -> None:
        print(("ok   " if cond else "FAIL ") + name + ("" if cond or not extra else " | " + extra))
        if not cond:
            fails.append(name)

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks: list[dict] = data.get("tasks", [])
    assets = {a.get("id"): a for a in data.get("visualAssets", [])}

    # Целостность solutionAssets ВО ВСЕХ каталогах (поле и рендер общие).
    for name, want_prefix in sorted(SUBJECT_PREFIX.items()):
        if name == "catalog.json":
            continue
        cdata = json.loads((ROOT / "server" / name).read_text(encoding="utf-8"))
        cassets = {a.get("id"): a for a in cdata.get("visualAssets", [])}
        for t in cdata.get("tasks", []):
            ids = t.get("solutionAssets")
            if not ids:
                continue
            tasks.append(t)  # для общих счётчиков ниже — с меткой каталога
            t["_catalog"] = name
            assets.update({k: v for k, v in cassets.items() if k not in assets})

    linked = [t for t in tasks if t.get("solutionAssets")]
    math_linked = [t for t in linked if not t.get("_catalog")]
    check("solutionAssets: привязок матпрофиля == 424", len(math_linked) == 424,
          f"found {len(math_linked)}")

    bad_ref = bad_file = bad_size = bad_ver = bad_src = overlap = bad_prefix = 0
    per_catalog: dict[str, int] = {}
    for t in linked:
        ids = t.get("solutionAssets")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            bad_ref += 1
            continue
        cat = t.get("_catalog") or "catalog.json"
        per_catalog[cat] = per_catalog.get(cat, 0) + 1
        want_prefix = SUBJECT_PREFIX[cat]
        cond_visual = (t.get("visual") or {}).get("assetId")
        for aid in ids:
            if aid == cond_visual:
                overlap += 1
            a = assets.get(aid)
            if a is None:
                bad_ref += 1
                continue
            if not aid.startswith(want_prefix):
                bad_prefix += 1
            src = str(a.get("src") or "")
            base = src.split("?", 1)[0]
            path = ROOT / base
            size = png_size(path)
            if size is None:
                bad_file += 1
                continue
            w, h = size
            # Порог 30px: ловит вырожденный мусор (запятая 15x21), но держит
            # легитимные полоски-иллюстрации (числовая прямая 164x35,
            # фрагменты схем скрещивания 161x37 — проверены глазами).
            if w < 30 or h < 30:
                bad_size += 1
            if a.get("width") != w or a.get("height") != h:
                bad_size += 1
            digest = hashlib.md5(path.read_bytes()).hexdigest()[:10]
            if src != f"{base}?v={digest}":
                bad_ver += 1
            if "get_file?id=" not in str(a.get("source") or ""):
                bad_src += 1
    check("solutionAssets: все id резолвятся (<prefix>-sol*)",
          bad_ref == 0 and bad_prefix == 0, f"bad {bad_ref}/{bad_prefix}")
    check("solutionAssets: файлы — валидные PNG", bad_file == 0, f"bad {bad_file}")
    check("solutionAssets: размеры не вырождены и совпадают", bad_size == 0, f"bad {bad_size}")
    check("solutionAssets: ?v=-хеш содержимого", bad_ver == 0, f"bad {bad_ver}")
    check("solutionAssets: source ведёт на get_file решения", bad_src == 0, f"bad {bad_src}")
    check("solutionAssets: не затирают visual условия", overlap == 0, f"overlap {overlap}")
    for name, want in sorted(EXPECTED_LINKED.items()):
        got = per_catalog.get(name, 0)
        check(f"масштаб {name}: привязок == {want}", got == want, f"found {got}")

    by_skill: dict[str, int] = {}
    for t in math_linked:
        by_skill[t.get("skill") or ""] = by_skill.get(t.get("skill") or "", 0) + 1
    check("линия 18 покрыта целиком (98/100...==98)",
          by_skill.get("n18_planimetry", 0) == 98, str(by_skill.get("n18_planimetry")))
    check("линия 15 покрыта почти целиком (>=95)",
          by_skill.get("n15_stereometry", 0) >= 95, str(by_skill.get("n15_stereometry")))

    p6 = next((t for t in math_linked if t.get("id") == "n15_p6"), None)
    check("n15_p6 существует", p6 is not None)
    if p6 is not None:
        check("n15_p6: ровно 4 рисунка решения в порядке документа",
              p6.get("solutionAssets") == ["math-sol141309", "math-sol141308",
                                           "math-sol141307", "math-sol119950"],
              repr(p6.get("solutionAssets")))
        check("n15_p6: «см. рис. 1» в solution на месте",
              "см. рис. 1" in (p6.get("solution") or ""),
              (p6.get("solution") or "")[:120])

    src = APP_JS.read_text(encoding="utf-8")
    check("js: solutionFiguresHtml определён",
          "function solutionFiguresHtml(task" in src)
    check("js: stripMissingFigures с третьим аргументом",
          "function stripMissingFigures(solution, hasVisual, hasSolutionFigs)" in src)
    check("js: разбор части 2 рендерит solutionFiguresHtml",
          "sessionSelfRevealFeedbackHtml" in src
          and "${mathText(solution)}${solutionFiguresHtml(t)}" in src)
    check("js: разбор части 1 рендерит solutionFiguresHtml",
          "${solutionFiguresHtml(t)}</div>" in src
          and "stripMissingFigures(t.solution" in src)

    print("SOLUTION-FIGURES " + ("OK" if not fails else f"FAIL ({len(fails)})"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
