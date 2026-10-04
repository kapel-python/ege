#!/usr/bin/env python3
"""Второй фактор входа в админку: заявка + подтверждение в Telegram.

Проверяется ровно то, что нельзя увидеть на глаз (живой сервер, temp-БД,
фейковый Bot API через EGE_TELEGRAM_API_URL — наружу ничего не ходит):

1. без бота вход остаётся парольным (старый путь цел);
2. при боте верный пароль сессию НЕ открывает: ответ — заявка (pending),
   куки ege_admin нет, /api/admin/* отвечает 401;
3. владелец получает сообщение с кодом/IP и кнопками; код в ответе
   совпадает с кодом в сообщении;
4. опрос без решения — pending; чужой браузер и битый токен — 404;
5. «Подтвердить» из своего чата открывает сессию (кука + /api/admin/* 200),
   заявка съедается (повторный опрос — 404);
6. «Отклонить» — 403, сессии нет;
7. решение из ЧУЖОГО чата игнорируется (заявка остаётся pending);
8. просрочка — 410, без сессии;
9. отмена — ok, после неё опрос 404; чужая отмена чужую заявку не сносит;
10. капы живых заявок (3/браузер, 5/IP) — дальше 429, владелец не спамится;
11. неверный пароль при боте — 401 без заявки и без сообщения;
12. мёртвый Bot API — 503 TELEGRAM_UNAVAILABLE без висящей заявки;
13. токены заявок лежат в базе только как sha256;
14. в сообщении нет пароля; одобрение/отказ видны в аудите.

Запуск из корня репозитория: python3 test/admin-telegram.py
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

ADMIN_PASSWORD = "correct-horse-admin-1"
BOT_TOKEN = "test-bot-token-1"
ADMIN_CHAT = "777001"
FOREIGN_CHAT = "666002"

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


# ---------------------------------------------------------------------------
# Фейковый Bot API: sendMessage/getUpdates/answerCallbackQuery/editMessageText.
# ---------------------------------------------------------------------------
class FakeTelegram:
    def __init__(self):
        self.sent: list[dict] = []
        self.updates: list[dict] = []
        self.callbacks_answered: list[str] = []
        self.edits: list[dict] = []
        self.fail_send = False
        self._next_update = 100
        self._next_message = 1
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _send(self, code, body: bytes):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _path(self):
                parsed = urllib.parse.urlparse(self.path)
                return parsed.path, urllib.parse.parse_qs(parsed.query)

            def _method(self):
                path, _ = self._path()
                prefix = f"/bot{BOT_TOKEN}/"
                if not path.startswith(prefix):
                    return None
                return path[len(prefix):]

            def do_GET(self):
                method = self._method()
                if method != "getUpdates":
                    self._send(404, b'{"ok":false}')
                    return
                _, query = self._path()
                try:
                    offset = int((query.get("offset") or ["0"])[0] or 0)
                except ValueError:
                    offset = 0
                items = [u for u in outer.updates if int(u.get("update_id", 0)) >= offset]
                self._send(200, json.dumps({"ok": True, "result": items}).encode())

            def do_POST(self):
                method = self._method()
                if method is None:
                    self._send(404, b'{"ok":false}')
                    return
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    payload = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    payload = {}
                if method == "sendMessage":
                    if outer.fail_send:
                        self._send(500, b'{"ok":false}')
                        return
                    outer.sent.append(payload)
                    mid = outer._next_message
                    outer._next_message += 1
                    self._send(200, json.dumps({"ok": True, "result": {"message_id": mid}}).encode())
                    return
                if method == "answerCallbackQuery":
                    outer.callbacks_answered.append(payload)
                    self._send(200, b'{"ok":true,"result":true}')
                    return
                if method == "editMessageText":
                    outer.edits.append(payload)
                    self._send(200, b'{"ok":true,"result":true}')
                    return
                self._send(404, b'{"ok":false}')

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def queue_message(self, chat: str, text: str):
        update_id = self._next_update
        self._next_update += 1
        self.updates.append({
            "update_id": update_id,
            "message": {
                "message_id": update_id,
                "chat": {"id": int(chat), "type": "private"},
                "from": {"id": int(chat)},
                "text": text,
            },
        })

    def queue_decision(self, short: str, approve: bool, chat: str = ADMIN_CHAT):
        action = "ok" if approve else "no"
        update_id = self._next_update
        self._next_update += 1
        self.updates.append({
            "update_id": update_id,
            "callback_query": {
                "id": f"cb-{update_id}",
                "from": {"id": int(chat)},
                "message": {"message_id": 1, "chat": {"id": int(chat)}},
                "data": f"egeadm:{short}:{'ok' if approve else 'no'}",
            },
        })
        return action


# ---------------------------------------------------------------------------
# Клиент теста.
# ---------------------------------------------------------------------------
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_device():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), NoRedirect())
    return opener, jar


def request(opener, base, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=15) as response:
            raw = response.read()
            return response.status, dict(response.headers), _maybe_json(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, dict(exc.headers), _maybe_json(raw)


def _maybe_json(raw: bytes):
    try:
        return json.loads(raw or b"{}")
    except ValueError:
        return {}


def cookie_value(jar, name):
    for cookie in jar:
        if cookie.name == name:
            return cookie.value
    return None


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    for key in ("EGE_TELEGRAM_BOT_TOKEN", "EGE_TELEGRAM_ADMIN_CHAT_ID",
                "EGE_TELEGRAM_API_URL", "EGE_ADMIN_PENDING_TTL_SEC"):
        os.environ.pop(key, None)
    salt = "c" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD.encode(), bytes.fromhex(salt), 1000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$1000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_tg_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def enable_telegram(fake: FakeTelegram):
    os.environ["EGE_TELEGRAM_BOT_TOKEN"] = BOT_TOKEN
    os.environ["EGE_TELEGRAM_ADMIN_CHAT_ID"] = ADMIN_CHAT
    os.environ["EGE_TELEGRAM_API_URL"] = fake.base


def disable_telegram():
    for key in ("EGE_TELEGRAM_BOT_TOKEN", "EGE_TELEGRAM_ADMIN_CHAT_ID",
                "EGE_TELEGRAM_API_URL"):
        os.environ.pop(key, None)


def db_rows(server, sql, args=()):
    conn = server.connect()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def db_scalar(server, sql, args=()):
    rows = db_rows(server, sql, args)
    return rows[0][0] if rows else None


def admin_login(opener, base, password=ADMIN_PASSWORD):
    return request(opener, base, "/api/admin/login", "POST", {"password": password})


def login_status(opener, base, pending):
    return request(opener, base, "/api/admin/login/status?pending=" + urllib.parse.quote(pending))


def short_of(server, pending_id: str) -> str | None:
    rows = db_rows(server, "SELECT short FROM admin_login_pending WHERE token=?",
                   (server.token_digest(pending_id),))
    return rows[0]["short"] if rows else None


def main():
    with tempfile.TemporaryDirectory(prefix="ege-admtg-") as tmp:
        fake = FakeTelegram()
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        try:
            # ---------------------------------------------------------------
            section("1. Без бота — старый парольный путь цел")
            opener, jar = make_device()
            status, _, body = admin_login(opener, base)
            check("вход без бота -> 200 ok", status == 200 and body.get("ok") is True
                  and not body.get("pending"), (status, body))
            check("кука ege_admin выдана", bool(cookie_value(jar, "ege_admin")))
            status, _, probe = request(opener, base, "/api/admin/session")
            check("сессия жива", status == 200 and probe.get("admin") is True, (status, probe))
            status, _, _ = request(opener, base, "/api/admin/logout", "POST", {})
            check("выход -> 200", status == 200, status)
            bad, _ = make_device()
            status, _, _ = admin_login(bad, base, "wrong-password")
            check("неверный пароль -> 401", status == 401, status)

            # ---------------------------------------------------------------
            section("2. При боте верный пароль — заявка, а не сессия")
            enable_telegram(fake)
            opener, jar = make_device()
            status, _, body = admin_login(opener, base)
            check("ответ 200 с pending", status == 200 and body.get("pending") is True
                  and bool(body.get("pendingId")) and bool(body.get("code")), (status, body))
            pending_id = body.get("pendingId") or ""
            check("куки ege_admin НЕТ", cookie_value(jar, "ege_admin") is None)
            check("кука сессии выдана (привязка опроса)", bool(cookie_value(jar, "ege_session")))
            check("одно сообщение владельцу", len(fake.sent) == 1, len(fake.sent))
            msg = fake.sent[-1] if fake.sent else {}
            check("сообщение в настроенный чат", str(msg.get("chat_id")) == ADMIN_CHAT,
                  msg.get("chat_id"))
            check("код из ответа совпадает с кодом в сообщении",
                  bool(body.get("code")) and body.get("code") in str(msg.get("text") or ""),
                  body.get("code"))
            check("в сообщении есть IP", "127.0.0.1" in str(msg.get("text") or ""))
            check("в сообщении кнопок две",
                  len((msg.get("reply_markup") or {}).get("inline_keyboard") or []) == 2)
            check("пароля в сообщении нет", ADMIN_PASSWORD not in str(msg.get("text") or ""))
            short = short_of(server, pending_id)
            check("заявка в базе", bool(short), short)
            status, _, probe = request(opener, base, "/api/admin/session")
            check("админ-сессии пока нет (401)", status == 401, status)
            status, _, _ = request(opener, base, "/api/admin/users")
            check("/api/admin/* закрыт до подтверждения (401)", status == 401, status)

            # ---------------------------------------------------------------
            section("3. Опрос: pending, чужой браузер и мусор — 404")
            status, _, st = login_status(opener, base, pending_id)
            check("свой опрос -> pending", status == 200 and st.get("pending") is True,
                  (status, st))
            stranger, _ = make_device()
            status, _, _ = login_status(stranger, base, pending_id)
            check("чужой браузер -> 404", status == 404, status)
            status, _, _ = login_status(opener, base, "bogus-token")
            check("битый токен -> 404", status == 404, status)
            status, _, _ = request(opener, base, "/api/admin/login/status")
            check("без параметра -> 400", status == 400, status)

            # ---------------------------------------------------------------
            section("4. Подтверждение из своего чата открывает сессию")
            fake.queue_decision(short, True)
            status, _, st = login_status(opener, base, pending_id)
            check("опрос после approve -> ok", status == 200 and st.get("ok") is True
                  and st.get("user"), (status, st))
            check("кука ege_admin поставлена опросом", bool(cookie_value(jar, "ege_admin")))
            status, _, probe = request(opener, base, "/api/admin/session")
            check("админка открылась", status == 200 and probe.get("admin") is True,
                  (status, probe))
            status, _, _ = login_status(opener, base, pending_id)
            check("заявка съедена (повтор -> 404)", status == 404, status)
            check("кнопка получила ответ", len(fake.callbacks_answered) >= 1)
            check("тост на кнопке — про подтверждение",
                  any("подтвержд" in str(c.get("text") or "") for c in fake.callbacks_answered),
                  [c.get("text") for c in fake.callbacks_answered])
            check("сообщение подписано итогом",
                  any("подтвержд" in str(e.get("text") or "") for e in fake.edits),
                  fake.edits)
            check("в подписи — открытая сессия",
                  any("Сессия открыта" in str(e.get("text") or "") for e in fake.edits))
            actions = [r["action"] for r in db_rows(
                server, "SELECT action FROM admin_audit WHERE action LIKE 'admin-login%'")]
            check("аудит: approve + login", "admin-login-approved" in actions
                  and "admin-login" in actions, actions)

            # ---------------------------------------------------------------
            section("5. Отклонение закрывает вход")
            opener2, jar2 = make_device()
            status, _, body2 = admin_login(opener2, base)
            pending2 = body2.get("pendingId") or ""
            short2 = short_of(server, pending2)
            fake.queue_decision(short2, False)
            status, _, st = login_status(opener2, base, pending2)
            check("опрос после deny -> 403 denied",
                  status == 403 and st.get("code") == "ADMIN_LOGIN_DENIED", (status, st))
            check("куки ege_admin нет", cookie_value(jar2, "ege_admin") is None)
            status, _, _ = request(opener2, base, "/api/admin/session")
            check("сессии нет", status == 401, status)
            check("тост на кнопке — про отклонение",
                  any("отклон" in str(c.get("text") or "") for c in fake.callbacks_answered))
            check("сообщение подписано отказом",
                  any("Сессия не открыта" in str(e.get("text") or "") for e in fake.edits))

            # ---------------------------------------------------------------
            section("6. Чужой чат игнорируется")
            opener3, jar3 = make_device()
            status, _, body3 = admin_login(opener3, base)
            pending3 = body3.get("pendingId") or ""
            short3 = short_of(server, pending3)
            fake.queue_decision(short3, True, chat=FOREIGN_CHAT)
            status, _, st = login_status(opener3, base, pending3)
            check("чужое нажатие не открывает (still pending)",
                  status == 200 and st.get("pending") is True, (status, st))
            check("куки нет", cookie_value(jar3, "ege_admin") is None)
            fake.queue_decision(short3, True)  # настоящее решение следом
            status, _, st = login_status(opener3, base, pending3)
            check("своё нажатие после чужого работает", status == 200 and st.get("ok") is True,
                  (status, st))

            # ---------------------------------------------------------------
            section("7. Просрочка — 410 без сессии")
            opener4, jar4 = make_device()
            status, _, body4 = admin_login(opener4, base)
            pending4 = body4.get("pendingId") or ""
            past = int(time.time() * 1000) - 1000
            conn = server.connect()
            try:
                conn.execute("UPDATE admin_login_pending SET expires_at=? WHERE token=?",
                             (past, server.token_digest(pending4)))
                conn.commit()
            finally:
                conn.close()
            status, _, st = login_status(opener4, base, pending4)
            check("просрочка -> 410 expired",
                  status == 410 and st.get("code") == "PENDING_EXPIRED", (status, st))
            check("куки нет", cookie_value(jar4, "ege_admin") is None)
            check("сообщение подписано просрочкой (мёртвых кнопок нет)",
                  any("Время вышло" in str(e.get("text") or "") for e in fake.edits))

            # ---------------------------------------------------------------
            section("8. Отмена")
            opener5, jar5 = make_device()
            status, _, body5 = admin_login(opener5, base)
            pending5 = body5.get("pendingId") or ""
            status, _, cancelled = request(opener5, base, "/api/admin/login/cancel",
                                           "POST", {"pending": pending5})
            check("cancel -> ok", status == 200 and cancelled.get("ok") is True,
                  (status, cancelled))
            status, _, _ = login_status(opener5, base, pending5)
            check("после отмены опрос -> 404", status == 404, status)
            check("сообщение подписано отзывом",
                  any("отозвана" in str(e.get("text") or "") for e in fake.edits))
            opener6, _ = make_device()
            status, _, body6 = admin_login(opener6, base)
            pending6 = body6.get("pendingId") or ""
            stranger, _ = make_device()
            status, _, cancelled = request(stranger, base, "/api/admin/login/cancel",
                                           "POST", {"pending": pending6})
            check("чужая отмена отвечает ok (без оракула)", status == 200, status)
            status, _, st = login_status(opener6, base, pending6)
            check("чужая отмена заявку НЕ снесла", status == 200 and st.get("pending") is True,
                  (status, st))
            status, _, _ = request(opener6, base, "/api/admin/login/cancel", "POST",
                                   {"pending": pending6})
            check("своя отмена подчищает", status == 200, status)

            # ---------------------------------------------------------------
            section("9. Капы живых заявок")
            cap_opener, _ = make_device()
            ids = []
            for _ in range(3):
                status, _, b = admin_login(cap_opener, base)
                ids.append(b.get("pendingId"))
            check("3 заявки одному браузеру — можно", all(ids) and len(fake.sent) >= 3,
                  (len(ids), len(fake.sent)))
            status, _, b = admin_login(cap_opener, base)
            check("4-я заявка тому же браузеру -> 429", status == 429, (status, b))
            for pid in ids:
                request(cap_opener, base, "/api/admin/login/cancel", "POST", {"pending": pid})
            fresh = []
            for _ in range(5):
                dev, _ = make_device()
                status, _, b = admin_login(dev, base)
                fresh.append((dev, b.get("pendingId"), status))
            check("5 заявок с адреса — можно", all(s == 200 for _, _, s in fresh),
                  [s for _, _, s in fresh])
            dev, _ = make_device()
            status, _, b = admin_login(dev, base)
            check("6-я заявка с адреса -> 429", status == 429, (status, b))
            for dev, pid, _ in fresh:
                request(dev, base, "/api/admin/login/cancel", "POST", {"pending": pid})

            # ---------------------------------------------------------------
            section("10. Неверный пароль и мёртвый бот")
            sent_before = len(fake.sent)
            bad2, _ = make_device()
            status, _, _ = admin_login(bad2, base, "wrong-password")
            check("неверный пароль -> 401", status == 401, status)
            check("сообщений не прибавилось", len(fake.sent) == sent_before, len(fake.sent))
            check("заявок не прибавилось",
                  db_scalar(server, "SELECT COUNT(*) FROM admin_login_pending") == 0)
            os.environ["EGE_TELEGRAM_API_URL"] = "http://127.0.0.1:1"
            dead, dead_jar = make_device()
            status, _, b = admin_login(dead, base)
            check("мёртвый бот -> 503 TELEGRAM_UNAVAILABLE",
                  status == 503 and b.get("code") == "TELEGRAM_UNAVAILABLE", (status, b))
            check("висящих заявок не осталось",
                  db_scalar(server, "SELECT COUNT(*) FROM admin_login_pending") == 0)
            check("куки админа нет", cookie_value(dead_jar, "ege_admin") is None)
            os.environ["EGE_TELEGRAM_API_URL"] = fake.base

            # ---------------------------------------------------------------
            section("11. Токены заявок — только хэши")
            opener7, _ = make_device()
            status, _, body7 = admin_login(opener7, base)
            pending7 = body7.get("pendingId") or ""
            tokens = [r[0] for r in db_rows(server, "SELECT token FROM admin_login_pending")]
            check("в базе есть строка заявки", len(tokens) >= 1, len(tokens))
            check("сырого токена в базе нет", pending7 not in tokens)
            check("всё хранимое — 64 hex",
                  all(len(t) == 64 and all(c in "0123456789abcdef" for c in t.lower())
                      for t in tokens), tokens)
            request(opener7, base, "/api/admin/login/cancel", "POST", {"pending": pending7})

            # ---------------------------------------------------------------
            section("12. Команда /start")
            opener8, _ = make_device()
            status, _, body8 = admin_login(opener8, base)
            pending8 = body8.get("pendingId") or ""
            sent_before = len(fake.sent)
            fake.queue_message(ADMIN_CHAT, "/start")
            status, _, st = login_status(opener8, base, pending8)
            check("опрос после /start всё ещё pending", status == 200 and st.get("pending") is True,
                  (status, st))
            check("владельцу пришёл ответ о привязке", len(fake.sent) == sent_before + 1,
                  len(fake.sent))
            owner_reply = str((fake.sent[-1] or {}).get("text") or "")
            check("ответ подтверждает привязку чата", "привязан как владелец" in owner_reply,
                  owner_reply[:80])
            fake.queue_message(FOREIGN_CHAT, "/start@ege_easy_ru_bot")
            status, _, _ = login_status(opener8, base, pending8)
            stranger_reply = str((fake.sent[-1] or {}).get("text") or "")
            check("чужому отвечает про непривязанный чат",
                  FOREIGN_CHAT in stranger_reply and "не привязан" in stranger_reply,
                  stranger_reply[:80])
            sent_before = len(fake.sent)
            fake.queue_message(ADMIN_CHAT, "привет, это просто текст")
            status, _, _ = login_status(opener8, base, pending8)
            check("обычный текст игнорируется молча", len(fake.sent) == sent_before,
                  len(fake.sent))
            request(opener8, base, "/api/admin/login/cancel", "POST", {"pending": pending8})

            # ---------------------------------------------------------------
            section("13. Фоновый цикл: бот жив без входов")
            stop_bg = threading.Event()
            bg_thread = server.start_admin_telegram_loop(stop_bg)
            try:
                sent_before = len(fake.sent)
                fake.queue_message(ADMIN_CHAT, "/start")
                deadline = time.time() + 30
                while len(fake.sent) == sent_before and time.time() < deadline:
                    time.sleep(0.5)
                check("/start отвечен фоном, без единого входа",
                      len(fake.sent) == sent_before + 1, len(fake.sent))
                check("ответ — про привязку",
                      "привязан как владелец" in str((fake.sent[-1] or {}).get("text") or ""))
            finally:
                stop_bg.set()
                bg_thread.join(timeout=15)
            check("поток останавливается по событию", not bg_thread.is_alive())
        finally:
            httpd.shutdown()
            httpd.server_close()
            fake.stop()

    print(f"\n{'ALL OK' if failures == 0 else 'FAILURES: ' + str(failures)}: {checks} проверок")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
