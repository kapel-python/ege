#!/usr/bin/env python3
"""Минутные самопроверки для страницы /status.

Каждую минуту сервер сам прогоняет короткие проверки по всем разделам,
которые видят пользователи (API, материалы, ИИ, ИИ-провайдеры,
проверка сочинений), и страница показывает их результат. Это замена прежней
логики «показываем последнее известное и ничего не трогаем»: последнее
известное врало после рестартов, а живого подтверждения работы не было.

Почему проверки идут ПОСЛЕДОВАТЕЛЬНО (по одной), а не параллельно все сразу:
проверка бежит каждую минуту на проде, рядом с живыми запросами учеников.
Параллельный залп давал бы пилу нагрузки (N потоков рвут одни и те же
таблицы SQLite, где пишет только один, — параллельные читатели встают за
пишущей транзакцией разом и держат соединения дольше), а выигрыш был бы
шумом: каждая проверка — миллисекунды локальной работы, общий прогон и так
укладывается в пару секунд. Последовательно = предсказуемая ровная
нагрузка, детерминированный порядок в ответе и простая атрибуция упавшей
проверки. Параллелизм здесь экономил бы доли секунды ценой риска
подтормаживания живых запросов — ученики важнее.

Что проверки НЕ делают (осознанно, это не упущение):
- ни одного живого вызова к ИИ-провайдерам («привет» за деньги каждый
  минуту = ~43 тыс. платных запросов в месяц с провайдера плюс риск
  упереться в rate limit шлюза; живым сигналом остаются реальный трафик
  учеников и фоновая проба раз в 15 минут);
- ни одной записи в БД (только SELECT через короткие read-only соединения —
  проверки не заводят аккаунтов, не тратят квоты, не пишут в ленту);
- ни одного запроса к LanguageTool (внешняя зависимость с чужой
  доступностью; её отказ честно виден по реальному трафику проверок).

Как это устроено: фоновый поток (start_loop, стартует в run_server рядом с
пробой failover) раз в CHECKS_INTERVAL_SEC прогоняет run_all_checks и кладёт
результат в память; /api/status отдаёт кэш полем checks (никакого нового
анонимного эндпоинта — значит, и новых лимитов не нужно: страница опрашивает
тот же /api/status раз в минуту, как раньше). Проверок нет первые секунды
после старта — страница тогда показывает только services, это честно.

Deliberately stdlib-only, как server.py и ai.py.
"""
from __future__ import annotations

import threading
import time

# Как часто прогонять проверки: страница опрашивает /api/status раз в минуту,
# и серверный кэш живёт столько же — каждый опрос видит свежий прогон.
CHECKS_INTERVAL_SEC = 60.0
# Проверка обязана быть миллисекундной локальной работой; потолок — страховка
# от зависшего вызова, а не норма (норма — десятки миллисекунд).
CHECK_TIMEOUT_SOFT_SEC = 5.0

_checks_lock = threading.Lock()
_cached: dict = {"items": None, "checkedAt": 0, "durationMs": 0}


def cached_checks() -> dict | None:
    """Последний прогон для /api/status: {items, checkedAt, ageSec, durationMs}.

    None — прогон ещё не успел (первые секунды после старта). Не бросает."""
    try:
        with _checks_lock:
            items = _cached.get("items")
            checked_at = int(_cached.get("checkedAt") or 0)
            duration = int(_cached.get("durationMs") or 0)
        if not items:
            return None
        now_ms = int(time.time() * 1000)
        return {"items": items, "checkedAt": checked_at,
                "ageSec": max(0, (now_ms - checked_at) // 1000),
                "durationMs": duration}
    except Exception:
        return None


def _run_one(check_id: str, label: str, fn) -> dict:
    """Одна проверка с замером времени. Никогда не бросает: неуспех проверки —
    это данные (ok=False), а не падение прогона."""
    started = time.monotonic()
    try:
        ok, detail = fn()
        ok = bool(ok)
        detail = str(detail or "")
    except Exception as exc:  # noqa: BLE001 — проверка не роняет прогон
        ok, detail = False, "Временно недоступно"
    latency = int((time.monotonic() - started) * 1000)
    if latency > int(CHECK_TIMEOUT_SOFT_SEC * 1000):
        ok = False
        detail = (detail + f" (превышен потолок {int(CHECK_TIMEOUT_SOFT_SEC)} с)").strip()
    return {"id": str(check_id), "label": str(label), "ok": ok,
            "detail": detail, "latencyMs": latency}


def run_all_checks(ctx: dict) -> list[dict]:
    """Весь прогон ПОСЛЕДОВАТЕЛЬНО, по одной проверке. ctx — зависимости от
    сервера (передаёт run_server, чтобы у модуля не было импорта server.py):
      counts() -> (subjects, skills, tasks, lessons) — дешёвые COUNT(*) по
        read-only соединению, те же таблицы, что видит ученик;
      agent_health() -> dict — _AGENT.public_agent_health();
      ai_health() -> dict — _AI.public_ai_health() (слитые тиры, без сети);
      ai_order() -> list — _AI.effective_priority("free") + ("plus");
      essay_judge() -> (free_judge|None, plus_judge|None);
      essay_ready() -> (tables_ok, rubric_version);
      probe_age_sec() -> float|None — возраст последнего тика фоновой пробы
        (None — поток проб не стартовал);
      age_fmt(ts_ms, now_ms) -> str — человеческий возраст метки (_age_ru).
    Возвращает список в фиксированном порядке — страница рисует как есть."""
    ctx = ctx if isinstance(ctx, dict) else {}

    def check_api():
        counts = ctx.get("counts")
        if not callable(counts):
            return False, "Временно недоступно"
        subjects, skills, tasks, lessons = counts()
        subjects, skills, tasks = int(subjects), int(skills), int(tasks)
        if subjects <= 0 or skills <= 0 or tasks <= 0:
            return False, "Временно недоступно"
        return True, (f"{subjects} предм., {skills} тем, {tasks} заданий — отвечают")

    def check_content():
        counts = ctx.get("counts")
        if not callable(counts):
            return False, "Временно недоступно"
        subjects, skills, tasks, lessons = (int(v) for v in counts())
        if lessons <= 0:
            return False, "Материалы временно недоступны"
        if tasks <= 0:
            return False, "Материалы временно недоступны"
        return True, f"Тем: {skills}, заданий: {tasks}, уроков: {lessons}"

    def check_agent():
        fn = ctx.get("agent_health")
        if not callable(fn):
            return False, "ИИ временно недоступен"
        health = fn() or {}
        tools = [t for t in (health.get("tools") or []) if t]
        missing = [t for t in (health.get("missing") or []) if t]
        if missing:
            return False, "ИИ временно недоступен"
        if not tools:
            return False, "ИИ временно недоступен"
        return True, f"{len(tools)} инструментов подключены"

    def check_ai():
        fn = ctx.get("ai_health")
        if not callable(fn):
            return False, "Временно недоступно"
        health = fn() or {}
        providers = [p for p in (health.get("providers") or []) if isinstance(p, dict)]
        configured = [p for p in providers if p.get("configured")]
        if not configured:
            return False, "Провайдеры не настроены"
        order_fn = ctx.get("ai_order")
        order = []
        if callable(order_fn):
            try:
                order = [x for x in (order_fn() or []) if x]
            except Exception:
                order = []
        if not order:
            return False, "Временно недоступно"
        last_ok = 0
        for p in configured:
            try:
                last_ok = max(last_ok, int(p.get("lastOkAt") or 0))
            except (TypeError, ValueError):
                pass
        try:
            last_ok = max(last_ok, int(((health.get("router") or {}).get("lastOkAt")) or 0))
        except (TypeError, ValueError):
            pass
        last_err = 0
        for p in configured:
            try:
                last_err = max(last_err, int(p.get("lastErrorAt") or 0))
            except (TypeError, ValueError):
                pass
        try:
            last_err = max(last_err, int(((health.get("router") or {}).get("lastErrorAt")) or 0))
        except (TypeError, ValueError):
            pass
        age_fn = ctx.get("age_fmt")
        now_ms = int(time.time() * 1000)
        if last_err > last_ok:
            age = age_fn(last_err, now_ms) if callable(age_fn) else ""
            return False, f"Последняя ошибка {age}".strip()
        if last_ok > 0:
            age = age_fn(last_ok, now_ms) if callable(age_fn) else ""
            detail = f"Последний запрос успешен · {age}".strip()
        else:
            detail = "Нет данных — покажет первый запрос"
        probe_fn = ctx.get("probe_age_sec")
        probe_age = None
        if callable(probe_fn):
            try:
                probe_age = probe_fn()
            except Exception:
                probe_age = None
        if probe_age is not None and probe_age > 300:
            return False, "Временно недоступно"
        return True, detail

    def check_essays():
        fn = ctx.get("essay_ready")
        if not callable(fn):
            return False, "Проверка сочинений временно недоступна"
        tables_ok, rubric = fn()
        if not tables_ok:
            return False, "Проверка сочинений временно недоступна"
        try:
            rubric = int(rubric or 0)
        except (TypeError, ValueError):
            rubric = 0
        if rubric <= 0:
            return False, "Проверка сочинений временно недоступна"
        judge_fn = ctx.get("essay_judge")
        judge = None
        if callable(judge_fn):
            try:
                judges = judge_fn()
                judge = (judges[0] if judges else None) or (judges[1] if len(judges) > 1 else None)
            except Exception:
                judge = None
        if not judge:
            return False, "Проверка сочинений временно недоступна"
        return True, "Работает"

    plan = [
        ("api", "API", check_api),
        ("content", "Материалы", check_content),
        ("agent", "ИИ", check_agent),
        ("ai", "ИИ-провайдеры", check_ai),
        ("essays", "Проверка сочинений", check_essays),
    ]
    # Последовательно: см. шапку модуля, почему не параллельно.
    return [_run_one(cid, label, fn) for cid, label, fn in plan]


def run_and_store(ctx: dict) -> list[dict]:
    """Один прогон с сохранением в кэш. Возвращает items. Не бросает."""
    started = time.monotonic()
    try:
        items = run_all_checks(ctx)
    except Exception:  # noqa: BLE001 — кэш лучше пустой, чем протухший вполовину
        items = []
    duration = int((time.monotonic() - started) * 1000)
    try:
        with _checks_lock:
            if items:
                _cached["items"] = items
                _cached["checkedAt"] = int(time.time() * 1000)
                _cached["durationMs"] = duration
            else:
                _cached["durationMs"] = duration
    except Exception:
        pass
    return items


def start_loop(stop: threading.Event, ctx_factory) -> threading.Thread:
    """Фоновый поток минутных проверок. Первый прогон — сразу (всё локальное,
    миллисекунды), дальше раз в CHECKS_INTERVAL_SEC. Не падает никогда:
    ctx_factory без сервера означает «проверять нечего», поток просто спит."""
    def run() -> None:
        try:
            ctx = ctx_factory() if callable(ctx_factory) else {}
            run_and_store(ctx)
        except Exception:  # noqa: BLE001 — фон не должен падать
            pass
        while not stop.is_set():
            if stop.wait(CHECKS_INTERVAL_SEC):
                return
            try:
                ctx = ctx_factory() if callable(ctx_factory) else {}
                run_and_store(ctx)
            except Exception:  # noqa: BLE001 — фон не должен падать
                pass

    thread = threading.Thread(target=run, name="ege-health-checks", daemon=True)
    thread.start()
    return thread
