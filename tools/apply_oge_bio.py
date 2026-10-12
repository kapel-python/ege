#!/usr/bin/env python3
"""Сборка банка биологии ОГЭ по выгрузкам источника (tools/out/bio_oge_NN.json).

Новый предмет (не добор): скрипт строит server/catalog_oge_biology.json
ЦЕЛИКОМ из констант ниже + сырца tools/out/bio_oge_*.json. Перезапуск
детерминирован: тот же сырец — тот же каталог. Ручная часть — только SKILLS
(имена + 3 хинта на тему, требует контракт реестра) и GOALS/DIAGNOSTIC.

Структура экзамена (ФИПИ, демоверсия/спецификация ОГЭ по биологии):
26 заданий, две части, максимум 47 первичных баллов. Часть 1 (№1–21,
краткий ответ): №1–3, 6, 8, 12, 14, 15, 20 — по 1 баллу; №4, 5, 7, 9–11,
16–19, 21 — по 2 балла; №13 — 3 балла. Часть 2 (№22–26, развёрнутый
ответ): №22, 23 — по 2 балла; №24–26 — по 3 балла. Пороги: «3» — 13+,
«4» — 26+, «5» — 38+ (профиль — 33+).

Правила отбора (как в apply_oge_math.py):
  * без настоящих рисунков: has_figure (фото/чертёж get_file) — в отсев;
  * текст ссылается на рисунок (FIG_RE) — в отсев, даже при images == 0;
  * часть 1 (№1–21): нужен непустой машинный ответ; часть 2 (№22–26):
    check "self" + type "extended_answer" (как часть 2 профиля), нужно
    непустое решение; фраза «в ответ запишите» в self-тексте запрещена
    (роняет install_catalog — проверяем здесь же);
  * цель — 100 заданий на тему; недостижимое — locked-навык (как o11/o18
    у математики ОГЭ) или честный кап с причинами построчно (см. отчёт).

    python3 tools/apply_oge_bio.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_oge_bio.py             # записать server/catalog_oge_biology.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from apply_basic import (  # переиспользуем классификатор/чистку базы
    FIG_RE,
    MATCHING_RE,
    MULTI_RE,
    classify,
    clean,
    matching_positions,
    sub_from,
)

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_oge_biology.json"
OUT_DIR = ROOT / "tools" / "out"

SUBJECT = "oge_biology"
TARGET_PER_LINE = 100
PART2_LINES = set(range(22, 27))
# Вес линии в первичных баллах (спецификация ФИПИ ОГЭ-биологии).
POINTS = {
    1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 2, 8: 1, 9: 2, 10: 2,
    11: 2, 12: 1, 13: 3, 14: 1, 15: 1, 16: 2, 17: 2, 18: 2, 19: 2,
    20: 1, 21: 2, 22: 2, 23: 2, 24: 3, 25: 3, 26: 3,
}
# Линии, где чертёж источника — декорация: проверено чтением, что условие
# самодостаточно (все данные и вопрос — в тексте, ссылок на рисунок нет).
# Пусто: фотографии морфологии/графики/структур несут данные (см. отчёт).
RELAX_LINES: set[int] = set()
APPROVED_SRC: set[str] = set()
# Навыки без честного банка (без рисунка не решаются в принципе) — locked
# до figura-пайплайна, как o11/o18 у математики ОГЭ и russian_writing до
# публикации русского. Проверено чтением сэмплов каждой линии: рисунок
# несёт данные (см. отчёт). Покрытие миссиями для них не требуется:
# needs_mission в subject-contract строится по выданным заданиям.
LOCKED_SKILLS = {"ob01_science", "ob04_graphics", "ob13_morph",
                 "ob14_humanfeat", "ob16_humanstruct", "ob19_ecodesc",
                 "ob20_foodchain", "ob21_biorel", "ob22_biorole"}

# --- Ветки Пути -------------------------------------------------------------
CATEGORIES = [
    {"id": "oge_bio_general", "name": "Общая биология (№1, 3, 5–8, 12)",
     "short": "Общая", "subject": SUBJECT},
    {"id": "oge_bio_diversity", "name": "Многообразие организмов (№2, 4, 9–11, 13)",
     "short": "Многообразие", "subject": SUBJECT},
    {"id": "oge_bio_human", "name": "Человек и его здоровье (№14–18, 22, 26)",
     "short": "Человек", "subject": SUBJECT},
    {"id": "oge_bio_eco", "name": "Экология и данные (№19–21, 23–25)",
     "short": "Экология", "subject": SUBJECT},
]

# --- Темы: id, имя, ветка ----------------------------------------------------
# Имена линий — по каталогу Решу ОГЭ (bio-oge.sdamgia.ru/prob_catalog).
SKILLS: list[tuple[str, str, str]] = [
    ("ob01_science", "№1 — Биология как наука", "oge_bio_general"),
    ("ob02_kingdoms", "№2 — Царства живой природы", "oge_bio_diversity"),
    ("ob03_syscat", "№3 — Систематические категории", "oge_bio_general"),
    ("ob04_graphics", "№4 — Информация в графической форме", "oge_bio_diversity"),
    ("ob05_processes", "№5 — Биологические процессы и явления", "oge_bio_general"),
    ("ob06_devices", "№6 — Биологические приборы", "oge_bio_general"),
    ("ob07_veracity", "№7 — Достоверность информации", "oge_bio_general"),
    ("ob08_structure", "№8 — Структура биологических объектов", "oge_bio_general"),
    ("ob09_divchoice", "№9 — Разнообразие организмов (выбор)", "oge_bio_diversity"),
    ("ob10_gaps", "№10 — Пропущенные термины и понятия", "oge_bio_diversity"),
    ("ob11_divmatch", "№11 — Разнообразие организмов (соответствие)", "oge_bio_diversity"),
    ("ob12_judgments", "№12 — Правильность суждений", "oge_bio_general"),
    ("ob13_morph", "№13 — Морфологические признаки", "oge_bio_diversity"),
    ("ob14_humanfeat", "№14 — Признаки строения человека", "oge_bio_human"),
    ("ob15_humanbody", "№15 — Особенности организма человека", "oge_bio_human"),
    ("ob16_humanstruct", "№16 — Строение организма человека", "oge_bio_human"),
    ("ob17_humanchoice", "№17 — Организм человека (выбор)", "oge_bio_human"),
    ("ob18_humanmatch", "№18 — Организм человека (соответствие)", "oge_bio_human"),
    ("ob19_ecodesc", "№19 — Экологическое описание вида", "oge_bio_eco"),
    ("ob20_foodchain", "№20 — Пищевые цепи", "oge_bio_eco"),
    ("ob21_biorel", "№21 — Биотические отношения", "oge_bio_eco"),
    ("ob22_biorole", "№22 — Роль биологии в жизни человека", "oge_bio_human"),
    ("ob23_scimethod", "№23 — Научные методы изучения", "oge_bio_eco"),
    ("ob24_biotext", "№24 — Работа с биологическим текстом", "oge_bio_eco"),
    ("ob25_biostat", "№25 — Статистика в табличной форме", "oge_bio_eco"),
    ("ob26_energy", "№26 — Энерготраты и рацион", "oge_bio_human"),
]

# --- Подсказки темы: ровно 3 непустые строки (требует контракт реестра) ------
HINTS: dict[str, list[str]] = {
    "ob01_science": [
        "Метод называй по действию: наблюдение — смотрит, эксперимент — меняет условия, сравнение — сопоставляет.",
        "Уровни организации иди по порядку: клетка → ткань → орган → система → организм.",
        "Признаки живого сверяй списком: питание, дыхание, рост, развитие, раздражимость, размножение.",
    ],
    "ob02_kingdoms": [
        "Бактерии — безъядерные (прокариоты): всё «палочка, кокк, бацилла» — сюда.",
        "Грибы не фотосинтезируют: спорынья, мукор, дрожжи — грибы, даже если похожи на растения.",
        "Вирусы — неклеточная форма жизни: в царства не входят, проверяй это отдельно.",
    ],
    "ob03_syscat": [
        "Иерархия сверху вниз: царство → отдел (тип) → класс → отряд → семейство → род → вид.",
        "Вид — мельчайшая единица: особи скрещиваются и дают плодовитое потомство.",
        "Отдел — только у растений, тип — у животных: не путай названия рангов.",
    ],
    "ob04_graphics": [
        "Сначала читай подписи осей и легенду графика — половина ответа уже там.",
        "Пик и спад на кривой переводи в слова: рост, максимум, снижение.",
        "Сравнивай ряды попарно: ищи, где линии расходятся сильнее всего.",
    ],
    "ob05_processes": [
        "Фотосинтез: свет + вода + углекислый газ → органика + кислород; место — хлоропласты.",
        "Дыхание — окисление органики с выделением энергии; не путай его с газообменом.",
        "Процесс привязывай к структуре: брожение — цитоплазма, синтез белка — рибосомы.",
    ],
    "ob06_devices": [
        "Микроскоп: увеличение равно произведению окуляра на объектив — считай до ответа.",
        "Лупа и микроскоп — оптика; термометр, весы, секундомер — измерение величин.",
        "Прибор выбирай по задаче: время — секундомер, массу — весы, мелкое — микроскоп.",
    ],
    "ob07_veracity": [
        "Достоверный источник: учебник, научная статья, музей — а не блог и реклама.",
        "Проверяй три вещи: кто автор, есть ли данные, можно ли повторить опыт.",
        "Рекламные слова («чудо», «стопроцентно») — маркер недостоверности.",
    ],
    "ob08_structure": [
        "Клетка: ядро хранит ДНК, митохондрии дают энергию, хлоропласты — только у растений.",
        "Ткань → орган → система: называй уровень каждого названного объекта.",
        "Органоид ищи по функции: рибосомы — белок, лизосомы — переваривание.",
    ],
    "ob09_divchoice": [
        "Цветки и плоды — только покрытосеменные; шишки — голосеменные.",
        "Молоком выкармливают только млекопитающие; перья — только у птиц.",
        "Споры у мхов и папоротников — бесполое размножение, семена — у семенных.",
    ],
    "ob10_gaps": [
        "Пропуск в схеме — это связь: спроси «что из чего получается» и «что чем управляет».",
        "Термин подбирай по грамматике: род и число должны совпасть с соседями.",
        "Список кандидатов сокращай: вычеркни заведомо чужие по теме.",
    ],
    "ob11_divmatch": [
        "Соответствие строй по одному признаку за раз: сначала очевидные пары.",
        "Каждому объекту — ровно один ответ: использованную цифру вычёркивай.",
        "Систематику сверяй снизу вверх: вид → род → семейство.",
    ],
    "ob12_judgments": [
        "Суждение ложно целиком, если ложно хоть одно слово: ищи «все», «только», «никогда».",
        "Проверяй каждое суждение отдельно, не переноси вывод с соседнего.",
        "Сомневаешься — вспоминай контрпример: один пример ломает «все».",
    ],
    "ob13_morph": [
        "Лист описывай по плану: черешковый или сидячий → жилкование → форма → край.",
        "Жилкование: дуговое и параллельное — однодольные, перистое и пальчатое — двудольные.",
        "Породу и сорт сверяй со стандартом по каждому признаку отдельно.",
    ],
    "ob14_humanfeat": [
        "Кость называй по отделу скелета: череп, позвоночник, конечности.",
        "Позвонки считай по отделам: 7 шейных, 12 грудных, 5 поясничных.",
        "Мышцы-антагонисты работают в паре: сгибатель — разгибатель.",
    ],
    "ob15_humanbody": [
        "Внутренняя среда — кровь, лимфа, тканевая жидкость: гомеостаз держит их состав.",
        "Гуморальная регуляция — через гормоны в крови, нервная — через рефлексы.",
        "Рефлекторная дуга: рецептор → нерв → центральная система → нерв → орган.",
    ],
    "ob16_humanstruct": [
        "Систему определяй по органам: нефроны — выделительная, альвеолы — дыхательная.",
        "Артерии несут кровь от сердца, вены — к сердцу (это не про кислород).",
        "Нейрон: дендриты принимают сигнал, аксон — передаёт дальше.",
    ],
    "ob17_humanchoice": [
        "Симптом привязывай к системе: одышка — дыхание, отёки — выделение и сердце.",
        "Витамины: D — кости, C — сосуды и иммунитет, A — зрение.",
        "Прививка — активный искусственный иммунитет; сыворотка — пассивный.",
    ],
    "ob18_humanmatch": [
        "Железу соотноси с гормоном: инсулин — поджелудочная, тироксин — щитовидная.",
        "Элемент — с последствием нехватки: железо — анемия, йод — зоб.",
        "Пары строй от известного: закрепи уверенные, потом разбирай спорные.",
    ],
    "ob19_ecodesc": [
        "Вид описывай по плану: ареал → местообитание → питание → роль в сообществе.",
        "Абиотические факторы — свет, вода, температура; биотические — всё живое.",
        "Приспособленность всегда относительна: подходит именно к этим условиям.",
    ],
    "ob20_foodchain": [
        "Цепь начинается с продуцента (растения) и идёт «кого съели».",
        "Стрелка показывает передачу вещества: от жертвы к потребителю.",
        "Редуценты (грибы, бактерии) замыкают круг: мёртвая органика → минеральные соли.",
    ],
    "ob21_biorel": [
        "Симбиоз — оба в выигрыше; паразитизм — один живёт за счёт другого.",
        "Конкуренция — борьба за общий ресурс; хищничество — «съел».",
        "Квартирантство и нахлебничество вреда хозяину не наносят — отличай от паразитизма.",
    ],
    "ob22_biorole": [
        "Практическую роль ищи в условии: медицина, сельское хозяйство, охрана природы.",
        "Заболевание — к профилактике: вакцинация, гигиена, карантин.",
        "Ответ строй как «факт → вывод»: сначала что дано, потом зачем это людям.",
    ],
    "ob23_scimethod": [
        "Гипотеза проверяется опытом с контролем: всё одинаково, кроме одного фактора.",
        "Наблюдение отвечает «что происходит», эксперимент — «почему».",
        "Вывод опирай на данные опыта, а не на текст учебника.",
    ],
    "ob24_biotext": [
        "Ответы ищи в тексте: подчёркивай предложения с нужными фактами.",
        "Вопросы идут по порядку текста: не прыгай туда-сюда.",
        "Свои знания добавляй, только если вопрос просит («используя знания»).",
    ],
    "ob25_biostat": [
        "Таблица читается по шапке: что в строках, что в столбцах, единицы измерения.",
        "Максимум и минимум находи по столбцу, потом называй строку.",
        "Тренд описывай словами: растёт, падает, пик в таком-то году.",
    ],
    "ob26_energy": [
        "Энергозатраты — это основной обмен плюс активность: складывай обе части.",
        "Рацион проверяй по балансу: белки, жиры, углеводы и калорийность.",
        "Единицы переводи до счёта: килоджоули и килокалории не смешивай.",
    ],
}

GOALS = [
    {"id": "g3", "label": "Оценка 3",
     "desc": "13+ баллов — аттестат"},
    {"id": "g4", "label": "Оценка 4",
     "desc": "26+ баллов — уверенный результат"},
    {"id": "g5", "label": "Оценка 5",
     "desc": "38+ баллов (профиль — 33+) — максимум ОГЭ"},
]

# Диагностика: по одному заданию из representative-линий части 1
# (self-заданий в диагностике нет: там поле ввода с автопроверкой).
DIAGNOSTIC_LINES = [2, 3, 5, 9, 12, 15, 17, 18]

DAILY = {"skill": "ob02_kingdoms", "target": 5, "xp": 50,
         "title": "Ежедневная подборка заданий ОГЭ"}

BOSSES = [
    {"id": "boss-oge-bio-general", "cat": "oge_bio_general",
     "title": "БОСС: Общая биология",
     "desc": "Смешанные задания общей биологии из банка биологии ОГЭ.",
     "size": 6, "xp": 300, "unlockAt": 25},
    {"id": "boss-oge-bio-diversity", "cat": "oge_bio_diversity",
     "title": "БОСС: Многообразие организмов",
     "desc": "Смешанные задания по многообразию организмов из банка биологии ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-bio-human", "cat": "oge_bio_human",
     "title": "БОСС: Человек и его здоровье",
     "desc": "Смешанные задания о человеке из банка биологии ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-bio-eco", "cat": "oge_bio_eco",
     "title": "БОСС: Экология и данные",
     "desc": "Смешанные задания по экологии из банка биологии ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
]

KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint",
             "hints", "solution", "type", "check", "sourceId", "status",
             "example", "points", "valueType", "source", "subject"]

SELF_PHRASE_RE = re.compile(r"в\s+ответ\s+запишите", re.I)
WORD_RE = re.compile(r"[а-яА-ЯёЁa-zA-Z]")


def line_of_skill(skill_id: str) -> int:
    m = re.match(r"ob(\d+)_", skill_id)
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


def value_type_of(text: str, raw_answer: str) -> str:
    if WORD_RE.search((raw_answer or "").split("|")[0].strip()):
        return "слово"
    return classify(text, raw_answer or "")


def raw_pool(n: int) -> list[dict]:
    path = OUT_DIR / f"bio_oge_{n:02d}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def usable(raw: dict, part2: bool, n: int = 0) -> bool:
    """Годится ли сырое задание в банк (без рисунков, решаемое)."""
    if raw.get("has_figure") and str(raw.get("src_id")) not in APPROVED_SRC \
            and n not in RELAX_LINES:
        return False
    if FIG_RE.search(raw.get("condition") or ""):
        return False
    if part2:
        # Развёрнутый ответ: нужно непустое решение; машинного ответа нет.
        return bool((raw.get("solution") or "").strip())
    return bool((raw.get("answer") or "").strip())


def task_from_source(n: int, idx: int, raw: dict, skill: str) -> dict:
    part2 = n in PART2_LINES
    text = clean(raw["condition"])
    solution = (raw.get("solution") or "").strip()
    points = POINTS[n]
    if part2:
        if SELF_PHRASE_RE.search(text):
            raise ValueError(f"self-задание {raw['src_id']}: «в ответ запишите» в тексте")
        hint, hints = hints_from(solution)
        task = {
            "id": f"ob{n:02d}_p{idx}",
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
            "source": f"Решу ОГЭ (СДАМ ГИА), биология, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    else:
        alts = [x.strip().strip(".") for x in (raw["answer"] or "").split("|")
                if x.strip()]
        answer = alts[0] if alts else ""
        value_type = value_type_of(text, raw["answer"] or "")
        hint, hints = hints_from(solution)
        task = {
            "id": f"ob{n:02d}_p{idx}",
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
            "source": f"Решу ОГЭ (СДАМ ГИА), биология, задание №{n}, {raw['url']}",
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
    for n in range(1, 27):
        skill = skills[n]
        part2 = n in PART2_LINES
        pool = [r for r in raw_pool(n) if usable(r, part2, n)]
        picked = pool[:TARGET_PER_LINE]
        if skill in LOCKED_SKILLS:
            picked = []
        for i, r in enumerate(picked, 1):
            tasks.append(task_from_source(n, i, r, skill))
        summary.append((n, skill, len(picked), len(pool), len(raw_pool(n))))
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
            "desc": f"Все задания №{num} из банка биологии ОГЭ.",
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
        "title": "Биология (ОГЭ)",
        "status": "ready",
        "features": {"lessons": False, "practice": True, "forecast": True,
                     "diagnostics": True, "missions": True, "bosses": True,
                     "daily": True, "path": True},
        "description": "Биология ОГЭ: все 26 номеров экзамена — практика на реальных заданиях.",
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
    print(f"{'линия':6} {'skill':18} {'взято':10} годных   сырца")
    short = 0
    for n, skill, got, good, total in summary:
        flag = "OK " if got == TARGET_PER_LINE or skill in LOCKED_SKILLS else "!! "
        if got < TARGET_PER_LINE and skill not in LOCKED_SKILLS:
            short += 1
        print(f"{flag} №{n:<4} {skill:18} {got:>3}/{TARGET_PER_LINE}   "
              f"{good:>3}      {total:>3}")
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
