#!/usr/bin/env python3
"""Сборка каталога истории (ЕГЭ, 21 задание) из реальных заданий Решу ЕГЭ.

Источники сырья (tools/out, тянет tools/fetch_history.py):
  * his_01..his_14, his_16..his_22 — пулы линий prob<N> (prob15 пропущен:
    legacy-комплексы «выполните задания 13, 14 и 15» без явных вопросов);
  * his_theme_terms.json — «раскройте смысл понятия + факт» (экзамен №19);
  * his_theme_args.json — запас «аргументов» (экзамен №20).

Соответствие пулов линиям экзамена (проверено вручную по banke источника;
нумерация Решу во 2-й части НЕ совпадает с нумерацией ФИПИ):
  his_01..12 -> №1..12; his_13 -> №13; his_14 -> №14; his_16+his_17 -> №15;
  his_18 -> №16 (ВОВ); his_19 -> №17 (причины); his_20 -> №18 (понятие+вопросы);
  themes -> №19 (понятие+факт); his_22+themes -> №20 (аргументы); his_21 -> №21.

Режимы: часть 1 (№1-12) — auto (строгая сверка, цифры и слова); часть 2
(№13-21) — self (ученик решает письменно и сверяется с официальным разбором).
Задания с картами/изображениями (№8-12, №15) идут только с импортированным
рисунком в assets/history (visual.assetId + visualAssets); без рисунка такое
задание нерешаемо и в банк не попадает.

    python3 tools/apply_history.py --analyze   # отбор без скачивания рисунков
    python3 tools/apply_history.py             # полная сборка каталога
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import figure_import  # noqa: E402

CATALOG = ROOT / "server" / "catalog_history.json"
OUT_DIR = ROOT / "tools" / "out"
FIG_MANIFEST = OUT_DIR / "his_figures.json"

TARGET = 100
SUBJECT = "history"

FIG_RE = re.compile(
    r"на\s+рисунк|на\s+диаграмм|на\s+график|изображ[её]н|показан\w*\s+на"
    r"|см\.\s*рисун", re.I)
ANSWER_RE = re.compile(r"^[0-9а-яёА-ЯЁ\s\-\–—|.,/()«»\"]+$")
# Явный вопрос в условии (отсекает legacy-комплексы без вопросов).
QMARK_RE = re.compile(
    r"\?|укажите|назовите|напишите|ответьте|запишите|тезис|аргумент"
    r"|раскройте|вспомните|сформулируйте|приведите|объясните|сравните", re.I)


def genre_ok(exam: int, cond: str) -> bool:
    low = cond.lower()
    if exam == 17:
        return ("причин" in low or "последств" in low or "предпосыл" in low
                or "повод" in low)
    if exam == 18:
        return "вспомните смысл понятия" in low
    if exam == 19:
        return "раскройте смысл понятия" in low
    if exam == 20:
        return "аргумент" in low and "тезис" not in low
    if exam == 21:
        return "тезис" in low
    if exam == 16:
        return ("фрагменты источников" in low or "воспоминани" in low)
    if exam in (13, 14):
        return "исторического источника" in low or "источника" in low
    return True


# skill, экзамен №, название, баллы, пулы, режим, цель
SKILLS = [
    ("h01_dates", 1, "№1 — Даты: события и годы", 2, ["his_01"], "auto_text", TARGET),
    ("h02_chrono", 2, "№2 — Хронология событий", 1, ["his_02"], "auto_text", TARGET),
    ("h03_facts", 3, "№3 — Факты: процессы и явления", 2, ["his_03"], "auto_text", TARGET),
    ("h04_table", 4, "№4 — Таблица: пропуски", 3, ["his_04"], "auto_text", TARGET),
    ("h05_persons", 5, "№5 — Деятели: события и участники", 2, ["his_05"], "auto_text", TARGET),
    ("h06_source", 6, "№6 — Письменный источник", 2, ["his_06"], "auto_text", TARGET),
    ("h07_culture", 7, "№7 — Культура: памятники", 2, ["his_07"], "auto_text", TARGET),
    ("h08_image", 8, "№8 — Изображение: пропуск", 1, ["his_08"], "auto_fig", TARGET),
    ("h09_map", 9, "№9 — Карта: век и объекты", 1, ["his_09"], "auto_fig", TARGET),
    ("h10_map", 10, "№10 — Карта: события и деятели", 1, ["his_10"], "auto_fig", TARGET),
    ("h11_maptext", 11, "№11 — Карта и текст: пропуск", 1, ["his_11"], "auto_fig", TARGET),
    ("h12_mapchoice", 12, "№12 — Карта: верные суждения", 2, ["his_12"], "auto_fig", TARGET),
    ("h13_attr", 13, "№13 — Источник: атрибуция", 2, ["his_13"], "self_text", TARGET),
    ("h14_search", 14, "№14 — Источник: поиск информации", 2, ["his_14"], "self_text", TARGET),
    ("h15_imgout", 15, "№15 — Изображения: вывод и объяснение", 2,
     ["his_16", "his_17"], "self_fig", TARGET),
    ("h16_wow", 16, "№16 — ВОВ: два источника", 2, ["his_18"], "self_text", TARGET),
    ("h17_causes", 17, "№17 — Причины и последствия", 3, ["his_19"], "self_text", TARGET),
    ("h18_terms", 18, "№18 — Понятие и вопросы", 3, ["his_20", "his_legacy_termsq"], "self_text", TARGET),
    ("h19_termfact", 19, "№19 — Понятие и факт", 2,
     ["his_theme_terms", "his_legacy_terms"], "self_text", TARGET),
    ("h20_args", 20, "№20 — Аргументы: Россия и мир", 3,
     ["his_22", "his_theme_args", "his_legacy_args"], "self_text", TARGET),
    ("h21_thesis", 21, "№21 — Тезис и обоснования", 3,
     ["his_21", "his_legacy_thesis"], "self_text", TARGET),
]

CATS = [
    ("hist_base", "Знание дат и фактов (№1–7)", "Факты", (1, 7)),
    ("hist_visual", "Карты, схемы, изображения (№8–12)", "Карты", (8, 12)),
    ("hist_source", "Источники и изображения (№13–16)", "Источники", (13, 16)),
    ("hist_part2", "Развёрнутый ответ (№17–21)", "Часть 2", (17, 21)),
]

HINTS = {
    "h01_dates": ["Сначала отметь знакомые даты-якоря (988, 1861, 1917, 1945).",
                  "Работай от известного: привяжи 1–2 события точно, остальные — исключением.",
                  "Проверь пару в обе стороны: год подходит событию, событие — году."],
    "h02_chrono": ["Выпиши даты событий рядом и упорядочи числами.",
                   "Сначала расставь века, потом уточни порядок внутри века.",
                   "Событие всеобщей истории — внешний якорь: привяжи его к российским датам."],
    "h03_facts": ["Разбей пары по векам: половина вариантов отсеется сразу.",
                  "Ищи прямое соответствие: процесс — его ключевой факт.",
                  "Не путай похожие процессы (опричнина и земщина, Смута и раскол)."],
    "h04_table": ["Прочитай заголовки таблицы: что дано, а что пропущено.",
                  "Закрывай пропуски по очереди, каждый — независимым фактом.",
                  "Связка «география + событие»: вспоминай карту."],
    "h05_persons": ["Деятель определяется делом: реформа, битва, труд.",
                    "Отсей деятелей чужого века.",
                    "Проверь обратную связь: событие точно связано с этим именем?"],
    "h06_source": ["Найди в отрывке маркеры времени: имена, даты, реалии.",
                   "Определи век, потом — событие.",
                   "Отвечай строго по инструкции: цифры или слова как просят."],
    "h07_culture": ["Определи вид памятника: храм, картина, книга, фильм.",
                    "Привяжи стиль и автора к веку.",
                    "Характеристика должна подходить целиком, а не одним словом."],
    "h08_image": ["Рассмотри все детали изображения: подписи, даты, символы.",
                  "Определи событие, потом — пропущенное слово.",
                  "Падеж и число в ответе не важны для проверки, важен корень слова."],
    "h09_map": ["Найди на схеме знакомые города и реки — это якоря.",
                "Определи век по главному событию схемы.",
                "Название сверяй с вопросом: город, век, полководец — что именно просят."],
    "h10_map": ["Привяжи стрелки и цифры к известным походам и битвам.",
                "Император определяется войной, война — театром действий.",
                "Проверь: объект с нужной цифрой, а не соседний."],
    "h11_maptext": ["Сначала прочитай текст: он называет событие.",
                    "Пропуск закрывается по схеме, а не по памяти.",
                    "Фамилию и топоним пиши полностью, как в источнике."],
    "h12_mapchoice": ["Разбирай каждое суждение отдельно, только по схеме.",
                     "Цифры на схеме сверяй с легендой.",
                     "Одно верное слово не делает суждение верным целиком."],
    "h13_attr": ["Атрибуция — три опоры: автор, время, событие.",
                 "Ищи прямые указания в тексте, потом подключай знания.",
                 "Год и век различай: в ответе нужно именно то, что спросили."],
    "h14_search": ["Отвечай словами источника плюс знание курса.",
                   "Каждый вопрос — отдельный пункт ответа.",
                   "Не уходи в пересказ: только то, о чём спросили."],
    "h15_imgout": ["Сначала вывод (что изображено), потом обоснование деталью.",
                   "Обоснование — конкретная деталь марки или монеты, а не впечатление.",
                   "Факт по культуре: автор, стиль, век."],
    "h16_wow": ["Определи событие по обоим источникам сразу.",
                "Вывод подтверждай опорами из фрагментов А и Б.",
                "Критерий ищи буквально: дата, имя, место."],
    "h17_causes": ["Причины — «почему случилось», последствия — «что изменилось».",
                   "Каждый пункт а/б/в — отдельный проверяемый факт.",
                   "Не путай причину и повод."],
    "h18_terms": ["Понятие: родовая принадлежность плюс видовое отличие.",
                  "На вопросы отвечай по существу, без общих слов.",
                  "Факты должны относиться к понятию, а не к эпохе вообще."],
    "h19_termfact": ["Определение: род плюс отличие; факт — конкретный и вне определения.",
                     "Факт не должен повторять слова твоего определения.",
                     "Один точный факт лучше трёх общих."],
    "h20_args": ["Аргумент = факт + пояснение-связка с точкой зрения.",
                 "Один аргумент — по России, второй — по всеобщей истории.",
                 "Факт без пояснения — не аргумент."],
    "h21_thesis": ["Тезис — оценочное суждение о сходстве или различии.",
                   "Каждое обоснование — факты, а не рассуждения.",
                   "Два обоснования — два разных факта."],
}

SELF_H1 = "Отвечай письменно по пунктам, потом сверься с разбором."
SELF_H2 = "По каждому пункту нужна конкретика: факт, дата, имя — а не общие слова."

DIAG_SKILLS = ["h01_dates", "h02_chrono", "h03_facts", "h05_persons", "h06_source", "h07_culture"]
DAILY = {"skill": "h02_chrono", "target": 5, "xp": 50, "title": "Ежедневная подборка: хронология"}


def load_pool(name: str) -> list[dict]:
    path = OUT_DIR / f"{name}.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def sub_from(text: str, skill_name: str) -> str:
    skip = {"рассмотрите изображение и выполните задание.",
            "рассмотрите схему и выполните задание.",
            "рассмотрите изображение и выполните задания 15, 16.",
            "рассмотрите изображение и выполните задания 16, 17."}
    for line in text.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if line and line.lower() not in skip:
            return line[:56].rstrip(" ,;:") or skill_name
    return skill_name


def usable_auto(r: dict, exam: int, figure: bool) -> bool:
    cond = (r.get("condition") or "").strip()
    ans = (r.get("answer") or "").strip()
    if not cond or not ans:
        return False
    if not (r.get("solution") or "").strip():
        return False
    if len(ans) > 100 or "<" in ans or "http" in ans:
        return False
    if not ANSWER_RE.fullmatch(ans):
        return False
    if figure:
        return bool(r.get("images"))
    if r.get("images"):
        return False
    if FIG_RE.search(cond):
        return False
    return True


def usable_self(r: dict, exam: int, figure: bool) -> bool:
    cond = (r.get("condition") or "").strip()
    sol = (r.get("solution") or "").strip()
    if not cond or not sol:
        return False
    # Ловушка загрузчика: self-задание с фразой «ответ запишите» роняет
    # install_catalog (у self нет поля ввода). Регистр важен: «Ответ
    # запишите в следующем виде» (оформление работы на бумаге) допустимо.
    if "ответ запишите" in cond:
        return False
    if not QMARK_RE.search(cond):
        return False
    if not genre_ok(exam, cond):
        return False
    if figure:
        return bool(r.get("images"))
    if r.get("images"):
        return False
    if FIG_RE.search(cond):
        return False
    return True


def hints_for(skill: str, solution: str, self_mode: bool) -> tuple[str, list[str]]:
    if self_mode:
        h = list(HINTS[skill][:2]) + [solution]
        return HINTS[skill][0], h
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", solution or "") if p.strip()]
    if not parts:
        generic = HINTS[skill][0]
        return generic, [generic]
    return parts[0], (parts[:3] if len(parts) >= 3 else parts + [HINTS[skill][1]] * (3 - len(parts)))


def build_auto(skill: str, exam: int, points: int, raw: dict, new_id: str) -> dict:
    alts = [x.strip() for x in (raw["answer"] or "").split("|") if x.strip()]
    text = (raw["condition"] or "").strip()
    hint, hints = hints_for(skill, raw.get("solution") or "", False)
    task = {
        "id": new_id,
        "skill": skill,
        "sub": sub_from(text, SKILLS_BY_ID[skill]["name"]),
        "num": f"№{exam}",
        "diff": 1,
        "text": text,
        "answer": alts[0],
        "hint": hint,
        "hints": hints,
        "solution": (raw.get("solution") or "").strip(),
        "type": "short_answer",
        "points": points,
        "source": f"Решу ЕГЭ (СДАМ ГИА), история, задание №{exam}, {raw['url']}",
        "sourceId": f"sdamgia-hist-{raw['src_id']}",
    }
    if len(alts) > 1:
        task["accept"] = alts
    return task


def build_self(skill: str, exam: int, points: int, raw: dict, new_id: str) -> dict:
    solution = (raw["solution"] or "").strip()
    text = (raw["condition"] or "").strip()
    task = {
        "id": new_id,
        "skill": skill,
        "sub": sub_from(text, SKILLS_BY_ID[skill]["name"]),
        "num": f"№{exam}",
        "diff": 2,
        "text": text,
        "answer": solution,
        "hint": SELF_H1,
        "hints": [SELF_H1, SELF_H2, solution],
        "solution": solution,
        "type": "short_answer",
        "points": points,
        "check": "self",
        "selfCheck": True,
        "source": f"Решу ЕГЭ (СДАМ ГИА), история, задание №{exam}, {raw['url']}",
        "sourceId": f"sdamgia-hist-{raw['src_id']}",
    }
    return task


SKILLS_BY_ID = {s[0]: {"exam": s[1], "name": s[2], "points": s[3], "pools": s[4],
                       "mode": s[5], "target": s[6]} for s in SKILLS}


def load_manifest() -> dict:
    if FIG_MANIFEST.exists():
        try:
            return json.loads(FIG_MANIFEST.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return {}


def save_manifest(manifest: dict) -> None:
    FIG_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8")


def figure_entry(pid: str, exam: int, manifest: dict, download: bool) -> dict | None:
    if pid in manifest:
        entry = manifest[pid]
        if (ROOT / entry["file"].split("?", 1)[0]).exists():
            return entry
    if not download:
        return {"id": f"his-src{pid}", "file": "?", "urls": [],
                "width": 0, "height": 0}
    import io
    buf = io.StringIO()
    saved = sys.stderr
    sys.stderr = buf
    try:
        entry = figure_import.import_task("his", pid, 2.5, figures_only=True)
    finally:
        sys.stderr = saved
    if entry:
        manifest[pid] = entry
    return entry


def build_asset(exam: int, entry: dict) -> dict:
    ratio = round(entry["width"] / entry["height"], 4) if entry.get("height") else 1.0
    return {
        "id": entry["id"],
        "src": entry["file"],
        "type": "image",
        "alt": f"Рисунок к заданию (история №{exam})",
        "width": 640,
        "ratio": ratio,
        "source": f"рисунок источника: {entry['urls'][0] if entry.get('urls') else ''}",
    }


def select() -> tuple[dict, dict]:
    """Отбор сырья по скилам. Возвращает (selected, report)."""
    selected: dict[str, list[dict]] = {}
    report: dict[str, dict] = {}
    for skill, exam, _name, _pts, pools, mode, target in SKILLS:
        figure = mode.endswith("_fig")
        self_mode = mode.startswith("self")
        raws: list[dict] = []
        seen: set[str] = set()
        for pool in pools:
            for r in load_pool(pool):
                pid = str(r.get("src_id"))
                if pid in seen:
                    continue
                seen.add(pid)
                raws.append(r)
        check = usable_self if self_mode else usable_auto
        # Для his_16+his_17 (оба — изображения №15) и his_22+themes порядок
        # пулов уже задаёт приоритет; внутри пула — порядок источника.
        cand = [r for r in raws if check(r, exam, figure)]
        selected[skill] = cand[:target + 25]
        report[skill] = {"pool": len(raws), "usable": len(cand)}
    return selected, report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true",
                    help="только отбор сырья, рисунки не качать, каталог не писать")
    args = ap.parse_args()

    selected, report = select()
    for skill, exam, _name, _pts, _pools, mode, target in SKILLS:
        got = len(selected[skill])
        print(f"№{exam:2} {skill:13} {mode:10} пул {report[skill]['pool']:4}, "
              f"годных {report[skill]['usable']:4} (цель {target})")
    if args.analyze:
        return 0

    manifest = load_manifest()
    manifest_dirty = 0
    tasks: list[dict] = []
    assets: list[dict] = []
    asset_ids: set[str] = set()
    statuses: dict[str, str] = {}
    for skill, exam, _name, points, _pools, mode, target in SKILLS:
        figure = mode.endswith("_fig")
        self_mode = mode.startswith("self")
        prefix = f"h{exam:02d}"
        k = 1
        taken = 0
        for r in selected[skill]:
            if taken >= target:
                break
            pid = str(r["src_id"])
            asset_id = None
            if figure:
                entry = figure_entry(pid, exam, manifest, True)
                manifest_dirty += 1
                if manifest_dirty >= 25:
                    save_manifest(manifest)
                    manifest_dirty = 0
                if not entry:
                    continue
                asset_id = entry["id"]
                if asset_id not in asset_ids:
                    assets.append(build_asset(exam, entry))
                    asset_ids.add(asset_id)
            new_id = f"{prefix}_p{k}"
            k += 1
            task = (build_self if self_mode else build_auto)(
                skill, exam, points, r, new_id)
            if asset_id:
                task["visual"] = {"assetId": asset_id}
                statuses[new_id] = "visual-provided"
            tasks.append(task)
            taken += 1
        print(f"№{exam:2} {skill:13} взято {taken}")
    save_manifest(manifest)

    # ?v=хеш содержимого (инвалидация годового immutable-кэша).
    for a in assets:
        f = ROOT / a["src"].split("?", 1)[0]
        if f.exists():
            digest = hashlib.md5(f.read_bytes()).hexdigest()[:10]
            a["src"] = f"{a['src'].split('?', 1)[0]}?v={digest}"

    skills_json = []
    for i, (skill, exam, name, _pts, _pools, _mode, _target) in enumerate(SKILLS):
        cat = next(c for c in CATS if c[3][0] <= exam <= c[3][1])[0]
        skills_json.append({
            "id": skill, "cat": cat, "ege": f"№{exam}", "name": name,
            "order": i, "metadata": {"hints": HINTS[skill]},
        })
    cats_json = [{"id": c[0], "name": c[1], "short": c[2]} for c in CATS]

    by_skill: dict[str, list[dict]] = {}
    for t in tasks:
        by_skill.setdefault(t["skill"], []).append(t["id"])

    missions = []
    for skill, exam, name, _pts, _pools, _mode, _target in SKILLS:
        ids = sorted(by_skill.get(skill, []))[:5]
        if not ids:
            raise SystemExit(f"пустой скил {skill}: миссию не собрать")
        short = name.split("—", 1)[1].strip() if "—" in name else name
        missions.append({
            "id": f"m-{skill}",
            "skill": skill,
            "title": f"Практика: {short}",
            "desc": f"Все задания линии №{exam} из тренировочного банка.",
            "tasks": ids,
            "xp": 50,
            "diff": 1,
        })

    bosses = [
        {"id": "boss-hist-base", "cat": "hist_base",
         "title": "БОСС: Факты и даты (№1–7)",
         "desc": "Смешанные задания №1–7 с кратким ответом из тренировочного банка.",
         "size": 10, "xp": 300, "unlockAt": 25},
        {"id": "boss-hist-visual", "cat": "hist_visual",
         "title": "БОСС: Карты и изображения (№8–12)",
         "desc": "Смешанные задания №8–12 по картам и изображениям.",
         "size": 10, "xp": 300, "unlockAt": 25},
        {"id": "boss-hist-source", "cat": "hist_source",
         "title": "БОСС: Источники (№13–16)",
         "desc": "Смешанные задания №13–16 по источникам и изображениям.",
         "size": 8, "xp": 400, "unlockAt": 25},
        {"id": "boss-hist-final", "cat": "hist_part2",
         "title": "БОСС: Весь экзамен",
         "desc": "Смешанный вариант из заданий №1–21 всего курса.",
         "size": 12, "xp": 500, "unlockAt": 60},
    ]

    diag = []
    for skill in DIAG_SKILLS:
        ids = sorted(by_skill.get(skill, []))
        if not ids:
            raise SystemExit(f"нет заданий для диагностики: {skill}")
        diag.append(ids[0])
    daily_skill = DAILY["skill"]
    if not by_skill.get(daily_skill):
        raise SystemExit(f"нет заданий для daily: {daily_skill}")

    subj = json.loads((ROOT / "server" / "subjects" / "history.json").read_text(encoding="utf-8"))
    catalog = {
        "subject": "history",
        "subjectId": "history",
        "title": "История (ЕГЭ)",
        "status": "ready",
        "locked": False,
        "comingSoon": False,
        "availability": "ready",
        "features": dict(subj["features"]),
        "description": subj["description"],
        "categories": cats_json,
        "skills": skills_json,
        "tasks": sorted(tasks, key=lambda t: (t.get("skill") or "", t.get("id") or "")),
        "lessons": [],
        "missions": missions,
        "bosses": bosses,
        "achievements": [],
        "daily": dict(DAILY),
        "goals": [
            {"id": "g60", "label": "60+ баллов", "desc": "Уверенная база для поступления"},
            {"id": "g80", "label": "80+ баллов", "desc": "Сильный результат для хорошего вуза"},
            {"id": "g95", "label": "95+ баллов", "desc": "Максимум — топовые направления"},
        ],
        "diagnosticTasks": diag,
        "visualAssets": assets,
        "visualAudit": {"defaultStatus": "not-published",
                        "taskStatuses": statuses, "references": []},
    }
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nзаданий: {len(tasks)}, рисунков: {len(assets)}, "
          f"миссий: {len(missions)}, диагностика: {diag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
