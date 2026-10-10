#!/usr/bin/env python3
"""Пересборка банка базовой математики по выгрузкам источника (tools/out/mathb_NN.json).

Правила (согласованы):
  * меняем ТОЛЬКО тестовую часть тех тем, где задание решается без рисунка;
  * «рисовальные» темы (№3, 7, 9, 11, 18) не трогаем: там уже верные официальные
    задания с восстановленными фигурами (MathVisual), а источник отдаёт фигуры
    растром, часто по несколько на задание — наш рендер их показать не может;
  * из источника берём только задания без картинок (images == 0);
  * формат ответа (valueType) определяем по данным источника: таблица-бланк
    «последовательность цифр» — по словам «соответствие» и числу позиций А…Г,
    иначе «целое число» / «конечная десятичная дробь».

    python3 tools/apply_basic.py --analyze   # сводка по темам, ничего не пишет
    python3 tools/apply_basic.py             # переписать server/catalog_basic.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_basic.json"
OUT_DIR = ROOT / "tools" / "out"

# Эти темы содержат задания, которые без рисунка не решить: не трогаем.
VISUAL_SKILLS = {"b03_tables", "b07_functions", "b09_grid",
                 "b11_practstereo", "b18_inequalities"}
MATCHING_RE = re.compile(r"соответстви|под каждой буквой|под каждой точкой", re.I)
EXPLICIT_RE = re.compile(r"\(([А-ЯA-Z]{2,8})\)")
ROW_LABEL_RE = re.compile(r"(?:^|\n)\s*([А-ЯA-Z])\)\s")
# Мультивыбор («выберите все утверждения», «набор номеров без пробелов»)
# тоже отдаётся набором цифр — как в бланке ЕГЭ («последовательность цифр»).
MULTI_RE = re.compile(
    r"без пробелов|без запятых|один\s+набор"
    r"|набор\s+(?:номеров|маршрутов|переводчиков|чисел|сумм)"
    r"|выберите\s+(?:все\s+|верные\s+|несколько\s+)?(?:утвержд|вариант)"
    r"|выберите\s+номера"
    r"|укажите\s+(?:номера|номера|цифры)"
    r"|запишите\s+(?:номера|цифры)"
    r"|номера\s+(?:выбранных|верных|соответствующих|двух|трёх|трех)", re.I)
# Текст ссылается на рисунок, которого у нас нет: задание без картинки не
# решить, поэтому в отбор не берём даже при images == 0.
FIG_RE = re.compile(
    r"на\s+рисунк|на\s+график|на\s+диаграмм|на\s+схем|изображ[её]н"
    r"|показан\w*\s+на\s+рисунк|см\.\s*рисун", re.I)
KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint", "hints",
             "solution", "type", "sourceId", "status", "example", "points",
             "valueType", "source", "subject"]


def matching_positions(text: str) -> int:
    m = EXPLICIT_RE.search(text)
    if m and len(set(m.group(1))) == len(m.group(1)):
        return len(m.group(1))
    labels = []
    for found in ROW_LABEL_RE.finditer(text):
        if not labels or labels[-1] != found.group(1):
            labels.append(found.group(1))
    return len(labels)


def classify(text: str, raw_answer: str) -> str:
    alts = [x.strip() for x in raw_answer.split("|") if x.strip()]
    a = alts[0] if alts else ""
    digits = bool(a) and re.fullmatch(r"[1-9]+", a) is not None
    if MATCHING_RE.search(text) and digits and matching_positions(text) == len(a):
        return "последовательность цифр"
    if digits and MULTI_RE.search(text):
        return "последовательность цифр"
    if re.fullmatch(r"[+-]?\d+", a):
        return "целое число"
    if re.fullmatch(r"[+-]?\d+[.,]\d+", a):
        return "конечная десятичная дробь"
    return "целое число"


def clean(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)   # латинская A) -> А)
    return text


def hints_from(solution: str, answer: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = "Прочитай условие и ответь на поставленный вопрос."
        return generic, [generic]
    return parts[0], parts[:3]


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def skill_by_line(data: dict) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for s in data.get("skills", []):
        found = re.search(r"№\s*(\d+)", str(s.get("name") or "") + " " + str(s.get("id") or ""))
        if found:
            mapping[int(found.group(1))] = s["id"]
    return mapping


def task_from_source(n: int, idx: int, raw: dict, skill: str) -> dict:
    alts = [x.strip().strip(".") for x in (raw["answer"] or "").split("|") if x.strip()]
    answer = alts[0] if alts else ""
    text = clean(raw["condition"])
    value_type = classify(text, raw["answer"] or "")
    hint, hints = hints_from(raw.get("solution") or "", answer)
    task = {
        "id": f"b{n:02d}_p{idx}",
        "skill": skill,
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": answer,
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": "short_answer",
        "sourceId": f"sdamgia-{raw['src_id']}",
        "status": "sdamgia",
        "example": idx,
        "points": 1,
        "valueType": value_type,
        "source": f"Решу ЕГЭ (СДАМ ГИА), база, задание №{n}, {raw['url']}",
        "subject": "basic_math",
    }
    out = {k: task[k] for k in KEY_ORDER}
    if len(alts) > 1:
        # Допустимые варианты набора: источник разделяет их «|».
        rebuilt: dict = {}
        for key, val in out.items():
            rebuilt[key] = val
            if key == "answer":
                rebuilt["accept"] = alts
        out = rebuilt
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    skills = skill_by_line(data)
    rebuilt: dict[str, list[dict]] = {}
    summary = []

    for n in range(1, 22):
        skill = skills.get(n)
        if not skill:
            summary.append((n, "?", 0, "нет навыка", 0))
            continue
        if skill in VISUAL_SKILLS:
            summary.append((n, skill, 0, "рисовальная — не трогаем", 0))
            continue
        path = OUT_DIR / f"mathb_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        plain = [r for r in raw
                 if not r.get("images") and not FIG_RE.search(r.get("condition") or "")]
        picked = plain[:15]
        rebuilt[skill] = [task_from_source(n, i, r, skill) for i, r in enumerate(picked, 1)]
        summary.append((n, skill, len(picked), f"из {len(raw)} (без рисунков {len(plain)})", len(raw)))

    for n, skill, got, note, total in summary:
        flag = "OK " if got == 15 or "рисовальная" in note else "!! "
        print(f"{flag} №{n:2} {skill:20} {got:>2} заданий  {note}")

    if args.analyze:
        return 0

    missing = [s for s, ts in rebuilt.items() if len(ts) != 15]
    if missing:
        print("НЕ ХВАТИЛО заданий (не переписываю эти темы):", ", ".join(missing))
    ready = {s: ts for s, ts in rebuilt.items() if len(ts) == 15}

    # Меняем только готовые НЕ-рисовальные темы; «рисовальные» и недобранные
    # оставляем нетронутыми.
    kept = [t for t in data["tasks"] if t.get("skill") not in ready]
    merged = kept + [t for s, ts in ready.items() for t in ts]
    merged.sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    data["tasks"] = merged

    # Аудит визуала: у подменённых заданий рисунка нет — помечаем text-only.
    audit = data.get("visualAudit")
    if isinstance(audit, dict) and isinstance(audit.get("taskStatuses"), dict):
        for s, ts in ready.items():
            for t in ts:
                audit["taskStatuses"][t["id"]] = "text-only"

    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    per: dict[str, int] = {}
    for t in data["tasks"]:
        per[t["skill"]] = per.get(t["skill"], 0) + 1
    print(f"записано: всего {len(data['tasks'])} заданий, тем {len(per)}")
    print("по темам:", {k: per[k] for k in sorted(per)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())