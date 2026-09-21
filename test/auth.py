#!/usr/bin/env python3
"""Регрессия: аккаунты (guest -> register -> login -> logout).

Покрывает контракт auth целиком на живом сервере с temp-БД:
1. новый посетитель получает гостевой профиль без регистрации;
2. регистрация привязывает ТЕКУЩЕГО гостя: accountId, прогресс, имя сохраняются;
3. повторное открытие сайта с той же сессией = auto-login (тот же аккаунт);
4. logout инвалидирует сессию серверно: старая кука не восстанавливает аккаунт;
5. login переводит сессию на существующий аккаунт (второй аккаунт виден);
6. login обратно возвращает первый аккаунт со всеми данными;
7. дубликат email -> 409; повторная регистрация залогиненного -> 409;
8. неверный пароль и несуществующий email -> одинаковый 401;
9. подмена user id в теле/заголовках не меняет идентичность;
10. чужие данные недоступны: чужая кука не видит историю, admin API -> 401;
14. истёкшая сессия -> новый гость + новая кука;
16. legacy-миграция: старый users.session_token продолжает работать;
17. повторный bootstrap не плодит дубликаты пользователей;
18. admin-auth живёт отдельно и продолжает работать.
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
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    # Свой хеш админ-пароля, чтобы проверить admin-контракт без внешних секретов.
    salt = "a" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_auth_test", SERVER_PATH)
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


def cookie_token(jar: http.cookiejar.CookieJar, name: str = "ege_session") -> str | None:
    for cookie in jar:
        if cookie.name == name:
            return cookie.value
    return None


def make_device():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def main():
    with tempfile.TemporaryDirectory(prefix="ege-auth-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
            # 16. Legacy-строка ДО старта сервера: миграция подхватит её при
            # первом же запросе (ensure_auth_schema), как на реальном апгрейде.
            cur = conn.execute(
                "INSERT INTO users(session_token, account_id, created_at, name) VALUES (?,?,?,?)",
                ("legacy-token-0123456789abcdef", "zzleg1", "1700000000000", "Старый гость"))
            legacy_id = cur.lastrowid
            conn.execute(
                "INSERT INTO user_stats(user_id, subject) VALUES (?, 'profile_math')", (legacy_id,))
            conn.execute(
                "INSERT INTO timeline(user_id, subject, created_at, text, client_id) VALUES (?,?,?,?,?)",
                (legacy_id, "profile_math", "1700000000000", "Наследие старой схемы", "legacy-1"))
            conn.commit()
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            opener_a, jar_a = make_device()

            # 1. Гость заходит без регистрации и сразу получает профиль.
            status, boot = request(opener_a, base, "/api/bootstrap-lite")
            assert status == 200, (status, boot)
            account_a = boot["accountId"]
            assert boot["auth"]["registered"] is False, boot["auth"]
            assert boot["auth"]["email"] is None, boot["auth"]

            # Гостевой прогресс: настройки + запись в истории.
            version = boot["state"]["stateVersion"]
            status, saved = request(opener_a, base, "/api/settings", "PATCH", {
                "subject": "profile_math", "expectedVersion": version,
                "settings": {"onboarded": True, "name": "Гость А", "selfLevel": "base", "goal": "g60"},
            })
            assert status == 200, (status, saved)
            status, seeded = request(opener_a, base, "/api/events/timeline", "POST", {
                "subject": "profile_math", "expectedVersion": saved["stateVersion"],
                "events": [{"ts": 1700000000000, "text": "Гостевой прогресс А"}],
            })
            assert status == 200, (status, seeded)

            # 2. Регистрация привязывает текущего гостя — данные не теряются.
            status, reg = request(opener_a, base, "/api/auth/register", "POST", {
                "name": "Пользователь А", "email": "User-A@Example.com", "password": "password-a-123",
            })
            assert status == 200, (status, reg)
            assert reg["user"]["registered"] is True, reg
            assert reg["user"]["email"] == "user-a@example.com", reg  # email нормализован
            assert reg["user"]["accountId"] == account_a, (reg, account_a)
            token_a = cookie_token(jar_a)
            assert token_a, "после регистрации сессия продолжается на новом токене"

            status, boot = request(opener_a, base, "/api/bootstrap")
            assert boot["accountId"] == account_a, boot["accountId"]
            assert boot["auth"] == {"registered": True, "email": "user-a@example.com"}, boot["auth"]
            assert boot["state"]["name"] == "Пользователь А", boot["state"]["name"]
            assert boot["state"]["onboarded"] is True, boot["state"]
            assert "Гостевой прогресс А" in [i["text"] for i in boot["state"]["timeline"]], boot["state"]["timeline"]

            # 3. Повторное открытие сайта — auto-login на той же сессии.
            status, reopen = request(opener_a, base, "/api/bootstrap-lite")
            assert reopen["accountId"] == account_a, reopen["accountId"]
            assert reopen["auth"]["registered"] is True, reopen["auth"]

            # Повторная регистрация уже зарегистрированного аккаунта -> 409.
            status, again = request(opener_a, base, "/api/auth/register", "POST", {
                "name": "X", "email": "other-a@example.com", "password": "password-x-123",
            })
            assert status == 409, (status, again)

            # 8. Неверный пароль -> 401; несуществующий email -> тот же 401/текст.
            status, bad_pw = request(opener_a, base, "/api/auth/login", "POST", {
                "email": "user-a@example.com", "password": "wrong-password",
            })
            assert status == 401, (status, bad_pw)
            status, bad_mail = request(opener_a, base, "/api/auth/login", "POST", {
                "email": "nobody@example.com", "password": "whatever-123",
            })
            assert status == 401, (status, bad_mail)
            assert bad_pw["error"] == bad_mail["error"], (bad_pw, bad_mail)

            # 9. Подмена user id ничего не меняет: идентичность — только из куки.
            status, spoof = request(opener_a, base, "/api/settings", "PATCH", {
                "subject": "profile_math", "expectedVersion": reopen["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "Пользователь А"},
                "userId": 999999, "id": 999999, "accountId": "zz9999",
            }, )
            assert status == 200, (status, spoof)
            status, boot = request(opener_a, base, "/api/bootstrap-lite")
            assert boot["accountId"] == account_a, boot["accountId"]

            # Второе «устройство» заводит/регистрирует второй аккаунт.
            opener_b, jar_b = make_device()
            status, boot_b = request(opener_b, base, "/api/bootstrap-lite")
            account_b = boot_b["accountId"]
            assert account_b != account_a, (account_a, account_b)
            status, reg_b = request(opener_b, base, "/api/auth/register", "POST", {
                "name": "Пользователь Б", "email": "user-b@example.com", "password": "password-b-123",
            })
            assert status == 200, (status, reg_b)
            status, boot_b = request(opener_b, base, "/api/bootstrap-lite")
            assert boot_b["auth"] == {"registered": True, "email": "user-b@example.com"}, boot_b["auth"]

            # 7. Занятый email со второго устройства -> 409.
            status, dup = request(opener_b, base, "/api/auth/register", "POST", {
                "name": "Клон", "email": "user-a@example.com", "password": "password-c-123",
            })
            assert status == 409, (status, dup)

            # 10. Чужая кука не видит данные первого аккаунта.
            assert boot_b["accountId"] == account_b
            status, boot_a = request(opener_a, base, "/api/bootstrap")
            assert "Гостевой прогресс А" in [i["text"] for i in boot_a["state"]["timeline"]]
            assert "Гостевой прогресс А" not in [i["text"] for i in boot_b["state"]["timeline"]]
            status, admin_probe = request(opener_b, base, "/api/admin/session")
            assert status == 401, (status, admin_probe)
            status, admin_users = request(opener_b, base, "/api/admin/users")
            assert status == 401, (status, admin_users)

            # 4. Logout: сервер инвалидирует сессию, auto-login невозможен.
            status, out = request(opener_a, base, "/api/auth/logout", "POST", {})
            assert status == 200, (status, out)
            status, guest_again = request(opener_a, base, "/api/bootstrap-lite")
            assert guest_again["accountId"] != account_a, guest_again["accountId"]
            assert guest_again["auth"]["registered"] is False, guest_again["auth"]
            # Даже ручная отправка старой (удалённой сервером) куки не
            # восстанавливает аккаунт — минтится свежий гость с новой кукой.
            bare = urllib.request.build_opener()
            status, stale = request(bare, base, "/api/bootstrap-lite", raw_cookie=f"ege_session={token_a}")
            assert status == 200, (status, stale)
            assert stale["accountId"] not in (account_a, account_b), stale["accountId"]
            assert stale["auth"]["registered"] is False, stale["auth"]

            # 5. Login из свежей гостевой сессии открывает именно второй аккаунт.
            status, login_b = request(opener_a, base, "/api/auth/login", "POST", {
                "email": "user-b@example.com", "password": "password-b-123",
            })
            assert status == 200, (status, login_b)
            assert login_b["user"]["accountId"] == account_b, login_b
            status, boot = request(opener_a, base, "/api/bootstrap-lite")
            assert boot["accountId"] == account_b, boot["accountId"]
            assert boot["auth"]["email"] == "user-b@example.com", boot["auth"]

            # 6. Logout -> login обратно: первый аккаунт и его данные на месте.
            status, out = request(opener_a, base, "/api/auth/logout", "POST", {})
            assert status == 200, (status, out)
            status, back = request(opener_a, base, "/api/auth/login", "POST", {
                "email": "user-a@example.com", "password": "password-a-123",
            })
            assert status == 200, (status, back)
            assert back["user"]["accountId"] == account_a, back
            status, boot = request(opener_a, base, "/api/bootstrap")
            assert boot["accountId"] == account_a
            assert boot["state"]["name"] == "Пользователь А", boot["state"]["name"]
            assert "Гостевой прогресс А" in [i["text"] for i in boot["state"]["timeline"]]

            # 14. Истёкшая сессия: сервер выдаёт нового гостя и новую куку.
            conn = server.connect()
            try:
                conn.execute("UPDATE user_sessions SET expires_at=? WHERE token=?",
                             (0, cookie_token(jar_a)))
                conn.commit()
            finally:
                conn.close()
            status, expired = request(opener_a, base, "/api/bootstrap-lite")
            assert status == 200, (status, expired)
            assert expired["accountId"] != account_a, expired["accountId"]
            assert expired["auth"]["registered"] is False, expired["auth"]

            # 16. Legacy-миграция: старый users.session_token продолжает работать.
            status, legacy = request(bare, base, "/api/bootstrap", raw_cookie="ege_session=legacy-token-0123456789abcdef")
            assert status == 200, (status, legacy)
            assert legacy["accountId"] == "zzleg1", legacy["accountId"]
            assert "Наследие старой схемы" in [i["text"] for i in legacy["state"]["timeline"]]
            assert legacy["auth"]["registered"] is False, legacy["auth"]

            # 17. Дубликатов нет: первый аккаунт сидит в той же строке users.
            conn = server.connect()
            try:
                row = conn.execute("SELECT id, email, name FROM users WHERE account_id=?", (account_a,)).fetchone()
                assert row is not None, "аккаунт А потерян"
                assert row["email"] == "user-a@example.com"
                assert row["name"] == "Пользователь А"
                total = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
                # A, B, гость после logout, гость после истечения, гость из
                # stale-токена, legacy — осмысленные строки без клонов.
                assert total <= 6, f"похоже на дубликаты: {total} users"
            finally:
                conn.close()

            # 18. Admin-auth отдельно и работает.
            status, anon_probe = request(bare, base, "/api/admin/session")
            assert status == 401, (status, anon_probe)
            opener_adm, jar_adm = make_device()
            status, adm_login = request(opener_adm, base, "/api/admin/login", "POST",
                                        {"password": "test-admin-password"})
            assert status == 200, (status, adm_login)
            status, adm_probe = request(opener_adm, base, "/api/admin/session")
            assert status == 200 and adm_probe["admin"] is True, (status, adm_probe)
            status, adm_out = request(opener_adm, base, "/api/admin/logout", "POST", {})
            assert status == 200, (status, adm_out)
            status, adm_probe2 = request(opener_adm, base, "/api/admin/session")
            assert status == 401, (status, adm_probe2)

            print("Auth regression OK: guest->register привязывает профиль, login/logout и сессии работают, дубликатов нет")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
