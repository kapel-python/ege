#!/usr/bin/env python3
"""Регрессия AI-оценки сочинения: transport, парсер JSON, валидатор, endpoint.

Обычный запуск (`python3 test/ai-essay.py`) полностью офлайновый: сеть
заглушена на уровне ai.chat, своя temp-БД и свой порт, прод не трогается.

Live-проверка на настоящем ключе — отдельный режим:
    EGE_AI_LIVE=1 python3 test/ai-essay.py
Ключ берётся из окружения, а если там пусто — из /etc/ege-2026.env
(файл с секретами systemd, в репозитории его нет).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = ROOT / "server"
SERVER_PATH = SERVER_DIR / "server.py"
AI_PATH = SERVER_DIR / "ai.py"

# Читаем до импорта: лимит ИИ фиксируется в момент загрузки модуля.
os.environ["EGE_AI_RATE_MAX"] = "3"
os.environ["EGE_AI_RATE_WINDOW_SEC"] = "3600"

LIVE = os.environ.get("EGE_AI_LIVE") == "1"
FAKE_KEY = "sk-test-not-a-real-key-000000000000"
# Работа длиннее порога ФИПИ (150 слов) — иначе сервер честно ставит 0,
# и тест проверял бы не разметку, а правило объёма.
LONG_TEXT = " ".join(["тестовое"] * 200)

# Синтетическая разметка (НЕ реальная работа и не реальные баллы): нужна только
# чтобы проверить форму ответа. Настоящий текст пишет пользователь.
CANONICAL_MAX = {cid: mx for cid, _name, mx in (
    ("K1", "Позиция автора", 1), ("K2", "Комментарий", 3),
    ("K3", "Собственное отношение", 2), ("K4", "Фактическая точности нет", 1),
    ("K5", "Логичность речи", 2), ("K6", "Этические нормы", 1),
    ("K7", "Орфография", 3), ("K8", "Пунктуация", 3),
    ("K9", "Грамматика", 3), ("K10", "Речевые нормы", 3),
)}

_checks = {"pass": 0, "fail": 0}


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        _checks["pass"] += 1
        print(f"  ok  {label}")
    else:
        _checks["fail"] += 1
        print(f"FAIL  {label}" + (f"\n        {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_payload() -> dict:
    """Форма ответа МОДЕЛИ (только содержание, К1–К6) с корректной разметкой
    и заведомо неверными итогами: валидатор обязан пересчитать их сам, а не
    поверить модели на слово. Грамотность (К7–К10) модель не возвращает."""
    criteria = []
    for cid, _name, mx in (
        ("K1", "Позиция автора", 1), ("K2", "Комментарий", 3),
        ("K3", "Собственное отношение", 2), ("K4", "Фактическая точность", 1),
        ("K5", "Логичность речи", 2), ("K6", "Этические нормы", 1),
    ):
        score = mx - 1 if mx > 1 else mx
        criteria.append({"id": cid, "name": _name, "score": score,
                         "max_score": mx, "comment": f"Комментарий к {cid}."})
    return {
        "total_score": 999,       # враньё модели
        "max_score": 999,         # враньё модели
        "short_verdict": "Работу нужно доработать.",
        "criteria": criteria,
        "what_to_improve": ["Проверить логику", "Исправить ошибки"],
        "recommendation": "Перепишите третий абзац.",
    }


def valid_grammar() -> list:
    """Блок К7–К10 в том виде, в каком его возвращает score_grammar (сумма 11)."""
    return [
        {"id": "K7", "name": "Орфография", "score": 2, "max_score": 3,
         "comment": "Ошибок: 1 («превет» → «привет»)."},
        {"id": "K8", "name": "Пунктуация", "score": 3, "max_score": 3, "comment": "Ошибок нет."},
        {"id": "K9", "name": "Грамматика", "score": 3, "max_score": 3, "comment": "Ошибок нет."},
        {"id": "K10", "name": "Речевые нормы", "score": 3, "max_score": 3, "comment": "Ошибок нет."},
    ]


# ---------------------------------------------------------------------------
# 1. Извлечение JSON
# ---------------------------------------------------------------------------
def test_extract_json(ai) -> None:
    section("extract_json: ответ модели приходит в разной обёртке")
    body = valid_payload()
    raw = json.dumps(body, ensure_ascii=False)

    check("чистый JSON", ai.extract_json(raw) == body)
    check("```json-обёртка", ai.extract_json(f"```json\n{raw}\n```") == body)
    check("обёртка без указания языка", ai.extract_json(f"```\n{raw}\n```") == body)
    check("преамбула перед объектом", ai.extract_json(f"Вот оценка:\n{raw}\nГотово.") == body)
    check("хвост после объекта", ai.extract_json(f"{raw}\n\nБалл: 17") == body)
    check("объект не с начала строки", ai.extract_json(f"Ответ: {raw}") == body)

    tricky_value = 'кавычка " и фигурная скобка { внутри строки'
    tricky = json.dumps({"comment": tricky_value}, ensure_ascii=False)
    check("скобки внутри строки не обрывают разбор",
          ai.extract_json(tricky).get("comment") == tricky_value,
          repr(ai.extract_json(tricky).get("comment")))

    for label, broken in (
        ("нет объекта", "Извините, я не смог оценить текст."),
        ("обрезанный объект", '{"total_score": 5, "criteria": ['),
        ("не-JSON", "<html>502 Bad Gateway</html>"),
        ("массив вместо объекта", "[1, 2, 3]"),
        ("комментарий // внутри", '{"total_score": 5 // пять\n}'),
    ):
        try:
            ai.extract_json(broken)
            check(f"отклонено: {label}", False, "исключения не было")
        except ai.AIFormatError:
            check(f"отклонено: {label}", True)
        except Exception as exc:  # noqa: BLE001 - тест ловит не тот класс
            check(f"отклонено: {label}", False, f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# 2. Валидатор разметки
# ---------------------------------------------------------------------------
def test_validate(ai) -> None:
    section("validate_essay: итоги пересчитываются, разметка неприёмиста")
    got = ai.validate_essay(valid_payload(), 300)
    # Фикстура снимает по 1 баллу с каждого критерия, где максимум > 1:
    # 1 + (3-1) + (2-1) + 1 + 1 + 1 = 7 из 10 — это только содержание (К1–К6).
    check("total_score пересчитан по критериям", got["total_score"] == 7, f"получено {got['total_score']}")
    check("max_score содержания = 10", got["max_score"] == 10, f"получено {got['max_score']}")
    check("критериев модели ровно 6", len(got["criteria"]) == 6)
    check("порядок K1..K6 соблюдён", [c["id"] for c in got["criteria"]] == [f"K{i}" for i in range(1, 7)])
    check("названия критериев из реестра", got["criteria"][0]["name"] == "Позиция автора")
    check("советы отфильтрованы", got["what_to_improve"] == ["Проверить логику", "Исправить ошибки"])

    # merge_essay: содержание модели + детерминированная грамотность = 22.
    merged = ai.merge_essay(got, valid_grammar(), 300)
    check("итог = содержание + грамотность", merged["total_score"] == 7 + 11,
          f"получено {merged['total_score']}")
    check("max_score = 22 по федеральному ключу", merged["max_score"] == 22)
    check("в ответе клиенту снова 10 критериев", len(merged["criteria"]) == 10)
    check("порядок K1..K10 соблюдён",
          [c["id"] for c in merged["criteria"]] == [f"K{i}" for i in range(1, 11)])
    check("вердикт остался последним полем", list(merged)[-1] == "short_verdict")
    # merge не верит даже нашему блоку на слово: баллы зажимаются в максимум.
    blown = [dict(c, score=99) for c in valid_grammar()]
    check("merge зажимает баллы грамотности в максимум",
          ai.merge_essay(got, blown, 300)["criteria"][6]["score"] == 3)
    # Правило объёма — наше, а не модели: <150 слов = 0 по всем критериям.
    # Регрессия с живого прогона: qwen3.8-flash объявляла «минимум 100 слов»,
    # потом «минимум 250 слов» и обнуляла работу по выдуманному правилу.
    # Замер: пока порог был в промпте, модель в 1 прогоне из 3 писала в вердикте
    # про объём («всего 151 слово, на грани порога»); с запретом и без порога в
    # промпте — ни разу. Правило применяет сервер, модели оно не нужно.
    system = ai.FORMATS["essay"]["system"]
    check("порог в коде = 150", ai.ESSAY_MIN_WORDS == 150, str(ai.ESSAY_MIN_WORDS))
    check("порога объёма нет в промпте", "150" not in system)
    check("в промпте нет формулировки о минимальном объёме",
          "Минимальный объём" not in system and "не менее 150" not in system)
    # Формулировка запретов, которая по замерам работает: перечисление того, что
    # нельзя, в текстовых полях + самопроверка перед ответом. Прежние варианты
    # («ЗАПРЕЩЕНО считать слова», отдельная строка про вердикт) давали 1 из 3.
    check("запрет баллов и объёма в текстовых полях",
          "В текстовых полях запрещены числа баллов" in system
          and "любые слова про объём текста" in system)
    check("есть самопроверка перед ответом", "Перед ответом проверь себя" in system)
    check("комментарий ограничен по длине (экономим токены, был обрыв ответа)",
          "Не длиннее 2 предложений" in system)
    check("потолки вместо каскада: К2 и К3 не выше 1 при К1 = 0",
          "по К2 ставь не выше 1 и по К3 не выше 1" in system)
    check("К4–К6 не зависят от К1", "К4–К6 от К1 не зависят" in system)
    check("старого каскада нет", "К2 и К3 работа оценивается 0 баллов" not in system)
    check("одна ошибка — один критерий", "Одна погрешность относится ровно к одному критерию" in system)
    check("К5 отделён от других критериев",
          "НЕ фактическая ошибка" in system and "набирай низкий балл за счёт" in system)
    check("короткий текст обнуляет содержание",
          ai.validate_essay(valid_payload(), 149)["total_score"] == 0,
          str(ai.validate_essay(valid_payload(), 149)["total_score"]))
    check("на слово ниже порога тоже 0",
          ai.validate_essay(valid_payload(), 149)["criteria"][0]["score"] == 0)
    check("на границе порога баллы модели сохраняются",
          ai.validate_essay(valid_payload(), 150)["total_score"] == 7,
          str(ai.validate_essay(valid_payload(), 150)["total_score"]))
    short = ai.merge_essay(ai.validate_essay(valid_payload(), 149), valid_grammar(), 149)
    check("короткий текст обнуляет и грамотность", short["total_score"] == 0,
          str(short["total_score"]))
    check("максимумы критериев не обнуляются при коротком тексте",
          [c["max_score"] for c in short["criteria"]]
          == [m for _i, _n, m in ai.ESSAY_CRITERIA])
    check("комментарии сохраняются даже при 0",
          all(c["comment"] for c in short["criteria"]))
    check("count_words считает по словам", ai.count_words("раз два три\nчетыре") == 4)

    # word_count_status удалён из контракта по требованию: модель не должна
    # его ни возвращать, ни видеть в схеме, и в ответе клиенту его нет.
    result = ai.merge_essay(ai.validate_essay(valid_payload(), 300), valid_grammar(), 300)
    check("в ответе нет word_count_status", "word_count_status" not in result, str(sorted(result)))
    check("в ответе нет лишних word_count/min_words",
          "word_count" not in result and "min_words" not in result, str(sorted(result)))
    check("в промпте нет word_count_status", "word_count_status" not in ai.FORMATS["essay"]["system"])
    check("в промпте нет выдуманных порогов 100/250/151",
          not any(x in ai.FORMATS["essay"]["system"] for x in ("250", "151", "100 слов")))
    check("даже если модель вернёт это поле — оно не попадёт в ответ",
          "word_count_status" not in ai.validate_essay(
              {**valid_payload(), "word_count_status": "too_short"}, 300))
    check("состав ответа ровно как в задании",
          sorted(result) == ["criteria", "max_score", "recommendation",
                             "short_verdict", "total_score", "what_to_improve"],
          str(sorted(result)))

    # Промпт должен содержать сами критерии, а не только «оцени по K1..K10».
    for needle, label in (
        ("ИСХОДНЫЙ ТЕКСТ НЕ ДАН", "честная оговорка про исходный текст"),
        ("К1. Отражение позиции автора", "К1 сформулирован"),
        ("К2. Комментарий к позиции", "К2 сформулирован"),
        ("К3. Собственное отношение", "К3 сформулирован"),
        ("К4. Фактическая точность речи", "К4 сформулирован"),
        ("К5. Логичность речи", "К5 сформулирован"),
        ("К6. Соблюдение этических норм", "К6 сформулирован"),
        ("проверяет отдельный автоматический инструмент", "грамотность вынесена из модели"),
        ("Идентификаторы критериев строго K1..K6", "схема из 6 критериев"),
        ("комикс, аниме, манга", "запрет негодных примеров"),
        ("смысловая связь между примерами", "требование К2 к связи"),
        ("short_verdict: 2–3 предложения", "правила заполнения"),
        ("recommendation: 1–2 предложения", "правила заполнения"),
        ("2–5 конкретных правок", "правила заполнения"),
        ("«ошибок нет»", "правило на случай отсутствия ошибок"),
    ):
        if label:
            check(f"промпт: {label}", needle in system)
    check("в промпте не осталось плейсхолдеров", "{min_words}" not in system)
    check("рубрик К7–К10 в промпте модели нет",
          not any(x in system for x in (
              "К7. Соблюдение", "К8. Соблюдение", "К9. Соблюдение", "К10. Соблюдение")))
    check("грамотности нет в схеме ответа", '"K7"' not in system)

    def rejects(label: str, mutate) -> None:
        body = valid_payload()
        mutate(body)
        try:
            ai.validate_essay(body, 300)
            check(f"отклонено: {label}", False, "принято без ошибки")
        except ai.AIFormatError:
            check(f"отклонено: {label}", True)
        except Exception as exc:  # noqa: BLE001
            check(f"отклонено: {label}", False, f"{type(exc).__name__}: {exc}")

    rejects("завышенный max_score у K1", lambda b: b["criteria"][0].__setitem__("max_score", 5))
    rejects("заниженный max_score у K2", lambda b: b["criteria"][1].__setitem__("max_score", 2))
    rejects("score больше max_score", lambda b: b["criteria"][1].__setitem__("score", 5))
    rejects("отрицательный score", lambda b: b["criteria"][0].__setitem__("score", -1))
    rejects("нечисловой score", lambda b: b["criteria"][0].__setitem__("score", "один"))
    rejects("пропущен критерий K5", lambda b: b["criteria"].pop(4))
    rejects("модель вернула К7 (грамотность не её дело)",
            lambda b: b["criteria"].append(
                {"id": "K7", "name": "Орфография", "score": 3,
                 "max_score": 3, "comment": "Ошибок нет."}))
    rejects("дубликат критерия", lambda b: b["criteria"].append(dict(b["criteria"][0])))
    rejects("пустой комментарий", lambda b: b["criteria"][3].__setitem__("comment", "   "))
    rejects("пустой вердикт", lambda b: b.__setitem__("short_verdict", ""))
    rejects("пустой список критериев", lambda b: b.__setitem__("criteria", []))
    rejects("критерий не объект", lambda b: b.__setitem__("criteria", ["K1"]))


# ---------------------------------------------------------------------------
# 3. Бюджет вызовов
# ---------------------------------------------------------------------------
def test_rate_limit(ai) -> None:
    section("ai_take: лимит на пользователя и на IP (EGE_AI_RATE_MAX=3)")
    ai.reset_ai_rate()
    outcomes = [ai.ai_take(["user:1"])[0] for _ in range(5)]
    check("первые 3 проходят", outcomes[:3] == [True, True, True], str(outcomes))
    check("4-й и 5-й отклонены", outcomes[3:] == [False, False], str(outcomes))
    allowed, retry = ai.ai_take(["user:1"])
    check("retry_after положителен", 0 < retry <= 3600, str(retry))
    check("другой пользователь не затронут", ai.ai_take(["user:2"])[0] is True)
    check("сломанный ключ не роняет бюджет", ai.ai_take([None])[0] is True)

    # Ключ IP: клиент без cookie получает нового гостя каждый раз, поэтому
    # лимит только по пользователю обходится тривиально. Два ключа — одна
    # транзакция: либо списываются оба, либо ни один.
    ai.reset_ai_rate()
    for index in range(3):
        check(f"пара user/ip #{index + 1} проходит", ai.ai_take(["user:9", "ip:9.9.9.9"])[0] is True)
    check("исчерпанный IP блокирует и нового гостя",
          ai.ai_take(["user:10", "ip:9.9.9.9"])[0] is False)
    check("тот же IP с другим юзером тоже заблокирован",
          ai.ai_take(["user:999", "ip:9.9.9.9"])[0] is False)
    check("другой IP не заблокирован", ai.ai_take(["user:10", "ip:8.8.8.8"])[0] is True)
    ai.reset_ai_rate()
    check("сброс работает", ai.ai_take(["user:1"])[0] is True)


# ---------------------------------------------------------------------------
# 4. run_format: входные границы
# ---------------------------------------------------------------------------
def test_run_format_input(ai) -> None:
    section("run_format: границы входа и изоляция промпта")
    calls: list[list[dict]] = []
    original = ai.chat
    original_lt = ai.lt_check

    def fake_chat(messages, **kwargs):
        calls.append(messages)
        return json.dumps(valid_payload(), ensure_ascii=False)

    ai.chat = fake_chat
    ai.lt_check = lambda text: []  # офлайн: LanguageTool в сеть не ходит
    try:
        ai.reset_ai_rate()
        try:
            # LONG_TEXT (200 слов): порог объёма не срабатывает, склейка видна.
            out = ai.run_format("essay", LONG_TEXT)
            check("essay вызывается и валидируется", True)
        except Exception as exc:  # noqa: BLE001
            out = {}
            check("essay вызывается и валидируется", False, f"{type(exc).__name__}: {exc}")
        check("модели уходит ровно одно сообщение", len(calls[0]) == 2, str(len(calls[0])))
        check("системный промпт серверный", calls[0][0]["role"] == "system")
        check("текст сочинения попал в user", "тестовое" in calls[0][1]["content"])
        check("ответ склеен: 10 критериев на 22",
              out.get("max_score") == 22 and len(out.get("criteria", [])) == 10,
              str(sorted(out)))
        check("грамотность без совпадений — полные баллы",
              [c["score"] for c in out.get("criteria", [])[6:]] == [3, 3, 3, 3])

        for label, fmt, text in (
            ("неизвестный формат", "nope", "текст"),
            ("пустой формат", "", "текст"),
            ("пустой текст", "essay", "   "),
            ("не-строковый текст", "essay", 42),
            ("слишком длинный текст", "essay", "я" * (ai.MAX_INPUT_CHARS + 1)),
        ):
            try:
                ai.run_format(fmt, text)
                check(f"отклонено: {label}", False, "принято")
            except ai.AIInputError:
                check(f"отклонено: {label}", True, "AIInputError")
            except Exception as exc:  # noqa: BLE001
                check(f"отклонено: {label}", False, f"{type(exc).__name__}: {exc}")

        # Модель не должна иметь возможности переопределить формат ответа.
        try:
            ai.run_format("essay", None)
            check("text=None отклонён", False, "принято")
        except ai.AIInputError:
            check("text=None отклонён", True, "AIInputError")
    finally:
        ai.chat = original
        ai.lt_check = original_lt


# ---------------------------------------------------------------------------
# 4б. Грамотность: маппинг LanguageTool -> К7-К10 (всё офлайн, lt_check замокан)
# ---------------------------------------------------------------------------
def _lt_match(category: str, rule_id: str, frag: str = "слово", fix: str = "исправление"):
    return {"rule": {"id": rule_id, "category": {"id": category}},
            "message": "сообщение",
            "context": {"text": f"до {frag} после", "offset": 3, "length": len(frag)},
            "replacements": [{"value": fix}]}


def test_grammar(ai) -> None:
    section("score_grammar: детерминированная грамотность без модели")
    original_lt = ai.lt_check
    try:
        ai.lt_check = lambda text: []
        got = ai.score_grammar("Чистый текст без ошибок.")
        check("все 4 критерия на месте", [c["id"] for c in got] == ["K7", "K8", "K9", "K10"])
        check("без совпадений — 3/3/3/3", [c["score"] for c in got] == [3, 3, 3, 3])
        check("комментарий «ошибок нет»", all(c["comment"] == "Ошибок нет." for c in got))

        # Маппинг категорий: опечатка -> К7, запятая -> К8, согласование -> К9.
        ai.lt_check = lambda text: [
            _lt_match("TYPOS", "MORFOLOGIK_RULE_RU_RU", "превет", "привет"),
            _lt_match("PUNCTUATION", "PUNKT_KOTORIJ", "который", "который,"),
            _lt_match("GRAMMAR", "SOGLAS", "уходит", "уходят"),
        ]
        got = ai.score_grammar("текст")
        check("TYPOS -> К7", got[0]["score"] == 2 and "превет" in got[0]["comment"])
        check("PUNCTUATION -> К8", got[1]["score"] == 2)
        check("GRAMMAR -> К9", got[2]["score"] == 2)
        check("К10 не задет чужими категориями", got[3]["score"] == 3)
        check("комментарий называет число", "Ошибок: 1" in got[0]["comment"])

        # Шкала ключей: 2 ошибки -> 2, 3-4 -> 1, 5+ -> 0.
        ai.lt_check = lambda text: [_lt_match("TYPOS", "R", f"слово{i}", f"фикс{i}") for i in range(4)]
        check("четыре ошибки -> 1", ai.score_grammar("т")[0]["score"] == 1)
        ai.lt_check = lambda text: [_lt_match("TYPOS", "R", f"слово{i}", f"фикс{i}") for i in range(5)]
        check("пять ошибок -> 0", ai.score_grammar("т")[0]["score"] == 0)

        # Однотипные повторы — одна ошибка, а не пять.
        ai.lt_check = lambda text: [_lt_match("TYPOS", "R", "превет", "привет") for _ in range(3)]
        check("дедуп однотипных повторов", ai.score_grammar("т")[0]["score"] == 2)

        # Оформление (типографика) и незнакомые категории ученика не наказывают.
        ai.lt_check = lambda text: [
            _lt_match("TYPOGRAPHY", "DASH", "тире", "—"),
            _lt_match("WHITESPACE", "SPACE", "пробел", " "),
            _lt_match("НЕИЗВЕСТНАЯ", "FUTURE_RULE", "х", "у"),
        ]
        check("типографика и неизвестное игнорируются",
              [c["score"] for c in ai.score_grammar("т")] == [3, 3, 3, 3])

        # Отказ сервиса — AIUnavailable (endpoint даст 503), а не тихий пропуск.
        def dead(text):
            raise ai.AIUnavailable("проверка грамотности недоступна: URLError")
        ai.lt_check = dead
        try:
            ai.score_grammar("т")
            check("отказ LanguageTool -> AIUnavailable", False, "исключения не было")
        except ai.AIUnavailable:
            check("отказ LanguageTool -> AIUnavailable", True)
        except Exception as exc:  # noqa: BLE001
            check("отказ LanguageTool -> AIUnavailable", False, f"{type(exc).__name__}: {exc}")
    finally:
        ai.lt_check = original_lt


# ---------------------------------------------------------------------------
# 5. Конфиг и транспорт без сети
# ---------------------------------------------------------------------------
def test_config_and_transport(ai) -> None:
    section("Конфиг и транспорт")
    saved = {k: os.environ.get(k) for k in
             ("AI_API_KEY", "EGE_AI_API_KEY", "AI_BASE_URL", "EGE_AI_BASE_URL",
              "DEFAULT_MODEL", "EGE_AI_MODEL")}
    try:
        for key in saved:
            os.environ.pop(key, None)
        check("без ключа — AIUnavailable, а не KeyError",
              _raises(ai, ai.chat, ai.AIUnavailable, [{"role": "user", "content": "x"}]))
        os.environ["AI_API_KEY"] = "sk-common"
        os.environ["EGE_AI_API_KEY"] = "sk-ege"
        check("приоритет EGE_AI_API_KEY", ai.api_key() == "sk-ege", ai.api_key())
        os.environ.pop("EGE_AI_API_KEY")
        check("fallback на AI_API_KEY", ai.api_key() == "sk-common")
        os.environ["AI_BASE_URL"] = "https://example.invalid/v1/"
        check("base_url без хвостового слэша", ai.base_url() == "https://example.invalid/v1", ai.base_url())
        os.environ["DEFAULT_MODEL"] = "some-model"
        check("модель из DEFAULT_MODEL", ai.model_name() == "some-model")
        check("форматы перечислены", "essay" in ai.format_ids(), str(ai.format_ids()))
        check("balance() без сети = None, не исключение", ai.balance() is None)
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _raises(ai, func, exc_type, *args, **kwargs) -> bool:
    try:
        func(*args, **kwargs)
    except exc_type:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


# ---------------------------------------------------------------------------
# 6. Endpoint поверх живого сервера (temp-БД, сеть заглушена)
# ---------------------------------------------------------------------------
def request(url: str, *, method: str = "GET", body: bytes | None = None,
            content_type: str | None = None, origin: str | None = None,
            sec_fetch_site: str | None = None, cookie: str | None = None):
    headers = {"Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    if origin:
        headers["Origin"] = origin
    if sec_fetch_site:
        headers["Sec-Fetch-Site"] = sec_fetch_site
    if cookie:
        headers["Cookie"] = cookie
    req = Request(url, data=body, headers=headers, method=method)
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers.items()), response.read()


def request_json(url: str, **kwargs):
    status, headers, raw = request(url, **kwargs)
    return status, headers, json.loads(raw or b"{}")


def test_endpoint(server) -> None:
    section("POST /api/ai/essay: маршрутизация, валидация, лимиты, утечки")
    ai = server._AI
    check("модуль ИИ загрузился вместе с сервером", ai is not None)

    httpd = server.create_http_server("127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    original_chat = ai.chat
    original_lt = ai.lt_check
    ai.chat = lambda messages, **kw: json.dumps(valid_payload(), ensure_ascii=False)
    # Офлайн: грамотность отвечает без совпадений (все тройки),
    # склейка даёт 7 (содержание фикстуры) + 12 = 19.
    ai.lt_check = lambda text: []
    saved_key = os.environ.get("AI_API_KEY")
    os.environ["AI_API_KEY"] = FAKE_KEY
    try:
        # Гость: user_for сам выдаёт гостевую сессию и cookie. Cookie должен
        # прийти даже на ошибочном ответе — иначе клиент не сможет удержать
        # лимит, а сервер будет плодить ему новые аккаунты.
        status, headers, _ = request(base + "/api/ai/essay", method="POST", body=b"{}",
                                     content_type="application/json")
        jar = headers.get("Set-Cookie", "").split(";")[0]
        check("гость получает сессию и 400 на пустом теле",
              status == 400 and "ege_session=" in jar, f"{status} {headers.get('Set-Cookie')}")

        def post(payload, **kwargs):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            return request_json(base + "/api/ai/essay", method="POST", body=body,
                                content_type="application/json", cookie=jar, **kwargs)

        ai.reset_ai_rate()
        status, _, body = post({"text": LONG_TEXT})
        check("валидный запрос -> 200", status == 200, f"{status} {body}")
        check("формат в ответе", body.get("format") == "essay")
        check("итог пересчитан сервером", body.get("result", {}).get("total_score") == 19, str(body)[:200])
        check("max_score 22", body.get("result", {}).get("max_score") == 22)
        check("критериев 10: содержание + грамотность",
              len(body.get("result", {}).get("criteria", [])) == 10)
        check("в ответе endpoint нет word_count_status", "word_count_status" not in body.get("result", {}))
        check("ключ не утёк в ответ", FAKE_KEY not in json.dumps(body, ensure_ascii=False))

        # Короткая работа: 0 по всем критериям, при этом 400-а не должно быть —
        # это не ошибка запроса, а оценка.
        ai.reset_ai_rate()
        status, _, body = post({"text": "Короткий текст из трёх слов."})
        check("короткий текст -> 200 с нулём", status == 200, f"{status} {body}")
        check("короткий текст обнулён", body.get("result", {}).get("total_score") == 0, str(body)[:200])
        check("максимумы на месте", body.get("result", {}).get("max_score") == 22)

        for label, payload, expected in (
            ("пустой текст", {"text": "  "}, 400),
            ("не-строковый текст", {"text": 5}, 400),
            ("лишнее поле", {"text": "ок", "model": "cheap"}, 400),
            ("слишком длинный текст", {"text": "я" * (ai.MAX_INPUT_CHARS + 10)}, 400),
        ):
            ai.reset_ai_rate()
            status, _, body = post(payload)
            check(f"{label} -> {expected}", status == expected, f"{status} {str(body)[:160]}")
        check("ошибка ввода не просит повторить",
              "попробуй" not in json.dumps(body, ensure_ascii=False).lower(), str(body)[:160])

        ai.reset_ai_rate()
        status, _, body = request_json(base + "/api/ai/essay", method="POST", body=b'{"text": \xd0\x9e',
                                      content_type="application/json", cookie=jar)
        check("битый JSON -> 400", status == 400, f"{status} {body}")

        status, _, body = request_json(base + "/api/ai/unknown-format", method="POST",
                                      body=json.dumps({"text": "ок"}).encode("utf-8"),
                                      content_type="application/json", cookie=jar)
        check("неизвестный формат -> 404", status == 404, f"{status} {body}")

        status, _, body = request_json(base + "/api/ai/essay/nested", method="POST",
                                      body=json.dumps({"text": "ок"}).encode("utf-8"),
                                      content_type="application/json", cookie=jar)
        check("вложенный путь формата -> 404", status == 404, f"{status} {body}")

        status, _, body = post({"text": "ок"}, sec_fetch_site="cross-site")
        check("cross-site -> 403", status == 403, f"{status} {body}")

        # Модель ответила мусором -> 502, а не «успех» с пустым результатом.
        ai.chat = lambda messages, **kw: "К сожалению, я не смог оценить текст."
        ai.reset_ai_rate()
        status, _, body = post({"text": "Моё сочинение."})
        check("мусор от модели -> 502", status == 502, f"{status} {body}")
        check("ref вместо текста ошибки", "ref" in body and "error" in body, str(body)[:160])
        ai.chat = lambda messages, **kw: json.dumps(valid_payload(), ensure_ascii=False)

        # Исчерпание бюджета: 3 дешёвых 200, дальше 429.
        ai.reset_ai_rate()
        codes = [post({"text": "ок"})[0] for _ in range(5)]
        check("после лимита -> 429", codes[3:] == [429, 429], str(codes))
        status, headers, body = post({"text": "ок"})
        check("429 с Retry-After", headers.get("Retry-After", "").isdigit(), str(headers.get("Retry-After")))
        check("429 объясняет клиенту", "retryAfter" in body, str(body)[:160])
        ai.reset_ai_rate()

        # Регрессия: клиент перестаёт слать cookie и каждый запрос получает
        # нового гостя. Без ключа IP лимит обходится и баланс уходит.
        anonymous = [request_json(base + "/api/ai/essay", method="POST",
                                  body=json.dumps({"text": "ок"}).encode("utf-8"),
                                  content_type="application/json")[0] for _ in range(6)]
        check("сброс cookie не обходит лимит", anonymous[3:] == [429, 429, 429], str(anonymous))
        ai.reset_ai_rate()

        # Провайдер недоступен -> 503 и никакого текста провайдера наружу.
        def boom(messages, **kwargs):
            raise ai.AIUnavailable("AI не настроен")
        ai.chat = boom
        status, _, body = post({"text": "Моё сочинение."})
        check("провайдер недоступен -> 503", status == 503, f"{status} {body}")
        check("внутренняя причина не утёкла", "AI не настроен" not in json.dumps(body, ensure_ascii=False))
        ai.reset_ai_rate()

        # LanguageTool недоступен, а модель ответила: ответа всё равно нет —
        # 503, а не «оценка без грамотности». Без блока К7–К10 итог на 22
        # собрать нельзя, а подменять его нельзя.
        ai.chat = lambda messages, **kw: json.dumps(valid_payload(), ensure_ascii=False)
        def lt_dead(text):
            raise ai.AIUnavailable("проверка грамотности недоступна: URLError")
        ai.lt_check = lt_dead
        status, _, body = post({"text": "Моё сочинение."})
        check("отказ LanguageTool -> 503", status == 503, f"{status} {body}")
        ai.lt_check = lambda text: []
        ai.reset_ai_rate()

        # Сайт продолжает работать: /api/ai/* не должен ломать соседние роуты.
        status, _, body = request_json(base + "/api/support/messages", method="POST",
                                      body=json.dumps({}).encode("utf-8"),
                                      content_type="application/json", cookie=jar)
        check("соседний /api/support/messages жив", status in (400, 403, 405), str(status))
    finally:
        ai.chat = original_chat
        ai.lt_check = original_lt
        ai.reset_ai_rate()
        if saved_key is None:
            os.environ.pop("AI_API_KEY", None)
        else:
            os.environ["AI_API_KEY"] = saved_key
        httpd.shutdown()
        httpd.server_close()


# ---------------------------------------------------------------------------
# 7. Live: настоящий ключ, настоящий провайдер
# ---------------------------------------------------------------------------
def load_live_key() -> str:
    key = (os.environ.get("AI_API_KEY") or os.environ.get("EGE_AI_API_KEY") or "").strip()
    if key:
        return key
    try:
        for line in Path("/etc/ege-2026.env").read_text(encoding="utf-8").splitlines():
            if line.startswith("AI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def test_live(ai) -> None:
    section("LIVE: настоящий вызов провайдера")
    key = load_live_key()
    if not key:
        check("ключ найден", False, "нет AI_API_KEY ни в env, ни в /etc/ege-2026.env")
        return
    os.environ["AI_API_KEY"] = key
    check("ключ найден", True, f"{key[:4]}…{key[-4:]} (len={len(key)})")

    left = ai.balance()
    check("баланс провайдера читается", left is not None, f"balance={left}")

    essay = (
        "Мне кажется, что произведение, о котором идёт речь, называет взросление не "
        "возрастом, а способностью человека отвечать за свой выбор. Автор пишет о "
        "юноше, который постепенно перестаёт прятаться за чужими решениями и "
        "пытается жить так, как сам считает нужным.\n\n"
        "Позиция автора понятна мне так: он не судит героя и не восхищается им, "
        "а наблюдает. Причём автор показывает героя изнутри, не пряча ни сомнений, "
        "ни усталости. В третьем абзаце, где герой впервые поступает сам, а не по "
        "подсказке старших, автор будто отступает в сторону и позволяет читателю "
        "самому сделать вывод. Именно в этом отступлении я вижу главную мысль "
        "произведения: настоящий взрослый человек способен принимать решения, "
        "которые нельзя отменить, даже если они причиняют боль.\n\n"
        "Собственное отношение у меня к этой позиции скорее тёплое, хотя я и не "
        "полностью с ней согласен. Мне близко то, что автор не даёт готовых ответов, "
        "но я считаю, что ему стоило показать последствия ошибок героя ярче, чем он "
        "это делает. Впрочем, возможно, в этом и заключается замысел: читатель "
        "должен сам догадаться, чем всё закончится.\n\n"
        "В шестом предложении второго абзаца есть неточность в формулировке, а в "
        "последнем абзаце я невольно повторяю одно и то же слово дважды, но в целом "
        "работа мне кажется честной и хорошо продуманной."
    )
    ai.reset_ai_rate()
    try:
        result = ai.run_format("essay", essay)
    except (ai.AIError, ai.AIFormatError, ai.AIUnavailable) as exc:
        check("живой вызов вернул валидный результат", False, f"{type(exc).__name__}: {exc}")
        return
    check("живой вызов вернул валидный результат", True)
    check("max_score равен 22", result["max_score"] == 22, str(result["max_score"]))
    check("total_score в диапазоне", 0 <= result["total_score"] <= 22, str(result["total_score"]))
    check("все 10 критериев на месте", len(result["criteria"]) == 10, str(len(result["criteria"])))
    check("критерии по порядку K1..K10",
          [c["id"] for c in result["criteria"]] == [f"K{i}" for i in range(1, 11)])
    check("вердикт непустой", len(result["short_verdict"]) > 10, repr(result["short_verdict"][:60]))
    check("советы непустые", len(result["what_to_improve"]) > 0, str(result["what_to_improve"]))
    check("в живом ответе нет word_count_status", "word_count_status" not in result)
    check("состав живого ответа как в задании",
          sorted(result) == ["criteria", "max_score", "recommendation",
                             "short_verdict", "total_score", "what_to_improve"],
          str(sorted(result)))
    print(f"\n  Живой ответ провайдера ({ai.model_name()}):")
    print(f"    total_score = {result['total_score']} / {result['max_score']}")
    print(f"    short_verdict: {result['short_verdict'][:200]}")
    for criterion in result["criteria"][:3]:
        print(f"    {criterion['id']} {criterion['score']}/{criterion['max_score']}: {criterion['comment'][:120]}")
    print(f"    recommendation: {result['recommendation'][:200]}")
    print(f"    what_to_improve: {result['what_to_improve'][:3]}")
    right = ai.balance()
    if left is not None and right is not None:
        print(f"    баланс: {left:.2f} -> {right:.2f} (списано {left - right:.4f})")


# ---------------------------------------------------------------------------
def main() -> int:
    print("AI-оценка сочинения: офлайн-регрессия" + (" + LIVE" if LIVE else ""))
    ai = load_module("ege_ai_unit", AI_PATH)
    test_extract_json(ai)
    test_validate(ai)
    test_rate_limit(ai)
    test_run_format_input(ai)
    test_grammar(ai)
    test_config_and_transport(ai)

    os.environ["EGE_DB_PATH"] = str(Path(tempfile.mkdtemp(prefix="ege-ai-test-")) / "ege.sqlite3")
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_SUPPORT_SECRET"] = "ege-test-ai-secret-0123456789abcdef"
    server = load_module("ege_ai_endpoint_test", SERVER_PATH)
    conn = server.connect()
    try:
        server.install_catalog(conn)
    finally:
        conn.close()
    test_endpoint(server)

    if LIVE:
        test_live(ai)
    else:
        print("\n(LIVE пропущен: для проверки на настоящем ключе — EGE_AI_LIVE=1)")

    total = _checks["pass"] + _checks["fail"]
    print(f"\n{_checks['pass']}/{total} проверок прошли, {_checks['fail']} провалено")
    return 1 if _checks["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
