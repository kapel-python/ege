#!/usr/bin/env python3
"""Добор профильной математики до 100 заданий в каждой из 20 тем.

Что делает:
  * аналоги (`author-analog`, `analog-openbank`) заменяются настоящими
    заданиями источника, id сохраняются;
  * дальше каждая тема добирается до TARGET=100: сначала задания с настоящим
    рисунком (чертежи/графики через get_file -> assets/math), потом текстовые;
  * №1–13 — короткий ответ (автопроверка, ответ число/десятичная дробь);
    №14–20 — развёрнутые (check:self, в answer/solution модельный ответ);
  * официальные демо/openbank и уже импортированные sdamgia не трогаем.

    python3 tools/apply_profile_topup.py --analyze
    python3 tools/apply_profile_topup.py
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

import apply_profile as base  # noqa: E402
import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog.json"
OUT_DIR = ROOT / "tools" / "out"
FIGCLASS = OUT_DIR / "math_figclass.json"
TARGET = 100

ANALOG_RE = re.compile(r"analog", re.I)
FORBIDDEN_SELF = re.compile(r"ответ запишите", re.I)

FIG_HINT_SHORT = ("Внимательно рассмотри рисунок: сверь все обозначения, "
                  "длины и точки с условием.")
FIG_HINT_EXT = ("Разбери рисунок: отметки на нём — часть условия, "
                "перенеси их в свой чертёж решения.")
PIC_HINT_SHORT = ("Формула — на рисунке: перепиши её аккуратно и решай.")
PIC_HINT_EXT = ("Уравнение — на рисунке: перепиши его точно и решай письменно.")


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def tidy(text: str) -> str:
    """Единый вид текста независимо от версии импортёра на момент выгрузки."""
    out = re.sub(r"[ \t]+", " ", text or "")
    out = re.sub(r"\(\s+", "(", out)
    out = re.sub(r"\s+\)", ")", out)
    return re.sub(r"\n\s*\n+", "\n", out).strip()


def norm_answer(raw: str) -> str:
    a = (raw or "").replace("−", "-").replace("–", "-").replace("\xa0", "")
    return re.sub(r"\s+", "", a).strip().strip(".")


def skill_by_line(data: dict) -> dict[int, str]:
    return base.skill_by_line(data)


# Потолки картинок в условии для заданий с формулами-картинками:
# больше — не читается как экзамен, такое не берём.
TEX_MAX = 3
TOTAL_MAX = 4


def entry(n: int, src_id: str, figclass: dict) -> dict:
    return figclass.get(f"{n}:{src_id}") or {}


def cond_clean(n: int, src_id: str, figclass: dict) -> bool:
    """Условие без единой картинки (значит, и без формул): как на экзамене.
    Без записи в кэше — не годно."""
    e = entry(n, src_id, figclass)
    return e.get("cond_n") == 0


def cond_figure_ok(n: int, src_id: str, figclass: dict) -> bool:
    """Чертёж годен: настоящий рисунок есть, а формул-картинок в условии нет.
    Без явной записи в кэше — не годен."""
    e = entry(n, src_id, figclass)
    return e.get("fig_n", 0) > 0 and not e.get("tex_n")


def cond_formula_pic(n: int, src_id: str, figclass: dict) -> bool:
    """Условие — формулы картинками (без чертежа): покажем их картинкой,
    как напечатано на экзамене. Не больше TEX_MAX штук."""
    e = entry(n, src_id, figclass)
    tex = e.get("tex_n")
    return (not e.get("fig_n")) and isinstance(tex, int) and 1 <= tex <= TEX_MAX


def cond_mixed_ok(n: int, src_id: str, figclass: dict) -> bool:
    """Чертёж + немного формул (векторы, графики): клеим всё по порядку,
    как идёт в условии. Всего не больше TOTAL_MAX."""
    e = entry(n, src_id, figclass)
    fig, tex = e.get("fig_n"), e.get("tex_n")
    if not isinstance(fig, int) or not isinstance(tex, int):
        return False
    return fig > 0 and tex > 0 and fig + tex <= TOTAL_MAX


def usable_pic_short(n: int, r: dict, figclass: dict) -> bool:
    """Условие — только формулы картинками: покажем их картинкой."""
    if not cond_formula_pic(n, str(r["src_id"]), figclass):
        return False
    ans = norm_answer(r.get("answer") or "")
    if "|" in ans:
        return False
    return base.classify(ans) is not None


def usable_mixed_short(n: int, r: dict, figclass: dict) -> bool:
    """Чертёж + немного формул: склеим всё по порядку условия."""
    if not cond_mixed_ok(n, str(r["src_id"]), figclass):
        return False
    ans = norm_answer(r.get("answer") or "")
    if "|" in ans:
        return False
    return base.classify(ans) is not None


def usable_pic_ext(n: int, r: dict, figclass: dict) -> bool:
    if not cond_formula_pic(n, str(r["src_id"]), figclass):
        return False
    if not (r.get("solution") or "").strip():
        return False
    if FORBIDDEN_SELF.search(r.get("condition") or ""):
        return False
    return True


def usable_mixed_ext(n: int, r: dict, figclass: dict) -> bool:
    if not cond_mixed_ok(n, str(r["src_id"]), figclass):
        return False
    if not (r.get("solution") or "").strip():
        return False
    if FORBIDDEN_SELF.search(r.get("condition") or ""):
        return False
    return True


def usable_short_text(n: int, r: dict, figclass: dict) -> bool:
    # Условие чистое по построению; решение может объяснять математику
    # словами (как учитель у доски).
    if not cond_clean(n, str(r["src_id"]), figclass):
        return False
    if base.FIG_RE.search(r.get("condition") or ""):
        return False
    ans = norm_answer(r.get("answer") or "")
    if "|" in ans:
        return False
    return base.classify(ans) is not None


def usable_short_fig(n: int, r: dict, figclass: dict) -> bool:
    if not cond_figure_ok(n, str(r["src_id"]), figclass):
        return False
    ans = norm_answer(r.get("answer") or "")
    if "|" in ans:
        return False
    return base.classify(ans) is not None


def usable_ext(n: int, r: dict, figclass: dict, *, want_fig: bool) -> bool:
    if not (r.get("condition") or "").strip() or not (r.get("solution") or "").strip():
        return False
    if FORBIDDEN_SELF.search(r.get("condition") or ""):
        return False
    if want_fig:
        if not cond_figure_ok(n, str(r["src_id"]), figclass):
            return False
    elif not cond_clean(n, str(r["src_id"]), figclass):
        return False
    if not want_fig and base.FIG_RE.search(r.get("condition") or ""):
        return False
    return True


def hints_for(solution: str, answer: str, fig_hint: str | None) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    hints = ([fig_hint] if fig_hint else []) + parts
    hints = [h for h in hints if h]
    while len(hints) < 3:
        hints.append(fig_hint or "Прочитай условие и ответь на поставленный вопрос.")
    hint, hints3 = hints[0], hints[:3]
    _ = answer
    return hint, hints3


def build_short(old: dict, n: int, raw: dict, new_id: str, skill: str,
                asset_id: str | None, pic: bool = False) -> dict:
    fixed = dict(raw)
    fixed["answer"] = norm_answer(raw.get("answer") or "")
    fixed["condition"] = tidy(base.clean(raw.get("condition") or ""))
    fixed["solution"] = tidy(raw.get("solution") or "")
    task = base.task_from_source(new_id, n, 1, fixed, skill)
    task = dict(task)
    if asset_id:
        fig_hint = PIC_HINT_SHORT if pic else FIG_HINT_SHORT
    else:
        fig_hint = None
    hint, hints = hints_for(task["solution"], task["answer"], fig_hint)
    task["hint"], task["hints"] = hint, hints
    if asset_id:
        task["visual"] = {"assetId": asset_id}
    # task_from_source уже проставил sub/num/diff/points/valueType/source.
    return task


def build_ext(old: dict, n: int, raw: dict, new_id: str, skill: str,
              asset_id: str | None, pic: bool = False) -> dict:
    text = tidy(base.clean(raw.get("condition") or ""))
    solution = tidy(raw.get("solution") or "")
    if asset_id:
        fig_hint = PIC_HINT_EXT if pic else FIG_HINT_EXT
    else:
        fig_hint = None
    hint, hints = hints_for(solution, solution, fig_hint)
    task = {
        "id": new_id, "skill": skill, "sub": base.sub_from(text), "num": f"№{n}",
        "diff": 2, "text": text, "answer": solution, "hint": hint, "hints": hints,
        "solution": solution, "type": "extended_answer", "check": "self",
        "selfCheck": True, "sourceId": f"sdamgia-{raw['src_id']}",
        "status": "sdamgia", "example": 1, "points": 2,
        "valueType": "общее решение + список",
        "source": f"Решу ЕГЭ (СДАМ ГИА), профиль, задание №{n}, {raw['url']}",
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
    ap.add_argument("--lines", default=None, help="напр. 1-10 или 14,15")
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
    skills = skill_by_line(data)
    assert len(skills) == 20, f"ожидали 20 тем, нашли {len(skills)}: {sorted(skills)}"
    figclass: dict = json.loads(FIGCLASS.read_text(encoding="utf-8")) if FIGCLASS.exists() else {}

    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    used_src = {t.get("sourceId") for t in tasks}
    used_ids = {t["id"] for t in tasks}
    present = {norm(t.get("text")) for t in tasks}

    assets = {a["id"]: a for a in data.get("visualAssets", [])}
    audit = data.get("visualAudit")
    statuses = audit.setdefault("taskStatuses", {}) if isinstance(audit, dict) else {}
    counters: dict[str, int] = {}

    report: list[str] = []
    picked_fig = 0

    for n in range(1, 21):
        if wanted is not None and n not in wanted:
            continue
        skill = skills[n]
        group = by_skill.get(skill, [])
        extended = n >= 14
        path = OUT_DIR / f"math_{n:02d}.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []

        def fresh(pool: list[dict]) -> list[dict]:
            out = []
            for r in pool:
                sid = f"sdamgia-{r['src_id']}"
                if sid in used_src:
                    continue
                cond = base.clean(r.get("condition") or "")
                if norm(cond) in present:
                    continue
                out.append(r)
            return out

        if extended:
            figs = fresh([r for r in raw if usable_ext(n, r, figclass, want_fig=True)])
            pics = fresh([r for r in raw if usable_pic_ext(n, r, figclass)])
            mixed = fresh([r for r in raw if usable_mixed_ext(n, r, figclass)])
            texts = fresh([r for r in raw if usable_ext(n, r, figclass, want_fig=False)])
            builder = build_ext
        else:
            figs = fresh([r for r in raw if usable_short_fig(n, r, figclass)])
            pics = fresh([r for r in raw if usable_pic_short(n, r, figclass)])
            mixed = fresh([r for r in raw if usable_mixed_short(n, r, figclass)])
            texts = fresh([r for r in raw if usable_short_text(n, r, figclass)])
            builder = build_short
        noclass = sum(1 for r in raw if f"{n}:{r['src_id']}" not in figclass)

        analogs = sorted([t for t in group if ANALOG_RE.search(t.get("status") or "")],
                         key=lambda t: t["id"])
        need_topup = max(0, TARGET - len(group))
        report.append(f"№{n:2} {skill:16} есть {len(group):3}, аналогов {len(analogs):2}, "
                      f"чертежи {len(figs):3}, форм-картинки {len(pics):3}, "
                      f"смешанные {len(mixed):3}, тексты {len(texts):3}, "
                      f"без классиф. {noclass:3}, надо {need_topup:3}")
        if args.analyze:
            continue

        # Кандидаты по приоритету: чертежи -> формулы-картинки ->
        # смешанные -> тексты. Аналоги забирают из той же очереди (id сохраняем).
        queue: list[tuple[dict, str]] = ([(r, "fig") for r in figs]
                                         + [(r, "pic") for r in pics]
                                         + [(r, "mixed") for r in mixed]
                                         + [(r, "text") for r in texts])
        qi = 0

        def take() -> tuple[dict, str, str | None] | None:
            """Следующий годный кандидат: (сырьё, режим, asset_id)."""
            nonlocal qi
            while qi < len(queue):
                r, mode = queue[qi]
                qi += 1
                asset_id = None
                if mode != "text":
                    got = figure_import.import_task(
                        "math", str(r["src_id"]), 2.5,
                        figures_only=(mode == "fig"))
                    if not got:
                        continue  # рисунок не вытянулся — следующий кандидат
                    asset_id = got["id"]
                    if asset_id not in assets:
                        assets[asset_id] = {
                            "id": asset_id,
                            "src": f"assets/math/{asset_id}.png",
                            "type": "image",
                            "alt": f"Рисунок к заданию (профиль №{n})",
                            "width": got.get("width", 640),
                            "ratio": (got.get("width", 640) / got.get("height", 480)
                                      if got.get("height") else 1.3333),
                            "source": f"рисунок источника: {got['urls'][0]}"
                                      if got.get("urls") else "sdamgia",
                            "sourceId": asset_id, "taskId": None,
                            "description": f"Рисунок источника к заданию профиля №{n}",
                        }
                return r, mode, asset_id
            return None

        def commit(new: dict, r: dict) -> None:
            used_src.add(f"sdamgia-{r['src_id']}")
            present.add(norm(new["text"]))

        # 1) аналоги -> настоящие задания, id сохраняем
        for old in analogs:
            got = take()
            if got is None:
                report.append(f"    ! {old['id']}: аналогу нет замены")
                break
            r, mode, asset_id = got
            new = builder(old, n, r, old["id"], skill, asset_id, mode == "pic")
            if asset_id:
                statuses[old["id"]] = "visual-provided"
                picked_fig += 1
            idx = tasks.index(old)
            tasks[idx] = new
            commit(new, r)

        # 2) добор до TARGET
        made = 0
        while made < need_topup:
            got = take()
            if got is None:
                break
            r, mode, asset_id = got
            prefix = "n%02d_" % n
            kind = {"fig": "f", "mixed": "f", "pic": "q", "text": "p"}[mode]
            new_id = next_id(f"{prefix}{kind}", used_ids, counters)
            new = builder({}, n, r, new_id, skill, asset_id, mode == "pic")
            new["example"] = len([t for t in tasks if t.get("skill") == skill]) + 1
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
          f"из них с рисунком {picked_fig} новых")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
