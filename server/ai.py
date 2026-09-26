#!/usr/bin/env python3
"""AI transport for EGE CORE.

One OpenAI-compatible HTTP call (`chat`) is the only place that talks to the
provider; everything above it is a *format* — a named prompt + validator
registered in FORMATS. Adding a second assessment therefore means adding one
dict entry, not a new branch in server.py.

The provider key never leaves the process: the browser posts the student's
text and receives the parsed JSON back, nothing else. Upstream error bodies are
never echoed to the client (they can carry account details) — callers get a
short error class plus a server-side ref.

Config (env): AI_API_KEY, AI_BASE_URL, DEFAULT_MODEL, or the EGE_-prefixed
spellings. The prefix wins when both are set, so the file can follow either
convention. The deterministic literacy block (K7–K10) talks to LanguageTool:
EGE_LT_URL (default is the public API; production should point at a
self-hosted server), EGE_LT_TIMEOUT_SEC. Deliberately stdlib-only: server.py
has no third-party imports and this module must not add one.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DEFAULT_BASE_URL = "https://gptunnel.ru/v1"
# Замерено на живой полной рубрике (сочинение ~210 слов, обычный запрос, 5 прогонов):
# qwen3.8-flash — 13–21 с, все ответы в лимите, ошибок формата 0, разброс баллов на
# одном и том же тексте 0–1 при temperature 0. Проверенные альтернативы хуже:
# deepseek-v4.1-flash (завышал, 29× дороже), mimo-v2.6-flash (120 с, завышал сильнее
# всех), gpt-5.6-luna (рвётся на 25-й секунде, нужен response_format), glm-5.3-flash
# (76–92 с), muse-spark-1.3 (69–73 с), minimax-m2.7 (не укладывается в 30 с).
# Правь EGE_AI_MODEL, если нужна другая, но проверяй латентность: клиент ждёт ответ
# вживую, и разброс в 7 баллов на одной работе — это не оценка, а лотерея.
DEFAULT_MODEL = "qwen3.8-flash"
DEFAULT_TIMEOUT_SEC = 90.0
# Оценка обязана быть воспроизводимой: та же работа — тот же балл. Замерено на
# qwen3.8-flash с одной рубрикой: при температуре по умолчанию провайдера (1.0)
# один и тот же текст получал 14 и 21 балл, при 0.0 — 21 и 21. Рубрика:
# «не выдумывай» и «колебайся — ставь 1» лишь сдвигают смещение, а это сужает
# именно случайность.
DEFAULT_TEMPERATURE = 0.0
MAX_INPUT_CHARS = 8000
# A bad or hostile key must not burn the request budget on a long retry loop.
MAX_UPSTREAM_BYTES = 256 * 1024


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return default


def api_key() -> str:
    return _env("EGE_AI_API_KEY", "AI_API_KEY")


def base_url() -> str:
    return _env("EGE_AI_BASE_URL", "AI_BASE_URL", default=DEFAULT_BASE_URL).rstrip("/")


def model_name() -> str:
    return _env("EGE_AI_MODEL", "DEFAULT_MODEL", default=DEFAULT_MODEL)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class AIUnavailable(Exception):
    """No key/base configured, or the provider is out of balance."""


class AIError(Exception):
    """Upstream refused, timed out, or answered with something unusable."""


class AIInputError(Exception):
    """The caller's request is wrong (unknown format, empty/oversized text).

    Distinct from AIFormatError on purpose: this one is our 400, the other is
    an upstream 502. Collapsing them would tell a student to retry a request
    that can never succeed.
    """


class AIFormatError(Exception):
    """The model replied, but the payload does not satisfy the format."""


# ---------------------------------------------------------------------------
# Per-caller budget
#
# The generic /api/ bucket allows 300 req/min per IP, which is survivable for
# SQLite but ruinous for a metered model: one script would drain the balance in
# minutes. The AI bucket is per user, much tighter, and tunable, because the
# right number depends on the price the operator signed up for.
# ---------------------------------------------------------------------------
AI_RATE_MAX = int(_env("EGE_AI_RATE_MAX", default="6") or 6)
AI_RATE_WINDOW_SEC = float(_env("EGE_AI_RATE_WINDOW_SEC", default="3600") or 3600)
_ai_hits: dict[str, list[float]] = {}
_ai_lock = threading.Lock()
# Upstream calls hold a worker thread for the whole round-trip; cap the
# concurrent ones so a burst of essays cannot saturate ThreadingHTTPServer.
AI_MAX_CONCURRENCY = int(_env("EGE_AI_MAX_CONCURRENCY", default="2") or 2)
_ai_slots = threading.Semaphore(AI_MAX_CONCURRENCY)
AI_SLOT_WAIT_SEC = float(_env("EGE_AI_SLOT_WAIT_SEC", default="3") or 3)


def ai_rate_ok(caller: str) -> tuple[bool, int]:
    """(allowed, seconds_until_reset) for one AI call by `caller`."""
    allowed, retry = ai_take([caller])
    return allowed, retry


def ai_take(keys: list[str]) -> tuple[bool, int]:
    """Charge one AI call against every key at once.

    A per-user bucket alone is not a limit: the cookie is the only proof of
    identity, so a client that simply stops sending it gets a brand-new guest —
    and a fresh budget — on every request. Callers therefore also pass an IP
    key, and the call is charged to all keys or to none, so a rejected request
    never burns one bucket while leaving the other intact.
    """
    try:
        now = time.time()
        with _ai_lock:
            buckets: dict[str, list[float]] = {}
            for key in keys:
                name = str(key or "?")
                recent = [t for t in _ai_hits.get(name, []) if now - t < AI_RATE_WINDOW_SEC]
                if len(recent) >= AI_RATE_MAX:
                    return False, max(1, int(AI_RATE_WINDOW_SEC - (now - recent[0])))
                buckets[name] = recent
            for name, recent in buckets.items():
                recent.append(now)
                _ai_hits[name] = recent
        return True, 0
    except Exception:
        # A broken budget must not take the endpoint down with it.
        return True, 0


def reset_ai_rate() -> None:
    """Test hook: forget every recorded AI call."""
    with _ai_lock:
        _ai_hits.clear()


# ---------------------------------------------------------------------------
# Transport — the single call every format goes through
# ---------------------------------------------------------------------------
def chat(messages: list[dict], *, model: str | None = None, timeout: float | None = None,
         max_tokens: int | None = None, temperature: float | None = None) -> str:
    """Send a chat completion and return the assistant text.

    `messages` is the OpenAI shape ([{"role": ..., "content": ...}, ...]) and is
    passed through untouched, which is what makes the call reusable: a format
    only decides what to put in the list.

    The provider expects the raw key in Authorization (no "Bearer " scheme) —
    that is the one non-standard quirk, taken from the working reference
    client. `useWalletBalance` charges the prepaid balance instead of failing
    when it is exhausted mid-request.
    """
    key = api_key()
    if not key:
        raise AIUnavailable("AI не настроен")
    if not isinstance(messages, list) or not messages:
        raise AIError("пустой список сообщений")

    body: dict[str, Any] = {
        "model": model or model_name(),
        "messages": messages,
        "useWalletBalance": True,
    }
    if max_tokens:
        body["max_tokens"] = int(max_tokens)
    body["temperature"] = float(
        DEFAULT_TEMPERATURE if temperature is None else temperature)

    request = urllib.request.Request(
        f"{base_url()}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            # Raw key on purpose — see docstring.
            "Authorization": key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    deadline = float(timeout if timeout is not None else _env("EGE_AI_TIMEOUT_SEC", default=str(DEFAULT_TIMEOUT_SEC)) or DEFAULT_TIMEOUT_SEC)
    try:
        # Слот ждём недолго: вызов занимает минуту, и клиенту честнее сразу
        # получить «занят, попробуй сейчас», чем висеть и потом упасть по
        # таймауту вместе с уже начавшимся вызовом.
        if not _ai_slots.acquire(timeout=AI_SLOT_WAIT_SEC):
            raise AIError("ИИ занят, попробуй через несколько секунд")
        try:
            with urllib.request.urlopen(request, timeout=deadline) as response:
                raw = response.read(MAX_UPSTREAM_BYTES + 1)
        finally:
            _ai_slots.release()
    except urllib.error.HTTPError as exc:
        raise _http_error(exc) from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AIError(f"провайдер недоступен: {type(exc).__name__}") from None

    if len(raw) > MAX_UPSTREAM_BYTES:
        raise AIError("ответ провайдера слишком большой")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise AIError("провайдер вернул не-JSON") from None

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise AIError("неожиданная структура ответа провайдера") from None


def _http_error(exc: urllib.error.HTTPError) -> Exception:
    """Map an upstream status onto our two error classes, body discarded.

    The body is read only to keep the connection tidy and is never returned:
    gateway errors from this provider quote the account and the failing key.
    """
    try:
        exc.read()
    except Exception:
        pass
    status = getattr(exc, "code", 0)
    if status in (401, 403):
        return AIUnavailable("AI не настроен")
    if status == 402:
        return AIUnavailable("на балансе ИИ закончились средства")
    if status == 429:
        return AIError("провайдер временно перегружен")
    return AIError(f"провайдер ответил {status}")


def balance() -> float | None:
    """Remaining prepaid balance, or None when the provider does not report it."""
    key = api_key()
    if not key:
        return None
    request = urllib.request.Request(
        f"{base_url()}/balance?useWalletBalance=true",
        headers={"Authorization": key},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read(MAX_UPSTREAM_BYTES))
    except Exception:
        return None
    try:
        return float(data.get("balance"))
    except (TypeError, ValueError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# JSON extraction
#
# The model is asked for bare JSON but may wrap it in a ```json fence or add a
# sentence of preamble. Both are recoverable; a *truncated* object is not, and
# must surface as an error rather than as a half-filled result.
# ---------------------------------------------------------------------------
def extract_json(text: str) -> dict:
    if not isinstance(text, str):
        raise AIFormatError("ответ не строка")
    body = text.strip()
    if body.startswith("```"):
        body = body.split("\n", 1)[-1] if "\n" in body else body
        if body.rstrip().endswith("```"):
            body = body.rstrip()[:-3]
        body = body.strip()
        if body.lower().startswith("json"):
            body = body[4:].strip()
    start = body.find("{")
    if start < 0:
        raise AIFormatError("в ответе нет JSON-объекта")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(body)):
        char = body[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                chunk = body[start:index + 1]
                try:
                    value = json.loads(chunk)
                except ValueError as exc:
                    raise AIFormatError(f"JSON не разбирается: {exc}") from None
                if not isinstance(value, dict):
                    raise AIFormatError("ожидался JSON-объект")
                return value
    raise AIFormatError("JSON-объект не закрыт — ответ обрезан")


def chat_json(system: str, user: str, **kwargs) -> dict:
    """`chat` plus JSON recovery. The universal entry point for formats."""
    return extract_json(chat([{"role": "system", "content": system},
                              {"role": "user", "content": user}], **kwargs))


# ---------------------------------------------------------------------------
# Formats
#
# A format is data: how to prompt, what to accept. The server dispatches by id
# and never branches on a specific assessment.
# ---------------------------------------------------------------------------
def _clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


# ЕГЭ, сочинение-рассуждение (задание 27).
# (id, название, максимум) — сумма максимумов = 22. Названия короткие, как в
# ответе; полные формулировки критериев живут в _ESSAY_SYSTEM.
# Максимумы живут здесь, а не берутся из ответа модели: иначе модель может
# «повысить» потолок и нарисовать себе 30 из 30.
ESSAY_CRITERIA: tuple[tuple[str, str, int], ...] = (
    ("K1", "Позиция автора", 1),
    ("K2", "Комментарий", 3),
    ("K3", "Собственное отношение", 2),
    ("K4", "Фактическая точность", 1),
    ("K5", "Логичность речи", 2),
    ("K6", "Этические нормы", 1),
    ("K7", "Орфография", 3),
    ("K8", "Пунктуация", 3),
    ("K9", "Грамматика", 3),
    ("K10", "Речевые нормы", 3),
)
ESSAY_MAX_SCORE = sum(item[2] for item in ESSAY_CRITERIA)
# Модель оценивает только содержание (К1–К6): именно там её суждение нужно и
# именно там оно управляемо потолками. Грамотность (К7–К10) уходит в
# детерминированный слой ниже — см. score_grammar.
ESSAY_MODEL_CRITERIA: tuple[tuple[str, str, int], ...] = ESSAY_CRITERIA[:6]
ESSAY_GRAMMAR_CRITERIA: tuple[tuple[str, str, int], ...] = ESSAY_CRITERIA[6:]
# Порог объёма по ФИПИ. Проверяет и применяет его сервер, а не модель: в живой
# проверке модель дважды называла свой собственный порог («минимум 100 слов»,
# потом «минимум 250 слов») и обнуляла работу из-за выдуманного правила.
# Число 150 продублировано в _ESSAY_SYSTEM — тест ai-essay.py падает при расхождении.
ESSAY_MIN_WORDS = 150


def count_words(text: str) -> int:
    return len(text.split())


# ---------------------------------------------------------------------------
# Грамотность (К7–К10) — детерминированный слой вместо модели
#
# Почему не модель: по этим критериям модель либо ставит 3/3 всем подряд, либо
# выдумывает число ошибок, а главное — один и тот же текст получает разные
# баллы (провайдер не гарантирует воспроизводимость даже при temperature 0).
# LanguageTool на одном тексте отвечает одинаково всегда; замер на чистом
# сочинении — 0 ложных срабатываний, явные опечатки ловит все. Цена
# детерминизма — слой КОНСЕРВАТИВЕН: часть пунктуации и почти все речевые
# ошибки он пропускает, то есть К7–К10 — это мягкая верхняя оценка грамотности,
# честная в сторону ученика, а не приговор.
#
# Зависимость: публичный API LanguageTool (бесплатный, ~20 запросов/мин с IP —
# наш лимит ИИ-вызовов гораздо жёстче, так что мы далеки от потолка). Тексты
# сочинений уходят третьей стороне, как уже уходят провайдеру модели.
# Промышленный путь — свой сервер LanguageTool (Java): EGE_LT_URL=
# http://127.0.0.1:8081/v2. Отказ сервиса → AIUnavailable → 503, как отказ
# провайдера: без блока грамотности ответ не собирается, а не подменяется.
# ---------------------------------------------------------------------------
LT_BASE_URL = _env("EGE_LT_URL", "LT_URL",
                   default="https://api.languagetool.org/v2").rstrip("/")
LT_TIMEOUT_SEC = float(_env("EGE_LT_TIMEOUT_SEC", default="15") or 15)

# Категории правил LanguageTool → критерий. Замерено на живых ответах API
# (см. протокол в test/ai-essay.py): TYPOS — опечатки, PUNCTUATION — запятые,
# GRAMMAR — согласование/деепричастия. Речевое (K10) LanguageTool для русского
# почти не ловит — категории на случай, если правило всё же сработает.
_LT_CATEGORY_TO_CRITERION = {
    "TYPOS": "K7",
    "CASING": "K7",        # прописная/строчная буква — орфография по ключам
    "PUNCTUATION": "K8",
    "GRAMMAR": "K9",
    "STYLE": "K10",
    "REDUNDANCY": "K10",
    "REPETITION": "K10",
    "CONFUSED_WORDS": "K10",
    "SEMANTICS": "K10",
    "COLLOQUIALISMS": "K10",
    "MISC": "K10",
}
# Оформление (ё, тире, кавычки, пробелы) по ключам не штрафуется.
_LT_IGNORED_CATEGORIES = {"TYPOGRAPHY", "WHITESPACE"}
# Незнакомая категорию ошибкой не считаем: наказывать ученика за то, что мы
# не смогли классифицировать, нельзя.


def lt_check(text: str) -> list:
    """Один вызов LanguageTool; возвращает сырой список matches.

    Это сетевой шов для тестов: всё ниже (маппинг, дедуп, шкала, комментарии)
    — чистый код и гоняется офлайн на готовых списках совпадений.
    """
    if not LT_BASE_URL:
        raise AIUnavailable("проверка грамотности не настроена")
    body = urllib.parse.urlencode(
        {"text": text, "language": "ru", "enabledOnly": "false"}).encode("utf-8")
    request = urllib.request.Request(
        f"{LT_BASE_URL}/check", data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=LT_TIMEOUT_SEC) as response:
            raw = response.read(MAX_UPSTREAM_BYTES + 1)
    except Exception as exc:  # noqa: BLE001 — любая сетевая/HTTP-ошибка = 503
        raise AIUnavailable(
            f"проверка грамотности недоступна: {type(exc).__name__}") from None
    if len(raw) > MAX_UPSTREAM_BYTES:
        raise AIUnavailable("ответ проверки грамотности слишком большой")
    try:
        matches = json.loads(raw)["matches"]
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise AIUnavailable("проверка грамотности ответила не-JSON") from None
    if not isinstance(matches, list):
        raise AIUnavailable("проверка грамотности: нет списка совпадений")
    return matches


def _essay_band(errors: int) -> int:
    # Шкала ключей: 0 ошибок — 3 балла, одна-две — 2, три-четыре — 1, пять+ — 0.
    if errors <= 0:
        return 3
    if errors <= 2:
        return 2
    if errors <= 4:
        return 1
    return 0


def _lt_fragment(match: dict) -> str:
    context = match.get("context") or {}
    text = context.get("text") or ""
    try:
        off = int(context.get("offset") or 0)
        length = int(context.get("length") or 0)
    except (TypeError, ValueError):
        return ""
    return text[off:off + length].strip()


def _grammar_comment(count: int, matches: list) -> str:
    if not count:
        return "Ошибок нет."
    examples = []
    for match in matches[:3]:
        frag = _lt_fragment(match)
        repls = match.get("replacements") or []
        fix = _clean_text(repls[0].get("value")) if repls and isinstance(repls[0], dict) else ""
        if frag and fix:
            examples.append(f"«{frag}» → «{fix}»")
        elif frag:
            examples.append(f"«{frag}»")
    more = " и ещё" if count > 3 else ""
    shown = "; ".join(examples)
    return f"Ошибок: {count}{more}" + (f" ({shown})." if shown else ".")


def score_grammar(text: str) -> list:
    """К7–К10 по совпадениям LanguageTool: маппинг, дедуп, шкала, комментарий.

    Однотипные повторы (тот же rule.id и тот же фрагмент) считаются одной
    ошибкой — так ключи трактуют однотипные ошибки.
    """
    by_criterion: dict[str, list] = {cid: [] for cid, _n, _m in ESSAY_GRAMMAR_CRITERIA}
    seen: set = set()
    for match in lt_check(text):
        if not isinstance(match, dict):
            continue
        rule = match.get("rule") or {}
        category = (rule.get("category") or {}).get("id") or ""
        if category in _LT_IGNORED_CATEGORIES:
            continue
        cid = _LT_CATEGORY_TO_CRITERION.get(category)
        if cid is None:
            continue
        key = (str(rule.get("id") or ""), _lt_fragment(match).lower())
        if key in seen:
            continue
        seen.add(key)
        by_criterion[cid].append(match)
    criteria = []
    for cid, name, official_max in ESSAY_GRAMMAR_CRITERIA:
        found = by_criterion[cid]
        criteria.append({"id": cid, "name": name,
                         "score": _essay_band(len(found)), "max_score": official_max,
                         "comment": _grammar_comment(len(found), found)})
    return criteria


_ESSAY_SYSTEM = """СИТУАЦИЯ

Ученик прочитал литературный текст и написал по нему сочинение-рассуждение: назвал \
проблему, прокомментировал позицию автора примерами, высказал своё отношение к ней. \
Ты — эксперт ЕГЭ по русскому языку. Ты проверяешь СОДЕРЖАНИЕ работы этого ученика \
по критериям К1–К6 и честно показываешь, сколько баллов оно стоит.

Грамотность (орфографию, пунктуацию, грамматику и речевые нормы, К7–К10) проверяет \
отдельный автоматический инструмент. Ты её НЕ оцениваешь: этих критериев в твоей \
работе и в твоём ответе нет, а опечатки в тексте сочинения игнорируй.

Тебе передан только текст сочинения. Исходный текст, который читал ученик, тебе не \
передали, и ты его не знаешь.

ИСХОДНЫЙ ТЕКСТ НЕ ДАН, и это нормально: проверять надо работу ученика, а не сверять её \
с книгой. Из-за этого:
- не снимай балл за то, что не можешь сверить цитату или деталь с источником;
- пример, который приводит ученик, оцени по тому, есть ли он, объяснён ли и связан ли с \
другим, а не по тому, действителен ли;
- «я не помню эту книгу» никогда не повод снизить балл.

Доступно тебе и действительно имеет значение: названа ли проблема, высказана ли позиция, \
есть ли примеры с пояснениями и связью между ними, обосновано ли отношение. \
Оценивай то, что перед тобой.

ПОРЯДОК РАБОТЫ (в ответ не выводи)

1. Содержание: К1, затем К2 и К3, затем К4, К5, К6.
2. Собери ответ.

КРИТЕРИИ ОЦЕНИВАНИЯ (К1–К6)

Максимальный первичный балл: 10

Важные общие правила:
- Работа, написанная без опоры на прочитанный исходный текст (не по данному \
тексту), не оценивается (0 баллов).
- Если сочинение представляет собой полностью переписанный или пересказанный \
исходный текст без каких-либо комментариев — 0 баллов.
- Пример-аргумент в К3 не должен повторять авторских суждений из исходного текста.
- Не принимаются в качестве примера-аргумента: комикс, аниме, манга, фанфик, \
графический роман, компьютерная игра и подобные источники.

Формулировка задания 27:
Напишите сочинение-рассуждение по проблеме, поставленной в исходном тексте: «...».
Сформулируйте позицию автора (рассказчика) по указанной проблеме.
Прокомментируйте, как в тексте раскрывается эта позиция. Включите в комментарий \
два примера-иллюстрации из прочитанного текста, важных для понимания позиции автора \
(рассказчика), и поясните их. Укажите и поясните смысловую связь между приведёнными \
примерами-иллюстрациями.
Сформулируйте и обоснуйте своё отношение к позиции автора (рассказчика) по проблеме \
исходного текста. Включите в обоснование пример-аргумент, опираясь на читательский, \
историко-культурный или жизненный опыт. (Не учитываются примеры-аргументы, \
источниками которых являются комикс, аниме, манга, фанфик, графический роман, \
компьютерная игра и другие подобные виды представления информации.)

I. Содержание сочинения

К1. Отражение позиции автора (рассказчика) по указанной проблеме исходного текста
1 балл — Позиция автора (расказчика) по указанной проблеме исходного текста \
сформулирована верно.
0 баллов — Позиция автора (расказчика) по указанной проблеме исходного текста не \
сформулирована или сформулирована неверно.
Оценивай по тексту самого сочинения: есть ли позиция по той проблеме, которую \
сочинение само заявило, и отвечает ли она именно на неё.
Важное указание: если по К1 выставлено 0 баллов, то по К2 ставь не выше 1 и по К3 \
не выше 1: без позиции полноценного комментария и обоснованного отношения быть не \
может, но обнулять эти критерии полностью нельзя. К4–К6 от К1 не зависят.
Одна погрешность относится ровно к одному критерию.

К2. Комментарий к позиции автора (рассказчика) по указанной проблеме исходного текста
3 балла — Позиция автора прокомментирована с опорой на исходный текст. Приведено 2 \
примера-иллюстрации из прочитанного текста, важных для понимания позиции автора. \
Дано пояснение к каждому из примеров. Указана смысловая связь между примерами и \
дано пояснение к ней.
2 балла — Позиция автора прокомментирована с опорой на исходный текст. Приведено 2 \
примера-иллюстрации, дано пояснение к каждому. Смысловая связь не указана, или не \
дано её пояснение, или дано неверное пояснение.
1 балл — Позиция автора прокомментирована с опорой на исходный текст. Приведён 1 \
пример-иллюстрация с пояснением к нему.
0 баллов — Приведён 1 пример без пояснения; или ни одного примера; или комментарий \
без опоры на текст; или простой пересказ; или большая цитата вместо комментария; или \
позиция не прокомментирована.
Указания: пример-иллюстрация без пояснения не засчитывается. Фактическая ошибка в \
комментарии учитывается по критерию К4. Оценивай структуру изложения, а не точность \
цитат.

К3. Собственное отношение к позиции автора (рассказчика) по указанной проблеме \
исходного текста
2 балла — Собственное отношение сформулировано и обосновано. Приведён пример-аргумент.
1 балл — Отношение сформулировано и обосновано, но пример-аргумент не приведён. ИЛИ \
Приведён пример-аргумент, но отношение заявлено формально (например: «Я согласен / \
не согласен с автором»).
0 баллов — Отношение заявлено лишь формально; или не сформулировано и не обосновано; \
или не соответствует проблеме; или пример-аргумент не подходит.
ВАЖНО про слово «формально». Оно означает отсутствие обоснования, а не наличие слов \
«я согласен». Примени такой приём: убери из текста слова «я согласен с автором» — если \
после этого всё ещё есть мысль с «потому что», с описанием жизни, с примером из \
прочитанного или с примером-аргументом, то отношение обосновано, и это 2 балла. Если \
после удаления ничего не остаётся — вот это и есть «лишь формально». \
Пример-аргумент из опыта может быть коротким и бытовым: «сегодня люди так же уходят в \
алгоритмы, чтобы не слышать прямой ответ» — это полноценный пример-аргумент на 2 балла. \
Не вычитай балл за то, что пример не из учебника. \
Указания: источник примера-аргумента — читательский, историко-культурный или \
жизненный опыт. Не принимаются: комикс, аниме, манга, фанфик, графический роман, \
компьютерная игра. Пример-аргумент не должен повторять авторских суждений из \
исходного текста.

II. Речевое оформление сочинения

К4. Фактическая точность речи
1 балл — Фактические ошибки отсутствуют.
0 баллов — Допущена одна фактическая ошибка или более.
Ошибкой считай утверждение сочинения, которое противоречит общеизвестному \
содержанию: неверный сюжет, герой, авторство, цитата, исторический факт. Не придумывай \
сцен, которых в сочинении нет.

К5. Логичность речи
2 балла — Логические ошибки отсутствуют.
1 балл — Допущены одна-две логические ошибки.
0 баллов — Допущены три логические ошибки или более.
Логическая ошибка — это только явное противоречие внутри самого сочинения или вывод, \
не следующий из предыдущей фразы ученика. Это НЕ фактическая ошибка (она в К4), НЕ \
промах К1, НЕ слабый аргумент и НЕ речь. Не набирай низкий балл за счёт \
ошибок из других критериев.

К6. Соблюдение этических норм
1 балл — Этические ошибки отсутствуют.
0 баллов — В работе приводятся примеры экстремистских и/или иных запрещённых \
материалов / социально неприемлемого поведения / имеются высказывания, нарушающие \
законодательство РФ.
Жёсткая оценка произведения и бытовой пример нарушением не считаются.

Максимальный балл за содержание: 10 (К1–К6)

КАК ЧИТАТЬ КРИТЕРИИ

«Пример из текста» — это пример, который приводит ученик в своём сочинении. Проверяй три \
вещи: пример есть, он пояснён, два примера связаны. Не проверяй, совпадает ли он с книгой, \
и отсутствие книги не считай поводом снизить балл.

ПОТОЛКИ — соблюдай буквально, они важнее твоей собственной оценки

- Проблема названа и позиция высказана в явном виде («проблема такая-то, автор считает, \
что...») → К1 = 1. Ставь 0 только если позиции нет совсем или она противоречит самому \
сочинению.
- Нет ни одного примера с пояснением → К2 = 0.
- Ровно один пример с пояснением, либо есть примеры без пояснений → К2 не выше 1.
- Нет пояснения к смысловой связи между двумя примерами → К2 не выше 2.
- За словами «я согласен» / «я не согласен» стоит обоснование и пример из опыта → К3 = 2, \
а не 1. Эти слова сами по себе не порок.
- За формулой («я согласен с автором и считаю его правым») ничего нет: ни «потому что», \
ни примера → К3 не выше 1.
- Пример-аргумент повторяет суждения автора → К3 не выше 1.
- Позиции нет (К1 = 0) → К2 не выше 1 и К3 не выше 1.
- Логическое противоречие внутри сочинения единственное → К5 = 1, не 0.

СЧЁТ В КОММЕНТАРИИ

В comment называй число, по которому ставишь балл: у К2 — «примеров: 2», у К3 — \
«аргументов из опыта: 0». Число обязано сходиться с баллом. Посчитал примеры, а \
поставил полный балл — вернись и пересчитай.

ПОЛОСЫ РАБОТЫ (итог содержания из 10)

2 — позиции нет, примеров нет, отношение не высказано. К1 = 0, К2 и К3 не выше 1, \
остальное — только факты, логика, этика.
6 — позиция есть, но пример один или без пояснений, связь не объяснена, отношение \
обосновано слабо.
9–10 — два примера с пояснениями и связью, отношение с примером из опыта.

Нераспространённая работа стоит 2–4, а не 8. Оценивай текст, а не впечатление от него.

ТРЕБОВАНИЯ К ПОЛЯМ

- comment: что именно повлияло на балл. Не длиннее 2 предложений, без цитат целиком — \
называй ошибку словами. Если сработал потолок из-за К1 — напиши об этом прямо.
- what_to_improve: 2–5 конкретных правок, каждая — отдельная строка, без пунктов с \
оценками в баллах.
- recommendation: 1–2 предложения, один самый полезный следующий шаг.
- short_verdict: 2–3 предложения, что получилось и что не получилось. В текстовых \
полях запрещены числа баллов, «из 10», итог и любые слова про объём текста, число \
слов и порог.
- Если ошибок нет — пиши «ошибок нет».

ФОРМАТ ОТВЕТА — соблюдай строго:
1. Ответ — ТОЛЬКО один JSON-объект. Ничего до и после: ни пояснений, ни markdown, \
ни обрамления ```.
2. В JSON нет комментариев. Ни //, ни /* */. Только пары "ключ": значение.
3. Все строки на русском языке, без переносов строк внутри значений.
4. Идентификаторы критериев строго K1..K6, каждый ровно один раз, в этом порядке. \
Порядок полей соблюдай: сначала критерии, потом правки и рекомендация, и short_verdict \
строго последним полем объекта.
5. score — целое число от 0 до max_score соответствующего критерия.
6. Не выдумывай ошибки: если ошибок нет, ставь полный балл и пиши об этом прямо.
7. Не выдумывай собственные пороги и правила: применяй только то, что написано выше.

Перед ответом проверь себя: при К1 = 0 выставлены потолки К2 не выше 1 и К3 не выше 1; \
К5 = 0 выставлен лишь при трёх логических ошибках самого сочинения; в текстовых полях \
нет чисел баллов и слов про объём; критериев ровно шесть.

Схема ответа:
{
  "total_score": <целое>,
  "max_score": 10,
  "criteria": [
    {"id": "K1", "name": "Позиция автора", "score": <целое>, "max_score": 1, "comment": "что повлияло на балл"},
    {"id": "K2", "name": "Комментарий", "score": <целое>, "max_score": 3, "comment": "что повлияло на балл"},
    {"id": "K3", "name": "Собственное отношение", "score": <целое>, "max_score": 2, "comment": "что повлияло на балл"},
    {"id": "K4", "name": "Фактическая точность", "score": <целое>, "max_score": 1, "comment": "что повлияло на балл"},
    {"id": "K5", "name": "Логичность речи", "score": <целое>, "max_score": 2, "comment": "что повлияло на балл"},
    {"id": "K6", "name": "Этические нормы", "score": <целое>, "max_score": 1, "comment": "что повлияло на балл"}
  ],
  "what_to_improve": ["2-5 конкретных правок, каждая — отдельная строка"],
  "recommendation": "1-2 предложения: один самый полезный следующий шаг",
  "short_verdict": "2-3 предложения: что получилось и что нет, ПОСЛЕДНИМ полем"
}"""


def _essay_user(text: str) -> str:
    return f"Объём работы: {count_words(text)} слов.\n\n--- ТЕКСТ СОЧИНЕНИЯ ---\n{text}"


def validate_essay(raw: dict, words: int = 0) -> dict:
    """Проверяет содержательную разметку модели (К1–К6) и пересчитывает итоги.

    `total_score` и `max_score` не берутся из ответа, а считаются заново:
    модель ненадёжна в арифметике, и ученик никогда не должен увидеть итог,
    противоречащий разбору выше. Грамотность (К7–К10) сюда не попадает — её
    добавляет merge_essay после детерминированной проверки.

    Правило объёма — тоже наше. Ниже ESSAY_MIN_WORDS вся работа стоит 0 по
    ключу ФИПИ — применяется здесь, даже если модель раздала баллы: в живом
    прогоне она выдумывала свои пороги («минимум 100», потом «минимум 250»)
    и обнуляла нормальные работы по выдуманной причине. Fail-closed: короткая
    работа никогда не набирает больше 0, длинная сохраняет оценку модели.
    """
    criteria_in = raw.get("criteria")
    if not isinstance(criteria_in, list) or not criteria_in:
        raise AIFormatError("нет списка критериев")
    by_id: dict[str, dict] = {}
    for item in criteria_in:
        if not isinstance(item, dict):
            raise AIFormatError("критерий не объект")
        cid = _clean_text(item.get("id")).upper()
        if cid in by_id:
            raise AIFormatError(f"критерий {cid} продублирован")
        by_id[cid] = item

    # Модель отвечает только за содержание: К7–К10 в её ответе — нарушение
    # схемы, а не «лишнее, которое можно выкинуть». Выкидывать молча нельзя:
    # merge ниже добавил бы свои К7–К10, и клиент получил бы критерии дважды.
    model_ids = {cid for cid, _n, _m in ESSAY_MODEL_CRITERIA}
    stray = sorted(set(by_id) - model_ids)
    if stray:
        raise AIFormatError(f"модель вернула чужие критерии: {', '.join(stray)}")
    too_short = words < ESSAY_MIN_WORDS
    criteria: list[dict] = []
    total = 0
    expected_max = 0
    for cid, name, official_max in ESSAY_MODEL_CRITERIA:
        item = by_id.get(cid)
        if item is None:
            raise AIFormatError(f"нет критерия {cid}")
        try:
            max_score = int(item["max_score"])
            score = int(item["score"])
        except (KeyError, TypeError, ValueError):
            raise AIFormatError(f"критерий {cid}: баллы не числа") from None
        if max_score != official_max:
            raise AIFormatError(f"критерий {cid}: max_score должен быть {official_max}")
        if score < 0 or score > max_score:
            raise AIFormatError(f"критерий {cid}: балл вне диапазона")
        comment = _clean_text(item.get("comment"))
        if not comment:
            raise AIFormatError(f"критерий {cid}: пустой комментарий")
        if too_short:
            score = 0
        total += score
        expected_max += max_score
        criteria.append({"id": cid, "name": name, "score": score,
                         "max_score": max_score, "comment": comment})

    model_max = sum(item[2] for item in ESSAY_MODEL_CRITERIA)
    if expected_max != model_max:
        raise AIFormatError(f"сумма максимумов {expected_max}, а должно быть {model_max}")

    verdict = _clean_text(raw.get("short_verdict"))
    if not verdict:
        raise AIFormatError("пустой short_verdict")
    improve = [_clean_text(x) for x in (raw.get("what_to_improve") or []) if _clean_text(x)]
    recommendation = _clean_text(raw.get("recommendation"))

    # Порядок полей совпадает со схемой: вердикт последний, чтобы клиент
    # получал критерии раньше итоговой фразы (и при стриминге — по очереди).
    return {
        "total_score": total,
        "max_score": expected_max,
        "criteria": criteria,
        "what_to_improve": improve,
        "recommendation": recommendation,
        "short_verdict": verdict,
    }


def merge_essay(partial: dict, grammar: list, words: int = 0) -> dict:
    """Склеивает содержание (К1–К6 от модели) и грамотность (К7–К10 из
    детерминированной проверки) в единый ответ на 22 балла.

    Баллы грамотности всё равно перепроверяются и зажимаются в максимум:
    это наш код, но контракт ответа клиенту не должен зависеть от того,
    кто его заполнил. Короткая работа обнуляет и этот блок — по ключу.
    """
    criteria = list(partial["criteria"])
    total = partial["total_score"]
    too_short = words < ESSAY_MIN_WORDS
    by_id = {c.get("id"): c for c in grammar if isinstance(c, dict)}
    for cid, name, official_max in ESSAY_GRAMMAR_CRITERIA:
        item = by_id.get(cid) or {}
        try:
            score = int(item.get("score", 0))
        except (TypeError, ValueError):
            score = 0
        score = max(0, min(score, official_max))
        comment = _clean_text(item.get("comment")) or "Ошибок нет."
        if too_short:
            score = 0
        total += score
        criteria.append({"id": cid, "name": name, "score": score,
                         "max_score": official_max, "comment": comment})

    return {
        "total_score": total,
        "max_score": ESSAY_MAX_SCORE,
        "criteria": criteria,
        "what_to_improve": partial["what_to_improve"],
        "recommendation": partial["recommendation"],
        "short_verdict": partial["short_verdict"],
    }


FORMATS: dict[str, dict] = {
    "essay": {
        "max_input_chars": MAX_INPUT_CHARS,
        "system": _ESSAY_SYSTEM,
        "user": _essay_user,
        "validate": validate_essay,
        # Детерминированный блок: грамотность считается без модели, затем
        # merge склеивает обе части в ответ на 22 балла.
        "grammar": score_grammar,
        "merge": merge_essay,
    },
}


def format_ids() -> list[str]:
    return sorted(FORMATS)


def run_format(format_id: str, text: str) -> dict:
    """Validate the input, call the model, return the normalised result.

    Only `text` is accepted from the caller: the model, the system prompt and
    the rubric are server-side, so a client cannot point the metered call at a
    cheaper model or rewrite the grading instructions.

    If a format declares a deterministic block ("grammar" + "merge"), both
    halves run in parallel: the model takes 13–21 с, LanguageTool — 1–3 с,
    so the literacy block adds no latency to the wait.
    """
    spec = FORMATS.get(_clean_text(format_id))
    if spec is None:
        raise AIInputError("неизвестный формат")
    body = _clean_text(text)
    if not body:
        raise AIInputError("пустой текст")
    if len(body) > spec["max_input_chars"]:
        raise AIInputError("текст длиннее лимита")
    words = count_words(body)
    grammar_fn = spec.get("grammar")
    if grammar_fn is None:
        return spec["validate"](chat_json(spec["system"], spec["user"](body)), words)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        model_future = pool.submit(chat_json, spec["system"], spec["user"](body))
        grammar_future = pool.submit(grammar_fn, body)
        partial = spec["validate"](model_future.result(), words)
        grammar = grammar_future.result()
    return spec["merge"](partial, grammar, words)
