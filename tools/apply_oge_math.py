#!/usr/bin/env python3
"""Сборка банка математики ОГЭ по выгрузкам источника (tools/out/oge_NN.json).

Новый предмет (не добор): скрипт строит server/catalog_oge_math.json ЦЕЛИКОМ
из констант ниже + сырца tools/out/oge_*.json. Перезапуск детерминирован:
тот же сырец — тот же каталог. Ручная часть — только SKILLS (имена + 3 хинта
на тему, требует контракт реестра) и GOALS/DIAGNOSTIC.

Правила отбора (как в apply_basic.py, с поправкой на ОГЭ):
  * без настоящих рисунков: has_figure (чертёж/get_file) — в отсев;
  * формулы-картинки источника (has_formula) РАЗРЕШЕНЫ: парсер подменяет их
    словесным alt-текстом («дробь: числитель…»), задание решается по тексту.
    Прецедент — живой банк профиля (n14_* и др. с verbal-формулами).
  * текст ссылается на рисунок (FIG_RE) — в отсев, даже при images == 0;
  * часть 1 (№1–19): нужен непустой машинный ответ; часть 2 (№20–25):
    check "self" + type "extended_answer" (как часть 2 профиля), нужно
    непустое решение; фраза «в ответ запишите» в self-тексте запрещена
    (роняет install_catalog — проверяем здесь же);
  * цель — 100 заданий на открытую линию (TARGET_PER_LINE): сначала чистый
    текст (images == 0), потом с verbal-формулами; недостижимое честно
    капается пулом (см. TARGET_PER_LINE).

    python3 tools/apply_oge_math.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_oge_math.py             # записать server/catalog_oge_math.json
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
CATALOG = ROOT / "server" / "catalog_oge_math.json"
OUT_DIR = ROOT / "tools" / "out"

SUBJECT = "oge_math"
# Полный добор: 100 заданий на открытую тему. Честные капы (пулы источника
# исчерпаны, проходы с 0 новых зафиксированы): №1–5 — 7/2/3/2/1 (всё остальное
# блока с планом/схемой), №7 — ~33, №13 — ~31, №14 — ~41 (фигурные линии,
# текстовый выход низкий). №11/№18 — locked (без рисунка не решаются).
TARGET_PER_LINE = 100
PART2_LINES = set(range(20, 26))
# Линии, где чертёж источника — декорация: условие полностью в тексте
# (проверено чтением каждого кандидата: все числа и вопрос — в тексте,
# ссылок на рисунок в тексте нет). FIG_RE-отсев при этом сохраняется.
RELAX_LINES = {15, 16, 17}
# Точечно проверенные задания блока №1–5 (форматы бумаги): условие
# самодостаточно (таблица размеров — в тексте). Проверено вручную:
# 408268, 408272 (соответствие форматов по таблице), 408323 (масса пачки
# выводится из правила деления А0). Отклонены: 408303, 408334 (данные —
# в таблице соседнего задания варианта, отдельно не решаются).
APPROVED_SRC = {"408268", "408272", "408323"}
# Навыки без единого честного задания (графики №11 и решётка №18 без
# рисунка не решаются в принципе) — locked до figura-пайплайна, как
# russian_writing до публикации русского. Покрытие миссиями для них не
# требуется: needs_mission в subject-contract строится по выданным заданиям.
LOCKED_SKILLS = {"o11_functions", "o18_grid"}

# --- Ветки Пути -------------------------------------------------------------
CATEGORIES = [
    {"id": "oge_pract", "name": "Практико-ориентированные (№1–5)",
     "short": "Практика", "subject": SUBJECT},
    {"id": "oge_algebra", "name": "Алгебра (№6–14, 20–22)",
     "short": "Алгебра", "subject": SUBJECT},
    {"id": "oge_geometry", "name": "Геометрия (№15–19, 23–25)",
     "short": "Геометрия", "subject": SUBJECT},
]

# --- Темы: id, имя, ветка ----------------------------------------------------
# Имена линий — по каталогу Решу ОГЭ (math-oge.sdamgia.ru/prob_catalog).
SKILLS: list[tuple[str, str, str]] = [
    ("o01_pract", "№1 — Прикладные задачи", "oge_pract"),
    ("o02_pract", "№2 — Прикладные задачи", "oge_pract"),
    ("o03_pract", "№3 — Прикладные задачи", "oge_pract"),
    ("o04_pract", "№4 — Прикладные задачи", "oge_pract"),
    ("o05_pract", "№5 — Прикладные задачи", "oge_pract"),
    ("o06_numbers", "№6 — Числа и вычисления", "oge_algebra"),
    ("o07_numline", "№7 — Числовые неравенства, координатная прямая", "oge_algebra"),
    ("o08_expr", "№8 — Числа, вычисления и алгебраические выражения", "oge_algebra"),
    ("o09_equations", "№9 — Уравнения, системы уравнений", "oge_algebra"),
    ("o10_probability", "№10 — Статистика, вероятности", "oge_algebra"),
    ("o11_functions", "№11 — Графики функций", "oge_algebra"),
    ("o12_formulas", "№12 — Расчёты по формулам", "oge_algebra"),
    ("o13_inequalities", "№13 — Неравенства, системы неравенств", "oge_algebra"),
    ("o14_progressions", "№14 — Задачи на прогрессии", "oge_algebra"),
    ("o15_triangles", "№15 — Треугольники и их элементы", "oge_geometry"),
    ("o16_circle", "№16 — Окружность, круг и их элементы", "oge_geometry"),
    ("o17_quads", "№17 — Четырёхугольники и их элементы", "oge_geometry"),
    ("o18_grid", "№18 — Фигуры на квадратной решётке", "oge_geometry"),
    ("o19_statements", "№19 — Анализ геометрических высказываний", "oge_geometry"),
    ("o20_equations2", "№20 — Уравнения и неравенства (часть 2)", "oge_algebra"),
    ("o21_wordprob", "№21 — Текстовые задачи (часть 2)", "oge_algebra"),
    ("o22_functions2", "№22 — Графики функций (часть 2)", "oge_algebra"),
    ("o23_geocalc", "№23 — Геометрические задачи на вычисление", "oge_geometry"),
    ("o24_geoproof", "№24 — Геометрические задачи на доказательство", "oge_geometry"),
    ("o25_geohard", "№25 — Геометрия повышенной сложности", "oge_geometry"),
]

# --- Подсказки темы: ровно 3 непустые строки (требует контракт реестра) ------
HINTS: dict[str, list[str]] = {
    "o01_pract": [
        "Сначала выпиши все числа из описания: размеры, тарифы, расход — каждый вопрос №1–5 берёт свои.",
        "Вопросы идут по одному тексту: перечитай описание целиком, даже если вопрос кажется отдельным.",
        "Сверяй единицы: метры и сантиметры, рубли и тысячи рублей — половина ошибок здесь.",
    ],
    "o02_pract": [
        "Это тот же текст, что в №1: данные уже выписаны — ищи нужные для нового вопроса.",
        "Рисуй схему: участок, дом, дорожки — по рисунку видно, что считать.",
        "Ответ — число без единиц измерения: их в бланк не пишут.",
    ],
    "o03_pract": [
        "Работай с таблицей тарифов или размеров из текста: закрой лишние столбцы и читай только нужный.",
        "Если в вопросе «на сколько больше или меньше» — считай оба варианта и вычитай.",
        "Проверь масштаб: клетки на плане — это метры, а не сантиметры.",
    ],
    "o04_pract": [
        "Формула уже дана в тексте или справочных материалах — подставь числа аккуратно.",
        "Считай по действиям и записывай промежуточные результаты: ошибка обычно в одном из них.",
        "Округляй только в самом конце: промежуточное округление портит ответ.",
    ],
    "o05_pract": [
        "Последний вопрос блока — самый составной: разбей его на 2–3 шага из предыдущих номеров.",
        "Если спрашивают самый выгодный вариант — посчитай все и сравни.",
        "Перечитай вопрос после решения: убедись, что ответил именно на него, а не на соседний.",
    ],
    "o06_numbers": [
        "Расставь порядок действий: сначала умножение и деление, потом сложение и вычитание.",
        "Десятичные дроби считай столбиком или переводи в обыкновенные — как удобнее.",
        "Знак минус: «минус на минус даёт плюс» — проверь каждый знак отдельно.",
    ],
    "o07_numline": [
        "Отметь числа на прямой примерно: отрицательные слева от нуля, дроби — между целыми.",
        "Сравнивай попарно: сначала найди самое маленькое, потом следующее.",
        "Квадрат числа больше самого числа, только если число больше 1 или отрицательно, — проверь.",
    ],
    "o08_expr": [
        "Степени с одинаковым основанием: при умножении показатели складываются, при делении — вычитаются.",
        "Корень — это степень одна вторая: переведи всё в степени и считай.",
        "Сначала упрости выражение, потом подставляй числа.",
    ],
    "o09_equations": [
        "Перенеси всё с иксом влево, числа — вправо, меняя знаки.",
        "Квадратное уравнение: считай дискриминант, не гадай корни.",
        "Если просят меньший или больший корень — реши полностью и выбери.",
    ],
    "o10_probability": [
        "Вероятность — это подходящие исходы делить на все возможные.",
        "«Хотя бы один» удобно считать через дополнение: единица минус вероятность противоположного.",
        "Прочитай, что именно спрашивают: часто путают «красный» и «не красный».",
    ],
    "o11_functions": [
        "Определи тип графика: прямая (линейная функция), парабола (квадрат), гипербола (обратная пропорциональность).",
        "Коэффициенты читаются с графика: наклон, сдвиг вверх или вниз, пересечения с осями.",
        "Сопоставляй по одной особенности за раз — исключи два заведомо чужих варианта.",
    ],
    "o12_formulas": [
        "Выпиши формулу из условия и подчеркни величину, которую ищешь.",
        "Подставляй числа с их знаками и степенями десятки.",
        "Если величина в знаменателе — сначала вырази её, потом подставляй.",
    ],
    "o13_inequalities": [
        "Решай как уравнение, но помни: при делении на отрицательное число знак переворачивается.",
        "Квадратное неравенство: найди корни и посмотри знак между ними.",
        "Система: реши каждое по отдельности и возьми пересечение.",
    ],
    "o14_progressions": [
        "Определи тип: разность постоянна — арифметическая прогрессия, частное постоянно — геометрическая.",
        "Формула n-го члена: aₙ = a₁ + d(n−1) — распиши её для своих чисел.",
        "Сумма: Sₙ = (a₁ + aₙ)·n/2 — не складывай вручную десять членов.",
    ],
    "o15_triangles": [
        "Сумма углов треугольника — 180 градусов: это решает половину задач.",
        "Равнобедренный: углы при основании равны; прямоугольный: теорема Пифагора и угол 30 градусов.",
        "Выпиши, что дано, прямо на чертеже: искомый угол обычно смежный или вертикальный с данным.",
    ],
    "o16_circle": [
        "Вписанный угол — половина центрального, опирающегося на ту же дугу.",
        "Касательная перпендикулярна радиусу в точке касания — ищи прямоугольный треугольник.",
        "Вписанный угол, опирающийся на диаметр, — прямой.",
    ],
    "o17_quads": [
        "Параллелограмм: противоположные стороны и углы равны, диагонали делятся пополам.",
        "Площадь: основание умножить на высоту; для ромба — половина произведения диагоналей.",
        "Трапеция: проведи две высоты — получишь прямоугольник и два треугольника.",
    ],
    "o18_grid": [
        "Считай по клеткам: катет — разность координат, гипотенуза — по теореме Пифагора.",
        "Площадь фигуры на решётке: дострой до прямоугольника и вычти лишние треугольники.",
        "Тангенс угла — отношение противолежащего катета к прилежащему: найди прямоугольный треугольник.",
    ],
    "o19_statements": [
        "Проверяй каждое утверждение отдельно: одно неверное слово — всё утверждение ложно.",
        "Вспомни точные формулировки: «все», «любой», «существует» — самые частые ловушки.",
        "Сомневаешься — нарисуй пример и контрпример.",
    ],
    "o20_equations2": [
        "Упрости выражение или уравнение до простейшего вида, потом решай.",
        "Замена переменной превращает громоздкое уравнение в квадратное.",
        "Запиши ответ полностью и проверь подстановкой: развёрнутое решение оценивается по критериям.",
    ],
    "o21_wordprob": [
        "Обозначь неизвестное иксом и составь уравнение по условию — это большая часть решения.",
        "Таблица «скорость — время — путь» или «производительность — время — работа» держит все связи.",
        "Проверь ответ на реалистичность и запиши решение по шагам: критерии дают баллы за ход.",
    ],
    "o22_functions2": [
        "Построй график по точкам: вершина параболы, асимптоты гиперболы, точки излома.",
        "Прямую y = m двигай снизу вверх и считай пересечения.",
        "Кусочную функцию строй по частям, точки стыка проверяй отдельно.",
    ],
    "o23_geocalc": [
        "Сделай большой чертёж и отметь всё данное: решение обычно в одном-двух дополнительных построениях.",
        "Ищи подобные треугольники или теорему Пифагора: почти все вычисления сводятся к ним.",
        "Запиши «дано — найти — решение»: за оформленный ход дают баллы даже при арифметической ошибке.",
    ],
    "o24_geoproof": [
        "Выпиши, что дано и что доказать: доказательство строится от конца.",
        "Признаки равенства и подобия треугольников — главный инструмент: найди пару.",
        "Каждое утверждение подкрепляй теоремой: «по двум углам», «как вертикальные».",
    ],
    "o25_geohard": [
        "Разбей задачу на леммы: докажи промежуточный факт и ссылайся на него.",
        "Дополнительные построения (параллельная, высота, описанная окружность) открывают задачу.",
        "Если застрял — иди от ответа: что нужно для него, чего не хватает.",
    ],
}

GOALS = [
    {"id": "g3", "label": "Оценка 3",
     "desc": "8+ баллов (из них ≥2 по геометрии) — аттестат"},
    {"id": "g4", "label": "Оценка 4",
     "desc": "15+ баллов (из них ≥2 по геометрии) — уверенный результат"},
    {"id": "g5", "label": "Оценка 5",
     "desc": "22+ баллов (из них ≥2 по геометрии) — максимум ОГЭ"},
]

# Диагностика: по одному заданию из representative-линий (все — часть 1,
# self-заданий в диагностике нет: там поле ввода с автопроверкой; линии 11
# и 18 locked — вместо них 7 и 12).
DIAGNOSTIC_LINES = [1, 6, 7, 9, 10, 12, 13, 15, 19]

DAILY = {"skill": "o06_numbers", "target": 5, "xp": 50,
         "title": "Ежедневная подборка заданий ОГЭ"}

BOSSES = [
    {"id": "boss-oge-pract", "cat": "oge_pract",
     "title": "БОСС: Практико-ориентированные задачи",
     "desc": "Смешанные задания №1–5 из банка математики ОГЭ.",
     "size": 6, "xp": 300, "unlockAt": 25},
    {"id": "boss-oge-algebra", "cat": "oge_algebra",
     "title": "БОСС: Алгебра",
     "desc": "Смешанные задания алгебры из банка математики ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-geometry", "cat": "oge_geometry",
     "title": "БОСС: Геометрия",
     "desc": "Смешанные задания геометрии из банка математики ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
]

KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint",
             "hints", "solution", "type", "check", "sourceId", "status",
             "example", "points", "valueType", "source", "subject"]

SELF_PHRASE_RE = re.compile(r"в\s+ответ\s+запишите", re.I)


def line_of_skill(skill_id: str) -> int:
    m = re.match(r"o(\d+)_", skill_id)
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


def raw_pool(n: int) -> list[dict]:
    path = OUT_DIR / f"oge_{n:02d}.json"
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
    if part2:
        if SELF_PHRASE_RE.search(text):
            raise ValueError(f"self-задание {raw['src_id']}: «в ответ запишите» в тексте")
        hint, hints = hints_from(solution)
        task = {
            "id": f"o{n:02d}_p{idx}",
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
            "points": 2,
            # Как у большинства self-заданий профиля: поле ввода у таких
            # заданий отсутствует, значение инертно, но пусть будет канон.
            "valueType": "общее решение + список",
            "source": f"Решу ОГЭ (СДАМ ГИА), математика, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    else:
        alts = [x.strip().strip(".") for x in (raw["answer"] or "").split("|")
                if x.strip()]
        answer = alts[0] if alts else ""
        value_type = classify(text, raw["answer"] or "")
        hint, hints = hints_from(solution)
        task = {
            "id": f"o{n:02d}_p{idx}",
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
            "points": 1,
            "valueType": value_type,
            "source": f"Решу ОГЭ (СДАМ ГИА), математика, задание №{n}, {raw['url']}",
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
    for n in range(1, 26):
        skill = skills[n]
        part2 = n in PART2_LINES
        pool = [r for r in raw_pool(n) if usable(r, part2, n)]
        pure = [r for r in pool if not r.get("images")]
        verbal = [r for r in pool if r.get("images")]
        picked = (pure + verbal)[:TARGET_PER_LINE]
        for i, r in enumerate(picked, 1):
            tasks.append(task_from_source(n, i, r, skill))
        summary.append((n, skill, len(picked), len(pure), len(verbal),
                        len(raw_pool(n))))
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
            "desc": f"Все задания №{num} из банка математики ОГЭ.",
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
        "title": "Математика (ОГЭ)",
        "status": "ready",
        "features": {"lessons": False, "practice": True, "forecast": True,
                     "diagnostics": True, "missions": True, "bosses": True,
                     "daily": True, "path": True},
        "description": "Математика ОГЭ: все 25 номеров экзамена — практика на реальных заданиях.",
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
    print(f"{'линия':6} {'skill':18} {'взято':6} чистых  с формулами  сырца")
    short = 0
    for n, skill, got, pure, verbal, total in summary:
        flag = "OK " if got == TARGET_PER_LINE else "!! "
        if got < TARGET_PER_LINE:
            short += 1
        print(f"{flag} №{n:<4} {skill:18} {got:>2}/{TARGET_PER_LINE}   "
              f"{pure:>3}     {verbal:>3}        {total:>3}")
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
