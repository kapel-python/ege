#!/usr/bin/env python3
"""Добор биологии до TARGET заданий на тему из источника (Решу ЕГЭ).

Правила:
  * добор только для короткой части (линии 1–21): развёрнутая (22–28) —
    это сочинения/разборы, у них по 3 задания по смыслу;
  * существующие задания (включая официальные с рисунками) не трогаем;
  * дополняем только заданиями без картинок и без ссылок на рисунок;
  * задания, где текст задания ссылается на рисунок, пропускаем.

    python3 tools/apply_biology_topup.py --analyze
    python3 tools/apply_biology_topup.py
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_biology.json"
OUT_DIR = ROOT / "tools" / "out"

TARGET = 15
MAX_LINE = 21  # дальше — развёрнутая часть

FIG_RE = re.compile(
    r"на\s+рисунк|на\s+диаграмм|на\s+график|изображ[её]н|показан\w*\s+на"
    r"|см\.\s*рисун|рассмотрите рисунок", re.I)
STOP_ROWS = re.compile(r"^\s*(?:[А-ЯA-Z]|\d+)\)\s", re.M)
ALPHA_ROWS = re.compile(r"(?m)^[А-Я]\)\s")


def usable(r: dict) -> bool:
    if r.get("images"):
        return False
    text = r.get("condition") or ""
    if FIG_RE.search(text):
        return False
    ans = (r.get("answer") or "").strip()
    if not ans or ans in ("?", "-"):
        return False
    return True


def answer_kind(r: dict) -> str:
    ans = (r.get("answer") or "").strip()
    alts = [a.strip() for a in ans.split("|") if a.strip()]
    a = alts[0] if alts else ans
    if re.fullmatch(r"\d{2,8}", a):
        return "digits"
    return "text"


def hints_from(solution: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = "Прочитай условие и ответь на поставленный вопрос."
        return generic, [generic]
    return parts[0], parts[:3]


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def task_from_source(old: dict, raw: dict, n: int, new_id: str) -> dict:
    ans = (raw["answer"] or "").strip()
    alts = [x.strip() for x in ans.split("|") if x.strip()]
    text = (raw["condition"] or "").strip()
    hint, hints = hints_from(raw.get("solution") or "")
    task = {
        "id": new_id,
        "skill": old["skill"],
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": alts[0],
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": old.get("type", "short_answer"),
        "points": old.get("points", 1) or 1,
        "source": f"Решу ЕГЭ (СДАМ ГИА), биология, задание №{n}, {raw['url']}",
        "sourceId": f"sdamgia-{raw['src_id']}",
    }
    out = {k: task[k] for k in (
        "id", "skill", "sub", "num", "diff", "text", "answer", "hint", "hints",
        "solution", "type", "points", "source", "sourceId") if k in task}
    for k, v in old.items():
        if k not in out:
            out[k] = v
    if len(alts) > 1:
        out["accept"] = alts
    return out


def next_suffix(group: list[dict], prefix: str) -> int:
    best = 0
    for t in group:
        m = re.match(re.escape(prefix) + r"_p(\d+)$", t.get("id") or "")
        if m:
            best = max(best, int(m.group(1)))
    return best + 1


def skill_by_line(data: dict) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for s in data.get("skills", []):
        m = re.search(r"№\s*(\d+)", str(s.get("name") or "") + " " + str(s.get("id") or ""))
        if m:
            mapping[int(m.group(1))] = s["id"]
    return mapping


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = data["tasks"]
    skills = skill_by_line(data)

    added: list[dict] = []
    for n in sorted(skills):
        if n > MAX_LINE:
            continue
        skill = skills[n]
        group = sorted([t for t in tasks if t.get("skill") == skill],
                       key=lambda t: t.get("id") or "")
        need = TARGET - len(group)
        if need <= 0:
            print(f"№{n:2} {skill:16} уже {len(group)} — ок")
            continue
        used = {t.get("sourceId") for t in group}
        path = OUT_DIR / f"bio_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        pool = [r for r in raw if usable(r) and f"sdamgia-{r['src_id']}" not in used]
        k = next_suffix(group, f"bio{n:02d}")
        take = pool[:need]
        for r in take:
            added.append(task_from_source(group[0] if group else {"skill": skill, "id": ""},
                                          r, n, f"bio{n:02d}_p{k}"))
            k += 1
        print(f"№{n:2} {skill:16} было {len(group)}, добрано {len(take)}"
              f"{'' if len(take) == need else ' (не хватило пула!)'}")

    if args.analyze:
        print(f"\nдобавилось бы: {len(added)}; всего стало бы: {len(tasks) + len(added)}")
        return 0

    data["tasks"] = tasks + added
    data["tasks"].sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"добрано: {len(added)}; всего: {len(data['tasks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())