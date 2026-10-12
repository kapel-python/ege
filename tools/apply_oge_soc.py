#!/usr/bin/env python3
"""Сборка банка обществознания ОГЭ по выгрузкам источника (tools/out/soc_oge_NN.json).

Новый предмет (не добор): скрипт строит server/catalog_oge_society.json ЦЕЛИКОМ
из констант ниже + сырца tools/out/soc_oge_*.json. Перезапуск детерминирован:
тот же сырец — тот же каталог. Ручная часть — только SKILLS (имена + 3 хинта
на тему, требует контракт реестра) и GOALS/DIAGNOSTIC.

Причуда источника (проверена маппингом prob1..prob20, см. отчёт): генератор
наборов soc-oge.sdamgia.ru принимает prob{N}, но отдаёт задания Типа f(N),
где f = {1:2, 2:3, 3:4, 4:5, 5:6, 6:9, 7:10, 8:11, 9:13, 10:14, 11:15,
12:16, 13:1, 14:7, 15:8, 16:12, 17:17, 18:18, 19:19, 20:20}; prob21+ пусты.
Файлы сырца ПЕРЕИМЕНОВАНЫ по номеру Типа (содержимому), поэтому raw_pool(n)
читает задания Типа n. Навыки и «№N» именуются по Типам каталога источника
(https://soc-oge.sdamgia.ru/prob_catalog), что для большинства линий
совпадает с нумерацией заданий демоверсии ФИПИ.

Правила отбора (как в apply_oge_math.py, с поправкой на обществознание):
  * без настоящих рисунков: has_figure — в отсев (фото Типа 7 и диаграммы
    Типа 12 без рисунка не решаются в принципе);
  * текст ссылается на рисунок (FIG_RE) — в отсев, даже при images == 0;
  * короткие ответы (непустой машинный ответ источника): short_answer,
    points 1;
  * развёрнутые ответы (пустой ответ + непустое решение с критериями):
    extended_answer + check "self", points 2; экзаменатурный хвост «Ответ
    запишите на бланке…» вырезается, остаток фразы «ответ запишите»
    в self-тексте запрещён (роняет install_catalog и аудит — проверяем
    здесь же);
  * цель второй волны — 100 заданий на линию: берём все годные (чистые
    тексты + verbal-формулы); где пул источника исчерпан — честный кап
    с цифрами (пул/годные после 12 проходов импортёра, см. отчёт).

    python3 tools/apply_oge_soc.py --analyze   # сводка по линиям, ничего не пишет
    python3 tools/apply_oge_soc.py             # записать server/catalog_oge_society.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from apply_basic import (  # переиспользуем чистку/подсказки базы
    FIG_RE,
    clean,
    sub_from,
)

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "server" / "catalog_oge_society.json"
OUT_DIR = ROOT / "tools" / "out"

SUBJECT = "oge_society"
TARGET_PER_LINE = 100
# Линии с развёрнутым ответом (пустой машинный ответ, решение с критериями):
# №1 (понятия), №7 (фото — только с рисунком, добирает figures-скрипт),
# №8 (финансы), №12 (статистика), №17–20 (текстовый блок).
EXT_TIPS = {1, 7, 8, 12, 17, 18, 19, 20}
# Навык без единого честного задания (все задания Типа 7 — анализ фото):
# locked, как o11/o18 у oge_math. Покрытие миссиями для него не требуется:
# needs_mission в subject-contract строится по выданным заданиям.
LOCKED_SKILLS = {"os07_photo"}

# --- Ветки Пути -------------------------------------------------------------
CATEGORIES = [
    {"id": "oss_person", "name": "Человек, общество, культура (№1–5)",
     "short": "Человек", "subject": SUBJECT},
    {"id": "oss_spheres", "name": "Социальная сфера и экономика (№6–10, 12)",
     "short": "Сферы", "subject": SUBJECT},
    {"id": "oss_polaw", "name": "Политика и право (№11, 13–16)",
     "short": "Политика и право", "subject": SUBJECT},
    {"id": "oss_text", "name": "Развёрнутые ответы по тексту (№17–20)",
     "short": "Текст", "subject": SUBJECT},
]

# --- Темы: id, имя, ветка ----------------------------------------------------
# Имена линий — по каталогу Решу ОГЭ (soc-oge.sdamgia.ru/prob_catalog).
SKILLS: list[tuple[str, str, str]] = [
    ("os01_concepts", "№1 — Раскрытие смысла понятий", "oss_person"),
    ("os02_table", "№2 — Понятие и его элементы: таблица", "oss_person"),
    ("os03_compare", "№3 — Сравнение", "oss_person"),
    ("os04_culture", "№4 — Духовная культура и наука", "oss_person"),
    ("os05_man", "№5 — Общество и человек", "oss_person"),
    ("os06_social", "№6 — Социальная сфера: анализ суждений", "oss_spheres"),
    ("os07_photo", "№7 — Социальная информация по фотоизображению", "oss_spheres"),
    ("os08_finance", "№8 — Финансовая грамотность", "oss_spheres"),
    ("os09_agents", "№9 — Функции и субъекты деятельности", "oss_spheres"),
    ("os10_econ", "№10 — Экономическая сфера: анализ суждений", "oss_spheres"),
    ("os11_politics", "№11 — Сфера политики", "oss_polaw"),
    ("os12_stats", "№12 — Анализ статистической информации", "oss_spheres"),
    ("os13_law", "№13 — Право и правонарушения", "oss_polaw"),
    ("os14_match", "№14 — Установление соответствия", "oss_polaw"),
    ("os15_socrel", "№15 — Социальные отношения", "oss_polaw"),
    ("os16_lawjudge", "№16 — Право: анализ суждений", "oss_polaw"),
    ("os17_significance", "№17 — Социальная значимость явлений", "oss_text"),
    ("os18_plan", "№18 — Составление плана по тексту", "oss_text"),
    ("os19_analysis", "№19 — Анализ текста", "oss_text"),
    ("os20_examples", "№20 — Иллюстрация положений текста примерами", "oss_text"),
]

# --- Подсказки темы: ровно 3 непустые строки (требует контракт реестра) ------
HINTS: dict[str, list[str]] = {
    "os01_concepts": [
        "Выбери два понятия, которые прямо используются в описанной ситуации, — остальные из списка там ни при чём.",
        "Раскрывая смысл, назови существенные признаки: род (что это) + видовое отличие (чем выделяется).",
        "Проверь ответ по критериям: засчитываются только понятия, реально задействованные в контексте.",
    ],
    "os02_table": [
        "Прочитай заголовки строк и столбцов: пропуск обычно восстанавливается по соседним ячейкам.",
        "Слово в пропуске должно точно называть элемент понятия — синонимы и пересказ не засчитываются.",
        "Сверь род и число: ответ вписывается в бланк словом в нужной форме.",
    ],
    "os03_compare": [
        "Сначала разнеси позиции по двум колонкам: «сходство» и «отличия» — не смешивай их.",
        "Сходство ищет общее у обоих объектов, отличие — признак, который есть только у одного.",
        "Ответ — набор цифр без пробелов: перепроверь каждую цифру отдельно.",
    ],
    "os04_culture": [
        "Определи сферу: наука, образование, мораль, религия, искусство — у каждой свои признаки.",
        "Наука отвечает на вопрос «что и почему», образование — «как передают знания», мораль — «что добро».",
        "Если в условии пример — подставь его под определение, а не под житейское понимание слова.",
    ],
    "os05_man": [
        "Различай биологическое (потребности, инстинкты) и социальное (общение, труд, нормы) в человеке.",
        "Общество как система: ищи связи — человек формируется в деятельности и общении.",
        "В заданиях про личность опирайся на признаки: социализация, деятельность, ответственность.",
    ],
    "os06_social": [
        "Проверяй каждое суждение отдельно: одно неверное слово — всё суждение ложно.",
        "Слова-маркеры «все», «всегда», «только», «никогда» чаще всего делают суждение неверным.",
        "Вспомни точные определения статусов, ролей, семьи и конфликтов — суждения строятся на них.",
    ],
    "os07_photo": [
        "Внимательно рассмотри изображение: детали (одежда, символы, действия) указывают на ценность.",
        "Свяжи увиденное с духовно-нравственными ценностями: патриотизм, семья, труд, милосердие.",
        "Ответ строй по критериям: что изображено, какая ценность, почему это важно для общества.",
    ],
    "os08_finance": [
        "Выдели факты ситуации: суммы, сроки, условия — решение строится только на них.",
        "Считай выгоду в рублях: проценты по вкладу и переплата по кредиту считаются от тела суммы.",
        "Дай обоснованный вывод: какой вариант выгоднее и почему, со ссылкой на расчёт.",
    ],
    "os09_agents": [
        "Определи субъект: государство, фирма, семья, гражданин — у каждого свои функции.",
        "Функцию узнавай по глаголу: регулирует, производит, воспитывает, защищает.",
        "Если спрашивают «кто», перечисли признаки из условия и сопоставь с субъектом.",
    ],
    "os10_econ": [
        "Проверяй каждое суждение отдельно: экономические термины (спрос, издержки, конкуренция) точны.",
        "Спрос растёт — цена растёт; предложение растёт — цена падает: сверяй направление связи.",
        "Безработица, инфляция, налоги — у каждого явления своя причина, не путай их.",
    ],
    "os11_politics": [
        "Определи, о чём речь: власть, государство, выборы, партии — у каждого свои признаки.",
        "Форму правления отличай по главе (монарх/президент), режим — по правам и свободам.",
        "Демократию узнавай по выборам, разделению властей и гарантиям прав.",
    ],
    "os12_stats": [
        "Сначала прочитай вопрос опроса и легенду таблицы: что измеряли и в каких единицах.",
        "Вывод делай сравнением столбцов: рост, падение или стабильность доли в процентах.",
        "Объяснение опирайся на обществоведческие знания, а не на житейские догадки.",
    ],
    "os13_law": [
        "Определи отрасль права: уголовное, гражданское, трудовое, административное — по отношениям.",
        "Правонарушение отличай по противоправности и вине; ответственность — по возрасту и отрасли.",
        "Норма права — правило от государства: ищи признак общеобязательности и санкции.",
    ],
    "os14_match": [
        "Работай по строкам: для каждого примера подбери элемент и сразу записывай цифру.",
        "Исключай заведомо чужие варианты — обычно остаются две-три рабочие пары.",
        "Ответ — последовательность цифр: число цифр равно числу примеров.",
    ],
    "os15_socrel": [
        "Определи сферу отношений: семья, труд, нация, конституционный строй — нормы у каждой свои.",
        "Семейные отношения регулирует Семейный кодекс, трудовые — Трудовой: ссылайся на них.",
        "Конституцию узнавай по высшим ценностям: права человека, суверенитет, разделение властей.",
    ],
    "os16_lawjudge": [
        "Проверяй каждое суждение отдельно: право не терпит приблизительных формулировок.",
        "«Все граждане», «любой закон», «всегда виновен» — абсолютные слова обычно ломают суждение.",
        "Конституция — высший закон: ни один акт ей противоречить не может.",
    ],
    "os17_significance": [
        "Прочитай ситуацию до конца: значимое явление влияет на многих людей, а не на одного.",
        "Оценивай с позиций норм и ценностей: законность, мораль, безопасность общества.",
        "Вывод подкрепляй фактами из условия, а не общими словами.",
    ],
    "os18_plan": [
        "Дели текст на смысловые фрагменты: один абзац — обычно один пункт плана.",
        "Пункт плана — краткий заголовок идеи фрагмента, а не цитата целиком.",
        "Проверь: все пункты вместе покрывают весь текст, ничего не потеряно и не повторено.",
    ],
    "os19_analysis": [
        "Отвечай строго по тексту: найди фрагмент, где об этом сказано, и опирайся на него.",
        "Различай мнение автора, факты и твоё объяснение — вопрос обычно просит конкретное.",
        "Объяснение строй через обществоведческое понятие: назови его и свяжи с текстом.",
    ],
    "os20_examples": [
        "Пример должен иллюстрировать именно то положение, которое названо, — не соседнее.",
        "Хороший пример конкретен: кто, что сделал, где и когда — общие фразы не засчитываются.",
        "Проверь каждый пример: положение названо верно и пример ему соответствует.",
    ],
}

GOALS = [
    {"id": "g3", "label": "Оценка 3",
     "desc": "14+ баллов — аттестат"},
    {"id": "g4", "label": "Оценка 4",
     "desc": "24+ баллов — уверенный результат"},
    {"id": "g5", "label": "Оценка 5",
     "desc": "32+ баллов — максимум ОГЭ"},
]

# Диагностика: по одному заданию из representative-линий (все — часть 1,
# self-заданий в диагностике нет: там поле ввода с автопроверкой).
DIAGNOSTIC_LINES = [2, 4, 5, 6, 10, 11, 14, 16]

DAILY = {"skill": "os04_culture", "target": 5, "xp": 50,
         "title": "Ежедневная подборка заданий ОГЭ"}

BOSSES = [
    {"id": "boss-oge-soc-person", "cat": "oss_person",
     "title": "БОСС: Человек, общество, культура",
     "desc": "Смешанные задания №1–5 из банка обществознания ОГЭ.",
     "size": 6, "xp": 300, "unlockAt": 25},
    {"id": "boss-oge-soc-spheres", "cat": "oss_spheres",
     "title": "БОСС: Социальная сфера и экономика",
     "desc": "Смешанные задания социальной сферы и экономики из банка обществознания ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-soc-polaw", "cat": "oss_polaw",
     "title": "БОСС: Политика и право",
     "desc": "Смешанные задания политики и права из банка обществознания ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
    {"id": "boss-oge-soc-text", "cat": "oss_text",
     "title": "БОСС: Развёрнутые ответы по тексту",
     "desc": "Смешанные задания с развёрнутым ответом из банка обществознания ОГЭ.",
     "size": 8, "xp": 400, "unlockAt": 25},
]

KEY_ORDER = ["id", "skill", "sub", "num", "diff", "text", "answer", "hint",
             "hints", "solution", "type", "check", "sourceId", "status",
             "example", "points", "valueType", "source", "subject"]

SELF_PHRASE_RE = re.compile(r"ответ\s+запишите", re.I)
# Экзаменатурный хвост источника («Ответ запишите на бланке ответов № 2,
# указав номер задания»): в приложении бланка №2 нет, фраза к тому же
# запрещена для self-заданий (аудит audit_catalog_import: FORBIDDEN) —
# вырезаем из развёрнутых текстов целиком.
BLANK_FORM_RE = re.compile(
    r"\s*Ответ\s+запишите\s+на\s+"
    r"(?:бланке\s+ответов\s+№\s*\d+|(?:отдельном|дополнительном)\s+листе)"
    r",?\s+указав\s+номер\s+задания\.", re.I | re.S)


def line_of_skill(skill_id: str) -> int:
    m = re.match(r"os(\d+)_", skill_id)
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
    path = OUT_DIR / f"soc_oge_{n:02d}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def usable(raw: dict, part2: bool) -> bool:
    """Годится ли сырое задание в банк (без рисунков, решаемое)."""
    if raw.get("has_figure"):
        return False
    if FIG_RE.search(raw.get("condition") or ""):
        return False
    if part2:
        # Развёрнутый ответ: нужно непустое решение; машинного ответа нет.
        return bool((raw.get("solution") or "").strip())
    return bool((raw.get("answer") or "").strip())


def task_from_source(n: int, idx: int, raw: dict, skill: str) -> dict:
    part2 = n in EXT_TIPS
    text = clean(raw["condition"])
    solution = (raw.get("solution") or "").strip()
    if part2:
        if not solution:
            raise ValueError(f"self-задание {raw['src_id']}: пустое решение")
        text = BLANK_FORM_RE.sub("", text).strip()
        if SELF_PHRASE_RE.search(text):
            raise ValueError(f"self-задание {raw['src_id']}: «ответ запишите» в тексте")
        hint, hints = hints_from(solution)
        task = {
            "id": f"os{n:02d}_p{idx}",
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
            "source": f"Решу ОГЭ (СДАМ ГИА), обществознание, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    else:
        alts = [x.strip().strip(".") for x in (raw["answer"] or "").split("|")
                if x.strip()]
        answer = alts[0] if alts else ""
        if not answer:
            raise ValueError(f"short-задание {raw['src_id']}: пустой ответ")
        hint, hints = hints_from(solution)
        task = {
            "id": f"os{n:02d}_p{idx}",
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
            "source": f"Решу ОГЭ (СДАМ ГИА), обществознание, задание №{n}, {raw['url']}",
            "subject": SUBJECT,
        }
    out = {k: task[k] for k in KEY_ORDER if k in task}
    if not part2 and len(alts) > 1:
        out["accept"] = alts
    return out


def task_num_key(t: dict) -> tuple[str, int]:
    # Числовой порядок внутри темы (p1, p2, …, p10, …): строковая сортировка
    # дала бы p1, p10, p100, p11 — миссии и подписи «задание N из M» врали бы
    # (та же причина, что у tools/sort_tasks.py; наш каталог он не покрывает).
    stem, _, tail = (t.get("id") or "").rpartition("_p")
    try:
        return (t.get("skill") or "", int(tail))
    except ValueError:
        return (t.get("skill") or "", 0)


def build_tasks() -> tuple[list[dict], list[tuple]]:
    skills = skill_by_line()
    tasks: list[dict] = []
    summary = []
    for n in range(1, 21):
        skill = skills[n]
        part2 = n in EXT_TIPS
        pool = [r for r in raw_pool(n) if usable(r, part2)]
        pure = [r for r in pool if not r.get("images")]
        verbal = [r for r in pool if r.get("images")]
        picked = (pure + verbal)[:TARGET_PER_LINE]
        for i, r in enumerate(picked, 1):
            tasks.append(task_from_source(n, i, r, skill))
        summary.append((n, skill, len(picked), len(pure), len(verbal),
                        len(raw_pool(n))))
    tasks.sort(key=task_num_key)
    return tasks, summary


def build_missions(tasks: list[dict]) -> list[dict]:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    missions = []
    for sid, name, _cat in SKILLS:
        if sid in LOCKED_SKILLS:
            continue
        group = sorted(by_skill.get(sid, []), key=task_num_key)
        assert group, f"нет заданий для миссии {sid}"
        num = line_of_skill(sid)
        missions.append({
            "id": f"m-{sid}",
            "skill": sid,
            "title": f"Практика: {name}",
            "desc": f"Все задания №{num} из банка обществознания ОГЭ.",
            "tasks": [t["id"] for t in group[:3]],
            "xp": 40,
            "diff": 2 if num in EXT_TIPS else 1,
        })
    return missions


def build_catalog(tasks: list[dict]) -> dict:
    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t)
    diagnostic = []
    for n in DIAGNOSTIC_LINES:
        sid = skill_by_line()[n]
        group = sorted(by_skill.get(sid, []), key=task_num_key)
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
        "title": "Обществознание (ОГЭ)",
        "status": "ready",
        "features": {"lessons": False, "practice": True, "forecast": True,
                     "diagnostics": True, "missions": True, "bosses": True,
                     "daily": True, "path": True},
        "description": "Обществознание ОГЭ: все 20 линий экзамена — практика на реальных заданиях.",
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
