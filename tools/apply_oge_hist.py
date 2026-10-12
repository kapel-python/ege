#!/usr/bin/env python3
"""Сборка банка истории ОГЭ по выгрузкам источника (tools/out/hist_oge_NN.json).

Новый предмет (не добор): скрипт строит server/catalog_oge_history.json ЦЕЛИКОМ
из констант ниже + сырца tools/out/hist_oge_*.json. Перезапуск детерминирован:
тот же сырец — тот же каталог. Ручная часть — только SKILLS (имена + 3 хинта
на тему, требует контракт реестра) и GOALS/DIAGNOSTIC.

Шкала — по спецификации ФИПИ ОГЭ-2026 по истории (24 задания, макс. 37):
часть 1 (№1–17): №1, 4, 7, 13 — по 2 балла, остальные — по 1;
часть 2: №18–21 и №23 — по 2 балла, №22 и №24 — по 3 балла.
Каталог источника (hist-oge.sdamgia.ru) ведёт 23 линии: FIPI-№21
(причины и следствия, 2 балла) отдельной линией не представлен, поэтому
сумма весов прогноза — 35 (честная сумма покрытых линий), пороги оценок —
по письму Рособрнадзора №04-44 (11/21/30).

Правила отбора (как в apply_oge_math.py, строже — карт в пилоте нет):
  * has_figure (карта/схема/иллюстрация через get_file) — в отсев;
  * текст ссылается на наглядность (FIG_RE: «рассмотрите схему»,
    «ознакомьтесь с изображениями» и т.п.) — в отсев, даже при images == 0;
  * часть 1 (№1–17, кроме визуальных линий): нужен непустой машинный ответ;
    разделитель «&» источника внутри варианта — склейка цифр
    последовательности («1&5&3» -> «153»), «|» — допустимые варианты;
  * часть 2 (№18–23): check "self" + type "extended_answer" (как часть 2
    профиля), нужно непустое решение; фраза «в ответ запишите» в self-тексте
    запрещена (роняет install_catalog — проверяем здесь же);
  * линии №8–14 (карты, иллюстрации, схемы, культура с изображениями) без
    рисунка не решаются в принципе (проверено: 15–17 проб на линию, все
    с фигурами) — locked до figura-пайплайна, как o11/o18 у oge_math.
    Цель второй волны — 100 заданий на открытую линию: 12 merge-проходов
    (count 10) исчерпали пулы источника почти досуха (сырца на линию
    28–56 против 33–62 в каталоге источника), поэтому каждая открытая
    линия берётся ПОЛНОСТЬЮ — честный кап на размере годного пула
    (см. отчёт второй волны). Поднять выдачу — только новым источником.

    python3 tools/apply_oge_hist.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_oge_hist.py             # записать server/catalog_oge_history.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from apply_basic import (  # переиспользуем классификатор/чистку базы
    FIG_RE,
    classify,
    clean,
    sub_from,
)

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_oge_history.json"
OUT_DIR = ROOT / "tools" / "out"

SUBJECT = "oge_history"
# Цель — 100 заданий на открытую линию; фактически берётся весь годный пул
# (исчерпан: 12 проходов, см. отчёт). Недобор против 100 — честный кап.
TARGET_PER_LINE = 100
PART2_LINES = set(range(18, 24))
# Баллы линий по спецификации ФИПИ ОГЭ-2026 (SDAM-линия 21 «ошибки» = FIPI-22,
# 3 балла; SDAM-линия 23 «ситуация» = FIPI-24, 3 балла).
LINE_POINTS = {
    1: 2, 2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 2,
    8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 2, 14: 1,
    15: 1, 16: 1, 17: 1,
    18: 2, 19: 2, 20: 2, 21: 3, 22: 2, 23: 3,
}
# Линии без единого честного текстового задания (карта/схема/иллюстрация —
# суть задания) — locked до figura-пайплайна, как o11/o18 у oge_math.
# Покрытие миссиями для них не требуется: needs_mission в subject-contract
# строится по выданным заданиям.
LOCKED_SKILLS = {
    "oh08_map", "oh09_map2", "oh10_map3", "oh11_images",
    "oh12_scheme", "oh13_culture", "oh14_culture2",
}

# --- Ветки Пути -------------------------------------------------------------
CATEGORIES = [
    {"id": "ogh_russia", "name": "Часть 1: история России (№1–14)",
     "short": "Россия", "subject": SUBJECT},
    {"id": "ogh_world", "name": "Часть 1: всеобщая история (№15–17)",
     "short": "Мир", "subject": SUBJECT},
    {"id": "ogh_extended", "name": "Часть 2: развёрнутые ответы (№18–23)",
     "short": "Развёрнутые", "subject": SUBJECT},
]

# --- Темы: id, имя, ветка ----------------------------------------------------
# Имена линий — по каталогу Решу ОГЭ (hist-oge.sdamgia.ru/prob_catalog).
SKILLS: list[tuple[str, str, str]] = [
    ("oh01_dates", "№1 — Систематизация фактов и понятий", "ogh_russia"),
    ("oh02_sequence", "№2 — Хронологическая последовательность", "ogh_russia"),
    ("oh03_terms", "№3 — Термин по определению", "ogh_russia"),
    ("oh04_facts", "№4 — Основные факты (множественный выбор)", "ogh_russia"),
    ("oh05_extraterm", "№5 — Лишний термин в ряду", "ogh_russia"),
    ("oh06_thesis", "№6 — Тезисы и факты для аргументации", "ogh_russia"),
    ("oh07_stats", "№7 — Работа со статистической таблицей", "ogh_russia"),
    ("oh08_map", "№8 — Работа с исторической картой", "ogh_russia"),
    ("oh09_map2", "№9 — Работа с исторической картой", "ogh_russia"),
    ("oh10_map3", "№10 — Карта и исторический текст", "ogh_russia"),
    ("oh11_images", "№11 — Работа с изображением", "ogh_russia"),
    ("oh12_scheme", "№12 — Информация в виде схемы", "ogh_russia"),
    ("oh13_culture", "№13 — Памятники культуры", "ogh_russia"),
    ("oh14_culture2", "№14 — Памятники культуры", "ogh_russia"),
    ("oh15_world", "№15 — Зарубежная история: деятели", "ogh_world"),
    ("oh16_world2", "№16 — Зарубежная история: факты", "ogh_world"),
    ("oh17_world3", "№17 — Зарубежная история: источник", "ogh_world"),
    ("oh18_source", "№18 — Источник: атрибуция", "ogh_extended"),
    ("oh19_source2", "№19 — Источник: поиск информации", "ogh_extended"),
    ("oh20_source3", "№20 — Источник: контекстный анализ", "ogh_extended"),
    ("oh21_errors", "№21 — Ошибки в историческом тексте", "ogh_extended"),
    ("oh22_compare", "№22 — Сравнение событий и явлений", "ogh_extended"),
    ("oh23_situation", "№23 — Анализ исторической ситуации", "ogh_extended"),
]

# --- Подсказки темы: ровно 3 непустые строки (требует контракт реестра) ------
HINTS: dict[str, list[str]] = {
    "oh01_dates": [
        "Выпиши пары «событие — год» заранее: соответствия ищутся по готовым парам, а не по памяти в момент ответа.",
        "Отсекай заведомо чужое: Аустерлиц — XIX век, Ледовое побоище — XIII, такие якоря решают половину таблицы.",
        "Проверь каждую букву отдельно: одна строка — один факт, не тяни соседние.",
    ],
    "oh02_sequence": [
        "Найди самое раннее и самое позднее события — края последовательности обычно очевидны.",
        "Привяжи события к векам: всё, что до 1700, — раньше всего петровского.",
        "Если сомневаешься в паре — вспомни причинность: причина всегда раньше следствия.",
    ],
    "oh03_terms": [
        "Ищи слово-ядро определения: «свод законов» — уложение, «порядок» — устав, «налог» — подать.",
        "Дата в определении — подсказка эпохи: 1497 — Судебник, 1649 — Соборное уложение.",
        "Отвечай одним словом в именительном падеже, без лишних пояснений.",
    ],
    "oh04_facts": [
        "Читай вопрос до конца: спрашивают участников — подойдут только люди, спрашивают события — только события.",
        "Вычёркивай заведомо чужую эпоху: Крымская война — XIX век, Смута — начало XVII.",
        "Если просят два верных — ищи именно два, лишний ответ обнуляет задание.",
    ],
    "oh05_extraterm": [
        "Сначала найди общее у четырёх: век, правитель, война, реформа — лишний тот, кто выбивается.",
        "Проверяй каждый термин отдельно, а не ищи лишний на глаз.",
        "Одно слово может относиться к двум рядам — смотри на остальные четыре для контекста.",
    ],
    "oh06_thesis": [
        "Тезис — это утверждение с оценкой («причина», «следствие», «значение»), факт — просто событие.",
        "Разбей четыре предложения на две пары: два тезиса звучат как выводы, два факта — как хроника.",
        "Ищи слова-маркеры: «потому что», «привело к», «свидетельствует» — это тезисы.",
    ],
    "oh07_stats": [
        "Читай шапку таблицы первой: что измерено, в каких единицах, за какие годы.",
        "«Сохранилось на уровне» — ищи одинаковые числа в строке; «наибольший рост» — biggest разницу.",
        "Сопоставляй начала и завершения по смыслу, а не по порядку: регион из А ищи среди вариантов.",
    ],
    "oh08_map": [
        "Найди на схеме стрелки походов и подписанные города — направление движения задаёт ответ.",
        "Легенда и подписи важнее деталей: век и стороны конфликта читаются из них.",
        "Сопоставь схему с известной картой событий: названия рек и городов — якоря.",
    ],
    "oh09_map2": [
        "Определи, чья это война и какой год: по именам полководцев и городам.",
        "Город из вопроса ищи среди подписей на схеме, а не вспоминай наизусть.",
        "Проверь соседние задания блока №8–10: схема одна, контекст общий.",
    ],
    "oh10_map3": [
        "Прочитай отрывок из источника первым: имена и события в нём привязываются к схеме.",
        "Соответствие «текст — карта» строится через топонимы: найди их в обоих местах.",
        "Век события из текста ограничивает выбор: дальше работай только со схемой.",
    ],
    "oh11_images": [
        "Определи эпоху по деталям: одежда, оружие, техника, архитектура.",
        "Исторический деятель узнаётся по подписи эпохи: век сужает круг до нескольких имён.",
        "Если спрашивают событие — ищи его признаки на изображении, а не в памяти.",
    ],
    "oh12_scheme": [
        "Читай схему сверху вниз: верхние блоки — общее, нижние — частное.",
        "Пропуск заполняется словом из той же эпохи, что соседи по схеме.",
        "Термины-подсказки рядом задают тему: Русь — «Русская правда», приказы — XVII век.",
    ],
    "oh13_culture": [
        "Памятник датируется по стилю: шатровый храм — XVI век, барокко — XVIII.",
        "Соотноси памятник с правителем: при ком строили — тем и отвечает.",
        "Список названий читай целиком: половина вариантов отпадает по веку.",
    ],
    "oh14_culture2": [
        "Автор и памятник — парные факты: запомни главные связки (Нестор — летопись, Рублёв — иконы).",
        "Проверяй каждый вариант отдельно: век, вид искусства, имя создателя.",
        "Если два варианта из одного века — уточни вид: литература, зодчество, живопись.",
    ],
    "oh15_world": [
        "Деятели зарубежных стран привязаны к событиям: реформатор — к реформе, полководец — к войне.",
        "Отсекай по эпохе: Древний мир, Средние века и Новое время не пересекаются.",
        "Страна из перечня задаёт круг имён: дальше выбирай внутри него.",
    ],
    "oh16_world2": [
        "Факты зарубежной истории учи связками «страна — событие — век».",
        "Хронология-якорь: падение Рима — V век, Реформация — XVI, революции — XVIII–XIX.",
        "Не путай похожие события разных стран: смотри на имена и топонимы в вопросе.",
    ],
    "oh17_world3": [
        "Источник читай с вопросом: ищи именно то, о чём спрашивают, а не пересказывай всё.",
        "Имена, титулы и география в тексте указывают на страну и эпоху.",
        "Ответ обычно — короткая цитата или её пересказ: не домысливай лишнего.",
    ],
    "oh18_source": [
        "Атрибуция — это «кто, когда, о чём»: ищи имя автора, дату и событие в самом тексте.",
        "Титулы и обращения выдают автора: «государь», «холоп», «братия» — маркеры эпохи.",
        "Событие из источника привяжи к дате: дальше отвечают уже знания, а не текст.",
    ],
    "oh19_source2": [
        "Отвечай словами источника: найди нужное место и перескажи близко к тексту.",
        "Каждый подпункт — отдельное место в тексте, не смешивай их.",
        "Если спрашивают два положения — выпиши ровно два, лишнее не добавит баллов.",
    ],
    "oh20_source3": [
        "Контекст — это знания за пределами текста: что было до и после описанного.",
        "Привяжи источник к событию из №18, дальше отвечай по курсу.",
        "Причины и следствия называй конкретно: имена, даты, факты, а не общие слова.",
    ],
    "oh21_errors": [
        "Проверяй каждое утверждение текста отдельно: дата, имя, порядок событий.",
        "Классические ловушки: перепутанные Рюрик и Олег, 862 и 882 годы, имена князей.",
        "Оформляй таблицу с обеими колонками: ошибка без исправления не засчитывается.",
    ],
    "oh22_compare": [
        "Сравнение строй по плану: сначала общее, потом различия — по 2–3 пункта.",
        "Каждый пункт подкрепляй фактом: дата, имя, событие, а не общие рассуждения.",
        "Точка зрения из задания — рамка: доказывай именно её, а не свою.",
    ],
    "oh23_situation": [
        "Определи правителя и эпоху по описанию: срок правления и события — якоря.",
        "Причины называй до события, следствия — после, не смешивай.",
        "Отвечай по критериям развёрнутого ответа: факты, связи, выводы — каждый пункт отдельно.",
    ],
}

GOALS = [
    {"id": "g3", "label": "Оценка 3",
     "desc": "11+ баллов — аттестат"},
    {"id": "g4", "label": "Оценка 4",
     "desc": "21+ баллов — уверенный результат"},
    {"id": "g5", "label": "Оценка 5",
     "desc": "30+ баллов — отличный результат"},
]

# Диагностика: по одному заданию из representative-линий (все — часть 1,
# self-заданий в диагностике нет: там поле ввода с автопроверкой).
DIAGNOSTIC_LINES = [1, 2, 3, 5, 6, 7, 15, 17]

DAILY = {"skill": "oh01_dates", "target": 5, "xp": 50,
         "title": "Ежедневная подборка заданий ОГЭ"}

BOSSES = [
    {"id": "boss-oge-hist-russia", "cat": "ogh_russia",
     "title": "БОСС: История России (часть 1)",
     "desc": "Смешанные задания по истории России из банка истории ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-hist-world", "cat": "ogh_world",
     "title": "БОСС: Всеобщая история",
     "desc": "Смешанные задания по всеобщей истории из банка истории ОГЭ.",
     "size": 6, "xp": 300, "unlockAt": 25},
    {"id": "boss-oge-hist-extended", "cat": "ogh_extended",
     "title": "БОСС: Развёрнутые ответы",
     "desc": "Смешанные задания части 2 из банка истории ОГЭ.",
     "size": 6, "xp": 400, "unlockAt": 25},
]

KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint",
             "hints", "solution", "type", "check", "sourceId", "status",
             "example", "points", "valueType", "source", "subject"]

SELF_PHRASE_RE = re.compile(r"в\s+ответ\s+запишите", re.I)
# Строка-упоминание наглядности, которую FIG_RE из apply_basic не ловит
# (история: «рассмотрите схему», «ознакомьтесь с изображениями»).
HIST_FIG_RE = re.compile(
    r"рассмотрите\s+(схему|рисунок|изображение|карту)"
    r"|ознакомьтесь\s+с\s+перечнем\s+и\s+изображениями", re.I)


def line_of_skill(skill_id: str) -> int:
    m = re.match(r"oh(\d+)_", skill_id)
    assert m, skill_id
    return int(m.group(1))


def skill_by_line() -> dict[int, str]:
    return {line_of_skill(sid): sid for sid, _, _ in SKILLS}


def hints_from(solution: str) -> tuple[str, list[str]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "")
             if p.strip()]
    if not parts:
        generic = "Прочитай условие и ответь на поставленный вопрос."
        return generic, [generic]
    return parts[0], parts[:3]


def norm_variants(raw_answer: str) -> list[str]:
    """Допустимые варианты ответа источника.

    «|» разделяет варианты («35|53», «Соборное Уложение|соборноеуложение»),
    «&» внутри варианта — склейка цифр последовательности («1&5&3» -> «153»).
    """
    out = []
    for chunk in (raw_answer or "").split("|"):
        chunk = chunk.strip().strip(".")
        if not chunk:
            continue
        if re.fullmatch(r"[\d\s&]+", chunk):
            chunk = re.sub(r"[\s&]", "", chunk)
        if chunk:
            out.append(chunk)
    return out


def raw_pool(n: int) -> list[dict]:
    path = OUT_DIR / f"hist_oge_{n:02d}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


# Сырые записи, исключённые из банка (честный кап, не в счёт TARGET):
# 27441/27442/27443/27445/28918/28919/27447 — битый блок решения источника
# (в решение утекли соседние задания и подвал страницы: «Спрятать пояснение»,
# «Наверх», «О проекте»; ловит audit_catalog_import как жёсткую проблему);
# 14144 — полный дубль 8235 (тот же текст и то же решение, другой src_id);
# 14087 — полный дубль 9250. Чинить нечем: парсер общий (не наш), а писать
# свои разборы запрещено — только реальные данные источника.
EXCLUDE_SRC = {"27441", "27442", "27443", "27445", "28918", "28919", "27447",
               "14144", "14087"}


def usable(raw: dict, part2: bool) -> bool:
    """Годится ли сырое задание в банк (без наглядности, решаемое)."""
    if str(raw.get("src_id")) in EXCLUDE_SRC:
        return False
    if raw.get("has_figure"):
        return False
    if FIG_RE.search(raw.get("condition") or ""):
        return False
    if HIST_FIG_RE.search(raw.get("condition") or ""):
        return False
    if part2:
        # Развёрнутый ответ: нужно непустое решение; машинного ответа нет.
        return bool((raw.get("solution") or "").strip())
    return bool(norm_variants(raw.get("answer") or ""))


def task_from_source(n: int, idx: int, raw: dict, skill: str) -> dict:
    part2 = n in PART2_LINES
    text = clean(raw["condition"])
    solution = (raw.get("solution") or "").strip()
    points = LINE_POINTS[n]
    if part2:
        if SELF_PHRASE_RE.search(text):
            raise ValueError(f"self-задание {raw['src_id']}: «в ответ запишите» в тексте")
        hint, hints = hints_from(solution)
        task = {
            "id": f"oh{n:02d}_p{idx}",
            "skill": skill,
            "sub": sub_from(text),
            "num": f"№{n}",
            "diff": 2,
            "text": text,
            "answer": "",
            "hint": hint,
            "hints": hints,
            "solution": solution,
            "type": "extended_answer",
            "check": "self",
            "sourceId": f"sdamgia-{raw['src_id']}",
            "status": "sdamgia",
            "example": idx,
            "points": points,
            # Как у большинства self-заданий профиля: поле ввода у таких
            # заданий отсутствует, значение инертно, но пусть будет канон.
            "valueType": "общее решение + список",
            "source": f"Решу ОГЭ (СДАМ ГИА), история, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    else:
        alts = norm_variants(raw.get("answer") or "")
        answer = alts[0] if alts else ""
        value_type = classify(text, answer)
        hint, hints = hints_from(solution)
        task = {
            "id": f"oh{n:02d}_p{idx}",
            "skill": skill,
            "sub": sub_from(text),
            "num": f"№{n}",
            "diff": 1,
            "text": text,
            "answer": answer,
            "hint": hint,
            "hints": hints,
            "solution": solution,
            "type": "short_answer",
            "sourceId": f"sdamgia-{raw['src_id']}",
            "status": "sdamgia",
            "example": idx,
            "points": points,
            "valueType": value_type,
            "source": f"Решу ОГЭ (СДАМ ГИА), история, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    out = {k: task[k] for k in KEY_ORDER if k in task}
    if not part2 and len(alts) > 1:
        out["accept"] = alts
    return out


def build_tasks() -> tuple[list[dict], list[tuple]]:
    skills = skill_by_line()
    tasks: list[dict] = []
    summary = []
    for n in range(1, 24):
        skill = skills[n]
        part2 = n in PART2_LINES
        if skill in LOCKED_SKILLS:
            summary.append((n, skill, 0, len(raw_pool(n))))
            continue
        pool = [r for r in raw_pool(n) if usable(r, part2)]
        picked = pool[:TARGET_PER_LINE]
        for i, r in enumerate(picked, 1):
            tasks.append(task_from_source(n, i, r, skill))
        summary.append((n, skill, len(picked), len(raw_pool(n))))
    tasks.sort(key=lambda t: (t.get("skill") or "", t.get("id") or ""))
    return tasks, summary


def build_missions(tasks: list[dict]) -> list[dict]:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    missions = []
    for sid, name, _cat in SKILLS:
        if sid in LOCKED_SKILLS:
            continue
        group = sorted(by_skill.get(sid, []), key=lambda t: t["id"])
        assert group, f"нет заданий для миссии {sid}"
        num = line_of_skill(sid)
        missions.append({
            "id": f"m-{sid}",
            "skill": sid,
            "title": f"Практика: {name}",
            "desc": f"Все задания №{num} из банка истории ОГЭ.",
            "tasks": [t["id"] for t in group[:3]],
            "xp": 40,
            "diff": 2 if num in PART2_LINES else 1,
        })
    return missions


def build_catalog(tasks: list[dict]) -> dict:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    diagnostic = []
    for n in DIAGNOSTIC_LINES:
        sid = skill_by_line()[n]
        group = sorted(by_skill.get(sid, []), key=lambda t: t["id"])
        assert group, f"нет заданий для диагностики: линия {n}"
        diagnostic.append(group[0]["id"])
    order = {sid: i for i, (sid, _, _) in enumerate(SKILLS)}
    skills = []
    for sid, name, cat in SKILLS:
        entry = {
            "id": sid,
            "name": name,
            "cat": cat,
            "order": order[sid],
            "ege": f"№{line_of_skill(sid)}",
            "subject": SUBJECT,
            "metadata": {"hints": HINTS[sid]},
        }
        if sid in LOCKED_SKILLS:
            entry["status"] = "locked"
            entry["locked"] = True
            entry["comingSoon"] = True
        skills.append(entry)
    return {
        "subject": SUBJECT,
        "subjectId": SUBJECT,
        "title": "История (ОГЭ)",
        "status": "ready",
        "features": {"lessons": False, "practice": True, "forecast": True,
                     "diagnostics": True, "missions": True, "bosses": True,
                     "daily": True, "path": True},
        "description": "История ОГЭ: задания №1–23 экзамена — практика на реальных заданиях.",
        "categories": CATEGORIES,
        "skills": skills,
        "tasks": tasks,
        "lessons": [],
        "missions": build_missions(tasks),
        "bosses": BOSSES,
        "achievements": [],
        "daily": DAILY,
        "goals": GOALS,
        "diagnosticTasks": diagnostic,
        "visualAssets": [],
        "visualAudit": {"defaultStatus": "not-published", "taskStatuses": {},
                       "references": []},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()

    tasks, summary = build_tasks()
    print(f"{'линия':6} {'skill':16} {'взято':8} сырца")
    short = 0
    for n, skill, got, total in summary:
        if skill in LOCKED_SKILLS:
            print(f"lock №{n:<4} {skill:16} каждый с рисунком (сырца {total})")
            continue
        flag = "OK " if got == TARGET_PER_LINE else "CAP "
        if got < TARGET_PER_LINE:
            short += 1
        print(f"{flag} №{n:<4} {skill:16} {got:>2}/{TARGET_PER_LINE}   "
              f"{total:>3}")
    print(f"итого заданий: {len(tasks)} (линий с недобором: {short})")
    if args.analyze:
        return 0
    data = build_catalog(tasks)
    CATALOG.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    print(f"записано {len(tasks)} заданий, {len(data['missions'])} миссий, "
          f"{len(data['bosses'])} боссов -> {CATALOG.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
