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
    "his": "https://hist-ege.sdamgia.ru",
}

UA = "Mozilla/5.0 (compatible; ege-content-import/1.0)"
TIMEOUT = 40
RETRIES = 3
PAUSE = 0.25

# Маркеры «здесь начинается решение» на странице задания: условие лежит
# выше сolnb-кнопки, поэтому режем точно по ней, а не по общим div-ам.
SOL_ANCHOR_RE = re.compile(r'id="soltb\d+"')
ANSWER_RE = re.compile(r'<div class="answer"[^>]*>(.*?)</div>', re.S)
# Начало блока решения задания. Конец блока ищем вручную (см. _solution_block):
# у части 1 он закрыт следующим <div class="answer">, у развёрнутых заданий
# части 2 машинного блока ответа нет вовсе — там конец это «Спрятать критерии».
SOLUTION_START_RE = re.compile(r'id="sol\d+"[^>]*>')


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


# Формулы источника в математике лежат картинками
# `<img class="tex" ... alt="...">`: alt — словесное описание формулы
# («2 в степени левая круглая скобка …»), без него в тексте остаются дыры
# («а) Решите уравнение  б) Укажите корни»). Подставляем alt прямо в текст,
# скобочные слова сворачиваем в настоящие скобки — это детерминировано и
# безопасно, сами слова формул не трогаем.
BRACKET_WORDS = (
    ("левая круглая скобка", "("), ("правая круглая скобка", ")"),
    ("левая квадратная скобка", "["), ("правая квадратная скобка", "]"),
    ("левая фигурная скобка", "{"), ("правая фигурная скобка", "}"),
)
# Маркер формулы-картинки источника (инлайн-TeX и /formula/-растры).
TEX_RE = re.compile(r'class="tex"|/formula/')


def _formula_alt(match: re.Match) -> str:
    tag = match.group(0)
    if 'class="tex"' not in tag and "/formula/" not in tag:
        return " "
    found = re.search(r'alt="([^"]*)"', tag)
    if not found:
        return " "
    alt = html.unescape(found.group(1)).replace("­", "")
    for ru, en in BRACKET_WORDS:
        alt = alt.replace(ru, en)
    alt = re.sub(r"\s+", " ", alt).strip().rstrip(".").strip()
    return f" ({alt}) " if alt else " "


def sub_formula_alt(raw: str) -> str:
    """Инлайновые формулы-рисунки -> их словесный alt-текст в скобках."""
    return re.sub(r"<img\b[^>]*>", _formula_alt, raw)


def strip_markup(raw: str) -> str:
    """HTML источника -> чистый текст: без софт-переносов и узких пробелов."""
    text = raw
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<p[^>]*>", "\n", text)
    text = re.sub(r"</p>", "\n", text)
    # Таблицы источника: ячейки разделяем « | », ряды — переводом строки.
    # Без этого данные склеиваются в нечитаемое «1Английский15 400».
    text = re.sub(r"</t[dh]>\s*", " | ", text)
    text = re.sub(r"</tr>\s*", "\n", text)
    text = re.sub(r"<table[^>]*>", "\n", text)
    text = re.sub(r"</table>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # СДАМ ГИА режет слова невидимыми мягкими переносами: «По­яс­не­ние».
    text = text.replace("\u00ad", "").replace("&shy;", "")
    text = text.replace("\u202f", " ").replace("\xa0", " ")
    # Невидимые склейки источника: word joiner и zero-width.
    text = re.sub(r"[\u2060\u200b\u200c\u200d\ufeff]", "", text)
    # Чистим разделители таблиц: лишние трубы, пустые края строк.
    text = re.sub(r"[ \t]*\|[ \t]*", " | ", text)
    text = re.sub(r"(?:[ \t]*\|)+[ \t]*(?=\n)", "", text)
    text = re.sub(r"(?m)^[ \t]*(?:\|[ \t]*)+", "", text)
    text = re.sub(r"(?:[ \t]*\|)+[ \t]*$", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def extract_div(page: str, match: re.Match) -> str:
    """Содержимое div, открытый тег которого найден в match (учёт вложенности)."""
    tag_end = page.index(">", match.end()) + 1
    depth = 1
    for mt in re.finditer(r"<div\b[^>]*>|</div>", page[tag_end:], re.I):
        depth += -1 if mt.group(0).startswith("</") else 1
        if depth == 0:
            return page[tag_end:tag_end + mt.start()]
    return page[tag_end:]


def _solution_block(page: str, from_pos: int) -> str:
    """HTML блока решения, начиная с позиции after_pos (после якоря «пояснение»).

    Конец блока — первый из маркеров: машинный ответ части 1
    (`<div class="answer">`) или критерии части 2 (`<div class="prob_crits">`).
    У развёрнутых заданий части 2 машинного ответа нет, поэтому прежний
    регекс с обязательным lookahead на answer их решение терял."""
    start = SOLUTION_START_RE.search(page, from_pos)
    if not start:
        return ""
    s = start.end()
    end = len(page)
    for marker in ('<div class="answer"', '<div class="prob_crits"'):
        found = page.find(marker, s)
        if found != -1:
            end = min(end, found)
    return page[s:end]


def images_zone_start(head: str, body_start: int) -> int:
    """Начало зоны поиска картинок: обычно сам id=body, но у заданий
    с рисунком («Рассмотрите рисунок…») он лежит в непосредственно
    предшествующем pbody-блоке (живой случай — био №5).

    Расширяем только при строгих условиях, иначе ловим мусор: разрыв
    маленький (< 2000 знаков), без скриптов, внутри есть <img>.
    На текст условия расширение НЕ влияет — только на подсчёт картинок.
    """
    opens = list(re.finditer(r'<div[^>]*class="pbody"[^>]*>', head[:body_start]))
    if not opens:
        return body_start
    prev = opens[-1].start()
    gap = head[prev:body_start]
    if len(gap) > 2000 or "<script" in gap.lower():
        return body_start
    if "<img" not in gap:
        return body_start
    return prev


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
    # Флаги строгого отбора — ДО подмены формул текстом (иначе меток нет).
    # Проверяем строго по тегам <img>, а не подстрокой по куску HTML: иначе
    # ловим мусор из ссылок и кнопок между условием и пояснением.
    # Зона картинок шире текста: рисунок может лежать в непосредственно
    # предшествующем pbody-блоке (см. images_zone_start).
    zone_raw = head[images_zone_start(head, body.start()):]
    cond_tags = re.findall(r"<img\b[^>]*>", zone_raw)
    n_img = len(cond_tags)
    cond_fig = any("get_file" in (re.search(r'src="([^"]*)"', t) or [ "", ""])[1]
                   for t in cond_tags)
    cond_tex = any('class="tex"' in t or "/formula/" in t for t in cond_tags)
    condition_raw = sub_formula_alt(condition_raw)

    solution_raw = _solution_block(page, anchor.start())
    sol_tex = any('class="tex"' in t or "/formula/" in t
                  for t in re.findall(r"<img\b[^>]*>", solution_raw))
    solution_raw = sub_formula_alt(solution_raw)
    # На источнике в конце блока решения идёт «Правило: …» — для нашей
    # подсказки оно не нужно, режем по маркеру.
    solution_raw = re.split(r"<img class=\"nodraw\"", solution_raw)[0]
    solution_raw = re.sub(r"<img[^>]*>", " ", solution_raw)

    answer_match = ANSWER_RE.search(page)
    answer_raw = strip_markup(answer_match.group(1)) if answer_match else ""
    answer = answer_raw.replace("Ответ:", "").strip().strip(".")
    # «|» в ответе источника разделяет допустимые варианты (например, для
    # заданий «соберите группу»). Сохраняем его без пробелов.
    answer = re.sub(r"\s*\|\s*", "|", answer).strip("|")

    text = strip_markup(condition_raw)
    # Задания №1–3 и №22–26 идут с текстом-источником в отдельном блоке
    # id="textNNN": он не входит в блок вопроса, поэтому приклеиваем его сверху.
    passage = ""
    pm = re.search(r'id="text\d+"', page)
    pass_tex = False
    if pm:
        frag = extract_div(page, pm)
        pass_tex = any('class="tex"' in t or "/formula/" in t
                       for t in re.findall(r"<img\b[^>]*>", frag))
        passage = strip_markup(sub_formula_alt(frag))
        if passage:
            text = passage + "\n\n" + text
    solution = strip_markup(solution_raw)
    # Служебные обвязки источника в решении нам не нужны: заголовок
    # «Пояснение (см. также Правило ниже)» и продублированный в конце ответ.
    solution = re.sub(r"^Пояснение\s*\([^)]*\)\.\s*", "", solution)
    solution = re.sub(r"^Пояснение[^.\n]*\.\s*", "", solution)
    # «|» в решении источника — маркер выделения фрагмента, а не таблица:
    # убираем, иначе рендер соберёт из строки с пайпом ложную таблицу.
    solution = solution.replace("|", "")
    solution = re.sub(r"\s*Ответ:\s*[^\s.]+\.?\s*$", "", solution).strip()
    # Хвостовая кнопка источника у развёрнутых заданий («Спрятать критерии»).
    solution = re.sub(r"\s*Спрятать (?:критерии|пояснение)\s*$", "", solution).strip()

    images = n_img
    tables = len(re.findall(r"<table", condition_raw, re.I))
    # Флаги для строгого отбора без повторного скачивания страницы:
    # has_figure — настоящий рисунок (чертёж/график, get_file) в условии;
    # has_formula — формула-картинка (class="tex", /formula/) в условии,
    # про passages или решении. Такие задания в банк не идут.
    has_figure = cond_fig
    has_formula = cond_tex or sol_tex or pass_tex
    return {
        "src_id": pid,
        "condition": text,
        "solution": solution,
        "answer": answer,
        "url": f"{base}/problem?id={pid}",
        "images": images,
        "tables": tables,
        "has_figure": has_figure,
        "has_formula": has_formula,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("subject", choices=sorted(SUBJECTS))
    ap.add_argument("line", type=int)
    ap.add_argument("count", type=int)
    ap.add_argument("--dry", action="store_true",
                    help="только показать результат, файл не писать")
    ap.add_argument("--passes", type=int, default=1,
                    help="сколько наборов собрать подряд (дедупликация по id); "
                         "стоп, когда новых заданий нет")
    ap.add_argument("--merge", action="store_true",
                    help="дописать новые задания к существующему файлу, а не "
                         "перезаписывать его")
    args = ap.parse_args()

    base = SUBJECTS[args.subject]
    path = OUT_DIR / f"{args.subject}_{args.line:02d}.json"
    known: dict[str, dict] = {}
    if args.merge and path.exists() and not args.dry:
        try:
            for item in json.loads(path.read_text(encoding="utf-8")):
                known[str(item.get("src_id"))] = item
        except (OSError, ValueError):
            known = {}
    print(f"линия {args.line}: уже известно {len(known)}, проходов {args.passes}")

    fresh = 0
    for p in range(args.passes):
        test_id = generate_set(base, args.line, args.count)
        ids = problem_ids(base, test_id)
        new_ids = [pid for pid in ids if pid not in known]
        print(f"  проход {p + 1}: набор {test_id}, заданий {len(ids)}, новых {len(new_ids)}")
        if not new_ids:
            break
        for i, pid in enumerate(new_ids, 1):
            item = parse_problem(base, pid)
            known[pid] = item
            fresh += 1
            print(f"    {i:2}. id={pid:>7} отв={item['answer']!r:10} картинок={item['images']} "
                  f"{item['condition'][:60]!r}")
            time.sleep(PAUSE)

    items = list(known.values())
    print(f"линия {args.line}: всего уникальных {len(items)} (+{fresh} новых)")

    if args.dry:
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    print(f"записано {len(items)} заданий -> {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())