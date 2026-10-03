#!/usr/bin/env python3
"""Роутер ИИ-провайдеров: приоритет CloseRouter, бесшовный failover на
gptunnel при отказе, часовой probe восстановления и системные обращения
в ленте админа при смене провайдера.

Офлайн: сеть заглушена на уровне ai._chat_via / urllib.request.urlopen,
состояние роутера — в temp-БД (EGE_DB_PATH), прод не трогается. Запуск из
корня репозитория: python3 test/ai-failover.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AI_PATH = ROOT / "server" / "ai.py"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)) if detail else ''}")


def section(title):
    print(f"\n== {title} ==")


ENV_KEYS = ("AI_API_KEY", "EGE_AI_API_KEY", "AI_BASE_URL", "EGE_AI_BASE_URL",
            "DEFAULT_MODEL", "EGE_AI_MODEL",
            "CLOSEROUTER_API_KEY", "EGE_CLOSEROUTER_API_KEY",
            "EGE_CLOSEROUTER_BASE_URL", "EGE_CLOSEROUTER_MODEL",
            "EGE_AI_PROBE_INTERVAL_SEC", "EGE_AI_PROBE_TIMEOUT_SEC")


def set_keys(gptunnel: bool, closerouter: bool) -> None:
    for key in ENV_KEYS:
        os.environ.pop(key, None)
    if gptunnel:
        os.environ["EGE_AI_API_KEY"] = "sk-gptunnel-test"
    if closerouter:
        os.environ["EGE_CLOSEROUTER_API_KEY"] = "closerouter_test_key"


def router_row(db_path: Path):
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute("SELECT value_json FROM app_config WHERE key='ai_router'").fetchone()
    finally:
        conn.close()
    return json.loads(row[0]) if row else None


def clear_router_row(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS app_config "
                     "(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
        conn.execute("DELETE FROM app_config WHERE key='ai_router'")
        conn.commit()
    finally:
        conn.close()


class FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, _n=-1):
        return self._payload


def main() -> int:
    saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
    saved_db = os.environ.get("EGE_DB_PATH")
    with tempfile.TemporaryDirectory(prefix="ege-ai-failover-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        os.environ["EGE_DB_PATH"] = str(db_path)
        spec = importlib.util.spec_from_file_location("ege_ai_failover_test", AI_PATH)
        assert spec and spec.loader
        ai = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ai)
        original_chat_via = ai._chat_via
        original_urlopen = urllib.request.urlopen

        def reset(gptunnel=True, closerouter=True):
            set_keys(gptunnel, closerouter)
            clear_router_row(db_path)
            ai.reset_router()

        try:
            # ----------------------------------------------------------
            section("Приоритет: настроены оба — первым идёт CloseRouter")
            # ----------------------------------------------------------
            reset()
            calls = []

            def healthy(name, messages, **kw):
                calls.append(name)
                return f"ok:{name}"

            ai._chat_via = healthy
            answer = ai.chat([{"role": "user", "content": "привет"}])
            check("ответ от closerouter", answer == "ok:closerouter", answer)
            check("gptunnel не дёргали", calls == ["closerouter"], calls)
            check("active_provider = closerouter", ai.active_provider() == "closerouter")

            # ----------------------------------------------------------
            section("Failover: отказ приоритетного переносит запрос на запасного")
            # ----------------------------------------------------------
            calls.clear()

            def closerouter_dead(name, messages, **kw):
                calls.append(name)
                if name == "closerouter":
                    raise ai.AIUnavailable("на балансе ИИ закончились средства")
                return f"ok:{name}"

            ai._chat_via = closerouter_dead
            answer = ai.chat([{"role": "user", "content": "проверка"}])
            check("ученик получил ответ запасного, без ошибки", answer == "ok:gptunnel", answer)
            check("порядок попыток: closerouter → gptunnel",
                  calls == ["closerouter", "gptunnel"], calls)
            row = router_row(db_path)
            check("активный в БД переключён на gptunnel",
                  row and row.get("active") == "gptunnel", row)
            check("в БД записана причина отказа",
                  row and "closerouter" in str(row.get("lastError")), row)

            # ----------------------------------------------------------
            section("Липкость: следующие запросы сразу идут на запасного")
            # ----------------------------------------------------------
            calls.clear()
            answer = ai.chat([{"role": "user", "content": "ещё проверка"}])
            check("ответ от gptunnel", answer == "ok:gptunnel", answer)
            check("сломанный closerouter не дёргали", calls == ["gptunnel"], calls)

            # ----------------------------------------------------------
            section("Рестарт процесса: активный читается из БД")
            # ----------------------------------------------------------
            ai.reset_router()  # забыл in-memory кэш, как после рестарта
            check("активный восстановлен из app_config",
                  ai.active_provider() == "gptunnel", ai.active_provider())

            # ----------------------------------------------------------
            section("Успех на запасном закрепляет его активным")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = closerouter_dead  # closerouter всё ещё мёртв
            ai.chat([{"role": "user", "content": "x"}])
            check("после failover активен gptunnel", ai.active_provider() == "gptunnel")
            ai._chat_via = healthy  # оба воскресли; активный пока gptunnel
            ai.chat([{"role": "user", "content": "y"}])
            check("успех gptunnel держит активным gptunnel до пробы",
                  ai.active_provider() == "gptunnel", ai.active_provider())

            # ----------------------------------------------------------
            section("Оба провайдера упали — ошибка наружу, без флип-флопа")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = healthy
            ai.chat([{"role": "user", "content": "pin"}])  # закрепить closerouter
            calls.clear()

            def both_dead(name, messages, **kw):
                calls.append(name)
                raise ai.AIError(f"{name} таймаут")

            ai._chat_via = both_dead
            raised = None
            try:
                ai.chat([{"role": "user", "content": "x"}])
            except ai.AIError as exc:
                raised = exc
            check("ошибка дошла до вызывающего", raised is not None)
            check("обе попытки были", calls == ["closerouter", "gptunnel"], calls)
            check("активный не вернулся к только что упавшему closerouter",
                  ai.active_provider() == "gptunnel", ai.active_provider())

            # ----------------------------------------------------------
            section("Probe: возврат приоритетного за 15 минут")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = closerouter_dead  # closerouter упал, активный — gptunnel
            ai.chat([{"role": "user", "content": "x"}])
            check("активен запасной gptunnel", ai.active_provider() == "gptunnel")
            check("интервал пробы — 15 минут по умолчанию", ai.PROBE_INTERVAL_SEC == 900.0,
                  str(ai.PROBE_INTERVAL_SEC))
            t0 = time.time()
            ai._chat_via = healthy  # closerouter восстановился
            calls.clear()
            check("probe раньше интервала — нет вызова",
                  ai.probe_tick(now=t0 + 10) is False and calls == [], calls)
            check("probe по расписанию — восстановил closerouter",
                  ai.probe_tick(now=t0 + ai.PROBE_INTERVAL_SEC + 1) is True)
            check("probe-вызов был именно на closerouter", calls == ["closerouter"], calls)
            check("активный снова closerouter", ai.active_provider() == "closerouter")
            row = router_row(db_path)
            check("lastProbeAt зафиксирован", bool(row and row.get("lastProbeAt")), row)
            check("возврат переживает рестарт (перечитано из БД)",
                  (ai.reset_router(), ai.active_provider() == "closerouter")[1])

            # ----------------------------------------------------------
            section("Probe: отказ — ждём ещё интервал")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = closerouter_dead
            ai.chat([{"role": "user", "content": "x"}])
            check("активен gptunnel", ai.active_provider() == "gptunnel")
            calls.clear()
            t_probe = t0 + ai.PROBE_INTERVAL_SEC + 1
            check("probe упал — активный не изменился",
                  ai.probe_tick(now=t_probe) is False and ai.active_provider() == "gptunnel")
            check("probe попытался ровно один раз", calls == ["closerouter"], calls)
            row = router_row(db_path)
            check("lastProbeError записан", bool(row and row.get("lastProbeError")), row)
            check("повторный probe раньше интервала не дёргает провайдера",
                  ai.probe_tick(now=t_probe + 60) is False and calls == ["closerouter"], calls)
            check("после интервала probe снова пытается",
                  (calls.clear(), ai.probe_tick(now=t_probe + ai.PROBE_INTERVAL_SEC + 1),
                   calls == ["closerouter"])[2], calls)

            # ----------------------------------------------------------
            section("Probe: приоритетный активен — не тратим деньги")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = healthy
            ai.chat([{"role": "user", "content": "pin"}])
            calls.clear()
            check("probe пропускается, когда активен приоритетный",
                  ai.probe_tick() is False and calls == [], calls)
            # Главное опасение: не дёргаем closerouter, пока он и так активен.
            # Проба идёт мимо _ordered_providers, поэтому замер по самому факту
            # вызова, а не по счётчику чата.
            pinged = []
            ai._chat_via = lambda *a, **kw: (pinged.append(1), healthy(*a, **kw))[1]
            check("15 минут без единого запроса к активному closerouter",
                  (ai.probe_tick(now=time.time() + ai.PROBE_INTERVAL_SEC + 1) is False
                   and pinged == []), pinged)

            # ----------------------------------------------------------
            section("Ключи: без ключей — 503, один провайдер — без failover")
            # ----------------------------------------------------------
            reset(gptunnel=False, closerouter=False)
            try:
                ai.chat([{"role": "user", "content": "x"}])
                check("без ключей — AIUnavailable", False, "исключения не было")
            except ai.AIUnavailable:
                check("без ключей — AIUnavailable", True)
            check("active_provider None без ключей", ai.active_provider() is None)

            reset(gptunnel=True, closerouter=False)
            calls.clear()
            ai._chat_via = healthy
            check("только gptunnel — active gptunnel", ai.active_provider() == "gptunnel")
            check("только gptunnel — ответ от него",
                  ai.chat([{"role": "user", "content": "x"}]) == "ok:gptunnel")
            check("closerouter без ключа не вызывается", calls == ["gptunnel"], calls)
            ai._chat_via = both_dead
            try:
                ai.chat([{"role": "user", "content": "x"}])
                check("единственный провайдер упал — ошибка наружу", False)
            except ai.AIError:
                check("единственный провайдер упал — ошибка наружу", True)
            check("активный остался gptunnel (переключаться некуда)",
                  ai.active_provider() == "gptunnel")

            reset(gptunnel=False, closerouter=True)
            ai._chat_via = healthy
            check("только closerouter — active closerouter",
                  ai.active_provider() == "closerouter")
            check("только closerouter — ответ от него",
                  ai.chat([{"role": "user", "content": "x"}]) == "ok:closerouter")

            # ----------------------------------------------------------
            section("Wire-формат: Bearer + merge_system у closerouter, raw у gptunnel")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = original_chat_via  # нужен настоящий HTTP-слой
            captured = []

            def fake_urlopen(request, timeout=0):
                captured.append({
                    "url": request.full_url,
                    "auth": request.headers.get("Authorization"),
                    "body": json.loads(request.data.decode("utf-8")),
                })
                return FakeResponse(json.dumps(
                    {"choices": [{"message": {"content": "ok"}}]}).encode("utf-8"))

            urllib.request.urlopen = fake_urlopen
            messages = [{"role": "system", "content": "СИСТЕМА"},
                        {"role": "user", "content": "РАБОТА"}]
            ai.chat(messages)
            check("closerouter: Bearer-авторизация",
                  captured[-1]["auth"] == "Bearer closerouter_test_key", captured[-1]["auth"])
            check("closerouter: базовый URL по умолчанию",
                  captured[-1]["url"] == "https://api.closerouter.dev/v1/chat/completions",
                  captured[-1]["url"])
            sent = captured[-1]["body"]
            check("closerouter: system слит в user",
                  [m["role"] for m in sent["messages"]] == ["user"]
                  and sent["messages"][0]["content"] == "СИСТЕМА\n\nРАБОТА",
                  sent["messages"])
            check("closerouter: без useWalletBalance",
                  "useWalletBalance" not in sent, sent)
            check("closerouter: модель по умолчанию",
                  sent["model"] == "anthropic/claude-sonnet-5", sent["model"])

            set_keys(gptunnel=True, closerouter=False)
            ai.reset_router()
            captured.clear()
            ai.chat(messages)
            sent = captured[-1]["body"]
            check("gptunnel: сырой ключ без Bearer",
                  captured[-1]["auth"] == "sk-gptunnel-test", captured[-1]["auth"])
            check("gptunnel: useWalletBalance на месте",
                  sent.get("useWalletBalance") is True, sent)
            check("gptunnel: роли не тронуты",
                  [m["role"] for m in sent["messages"]] == ["system", "user"],
                  sent["messages"])

            # ----------------------------------------------------------
            section("HTTP 402 приоритетного → failover на запасного (живой путь)")
            # ----------------------------------------------------------
            reset()
            ai._chat_via = original_chat_via

            def urlopen_402(request, timeout=0):
                body = json.loads(request.data.decode("utf-8"))
                if "closerouter" in request.full_url:
                    raise urllib.error.HTTPError(request.full_url, 402, "Payment Required", {}, None)
                return FakeResponse(json.dumps(
                    {"choices": [{"message": {"content": "спас:" + body["model"]}}]}).encode("utf-8"))

            urllib.request.urlopen = urlopen_402
            answer = ai.chat([{"role": "user", "content": "сочинение"}])
            check("402 превратился в ответ запасного", answer == "спас:qwen3.8-flash", answer)
            check("активный переключён на gptunnel", ai.active_provider() == "gptunnel")

            # ----------------------------------------------------------
            section("Понижение: два подряд отказа — в конец очереди")
            # ----------------------------------------------------------
            reset()
            calls = []

            def flap(name, messages, **kw):
                calls.append(name)
                if name == "closerouter":
                    raise ai.AIError("провайдер недоступен: TimeoutError")
                return f"ok:{name}"

            ai._chat_via = flap
            ai.chat([{"role": "user", "content": "x"}])
            check("первый отказ: порядок closerouter → gptunnel",
                  calls == ["closerouter", "gptunnel"], calls)
            check("после одного отказа понижения нет",
                  ai._provider_demoted("closerouter") is False)
            check("активный ушёл на живого gptunnel",
                  ai.active_provider() == "gptunnel")
            calls.clear()
            ai.chat([{"role": "user", "content": "y"}])
            check("здоровый активный идёт первым, упавший не дёргаем",
                  calls == ["gptunnel"], calls)
            # Оба лежат два раза подряд — оба понижены, порядок приоритетный.
            ai._chat_via = both_dead
            for _ in range(2):
                try:
                    ai.chat([{"role": "user", "content": "z"}])
                except ai.AIError:
                    pass
            check("два подряд отказа понижают closerouter",
                  ai._provider_demoted("closerouter") is True)
            check("два подряд отказа понижают gptunnel",
                  ai._provider_demoted("gptunnel") is True)
            check("все понижены — порядок обычный приоритетный",
                  ai._ordered_providers() == ["closerouter", "gptunnel"],
                  ai._ordered_providers())
            # Первый же успех снимает понижение — но только у ответившего:
            # цепочка останавливается на первом успехе, второго не дёргают.
            ai._chat_via = healthy
            calls.clear()
            ai.chat([{"role": "user", "content": "w"}])
            check("успех снимает понижение у ответившего",
                  ai._provider_demoted("closerouter") is False
                  and ai._provider_demoted("gptunnel") is True
                  and calls == ["closerouter"], calls)

            # ----------------------------------------------------------
            section("Probe с тремя провайдерами: поднимает высшего живого")
            # ----------------------------------------------------------
            # high мёртв, medium жив, активен low: старая проба пинала только
            # high, падала и оставляла трафик на low. Новая обязана поднять
            # medium — высшего из ответивших.
            reset()
            ai._app_config_write(ai._CUSTOM_KEY, {"third": {
                "id": "third", "title": "Third",
                "base_url": "https://third.example/v1", "model": "third-model",
                "api_key": "sk-third-test", "auth": "bearer",
                "use_wallet_balance": False, "merge_system": False,
                "enabled": True}})
            ai._app_config_write(ai._SLOTS_KEY,
                                 {"high": "third", "medium": "closerouter",
                                  "low": "gptunnel"})
            ai.reset_providers_cache()
            check("порядок — high → medium → low",
                  ai.effective_priority() == ["third", "closerouter", "gptunnel"],
                  ai.effective_priority())
            calls.clear()

            def high_mid_dead(name, messages, **kw):
                calls.append(name)
                if name in ("third", "closerouter"):
                    raise ai.AIError("провайдер недоступен: TimeoutError")
                return f"ok:{name}"

            ai._chat_via = high_mid_dead
            ai.chat([{"role": "user", "content": "x"}])
            check("при двух мёртвых активен выживший low",
                  ai.active_provider() == "gptunnel", ai.active_provider())

            def high_dead(name, messages, **kw):
                calls.append(name)
                if name == "third":
                    raise ai.AIError("провайдер недоступен: TimeoutError")
                return f"ok:{name}"

            ai._chat_via = high_dead
            calls.clear()
            t0 = time.time()
            check("проба нашла живого medium и подняла его",
                  ai.probe_tick(now=t0 + ai.PROBE_INTERVAL_SEC + 1) is True)
            check("проба шла по кандидатам сверху вниз",
                  calls == ["third", "closerouter"], calls)
            check("активен поднятый medium",
                  ai.active_provider() == "closerouter", ai.active_provider())
            # Чистим трёхпровайдерную сцену: дальше тест живёт на паре
            # closerouter/gptunnel, чужие слоты ему не нужны.
            ai._app_config_write(ai._CUSTOM_KEY, {})
            ai._app_config_write(ai._SLOTS_KEY,
                                 {"high": None, "medium": None, "low": None})
            ai.reset_providers_cache()
            check("после чистки порядок снова кодовый",
                  ai.effective_priority() == ["closerouter", "gptunnel"],
                  ai.effective_priority())

            # ----------------------------------------------------------
            section("Системные обращения: смена провайдера попадает в ленту админа")
            # ----------------------------------------------------------
            # Роутер только сообщает факт; собирает обращение сервер. Здесь
            # подписчик настоящий (server.log_system_support_message) — временная
            # БД, так что запись идёт в support_messages рядом с роутером.
            srv_spec = importlib.util.spec_from_file_location(
                "ege_ai_failover_srv", ROOT / "server" / "server.py")
            srv = importlib.util.module_from_spec(srv_spec)
            srv_spec.loader.exec_module(srv)
            # Подписка — на том самом экземпляре ai, которым мы зовём chat():
            # у server.py свой собственный, загруженный отдельно.
            events = []
            ai.set_system_listener(lambda event: (
                events.append(event), srv.log_system_support_message(event))[1])

            def system_rows():
                conn = sqlite3.connect(str(db_path))
                try:
                    return conn.execute(
                        "SELECT id, source, status, message FROM support_messages"
                        " WHERE source='system' ORDER BY id").fetchall()
                finally:
                    conn.close()

            reset()
            events.clear()
            ai._chat_via = original_chat_via

            def closerouter_402(name, messages, **kw):
                if name == "closerouter":
                    raise ai.AIUnavailable("на балансе ИИ закончились средства")
                return f"ok:{name}"

            ai._chat_via = closerouter_402
            ai.chat([{"role": "user", "content": "сочинение"}])
            rows = system_rows()
            check("смена провайдера записана в ленту", len(rows) == 1, rows)
            check("источник — system", bool(rows) and rows[0][1] == "system", rows)
            check("статус — new (обычное непрочитанное обращение)",
                  bool(rows) and rows[0][2] == "new", rows)
            check("в тексте оба провайдера и причина",
                  bool(rows) and "CloseRouter" in rows[0][3] and "GPTunnel" in rows[0][3]
                  and "средства" in rows[0][3], rows[0][3] if rows else "")
            check("событие отдало kind=provider_switch",
                  any(e.get("kind") == "provider_switch" and e.get("from") == "closerouter"
                      and e.get("to") == "gptunnel" for e in events), events)

            # Повторный отказ в пределах часа — та же авария, второй строки нет.
            ai._chat_via = closerouter_402
            ai.chat([{"role": "user", "content": "ещё одно"}])
            check("дедупль: повтор не плодит ленту", len(system_rows()) == 1, system_rows())

            # Восстановление приоритетного — отдельное событие и отдельная строка.
            ai._chat_via = lambda name, messages, **kw: f"ok:{name}"
            ai._notify_system({"kind": "provider_restored", "from": "gptunnel",
                               "to": "closerouter", "at": int(time.time() * 1000)})
            rows = system_rows()
            check("восстановление записано отдельной строкой", len(rows) == 2, rows)
            check("в тексте восстановления есть провайдер",
                  len(rows) == 2 and "снова доступен" in rows[1][3], rows[1][3] if len(rows) > 1 else "")

            # Отказ последнего провайдера — авария, а не «смена».
            def all_dead(name, messages, **kw):
                raise ai.AIUnavailable("на балансе ИИ закончились средства")

            reset()
            ai._chat_via = all_dead
            try:
                ai.chat([{"role": "user", "content": "сочинение"}])
            except ai.AIUnavailable:
                pass
            rows = system_rows()
            kinds = [r[3] for r in rows]
            check("авария (все упали) записана один раз",
                  sum(1 for r in rows if "Не отвечает ни один провайдер" in r[3]) == 1, kinds)
            check("подписчик не роняет проверку при мусорном событии",
                  srv.log_system_support_message({"kind": "нет-такого"}) is None)

            ai.set_system_listener(None)
        finally:
            ai._chat_via = original_chat_via
            urllib.request.urlopen = original_urlopen
            for key, value in saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            if saved_db is None:
                os.environ.pop("EGE_DB_PATH", None)
            else:
                os.environ["EGE_DB_PATH"] = saved_db

    print(f"\n{'=' * 60}\nИТОГ: {checks - failures}/{checks} проверок прошло, "
          f"{failures} упало\n{'=' * 60}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
