#!/usr/bin/env python3
"""Банк сочинений №13 ОГЭ по русскому из выгрузки tools/out/rus_oge_13.json.

Каждая страница источника несёт полный текст (по которому пишут и изложение,
и сочинение) + три варианта тем (13.1/13.2/13.3). Мы берём тексты экзаменационного
объёма (150–650 слов, потолок ОГЭ в _essay_source_file), выбираем из каждого
универсальную тему (предпочтительно 13.3 — вопрос о понятии: к ней проще всего
писать аргумент из опыта) и кладём:
  * server/essay_texts.d/oge_src_<...>.json — исходный текст (subject oge_russian);
  * задания oge_re13_N (type long_text) в server/catalog_oge_russian.json.

    python3 tools/apply_oge_russian_essays.py --analyze   # что выйдет, ничего не пишет
    python3 tools/apply_oge_russian_essays.py             # записать тексты + каталог
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_oge_russian.json"
ESSAY_DIR = ROOT / "server" / "essay_texts.d"
RAW = ROOT / "tools" / "out" / "rus_oge_13.json"

WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+(?:['’\-–][0-9A-Za-zА-Яа-яЁё]+)*")
# Сколько текстов кладём в банк. 12 — как у ЕГЭ (13 текстов), чтобы очередь
# практики была сопоставимой; каждый проверен на экзаменационный объём.
TARGET_TEXTS = 12
# Пороги объёма совпадают с _essay_source_file (server.py): для oge-предметов
# потолок выше (текст ОГЭ длиннее — по нему пишут и изложение, и сочинение).
MIN_WORDS, MAX_WORDS = 150, 650
TASK_MARKERS = ("Используя прочитанный текст", "13.1 Напишите", "Напишите сочинение")
TASK_PREFIX = "oge_re13_"

ESSAY_TASK_TEXT = (
    "Прочитайте текст и напишите сочинение-рассуждение на тему «{topic}».\n\n"
    "Дайте ответ на вопрос, сформулированный в теме сочинения. Приведите два "
    "аргумента, подтверждающих ваши рассуждения: один — по прочитанному тексту, "
    "второй — из вашего читательского, жизненного или иного опыта. Поясните "
    "каждый аргумент: покажите, как он подтверждает ваш ответ. Сделайте вывод.\n\n"
    "Объём сочинения — не менее 70 слов. Пишите аккуратно, разборчиво."
)


def split_text(raw_condition: str) -> str:
    """Текст до формулировок заданий (13.1/13.2/13.3 и служебного хвоста)."""
    idx = min([raw_condition.find(m) for m in TASK_MARKERS
               if raw_condition.find(m) > 0] or [-1])
    return raw_condition[:idx].strip() if idx > 0 else ""


def pick_topic(raw_condition: str) -> str:
    """Тема сочинения: предпочитаем 13.3 (вопрос о понятии — универсальнее
    для аргумента из опыта), иначе 13.2, иначе 13.1."""
    topics = {}
    for m in re.finditer(
            r"(13\.[123])\s+Напишите сочинение-рассуждение на тему\s*[«\"]([^»\"]+)[»\"]",
            raw_condition):
        topics[m.group(1)] = m.group(2).strip()
    for variant in ("13.3", "13.2", "13.1"):
        if topics.get(variant):
            return topics[variant]
    return ""


def author_of(text: str) -> str:
    m = re.search(r"\(По\s+([^)]+)\)\s*\*?\s*$", text)
    if m:
        name = m.group(1).strip().rstrip("*").strip()
        # «Ю. Нагибину» → подача в именительном падеже нужна ручная правка;
        # здесь оставляем как у источника (дательный), поле не критично.
        return name
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    raw = json.loads(RAW.read_text(encoding="utf-8"))
    rows = []
    seen_texts: set[str] = set()
    for r in raw:
        text = split_text(r["condition"])
        if not text:
            continue
        words = len(WORD_RE.findall(text))
        if not MIN_WORDS <= words <= MAX_WORDS:
            continue
        topic = pick_topic(r["condition"])
        if not topic:
            continue
        # дедуп по первым 200 буквам текста: страницы-дубли у источника бывают
        key = re.sub(r"\s+", "", text)[:200].lower()
        if key in seen_texts:
            continue
        seen_texts.add(key)
        rows.append({"src_id": r["src_id"], "text": text, "words": words,
                     "topic": topic, "author": author_of(text),
                     "url": r["url"]})
    rows.sort(key=lambda x: x["words"])
    picked = rows[:TARGET_TEXTS]

    for i, row in enumerate(picked, 1):
        print(f"{i:2}. src={row['src_id']:>6} слов={row['words']:>3} "
              f"автор={row['author'] or '—':<20} тема: {row['topic'][:60]}")
    if args.analyze:
        return 0
    if len(picked) < 8:
        print(f"мало текстов ({len(picked)}) — каталог не тронут")
        return 1

    ESSAY_DIR.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    tasks = [t for t in catalog["tasks"]
             if not str(t.get("id", "")).startswith(TASK_PREFIX)]
    for i, row in enumerate(picked, 1):
        text_id = f"oge_src_{row['src_id']}"
        payload = {
            "id": text_id,
            "subject": "oge_russian",
            "author": row["author"],
            "work": "текст из банка ОГЭ (СДАМ ГИА)",
            "exam": "ОГЭ",
            "problem": row["topic"],
            "problemCircle": [],
            "text": row["text"],
            "sourceUrl": row["url"],
            "notes": f"Текст задания 13 ОГЭ (страница источника {row['src_id']}). "
                     "Тема выбрана из трёх вариантов страницы (приоритет 13.3).",
        }
        (ESSAY_DIR / f"{text_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8")
        tasks.append({
            "id": f"{TASK_PREFIX}{i}",
            "skill": "or13_essay",
            "sub": "Сочинение по прочитанному тексту",
            "num": "13",
            "diff": 4,
            "type": "long_text",
            "text": ESSAY_TASK_TEXT.format(topic=row["topic"]),
            "answer": "",
            "hint": "Сначала сформулируй ответ на вопрос темы одним предложением, "
                    "потом подбери аргументы.",
            "solution": "",
            "sourceTextId": text_id,
        })
    catalog["tasks"] = tasks
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    print(f"записано: {len(picked)} текстов в essay_texts.d, "
          f"{len(picked)} заданий long_text в каталоге")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
