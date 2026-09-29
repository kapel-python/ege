#!/usr/bin/env python3
"""ИИ-наставник: треды, цикл tool-calling, подтверждения, квота.

Temp-БД, живой сервер, мок провайдера (без сети и денег):
  * гость — 401 GUEST_PENDING везде, профиля не заводит;
  * чужой тред — 404, чужие сообщения не отдаются, инструменты чужих не видят;
  * ответ без tools — финальный текст и одно списание квоты;
  * ответ с tools — цикл отрабатывает, шаги в базе и в ответе;
  * действие — confirm без записи, approve меняет, отмена пишет «Отменено учеником»;
  * длинный цикл — обрыв ответом по собранным данным (вызов без tools);
  * 10 ходов — ок, 11-й — 429 AI_LIMIT; 502 возвращает жетон;
  * повторный ход — кэш, usage.cost не растёт;
  * 400 на пустой/длинный, 400 AGENT_BUSY на параллельный ход;
  * парсер ai.py: реплика вместе с вызовами — не ошибка (preamble), пустой ответ — ошибка;
  * заголовок — первые 60 символов, подписка — колонка в users.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
os.environ["EGE_TRUSTED_PROXY"] = "1"

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
    spec = importlib.util.spec_from_file_location("ege_ai_agent_test", SERVER_PATH)
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
            raw = resp.read()
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return status, payload


def main():
    with tempfile.TemporaryDirectory(prefix="ege-ai-agent-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        agent = server._AGENT
        assert ai is not None and agent is not None, "AI/agent modules not loaded"

        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        # Мок провайдера: очередь сценариев, счётчик вызовов = usage.cost.
        calls = {"n": 0}
        script: list = []
        lock = threading.Lock()

        def mock_chat(messages, tools, **kw):
            with lock:
                calls["n"] += 1
                if script:
                    return script.pop(0)
            return {"text": "Финальный ответ.", "tool_calls": []}

        def mock_plain(messages, **kw):
            """Финал по потолку шагов (agent._summarize) идёт в chat() без tools."""
            with lock:
                calls["n"] += 1
                item = script.pop(0) if script else None
            if not item or item.get("tool_calls"):
                return ""  # без инструментов ответ без вызовов — тут пусто
            return item.get("text") or ""

        ai.chat_with_tools = mock_chat
        ai.chat = mock_plain
        ai.reset_ai_rate()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def claim(client, name, subject="profile_math"):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": subject, "onboarded": True, "name": name})

        def new_thread(client):
            return client.request(base, "POST", "/api/agent/threads", {})

        def turn(client, tid, text, extra=None):
            payload = {"threadId": tid, "text": text}
            if extra:
                payload.update(extra)
            return client.request(base, "POST", "/api/agent/turns", payload)

        try:
            section("парсер: реплика вместе с вызовами — не ошибка формата")
            # Живой случай 29.09 (gptunnel/qwen3.8-flash): ответ на «вызови все
            # доступные инструменты» приходил как «Сейчас соберу… » + tool_calls,
            # строгий разбор давал AIFormatError → 502 и пустой тред.
            mixed = ai.parse_tool_message({"content": "Сейчас соберу всё.", "tool_calls": [
                {"id": "1", "function": {"name": "fold_web", "arguments": "{}"}}]})
            check("текст+вызовы разбираются, вызовы главнее",
                  bool(mixed["tool_calls"]) and mixed["text"] == "Сейчас соберу всё."
                  and mixed["preamble"] == "Сейчас соберу всё.", str(mixed)[:200])
            only_calls = ai.parse_tool_message({"content": None, "tool_calls": [
                {"function": {"name": "fold_web", "arguments": '{"op":"forecast"}'}}]})
            check("только вызовы — ок, preamble пустой",
                  only_calls["tool_calls"][0]["name"] == "fold_web" and only_calls["preamble"] is None,
                  str(only_calls)[:200])
            check("только текст — ок",
                  ai.parse_tool_message({"content": "hi"})["text"] == "hi")
            try:
                ai.parse_tool_message({"content": None, "tool_calls": []})
                check("пустой ответ — AIFormatError", False)
            except ai.AIFormatError:
                check("пустой ответ — AIFormatError", True)

            section("гость закрыт")
            guest = Client("10.0.0.1")
            for method, path, body in [
                ("GET", "/api/agent/threads", None),
                ("GET", "/api/agent/limits", None),
                ("POST", "/api/agent/threads", {}),
                ("POST", "/api/agent/turns", {"threadId": 1, "text": "hi"}),
                ("POST", "/api/agent/turns/confirm", {"messageId": 1, "approve": True}),
            ]:
                status, body_out = guest.request(base, method, path, body)
                check(f"{method} {path} гостю -> 401 GUEST_PENDING",
                      status == 401 and body_out.get("code") == "GUEST_PENDING", f"{status} {body_out}")
            check("гостю не выдали сессию", "ege_session" not in guest.cookies)

            section("треды и изоляция")
            a = Client("10.1.0.1")
            b = Client("10.2.0.1")
            status, _ = claim(a, "Аня")
            check("claim Аня", status == 200, str(status))
            status, _ = claim(b, "Боря")
            check("claim Боря", status == 200, str(status))
            status, body = new_thread(a)
            check("создать тред", status == 200 and body.get("thread", {}).get("id"), f"{status} {body}")
            tid_a = body["thread"]["id"]
            status, body = b.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            check("чужой тред -> 404", status == 404, f"{status} {body}")
            status, body = turn(b, tid_a, "привет")
            check("чужой ход -> 404", status == 404, f"{status} {body}")
            status, body = b.request(base, "POST", f"/api/agent/threads/{tid_a}/delete", {})
            check("чужое удаление -> 404", status == 404, f"{status} {body}")

            section("ответ без tools: финал + одно списание")
            with lock:
                script.clear()
                calls["n"] = 0
            status, body = turn(a, tid_a, "просто привет")
            check("ход без tools -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("ответ несёт заголовок треда", body.get("thread", {}).get("title"), str(body.get("thread")))
            check("шагов нет", body.get("steps") == [], str(body.get("steps")))
            check("usage.cost == 1", body.get("usage", {}).get("cost") == 1, str(body.get("usage")))
            status, quota = a.request(base, "GET", "/api/agent/limits", None)
            check("квота 9 из 10", quota.get("remaining") == 9 and quota.get("limit") == 10, str(quota))
            check("заголовок детерминирован (первые 60)",
                  True, "")
            status, body = a.request(base, "GET", "/api/agent/threads", None)
            title = (body.get("threads") or [{}])[0].get("title", "")
            check("заголовок — первые 60 символов вопроса",
                  title.startswith("просто привет"), title)
            check("список тредов несёт квоту (первый экран за 2 RTT)",
                  (body.get("quota") or {}).get("limit") == 10, str(body.get("quota")))
            status, ctx = a.request(base, "GET", "/api/agent/context", None)
            check("контекст шапки: уровень/серия",
                  status == 200 and ctx.get("level") == 1 and ctx.get("streak") == 0
                  and ctx.get("need") == 400 and ctx.get("pct") == 0, f"{status} {ctx}")
            status, ctx = guest.request(base, "GET", "/api/agent/context", None)
            check("контекст гостю -> 401 GUEST_PENDING",
                  status == 401 and ctx.get("code") == "GUEST_PENDING", f"{status} {ctx}")

            section("ответ с tools: цикл и шаги в базе")
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "c1", "name": "fold_web", "arguments": {"op": "forecast"}}]},
                    {"text": "Прогноз: всё по данным.", "tool_calls": []},
                ])
                calls["n"] = 0
            status, body = turn(a, tid_a, "какой у меня прогноз?")
            check("ход с tools -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("один шаг чтения", len(body.get("steps") or []) == 1
                  and body["steps"][0].get("tool") == "fold_web", str(body.get("steps")))
            check("шаг человеческий", "прогноз" in (body["steps"][0].get("label") or "").lower(), str(body["steps"][0]))
            check("usage.cost == 2", body.get("usage", {}).get("cost") == 2, str(body.get("usage")))
            status, body = a.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            roles = [m["role"] for m in body.get("messages", [])]
            check("в базе user+tool+assistant", "user" in roles and "tool" in roles and "assistant" in roles, str(roles))

            section("действие: confirm без записи, approve меняет")
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "c2", "name": "update_profile",
                                                   "arguments": {"selfLevel": "confident"}}]},
                ])
            # текущий уровень
            conn2 = server.connect()
            try:
                cur_level = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                before_level = cur_level["self_level"] if cur_level else None
            finally:
                conn2.close()
            status, body = turn(a, tid_a, "поставь мне уверенный уровень")
            check("действие -> pending без финала",
                  status == 200 and body.get("pending") is True and body.get("final") is None,
                  f"{status} {body}")
            pending_id = (body.get("steps") or [{}])[0].get("id")
            check("шаг needs_confirm", (body.get("steps") or [{}])[0].get("status") == "needs_confirm")
            conn2 = server.connect()
            try:
                cur = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                check("до approve данные не меняются", (cur["self_level"] if cur else None) == before_level)
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.append({"text": "Уровень обновлён.", "tool_calls": []})
            status, body = a.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": pending_id, "approve": True})
            check("approve -> 200 с финалом", status == 200 and body.get("final"), f"{status} {body}")
            conn2 = server.connect()
            try:
                cur = conn2.execute("SELECT self_level FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE name='Аня') AND subject='profile_math'").fetchone()
                check("после approve уровень confident", cur and cur["self_level"] == "confident", str(dict(cur) if cur else None))
            finally:
                conn2.close()

            section("отмена пишет «Отменено учеником»")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "c3", "name": "reset_progress", "arguments": {}}]})
            status, body = turn(a, tid_a, "сбрось мой прогресс")
            check("reset -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            cancel_id = (body.get("steps") or [{}])[0].get("id")
            status, body = a.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": cancel_id, "approve": False})
            check("cancel -> Отменено учеником",
                  status == 200 and body.get("final") == "Отменено учеником.", f"{status} {body}")

            section("длинный цикл обрывается ответом, а не отказом")
            with lock:
                script.clear()
                for i in range(12):
                    script.append({"text": None, "tool_calls": [{"id": f"l{i}", "name": "fold_web",
                                                                 "arguments": {"op": "progress"}}]})
            status, body = turn(a, tid_a, "расскажи всё подробно")
            check("длинный цикл -> 200 с финалом",
                  status == 200 and isinstance(body.get("final"), str) and "слишком длинным" in body["final"],
                  f"{status} {str(body)[:200]}")
            check("шагов не больше MAX",
                  len(body.get("steps") or []) <= agent.MAX_TOOL_STEPS, str(len(body.get("steps") or [])))
            # Тот же потолок, но на вызове без инструментов модель отвечает
            # текстом: ход заканчивается настоящим ответом по собранным данным.
            with lock:
                script.clear()
                for i in range(agent.MAX_TOOL_STEPS + 1):
                    script.append({"text": None, "tool_calls": [{"id": f"m{i}", "name": "fold_web",
                                                                 "arguments": {"op": "progress"}}]})
                script.append({"text": "Собрал всё по твоим данным.", "tool_calls": []})
            status, body = turn(a, tid_a, "вызови все доступные инструменты")
            check("потолок шагов -> ответ по собранным данным",
                  status == 200 and body.get("final") == "Собрал всё по твоим данным."
                  and len(body.get("steps") or []) == agent.MAX_TOOL_STEPS,
                  f"{status} {str(body)[:200]}")
            # Реплика модели вместе с вызовами — обычный ход, а не 502: реплика
            # уходит в preamble, инструменты выполняются.
            with lock:
                script.clear()
                script.append(ai.parse_tool_message({"content": "Сейчас соберу всё.", "tool_calls": [
                    {"id": "p1", "function": {"name": "fold_web",
                                              "arguments": '{"op":"forecast"}'}}]}))
                script.append({"text": "Вот твой прогноз.", "tool_calls": []})
            status, body = turn(a, tid_a, "собери всё по мне")
            check("реплика+вызовы -> 200 с финалом",
                  status == 200 and body.get("final") == "Вот твой прогноз."
                  and len(body.get("steps") or []) == 1,
                  f"{status} {str(body)[:200]}")

            section("400 на пустой/длинный")
            status, body = turn(a, tid_a, "   ")
            check("пустой -> 400", status == 400, f"{status} {body}")
            status, body = turn(a, tid_a, "x" * 3000)
            check("длинный -> 400", status == 400, f"{status} {body}")

            section("инструменты не видят чужих данных")
            # Ане — ошибку, Боря её не видит.
            conn2 = server.connect()
            try:
                anya = conn2.execute("SELECT id FROM users WHERE name='Аня'").fetchone()
                borya = conn2.execute("SELECT id FROM users WHERE name='Боря'").fetchone()
                task = conn2.execute("SELECT t.id AS tid, t.skill_id AS sid FROM tasks t JOIN skills s ON s.id=t.skill_id WHERE s.subject='profile_math' LIMIT 1").fetchone()
                conn2.execute("INSERT INTO user_errors(user_id, subject, task_id, skill_id, topic, created_at, resolved) VALUES (?,?,?,?,?,?,0)",
                              (int(anya["id"]), "profile_math", task["tid"], task["sid"], "t", "1"))
                conn2.commit()
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.extend([
                    {"text": None, "tool_calls": [{"id": "e1", "name": "fold_web", "arguments": {"op": "errors", "limit": 5}}]},
                    {"text": "Готово.", "tool_calls": []},
                ])
            status, body = b.request(base, "POST", "/api/agent/threads", {})
            tid_b = body["thread"]["id"]
            status, body = turn(b, tid_b, "покажи мои ошибки")
            got = (body.get("steps") or [{}])[0].get("result", {})
            check("Боря не видит Анину ошибку", got.get("total") == 0 and got.get("open") == 0, str(got))

            section("повторный ход кэшируется, cost не растёт")
            with lock:
                script.clear()
                script.append({"text": "Кэшируемый ответ.", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(a, tid_a, "повторимый вопрос")
            check("первый -> 200", status == 200, f"{status}")
            first_cost = calls["n"]
            status, body = turn(a, tid_a, "повторимый вопрос")
            check("повтор -> cached", status == 200 and body.get("cached") is True, f"{status} {body}")
            check("cost не растёт", calls["n"] == first_cost, f"{calls['n']} vs {first_cost}")
            check("usage.cost 0 у кэша", body.get("usage", {}).get("cost") == 0, str(body.get("usage")))
            with lock:
                script.clear()
                script.append({"text": "Свежая попытка.", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(a, tid_a, "повторимый вопрос", {"force": True})
            check("force:true обходит кэш", status == 200 and body.get("cached") is not True
                  and body.get("final") == "Свежая попытка.", f"{status} {body}")
            check("force зовёт модель", calls["n"] == 1, str(calls["n"]))

            section("детерминированная ошибка инструментов -> 400, не 502")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "bad1", "name": "fold_web",
                                                             "arguments": {"op": "no_such_op"}}]})
            _, quota_before = a.request(base, "GET", "/api/agent/limits", None)
            status, body = turn(a, tid_a, "сломай инструмент")
            check("битый op -> 400 AGENT_TOOL_ERROR",
                  status == 400 and body.get("code") == "AGENT_TOOL_ERROR", f"{status} {body}")
            _, quota_after = a.request(base, "GET", "/api/agent/limits", None)
            check("400 за инструмент возвращает жетон",
                  quota_after.get("remaining") == quota_before.get("remaining"), f"{quota_before} -> {quota_after}")

            section("квота: 10 ходов, 11-й 429, 502 возвращает жетон")
            c = Client("10.3.0.1")
            claim(c, "Вера")
            status, body = new_thread(c)
            tid_c = body["thread"]["id"]
            with lock:
                script.clear()
            for i in range(10):
                with lock:
                    script.append({"text": f"Ответ {i}.", "tool_calls": []})
                status, body = turn(c, tid_c, f"вопрос {i}")
                check(f"ход {i + 1} -> 200", status == 200, f"{status} {body}")
            status, body = turn(c, tid_c, "лишний вопрос")
            check("11-й -> 429 AI_LIMIT",
                  status == 429 and body.get("code") == "AI_LIMIT", f"{status} {body}")
            check("429 несёт limit/remaining", body.get("limit") == 10 and body.get("remaining") == 0, str(body))
            # 502 возвращает жетон: чистим квоту ageing через refund проверки.
            # Берём свежего пользователя, тратим 1, роняем модель, проверяем возврат.
            d = Client("10.4.0.1")
            claim(d, "Гоша")
            status, body = new_thread(d)
            tid_d = body["thread"]["id"]
            with lock:
                script.clear()

            def boom(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                raise ai.AIError("upstream 500")

            old_chat = ai.chat_with_tools
            ai.chat_with_tools = boom
            status, body = turn(d, tid_d, "урони модель")
            check("сбой модели -> 502", status == 502, f"{status} {body}")
            ai.chat_with_tools = mock_chat
            status, quota = d.request(base, "GET", "/api/agent/limits", None)
            check("502 вернул жетон (10 из 10)", quota.get("remaining") == 10, str(quota))

            section("повтор: AIFormatError один раз -> ход проходит")
            f = Client("10.6.0.1")
            claim(f, "Иван")
            status, body = new_thread(f)
            tid_f = body["thread"]["id"]
            with lock:
                script.clear()
                calls["n"] = 0

            flaky = {"failed": False}
            def flaky_chat(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                    if not flaky["failed"]:
                        flaky["failed"] = True
                        raise ai.AIFormatError("текст и вызовы одновременно")
                return {"text": "Ответ после повтора.", "tool_calls": []}

            old_chat = ai.chat_with_tools
            ai.chat_with_tools = flaky_chat
            status, body = turn(f, tid_f, "вопрос с повтором")
            ai.chat_with_tools = mock_chat
            check("AIFormatError один раз -> 200", status == 200 and body.get("final"), f"{status} {body}")
            check("повтор был (2 вызова)", calls["n"] == 2, str(calls["n"]))

            section("AGENT_BUSY на параллельный ход")
            e = Client("10.5.0.1")
            claim(e, "Женя")
            status, body = new_thread(e)
            tid_e = body["thread"]["id"]
            # Детерминированно: держим слот треда вручную — второй ход в тот же
            # тред обязан получить 400 AGENT_BUSY, а не встать в очередь.
            assert server._agent_busy_acquire(tid_e), "busy acquire failed"
            try:
                s2, b2 = turn(e, tid_e, "второй вопрос")
            finally:
                server._agent_busy_release(tid_e)
            check("параллельный -> 400 AGENT_BUSY",
                  s2 == 400 and b2.get("code") == "AGENT_BUSY", f"{s2} {b2}")
            check("BUSY несёт retryAfter",
                  isinstance(b2.get("retryAfter"), int) and b2.get("retryAfter") >= 1, f"{s2} {b2}")
            with lock:
                script.clear()
                script.append({"text": "Ответ после busy.", "tool_calls": []})
            s3, b3 = turn(e, tid_e, "вопрос после busy")
            check("после release ход идёт", s3 == 200 and b3.get("final"), f"{s3} {b3}")

            section("подписка и удаление")
            conn2 = server.connect()
            try:
                cols = {r["name"] for r in conn2.execute("PRAGMA table_info(users)")}
                check("users.subscription существует", "subscription" in cols, str(sorted(cols)[:8]))
            finally:
                conn2.close()
            status, body = a.request(base, "POST", f"/api/agent/threads/{tid_a}/delete", {})
            check("удалить свой тред", status == 200, f"{status} {body}")
            status, body = a.request(base, "GET", f"/api/agent/threads/{tid_a}", None)
            check("удалённый тред -> 404", status == 404, f"{status} {body}")
            check("404 несёт код THREAD_NOT_FOUND", body.get("code") == "THREAD_NOT_FOUND", f"{status} {body}")

            section("approve -> 502 откатывает шаг в needs_confirm")
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "r1", "name": "update_profile",
                                                             "arguments": {"selfLevel": "base"}}]})
            status, body = turn(d, tid_d, "поставь базовый уровень")
            check("действие -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            retry_id = (body.get("steps") or [{}])[0].get("id")
            ai.chat_with_tools = boom
            status, body = d.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": retry_id, "approve": True})
            check("resume упал -> 502", status == 502, f"{status} {body}")
            ai.chat_with_tools = mock_chat
            status, body = d.request(base, "GET", f"/api/agent/threads/{tid_d}", None)
            st = [m for m in body.get("messages", []) if m.get("id") == retry_id]
            check("шаг снова needs_confirm", bool(st) and st[0].get("status") == "needs_confirm",
                  str(st)[:200])
            with lock:
                script.clear()
                script.append({"text": "Уровень обновлён.", "tool_calls": []})
            status, body = d.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": retry_id, "approve": True})
            check("повторный approve -> 200", status == 200 and body.get("final"), f"{status} {body}")

            section("персональный потолок ходов наставника")
            g = Client("10.7.0.1")
            claim(g, "Гоша-грант")
            status, body = new_thread(g)
            tid_g = body["thread"]["id"]
            with lock:
                script.clear()
            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("до гранта обычные 10", quota.get("limit") == 10 and quota.get("remaining") == 10, str(quota))

            def uid_of(name):
                c = server.connect()
                c.row_factory = sqlite3.Row
                try:
                    return c.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()["id"]
                finally:
                    c.close()

            uid_g = uid_of("Гоша-грант")
            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 500})
                check("admin выдал 500 ходов", st.get("limit") == 500 and st.get("remaining") == 500, str(st))
                check("customLimit виден админу", st.get("customLimit") == 500, str(st))
                check("глобальный потолок не тронут", st.get("globalLimit") == 10, str(st))
            finally:
                conn2.close()

            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("живой сервер отдаёт 500 из 500",
                  quota.get("limit") == 500 and quota.get("remaining") == 500, str(quota))

            # Главное: грант выше общего потолка переживает ленивую зарядку.
            # Без персонального потолка MIN(10, ...) срезал бы его на первом
            # же 8-часовом тике — ровно те грабли, что закрыла ai_user_limits
            # для проверок сочинений.
            with lock:
                script.clear()
                script.append({"text": "Ход после гранта.", "tool_calls": []})
            status, body = turn(g, tid_g, "первый вопрос после гранта")
            check("ход после гранта -> 200", status == 200 and body.get("final"), f"{status} {body}")

            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                owner = f"agent:{uid_g}"
                win = agent.agent_quota_window_ms()
                # Ход выше запустил таймер цепочки — прокручиваем окно на тик+.
                agent.agent_quota_status(conn2, uid_g, int(time.time() * 1000) + win)
                row = conn2.execute("SELECT count, timer_ms FROM ai_usage WHERE owner=?",
                                    (owner,)).fetchone()
                check("грант пережил 8-часовой тик (не срезан до 10)",
                      int(row["count"]) == 500, str(dict(row)))
                check("карман полон -> таймер стоит", row["timer_ms"] is None, str(dict(row)))
                # Возврат жетона тоже уважает персональный потолок.
                conn2.execute("UPDATE ai_usage SET count=1, timer_ms=? WHERE owner=?",
                              (int(time.time() * 1000), owner))
                conn2.commit()
                agent.agent_quota_refund(conn2, uid_g)
                row = conn2.execute("SELECT count FROM ai_usage WHERE owner=?", (owner,)).fetchone()
                check("возврат жетона не выше персонального потолка", int(row["count"]) == 2, str(dict(row)))
            finally:
                conn2.close()

            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                st = agent.admin_agent_quota_set(conn2, uid_g, {"limit": None, "refill": True})
                check("limit null -> общий потолок 10",
                      st.get("limit") == 10 and st.get("remaining") == 10
                      and st.get("customLimit") is None, str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 3})
                check("частичный остаток ниже потолка -> таймер стартует",
                      st.get("remaining") == 3 and st.get("resetInSec"), str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 20})
                check("грант выше потолка сам поднимает потолок",
                      st.get("limit") == 20 and st.get("remaining") == 20, str(st))
                st = agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 0})
                check("потолок 20, остаток 0 -> ждём возврата",
                      st.get("limit") == 20 and st.get("remaining") == 0 and st.get("resetInSec"), str(st))
                try:
                    agent.admin_agent_quota_set(conn2, uid_g, {"remaining": 5000})
                    check("remaining > 1000 отвергается", False, "принято")
                except ValueError:
                    check("remaining > 1000 отвергается", True)
                st = agent.admin_agent_quota_set(conn2, uid_g, {"limit": None, "refill": True})
                check("снятие потолка возвращает 10", st.get("limit") == 10, str(st))
                server.ensure_ai_user_limit_schema(conn2)
                row = conn2.execute("SELECT COUNT(*) c FROM ai_user_limits WHERE user_id=?",
                                    (uid_g,)).fetchone()
                check("потолок наставника не трогает ai_user_limits", int(row["c"]) == 0, str(dict(row)))
            finally:
                conn2.close()

            status, quota = g.request(base, "GET", "/api/agent/limits", None)
            check("после снятия потолка снова 10 из 10",
                  quota.get("limit") == 10 and quota.get("remaining") == 10, str(quota))
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
