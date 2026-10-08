#!/usr/bin/env python3
"""Ложные срабатывания «фермы»: 10 самых вероятных сценариев честного ученика.

Правило, которое проверяем (цель продукта): окно «ферма» — только когда
человек переключился на ДРУГОЙ аккаунт в ТОМ ЖЕ браузере и котёл устройства
уже выеден до нуля, а сам он на этом аккаунте ещё не тратил. Всё остальное —
обычное окно исчерпания с таймером, даже если блокировка та же.

Сценарии (temp-БД, живой сервер, мок провайдера):
  1. одиночка выел своё (5/5 своих трат) — без reason;
  2. второй аккаунт, сам потратил часть (2 из 5) — без reason;
  3. котёл подзарядился (остаток 2), аккаунт не тратил — без reason,
     и проверка ЕЩЁ ПРОХОДИТ (обвинять при живом остатке нельзя);
  4. школьный IP: сеть выели чужие из других браузеров, свежий аккаунт
     с холодной кукой — без reason (сеть общая: класс/второе своё устройство);
  5. сеть подзарядилась (остаток 2), кука холодная — без reason,
     проверка проходит;
  6. переключение на второй аккаунт в ТОМ ЖЕ браузере — reason (контроль);
  7. состаренный второй в том же браузере — reason (контроль);
  8. неуспешная проверка вернула жетон (refund) — без reason;
  9. ИИ: школьная сеть и подзаряженный котёл — без reason;
 10. ИИ: переключение в том же браузере — reason (контроль).

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
    spec = importlib.util.spec_from_file_location("ege_farm_false_positive_test", SERVER_PATH)
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
            raw = resp.read()
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return status, payload


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


def main():
    with tempfile.TemporaryDirectory(prefix="ege-farm-false-positive-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        assert ai is not None, "AI module not loaded"

        def good_chat(messages, **kw):
            with model_lock:
                model_calls["n"] += 1
            return json.dumps(model_payload(), ensure_ascii=False)

        def broken_chat(*a, **kw):
            raise Exception("boom")

        ai.chat = good_chat
        ai.lt_check = lambda text: []
        ai.reset_ai_rate()

        def mock_agent_chat(messages, tools, **kw):
            with model_lock:
                model_calls["n"] += 1
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
                          (str(int(time.time() * 1000) - delta_ms), user_id))
                c.commit()
            finally:
                c.close()

        def db_bump_zeros(prefixes, count):
            """Подзарядить выеденные котлы вручную: сеть/кука/ИИ-котлы."""
            c = server.connect()
            try:
                likes = " OR ".join(["owner LIKE ?"] * len(prefixes))
                c.execute(f"UPDATE ai_usage SET count=? WHERE count=0 AND ({likes})",
                          (count, *prefixes))
                c.commit()
            finally:
                c.close()

        def claim(client, name, subject="russian"):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": subject, "onboarded": True, "name": name})

        def essay_limits(client):
            return client.request(base, "GET", "/api/ai/limits")

        def ai_check(client):
            return client.request(base, "POST", "/api/ai/essay",
                                  {"text": fresh_text(200), "taskId": "re27_1", "subject": "russian"})

        def agent_quota(client):
            return client.request(base, "GET", "/api/agent/limits")

        def new_thread(client):
            return client.request(base, "POST", "/api/agent/threads", {})

        def turn(client, tid, text):
            return client.request(base, "POST", "/api/agent/turns",
                                  {"threadId": tid, "text": text})

        def spend_all(client, n):
            for i in range(n):
                s, _ = ai_check(client)
                assert s == 200, (i, s)

        def agent_turns(client, n):
            s, tb = new_thread(client)
            tid = (tb.get("thread") or {}).get("id")
            assert s == 200 and tid, (s, tb)
            for i in range(n):
                s, _ = turn(client, tid, f"вопрос {i}")
                assert s == 200, (i, s)

        try:
            # ---------------- 1. одиночка выел своё ----------------
            section("1. одиночка выел свои 5 — обычное окно, без обвинения")
            c1 = Client("10.60.0.1")
            claim(c1, "Одиночка-ФП")
            spend_all(c1, 5)
            s, st = essay_limits(c1)
            check("0 без reason", st.get("remaining") == 0 and st.get("reason") is None, str(st))
            s, body = ai_check(c1)
            check("429 без reason", s == 429 and body.get("reason") is None, f"{s} {body}")

            # ---------------- 2. второй аккаунт, свои траты ----------------
            section("2. второй аккаунт, сам потратил 2 из 5 — без обвинения")
            c2 = Client("10.60.0.2")
            claim(c2, "Первый-ФП")
            spend_all(c2, 3)
            c2.request(base, "POST", "/api/auth/logout")
            claim(c2, "Второй-ФП")
            spend_all(c2, 2)
            s, st = essay_limits(c2)
            check("0 без reason (свой 3/5)", st.get("remaining") == 0 and st.get("reason") is None, str(st))
            s, body = ai_check(c2)
            check("429 без reason", s == 429 and body.get("reason") is None, f"{s} {body}")

            # ---------------- 3. котёл подзарядился, остаток есть ----------------
            section("3. котёл подзаряжен (остаток 2), аккаунт не тратил — не обвинять, проверка идёт")
            c3 = Client("10.60.0.3")
            claim(c3, "Старый-ФП-3")
            spend_all(c3, 5)
            db_bump_zeros(("k:%", "n:%"), 2)  # котлы зарядились на тик вперёд
            c3.request(base, "POST", "/api/auth/logout")
            claim(c3, "Свежий-ФП-3")
            s, st = essay_limits(c3)
            check("остаток 2 и без reason", st.get("remaining") == 2 and st.get("reason") is None, str(st))
            s, body = ai_check(c3)
            check("проверка проходит (место есть)", s == 200, f"{s} {str(body)[:90]}")

            # ---------------- 4. школьный IP: сеть выели чужие ----------------
            section("4. школьный IP: чужие выели сеть, свежий с холодной кукой — без обвинения")
            c4a = Client("10.60.0.4")
            claim(c4a, "Чужой-ФП-4")
            spend_all(c4a, 5)
            c4b = Client("10.60.0.4")  # тот же IP, свой браузер
            claim(c4b, "Школьник-ФП-4")
            s, st = essay_limits(c4b)
            check("0 без reason по сети", st.get("remaining") == 0 and st.get("reason") is None, str(st))
            s, body = ai_check(c4b)
            check("429 без reason (блок по сети, но не обвинение)",
                  s == 429 and body.get("reason") is None, f"{s} {body}")

            # ---------------- 5. сеть подзарядилась, место есть ----------------
            section("5. сеть подзаряжена (остаток 2), холодная кука — проверка идёт")
            c5a = Client("10.60.0.5")
            claim(c5a, "Чужой-ФП-5")
            spend_all(c5a, 3)
            db_bump_zeros(("n:%",), 2)
            c5b = Client("10.60.0.5")
            claim(c5b, "Школьник-ФП-5")
            s, st = essay_limits(c5b)
            check("остаток 2 и без reason", st.get("remaining") == 2 and st.get("reason") is None, str(st))
            s, body = ai_check(c5b)
            check("проверка проходит", s == 200, f"{s} {str(body)[:90]}")

            # ---------------- 6. переключение в том же браузере (контроль) ----------------
            section("6. переключение на второй аккаунт в ТОМ ЖЕ браузере — reason (контроль)")
            c6 = Client("10.60.0.6")
            claim(c6, "Старый-ФП-6")
            spend_all(c6, 5)
            c6.request(base, "POST", "/api/auth/logout")
            claim(c6, "Свежий-ФП-6")
            s, st = essay_limits(c6)
            check("0 + reason", st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))
            s, body = ai_check(c6)
            check("429 + reason", s == 429 and body.get("reason") == "farm_suspected", f"{s} {body}")

            # ---------------- 7. состаренный второй в том же браузере (контроль) ----------------
            section("7. состаренный второй в том же браузере — reason (контроль)")
            c7 = Client("10.60.0.7")
            claim(c7, "Старый-ФП-7")
            spend_all(c7, 5)
            c7.request(base, "POST", "/api/auth/logout")
            claim(c7, "Давний-ФП-7")
            db_age_user(db_user_id("Давний-ФП-7"), TRUST_MS + 3600_000)
            s, st = essay_limits(c7)
            check("0 + reason (кука держит и давнего)",
                  st.get("remaining") == 0 and st.get("reason") == "farm_suspected", str(st))

            # ---------------- 8. refund после сбоя ----------------
            section("8. неуспешная проверка вернула жетон — без обвинения")
            c8 = Client("10.60.0.8")
            claim(c8, "Рефанд-ФП")
            spend_all(c8, 1)
            ai.chat = broken_chat
            try:
                ai_check(c8)
            except Exception:
                pass
            ai.chat = good_chat
            s, st = essay_limits(c8)
            check("4/5 без reason", st.get("remaining") == 4 and st.get("reason") is None, str(st))

            # ---------------- 9. ИИ: школьная сеть и подзаряженный котёл ----------------
            section("9. ИИ: сеть выели чужие / котёл подзаряжен — без обвинения")
            a9a = Client("10.60.0.9")
            claim(a9a, "ИИ-чужой-ФП-9", "profile_math")
            agent_turns(a9a, 10)
            a9b = Client("10.60.0.9")  # тот же IP, свой браузер
            claim(a9b, "ИИ-школьник-ФП-9", "profile_math")
            s, q = agent_quota(a9b)
            check("сеть: 0 без reason", q.get("remaining") == 0 and q.get("reason") is None, str(q))
            s, tb = new_thread(a9b)
            tid9 = (tb.get("thread") or {}).get("id")
            s, body = turn(a9b, tid9, "ответь")
            check("ход 429 без reason", s == 429 and body.get("reason") is None, f"{s} {body}")
            # Подзаряженный котёл: тот же браузер, что выел, новый аккаунт
            a9c = Client("10.60.0.10")
            claim(a9c, "ИИ-старый-ФП-10", "profile_math")
            agent_turns(a9c, 10)
            db_bump_zeros(("ak:%", "an:%"), 3)
            a9c.request(base, "POST", "/api/auth/logout")
            claim(a9c, "ИИ-свежий-ФП-10", "profile_math")
            s, q = agent_quota(a9c)
            check("котёл: остаток 3 без reason", q.get("remaining") == 3 and q.get("reason") is None, str(q))
            s, tb = new_thread(a9c)
            tid10 = (tb.get("thread") or {}).get("id")
            s, body = turn(a9c, tid10, "ответь")
            check("ход проходит (место есть)", s == 200, f"{s} {str(body)[:90]}")

            # ---------------- 10. ИИ: переключение в том же браузере (контроль) ----------------
            section("10. ИИ: переключение в ТОМ ЖЕ браузере — reason (контроль)")
            a11 = Client("10.60.0.11")
            claim(a11, "ИИ-старый-ФП-11", "profile_math")
            agent_turns(a11, 10)
            a11.request(base, "POST", "/api/auth/logout")
            claim(a11, "ИИ-свежий-ФП-11", "profile_math")
            s, q = agent_quota(a11)
            check("0 + reason", q.get("remaining") == 0 and q.get("reason") == "farm_suspected", str(q))
        finally:
            try:
                httpd.shutdown()
            except Exception:
                pass
    print(f"\n{checks - failures}/{checks} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
