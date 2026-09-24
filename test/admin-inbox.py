#!/usr/bin/env python3
"""Регрессия: скрытый Admin Inbox в дашборде («Обращения»).

Контракт:
1. guest: GET /api/admin/support-messages -> 401; bootstrap(-lite) содержит
   isAdmin=false и НЕ содержит данных обращений;
2. обычный пользователь: то же самое, включая пагинацию и мусорные limit/offset
   (пагинация не обходит авторизацию);
3. admin (POST /api/admin/login): bootstrap/bootstrap-lite/POST /api/subject и
   GET /api/auth/session содержат isAdmin=true; inbox -> 200, новые сверху,
   точные поля {id,message,status,createdAt}, total/newCount корректны;
4. пагинация: limit/offset режут выдачу; limit=0/-1/abc/101, offset=-1/abc -> 400;
5. утечек нет: request_key/message_digest нигде не отдаются;
6. привязка куки: ege_admin, скопированная на другой аккаунт, -> 401;
7. мусорный ege_session + валидный ege_admin -> 401;
8. протухшая admin-сессия -> 401 на inbox и isAdmin=false в bootstrap;
9. logout (/api/auth/logout) -> isAdmin=false, inbox -> 401;
10. существующая /admin не сломана: overview продолжает отвечать 200 админу
    и 401 остальным.

Живой сервер на temp-БД, прод не трогается.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ADMIN_PASSWORD = b"test-admin-password"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "b" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_admin_inbox_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None, raw_cookie: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if raw_cookie:
        req.add_header("Cookie", raw_cookie)
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def cookie_value(jar: http.cookiejar.CookieJar, name: str) -> str | None:
    for cookie in jar:
        if cookie.name == name:
            return cookie.value
    return None


def make_device():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def seed_messages(server, db_path: Path):
    conn = server.connect()
    try:
        server.ensure_support_schema(conn)
        rows = [
            ("старое сообщение номер один, статус new", "new", "1700000001000"),
            ("второе сообщение, уже просмотрено", "reviewed", "1700000002000"),
            ("самое свежее обращение с длинным текстом " + "я" * 300, "new", "1700000003000"),
        ]
        for i, (message, status, created_at) in enumerate(rows):
            request_key = hashlib.sha256(f"inbox-seed-{i}".encode()).hexdigest()
            digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
            conn.execute(
                "INSERT INTO support_messages(request_key, message_digest, source, message, spam_score, status, created_at)"
                " VALUES (?, ?, 'contacts', ?, 0, ?, ?)",
                (request_key, digest, message, status, created_at),
            )
        conn.commit()
    finally:
        conn.close()


def assert_no_leak(payload: dict, where: str):
    raw = json.dumps(payload, ensure_ascii=False)
    assert "request_key" not in payload, where
    assert "message_digest" not in payload, where
    assert "requestKey" not in raw and "messageDigest" not in raw, where


def main():
    with tempfile.TemporaryDirectory(prefix="ege-admin-inbox-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        seed_messages(server, db_path)

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            guest, guest_jar = make_device()
            user, user_jar = make_device()
            admin, admin_jar = make_device()

            # 1. Guest: inbox закрыт, bootstrap честный и без данных.
            status, body = request(guest, base, "/api/admin/support-messages")
            assert status == 401, (status, body)
            for path in ("/api/bootstrap-lite", "/api/bootstrap"):
                status, boot = request(guest, base, path)
                assert status == 200, (status, boot, path)
                assert boot.get("isAdmin") is False, (path, boot.get("isAdmin"))
                assert "messages" not in boot and "supportMessages" not in boot, path
                assert_no_leak(boot, f"guest {path}")
            status, probe = request(guest, base, "/api/auth/session")
            assert status == 200 and probe.get("isAdmin") is False, (status, probe)

            # 2. Обычный пользователь: тот же отказ, пагинация не помогает.
            status, boot = request(user, base, "/api/bootstrap-lite")
            assert status == 200 and boot.get("isAdmin") is False, (status, boot)
            for inbox_path in (
                "/api/admin/support-messages",
                "/api/admin/support-messages?limit=1&offset=0",
                "/api/admin/support-messages?limit=100&offset=0",
                "/api/admin/support-messages?limit=abc",
            ):
                status, body = request(user, base, inbox_path)
                assert status == 401, (inbox_path, status, body)
            # Существующая админка тоже закрыта для него.
            status, _ = request(user, base, "/api/admin/overview")
            assert status == 401, status

            # 3. Admin login на третьем устройстве.
            status, boot = request(admin, base, "/api/bootstrap-lite")
            assert status == 200, (status, boot)
            status, login = request(admin, base, "/api/admin/login", "POST",
                                   {"password": ADMIN_PASSWORD.decode()})
            assert status == 200, (status, login)
            assert cookie_value(admin_jar, "ege_admin"), "admin cookie not set"

            for path in ("/api/bootstrap-lite", "/api/bootstrap"):
                status, boot = request(admin, base, path)
                assert status == 200, (status, boot, path)
                assert boot.get("isAdmin") is True, (path, boot)
                assert "messages" not in boot, path
                assert_no_leak(boot, f"admin {path}")
            status, probe = request(admin, base, "/api/auth/session")
            assert status == 200 and probe.get("isAdmin") is True, (status, probe)
            status, subj = request(admin, base, "/api/subject", "POST", {"subject": "profile_math"})
            assert status == 200 and subj.get("isAdmin") is True, (status, subj)

            status, inbox = request(admin, base, "/api/admin/support-messages")
            assert status == 200, (status, inbox)
            assert inbox["total"] == 3 and inbox["newCount"] == 2, inbox
            assert inbox["limit"] == 20 and inbox["offset"] == 0, inbox
            messages = inbox["messages"]
            assert len(messages) == 3, inbox
            # По умолчанию status=all: сгруппировано по статусу, внутри
            # группы новые сверху. Сиды: id3=new, id2=reviewed, id1=new.
            assert messages[0]["message"].startswith("самое свежее"), messages[0]
            assert messages[1]["message"].startswith("старое сообщение"), messages[1]
            assert messages[2]["status"] == "reviewed", messages[2]
            assert [m["status"] for m in messages] == ["new", "new", "reviewed"], messages
            for m in messages:
                assert set(m.keys()) == {"id", "message", "status", "createdAt"}, m.keys()
                assert isinstance(m["id"], int) and isinstance(m["message"], str), m
            assert_no_leak(inbox, "admin inbox")

            # 4. Пагинация.
            status, page = request(admin, base, "/api/admin/support-messages?limit=1&offset=0")
            assert status == 200 and len(page["messages"]) == 1, (status, page)
            assert page["messages"][0]["id"] == messages[0]["id"], page
            assert page["total"] == 3 and page["newCount"] == 2, page
            status, page2 = request(admin, base, "/api/admin/support-messages?limit=1&offset=1")
            assert status == 200 and len(page2["messages"]) == 1, (status, page2)
            assert page2["messages"][0]["id"] == messages[1]["id"], page2
            status, page3 = request(admin, base, "/api/admin/support-messages?limit=2&offset=2")
            assert status == 200 and len(page3["messages"]) == 1, (status, page3)
            status, empty = request(admin, base, "/api/admin/support-messages?limit=20&offset=99")
            assert status == 200 and empty["messages"] == [] and empty["total"] == 3, (status, empty)
            for bad in ("?limit=0", "?limit=-1", "?limit=abc", "?limit=101",
                        "?offset=-1", "?offset=abc", "?limit=2&offset=1.5"):
                status, body = request(admin, base, "/api/admin/support-messages" + bad)
                assert status == 400, (bad, status, body)
                assert "request_key" not in json.dumps(body), bad

            # 6. Чужая кука: ege_admin админа на устройстве обычного юзера.
            admin_cookie = cookie_value(admin_jar, "ege_admin")
            user_session = cookie_value(user_jar, "ege_session")
            assert admin_cookie and user_session
            forged = f"ege_session={user_session}; ege_admin={admin_cookie}"
            status, body = request(user, base, "/api/admin/support-messages", raw_cookie=forged)
            assert status == 401, (status, body)

            # 7. Мусорная user-сессия + валидный admin-токен.
            forged2 = f"ege_session={'z' * 43}; ege_admin={admin_cookie}"
            status, body = request(user, base, "/api/admin/support-messages", raw_cookie=forged2)
            assert status == 401, (status, body)

            # 10. /admin жива: overview 200 у админа.
            status, overview = request(admin, base, "/api/admin/overview")
            assert status == 200 and "users" in overview, (status, overview)

            # 8. Протухание admin-сессии: правим expires_at напрямую в БД.
            conn2 = server.connect()
            try:
                row = conn2.execute("SELECT id FROM admin_sessions").fetchone()
                assert row, "no admin session row"
                conn2.execute("UPDATE admin_sessions SET expires_at=? WHERE id=?", (1, row["id"]))
                conn2.commit()
            finally:
                conn2.close()
            status, body = request(admin, base, "/api/admin/support-messages")
            assert status == 401, (status, body)
            status, boot = request(admin, base, "/api/bootstrap-lite")
            assert status == 200 and boot.get("isAdmin") is False, (status, boot)

            # 9. Повторный admin-login, затем logout аккаунта.
            status, login = request(admin, base, "/api/admin/login", "POST",
                                   {"password": ADMIN_PASSWORD.decode()})
            assert status == 200, (status, login)
            status, inbox = request(admin, base, "/api/admin/support-messages")
            assert status == 200, (status, inbox)
            status, bye = request(admin, base, "/api/auth/logout", "POST", {})
            assert status == 200, (status, bye)
            status, body = request(admin, base, "/api/admin/support-messages")
            assert status == 401, (status, body)
            status, boot = request(admin, base, "/api/bootstrap-lite")
            assert status == 200 and boot.get("isAdmin") is False, (status, boot)

            # 11. «Прочитано»: guest/user -> 401; admin отмечает -> исчезает
            # из ленты новых, но остаётся в БД со статусом reviewed + аудит.
            status, login = request(admin, base, "/api/admin/login", "POST",
                                   {"password": ADMIN_PASSWORD.decode()})
            assert status == 200, (status, login)
            status, inbox = request(admin, base, "/api/admin/support-messages?status=new")
            assert status == 200, (status, inbox)
            fresh = [m for m in inbox["messages"] if m["status"] == "new"]
            assert len(fresh) == 2, inbox
            target = fresh[0]["id"]
            for device, jar_name in ((guest, "guest"), (user, "user")):
                status, body = request(device, base, f"/api/admin/support-messages/{target}/read", "POST", {})
                assert status == 401, (jar_name, status, body)
            status, done = request(admin, base, f"/api/admin/support-messages/{target}/read", "POST", {})
            assert status == 200, (status, done)
            assert done == {"ok": True, "id": target, "status": "reviewed"}, done
            # Идемпотентный повтор и чтение уже просмотренного.
            status, done2 = request(admin, base, f"/api/admin/support-messages/{target}/read", "POST", {})
            assert status == 200 and done2["status"] == "reviewed", (status, done2)
            other = [m for m in fresh if m["id"] != target][0]["id"]
            status, done3 = request(admin, base, f"/api/admin/support-messages/{other}/read", "POST", {})
            assert status == 200 and done3["status"] == "reviewed", (status, done3)
            # Несуществующий и мусорный id.
            status, body = request(admin, base, "/api/admin/support-messages/999999/read", "POST", {})
            assert status == 404, (status, body)
            for bad_id in ("abc", "0", "-1", "1.5"):
                status, body = request(admin, base, f"/api/admin/support-messages/{bad_id}/read", "POST", {})
                assert status == 400, (bad_id, status, body)
            # Лента новых больше не содержит отмеченные; фильтр и аудит — да.
            status, news = request(admin, base, "/api/admin/support-messages?status=new")
            assert status == 200 and news["messages"] == [] and news["total"] == 0, (status, news)
            assert news["newCount"] == 0, news
            status, read = request(admin, base, "/api/admin/support-messages?status=reviewed&limit=100")
            assert status == 200 and {m["id"] for m in read["messages"]} >= {target, other}, (status, read)
            assert read["newCount"] == 0, read
            status, everything = request(admin, base, "/api/admin/support-messages?limit=100")
            assert status == 200 and everything["total"] == 3, (status, everything)
            by_id = {m["id"]: m["status"] for m in everything["messages"]}
            assert by_id[target] == "reviewed" and by_id[other] == "reviewed", by_id
            for bad_status in ("?status=bogus", "?status=NEW"):
                status, body = request(admin, base, "/api/admin/support-messages" + bad_status)
                assert status == 400, (bad_status, status, body)
            # Пустое значение = параметр не задан: parse_qs его отбрасывает,
            # работает дефолт all.
            status, body = request(admin, base, "/api/admin/support-messages?status=")
            assert status == 200 and body["total"] == 3, (status, body)
            # Чужие методы: GET ленты по адресу чтения -> 404 у админа;
            # PUT -> 405 у админа; гостю везде 401.
            status, body = request(admin, base, f"/api/admin/support-messages/{target}/read")
            assert status == 404, (status, body)
            status, body = request(admin, base, f"/api/admin/support-messages/{target}/read", "PUT", {})
            assert status == 405, (status, body)
            status, body = request(guest, base, f"/api/admin/support-messages/{target}/read", "PUT", {})
            assert status == 401, (status, body)
            # Аудит записан без привязки к пользователю (обращения анонимны).
            conn3 = server.connect()
            try:
                audit = conn3.execute(
                    "SELECT action, target_user_id, detail FROM admin_audit WHERE action='support-read'"
                    " ORDER BY id DESC LIMIT 2").fetchall()
                assert len(audit) == 2, [dict(r) for r in audit]
                assert all(r["target_user_id"] is None for r in audit), [dict(r) for r in audit]
                assert {r["detail"] for r in audit} == {f"message {target}", f"message {other}"}, \
                    [dict(r) for r in audit]
            finally:
                conn3.close()

            # 12. Контракт панели раздела «Обращения»: он переиспользует те же
            # GET (status/limit/offset) и POST .../read — трех счетчиков
            # (new/reviewed/all) в UI достаточно, новые строго сверху.
            status, n_page = request(admin, base, "/api/admin/support-messages?status=new&limit=2&offset=0")
            assert status == 200 and n_page["limit"] == 2 and n_page["offset"] == 0, (status, n_page)
            assert all(m["status"] == "new" for m in n_page["messages"]), n_page
            status, r_page = request(admin, base, "/api/admin/support-messages?status=reviewed&limit=100&offset=0")
            assert status == 200 and all(m["status"] == "reviewed" for m in r_page["messages"]), (status, r_page)
            status, a_page = request(admin, base, "/api/admin/support-messages?status=all&limit=100&offset=0")
            assert status == 200, (status, a_page)
            # «Все» сгруппирована по статусу: new -> reviewed -> resolved ->
            # archived, внутри каждой группы id DESC. Все три сейчас reviewed,
            # поэтому порядок остаётся id DESC и проверка на «сверху новые»
            # делается на смеси ниже.
            order = {"new": 0, "reviewed": 1, "resolved": 2, "archived": 3}
            keys = [(order[m["status"]], -m["id"]) for m in a_page["messages"]]
            assert keys == sorted(keys), keys
            # newCount всегда глобальный (для бейджа), а total — по фильтру.
            assert a_page["newCount"] == 0 and a_page["total"] == 3, a_page

            # Смешанная сцена: возвращаем одно «new» и одно «resolved» и
            # проверяем, что «Все» кладёт их в правильные группы/порядок.
            conn4 = server.connect()
            try:
                conn4.execute("UPDATE support_messages SET status='new' WHERE id=?", (target,))
                conn4.execute("UPDATE support_messages SET status='resolved' WHERE id=?", (1,))
                conn4.commit()
            finally:
                conn4.close()
            status, mixed = request(admin, base, "/api/admin/support-messages?status=all&limit=100&offset=0")
            assert status == 200, (status, mixed)
            got = [(m["id"], m["status"]) for m in mixed["messages"]]
            assert got[0][1] == "new", got  # непрочитанные строго сверху
            assert got[1][1] == "reviewed", got
            assert got[-1][1] == "resolved", got
            assert got[-1][0] == 1, got
            assert mixed["newCount"] == 1 and mixed["total"] == 3, mixed
            # Фильтрованные вкладки не смешивают статусы.
            status, only_new = request(admin, base, "/api/admin/support-messages?status=new&limit=100&offset=0")
            assert [m["id"] for m in only_new["messages"]] == [target], only_new
            status, only_rev = request(admin, base, "/api/admin/support-messages?status=reviewed&limit=100&offset=0")
            assert [m["id"] for m in only_rev["messages"]] == [2], only_rev

            print("admin-inbox: OK (guest/user/admin/spoof/expiry/logout/pagination/read)")
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    main()
