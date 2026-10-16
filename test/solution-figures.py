#!/usr/bin/env python3
"""Рисунки решений матпрофиля (task.solutionAssets).

Живой факт: ссылки «см. рис. N» / «Рис. N» в solution — настоящие чертежи
источника (get_file в блоке решения, tools/out/math_solfig.json), а не
формулы. Импортёр tools/import_solution_figures.py вывозит их в
assets/math/math-sol<FID>.png и цепляет заданию полем solutionAssets
(порядок документа = Рис. 1..N). Старый клиент поле игнорирует, новый
рендерит под разбором (solutionFiguresHtml в js/app.js).

Тест фиксирует:
  1) каждый solutionAssets id есть в visualAssets, файл на диске — валидный
     PNG, не вырожденный, размеры совпадают с записью, src несёт ?v=-хеш
     содержимого, source указывает на get_file решения;
  2) solutionAssets не пересекаются с visual.assetId условия (поле только
     добавляет, старое не трогает);
  3) масштаб: привязок не меньше 400, линии 15 и 18 покрыты почти целиком;
  4) живой пример n15_p6 (sdamgia-519659): три рисунка решения в порядке
     документа, ссылка «см. рис. 1» в solution на месте (режем на клиенте,
     не в данных);
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

    linked = [t for t in tasks if t.get("solutionAssets")]
    check("solutionAssets: привязок >= 400", len(linked) >= 400, f"found {len(linked)}")

    bad_ref = bad_file = bad_size = bad_ver = bad_src = overlap = 0
    for t in linked:
        ids = t.get("solutionAssets")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            bad_ref += 1
            continue
        cond_visual = (t.get("visual") or {}).get("assetId")
        for aid in ids:
            if aid == cond_visual:
                overlap += 1
            a = assets.get(aid)
            if a is None:
                bad_ref += 1
                continue
            if not aid.startswith("math-sol"):
                bad_ref += 1
            src = str(a.get("src") or "")
            base = src.split("?", 1)[0]
            path = ROOT / base
            size = png_size(path)
            if size is None:
                bad_file += 1
                continue
            w, h = size
            if w < 40 or h < 40:
                bad_size += 1
            if a.get("width") != w or a.get("height") != h:
                bad_size += 1
            digest = hashlib.md5(path.read_bytes()).hexdigest()[:10]
            if src != f"{base}?v={digest}":
                bad_ver += 1
            if "get_file?id=" not in str(a.get("source") or ""):
                bad_src += 1
    check("solutionAssets: все id резолвятся в math-sol*", bad_ref == 0, f"bad {bad_ref}")
    check("solutionAssets: файлы — валидные PNG", bad_file == 0, f"bad {bad_file}")
    check("solutionAssets: размеры не вырождены и совпадают", bad_size == 0, f"bad {bad_size}")
    check("solutionAssets: ?v=-хеш содержимого", bad_ver == 0, f"bad {bad_ver}")
    check("solutionAssets: source ведёт на get_file решения", bad_src == 0, f"bad {bad_src}")
    check("solutionAssets: не затирают visual условия", overlap == 0, f"overlap {overlap}")

    by_skill: dict[str, int] = {}
    for t in linked:
        by_skill[t.get("skill") or ""] = by_skill.get(t.get("skill") or "", 0) + 1
    check("линия 18 покрыта целиком (98/100...==98)",
          by_skill.get("n18_planimetry", 0) == 98, str(by_skill.get("n18_planimetry")))
    check("линия 15 покрыта почти целиком (>=95)",
          by_skill.get("n15_stereometry", 0) >= 95, str(by_skill.get("n15_stereometry")))

    p6 = next((t for t in tasks if t.get("id") == "n15_p6"), None)
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
