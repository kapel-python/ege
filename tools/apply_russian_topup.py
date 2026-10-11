#!/usr/bin/env python3
"""Добор русского языка до 100 заданий в каждой теме №1–26.

Текущий банк (15 на тему) ссылается на Решу ЕГЭ словами, но без sourceId
проверить его нельзя. Поэтому заменяем ВСЕ 15 существующих настоящим
содержимым источника (id сохраняем: на rXX_1..3 ссылаются миссии, на
rXX_1 — диагностика), затем добираем до TARGET=100 новыми id rXX_16+.

Сочинение (russian_essay_source) не трогаем: там своя механика.
Рисунков в русском ЕГЭ нет — только текст.
Ответы с вариантами «a|b» кладём в accept (движок понимает).

    python3 tools/apply_russian_topup.py --analyze
    python3 tools/apply_russian_topup.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_russian.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 100
ESSAY_SKILL = "russian_essay_source"

FIG_RE = re.compile(
    r"на\s+рисунк|на\s+диаграмм|на\s+график|изображ[её]н|показан\w*\s+на"
    r"|см\.\s*рисун", re.I)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def clean(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)
    return re.sub(r"[ \t]+", " ", text)


def hints_from(solution: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = "Прочитай условие и ответь на поставленный вопрос."
        return generic, [generic]
    hints = parts[:3]
    while len(hints) < 3:
        hints.append(parts[-1])
    return hints[0], hints


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def usable(r: dict) -> bool:
    if r.get("images"):
        return False
    if FIG_RE.search(r.get("condition") or ""):
        return False
    return bool((r.get("answer") or "").strip())


def split_answer(raw: str) -> tuple[str, list[str] | None]:
    answer = re.sub(r"\s*\|\s*", "|", (raw or "").strip().strip(".")).strip("|")
    if "|" in answer:
        variants = [v for v in answer.split("|") if v]
        return variants[0], variants
    return answer, None


def build(old: dict, n: int, raw: dict, new_id: str, skill: str,
         value_type: str) -> dict:
    text = clean(raw.get("condition") or "")
    solution = re.sub(r"[ \t]+", " ", (raw.get("solution") or "").strip())
    answer, accept = split_answer(raw.get("answer") or "")
    hint, hints = hints_from(solution)
    task = {
        "id": new_id, "skill": skill, "sub": sub_from(text), "num": f"№{n}",
        "diff": 1, "text": text, "answer": answer, "hint": hint, "hints": hints,
        "solution": solution, "type": "short_answer",
        "sourceId": f"sdamgia-{raw['src_id']}", "points": 1,
        "valueType": value_type,
        "source": f"Решу ЕГЭ (СДАМ ГИА), русский язык, задание №{n}, {raw['url']}",
    }
    if accept:
        task["accept"] = accept
    return task


def skill_line(skill_id: str) -> int | None:
    m = re.match(r"r(\d+)$", skill_id)
    return int(m.group(1)) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks: list[dict] = data["tasks"]
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)

    used_src = {t.get("sourceId") for t in tasks if t.get("sourceId")}
    present = {norm(t.get("text")) for t in tasks if t.get("skill") != ESSAY_SKILL}
    report: list[str] = []

    for skill in sorted(by_skill):
        if skill == ESSAY_SKILL:
            continue
        n = skill_line(skill)
        group = sorted(by_skill[skill], key=lambda t: t["id"])
        vt = max({t.get("valueType") for t in group if t.get("valueType")},
                 key=lambda v: sum(1 for t in group if t.get("valueType") == v),
                 default="цифра")
        path = OUT_DIR / f"rus_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = []
        for r in raw:
            if not usable(r):
                continue
            sid = f"sdamgia-{r['src_id']}"
            if sid in used_src:
                continue
            if norm(clean(r.get("condition") or "")) in present:
                continue
            pool.append(r)
        need_new = max(0, TARGET - len(group))
        report.append(f"№{n:2} {skill:8} есть {len(group):3}, пул {len(pool):3}, "
                      f"надо новых {need_new:3}, valueType {vt}")
        if args.analyze:
            continue
        qi = 0

        def take() -> dict | None:
            nonlocal qi
            while qi < len(pool):
                r = pool[qi]
                qi += 1
                return r
            return None

        def commit(new: dict, r: dict) -> None:
            used_src.add(f"sdamgia-{r['src_id']}")
            present.add(norm(new["text"]))

        for old in group:  # только непроверяемые (без sourceId API) — заменить
            if (old.get("sourceId") or "").startswith("sdamgia-"):
                continue
            r = take()
            if r is None:
                report.append(f"    ! {old['id']}: нет замены")
                break
            new = build(old, n, r, old["id"], skill, vt)
            tasks[tasks.index(old)] = new
            commit(new, r)
        made = 0
        k = max([int(m.group(1)) for t in group
                 for m in [re.search(r"_(\d+)$", t["id"])] if m] or [0])
        while made < need_new:
            r = take()
            if r is None:
                break
            k += 1
            new_id = f"{skill}_{k}"
            while new_id in {t["id"] for t in tasks}:
                k += 1
                new_id = f"{skill}_{k}"
            new = build({}, n, r, new_id, skill, vt)
            tasks.append(new)
            commit(new, r)
            made += 1
        have = sum(1 for t in tasks if t.get("skill") == skill)
        report.append(f"    -> стало {have} (добавлено {made})")

    for line in report:
        print(line)
    if args.analyze:
        return 0
    data["tasks"] = sorted(tasks, key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"записано: заданий {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
