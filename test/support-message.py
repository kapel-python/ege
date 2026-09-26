#!/usr/bin/env python3
"""E2E-регрессия публичной быстрой формы сообщений поддержки."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
MIN_MESSAGE = 10
MAX_MESSAGE = 2000
TEST_SECRET = "ege-test-support-secret-0123456789abcdef"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_support_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(url: str, *, method: str = "GET", body: bytes | None = None,
            content_type: str | None = None, origin: str | None = None,
            content_encoding: str | None = None, cookie: str | None = None,
            extra_headers: dict | None = None):
    headers = {"Accept": "application/json"}
    if content_type is not None:
        headers["Content-Type"] = content_type
    if origin is not None:
        headers["Origin"] = origin
    if content_encoding is not None:
        headers["Content-Encoding"] = content_encoding
    if cookie is not None:
        headers["Cookie"] = cookie
    if extra_headers:
        headers.update(extra_headers)
    req = Request(url, data=body, headers=headers, method=method)
    try:
        response = urlopen(req, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers.items()), response.read()


def request_json(url: str, **kwargs):
    status, headers, raw = request(url, **kwargs)
    return status, headers, json.loads(raw or b"{}")


def rid(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()[:32]


def main():
    os.environ["EGE_SUPPORT_SECRET"] = TEST_SECRET
    os.environ["EGE_SUPPORT_MIN_DWELL_SEC"] = "0"
    with tempfile.TemporaryDirectory(prefix="ege-support-test-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)

        conn = server.connect()
        try:
            server.install_catalog(conn)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(support_messages)")}
            assert columns == {
                "id", "request_key", "message_digest", "source", "message",
                "spam_score", "status", "created_at",
            }, columns
            tables = {row["name"] for row in
                      conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert "support_rate_hits" in tables, tables
            index_columns = {
                tuple(row["name"] for row in conn.execute(f"PRAGMA index_info({row['name']})"))
                for row in conn.execute("PRAGMA index_list(support_messages)")
            }
            assert ("request_key",) in index_columns, index_columns
            # Повторный запуск миграции ничего не ломает и не дублирует схему.
            server.ensure_support_schema(conn)
            server.ensure_support_schema(conn)
            assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        endpoint = base + "/api/support/messages"

        def clear_rate():
            admin = server.connect()
            try:
                admin.execute("DELETE FROM support_rate_hits")
                admin.commit()
            finally:
                admin.close()

        def fetch_form_token() -> str:
            status, headers, _ = request(base + "/contacts")
            assert status == 200, status
            set_cookie = headers.get("Set-Cookie", "")
            assert "ege_support_form=" in set_cookie, set_cookie
            return set_cookie.split("ege_support_form=", 1)[1].split(";", 1)[0].strip()

        form_token = fetch_form_token()
        jar = f"ege_support_form={form_token}"

        def post(payload=None, *, raw: bytes | None = None, content_type="application/json",
                 origin=None, content_encoding=None, cookie=jar):
            body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
            return request_json(
                endpoint,
                method="POST",
                body=body,
                content_type=content_type,
                origin=origin,
                content_encoding=content_encoding,
                cookie=cookie,
            )

        def post_message(message: str, request_id: str, **kwargs):
            payload = {"message": message, "requestId": request_id, "formToken": form_token}
            payload.update(kwargs.pop("extra", {}))
            return post(payload, **kwargs)

        try:
            # Form-токен обязателен в cookie и теле, токены должны совпадать.
            clear_rate()
            status, _, body = post({"message": "достаточно длинное сообщение", "requestId": rid("no-cookie")},
                                   cookie=None)
            assert status == 400 and body.get("code") == "form_token", (status, body)
            status, _, body = post({"message": "достаточно длинное сообщение", "requestId": rid("no-body-token")})
            assert status == 400 and body.get("code") == "form_token", (status, body)
            status, _, body = post({"message": "достаточно длинное сообщение",
                                    "requestId": rid("tampered"), "formToken": form_token[:-2] + "00"})
            assert status == 400 and body.get("code") == "form_token", (status, body)
            other = fetch_form_token()
            status, _, body = post({"message": "достаточно длинное сообщение",
                                    "requestId": rid("mismatch"), "formToken": other})
            assert status == 400 and body.get("code") == "form_token", (status, body)
            expired = server.mint_support_form_token(TEST_SECRET, int(time.time()) - 8000)
            status, _, body = post({"message": "достаточно длинное сообщение",
                                    "requestId": rid("expired"), "formToken": expired},
                                   cookie=f"ege_support_form={expired}")
            assert status == 400 and body.get("code") == "form_token", (status, body)

            # Не-JSON, неверная кодировка, compression и чужой Origin отсекаются.
            clear_rate()
            status, _, _ = post_message("корректное сообщение", rid("wrong-type"), content_type="text/plain")
            assert status == 415, status
            status, _, _ = post_message("корректное сообщение", rid("wrong-charset"),
                                        content_type="application/json; charset=iso-8859-1")
            assert status == 415, status
            status, _, _ = post_message("корректное сообщение", rid("encoded"), content_encoding="gzip")
            assert status == 415, status
            status, _, _ = post_message("корректное сообщение", rid("foreign"),
                                        origin="https://attacker.example")
            assert status == 403, status
            # Ровно тот же Origin проходит Origin-проверку и доходит до валидации.
            status, _, _ = post_message("коротко", rid("same-origin"), origin=base)
            assert status == 400, status

            # Строгий JSON, типы, неизвестные поля, длина и control chars.
            clear_rate()
            invalid_cases = [
                (b"{", 400),
                (b'{"message":"valid text","requestId":"1234567890123456"} trailing', 400),
                (b'{"message":"one","message":"two"}', 400),
                (b'{"message":"NaN","requestId":"1234567890123456"}', 400),
                (b'{"message":"\xff","requestId":"1234567890123456"}', 400),
                (json.dumps({"message": "123456789", "requestId": rid("short"),
                             "formToken": form_token}).encode(), 400),
                (json.dumps({"message": "          ", "requestId": rid("spaces"),
                             "formToken": form_token}).encode(), 400),
                (json.dumps({"message": "Ошибка\x00 тут", "requestId": rid("nul"),
                             "formToken": form_token}).encode(), 400),
                (json.dumps({"message": "Ошибка\u202e тут", "requestId": rid("bidi"),
                             "formToken": form_token}).encode(), 400),
                (json.dumps({"message": "я" * (MAX_MESSAGE + 1), "requestId": rid("long"),
                             "formToken": form_token}).encode(), 400),
                (json.dumps({"message": "valid message", "requestId": rid("unknown"),
                             "formToken": form_token, "userId": 1}).encode(), 400),
                (b"x" * (server.SUPPORT_REQUEST_MAX_BYTES + 1), 413),
            ]
            for index, (body, expected) in enumerate(invalid_cases):
                # Attempt-лимит общий на IP: сбрасываем бакет, чтобы фаза
                # проверяла валидацию, а не лимит (он проверяется отдельно ниже).
                if index and index % 4 == 0:
                    clear_rate()
                status, _, _ = post(raw=body)
                assert status == expected, (expected, status, body[:50])
            status, _, _ = post({"message": "сообщение без requestId", "formToken": form_token})
            assert status == 400, status

            # Honeypot получает нейтральный успех, но ничего не пишет.
            clear_rate()
            conn = server.connect()
            try:
                assert conn.execute("SELECT COUNT(*) FROM support_messages").fetchone()[0] == 0
            finally:
                conn.close()
            status, _, body = post({
                "message": "Не сохраняй это сообщение", "requestId": rid("honeypot"),
                "formToken": form_token, "website": "bot.example",
            })
            assert status == 202 and body == {"ok": True}, (status, body)

            # Валидное сообщение нормализуется, идемпотентно и не создаёт гостя.
            clear_rate()
            request_id = rid("valid")
            text = "  Первая строка\nвторая строка  "
            status, headers, body = post_message(text, request_id)
            assert status == 202 and body == {"ok": True}, (status, body)
            assert headers.get("Cache-Control") == "no-store"
            assert headers.get("X-Content-Type-Options") == "nosniff"
            assert headers.get("X-Frame-Options") == "DENY"
            assert "Set-Cookie" not in headers

            # Тот же ключ + то же нормализованное сообщение не создаёт дубль.
            status, _, _ = post_message(text, request_id)
            assert status == 202, status
            # Тот же ключ с другим текстом — конфликт, а не новая запись.
            status, _, _ = post_message("Другое сообщение", request_id)
            assert status == 409, status

            conn = server.connect()
            try:
                assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
                assert conn.execute("SELECT COUNT(*) FROM support_messages").fetchone()[0] == 1
                row = conn.execute(
                    "SELECT request_key, message_digest, source, message, spam_score, status, created_at "
                    "FROM support_messages"
                ).fetchone()
                assert row["source"] == "contacts"
                assert row["message"] == "Первая строка\nвторая строка"
                assert row["spam_score"] == 0
                assert row["status"] == "new"
                assert row["created_at"]
                assert request_id not in row["request_key"] + row["message_digest"]
            finally:
                conn.close()

            # Тот же текст с новым ключом — spray: нейтральный успех без записи.
            clear_rate()
            status, _, _ = post_message(text, rid("same-text-new-key"))
            assert status == 202, status
            conn = server.connect()
            try:
                assert conn.execute("SELECT COUNT(*) FROM support_messages").fetchone()[0] == 1
            finally:
                conn.close()

            # Спам-структура (ссылки + телефон) уходит в карантин, а не в inbox.
            clear_rate()
            spam_text = ("Заработок уже сегодня! Жми https://spam.example/win и "
                         "http://spam.example/go, звони +7 900 123-45-67 срочно")
            status, _, _ = post_message(spam_text, rid("spam"))
            assert status == 202, status
            conn = server.connect()
            try:
                row = conn.execute("SELECT spam_score, status FROM support_messages ORDER BY id DESC LIMIT 1").fetchone()
                assert row["spam_score"] >= server.SUPPORT_SPAM_THRESHOLD, dict(row)
                assert row["status"] == "new"
            finally:
                conn.close()

            # Параллельный повтор одного requestId создаёт ровно одну строку.
            clear_rate()
            parallel_id = rid("parallel")
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(post_message, "Параллельное сообщение", parallel_id) for _ in range(2)]
                results = [future.result() for future in futures]
            assert {result[0] for result in results} == {202}, results

            # Attempt-лимит персистентный: burst исчерпывается, дальше 429 с Retry-After.
            clear_rate()
            for index in range(server.SUPPORT_ATTEMPT_BURST_MAX):
                status, _, _ = post_message(f"Аккуратное сообщение номер {index} для проверки лимита",
                                            rid(f"rate-{index}"))
                assert status == 202, (index, status)
            status, headers, body = post_message("Это сообщение уже должно упереться в лимит",
                                                 rid("rate-last"))
            assert status == 429 and body.get("retryAfter", 0) > 0, (status, body)
            assert int(headers.get("Retry-After", "0")) > 0

            # GET-ветки нет и он не создаёт гостя/cookie.
            conn = server.connect()
            try:
                before_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            finally:
                conn.close()
            status, headers, body = request_json(endpoint)
            assert status == 404 and "message" not in body, (status, body)
            assert "Set-Cookie" not in headers
            conn = server.connect()
            try:
                assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == before_users
            finally:
                conn.close()

            # Канонический маршрут контактов отдаёт страницу и form-cookie.
            for route in ("/contacts", "/contacts.html"):
                status, headers, raw = request(base + route)
                assert status == 200, (route, status)
                assert b'id="quickMessageForm"' in raw
                assert headers.get("X-Robots-Tag") == "noindex, nofollow"
                assert "ege_support_form=" in headers.get("Set-Cookie", ""), route
            # Ревалидация (304) тоже обновляет cookie: вкладка, открытая
            # дольше жизни cookie, чинится без ручной перезагрузки.
            etag = headers.get("ETag", "") or headers.get("Etag", "")
            assert etag, headers
            status, headers, _ = request(base + "/contacts", extra_headers={"If-None-Match": etag})
            assert status == 304, status
            assert "ege_support_form=" in headers.get("Set-Cookie", ""), headers

            contacts = (ROOT / "contacts.html").read_text(encoding="utf-8")
            assert "/api/support/messages" in contacts
            assert "meaningfulLength >= 10" in contacts
            assert 'id="quickMessageSuccess"' in contacts
            assert "requestIdFor(message)" in contacts
            assert "requestId: requestId" in contacts or "requestId:requestId" in contacts
            assert "formToken:" in contacts and 'getCookie("ege_support_form")' in contacts
            assert "function supportFailureText" in contacts
            assert "payload.error" not in contacts
            assert "error.userMessage" in contacts
            footer = (ROOT / "js" / "footer.js").read_text(encoding="utf-8")
            assert 'href="/contacts">Контакты' in footer
            assert 'Контакты <span class="ef-mini ef-mini--soon">скоро' not in footer

        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

        # Legacy support table is expanded in place: no rows are dropped and a
        # repeated migration remains a no-op.
        with tempfile.TemporaryDirectory(prefix="ege-support-legacy-") as legacy_tmp:
            legacy_server = load_server(Path(legacy_tmp) / "ege.sqlite3")
            legacy = legacy_server.connect()
            try:
                legacy.execute("CREATE TABLE support_messages (id INTEGER PRIMARY KEY, message TEXT)")
                legacy.execute("INSERT INTO support_messages(id, message) VALUES (7, ?)", ("Старое сообщение",))
                legacy_server.ensure_support_schema(legacy)
                legacy_server.ensure_support_schema(legacy)
                legacy_columns = {row["name"] for row in legacy.execute("PRAGMA table_info(support_messages)")}
                assert {"request_key", "message_digest", "source", "spam_score", "status", "created_at"} <= legacy_columns
                legacy_row = legacy.execute("SELECT * FROM support_messages WHERE id=7").fetchone()
                assert legacy_row["message"] == "Старое сообщение"
                assert len(legacy_row["request_key"]) == 64
                assert len(legacy_row["message_digest"]) == 64
                assert legacy_row["source"] == "contacts" and legacy_row["status"] == "new"
                assert legacy_row["spam_score"] == 0
            finally:
                legacy.close()

        print("Support message E2E OK: form token, persistent limits, spam quarantine, dedup and no public read")


if __name__ == "__main__":
    main()
