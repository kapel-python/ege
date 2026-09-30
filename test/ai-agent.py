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
                  status == 200 and isinstance(body.get("final"), str) and "не успел" in body["final"],
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

            section("replaceLast: ход ЗАМЕНЯЕТ последнюю пару, а не дублирует")
            # Свой клиент с большим грантом: у Ани к этому месту жетоны
            # предыдущих секций уже на исходе, а здесь каждый ход платит.
            c4 = Client("10.8.0.1")
            claim(c4, "Дина-замена")
            _, body = new_thread(c4)
            tid_d = body["thread"]["id"]
            conn2 = server.connect()
            conn2.row_factory = sqlite3.Row
            try:
                uid_d = conn2.execute("SELECT id FROM users WHERE name='Дина-замена'").fetchone()["id"]
                agent.admin_agent_quota_set(conn2, uid_d, {"remaining": 100})
            finally:
                conn2.close()
            with lock:
                script.clear()
                script.append({"text": "Первый ответ.", "tool_calls": []})
                script.append({"text": "Второй ответ.", "tool_calls": []})
            status, body = turn(c4, tid_d, "заменяемый вопрос")
            check("обычный ход -> 200", status == 200, f"{status} {body}")
            status, body = turn(c4, tid_d, "заменяемый вопрос", {"replaceLast": True})
            check("replaceLast с тем же текстом обходит кэш (не cached)",
                  status == 200 and body.get("cached") is not True, f"{status} {body}")
            check("replaceLast -> новый ответ от модели",
                  body.get("final") == "Второй ответ.", str(body.get("final")))

            def msgs_of(tid):
                c = server.connect()
                c.row_factory = sqlite3.Row
                try:
                    return c.execute("SELECT role, content FROM agent_messages"
                                     " WHERE thread_id=? ORDER BY seq", (int(tid),)).fetchall()
                finally:
                    c.close()

            rows = msgs_of(tid_d)
            user_cnt = sum(1 for r in rows if r["role"] == "user" and (r["content"] or "") == "заменяемый вопрос")
            check("в базе ОДИН такой вопрос (пара заменена, не продублирована)", user_cnt == 1, str(user_cnt))
            finals = [r["content"] for r in rows if r["role"] == "assistant" and (r["content"] or "").strip()]
            check("в базе последний финал — новый", finals[-1] == "Второй ответ.", str(finals[-2:]))

            status, body = turn(c4, tid_d, "изменённый вопрос", {"replaceLast": True})
            check("замена на другой текст -> 200", status == 200, f"{status} {body}")
            rows = msgs_of(tid_d)
            check("старый вопрос исчез из базы",
                  not any(r["role"] == "user" and r["content"] == "заменяемый вопрос" for r in rows),
                  str([r["content"] for r in rows if r["role"] == "user"][-2:]))

            # Неуспех заменяющего хода не сносит старую пару (снос — в транзакции успеха).
            def boom_chat(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                raise ai.AIError("upstream 500")
            saved = ai.chat_with_tools
            ai.chat_with_tools = boom_chat
            try:
                status, body = turn(c4, tid_d, "вопрос со сбоем", {"replaceLast": True})
                check("сбой модели -> 502", status == 502, f"{status} {body}")
            finally:
                ai.chat_with_tools = saved
            rows = msgs_of(tid_d)
            check("после 502 старая пара цела (изменённый вопрос на месте)",
                  any(r["role"] == "user" and r["content"] == "изменённый вопрос" for r in rows)
                  and not any(r["content"] == "вопрос со сбоем" for r in rows),
                  str([r["content"] for r in rows if r["role"] == "user"][-2:]))

            # replaceLast поверх ожидания подтверждения действия — 400, ничего не ломает.
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "act1", "name": "reset_progress",
                                                             "arguments": {}}]})
            c3 = Client("10.9.0.1")
            claim(c3, "Дина-pending")
            _, body = new_thread(c3)
            tid_v = body["thread"]["id"]
            status, body = turn(c3, tid_v, "разбери ошибку")
            check("ход встал на подтверждение", status == 200 and body.get("pending") is True, f"{status} {body}")
            status, body = turn(c3, tid_v, "другой вопрос", {"replaceLast": True})
            check("replaceLast при needs_confirm -> 400 AGENT_PENDING",
                  status == 400 and body.get("code") == "AGENT_PENDING", f"{status} {body}")
            rows = msgs_of(tid_v)
            check("ожидающий шаг не снесён",
                  any(r["role"] == "tool" for r in rows) and not any(r["content"] == "другой вопрос" for r in rows),
                  str([(r["role"], r["content"][:20]) for r in rows]))

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
            temps = {"seen": []}
            def flaky_chat(messages, tools, **kw):
                with lock:
                    calls["n"] += 1
                    temps["seen"].append((kw.get("temperature"), kw.get("timeout")))
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
            # Повтор при temperature 0 вернул бы ТОТ ЖЕ вырожденный ответ —
            # ровно ту ошибку, ради которой повтор и делается. Второй вызов
            # поэтому идёт с чуть другой температурой.
            check("повтор идёт с другой температурой (иначе он бессмыслен)",
                  len(temps["seen"]) == 2 and temps["seen"][0][0] == 0.0
                  and temps["seen"][1][0] == server._AGENT_RETRY_TEMPERATURE
                  and temps["seen"][1][0] != temps["seen"][0][0], str(temps["seen"]))
            # Бюджет хода спускается вниз и ограничивает один вызов:
            # 90-секундный потолок раньше проверялся только между шагами, и один
            # зависший вызов провайдера тянул ход ещё на EGE_AI_TIMEOUT_SEC.
            check("вызов ограничен остатком бюджета хода",
                  all(isinstance(t, (int, float)) and 0 < t <= ai.DEFAULT_TIMEOUT_SEC
                      for _, t in temps["seen"]), str(temps["seen"]))
            # Сам потолок одного вызова: не больше общего таймаута провайдера и
            # не больше того, что реально осталось от хода.
            check("_agent_call_timeout: без бюджета — общий таймаут",
                  server._agent_call_timeout(None) is None
                  and server._agent_call_timeout(10.0) == 10.0
                  and server._agent_call_timeout(1000.0) == ai.DEFAULT_TIMEOUT_SEC
                  and server._agent_call_timeout(0) is None,
                  f"{server._agent_call_timeout(None)} {server._agent_call_timeout(10.0)} "
                  f"{server._agent_call_timeout(1000.0)} {server._agent_call_timeout(0)}")

            section("повтор есть и в resume после подтверждения")
            # Раньше у _chat_cf повтора не было вовсе: одна форматная ошибка
            # после уже применённого действия отдавала 502 и откатывала шаг.
            with lock:
                script.clear()
                script.append({"text": None, "tool_calls": [{"id": "cf1", "name": "update_profile",
                                                            "arguments": {"selfLevel": "base"}}]})
            status, body = turn(f, tid_f, "поставь базовый уровень")
            check("действие -> pending", status == 200 and body.get("pending") is True, f"{status} {body}")
            confirm_id = (body.get("steps") or [{}])[0].get("id")
            flaky2 = {"failed": False, "n": 0}
            def flaky_cf(messages, tools, **kw):
                with lock:
                    flaky2["n"] += 1
                    if not flaky2["failed"]:
                        flaky2["failed"] = True
                        raise ai.AIFormatError("пустой ответ модели")
                return {"text": "Уровень обновлён после повтора.", "tool_calls": []}
            ai.chat_with_tools = flaky_cf
            status, body = f.request(base, "POST", "/api/agent/turns/confirm",
                                     {"messageId": confirm_id, "approve": True})
            ai.chat_with_tools = mock_chat
            check("resume с одной форматной ошибкой -> 200",
                  status == 200 and (body.get("final") or "").startswith("Уровень обновлён"),
                  f"{status} {body}")
            check("resume позвал модель дважды (один повтор)", flaky2["n"] == 2, str(flaky2["n"]))
            status, body = f.request(base, "GET", f"/api/agent/threads/{tid_f}", None)
            done = [m for m in body.get("messages", []) if m.get("id") == confirm_id]
            check("шаг применён, а не откатан", bool(done) and done[0].get("status") == "applied",
                  str(done)[:160])

            section("кнопки-продолжения: модель даёт свои, сервер режет блок из текста")
            # Свой клиент с большим грантом: у Ани к этому месту жетоны
            # предыдущих секций уже на исходе, а тут каждый ход платит.
            k = Client("10.11.0.1")
            claim(k, "Кира-кнопки")
            conn_k = server.connect()
            conn_k.row_factory = sqlite3.Row
            try:
                uid_k = conn_k.execute("SELECT id FROM users WHERE name='Кира-кнопки'").fetchone()["id"]
                agent.admin_agent_quota_set(conn_k, uid_k, {"remaining": 200})
            finally:
                conn_k.close()
            _, body = new_thread(k)
            tid_k = body["thread"]["id"]
            # Формат блока — часть контракта: если он утечёт в final, ученик
            # увидит в ленте кусок служебного JSON.
            raw, sugg = agent.split_suggestions(
                "Держи разбор.\n\n```suggest\n"
                '[{"label":"Дай задачу","ask":"Дай задачу на производную, простую."},'
                '{"label":"Проще","ask":"Объясни то же самое проще."}]\n'
                "```")
            check("блок вырезан из текста, варианты разобраны",
                  raw == "Держи разбор." and len(sugg) == 2
                  and sugg[0]["label"] == "Дай задачу" and sugg[0]["ask"].startswith("Дай задачу"),
                  f"{raw!r} {sugg}")
            check("построчный формат блока тоже принимается (label | ask)",
                  agent.split_suggestions("Текст.\n```suggest\nРазбери ошибку | Разбери мою ошибку по шагам.\n```")[1]
                  == [{"label": "Разбери ошибку", "ask": "Разбери мою ошибку по шагам."}])
            check("свободное содержимое кнопок проходит как есть (хоть «я умный»)",
                  agent.split_suggestions("Текст.\n```suggest\n"
                                          '[{"label":"я умный","ask":"Докажи, что ты умнее меня, наставник."}]\n'
                                          "```")[1]
                  == [{"label": "я умный", "ask": "Докажи, что ты умнее меня, наставник."}])
            check("мусор в блоке не ломает ответ и не даёт пустых кнопок",
                  agent.split_suggestions("Ответ.\n```suggest\nне json и не список\n```")[0] == "Ответ."
                  and agent.split_suggestions("Ответ.\n```suggest\nне json и не список\n```")[1] == [])
            check("больше трёх вариантов не берём, дубли по ask схлопываются",
                  len(agent.split_suggestions("x\n```suggest\n"
                                              + json.dumps([{"label": f"L{i}", "ask": f"вопрос {i}"} for i in range(6)])
                                              + "\n```")[1]) == agent.MAX_SUGGESTIONS
                  and len(agent.split_suggestions("x\n```suggest\n"
                                                  + json.dumps([{"label": "A", "ask": "тот же"},
                                                                {"label": "B", "ask": "тот же"}])
                                                  + "\n```")[1]) == 1)

            with lock:
                script.clear()
                script.append({"text": "Собрал по тебе.\n\n```suggest\n"
                                       '[{"label":"Разбери ошибку","ask":"Разбери мою ошибку по шагам."},'
                                       '{"label":"Дай задачу","ask":"Дай задачу на слабую тему."}]\n'
                                       "```", "tool_calls": []})
            status, body = turn(k, tid_k, "расскажи про прогресс")
            check("ход отдаёт suggests клиенту",
                  status == 200 and [s["label"] for s in (body.get("suggests") or [])]
                  == ["Разбери ошибку", "Дай задачу"], f"{status} {body.get('suggests')}")
            check("служебный блок не попал в текст ответа",
                  body.get("final") == "Собрал по тебе.", repr(body.get("final")))
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            last = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]
            check("в базе тоже чистый текст (блок в историю не уходит)",
                  last["content"] == "Собрал по тебе." and "suggest" not in last["content"],
                  repr(last["content"]))
            check("история отдаёт НАСТОЯЩИЕ кнопки ответа (слова модели, не шаблон)",
                  last.get("suggests") == [{"label": "Разбери ошибку", "ask": "Разбери мою ошибку по шагам."},
                                           {"label": "Дай задачу", "ask": "Дай задачу на слабую тему."}],
                  repr(last.get("suggests")))
            # Кэшированный повтор того же вопроса: кнопки — те же, из базы.
            status, body = turn(k, tid_k, "расскажи про прогресс")
            check("кэшированный ход отдаёт сохранённые кнопки",
                  status == 200 and body.get("cached") is True
                  and [x["label"] for x in (body.get("suggests") or [])]
                  == ["Разбери ошибку", "Дай задачу"], f"{status} {body.get('suggests')}")

            with lock:
                script.clear()
                script.append({"text": "Просто ответ без блока.", "tool_calls": []})
            status, body = turn(k, tid_k, "ещё вопрос")
            check("без блока кнопок нет (а не дежурный набор)",
                  status == 200 and body.get("suggests") == [],
                  f"{status} {body.get('suggests')}")
            with lock:
                script.clear()
                script.append({"text": "Дерзкий ответ.\n\n```suggest\n"
                                       '[{"label":"я умный","ask":"Докажи, что ты умнее меня, наставник."},'
                                       '{"label":"ещё дерзче","ask":"Придумай вопрос посложнее."}]\n'
                                       "```", "tool_calls": []})
            status, body = turn(k, tid_k, "дерзни")
            check("свободные названия кнопок доходят до клиента как есть",
                  status == 200 and [x["label"] for x in (body.get("suggests") or [])]
                  == ["я умный", "ещё дерзче"], f"{status} {body.get('suggests')}")
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            last = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]
            check("свободные кнопки переживают перезагрузку (лежат в базе)",
                  [x["label"] for x in (last.get("suggests") or [])] == ["я умный", "ещё дерзче"],
                  repr(last.get("suggests")))

            # Длинный ответ: блок кнопок стоит В КОНЦЕ, за прежним потолком в
            # 8000 знаков. Раньше текст резался до разбора блока, и у длинного
            # ответа кнопки пропадали совсем.
            long_answer = ("Разбираю твои ошибки по шагам. " * 320).strip()
            with lock:
                script.clear()
                script.append({"text": long_answer + "\n\n```suggest\n"
                               '[{"label":"Дай задачу","ask":"Дай задачу на производную."}]\n```',
                               "tool_calls": []})
            status, body = turn(k, tid_k, "разбери мои ошибки подробно")
            check("кнопки выживают у длинного ответа (блок не срезан потолком)",
                  status == 200 and len(body.get("final") or "") > 8000
                  and [s["label"] for s in (body.get("suggests") or [])] == ["Дай задачу"]
                  and "suggest" not in (body.get("final") or ""),
                  f"{status} len={len(body.get('final') or '')} {body.get('suggests')}")
            status, body = k.request(base, "GET", f"/api/agent/threads/{tid_k}", None)
            stored = [m for m in body.get("messages", []) if m["role"] == "assistant"][-1]["content"]
            check("в базе длинный ответ тоже без блока и в пределах потолка",
                  "suggest" not in stored and len(stored) <= agent.AGENT_REPLY_MAX,
                  f"len={len(stored)}")

            check("потолки ответа согласованы (ai.AI_REPLY_MAX == agent.AGENT_REPLY_MAX)",
                  ai.AI_REPLY_MAX == agent.AGENT_REPLY_MAX,
                  f"{ai.AI_REPLY_MAX} vs {agent.AGENT_REPLY_MAX}")
            check("потолок ответа действительно шире прежних 8000",
                  agent.AGENT_REPLY_MAX > 8000, str(agent.AGENT_REPLY_MAX))

            section("«сейчас посмотрю» без вызова -> инструмент зовётся")
            # Живой случай: «посмотри мой профиль» → «Сейчас посмотрю твой
            # профиль» и НИ ОДНОГО вызова. Правило в промпте лечит не всех,
            # поэтому цикл переспрашивает, а потом зовёт инструмент сам.
            with lock:
                script.clear()
                script.append({"text": "Сейчас посмотрю твой профиль", "tool_calls": []})
                script.append({"text": None, "tool_calls": [
                    {"id": "s1", "name": "fold_web", "arguments": {"op": "profile"}}]})
                script.append({"text": "Ты Иван, уровень base.", "tool_calls": []})
            status, body = turn(k, tid_k, "посмотри мой профиль")
            check("обещание без вызова -> ход всё равно с шагом",
                  status == 200 and len(body.get("steps") or []) == 1
                  and body["steps"][0]["tool"] == "fold_web"
                  and body.get("final") == "Ты Иван, уровень base.", f"{status} {str(body)[:200]}")

            # Модель упрямится и после переспроса: сервер зовёт инструмент сам,
            # выбирая его по вопросу, и отвечает по данным — без блока кнопок
            # «сейчас посмотрю» на экране.
            with lock:
                script.clear()
                script.append({"text": "Сейчас проверю твои ошибки.", "tool_calls": []})
                script.append({"text": "Сейчас проверю твои ошибки.", "tool_calls": []})
                script.append({"text": "Вот что видно по ошибкам.", "tool_calls": []})
            status, body = turn(k, tid_k, "где я ошибаюсь?")
            check("упрямое обещание -> сервер зовёт инструмент сам",
                  status == 200 and len(body.get("steps") or []) == 1
                  and body["steps"][0]["tool"] == "fold_web"
                  and body["steps"][0]["args"].get("op") == "errors"
                  and body.get("final") == "Вот что видно по ошибкам.", f"{status} {str(body)[:240]}")

            # Обычный короткий ответ (приветствие) переспросом не ломается:
            # вопрос не про данные — лишнего вызова быть не должно.
            with lock:
                script.clear()
                script.append({"text": "Привет! Чем помочь?", "tool_calls": []})
                calls["n"] = 0
            status, body = turn(k, tid_k, "привет")
            check("приветствие отвечает сразу, без вызова и переспроса",
                  status == 200 and body.get("final") == "Привет! Чем помочь?"
                  and not (body.get("steps") or []) and calls["n"] == 1,
                  f"{status} {str(body)[:200]} cost={calls['n']}")

            section("невидимые повторы переживают серию сбоев")
            # Три подряд неудачных вызова модели раньше давали 502 (два повтора
            # и всё): теперь температура растёт 0 → 0.3 → 0.6 и попыток хватает.
            h = Client("10.10.0.1")
            claim(h, "Егор-серия")
            _, body = new_thread(h)
            tid_h = body["thread"]["id"]
            temps_h = {"seen": []}

            def always_fail(messages, tools, **kw):
                with lock:
                    temps_h["seen"].append(kw.get("temperature"))
                raise ai.AIError("upstream 500")

            saved_chat = ai.chat_with_tools
            ai.chat_with_tools = always_fail
            try:
                status, body = turn(h, tid_h, "сбойный вопрос")
            finally:
                ai.chat_with_tools = saved_chat
            check("три попытки с растущей температурой",
                  temps_h["seen"][:3] == [0.0, server._AGENT_RETRY_TEMPERATURE, 0.6], str(temps_h["seen"]))
            check("серия сбоев -> 502 (жетон вернётся)", status == 502, f"{status} {body}")

            with lock:
                script.clear()
                script.append({"text": "Ответ со второй попытки.", "tool_calls": []})
            status, quota = h.request(base, "GET", "/api/agent/limits", None)
            check("502 не списал жетон", quota.get("remaining") == 10, str(quota))
            status, body = turn(h, tid_h, "нормальный вопрос")
            check("после сбоя ход идёт как обычно", status == 200 and body.get("final"), f"{status} {body}")

            section("потолок хода: сетка взята с запасом, а не отказ")
            # run_cycle напрямую: бюджет задаём сами, ждать 90 секунд не надо.
            conn3 = server.connect()
            conn3.row_factory = sqlite3.Row
            try:
                anya_id = int(conn3.execute("SELECT id FROM users WHERE name='Аня'").fetchone()["id"])

                spent = {"b": []}

                def budgeted(messages, tools, budget=None):
                    spent["b"].append(budget)
                    # Съедаем бюджет хода: мгновенный мок иначе успевает
                    # выбить все 10 шагов, а тут проверяем именно обрыв.
                    time.sleep(0.3)
                    if tools:
                        return {"text": None, "tool_calls": [
                            {"id": "bt1", "name": "fold_web", "arguments": {"op": "progress"}}]}
                    return {"text": "", "tool_calls": []}

                steps, final, pending = agent.run_cycle(
                    conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                    budgeted, deadline=time.monotonic() + agent.TURN_CALL_FLOOR_SEC + 0.25)
                check("истёкший бюджет с собранными шагами -> честный ответ, не 502",
                      len(steps) == 1 and isinstance(final, str) and "не успел" in final
                      and pending is None, f"{len(steps)} {final!r}")
                # Вызовы хода ограничены остатком бюджета, а финал по собранным
                # данным (_summarize) получает СВОЁ окно TURN_SUMMARY_EXTRA_SEC:
                # к этому моменту бюджет хода обычно исчерпан, и без своего окна
                # честный ответ подменялся бы просьбой уточнить вопрос — ровно
                # тогда, когда все данные уже на руках (так и было: «не успел»
                # вместо ответа приходил даже при живом провайдере).
                check("шаг хода ограничен остатком бюджета, финал — своим окном",
                      len(spent["b"]) >= 2 and spent["b"][0] <= agent.TURN_CALL_FLOOR_SEC + 0.3
                      and spent["b"][-1] <= agent.TURN_SUMMARY_EXTRA_SEC,
                      str(spent["b"]))

                # Бюджет убывает от шага к шагу — потолок один на весь ход,
                # а не на каждый вызов с нуля.
                two_budgets = []

                def two_steps(messages, tools, budget=None):
                    two_budgets.append(budget)
                    if len(two_budgets) == 1:
                        return {"text": None, "tool_calls": [
                            {"id": "bt2", "name": "fold_web", "arguments": {"op": "progress"}}]}
                    return {"text": "Второй ответ.", "tool_calls": []}

                steps, final, pending = agent.run_cycle(
                    conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                    two_steps, deadline=time.monotonic() + 30.0)
                check("два шага -> бюджет уменьшился",
                      len(two_budgets) == 2 and two_budgets[1] < two_budgets[0], str(two_budgets))
                check("два шага -> обычный ответ", len(steps) == 1 and final == "Второй ответ.",
                      f"{len(steps)} {final!r}")

                def instant(messages, tools, budget=None):
                    return {"text": "Готовый ответ.", "tool_calls": []}

                try:
                    agent.run_cycle(conn3, anya_id, "profile_math", [{"role": "user", "content": "hi"}],
                                    instant, deadline=time.monotonic() - 1.0)
                    check("истёкший бюджет без единого шага -> 502 (жетон вернётся)", False, "ответ вместо отказа")
                except TimeoutError:
                    check("истёкший бюджет без единого шага -> 502 (жетон вернётся)", True)
            finally:
                conn3.close()

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
