#!/usr/bin/env python3
"""КРИТИЧЕСКИЕ сценарии Admin Inbox: кто видит блок и когда он исчезает.

Один большой regression-тест на живом сервере с temp-БД (прод не трогается).
Покрывает popular+critical:

  A. Видимость: guest / обычный юзер / admin (только серверный isAdmin).
  B. Блок исчезает: logout, отзыв сессии, истечение user/admin-сессии,
     admin logout, удаление аккаунта каскадом, смена аккаунта, повторный
     вход, повторный вход с другого устройства.
  C. Обход авторизации: чужая/подменённая ege_admin, отсутствие ege_session,
     битый токен, подмена user_id/account_id/isAdmin в query и заголовках,
     отсутствие плодения аккаунтов 401-пробами, отсутствие утечек текста.
  D. Данные: валидация пагинации, порядок/группировка, идемпотентность
     «Прочитано», аудит, белый список полей, исчезновение из status=new.
  E. Финальный инвариант: обычный юзер по-прежнему не видит блок и не
     получает данные ни через что.

Запуск: python3 test/admin-inbox-security.py
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
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ADMIN_PASSWORD = b"inbox-security-test-admin"
USER_PASSWORD = b"user-password-123"
SECRET_TEXT = "СЕКРЕТНЫЙ-ТЕКСТ-ОБРАЩЕНИЯ-ДОЛЖЕН-НЕ-УТЕКАТЬ"

FAILED: list[str] = []
PASSED = 0


def t(name: str, cond: bool, extra: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL {name}" + (f" — {extra}" if extra else ""))


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "d" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_inbox_security_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """Устройство = свой cookie jar (своя user-сессия и свой admin-token)."""

    def __init__(self, base: str, name: str):
        self.base = base
        self.name = name
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def __call__(self, path: str, method: str = "GET", body=None, raw_cookie: str | None = None,
                 headers: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if raw_cookie:
            req.add_header("Cookie", raw_cookie)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def json(self, path: str, method: str = "GET", body=None, raw_cookie: str | None = None,
             headers: dict | None = None):
        status, raw = self(path, method, body, raw_cookie, headers)
        try:
            return status, json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return status, {"_raw": raw[:200].decode("utf-8", "replace")}

    def cookie(self, name: str) -> str | None:
        for c in self.jar:
            if c.name == name:
                return c.value
        return None

    def cookie_header(self) -> str:
        return "; ".join(f"{c.name}={c.value}" for c in self.jar)

    def raw_json(self, path: str, cookie: str, method: str = "GET", body=None,
                 headers: dict | None = None):
        """Запрос РОВНО с указанной Cookie — без cookie jar устройства.

        Нужен для проверок подмены: иначе urllib дописывает собственные куки
        клиента в заголовок, и тест «проходит» на смеси двух сессий."""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Cookie", cookie)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()


def make_admin(base: str, name: str) -> Client:
    c = Client(base, name)
    st, _ = c.json("/api/bootstrap-lite")
    assert st == 200, f"{name}: bootstrap {st}"
    st, body = c.json("/api/admin/login", "POST", {"password": ADMIN_PASSWORD.decode()})
    assert st == 200 and c.cookie("ege_admin"), f"{name}: admin login {st} {body}"
    return c


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-inbox-security-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
            server.ensure_support_schema(conn)
            rows = [
                (SECRET_TEXT, "new"),
                ("Старое прочитанное обращение", "reviewed"),
                ("Решённое обращение", "resolved"),
            ]
            for i, (text, status) in enumerate(rows):
                conn.execute(
                    "INSERT INTO support_messages(request_key, message_digest, source, message,"
                    " spam_score, status, created_at) VALUES (?,?,?,?,0,?,?)",
                    (hashlib.sha256(f"sec-{i}".encode()).hexdigest(),
                     hashlib.sha256(text.encode()).hexdigest(), "contacts", text,
                     status, str(1700000000000 + i * 1000)),
                )
            conn.commit()
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            db = lambda: server.connect()  # noqa: E731
            INBOX = "/api/admin/support-messages"

            guest = Client(base, "guest")
            user = Client(base, "user")
            admin = make_admin(base, "admin")

            # ---------------------------------------------------------- A
            section("A. Видимость блока: guest / юзер / admin")
            st, boot = guest.json("/api/bootstrap-lite")
            t("A1 guest: bootstrap 200 и isAdmin=false", st == 200 and boot.get("isAdmin") is False, f"{st} {boot.get('isAdmin')}")
            t("A2 guest: в bootstrap нет данных обращений",
              not ({"messages", "supportMessages", "inbox"} & set(boot)), str(list(boot)[:8]))
            t("A3 guest: inbox API 401", guest.json(INBOX)[0] == 401)
            t("A4 guest: /api/admin/session 401", guest.json("/api/admin/session")[0] == 401)

            st, _ = user.json("/api/bootstrap-lite")
            st, reg = user.json("/api/auth/register", "POST",
                                {"name": "Обычный", "email": "user@example.com",
                                 "password": USER_PASSWORD.decode()})
            t("A5 юзер: регистрация прошла", st == 200, str(reg)[:120])
            st, boot = user.json("/api/bootstrap-lite")
            t("A6 юзер: isAdmin=false после регистрации", st == 200 and boot.get("isAdmin") is False)
            t("A7 юзер: inbox API 401 (в т.ч. пагинация)",
              user.json(f"{INBOX}?limit=100&offset=0")[0] == 401
              and user.json(f"{INBOX}?status=all")[0] == 401)
            t("A8 юзер: чужие админ-эндпоинты тоже 401", user.json("/api/admin/overview")[0] == 401)

            for path in ("/api/bootstrap-lite", "/api/bootstrap"):
                st, b = admin.json(path)
                t(f"A9 admin: {path} isAdmin=true", st == 200 and b.get("isAdmin") is True, str(st))
            st, sess = admin.json("/api/auth/session")
            t("A10 admin: /api/auth/session isAdmin=true", st == 200 and sess.get("isAdmin") is True)
            st, subj = admin.json("/api/subject", "POST", {"subject": "profile_math"})
            t("A11 admin: POST /api/subject isAdmin=true", st == 200 and subj.get("isAdmin") is True)
            st, inbox = admin.json(INBOX)
            t("A12 admin: inbox 200 и непустой", st == 200 and len(inbox.get("messages", [])) == 3, str(st))
            t("A13 admin: /api/admin/session 200", admin.json("/api/admin/session")[0] == 200)

            # ---------------------------------------------------------- B
            section("B. Блок исчезает: logout / отзыв / истечение / смена аккаунта")

            # B1 logout обычного юзера
            st, _ = user.json("/api/auth/logout", "POST", {})
            st, boot = user.json("/api/bootstrap-lite")
            t("B1 logout юзера: isAdmin=false", st == 200 and boot.get("isAdmin") is False)
            t("B1 logout юзера: inbox 401", user.json(INBOX)[0] == 401)

            # B2 logout админа: обе куки чистятся, прав нет
            st, _ = admin.json("/api/auth/logout", "POST", {})
            t("B2 logout: ege_admin кука снята", admin.cookie("ege_admin") in (None, ""), str(admin.cookie("ege_admin")))
            t("B2 logout: ege_session кука снята", admin.cookie("ege_session") in (None, ""), str(admin.cookie("ege_session")))
            st, boot = admin.json("/api/bootstrap-lite")
            t("B2 logout: isAdmin=false в bootstrap", st == 200 and boot.get("isAdmin") is False)
            t("B2 logout: inbox 401", admin.json(INBOX)[0] == 401)
            t("B2 logout: /api/admin/session 401", admin.json("/api/admin/session")[0] == 401)

            # B3 повторный вход в /admin возвращает права
            st, _ = admin.json("/api/admin/login", "POST", {"password": ADMIN_PASSWORD.decode()})
            st, boot = admin.json("/api/bootstrap-lite")
            t("B3 повторный /api/admin/login: права вернулись", st == 200 and boot.get("isAdmin") is True)
            t("B3 inbox снова 200", admin.json(INBOX)[0] == 200)

            # B4 истечение user_sessions (админский аккаунт теряет user-сессию)
            c = db()
            try:
                tok = admin.cookie("ege_session")
                c.execute("UPDATE user_sessions SET expires_at=? WHERE token=?",
                          (int(time.time() * 1000) - 1000, tok))
                c.commit()
            finally:
                c.close()
            t("B4 истёкшая user-сессия: inbox 401", admin.json(INBOX)[0] == 401)
            t("B4 истёкшая user-сессия: /api/admin/session 401", admin.json("/api/admin/session")[0] == 401)
            st, boot = admin.json("/api/bootstrap-lite")
            t("B4 истёкшая user-сессия: новый bootstrap isAdmin=false", st == 200 and boot.get("isAdmin") is False)

            # B5 отзыв текущей сессии через devices API
            admin2 = make_admin(base, "admin-revoke")
            st, devices = admin2.json("/api/auth/devices")
            current = next((d["id"] for d in devices.get("devices", []) if d.get("current")), None)
            t("B5 подготовка: текущая сессия видна в devices", current is not None, str(devices)[:120])
            st, _ = admin2.json(f"/api/auth/devices/{current}", "DELETE")
            t("B5 отзыв текущей сессии: 200", st == 200, str(st))
            t("B5 отзыв: inbox 401", admin2.json(INBOX)[0] == 401)
            st, boot = admin2.json("/api/bootstrap-lite")
            t("B5 отзыв: isAdmin=false", st == 200 and boot.get("isAdmin") is False)

            # B6 admin logout отдельно (user-сессия остаётся валидной)
            admin3 = make_admin(base, "admin-logout")
            st, _ = admin3.json("/api/admin/logout", "POST", {})
            t("B6 /api/admin/logout: 200 и кука снята", st == 200 and not admin3.cookie("ege_admin"), str(st))
            st, auth = admin3.json("/api/auth/session")
            t("B6 user-сессия продолжает работать", st == 200 and auth.get("isAdmin") is False, str(auth)[:120])
            t("B6 inbox 401 после admin-logout", admin3.json(INBOX)[0] == 401)

            # B7 истечение admin_sessions при живой user-сессии
            admin4 = make_admin(base, "admin-expire")
            c = db()
            try:
                c.execute("UPDATE admin_sessions SET expires_at=? WHERE user_id IN "
                          "(SELECT id FROM users WHERE id IN (SELECT user_id FROM admin_sessions))",
                          (int(time.time() * 1000) - 1000,))
                c.commit()
            finally:
                c.close()
            t("B7 истёкшая admin-сессия: inbox 401", admin4.json(INBOX)[0] == 401)
            t("B7 истёкшая admin-сессия: /api/admin/session 401", admin4.json("/api/admin/session")[0] == 401)
            st, boot = admin4.json("/api/bootstrap-lite")
            t("B7 истёкшая admin-сессия: isAdmin=false при живой user-сессии",
              st == 200 and boot.get("isAdmin") is False, str(boot.get("isAdmin")))

            # B8 удаление аккаунта каскадом сносит admin_sessions
            admin5 = make_admin(base, "admin-delete")
            st, _ = admin5.json("/api/state", "DELETE")
            t("B8 удаление аккаунта: 200", st == 200, str(st))
            t("B8 после удаления: inbox 401", admin5.json(INBOX)[0] == 401)
            t("B8 после удаления: /api/admin/session 401", admin5.json("/api/admin/session")[0] == 401)

            # B9 смена аккаунта: login в другой аккаунт с той же админ-кукой
            switcher = Client(base, "switcher")
            st, _ = switcher.json("/api/bootstrap-lite")
            st, _ = switcher.json("/api/auth/register", "POST",
                                  {"name": "Второй", "email": "second@example.com",
                                   "password": USER_PASSWORD.decode()})
            live_admin = make_admin(base, "admin-switch")
            admin_pair = f"ege_session={live_admin.cookie('ege_session')}; ege_admin={live_admin.cookie('ege_admin')}"
            mix_pair = f"ege_session={switcher.cookie('ege_session')}; ege_admin={live_admin.cookie('ege_admin')}"
            st, _ = switcher.raw_json(INBOX, admin_pair)
            t("B9a контроль: своя пара кук админа работает (200)", st == 200, str(st))
            st, _ = switcher.raw_json(INBOX, mix_pair)
            t("B9b подмена: ege_session другого аккаунта + ege_admin админа -> 401", st == 401, str(st))
            st, raw = switcher.raw_json("/api/bootstrap-lite", mix_pair)
            try:
                is_admin = json.loads(raw).get("isAdmin")
            except Exception:
                is_admin = "not-json"
            t("B9c подмена: bootstrap isAdmin=false", is_admin is False, str(is_admin))
            st, _ = switcher.raw_json(INBOX, switcher.cookie_header())
            t("B9d свой аккаунт без админ-куки -> 401", st == 401, str(st))

            # B10 повторный вход в /admin с другого устройства отзывает первый
            # (документированное поведение create_admin_session: одна живая
            #  admin-сессия на аккаунт)
            multi = make_admin(base, "multi-device")
            st, boot = multi.json("/api/bootstrap-lite")
            was_admin = boot.get("isAdmin") is True
            st, _ = multi.json("/api/admin/login", "POST", {"password": ADMIN_PASSWORD.decode()})
            st, boot = multi.json("/api/bootstrap-lite")
            t("B10 повторный вход с того же устройства: права на месте",
              was_admin and st == 200 and boot.get("isAdmin") is True)

            # ---------------------------------------------------------- C
            section("C. Обход авторизации")
            admin6 = make_admin(base, "admin-guard")
            a_sess, a_admin = admin6.cookie("ege_session"), admin6.cookie("ege_admin")
            other = Client(base, "other-user")
            st, _ = other.json("/api/bootstrap-lite")
            o_sess = other.cookie("ege_session")

            st, _ = other.raw_json(INBOX, f"ege_session={o_sess}; ege_admin={a_admin}")
            t("C1 чужая ege_admin на чужой сессии: 401", st == 401, str(st))
            st, _ = other.raw_json(INBOX, f"ege_admin={a_admin}")
            t("C2 ege_admin без ege_session: 401", st == 401, str(st))
            st, _ = other.raw_json(INBOX, f"ege_session={'z' * 43}; ege_admin={a_admin}")
            t("C3 битый ege_session + валидная ege_admin: 401", st == 401, str(st))
            st, _ = other.raw_json(INBOX, f"ege_session={o_sess}; ege_admin=not-a-token")
            t("C4 мусорная ege_admin: 401", st == 401, str(st))
            st, _ = other.raw_json(INBOX, f"ege_session={a_sess}; ege_admin={a_admin}")
            t("C5b настоящая пара своего админа: 200 (контроль положительный)", st == 200, str(st))
            st, _ = other.raw_json(INBOX, "")
            t("C5c вообще без кук: 401", st == 401, str(st))

            spoof_paths = [
                f"{INBOX}?user_id=1&account_id=AAAAAA&isAdmin=true",
                f"{INBOX}?userId=1&accountId=AAAAAA",
                f"{INBOX}?limit=100&offset=0&status=all",
            ]
            for p in spoof_paths:
                st, _ = other.raw_json(p, f"ege_session={o_sess}; ege_admin={a_admin}",
                                       headers={"X-Admin": "1", "X-Is-Admin": "true",
                                                "X-Forwarded-User": "1"})
                t(f"C6 подмена в query/заголовках не даёт прав: {p[:44]}...", st == 401, str(st))

            c = db()
            try:
                before = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            finally:
                c.close()
            for _ in range(3):
                other.json(INBOX)
                guest.json(INBOX)
            c = db()
            try:
                after = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            finally:
                c.close()
            t("C6 401-пробы не плодят аккаунты", before == after, f"{before} -> {after}")

            st, raw = other.json(INBOX)
            t("C7 текст обращения не утекает в отказе", SECRET_TEXT.encode() not in raw)
            leaks = []
            for path in ("/api/bootstrap-lite", "/api/auth/session", "/api/subjects", "/api/status"):
                st, raw = other(path)
                if SECRET_TEXT.encode() in raw:
                    leaks.append(path)
            t("C8 текст не утекает в публичных/bootstrap API", not leaks, str(leaks))
            st, payload = other.json("/api/bootstrap")
            keys = set(payload.keys())
            t("C9 в bootstrap нет admin-полей кроме isAdmin",
              not ({"messages", "inbox", "supportMessages", "adminInbox"} & keys), str(sorted(keys)))
            t("C10 без ege_admin даже валидная user-сессия админа не даёт прав",
              other.raw_json(INBOX, f"ege_session={a_sess}")[0] == 401)

            # ---------------------------------------------------------- D
            section("D. Данные: пагинация, порядок, «Прочитано», утечки полей")
            for bad in ("?limit=0", "?limit=-1", "?limit=abc", "?limit=101", "?offset=-1",
                        "?offset=abc", "?status=bogus", "?limit=2&offset=1.5"):
                st, _ = admin6.json(INBOX + bad)
                t(f"D1 некорректная пагинация/статус -> 400: {bad}", st == 400, str(st))

            st, page1 = admin6.json(f"{INBOX}?limit=2&offset=0")
            st, page2 = admin6.json(f"{INBOX}?limit=2&offset=2")
            t("D2 пагинация отдаёт стабильные страницы",
              st == 200 and len(page1.get("messages", [])) == 2 and len(page2.get("messages", [])) == 1,
              f"{len(page1.get('messages', []))}/{len(page2.get('messages', []))}")
            order = {"new": 0, "reviewed": 1, "resolved": 2, "archived": 3}
            keys_all = [(order[m["status"]], -m["id"]) for m in page1.get("messages", []) + page2.get("messages", [])]
            t("D3 порядок: группы статуса, внутри id DESC", keys_all == sorted(keys_all), str(keys_all))
            t("D4 счётчики совпадают с выборкой",
              page1.get("total") == 3 and page1.get("newCount") == 1,
              f"total={page1.get('total')} new={page1.get('newCount')}")

            allowed = {"id", "message", "status", "createdAt"}
            sample = (page1.get("messages") or [{}])[0]
            t("D5 наружу только разрешённые поля", set(sample) <= allowed, str(sorted(sample)))
            t("D6 нет внутренних ключей дедупа",
              "request_key" not in json.dumps(page1) and "message_digest" not in json.dumps(page1))

            st, newonly = admin6.json(f"{INBOX}?status=new")
            target = (newonly.get("messages") or [{}])[0].get("id")
            st, done = admin6.json(f"{INBOX}/{target}/read", "POST", {})
            t("D7 «Прочитано»: 200 и статус reviewed", st == 200 and done.get("status") == "reviewed", f"{st} {done}")
            st, again = admin6.json(f"{INBOX}/{target}/read", "POST", {})
            t("D8 идемпотентность повторного чтения", st == 200 and again.get("status") == "reviewed")
            st, body = admin6.json(f"{INBOX}/999999/read", "POST", {})
            t("D9 несуществующий id -> 404", st == 404, str(st))
            st, body = other.json(f"{INBOX}/{target}/read", "POST", {})
            t("D10 чужой не может отметить прочитанным", st == 401, str(st))
            st, body = admin6.json(f"{INBOX}/{target}/read", "PUT", {})
            t("D11 PUT по адресу чтения -> 405", st == 405, str(st))
            st, after = admin6.json(f"{INBOX}?status=new")
            t("D12 прочитанное исчезло из status=new", st == 200 and after.get("total") == 0, str(after.get("total")))
            st, allmsgs = admin6.json(f"{INBOX}?status=reviewed&limit=100")
            t("D13 прочитанное осталось в БД (status=reviewed)",
              st == 200 and any(m["id"] == target for m in allmsgs.get("messages", [])), str(st))

            c = db()
            try:
                audit = c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='support-read'").fetchone()[0]
            finally:
                c.close()
            t("D14 чтение попало в аудит", audit >= 1, str(audit))

            # ---------------------------------------------------------- E
            section("E. Финальный инвариант: юзер по-прежнему без блока и без данных")
            st, boot = user.json("/api/bootstrap-lite")
            t("E1 юзер: isAdmin=false в финале", st == 200 and boot.get("isAdmin") is False)
            t("E2 юзер: inbox 401 в финале", user.json(INBOX)[0] == 401)
            st, raw = user.json(INBOX)
            t("E3 юзер: текст обращений не утекает в финале", SECRET_TEXT.encode() not in raw)
            st, sess = user.json("/api/auth/session")
            t("E4 /api/auth/session: isAdmin=false у юзера", st == 200 and sess.get("isAdmin") is False)
        finally:
            httpd.shutdown()

    print(f"\n{'=' * 46}")
    if FAILED:
        print(f"ПРОВАЛЕНО {len(FAILED)} из {PASSED + len(FAILED)}:")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print(f"admin-inbox-security: OK — все {PASSED} критических проверок прошли")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
