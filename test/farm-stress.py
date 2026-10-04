#!/usr/bin/env python3
"""Жёсткий стресс антиабуза: ноль ложных обвинений + ферма не проходит никак.

Две стороны одной медали (temp-БД, живой сервер, мок провайдера):
  A. ЧЕСТНЫЕ НЕ СТРАДАЮТ — ни одного reason:"farm_suspected" там, где его
     быть не должно: одиночка выедает своё (429 с таймером, без причины),
     перелогин хранит своё, давний второй из ДРУГОГО браузера полон,
     другая сеть полна, Plus холодный — 10/10 (50 ходов), грант 500 —
     500 без причины и его траты котёл не греют, refund возвращает ровно,
     граница 24ч: TRUST-1мин душит, TRUST+1мин отпускает (сеть), частичный
     котёл даёт частичный остаток без обвинений (reason только в 429-нуле).
  B. ФЕРМА НЕ ПРОХОДИТ — как бы ни крутился: серия свежих на том же
     браузере (logout+claim), стёртые куки (тот же IP), другой браузер
     (тот же IP — ловит сеть), параллельная ферма (6 акков разом: всего
     <=5 вызовов модели в сочинениях и <=10 ходов в ИИ), Plus-main-hot не
     прикрывает бесплатную ферму, спавший второй в ТОМ ЖЕ браузере тоже
     в котёл (кука), reason есть везде (limits, 429, quota,
     треды), модель фермой не вызывается ни разу.
  C. ИЗВЕСТНЫЕ ГРАНИЦЫ (документируют, а не чинят): другой браузер +
     старые акки котлом не ловятся (куки разные — цена безопасности школы),
     ротация IP+куки неотличима от честного новичка (сигнала нет в принципе).

Офлайн: ai.chat/ai.lt_check/ai.chat_with_tools заглушены, прод не трогается.
EGE_TRUSTED_PROXY=1 моделирует сети через X-Forwarded-For.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"

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
    spec = importlib.util.spec_from_file_location("ege_farm_stress_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
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
            resp = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as exc:
            resp = exc
        with resp:
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


_POOL = ("память детство пример позиция автор текст отношение связь вывод "
         "вопрос письмо сад война город книга голос долг выбор имя слово вера "
         "совесть путь дом смерть время труд").split()
_SEQ = [0]


def fresh_text(n=200):
    _SEQ[0] += 1
    seq = _SEQ[0]
    return " ".join(f"{w}-{seq}-{i // len(_POOL)}" if not (seq == 1 and i < len(_POOL))
                    else w for i, w in enumerate([_POOL[i % len(_POOL)] for i in range(n)]))


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
    with tempfile.TemporaryDirectory(prefix="ege-farm-stress-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        assert ai is not None, "AI module not loaded"
        assert server._SUB is not None, "модуль подписки не загрузился"

        def good_chat(messages, **kw):
            note_model_call()
            return json.dumps(model_payload(), ensure_ascii=False)

        ai.chat = good_chat
        ai.lt_check = lambda text: []
        ai.reset_ai_rate()

        agent_calls = {"n": 0}
        agent_lock = threading.Lock()

        def mock_agent_chat(messages, tools, **kw):
            with agent_lock:
                agent_calls["n"] += 1
            return {"text": "Финальный ответ.", "tool_calls": []}

        ai.chat_with_tools = mock_agent_chat

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
            c = server.connect()
            try:
                row = c.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()
                return int(row["id"]) if row else None
            finally:
                c.close()

        def db_age_user(user_id, delta_ms):
            c = server.connect()
            try:
                c.execute("UPDATE users SET created_at=? WHERE id=?",
                          (str(now_ms() - delta_ms), user_id))
                c.commit()
            finally:
                c.close()

        def grant_essay(user_id, limit, remaining):
            c = server.connect()
            try:
                return server.admin_ai_limit_set(c, user_id, {"limit": limit, "remaining": remaining})
            finally:
                c.close()

        def grant_agent(user_id, limit, remaining):
            c = server.connect()
            try:
                return server._AGENT.admin_agent_quota_set(
                    c, user_id, {"limit": limit, "remaining": remaining})
            finally:
                c.close()

        def claim(client, name, subject="russian"):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": subject, "onboarded": True, "name": name})

        def essay_limits(client):
            return client.request(base, "GET", "/api/ai/limits")

        def ai_check(client, text=None):
            return client.request(base, "POST", "/api/ai/essay",
                                  {"text": text if text is not None else fresh_text(200),
                                   "taskId": "re27_1", "subject": "russian"})

        def agent_quota(client):
            return client.request(base, "GET", "/api/agent/limits")

        def new_thread(client):
            return client.request(base, "POST", "/api/agent/threads", {})

        def turn(client, tid, text):
            return client.request(base, "POST", "/api/agent/turns",
                                  {"threadId": tid, "text": text})

        def buy_plus(client):
            s, _, co = client.request(base, "POST", "/api/subscription/checkout",
                                      {"period": "month"})
            assert s == 200, co
            s, _, ok = client.request(base, "POST", "/api/subscription/confirm",
                                      {"paymentId": co["paymentId"]})
            assert s == 200, ok
            return ok

        try:
            # ================= A. ЧЕСТНЫЕ НЕ СТРАДАЮТ =================
            section("A1. одиночка выедает своё: 429 с таймером, БЕЗ причины")
            a = Client("10.30.0.1")
            claim(a, "Одиночка")
            for _ in range(5):
                s, _, _ = ai_check(a)
                assert s == 200, s
            s, _, st = essay_limits(a)
            check("сочинения: 0 без reason, таймер есть",
                  st.get("remaining") == 0 and st.get("reason") is None
                  and isinstance(st.get("resetInSec"), int), str(st))
            s, _, body = ai_check(a)
            check("429 без reason, текст про таймер",
                  s == 429 and body.get("reason") is None and "аймер" in str(body.get("error")), str(body))

            m = Client("10.31.0.1")
            claim(m, "Одиночка-ИИ", "profile_math")
            s, _, tb = new_thread(m)
            tid = (tb.get("thread") or {}).get("id")
            for i in range(10):
                s, _, _ = turn(m, tid, f"вопрос {i}")
                assert s == 200, (s, i)
            s, _, q = agent_quota(m)
            check("ИИ: 0 без reason", q.get("remaining") == 0 and q.get("reason") is None, str(q))
            s, _, body = turn(m, tid, "лишний")
            check("ход 429 без reason", s == 429 and body.get("reason") is None, str(body))

            section("A2. перелогин хранит своё (не обнуляет, не обвиняет)")
            # Перелогин в свой аккаунт — на ХОЛОДНОМ устройстве, чтобы котёл
            # не вмешивался: проверяем именно «своё хранится», а не ферму.
            r = Client("10.30.0.2")
            claim(r, "Возврат")
            s, _, _ = r.request(base, "POST", "/api/auth/register",
                                {"email": "back@example.com", "password": "secret-pass-1"})
            assert s == 200, s
            for _ in range(5):
                s, _, _ = ai_check(r)
                assert s == 200, s
            r.request(base, "POST", "/api/auth/logout")
            s, _, _ = r.request(base, "POST", "/api/auth/login",
                                {"email": "back@example.com", "password": "secret-pass-1"})
            check("login после трат", s == 200, f"{s}")
            s, _, st = essay_limits(r)
            check("после перелогина своё 0 без reason",
                  st.get("remaining") == 0 and st.get("reason") is None, str(st))

            section("A3. давний второй из ДРУГОГО браузера цел (оба продукта)")
            a2 = Client("10.30.0.1")  # тот же браузер/сеть, где Одиночка всё съел
            claim(a2, "Второй-давний")
            db_age_user(db_user_id("Второй-давний"), TRUST_MS + 3600_000)
            s, _, st = essay_limits(a2)
            check("сочинения: свой лимит цел, reason нет",
                  st.get("remaining") == st.get("limit") and st.get("reason") is None, str(st))
            db_age_user(db_user_id("Одиночка-ИИ"), TRUST_MS + 3600_000)
            m2 = Client("10.31.0.1")  # второй старый на том же горячем устройстве
            claim(m2, "Второй-давний-ИИ", "profile_math")
            db_age_user(db_user_id("Второй-давний-ИИ"), TRUST_MS + 3600_000)
            s, _, q = agent_quota(m2)
            check("ИИ: своя квота цела, reason нет",
                  q.get("remaining") == q.get("limit") and q.get("reason") is None, str(q))

            section("A4. другая сеть — всегда полна")
            e = Client("10.30.0.9")
            claim(e, "Другая-сеть")
            s, _, st = essay_limits(e)
            check("5/5 без reason", st.get("remaining") == 5 and st.get("reason") is None, str(st))
            w = Client("10.31.0.9")
            claim(w, "Другая-сеть-ИИ", "profile_math")
            s, _, q = agent_quota(w)
            check("10/10 без reason", q.get("remaining") == 10 and q.get("reason") is None, str(q))

            section("A5. Plus холодный: оплаченное целиком, без причины")
            p = Client("10.32.0.1")
            claim(p, "Плюс-холодный")
            buy_plus(p)
            s, _, st = essay_limits(p)
            check("сочинения 10/10 без reason", st.get("limit") == 10 and st.get("remaining") == 10
                  and st.get("reason") is None, str(st))
            pp = Client("10.33.0.1")
            claim(pp, "Плюс-ИИ", "profile_math")
            buy_plus(pp)
            s, _, q = agent_quota(pp)
            check("ходы 50/50 без reason", q.get("limit") == 50 and q.get("remaining") == 50
                  and q.get("reason") is None, str(q))

            section("A6. грант админа: 500 без причины, котёл не греется")
            g = Client("10.34.0.1")
            claim(g, "Грант")
            grant_essay(db_user_id("Грант"), 500, 500)
            s, _, st = essay_limits(g)
            check("500/500 без reason", st.get("limit") == 500 and st.get("remaining") == 500
                  and st.get("reason") is None, str(st))
            for _ in range(3):
                s, _, _ = ai_check(g)
                assert s == 200, s
            # Траты гранта котёл не грели: свежий рядом — полон:
            g2 = Client("10.34.0.1")
            claim(g2, "Рядом-с-грантом")
            s, _, st = essay_limits(g2)
            check("свежий рядом с грантом: 5/5 без reason (котёл холодный)",
                  st.get("remaining") == 5 and st.get("reason") is None, str(st))

            section("A7. refund возвращает ровно (котёл не накручивается)")
            k = Client("10.35.0.1")
            claim(k, "Рефанд")
            s, _, before_st = essay_limits(k)
            assert before_st.get("remaining") == 5, before_st
            s, _, _ = ai_check(k)
            assert s == 200, s
            # Ломаем модель и роняем проверку: жетон должен вернуться везде:
            ai.chat = lambda *am, **akw: (_ for _ in ()).throw(Exception("boom"))
            try:
                s, _, _ = ai_check(k)
            except Exception:
                s = "conn-broken"
            ai.chat = good_chat
            s, _, st = essay_limits(k)
            check("после сбоя карман 4/5 без reason (потрачена только удачная)",
                  st.get("remaining") == 4 and st.get("reason") is None, str(st))

            section("A8. граница 24ч: сутки отпирают СЕТЬ, кука держит всегда")
            # Горячее устройство 10.36.0.1: основной выедает всё:
            h = Client("10.36.0.1")
            claim(h, "Горячий")
            for _ in range(5):
                s, _, _ = ai_check(h)
                assert s == 200, s
            h.request(base, "POST", "/api/auth/logout")
            claim(h, "Почти-старый")
            db_age_user(db_user_id("Почти-старый"), TRUST_MS - 60_000)
            s, _, st = essay_limits(h)
            check("за минуту до суток: всё ещё gated (0 + reason)",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
            db_age_user(db_user_id("Почти-старый"), TRUST_MS + 60_000)
            s, _, st = essay_limits(h)
            check("через минуту после суток в ТОМ ЖЕ браузере: кука держит (0 + reason)",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
            hold = Client("10.36.0.1")  # та же сеть, другая кука
            claim(hold, "Старый-другая-кука")
            db_age_user(db_user_id("Старый-другая-кука"), TRUST_MS + 60_000)
            s, _, st = essay_limits(hold)
            check("через минуту после суток из ДРУГОГО браузера: свободен (5, без reason)",
                  st.get("remaining") == 5 and st.get("reason") is None, str(st))

            section("A9. детерминированный гейт жетонов не трогает")
            z = Client("10.37.0.1")
            claim(z, "Гейт")
            s, _, body = ai_check(z, "слово " * 200)
            check("повторы — детерминированный 0 без модели",
                  s == 200 and body.get("deterministic") == "low_diversity", f"{s} {str(body)[:120]}")
            s, _, st = essay_limits(z)
            check("лимит цел 5/5 (резерва не было)", st.get("remaining") == 5, str(st))

            # ================= B. ФЕРМА НЕ ПРОХОДИТ =================
            section("B1. серия свежих на том же браузере: все в котёл (сочинения)")
            f = Client("10.40.0.1")
            claim(f, "Фермер-0")
            for _ in range(5):
                s, _, _ = ai_check(f)
                assert s == 200, s
            for n in range(1, 4):
                f.request(base, "POST", "/api/auth/logout")
                claim(f, f"Фермер-{n}")
                s, _, st = essay_limits(f)
                check(f"фермер-{n}: 0 + reason",
                      st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
                before = model_calls["n"]
                s, _, body = ai_check(f)
                check(f"проверка фермера-{n}: 429 + reason, модель молчит",
                      s == 429 and body.get("reason") == "farm_suspected"
                      and model_calls["n"] == before, f"{s} {body}")

            section("B2. стёр куки / другой браузер, та же сеть — ловит сеть")
            for n, tag in enumerate(("Стертые-куки", "Другой-браузер")):
                d = Client("10.40.0.1")
                claim(d, tag)
                s, _, st = essay_limits(d)
                check(f"{tag}: 0 + reason по сети",
                      st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
                before = model_calls["n"]
                s, _, body = ai_check(d)
                check(f"{tag}: 429 + reason", s == 429 and body.get("reason") == "farm_suspected"
                      and model_calls["n"] == before, f"{s} {body}")

            section("B3. параллельная ферма: 6 акков разом — всего <=5 вызовов модели")
            cold_ip = "10.41.0.1"
            racers = []
            for n in range(6):
                c = Client(cold_ip)
                claim(c, f"Гонщик-{n}")
                racers.append(c)
            before = model_calls["n"]
            results = []
            rlock = threading.Lock()

            def fire(c):
                s, _, b = ai_check(c)
                with rlock:
                    results.append(s)

            threads = [threading.Thread(target=fire, args=(c,)) for c in racers]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            oks = sum(1 for s in results if s == 200)
            check("6 параллельных на холодном устройстве: 200 не больше 5",
                  oks <= 5, str(results))
            check("модель вызвана не больше 5 раз",
                  model_calls["n"] - before <= 5, str(model_calls["n"] - before))

            section("B4. ферма ходов ИИ: серия + параллель + reason везде")
            mf = Client("10.42.0.1")
            claim(mf, "ИИ-фермер-0", "profile_math")
            s, _, tb = new_thread(mf)
            tid0 = (tb.get("thread") or {}).get("id")
            for i in range(10):
                s, _, _ = turn(mf, tid0, f"вопрос {i}")
                assert s == 200, (s, i)
            mf.request(base, "POST", "/api/auth/logout")
            claim(mf, "ИИ-фермер-1", "profile_math")
            s, _, q = agent_quota(mf)
            check("квота: 0 + reason", q.get("remaining") == 0
                  and q.get("reason") == "farm_suspected", str(q))
            s, _, tb = new_thread(mf)
            ftid = (tb.get("thread") or {}).get("id")
            s, _, tl = mf.request(base, "GET", "/api/agent/threads", None)
            check("quota в списке тредов тоже с reason",
                  (tl.get("quota") or {}).get("reason") == "farm_suspected"
                  and (tl.get("quota") or {}).get("remaining") == 0, str(tl.get("quota")))
            before_a = agent_calls["n"]
            s, _, body = turn(mf, ftid, "дай ответ")
            check("ход: 429 + reason, модель молчит",
                  s == 429 and body.get("reason") == "farm_suspected"
                  and agent_calls["n"] == before_a, f"{s} {body}")
            # Параллель на холодном IP: 4 акка x 5 ходов, котёл 10:
            pcold = "10.43.0.1"
            pres = []
            plock = threading.Lock()

            def pfire(n):
                c = Client(pcold)
                claim(c, f"Параллель-{n}", "profile_math")
                _, _, tb2 = new_thread(c)
                t2 = (tb2.get("thread") or {}).get("id")
                for i in range(5):
                    s2, _, _ = turn(c, t2, f"вопрос {i}")
                    with plock:
                        pres.append(s2)

            pts = [threading.Thread(target=pfire, args=(n,)) for n in range(4)]
            before_a = agent_calls["n"]
            for t in pts:
                t.start()
            for t in pts:
                t.join()
            poks = sum(1 for s in pres if s == 200)
            check("20 ходов 4 акков на холодном устройстве: 200 не больше 10",
                  poks <= 10, f"ok={poks}")
            check("модель вызвана не больше 10 раз",
                  agent_calls["n"] - before_a <= 10, str(agent_calls["n"] - before_a))

            section("B5. Plus-main-hot не прикрывает бесплатную ферму")
            pm = Client("10.44.0.1")
            claim(pm, "Плюс-майнер")
            buy_plus(pm)
            for _ in range(10):
                s, _, _ = ai_check(pm)
                assert s == 200, s
            pm.request(base, "POST", "/api/auth/logout")
            claim(pm, "Бесплатный-следом")
            s, _, st = essay_limits(pm)
            check("бесплатный свежий после Plus-трат: 0 + reason",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))

            section("B6. спавшая ферма в ТОМ ЖЕ браузере: старый второй тоже в котёл")
            # Тот же браузер (тот же Client = та же кука), новый бесплатный
            # аккаунт, состаренный вручную: кука горячая — отказ с причиной.
            pm.request(base, "POST", "/api/auth/logout")
            claim(pm, "Спящий-в-том-же-браузере")
            db_age_user(db_user_id("Спящий-в-том-же-браузере"), TRUST_MS + 3600_000)
            s, _, st = essay_limits(pm)
            check("сочинения: старый в том же браузере — 0 + reason",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
            before = model_calls["n"]
            s, _, body = ai_check(pm)
            check("проверка — 429 + reason, модель молчит",
                  s == 429 and body.get("reason") == "farm_suspected"
                  and model_calls["n"] == before, f"{s} {body}")
            # Тот же сценарий для ходов ИИ:
            am = Client("10.47.0.1")
            claim(am, "ИИ-спящий-0", "profile_math")
            db_age_user(db_user_id("ИИ-спящий-0"), TRUST_MS + 3600_000)
            s, _, tb = new_thread(am)
            atid = (tb.get("thread") or {}).get("id")
            for i in range(10):
                s, _, _ = turn(am, atid, f"вопрос {i}")
                assert s == 200, (s, i)
            am.request(base, "POST", "/api/auth/logout")
            claim(am, "ИИ-спящий-1", "profile_math")
            db_age_user(db_user_id("ИИ-спящий-1"), TRUST_MS + 3600_000)
            s, _, q = agent_quota(am)
            check("ИИ: старый в том же браузере — 0 + reason",
                  q.get("remaining") == 0 and q.get("reason") == "farm_suspected", str(q))

            # ================= C. ИЗВЕСТНЫЕ ГРАНИЦЫ =================
            section("C1. другой браузер + старые акки: котлом НЕ ловится (документировано)")
            o1 = Client("10.45.0.1")
            claim(o1, "Спящий-1")
            db_age_user(db_user_id("Спящий-1"), TRUST_MS + 3600_000)
            for _ in range(5):
                s, _, _ = ai_check(o1)
                assert s == 200, s
            o2 = Client("10.45.0.1")
            claim(o2, "Спящий-2")
            db_age_user(db_user_id("Спящий-2"), TRUST_MS + 3600_000)
            s, _, st = essay_limits(o2)
            check("второй старый из другого браузера: ПОЛОН (куки разные)",
                  st.get("remaining") == 5 and st.get("reason") is None, str(st))

            section("C2. ротация IP+куки неотличима от новичка (документировано)")
            v = Client("10.46.0.99")
            claim(v, "Невидимка")
            s, _, st = essay_limits(v)
            check("новый IP+куки: полон (сигнала связать нет)",
                  st.get("remaining") == 5 and st.get("reason") is None, str(st))
        finally:
            try:
                httpd.shutdown()
            except Exception:
                pass
    print(f"\n{checks - failures}/{checks} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
