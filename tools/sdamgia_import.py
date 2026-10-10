#!/usr/bin/env python3
"""Импорт реальных заданий ЕГЭ с Решу ЕГЭ (СДАМ ГИА) в каталоги предметов.

Зачем: в каталогах были самописные задания («аналог демоверсии»). На сайте не
должно быть аналогов — только реальные задания. Решу ЕГЭ отдаёт условие,
пояснение и машинно-читаемый ответ каждого задания, поэтому импорт без
догадок: ответ берётся из блока `<div class="answer">` самого источника.

Как работает:
  1. `/test?a=generate&prob<N>=<M>` — сервис собирает набор из M заданий линии N
     и отдаёт редиректом id варианта.
  2. `/test?id=<id>` — страница варианта со списком id заданий.
  3. `/problem?id=<id>` — страница задания: условие, решение, ответ.

Запросы идут с паузой и ретраями: источник чужой, льём вежливо.

Назначение ответа важно для нашего UI: короткий ответ (valueType «цифра»)
рисует одно поле ввода, а «последовательность цифр» + метки строк «А) …» в
тексте включает таблицу-ответ как в бланке ЕГЭ. Тип задаёт вызывающий код,
а не этот скрипт: он только собирает данные источника.

    python3 tools/sdamgia_import.py rus 4 15 --dry   # посмотреть, что придёт
    python3 tools/sdamgia_import.py rus 4 15         # выгрузить в tools/out/rus_04.json
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "tools" / "out"

SUBJECTS = {
    "rus": "https://rus-ege.sdamgia.ru",
    "bio": "https://bio-ege.sdamgia.ru",
    "inf": "https://inf-ege.sdamgia.ru",
    "soc": "https://soc-ege.sdamgia.ru",
    "mathb": "https://mathb-ege.sdamgia.ru",
    "math": "https://math-ege.sdamgia.ru",
}

UA = "Mozilla/5.0 (compatible; ege-content-import/1.0)"
TIMEOUT = 40
RETRIES = 3
PAUSE = 0.7

# Маркеры «здесь начинается решение» на странице задания: условие лежит
# выше сolnb-кнопки, поэтому режем точно по ней, а не по общим div-ам.
SOL_ANCHOR_RE = re.compile(r'id="soltb\d+"')
ANSWER_RE = re.compile(r'<div class="answer"[^>]*>(.*?)</div>', re.S)
SOLUTION_RE = re.compile(r'id="sol(\d+)"[^>]*>(.*?)(?=<div class="answer")', re.S)


def get(base: str, path: str) -> str:
    url = f"{base}{path}"
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, OSError) as exc:  # сеть отвалилась/таймаут
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"не удалось получить {url}: {last}")


def generate_set(base: str, line: int, count: int) -> str:
    """Собрать набор из count заданий линии line; вернуть id варианта.

    Источник отвечает редиректом на готовый вариант, но urllib по умолчанию
    переходит по нему сам, поэтому id забираем и из Location, и из
    итогового URL — иначе на 200 вместо 302 скрипт падал.
    """
    query = urllib.parse.urlencode({f"prob{line}": count})
    req = urllib.request.Request(f"{base}/test?a=generate&{query}",
                                 headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            final_url = resp.url or ""
    except urllib.error.HTTPError as exc:
        final_url = exc.headers.get("Location") or ""
        if exc.code not in (301, 302, 303, 307, 308):
            raise RuntimeError(f"сбор набора вернул {exc.code}") from exc
    if "id=" not in final_url:
        raise RuntimeError(f"в ответе сборщика нет id варианта: {final_url!r}")
    return final_url.split("id=", 1)[1].split("&", 1)[0]


def problem_ids(base: str, test_id: str) -> list[str]:
    page = get(base, f"/test?id={test_id}&nt=True&pub=False")
    ids: list[str] = []
    for found in re.findall(r"/problem\?id=(\d+)", page):
        if found not in ids:
            ids.append(found)
    return ids


def strip_markup(raw: str) -> str:
    """HTML источника -> чистый текст: без софт-переносов и узких пробелов."""
    text = raw
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<p[^>]*>", "\n", text)
    text = re.sub(r"</p>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # СДАМ ГИА режет слова невидимыми мягкими переносами: «По­яс­не­ние».
    text = text.replace("\u00ad", "").replace("&shy;", "")
    text = text.replace("\u202f", " ").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def parse_problem(base: str, pid: str) -> dict:
    page = get(base, f"/problem?id={pid}")

    anchor = SOL_ANCHOR_RE.search(page)
    if not anchor:
        raise RuntimeError(f"задание {pid}: не найден блок решения")
    head = page[:anchor.start()]
    cut = head.rfind("<a ")
    if cut != -1:
        head = head[:cut]
    # Условие — первый блок id="bodyNNN" до кнопки «Спрятать пояснение»:
    # боковая панель тоже содержит pbody, поэтому rfind брал чужой блок.
    body = re.search(r'id="body\d+"[^>]*class="pbody"[^>]*>', head)
    if not body:
        raise RuntimeError(f"задание {pid}: не найден блок условия")
    condition_raw = head[body.end():]

    sol = SOLUTION_RE.search(page[anchor.start():])
    solution_raw = sol.group(2) if sol else ""
    # На источнике в конце блока решения идёт «Правило: …» — для нашей
    # подсказки оно не нужно, режем по маркеру.
    solution_raw = re.split(r"<img class=\"nodraw\"", solution_raw)[0]
    solution_raw = re.sub(r"<img[^>]*>", " ", solution_raw)

    answer_match = ANSWER_RE.search(page)
    answer_raw = strip_markup(answer_match.group(1)) if answer_match else ""
    answer = answer_raw.replace("Ответ:", "").strip().strip(".")

    text = strip_markup(condition_raw)
    solution = strip_markup(solution_raw)
    # Служебные обвязки источника в решении нам не нужны: заголовок
    # «Пояснение (см. также Правило ниже)» и продублированный в конце ответ.
    solution = re.sub(r"^Пояснение[^.]*\.\s*", "", solution)
    solution = re.sub(r"\s*Ответ:\s*[^\s.]+\.?\s*$", "", solution).strip()

    images = len(re.findall(r"<img", condition_raw))
    return {
        "src_id": pid,
        "condition": text,
        "solution": solution,
        "answer": answer,
        "url": f"{base}/problem?id={pid}",
        "images": images,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("subject", choices=sorted(SUBJECTS))
    ap.add_argument("line", type=int)
    ap.add_argument("count", type=int)
    ap.add_argument("--dry", action="store_true",
                    help="только показать результат, файл не писать")
    args = ap.parse_args()

    base = SUBJECTS[args.subject]
    test_id = generate_set(base, args.line, args.count)
    ids = problem_ids(base, test_id)
    print(f"линия {args.line}: набор {test_id}, заданий найдено {len(ids)}")

    items: list[dict] = []
    for i, pid in enumerate(ids, 1):
        item = parse_problem(base, pid)
        items.append(item)
        print(f"  {i:2}. id={pid:>7} отв={item['answer']!r:10} картинок={item['images']} "
              f"{item['condition'][:60]!r}")
        time.sleep(PAUSE)

    if args.dry:
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{args.subject}_{args.line:02d}.json"
    path.write_text(json.dumps(items, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    print(f"записано {len(items)} заданий -> {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())