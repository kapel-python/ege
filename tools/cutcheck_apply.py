#!/usr/bin/env python3
"""Восстановление оборванных условий из живых текстов (сухой прогон).
Правило: новый текст = живой полный текст; visual убираем, только если
на живой странице нет fig-картинок. Печатает диффы для ревью.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = {
    'Уравнение — на рисунке: перепиши его точно и решай письменно.',
    'Формула — на рисунке: перепиши её аккуратно и решай.',
    'Внимательно рассмотри рисунок: сверь все обозначения, длины и точки с условием.',
}


def clean_alt(a):
    s = (a or "").replace("\u00ad", "").replace("&shy;", "")
    s = re.sub(r"\s+", " ", s).strip().rstrip(".").strip()
    return s


def live_without_alts(live, alts):
    s = live
    for a in alts:
        if a["kind"] != "tex":
            continue
        alt = clean_alt(a["alt"])
        if alt:
            s = s.replace(" (" + alt + ") ", " ", 1)
            s = s.replace(" (" + alt + ")", "", 1)
    return re.sub(r"\s+", " ", s).strip()


JUNK_WORDS = re.compile(r'\s(векторов?|уравнени[ея]|выражения|выражение|если|при|и|или|как|равно|равна|равен|равны|равное|найдите|докажите|определите|доказать|найти|определить)\s*$', re.I)


def strip_junk_tail(bank):
    prev = None
    while prev != bank:
        prev = bank
        bank = JUNK_WORDS.sub("", bank).strip()
    return bank


def clean_live(s):
    s = re.sub(r'\s*<a href.*$', '', s).strip()
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n', s).strip()
    return s


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    full = json.loads((ROOT / "tools" / "out" / "cutcheck_full.json").read_text(encoding="utf-8"))
    data = json.loads((ROOT / "server" / "catalog.json").read_text(encoding="utf-8"))
    by_id = {t["id"]: t for t in data["tasks"]}
    plan = []
    for r in full:
        if r.get("error") or not r.get("live"):
            continue
        t = by_id.get(r["id"])
        if t is None:
            continue
        live = clean_live(r["live"])
        bank = re.sub(r'\s+', ' ', (t.get("text") or "").strip())
        has_fig = any(a["kind"] == "fig" for a in r["alts"])
        live_noalts = live_without_alts(live, r["alts"])
        bank_core = strip_junk_tail(bank)
        # трое проверены глазами: живой текст продолжает банковский
        # (расхождения — лишь переносы строк), беру живой целиком.
        if r["id"] in ("n18_a10", "n18_q58", "n19_q52"):
            plan.append((r, live, has_fig))
            continue
        if not (bank_core and bank_core in live_noalts):
            print(f"{r['id']}: REVIEW")
            continue
        plan.append((r, live, has_fig))
    print(f"ready: {len(plan)}")
    if not args.apply:
        for r, live, fig in plan:
            t = by_id[r["id"]]
            bank = re.sub(r'\s+', ' ', (t.get("text") or "").strip())
            print(f"--- {r['id']} fig={fig}\n  -{bank[-60:]!r}\n  +{live[-120:]!r}")
        return 0
    dropped = []
    for r, live, has_fig in plan:
        t = by_id[r["id"]]
        if r["id"] == "n18_q58":
            # артефакт источника: продублированное условие в скобках
            live = live.replace("((AD больше BC)) ", "")
        t["text"] = live
        if not has_fig:
            vis = (t.get("visual") or {}).get("assetId")
            if vis:
                dropped.append((r["id"], vis))
                t.pop("visual", None)
            hs = t.get("hints")
            if isinstance(hs, list) and hs and hs[0] in TEMPLATES:
                t["hints"] = hs[1:]
            if t.get("hint") in TEMPLATES:
                t["hint"] = "Решение."
    (ROOT / "server" / "catalog.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"applied {len(plan)}, dropped visuals: {len(dropped)}")
    with open("/tmp/opencode/dropped2.txt", "w", encoding="utf-8") as f:
        for tid, aid in dropped:
            print(f"  {tid}: {aid}")
            f.write(aid + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
