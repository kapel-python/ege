#!/usr/bin/env python3
"""Добор биологии до 100 заданий в каждой из 28 тем.

Что делает:
  * аналоги (`bio-*`, `sd-*`) заменяются настоящими заданиями источника,
    id сохраняются (на _p ссылаются миссии, на _p1 — диагностика);
  * официальные ФИПИ (`fipi-*`) и уже импортированные (`sdamgia-*`) не трогаем;
  * дальше каждая тема добирается до TARGET=100: сначала с рисунком
    (чертежи/фото через get_file -> assets/biology), потом тексты;
  * №1–21 — короткий ответ (автопроверка); №22–28 — развёрнутые
    (check:self, в answer/solution модельный ответ источника).

    python3 tools/apply_biology_topup.py --analyze
    python3 tools/apply_biology_topup.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_biology.json"
OUT_DIR = ROOT / "tools" / "out"
TARGET = 100
EXT_FROM = 22

FIG_RE = re.compile(
    r"рассмотрите\s+(рисунок|фотографию|схему)|на\s+рисунк|на\s+фотографии"
    r"|на\s+схем|изображ[её]н|показан\w*\s+на|см\.\s*рисун", re.I)
FORBIDDEN_SELF = re.compile(r"ответ запишите", re.I)

FIG_HINT = ("Внимательно рассмотри рисунок: сверь все обозначения и номера "
            "с условием.")


def is_analog(t: dict) -> bool:
    sid = t.get("sourceId") or ""
    return not (sid.startswith("sdamgia-") or sid.startswith("fipi-"))


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def clean(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"(?m)^(\s*)A\)", r"\1А)", text)
    return re.sub(r"[ \t]+", " ", text)


def tidy(text: str) -> str:
    out = re.sub(r"[ \t]+", " ", text or "")
    out = re.sub(r"\(\s+", "(", out)
    out = re.sub(r"\s+\)", ")", out)
    return re.sub(r"\n\s*\n+", "\n", out).strip()


def norm_answer(raw: str) -> str:
    return re.sub(r"\s+", "", (raw or "").replace("−", "-")).strip().strip(".")


def split_answer(raw: str) -> tuple[str, list[str] | None]:
    answer = re.sub(r"\s*\|\s*", "|", norm_answer(raw)).strip("|")
    if "|" in answer:
        variants = [v for v in answer.split("|") if v]
        return variants[0], variants
    return answer, None


def hints_for(solution: str, fig: bool) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    hints = ([FIG_HINT] if fig else []) + parts
    hints = [h for h in hints if h]
    while len(hints) < 3:
        hints.append(FIG_HINT if fig else "Прочитай условие и ответь на поставленный вопрос.")
    return hints[0], hints[:3]


def sub_from(text: str) -> str:
    line = re.sub(r"\s+", " ", text.split("\n")[0]).strip()
    return line[:56].rstrip(" ,;:") or "Задание"


def usable_short_text(r: dict) -> bool:
    if r.get("images"):
        return False
    if FIG_RE.search(r.get("condition") or ""):
        return False
    return bool((r.get("answer") or "").strip())


def usable_short_fig(r: dict) -> bool:
    return bool(r.get("images"))


def usable_ext(r: dict, *, want_fig: bool) -> bool:
    if not (r.get("condition") or "").strip() or not (r.get("solution") or "").strip():
        return False
    if FORBIDDEN_SELF.search(r.get("condition") or ""):
        return False
    has_img = bool(r.get("images"))
    if want_fig != has_img:
        return False
    if not want_fig and FIG_RE.search(r.get("condition") or ""):
        return False
    return True


def build_short(n: int, raw: dict, new_id: str, skill: str,
                asset_id: str | None) -> dict:
    text = tidy(clean(raw.get("condition") or ""))
    solution = tidy(raw.get("solution") or "")
    answer, accept = split_answer(raw.get("answer") or "")
    hint, hints = hints_for(solution, bool(asset_id))
    task = {
        "id": new_id, "skill": skill, "sub": sub_from(text), "num": f"№{n}",
        "diff": 1, "text": text, "answer": answer, "hint": hint, "hints": hints,
        "solution": solution, "type": "short_answer",
        "sourceId": f"sdamgia-{raw['src_id']}", "points": 1,
        "source": f"Решу ЕГЭ (СДАМ ГИА), биология, задание №{n}, {raw['url']}",
    }
    if accept:
        task["accept"] = accept
    if asset_id:
        task["visual"] = {"assetId": asset_id}
    return task


def build_ext(n: int, raw: dict, new_id: str, skill: str,
              asset_id: str | None) -> dict:
    text = tidy(clean(raw.get("condition") or ""))
    solution = tidy(raw.get("solution") or "")
    hint, hints = hints_for(solution, bool(asset_id))
    task = {
        "id": new_id, "skill": skill, "sub": sub_from(text), "num": f"№{n}",
        "diff": 2, "text": text, "answer": solution, "hint": hint, "hints": hints,
        "solution": solution, "type": "extended_answer", "check": "self",
        "selfCheck": True, "sourceId": f"sdamgia-{raw['src_id']}", "points": 2,
        "source": f"Решу ЕГЭ (СДАМ ГИА), биология, задание №{n}, {raw['url']}",
    }
    if asset_id:
        task["visual"] = {"assetId": asset_id}
    return task


def next_id(prefix: str, used: set[str], counters: dict[str, int]) -> str:
    counters[prefix] = counters.get(prefix, 0) + 1
    while f"{prefix}{counters[prefix]}" in used:
        counters[prefix] += 1
    new = f"{prefix}{counters[prefix]}"
    used.add(new)
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--lines", default=None, help="напр. 1-21 или 22,23")
    args = ap.parse_args()
    wanted: set[int] | None = None
    if args.lines:
        wanted = set()
        for part in args.lines.split(","):
            part = part.strip()
            if "-" in part:
                a, b = part.split("-", 1)
                wanted.update(range(int(a), int(b) + 1))
            elif part:
                wanted.add(int(part))

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks: list[dict] = data["tasks"]
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    skills = sorted(by_skill)
    assert len(skills) == 28, f"ожидали 28 тем, нашли {len(skills)}"

    used_src = {t.get("sourceId") for t in tasks if t.get("sourceId")}
    used_ids = {t["id"] for t in tasks}
    present = {norm(t.get("text")) for t in tasks}
    assets = {a["id"]: a for a in data.get("visualAssets", [])}
    audit = data.get("visualAudit")
    statuses = audit.setdefault("taskStatuses", {}) if isinstance(audit, dict) else {}
    counters: dict[str, int] = {}
    report: list[str] = []
    picked_fig = 0

    for skill in skills:
        n = int(skill[3:5])
        if wanted is not None and n not in wanted:
            continue
        group = by_skill[skill]
        extended = n >= EXT_FROM
        path = OUT_DIR / f"bio_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []

        def fresh(pool: list[dict]) -> list[dict]:
            out = []
            for r in pool:
                sid = f"sdamgia-{r['src_id']}"
                if sid in used_src:
                    continue
                if norm(clean(r.get("condition") or "")) in present:
                    continue
                out.append(r)
            return out

        if extended:
            figs = fresh([r for r in raw if usable_ext(r, want_fig=True)])
            texts = fresh([r for r in raw if usable_ext(r, want_fig=False)])
            builder = build_ext
        else:
            figs = fresh([r for r in raw if usable_short_fig(r)])
            texts = fresh([r for r in raw if usable_short_text(r)])
            builder = build_short

        analogs = sorted([t for t in group if is_analog(t)], key=lambda t: t["id"])
        need_topup = max(0, TARGET - len(group))
        report.append(f"№{n:2} {skill:16} есть {len(group):3}, аналогов {len(analogs):2}, "
                      f"рисунки {len(figs):3}, тексты {len(texts):3}, надо {need_topup:3}")
        if args.analyze:
            continue

        queue: list[tuple[dict, bool]] = ([(r, True) for r in figs]
                                          + [(r, False) for r in texts])
        qi = 0

        def take() -> tuple[dict, str | None] | None:
            nonlocal qi
            while qi < len(queue):
                r, want_fig = queue[qi]
                qi += 1
                asset_id = None
                if want_fig:
                    got = figure_import.import_task("bio", str(r["src_id"]), 2.5,
                                                    figures_only=True)
                    if not got:
                        continue
                    asset_id = got["id"]
                    if asset_id not in assets:
                        assets[asset_id] = {
                            "id": asset_id, "src": f"assets/biology/{asset_id}.png",
                            "type": "image", "alt": f"Рисунок к заданию (биология №{n})",
                            "width": got.get("width", 640),
                            "ratio": (got.get("width", 640) / got.get("height", 480)
                                      if got.get("height") else 1.3333),
                            "source": f"рисунок источника: {got['urls'][0]}"
                                      if got.get("urls") else "sdamgia",
                            "sourceId": asset_id, "taskId": None,
                            "description": f"Рисунок источника к заданию биологии №{n}",
                        }
                return r, asset_id
            return None

        def commit(new: dict, r: dict) -> None:
            used_src.add(f"sdamgia-{r['src_id']}")
            present.add(norm(new["text"]))

        for old in analogs:
            got = take()
            if got is None:
                report.append(f"    ! {old['id']}: аналогу нет замены")
                break
            r, asset_id = got
            new = builder(n, r, old["id"], skill, asset_id)
            if asset_id:
                statuses[old["id"]] = "visual-provided"
                picked_fig += 1
            tasks[tasks.index(old)] = new
            commit(new, r)

        made = 0
        while made < need_topup:
            got = take()
            if got is None:
                break
            r, asset_id = got
            prefix = f"bio{n:02d}_"
            kind = "f" if asset_id else "p"
            new_id = next_id(f"{prefix}{kind}", used_ids, counters)
            new = builder(n, r, new_id, skill, asset_id)
            tasks.append(new)
            if asset_id:
                statuses[new_id] = "visual-provided"
                picked_fig += 1
            commit(new, r)
            made += 1
            time.sleep(0.1)

        have = sum(1 for t in tasks if t.get("skill") == skill)
        report.append(f"    -> стало {have} (добавлено {made})")

    for line in report:
        print(line)
    if args.analyze:
        return 0
    data["tasks"] = sorted(tasks, key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    data["visualAssets"] = sorted(assets.values(), key=lambda a: a.get("id") or "")
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"записано: заданий {len(data['tasks'])}, ассетов {len(data['visualAssets'])}, "
          f"с рисунком новых {picked_fig}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
