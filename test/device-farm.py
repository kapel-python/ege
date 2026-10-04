#!/usr/bin/env python3
"""Ферма аккаунтов: один device — один общий котёл, подписка не освобождает.

Живая дыра: основной аккаунт тратил все лимиты, переключение на другой
аккаунт давало полный лимит заново — можно было крутить бесконечную ферму.
Причины было три, и все закрыты здесь:
  * траты ДАВНЕГО аккаунта котёл устройства не грели вовсе (минусился
    только свой u:-бакет), поэтому свежая ферма рядом видела холодный
    котёл и получала полные 5 проверок;
  * Plus/грант выше базового вообще выводили аккаунт из-под котла
    (ранний return в _ai_usage_owners), то есть подписка была льготой
    для фермы;
  * у ходов ИИ котла не было совсем: agent_quota_* считали только свой
    `agent:<id>`-бакет, и второй аккаунт всегда получал полные 10 ходов.

Новые правила (оба продукта, одинаковые):
  * КАЖДАЯ трата греет котлы устройства (кука `k:/ak:` + сеть `n:/an:`) —
    любой возраст, любая подписка;
  * котёл КУКИ читают все без льгот (один браузер = один человек):
    второй аккаунт в том же браузере упирается в выеденный котёл, даже
    если ему больше суток; котёл СЕТИ читают только свежие (< суток,
    ручка EGE_AI_USAGE_DEVICE_TRUST_SEC) — один IP может быть целым
    классом, давних по сети не судим;
  * льготу чтения дают только ручной грант админа выше базового и Plus
    (оплаченная квота), но греют котёл и они;
  * когда чужой котёл жмёт сильнее своего бакета, статус и 429 несут
    reason="farm_suspected", а модалка показывает причину БЕЗ таймера
    (время вслух не называем).

Что проверяется (temp-БД, живой сервер, мок провайдера):
  * сочинения: старый основной выедает 5 → свежий на том же браузере/IP
    получает remaining 0 + reason, проверка — 429 AI_LIMIT + reason, модель
    не вызывается; повзрослевший в том же браузере — тоже 0 + reason;
    старый из другого браузера (та же сеть) цел — школа жива; Plus чтится
    (10/10) и ферму не прикрывает; другая сеть не страдает;
  * ходы ИИ: то же самое через /api/agent/turns (старый основной выедает
    10 → свежий и повзрослевший в том же браузере упираются в котёл с
    reason; старый из другого браузера цел).

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
    spec = importlib.util.spec_from_file_location("ege_device_farm_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """Один браузер: свои куки и свой сетевой адрес."""

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
    with tempfile.TemporaryDirectory(prefix="ege-device-farm-") as tmp:
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

        try:
            # ---------------- ферма сочинений: старый основной греет котёл
            section("сочинения: старый основной выедает — свежий упирается в котёл")
            a = Client("10.20.0.1")
            status, _, body = claim(a, "Основной")
            check("claim основного", status == 200, f"{status}")
            db_age_user(db_user_id("Основной"), TRUST_MS + 3600_000)
            for i in range(5):
                status, _, _ = ai_check(a)
                check(f"основной тратит #{i + 1}", status == 200, f"{status}")
            status, _, body = ai_check(a)
            check("6-я основного — его собственный 429",
                  status == 429 and body.get("code") == "AI_LIMIT"
                  and body.get("reason") != "farm_suspected", f"{status} {body}")
            status, _, _ = a.request(base, "POST", "/api/auth/logout")
            check("logout основного", status == 200, f"{status}")
            check("кука устройства пережила logout", "ege_device" in a.cookies)
            before = model_calls["n"]
            status, _, body = claim(a, "Фермер")
            check("ферма на том же браузере завелась", status == 200, f"{status}")
            status, _, st = essay_limits(a)
            check("свежий на горячем устройстве: remaining 0 + reason",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
            status, _, body = ai_check(a)
            check("проверка фермера — 429 AI_LIMIT + reason",
                  status == 429 and body.get("code") == "AI_LIMIT"
                  and body.get("reason") == "farm_suspected", f"{status} {body}")
            check("текст 429 — про устройство, а не про таймер",
                  "устройстве" in str(body.get("error", "")), str(body.get("error")))
            check("модель фермой не вызвана", model_calls["n"] == before)

            # ---------------- старый второй в ТОМ ЖЕ браузере — в котёл
            # (Фермер пока бесплатный: Plus купит позже, ниже).
            section("старый второй в том же браузере упирается в котёл")
            db_age_user(db_user_id("Фермер"), TRUST_MS + 3600_000)
            status, _, st = essay_limits(a)
            check("повзрослевший в том же браузере: 0 + reason (котёл общий)",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected",
                  str(st))
            before = model_calls["n"]
            status, _, body = ai_check(a)
            check("его проверка — 429 + reason, модель не вызвана",
                  status == 429 and body.get("reason") == "farm_suspected"
                  and model_calls["n"] == before, f"{status} {body}")

            # ---------------- Plus чтится, но ферму не прикрывает
            section("Plus: оплаченная квота цела, но котёл греет как все")
            status, _, co = a.request(base, "POST", "/api/subscription/checkout",
                                      {"period": "month"})
            check("checkout фермера", status == 200, f"{status} {co}")
            status, _, ok = a.request(base, "POST", "/api/subscription/confirm",
                                      {"paymentId": co["paymentId"]})
            check("фермер купил Plus", status == 200, f"{status} {ok}")
            status, _, st = essay_limits(a)
            check("Plus-квота оплачена: потолок 10, остаток 10, причины нет",
                  st.get("limit") == 10 and st.get("remaining") == 10
                  and st.get("reason") is None, str(st))
            status, _, body = ai_check(a)
            check("проверка Plus-аккаунта проходит (оплачено)", status == 200,
                  f"{status} {str(body)[:100]}")
            # А свежая бесплатная ферма рядом — всё равно упирается в котёл:
            # Plus основного её не прикрывает (он и сам котёл греет).
            g = Client("10.20.0.1")  # та же сеть, чистые куки
            claim(g, "Фермер-2")
            status, _, st = essay_limits(g)
            check("бесплатный свежий на горячем устройстве: 0 + reason",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected",
                  str(st))
            before = model_calls["n"]
            status, _, body = ai_check(g)
            check("его проверка — 429 + reason, модель не вызвана",
                  status == 429 and body.get("reason") == "farm_suspected"
                  and model_calls["n"] == before, f"{status} {body}")

            # ---------------- другой браузер, та же сеть: старый цел (школа жива)
            section("старый второй из другого браузера цел")
            aold = Client("10.20.0.1")  # та же сеть, чистые куки = другой браузер
            claim(aold, "Давний-другой-браузер")
            db_age_user(db_user_id("Давний-другой-браузер"), TRUST_MS + 3600_000)
            status, _, st = essay_limits(aold)
            check("5/5 без reason (сеть давних не судит)",
                  st.get("remaining") == 5 and st.get("reason") is None, str(st))
            status, _, _ = ai_check(aold)
            check("его проверка проходит", status == 200, f"{status}")

            # ---------------- другая сеть не страдает
            section("честный новичок с другой сети не заблокирован")
            e = Client("10.20.0.9")
            claim(e, "Новичок")
            status, _, st = essay_limits(e)
            check("5 из 5 без reason", st.get("remaining") == 5 and st.get("reason") is None,
                  str(st))
            status, _, _ = ai_check(e)
            check("его проверка проходит", status == 200, f"{status}")

            # ---------------- ферма ходов ИИ: котла не было вообще
            section("ходы ИИ: старый основной выедает — свежий упирается в котёл")
            m = Client("10.21.0.1")
            status, _, _ = claim(m, "Агент-основной", "profile_math")
            check("claim агента-основного", status == 200, f"{status}")
            db_age_user(db_user_id("Агент-основной"), TRUST_MS + 3600_000)
            status, _, tb = new_thread(m)
            tid = (tb.get("thread") or {}).get("id")
            check("тред основного", status == 200 and tid, f"{status} {tb}")
            for i in range(10):
                status, _, _ = turn(m, tid, f"вопрос {i}")
                check(f"ход основного #{i + 1}", status == 200, f"{status}")
            status, _, body = turn(m, tid, "лишний")
            check("11-й основного — его собственный 429 без reason",
                  status == 429 and body.get("code") == "AI_LIMIT"
                  and body.get("reason") != "farm_suspected", f"{status} {body}")
            m.request(base, "POST", "/api/auth/logout")
            status, _, _ = claim(m, "Агент-фермер", "profile_math")
            check("фермер ИИ на том же браузере завёлся", status == 200, f"{status}")
            status, _, q = agent_quota(m)
            check("квота фермера: 0 + reason",
                  q.get("remaining") == 0 and q.get("reason") == "farm_suspected", str(q))
            status, _, tb = new_thread(m)
            ftid = (tb.get("thread") or {}).get("id")
            before_agent = agent_calls["n"]
            status, _, body = turn(m, ftid, "дай ответ")
            check("ход фермера — 429 AI_LIMIT + reason, модель не вызвана",
                  status == 429 and body.get("code") == "AI_LIMIT"
                  and body.get("reason") == "farm_suspected"
                  and agent_calls["n"] == before_agent, f"{status} {body}")

            # ---------------- старый второй в ТОМ ЖЕ браузере — в котёл
            section("старый второй по ИИ в том же браузере упирается в котёл")
            db_age_user(db_user_id("Агент-фермер"), TRUST_MS + 3600_000)
            status, _, q = agent_quota(m)
            check("повзрослевший в том же браузере: 0 + reason",
                  q.get("remaining") == 0 and q.get("reason") == "farm_suspected",
                  str(q))
            before_agent = agent_calls["n"]
            status, _, body = turn(m, ftid, "ещё вопрос")
            check("его ход — 429 + reason, модель не вызвана",
                  status == 429 and body.get("reason") == "farm_suspected"
                  and agent_calls["n"] == before_agent, f"{status} {body}")

            # ---------------- другой браузер, та же сеть: старый цел
            section("старый второй по ИИ из другого браузера цел")
            mold = Client("10.21.0.1")  # та же сеть, чистые куки
            claim(mold, "Давний-другой-браузер-ИИ", "profile_math")
            db_age_user(db_user_id("Давний-другой-браузер-ИИ"), TRUST_MS + 3600_000)
            status, _, q = agent_quota(mold)
            check("10/10 без reason (сеть давних не судит)",
                  q.get("remaining") == 10 and q.get("reason") is None, str(q))

            # ---------------- другая сеть по ИИ не страдает
            section("честный новичок ИИ с другой сети не заблокирован")
            w = Client("10.21.0.9")
            claim(w, "Агент-новичок", "profile_math")
            status, _, q = agent_quota(w)
            check("10 из 10 без reason", q.get("remaining") == 10 and q.get("reason") is None,
                  str(q))
        finally:
            try:
                httpd.shutdown()
            except Exception:
                pass
    print(f"\n{checks - failures}/{checks} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
