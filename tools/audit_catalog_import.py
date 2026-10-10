#!/usr/bin/env python3
"""Аудит каталогов после импорта: доверять данным можно только после проверки.

Импортёр извлекает текст, ответ, решение и рисунок из страниц источника.
Он уже падал «тихо»: терял решения части 2 (нет машинного блока ответа),
выбрасывал картинку с двумя метками-вотермарками, подмешивал задание чужой
линии. Поэтому после каждого импорта прогоняем этот аудит.

Жёсткие (ломают доверие, код возврата 1):
  * пустые обязательные поля;
  * остатки вёрстки источника: HTML-теги и HTML-сущности;
  * явные элементы интерфейса в тексте/решении;
  * self-задание с фразой «ответ запишите» (движок такое отвергает);
  * висячие visual (assetId без ассета), отсутствующие файлы, чужой хеш ?v=,
    осиротевшие ассеты;
  * для общества: аналоги-самопис и дубли текста (их не должно быть).

Мягкие (отчёт, без падения): дубли текста и форматы ответов в остальных
предметах — там это исторически допустимо.

    python3 tools/audit_catalog_import.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Строгий HTML-тег: только известные теги, иначе «<iostream>» из C++ и «<» из
# математики дают ложное срабатывание.
HTML_TAG = re.compile(
    r"</?(?:div|span|p|br|hr|a|b|i|u|em|strong|ul|ol|li|table|thead|tbody"
    r"|tr|td|th|img|font|sup|sub|center|small|big|script|style)\b[^>\n]*>",
    re.I)
ENTITY = re.compile(r"&(nbsp|amp|quot|lt|gt|laquo|raquo|mdash|ndash|hellip|#\d+);")
UI_RESIDUE = re.compile(
    r"Смотреть решение|Показать ответ|Показать пояснение|Спрятать критерии"
    r"|Спрятать пояснение|Разбор задания")
FORBIDDEN = re.compile(r"ответ запишите", re.I)
ANALOG = re.compile(r"тренировочный вариант|тренажёр|описан текстом", re.I)
DIGITS = re.compile(r"^[0-9|]+$")

SOCIETY = "catalog_society.json"


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def audit_catalog(path: Path) -> tuple[list[str], list[str]]:
    hard: list[str] = []
    soft: list[str] = []
    name = path.name
    data = json.loads(path.read_text(encoding="utf-8"))
    tasks = data.get("tasks") or []
    assets = data.get("visualAssets") or []
    aid = {a.get("id"): a for a in assets}
    is_society = path.name == SOCIETY

    for t in tasks:
        tid = t.get("id") or "?"
        for fld in ("id", "skill", "text"):
            if not str(t.get(fld) or "").strip():
                hard.append(f"{name}: {tid}: пустое поле {fld}")
        if not str(t.get("text") or "").strip():
            hard.append(f"{name}: {tid}: пустой текст")
        if not (str(t.get("answer") or "").strip() or str(t.get("solution") or "").strip()):
            hard.append(f"{name}: {tid}: нет ни answer, ни solution")
        for fld in ("text", "solution", "answer"):
            v = str(t.get(fld) or "")
            if HTML_TAG.search(v):
                hard.append(f"{name}: {tid}: HTML-тег в {fld}")
            if ENTITY.search(v):
                hard.append(f"{name}: {tid}: HTML-сущность в {fld}")
            m = UI_RESIDUE.search(v)
            if m:
                hard.append(f"{name}: {tid}: интерфейс источника в {fld}: {m.group(0)}")
        is_self = (t.get("check") == "self") or bool(t.get("selfCheck"))
        if is_self and FORBIDDEN.search(str(t.get("text") or "")):
            hard.append(f"{name}: {tid}: self-задание с «ответ запишите»")
        if is_society and ANALOG.search(str(t.get("source") or "")) \
                and "Демоверсия" not in str(t.get("source") or ""):
            hard.append(f"{name}: {tid}: самописный аналог в банке")
        if is_society and not is_self:
            ans = str(t.get("answer") or "").strip()
            if ans and not DIGITS.match(ans):
                hard.append(f"{name}: {tid}: ответ авто-задания не цифровой: {ans!r}")
        aid_task = (t.get("visual") or {}).get("assetId")
        if aid_task and aid_task not in aid:
            hard.append(f"{name}: {tid}: visual ссылается на несуществующий ассет")

    for a in assets:
        base = str(a.get("src") or "").split("?")[0]
        f = ROOT / base
        if not base or not f.exists():
            hard.append(f"{name}: ассет {a.get('id')}: файл не найден: {base}")
            continue
        if "?v=" in str(a.get("src") or ""):
            want = str(a["src"]).split("?v=", 1)[1]
            got = hashlib.md5(f.read_bytes()).hexdigest()[:10]
            if want != got:
                hard.append(f"{name}: ассет {a.get('id')}: устарел хеш ?v=")

    used = {a.get("id") for a in assets}
    referenced = {(t.get("visual") or {}).get("assetId") for t in tasks}
    for a_id in used - referenced:
        hard.append(f"{name}: осиротевший ассет {a_id}")

    # дубли текста
    seen: dict[str, list[str]] = {}
    for t in tasks:
        k = norm(t.get("text"))
        if k:
            seen.setdefault(k, []).append(t.get("id"))
    for k, ids in seen.items():
        if len(ids) > 1:
            msg = f"{name}: дубли текста: {ids}"
            (hard if is_society else soft).append(msg)

    return hard, soft


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalog", default=SOCIETY,
                    help="имя файла каталога в server/ (по умолчанию общество)")
    ap.add_argument("--all", action="store_true", help="проверить все каталоги")
    args = ap.parse_args()

    if args.all:
        paths = sorted((ROOT / "server").glob("catalog_*.json"))
    else:
        paths = [ROOT / "server" / args.catalog]

    all_hard: list[str] = []
    all_soft: list[str] = []
    for path in paths:
        if not path.exists():
            print(f"нет каталога: {path}")
            return 1
        hard, soft = audit_catalog(path)
        mark = "ЧИСТО" if not hard else f"ПРОБЛЕМ {len(hard)}"
        extra = f", предупреждений {len(soft)}" if soft else ""
        print(f"== {path.name}: {mark}{extra}")
        for line in hard:
            print("   !", line)
        for line in soft:
            print("   ~", line)
        all_hard += hard
        all_soft += soft

    print(f"\nвсего жёстких проблем: {len(all_hard)}, предупреждений: {len(all_soft)}")
    return 1 if all_hard else 0


if __name__ == "__main__":
    raise SystemExit(main())