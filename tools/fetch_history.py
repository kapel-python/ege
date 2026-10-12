#!/usr/bin/env python3
"""Фоновый сбор сырых пулов истории (Решу ЕГЭ, hist-ege.sdamgia.ru).

Что тянет:
  * линии prob1-14,16-22 (prob15 — legacy-комплексы «задания 13, 14 и 15»
    без явных вопросов, в банк не идут) -> tools/out/his_NN.json;
  * тематические страницы (/test?theme=N) для добора жанров, которых нет
    отдельными линиями: TERMS2 «раскройте смысл понятия + факт» (экзамен
    №19) и ARGS «аргументы» (экзамен №20, запас к малому пулу prob22).

Идемпотентно: существующие файлы сливаются по src_id, повторный запуск
добирает только новое. Вежливо: паузы между запросами, ретраи внутри
sdamgia_import.

    python3 tools/fetch_history.py            # всё (долго, ~40-60 мин)
    python3 tools/fetch_history.py --themes-only
    python3 tools/fetch_history.py --lines 1 2 3
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import sdamgia_import as S  # noqa: E402

BASE = S.SUBJECTS["his"]
OUT_DIR = ROOT / "tools" / "out"
LOG = OUT_DIR / "his_fetch.log"

# линия sdam -> (файл, цель, размер набора)
LINES = {
    1: (130, 20), 2: (130, 20), 3: (130, 20), 4: (130, 20),
    5: (130, 20), 6: (130, 20), 7: (130, 20), 8: (130, 20),
    9: (130, 20), 10: (130, 20), 11: (130, 20), 12: (130, 20),
    13: (80, 10), 14: (80, 10), 16: (80, 10), 17: (80, 10),
    18: (80, 10), 19: (80, 10), 20: (30, 10), 21: (80, 10),
    22: (40, 10),
}
MAX_PASSES = 16


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_known(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return {str(it.get("src_id")): it
                for it in json.loads(path.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {}


def fetch_line(line: int) -> int:
    target, count = LINES[line]
    path = OUT_DIR / f"his_{line:02d}.json"
    known = load_known(path)
    log(f"линия {line}: уже {len(known)}, цель {target}")
    dry = 0
    fresh = 0
    for p in range(MAX_PASSES):
        if len(known) >= target:
            break
        try:
            test_id = S.generate_set(BASE, line, count)
            ids = S.problem_ids(BASE, test_id)
        except Exception as exc:  # сеть чихнула — пропуск прохода
            log(f"  проход {p + 1}: сеть: {exc}")
            time.sleep(5)
            continue
        new_ids = [pid for pid in ids if pid not in known]
        if not new_ids:
            dry += 1
            if dry >= 2:
                log(f"  проход {p + 1}: сухо дважды — пул исчерпан ({len(known)})")
                break
            continue
        dry = 0
        ok = 0
        for pid in new_ids:
            try:
                known[pid] = S.parse_problem(BASE, pid)
                ok += 1
                fresh += 1
            except Exception as exc:
                log(f"    id={pid}: пропуск ({exc})")
            time.sleep(S.PAUSE)
        log(f"  проход {p + 1}: набор {test_id}, новых {ok} (всего {len(known)})")
        if len(new_ids) < 2:
            dry += 1
            if dry >= 2:
                break
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(list(known.values()), ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    log(f"линия {line}: итого {len(known)} (+{fresh} новых) -> {path.name}")
    return len(known)


def fetch_themes() -> None:
    """Добор TERMS2/ARGS через тематические страницы (экзамен №19/№20)."""
    terms: dict[str, dict] = {}
    args: dict[str, dict] = {}
    for path, store in (("his_theme_terms.json", terms), ("his_theme_args.json", args)):
        p = OUT_DIR / path
        store.update(load_known(p))
    log(f"темы: уже terms={len(terms)}, args={len(args)}")
    cand_terms: set[str] = set()
    cand_args: set[str] = set()
    for theme in range(1, 501):
        try:
            page = S.get(BASE, f"/test?theme={theme}&nt=True&pub=False")
        except Exception:
            continue
        # Источник режет слова мягкими переносами («рас­крой­те»): фраза
        # «раскройте смысл понятия» иначе не находится никогда.
        low = page.lower().replace("­", "").replace("&shy;", "")
        ids = [i for i in re.findall(r"/problem\?id=(\d+)", page) if i not in terms and i not in args]
        if not ids:
            continue
        if "раскройте смысл понятия" in low:
            cand_terms.update(ids)
        if "аргумент" in low:
            cand_args.update(ids)
        if theme % 50 == 0:
            log(f"  темы {theme}: кандидатов terms={len(cand_terms)}, args={len(cand_args)}")
        time.sleep(0.15)
    log(f"темы: кандидатов terms={len(cand_terms)}, args={len(cand_args)} — разбор...")
    for pid in sorted(cand_terms - set(args)):
        try:
            r = S.parse_problem(BASE, pid)
        except Exception:
            continue
        c = (r.get("condition") or "").lower()
        if "раскройте смысл понятия" in c:
            terms[pid] = r
        time.sleep(S.PAUSE)
    for pid in sorted(cand_args - set(terms)):
        try:
            r = S.parse_problem(BASE, pid)
        except Exception:
            continue
        c = (r.get("condition") or "").lower()
        if "аргумент" in c and "тезис" not in c:
            args[pid] = r
        time.sleep(S.PAUSE)
    (OUT_DIR / "his_theme_terms.json").write_text(
        json.dumps(list(terms.values()), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (OUT_DIR / "his_theme_args.json").write_text(
        json.dumps(list(args.values()), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"темы: итого terms={len(terms)}, args={len(args)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--themes-only", action="store_true")
    ap.add_argument("--lines", nargs="*", type=int, default=None)
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not args.themes_only:
        lines = args.lines or sorted(LINES)
        for line in lines:
            if line not in LINES:
                log(f"линия {line}: пропуск (нет в плане; prob15 исключён)")
                continue
            try:
                fetch_line(line)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                log(f"линия {line}: ОШИБКА {exc}")
    else:
        fetch_themes()
    if not args.themes_only and args.lines is None:
        fetch_themes()
    log("ГОТОВО")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
