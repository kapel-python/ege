#!/usr/bin/env python3
"""Антиабуз лимита ИИ-проверок сочинений: 3 проверки на аккаунт, скользящее
окно 8 часов (потраченная проверка возвращается ровно через 8 часов).

Сценарии — как действуют реальные ученики, а не синтетические диктофоны:
  * обычный ученик: 3 проверки проходят, 4-я — 429 AI_LIMIT с живым
    resetInSec и Retry-After, модель при отказе не вызывается (0 денег);
  * «за ночь появился 1 запрос»: истекает только самая старая трата,
    а через 8 часов после первой лимит восстановлен полностью;
  * сбой не жжёт лимит: 400/502/503 возвращают резервацию;
  * ферма «вышел — завёл новый аккаунт» на том же браузере: свежий аккаунт
    упирается в бюджет устройства; то же при стёртых куках (ловит сеть);
    перелогин в свой же аккаунт лимит не обнуляет;
  * недожатие: давний аккаунт на общем компьютере ограничен только своим
    бюджетом, а чужое устройство/другая сеть не блокируют невиновных;
  * смена устройства не спасает: лимит следует за аккаунтом;
  * гонка из двух вкладок: 6 параллельных запросов при одном остатке —
    ровно один 200;
  * гость закрыт везде (401 GUEST_PENDING), в базе и в ответах только HMAC —
    ни сырой куки, ни IP.

Офлайн: ai.chat/ai.lt_check заглушены (как в test/essay-pipeline.py), своя
temp-БД и свой порт, прод не трогается. EGE_TRUSTED_PROXY=1 позволяет
моделировать разные сети через X-Forwarded-For.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

# Читаем до импорта: in-memory бакет всплесков (ai.ai_take) фиксируется в
# момент загрузки модуля. Здесь проверяется ПЕРСИСТЕНТНЫЙ лимит (ai_usage),
# поэтому бакет всплесков поднят так высоко, что не стреляет никогда.
os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_TRUSTED_PROXY"] = "1"

WINDOW_MS = 8 * 3600 * 1000
TRUST_MS = 24 * 3600 * 1000

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def section(title):
    print(f"\n== {title}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_ai_limits_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """Один браузер: свои куки (ege_session + ege_device) и свой сетевой
    адрес (X-Forwarded-For — в тесте прокси доверенный). Стирание кук —
    новый Client с тем же ip; второй браузер — новый Client с тем же ip;
    другая сеть — новый ip."""

    def __init__(self, ip: str):
        self.ip = ip
        self.cookies: dict[str, str] = {}

    def request(self, base: str, method: str, path: str, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        req.add_header("X-Forwarded-For", self.ip)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as exc:
            resp = exc
        with resp:
            # Set-Cookie может быть два (сессия + отпечаток устройства) —
            # берём все, иначе потеряем куку устройства.
            for sc in resp.headers.get_all("Set-Cookie") or []:
                name, _, rest = sc.partition("=")
                value = rest.split(";")[0].strip()
                if value:
                    self.cookies[name.strip()] = value
                else:
                    self.cookies.pop(name.strip(), None)
            status = resp.status
            headers = dict(resp.headers)
            raw = resp.read()
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return status, headers, payload

    def clone_session_to(self, other: "Client") -> None:
        """Тот же аккаунт с другого устройства: сервер видит ту же сессию."""
        if "ege_session" in self.cookies:
            other.cookies["ege_session"] = self.cookies["ege_session"]


def words(n, w="слово"):
    return " ".join([w] * n)


def model_payload():
    criteria = []
    for cid, name, mx in (("K1", "Позиция автора", 1), ("K2", "Комментарий", 3),
                          ("K3", "Собственное отношение", 2), ("K4", "Фактическая точность", 1),
                          ("K5", "Логичность речи", 2), ("K6", "Этические нормы", 1)):
        criteria.append({"id": cid, "name": name, "score": mx if mx <= 1 else mx - 1,
                         "max_score": mx, "comment": f"Комментарий к {cid}."})
    return {"total_score": 999, "max_score": 999, "short_verdict": "Работу нужно доработать.",
            "criteria": criteria, "what_to_improve": ["Проверить логику"],
            "recommendation": "Переписать третий абзац."}


model_calls = {"n": 0}
model_lock = threading.Lock()


def note_model_call():
    with model_lock:
        model_calls["n"] += 1


def main():
    with tempfile.TemporaryDirectory(prefix="ege-ai-limits-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        assert ai is not None, "AI module not loaded"
        os.environ["AI_API_KEY"] = "sk-test-ai-limits-key"

        def good_chat(messages, **kw):
            note_model_call()
            return json.dumps(model_payload(), ensure_ascii=False)

        ai.chat = good_chat
        ai.lt_check = lambda text: []
        ai.reset_ai_rate()

        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def now_ms():
            return int(time.time() * 1000)

        def db_user_id(name):
            conn = server.connect()
            try:
                row = conn.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()
                return int(row["id"]) if row else None
            finally:
                conn.close()

        def db_age_usage(user_id, delta_ms, oldest_only=False):
            """Перемотать траты в прошлое: окно скользящее, поэтому старение
            строк равносильно ожиданию."""
            conn = server.connect()
            try:
                if oldest_only:
                    conn.execute(
                        "UPDATE ai_usage SET created_ms = created_ms - ? WHERE id ="
                        " (SELECT id FROM ai_usage WHERE user_id=? ORDER BY created_ms ASC LIMIT 1)",
                        (delta_ms, user_id))
                else:
                    conn.execute("UPDATE ai_usage SET created_ms = created_ms - ? WHERE user_id=?",
                                 (delta_ms, user_id))
                conn.commit()
            finally:
                conn.close()

        def db_age_user(user_id, delta_ms):
            conn = server.connect()
            try:
                conn.execute("UPDATE users SET created_at=? WHERE id=?",
                             (str(now_ms() - delta_ms), user_id))
                conn.commit()
            finally:
                conn.close()

        def claim(client, name):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": "russian", "onboarded": True, "name": name})

        def limits(client):
            return client.request(base, "GET", "/api/ai/limits")

        def ai_check(client, text=None):
            return client.request(base, "POST", "/api/ai/essay",
                                  {"text": text if text is not None else words(200),
                                   "taskId": "re27_1", "subject": "russian"})

        try:
            # ------------------------------------------------ гость закрыт
            section("гость: сценарий «использовать гостя» закрыт архитектурой")
            guest = Client("10.0.0.1")
            status, _, body = limits(guest)
            check("GET /api/ai/limits гостю -> 401 GUEST_PENDING",
                  status == 401 and body.get("code") == "GUEST_PENDING", f"{status} {body}")
            before = model_calls["n"]
            status, _, body = ai_check(guest)
            check("POST /api/ai/essay гостю -> 401 GUEST_PENDING",
                  status == 401 and body.get("code") == "GUEST_PENDING", f"{status} {body}")
            check("модель гостем не вызвана", model_calls["n"] == before)
            check("гостю не выдали сессионную куку", "ege_session" not in guest.cookies)

            # --------------------------------------- обычный ученик: 3 и стоп
            section("3 проверки на аккаунт, 4-я — 429 AI_LIMIT")
            a = Client("10.1.0.1")
            status, _, body = claim(a, "Аня")
            check("claim Ани", status == 200, f"{status} {body}")
            check("кука устройства выдана", "ege_device" in a.cookies)
            status, _, st = limits(a)
            check("лимит свежего аккаунта: 3 из 3, таймера нет",
                  status == 200 and st.get("limit") == 3 and st.get("remaining") == 3
                  and st.get("resetInSec") is None and st.get("windowSec") == 8 * 3600,
                  f"{status} {st}")
            for i in range(3):
                status, _, body = ai_check(a)
                check(f"проверка #{i + 1} -> 200", status == 200 and body.get("ok") is True,
                      f"{status} {str(body)[:120]}")
            check("модель вызвана ровно 3 раза", model_calls["n"] == 3, str(model_calls["n"]))
            status, _, st = limits(a)
            check("после 3 проверок: remaining 0, таймер до возврата первой (~8ч)",
                  st.get("remaining") == 0 and isinstance(st.get("resetInSec"), int)
                  and 7 * 3600 < st["resetInSec"] <= 8 * 3600, str(st))
            before = model_calls["n"]
            status, headers, body = ai_check(a)
            check("4-я проверка -> 429 AI_LIMIT",
                  status == 429 and body.get("code") == "AI_LIMIT", f"{status} {body}")
            check("429 несёт limit/remaining/resetInSec",
                  body.get("limit") == 3 and body.get("remaining") == 0
                  and isinstance(body.get("resetInSec"), int) and body["resetInSec"] > 0, str(body))
            check("429 несёт retryAfter и заголовок Retry-After",
                  body.get("retryAfter", 0) > 0 and str(headers.get("Retry-After", "")).isdigit(),
                  f"{body.get('retryAfter')} / {headers.get('Retry-After')}")
            check("заблокированный запрос не вызывает модель (0 денег)",
                  model_calls["n"] == before)

            # ----------------------- скользящее окно: ночь и полное восстановление
            section("скользящее окно 8ч: возврат по одной, полное восстановление")
            ania = db_user_id("Аня")
            check("юзер Ани найден в БД", ania is not None)
            db_age_usage(ania, WINDOW_MS + 60_000, oldest_only=True)
            status, _, st = limits(a)
            check("истекла самая старая трата -> появился ровно 1 запрос",
                  st.get("remaining") == 1, str(st))
            check("таймер теперь показывает возврат следующей (~8ч)",
                  isinstance(st.get("resetInSec"), int) and st["resetInSec"] > 7 * 3600, str(st))
            status, _, body = ai_check(a)
            check("вернувшийся запрос тратится -> 200", status == 200, f"{status}")
            status, _, st = limits(a)
            check("и снова remaining 0", st.get("remaining") == 0, str(st))
            db_age_usage(ania, WINDOW_MS + 60_000)
            status, _, st = limits(a)
            check("через 8ч после первой траты лимит восстановлен полностью",
                  st.get("remaining") == 3 and st.get("resetInSec") is None, str(st))

            # ------------------------------------- сбой не жжёт лимит (refund)
            section("неудачная проверка лимита не стоит")
            c = Client("10.2.0.1")
            claim(c, "Саша")
            before = model_calls["n"]

            def boom_error(messages, **kw):
                note_model_call()
                raise ai.AIError("upstream 402")

            ai.chat = boom_error
            status, _, body = ai_check(c)
            check("отказ провайдера -> 502", status == 502, f"{status} {body}")
            status, _, st = limits(c)
            check("502 вернул резервацию: лимит не потрачен",
                  st.get("remaining") == 3, str(st))

            def boom_unavailable(messages, **kw):
                note_model_call()
                raise ai.AIUnavailable("no key")

            ai.chat = boom_unavailable
            status, _, body = ai_check(c)
            check("провайдер недоступен -> 503", status == 503, f"{status} {body}")
            status, _, st = limits(c)
            check("503 вернул резервацию", st.get("remaining") == 3, str(st))

            def garbage(messages, **kw):
                note_model_call()
                return "это не json вообще"

            ai.chat = garbage
            status, _, body = ai_check(c)
            check("мусорный ответ модели -> 502", status == 502, f"{status} {body}")
            status, _, st = limits(c)
            check("502 формата вернул резервацию", st.get("remaining") == 3, str(st))
            check("все 4 сбоя дошли до модели, но не списались",
                  model_calls["n"] == before + 3, str(model_calls["n"]))
            ai.chat = good_chat
            before = model_calls["n"]
            status, _, body = ai_check(c, text="  ")
            check("пустой текст -> 400 (валидация до модели)",
                  status == 400 and model_calls["n"] == before, f"{status} {body}")
            status, _, st = limits(c)
            check("400 не тратит лимит", st.get("remaining") == 3, str(st))
            status, _, body = ai_check(c)
            check("удачная проверка списывается", status == 200, f"{status}")
            status, _, st = limits(c)
            check("remaining 2 после одной удачной", st.get("remaining") == 2, str(st))

            # ------------------- ферма: вышел и завёл новый аккаунт (то же устройство)
            section("ферма «вышел — новый аккаунт» на одном устройстве закрыта")
            for i in range(3):  # Аня снова тратит всё: устройство «горячее»
                status, _, _ = ai_check(a)
                check(f"Аня дожимает лимит #{i + 1}", status == 200, f"{status}")
            status, _, st = limits(a)
            check("Аня на нуле", st.get("remaining") == 0, str(st))
            status, _, _ = a.request(base, "POST", "/api/auth/logout")
            check("logout Ани", status == 200, f"{status}")
            check("кука устройства пережила logout", "ege_device" in a.cookies)
            check("сессионная кука удалена", "ege_session" not in a.cookies)
            before = model_calls["n"]
            status, _, body = claim(a, "Аня-2")
            check("второй аккаунт на том же браузере завёлся", status == 200, f"{status}")
            status, _, st = limits(a)
            check("новый аккаунт упирается в бюджет устройства: remaining 0",
                  st.get("remaining") == 0, str(st))
            status, _, body = ai_check(a)
            check("проверка со «свежего» аккаунта -> 429 AI_LIMIT",
                  status == 429 and body.get("code") == "AI_LIMIT", f"{status} {body}")
            check("модель фермой не вызвана", model_calls["n"] == before)
            # цикл регистраций: третий аккаунт подряд — то же самое
            a.request(base, "POST", "/api/auth/logout")
            claim(a, "Аня-3")
            status, _, st = limits(a)
            check("третий аккаунт подряд — тот же ответ", st.get("remaining") == 0, str(st))

            # стёр куки — ловит сеть
            section("стирание кук не помогает: бюджет устройства ловит сеть")
            d = Client("10.1.0.1")  # та же сеть, чистые куки
            status, _, body = claim(d, "Дима")
            check("claim Димы (чистые куки, та же сеть)", status == 200, f"{status}")
            status, _, st = limits(d)
            check("без куки устройства бюджет ловится по сети: remaining 0",
                  st.get("remaining") == 0, str(st))
            before = model_calls["n"]
            status, _, body = ai_check(d)
            check("проверка Димы -> 429 AI_LIMIT, модель не вызвана",
                  status == 429 and body.get("code") == "AI_LIMIT" and model_calls["n"] == before,
                  f"{status} {body}")
            # другая сеть — честный новичок не страдает
            e = Client("10.1.0.2")
            claim(e, "Ева")
            status, _, st = limits(e)
            check("новичок с другого устройства/сети не заблокирован: 3 из 3",
                  st.get("remaining") == 3, str(st))
            status, _, body = ai_check(e)
            check("его проверка проходит", status == 200, f"{status}")

            # ------------------------- недожатие: давний аккаунт на горячем устройстве
            section("давний аккаунт на общем компьютере не страдает")
            # Активная сессия клиента a — «Аня-3» (последняя заявка фермы).
            # Взрослим её возраст: бюджет устройства к давним аккаунтам не
            # применяется, иначе страдал бы каждый, кто впервые зашёл с
            # общего компьютера, где кто-то уже исчерпал лимит.
            anya2 = db_user_id("Аня-2")
            anya3 = db_user_id("Аня-3")
            check("юзеры фермы найдены", anya2 is not None and anya3 is not None)
            db_age_user(anya3, TRUST_MS + 3600_000)
            status, _, st = limits(a)
            check("аккаунт старше суток на горячем устройстве: свой лимит цел",
                  st.get("remaining") == 3, str(st))
            before = model_calls["n"]
            status, _, body = ai_check(a)
            check("и проверка проходит", status == 200 and model_calls["n"] == before + 1, f"{status}")
            # устройство стало ещё горячее — новичок на нём по-прежнему заблокирован
            f = Client("10.1.0.1")
            claim(f, "Федя")
            status, _, st = limits(f)
            check("а свежий аккаунт на том же устройстве всё ещё заблокирован",
                  st.get("remaining") == 0, str(st))

            # --------------------- перелогин в свой аккаунт лимит не обнуляет
            section("перелогин в тот же аккаунт лимит не обнуляет")
            g = Client("10.3.0.1")
            claim(g, "Гриша")
            status, _, body = g.request(base, "POST", "/api/auth/register",
                                        {"email": "grisha@example.com", "password": "secret-pass-1"})
            check("register Гриши", status == 200, f"{status} {body}")
            for i in range(3):
                status, _, _ = ai_check(g)
                check(f"Гриша тратит #{i + 1}", status == 200, f"{status}")
            g.request(base, "POST", "/api/auth/logout")
            status, _, body = g.request(base, "POST", "/api/auth/login",
                                        {"email": "grisha@example.com", "password": "secret-pass-1"})
            check("login Гриши", status == 200, f"{status} {body}")
            status, _, st = limits(g)
            check("после перелогина remaining всё ещё 0", st.get("remaining") == 0, str(st))
            before = model_calls["n"]
            status, _, body = ai_check(g)
            check("и проверка честно заблокирована", status == 429 and model_calls["n"] == before,
                  f"{status}")

            # ------------------- смена устройства не спасает: лимит за аккаунтом
            section("смена устройства не обнуляет лимит аккаунта")
            g2 = Client("10.9.9.9")  # другое устройство, другая сеть
            g.clone_session_to(g2)
            status, _, st = limits(g2)
            check("тот же аккаунт с нового устройства: remaining 0",
                  st.get("remaining") == 0, str(st))
            before = model_calls["n"]
            status, _, body = ai_check(g2)
            check("проверка с нового устройства -> 429, модель не вызвана",
                  status == 429 and body.get("code") == "AI_LIMIT" and model_calls["n"] == before,
                  f"{status} {body}")

            # ---------------------------------- гонка: 6 параллельных, остаток 1
            section("гонка вкладок: лишнюю проверку не выдать")
            h = Client("10.8.0.1")
            claim(h, "Нина")
            for i in range(2):
                status, _, _ = ai_check(h)
                check(f"Нина тратит #{i + 1}", status == 200, f"{status}")
            status, _, st = limits(h)
            check("остаток ровно 1", st.get("remaining") == 1, str(st))
            before = model_calls["n"]
            results = []
            results_lock = threading.Lock()

            def fire():
                status, _, body = ai_check(h)
                with results_lock:
                    results.append((status, body.get("code")))

            threads = [threading.Thread(target=fire) for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            oks = sum(1 for s, _ in results if s == 200)
            limited = sum(1 for s, code in results if s == 429 and code == "AI_LIMIT")
            check("6 параллельных при остатке 1 -> ровно один 200",
                  oks == 1, str(results))
            check("остальные пять -> 429 AI_LIMIT", limited == 5, str(results))
            check("модель вызвана ровно один раз", model_calls["n"] == before + 1,
                  str(model_calls["n"]))

            # ---------------------------------- лимит настраивается окружением
            section("лимит — конфигурация, а не константа в коде")
            os.environ["EGE_AI_USAGE_MAX"] = "1"
            try:
                i = Client("10.7.0.1")
                claim(i, "Ира")
                status, _, st = limits(i)
                check("EGE_AI_USAGE_MAX=1 виден в статусе",
                      st.get("limit") == 1 and st.get("remaining") == 1, str(st))
                status, _, _ = ai_check(i)
                check("первая проверка проходит", status == 200, f"{status}")
                status, _, body = ai_check(i)
                check("вторая — уже 429", status == 429 and body.get("code") == "AI_LIMIT",
                      f"{status} {body}")
            finally:
                del os.environ["EGE_AI_USAGE_MAX"]
            j = Client("10.6.0.1")
            claim(j, "Женя")
            status, _, st = limits(j)
            check("без env снова 3 из 3", st.get("limit") == 3 and st.get("remaining") == 3, str(st))

            # ------------------------------ граница окна: 59 секунд до возврата
            section("граница окна: трата моложе 8ч ещё занята")
            for k in range(3):
                status, _, _ = ai_check(j)
                check(f"Женя тратит #{k + 1}", status == 200, f"{status}")
            zhenia = db_user_id("Женя")
            db_age_usage(zhenia, WINDOW_MS - 60_000, oldest_only=True)
            status, _, st = limits(j)
            check("трата 8ч-минута назад всё ещё занята",
                  st.get("remaining") == 0, str(st))
            check("таймер показывает около минуты",
                  isinstance(st.get("resetInSec"), int) and 0 < st["resetInSec"] <= 120, str(st))
            db_age_usage(zhenia, 120_000, oldest_only=True)
            status, _, st = limits(j)
            check("ещё две минуты — и запрос вернулся", st.get("remaining") == 1, str(st))

            # ------------------------------------------ приватность отпечатков
            section("в базе только HMAC: ни сырой куки, ни IP")
            conn = server.connect()
            try:
                rows = conn.execute("SELECT user_id, device_key, device_net FROM ai_usage").fetchall()
            finally:
                conn.close()
            check("траты записаны", len(rows) > 0)
            hex32 = re.compile(r"^[0-9a-f]{32}$")
            check("device_key — только 32-символьный HMAC или NULL",
                  all(r["device_key"] is None or hex32.match(str(r["device_key"])) for r in rows))
            check("device_net — только 32-символьный HMAC или NULL",
                  all(r["device_net"] is None or hex32.match(str(r["device_net"])) for r in rows))
            raw_values = {str(r["device_key"]) for r in rows} | {str(r["device_net"]) for r in rows}
            leaked_ips = [ip for ip in ("10.1.0.1", "10.1.0.2", "10.8.0.1") if ip in raw_values]
            check("сырых IP в базе нет", not leaked_ips, str(leaked_ips))
            leaked_cookies = [v for v in (a.cookies.get("ege_device"), g.cookies.get("ege_device"))
                              if v and v in raw_values]
            check("сырых значений куки в базе нет", not leaked_cookies, str(leaked_cookies))
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
