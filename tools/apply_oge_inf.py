#!/usr/bin/env python3
"""Сборка банка информатики ОГЭ по выгрузкам источника (tools/out/inf_oge_NN.json).

Новый предмет (не добор): скрипт строит server/catalog_oge_informatics.json
ЦЕЛИКОМ из констант ниже + сырца tools/out/inf_oge_*.json. Перезапуск
детерминирован: тот же сырец — тот же каталог. Ручная часть — только SKILLS
(имена + 3 хинта на тему, требует контракт реестра) и GOALS/DIAGNOSTIC.

Правила отбора (как в apply_oge_math.py, с поправкой на информатику):
  * без настоящих рисунков: has_figure — в отсев;
  * формулы-картинки источника (has_formula) РАЗРЕШЕНЫ: парсер подменяет их
    словесным alt-текстом, задание решается по тексту (прецедент — живой
    банк профиля и oge_math);
  * текст ссылается на рисунок (FIG_RE) — в отсев, даже при images == 0;
  * нужен непустой машинный ответ (все открытые линии — краткий ответ,
    часть с компьютером в банк не идёт);
  * линии №9 (схемы дорог — все 23 пробы с рисунком), №11–12 (поиск и подсчёт
    файлов в каталогах DEMO — нужен компьютер) и №13–16 (создание
    презентации/документа, электронные таблицы, Робот, программирование —
    машинного ответа нет, нужен компьютер) — locked: без компьютера и файлов
    не решаются в принципе. Покрытие миссиями для них не требуется:
    needs_mission в subject-contract строится по выданным заданиям;
  * цель — 100 заданий на линию; честные капы второй волны (пулы СДАМ ГИА
    исчерпаны: проходы 12 + доборы, дальше +1–2 задания за 4 прохода):
    №1 — 44, №2 — 94, №3 — 43, №4 — 82, №5 — 39, №6 — 48, №7 — 60,
    №8 — 57, №10 — 34; минус SKIP_SRC (волна 3): итого в банке 520:
    №3 — 17, №6 — 27, №7 — 59. Берём весь годный пул целиком
    (pure-текст, затем verbal-формулы);
  * сортировка заданий естественная (p1, p2, …, p10, а не строки):
    миссии берут первые 3 id темы (p1–p3);
  * ответы-цифровые коды (трассы исполнителя, порядок фрагментов адреса)
    проверяются строго по порядку: тексты с формулировками мультивыбора
    (DIGIT_SET_TASK_RE в js/state.js) для таких ответов — в отсев
    (проверено: в пуле таких нет, assert ниже это сторожит).

    python3 tools/apply_oge_inf.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_oge_inf.py             # записать server/catalog_oge_informatics.json
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
CATALOG = ROOT / "server" / "catalog_oge_informatics.json"
OUT_DIR = ROOT / "tools" / "out"

SUBJECT = "oge_informatics"
TARGET_PER_LINE = 100
# Открытые линии: краткий ответ без компьютера. Остальные — locked
# (см. LOCKED_SKILLS): компьютер/файлы нужны в принципе.
OPEN_LINES = (1, 2, 3, 4, 5, 6, 7, 8, 10)
# Навыки без единого честного задания — locked до компьютерного практикума:
# №9 — схемы дорог только рисунком (23/23 проб с has_figure и FIG_RE),
# №11–12 — поиск/подсчёт файлов в каталогах (нужен компьютер),
# №13–16 — создание файлов: презентация/документ, таблицы, Робот,
# программирование (машинного ответа нет, нужен компьютер).
LOCKED_SKILLS = {"oi09_graphs", "oi11_filesearch", "oi12_filecount",
                 "oi13_office", "oi14_spreadsheet", "oi15_robot",
                 "oi16_coding"}

# --- Отсев битого импорта (волна 3, аудит) ------------------------------------
# Общий парсер (tools/sdamgia_import.py: strip_markup, r"<[^>]+>") выедает
# ASCII-сравнения вида "< N" вместе с "тегом": условие теряет порог
# ("НЕ (X <= 7) И (X < 20)" -> "НЕ (X И (X", сверено с оригиналом №10637),
# задание нерешаемо. Правится только отбором здесь (общий файл — не наш):
# ниже src_id заданий с усечённым условием (oi03: голый X/Число без
# предиката; oi06: оборванные "если s"/"if s"; плюс точный дубль oi07
# sdamgia-1088 = sdamgia-718). Проверено чтением всех 43 текстов oi03
# и всех 48 текстов oi06 целиком.
SKIP_SRC = {
    "10463", "10464", "10466", "10467", "10635", "10636", "10637",
    "10638", "10639", "10640", "10642", "10872", "10873", "10874",
    "10876", "10877", "1088", "10891", "10892", "10950", "10951",
    "10953", "10954", "10955", "16011", "18174", "18186", "18189",
    "18245", "18257", "18290", "37188", "37189", "37236", "37256",
    "37271", "37468", "37483", "37513", "42026", "42053", "43522",
    "43580", "43596", "43684", "43706", "43768", "47704",
}

# --- Ветки Пути -------------------------------------------------------------
CATEGORIES = [
    {"id": "oge_inf_info", "name": "Данные и кодирование (№1, 2, 10)",
     "short": "Данные", "subject": SUBJECT},
    {"id": "oge_inf_models", "name": "Модели, сети и логика (№3, 4, 7, 8)",
     "short": "Модели", "subject": SUBJECT},
    {"id": "oge_inf_algo", "name": "Алгоритмы и программы (№5, 6)",
     "short": "Алгоритмы", "subject": SUBJECT},
]

# --- Темы: id, имя, ветка ----------------------------------------------------
# Имена линий — по каталогу Решу ОГЭ (inf-oge.sdamgia.ru/prob_catalog)
# и плану КИМ ФИПИ (демоверсия/спецификация ОГЭ-2025 по информатике).
SKILLS: list[tuple[str, str, str]] = [
    ("oi01_memory", "№1 — Объём памяти для текстовых данных", "oge_inf_info"),
    ("oi02_decode", "№2 — Декодирование кодовой последовательности", "oge_inf_info"),
    ("oi03_logic", "№3 — Истинность составного высказывания", "oge_inf_models"),
    ("oi04_models", "№4 — Формальные описания: таблицы", "oge_inf_models"),
    ("oi05_executor", "№5 — Простой алгоритм для исполнителя", "oge_inf_algo"),
    ("oi06_program", "№6 — Программы с условным оператором", "oge_inf_algo"),
    ("oi07_network", "№7 — Адресация в сети Интернет", "oge_inf_models"),
    ("oi08_queries", "№8 — Поисковые запросы и логика", "oge_inf_models"),
    ("oi09_graphs", "№9 — Схемы дорог: пути между городами", "oge_inf_models"),
    ("oi10_numsys", "№10 — Системы счисления", "oge_inf_info"),
    ("oi11_filesearch", "№11 — Поиск информации в файлах", "oge_inf_info"),
    ("oi12_filecount", "№12 — Файлы по условию", "oge_inf_info"),
    ("oi13_office", "№13 — Презентация или текстовый документ", "oge_inf_algo"),
    ("oi14_spreadsheet", "№14 — Электронные таблицы", "oge_inf_models"),
    ("oi15_robot", "№15 — Алгоритм для исполнителя", "oge_inf_algo"),
    ("oi16_coding", "№16 — Программирование", "oge_inf_algo"),
]

# --- Подсказки темы: ровно 3 непустые строки (требует контракт реестра) ------
HINTS: dict[str, list[str]] = {
    "oi01_memory": [
        "Объём текста — это число символов умножить на вес одного символа: для Unicode обычно 16 бит (2 байта), для КОИ-8 — 8 бит (1 байт).",
        "Пробелы — тоже символы: считай весь текст целиком, включая пробелы и знаки препинания.",
        "Переведи итог в нужные единицы: биты дели на 8 для байтов, байты — на 1024 для килобайтов.",
    ],
    "oi02_decode": [
        "Выпиши код каждого символа из таблицы и разбей цепочку слева направо.",
        "Если цепочка не бьётся — проверь таблицу: часто путают похожие коды.",
        "Декодируй до конца и перечитай слово: осмысленное слово — признак верной разбивки.",
    ],
    "oi03_logic": [
        "Подставь кандидата в каждое простое условие отдельно и отметь, какие истинны.",
        "Составное высказывание разбирай по связкам: «и» требует всех истинных, «или» — хотя бы одного.",
        "Отрицание переворачивает результат: сначала посчитай без «не», потом инвертируй.",
    ],
    "oi04_models": [
        "Перепиши таблицу в виде списка связей: кто с кем соединён и какой ценой.",
        "Ищи кратчайший путь перебором от старта: отбрасывай ветки, уже длиннее найденного.",
        "Проверь направление движения: путь туда и обратно может отличаться.",
    ],
    "oi05_executor": [
        "Выполни программу на бумаге шаг за шагом: заведи столбик «число на экране» после каждой команды.",
        "Неизвестный параметр (b) — это икс: составь уравнение по итогам трассировки и реши его.",
        "«Зачеркни справа» — это целочисленное деление на 10: остаток отбрасывается.",
    ],
    "oi06_program": [
        "Прочитай условие как математику: OR — «или», AND — «и», иначе — во всех остальных случаях.",
        "Прогони каждую пару входных чисел через условие отдельно и считай срабатывания.",
        "Кавычки и регистр в выводе на подсчёт не влияют — важен только факт срабатывания.",
    ],
    "oi07_network": [
        "Разбери адрес на части: протокол, сервер, файл — каждый фрагмент встаёт на своё место.",
        "Собери адрес по шаблону: протокол, разделитель, сервер, разделитель, файл.",
        "IP-адрес — четыре числа от 0 до 255 через точки: склейка идёт по порядку октетов.",
    ],
    "oi08_queries": [
        "Обозначь каждое слово множеством страниц и нарисуй круги Эйлера: пересечение — это «и».",
        "Чем больше слов через «и», тем меньше страниц: запрос уже — результат меньше.",
        "Вырази неизвестный запрос через известные: сложи и вычти круги по формуле включений-исключений.",
    ],
    "oi09_graphs": [
        "Выпиши все дороги из схемы в таблицу смежности: города — строки и столбцы, длины — ячейки.",
        "Считай длину каждого маршрута от старта до финиша и сравни.",
        "Проверяй условие прохода через пункт: сначала отсей маршруты мимо него, потом считай.",
    ],
    "oi10_numsys": [
        "Перевод в десятичную: распиши число по разрядам и умножь каждую цифру на основание в степени позиции.",
        "Двоичное в восьмеричное и шестнадцатеричное — триадами и тетрадами от младшего разряда.",
        "Сумма цифр считается уже в новой системе: сначала переведи число, потом складывай цифры.",
    ],
    "oi11_filesearch": [
        "Ищи по каталогам средствами системы: маска имени и расширение задают отбор.",
        "Ключевая фраза ищется внутри файлов: открой найденное и проверь контекст.",
        "Ответ перепиши точно, без лишних пробелов.",
    ],
    "oi12_filecount": [
        "Отбор идёт сразу по двум признакам: расширение и размер — проверь оба.",
        "Считай только файлы в указанных подкаталогах, корень каталога не трогай.",
        "Информационный объём считай по фактическим размерам отобранных файлов.",
    ],
    "oi13_office": [
        "Каждый слайд отвечает на свой подпункт темы и имеет заголовок.",
        "Единый стиль: один шрифт, один фон, одинаковое оформление заголовков на всех слайдах.",
        "Иллюстрации — из выданного каталога: на каждом слайде должны быть и текст, и изображения.",
    ],
    "oi14_spreadsheet": [
        "Сначала отсортируй или отфильтруй таблицу по условию — дальше считай по видимым строкам.",
        "Встроенные функции суммы, среднего и условия решают большинство пунктов без ручного подсчёта.",
        "Диаграмма строится по итоговым числам, а не по всей таблице.",
    ],
    "oi15_robot": [
        "Разметь лабиринт на бумаге: стены, закрашиваемые клетки, старт Робота.",
        "Цикл «пока» крутится до упора: проверь условие выхода на каждом шаге трассировки.",
        "Ветвление проверяет стены вокруг: распиши все четыре направления перед выбором.",
    ],
    "oi16_coding": [
        "Прочитай входной формат: первое число — количество, дальше — сама последовательность.",
        "Держи один максимум-кандидат и обновляй его в цикле — массив хранить не нужно.",
        "Проверь программу на примере из условия и на границе.",
    ],
}

GOALS = [
    {"id": "g3", "label": "Оценка 3",
     "desc": "5+ баллов — аттестат"},
    {"id": "g4", "label": "Оценка 4",
     "desc": "11+ баллов — уверенный результат"},
    {"id": "g5", "label": "Оценка 5",
     "desc": "17+ баллов — отличный результат"},
]

# Диагностика: по одному заданию из representative-линий (все — краткий
# ответ с автопроверкой: в диагностике поле ввода, self-заданий там нет).
DIAGNOSTIC_LINES = [1, 2, 4, 5, 6, 7, 8, 10]

DAILY = {"skill": "oi01_memory", "target": 5, "xp": 50,
         "title": "Ежедневная подборка заданий ОГЭ"}

BOSSES = [
    {"id": "boss-oge-inf-data", "cat": "oge_inf_info",
     "title": "БОСС: Данные и кодирование",
     "desc": "Смешанные задания о данных и кодировании из банка информатики ОГЭ.",
     "size": 6, "xp": 300, "unlockAt": 25},
    {"id": "boss-oge-inf-models", "cat": "oge_inf_models",
     "title": "БОСС: Модели и логика",
     "desc": "Смешанные задания о моделях, сетях и логике из банка информатики ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-inf-algo", "cat": "oge_inf_algo",
     "title": "БОСС: Алгоритмы",
     "desc": "Смешанные задания об алгоритмах и программах из банка информатики ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
]

KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint",
             "hints", "solution", "type", "check", "sourceId", "status",
             "example", "points", "valueType", "source", "subject"]

# Формулировки мультивыбора (js/state.js: DIGIT_SET_TASK_RE): цифровой ответ
# на такой текст сверялся бы как множество без порядка — для трасс
# исполнителя и порядка фрагментов адреса порядок смысловой, поэтому
# такие задания в банк не берём (в текущем пуле их нет — assert сторожит).
DIGIT_SET_RE = re.compile(
    r"под\s+котор\S*\s+(?:они\s+)?указан|(?:запишите|укажите)\s+в\s+ответ\s+"
    r"(?:цифр|номера)|укажите\s+(?:все\s+)?цифр|на\s+месте\s+котор\S*\s+"
    r"(?:пишется|должн)|(?:выберите|выпишите)\s+(?:верные|правильные|все)?\s*"
    r"(?:суждени|утверждени|варианты|номера|ответы|признаки|позиции|термины)|"
    r"(?:найдите|укажите)\s+в\s+(?:приведён|приведен|данн|указанн)\S*\s*"
    r"(?:ниже\s*)?(?:списке|перечне)|(?:запишите|укажите|выпишите|напишите)\s+"
    r"(?:их\s+)?номера|напишите\s+номер|(?:один\s+)?набор\s+номеров", re.I)
DIGIT_CODE_RE = re.compile(r"^\d{2,12}$")

WORD_RE = re.compile(r"[a-zA-Zа-яёА-ЯЁ]")


def natural_key(task: dict) -> tuple:
    """Естественный порядок id вида oiNN_pM: p1, p2, …, p10 (не строки)."""
    m = re.match(r"^(.*?)(\d+)$", str(task.get("id") or ""))
    if not m:
        return (str(task.get("id") or ""), 0)
    return (m.group(1), int(m.group(2)))


def line_of_skill(skill_id: str) -> int:
    m = re.match(r"oi(\d+)_", skill_id)
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


def classify_inf(text: str, raw_answer: str) -> str:
    """valueType как в apply_basic, но словесные ответы — «слово»
    (прецедент — живой банк русского), а не «целое число» по умолчанию."""
    value_type = classify(text, raw_answer)
    if value_type == "целое число":
        alts = [x.strip() for x in raw_answer.split("|") if x.strip()]
        if alts and WORD_RE.search(alts[0]):
            return "слово"
    return value_type


def raw_pool(n: int) -> list[dict]:
    path = OUT_DIR / f"inf_oge_{n:02d}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def usable(raw: dict) -> bool:
    """Годится ли сырое задание в банк (текст, самодостаточное)."""
    if str(raw.get("src_id")) in SKIP_SRC:
        return False
    if raw.get("has_figure"):
        return False
    if FIG_RE.search(raw.get("condition") or ""):
        return False
    if not (raw.get("answer") or "").strip():
        return False
    return True


def task_from_source(n: int, idx: int, raw: dict, skill: str) -> dict:
    alts = [x.strip().strip(".") for x in (raw["answer"] or "").split("|")
            if x.strip()]
    answer = alts[0] if alts else ""
    assert answer, raw.get("src_id")
    if DIGIT_CODE_RE.fullmatch(answer):
        assert not DIGIT_SET_RE.search(raw.get("condition") or ""), \
            f"цифровой код с формулировкой мультивыбора: {raw['src_id']}"
    text = clean(raw["condition"])
    value_type = classify_inf(text, raw["answer"] or "")
    hint, hints = hints_from(raw.get("solution") or "")
    task = {
        "id": f"oi{n:02d}_p{idx}",
        "skill": skill,
        "sub": sub_from(text),
        "num": f"№{n}",
        "diff": 1,
        "text": text,
        "answer": answer,
        "hint": hint,
        "hints": hints,
        "solution": raw.get("solution") or "",
        "type": "short_answer",
        "sourceId": f"sdamgia-{raw['src_id']}",
        "status": "sdamgia",
        "example": idx,
        "points": 1,
        "valueType": value_type,
        "source": f"Решу ОГЭ (СДАМ ГИА), информатика, задание №{n}, {raw['url']}",
        "subject": SUBJECT,
    }
    out = {k: task[k] for k in KEY_ORDER if k in task}
    if len(alts) > 1:
        out["accept"] = alts
    return out


def build_tasks() -> tuple[list[dict], list[tuple]]:
    skills = skill_by_line()
    tasks: list[dict] = []
    summary = []
    for n in OPEN_LINES:
        skill = skills[n]
        pool = [r for r in raw_pool(n) if usable(r)]
        pure = [r for r in pool if not r.get("images")]
        verbal = [r for r in pool if r.get("images")]
        picked = (pure + verbal)[:TARGET_PER_LINE]
        for i, r in enumerate(picked, 1):
            tasks.append(task_from_source(n, i, r, skill))
        summary.append((n, skill, len(picked), len(pure), len(verbal),
                        len(raw_pool(n))))
    tasks.sort(key=lambda t: (t.get("skill") or "", natural_key(t)))
    return tasks, summary


def build_missions(tasks: list[dict]) -> list[dict]:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    missions = []
    for sid, name, _cat in SKILLS:
        if sid in LOCKED_SKILLS:
            continue
        group = sorted(by_skill.get(sid, []), key=natural_key)
        assert group, f"нет заданий для миссии {sid}"
        num = line_of_skill(sid)
        missions.append({
            "id": f"m-{sid}",
            "skill": sid,
            "title": f"Практика: {name}",
            "desc": f"Все задания №{num} из банка информатики ОГЭ.",
            "tasks": [t["id"] for t in group[:3]],
            "xp": 40,
            "diff": 1,
        })
    return missions


def build_catalog(tasks: list[dict]) -> dict:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    diagnostic = []
    for n in DIAGNOSTIC_LINES:
        sid = skill_by_line()[n]
        group = sorted(by_skill.get(sid, []), key=natural_key)
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
        "title": "Информатика (ОГЭ)",
        "status": "ready",
        "features": {"lessons": False, "practice": True, "forecast": True,
                     "diagnostics": True, "missions": True, "bosses": True,
                     "daily": True, "path": True},
        "description": "Информатика ОГЭ: задания №1–8 и №10 с кратким ответом — практика на реальных заданиях.",
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
