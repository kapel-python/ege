#!/usr/bin/env python3
"""Вход через Google: полный серверный поток на живом сервере с temp-БД.

Проверяется ровно то, что нельзя увидеть на глаз:

1. без ключей вход выключен честно (503), сайт при этом живой;
2. GET /api/auth/google — редирект на провайдера с подписанным state, кука
   nonce едет вместе, и в базе НИЧЕГО не появляется;
3. подделанный state, чужой state и state без куки браузера не дают входа
   (три независимые проверки: подпись, привязка к браузеру, возраст);
4. успешный вход нового адреса заводит одну строку users + привязку, ставит
   сессию, и клиентский bootstrap видит registered=true и googleEnabled=true;
5. повторный вход с того же Google-аккаунта с ДРУГОГО устройства попадает в
   тот же users.id — второй строки не появляется;
6. адрес, уже занятый парольным аккаунтом, открывает его так же, как вход по
   паролю (Google подтвердил владение почтой), но второй Google-аккаунт в уже
   привязанный профиль не пускается (error=conflict);
7. гость с прогрессом, вошедший через Google, сохраняет свой accountId;
8. заблокированный аккаунт не получает сессию (403 ACCOUNT_BLOCKED);
9. неподтверждённая почта провайдера не даёт входа (error=identity);
10. код одноразовый: повторный callback с тем же кодом не проходит;
11. cross-site POST на unlink отклоняется гейтом CSRF (403);
12. отвязка Google: у аккаунта без пароля refused (400 NO_PASSWORD) —
    иначе человек потерял бы единственный вход; с паролем отвязка проходит;
13. удаление аккаунта админом сносит привязку каскадом.

Запуск из корня репозитория: python3 test/google-auth.py
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
# Фейковый Google: подпись кода, одноразовость, профиль владельца.
# ---------------------------------------------------------------------------
class FakeGoogle:
    """Мини-шлюз: /authorize → код, /token → токен, /userinfo → профиль."""

    def __init__(self):
        self.codes: dict[str, dict] = {}
        self.used_codes: set[str] = set()
        self.issued_tokens: dict[str, dict] = {}
        self.token_calls = 0
        self.userinfo_calls = 0
        # Кем притвориться на следующий вход: sub/email/name/verified.
        self.identity = {"sub": "google-sub-1", "email": "guy@example.com",
                         "name": "Гай Кей", "email_verified": True}
        self.fail_token_with: str | None = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _send(self, code, body: bytes, ctype="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                if parsed.path == "/authorize":
                    # Настоящий провайдер сначала спрашивает человека; здесь
                    # сразу выдаём код — тесту важна вторая половина потока.
                    code = f"code-{len(outer.codes) + 1}-{int(time.time() * 1000)}"
                    outer.codes[code] = {"sub": outer.identity["sub"],
                                         "email": outer.identity["email"],
                                         "used": False}
                    redirect = (query.get("redirect_uri", [""])[0]
                                + "?code=" + urllib.parse.quote(code)
                                + "&state=" + urllib.parse.quote(query.get("state", [""])[0]))
                    self.send_response(302)
                    self.send_header("Location", redirect)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if parsed.path == "/userinfo":
                    outer.userinfo_calls += 1
                    auth = self.headers.get("Authorization") or ""
                    token = auth[7:] if auth.startswith("Bearer ") else ""
                    profile = outer.issued_tokens.get(token)
                    if not profile:
                        self._send(401, json.dumps({"error": "invalid_token"}).encode())
                        return
                    self._send(200, json.dumps(profile).encode())
                    return
                self._send(404, b"{}")

            def do_POST(self):
                outer.token_calls += 1
                length = int(self.headers.get("Content-Length") or 0)
                form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
                if outer.fail_token_with:
                    self._send(400, json.dumps({"error": outer.fail_token_with}).encode())
                    return
                code = form.get("code", [""])[0]
                stored = outer.codes.get(code)
                # Код одноразовый — ровно как настоящий: повторный обмен даёт
                # invalid_grant, и это единственная защита от replay без БД.
                if not stored or stored["used"]:
                    self._send(400, json.dumps({"error": "invalid_grant"}).encode())
                    return
                stored["used"] = True
                token = "tok-" + hashlib.sha1(code.encode()).hexdigest()[:16]
                outer.issued_tokens[token] = {"sub": stored["sub"], "email": stored["email"],
                                              "name": outer.identity["name"],
                                              "email_verified": outer.identity["email_verified"]}
                self._send(200, json.dumps({"access_token": token,
                                            "token_type": "Bearer", "expires_in": 3600}).encode())

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ---------------------------------------------------------------------------
# Клиент теста: без автоперехода по редиректам (иначе 302 от Google утащил бы
# нас на колбэк сам, и проверять было бы нечего).
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
    return request_url(opener, base + path, method, body)


def request_url(opener, url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
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


def location_of(headers) -> str:
    return headers.get("Location") or ""


def fragment_of(location: str) -> str:
    return location.split("#", 1)[1] if "#" in location else location


def query_of_fragment(fragment: str) -> dict:
    body = fragment.split("?", 1)[1] if "?" in fragment else ""
    return {k: v[0] for k, v in urllib.parse.parse_qs(body).items()}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ.pop("EGE_GOOGLE_CLIENT_ID", None)
    os.environ.pop("EGE_GOOGLE_CLIENT_SECRET", None)
    os.environ.pop("EGE_GOOGLE_REDIRECT_URI", None)
    salt = "b" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"unused", bytes.fromhex(salt), 1000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$1000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_google_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def enable_google(fake: FakeGoogle, base: str):
    """Включаем вход через фейкового Google и объявляем redirect_uri."""
    os.environ["EGE_GOOGLE_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com"
    os.environ["EGE_GOOGLE_CLIENT_SECRET"] = "test-client-secret"
    os.environ["EGE_GOOGLE_AUTH_URL"] = fake.base + "/authorize"
    os.environ["EGE_GOOGLE_TOKEN_URL"] = fake.base + "/token"
    os.environ["EGE_GOOGLE_USERINFO_URL"] = fake.base + "/userinfo"
    os.environ["EGE_GOOGLE_REDIRECT_URI"] = base + "/api/auth/google/callback"
    os.environ["EGE_PUBLIC_URL"] = base


def rows(server, sql, args=()):
    conn = server.connect()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def count_users(server) -> int:
    return int(rows(server, "SELECT COUNT(*) AS c FROM users")[0]["c"])


def full_google_login(opener, base, fake: FakeGoogle, expect_fragment: str | None = None):
    """Пройти весь поток как браузер: старт → подпись → код → колбэк."""
    status, headers, _ = request(opener, base, "/api/auth/google")
    if status != 302:
        return status, headers, {}
    start_location = location_of(headers)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start_location).query)["state"][0]
    # Код выдаёт провайдер: идём к нему тем же браузером и берём редирект.
    status, headers, _ = request_url(opener, start_location)
    callback = location_of(headers)
    status, headers, body = request_url(opener, callback)
    fragment = fragment_of(location_of(headers))
    if expect_fragment is not None:
        check(f"возврат на {expect_fragment}", fragment.startswith(expect_fragment),
              f"{fragment} (status {status})")
    return status, headers, body


def main():
    with tempfile.TemporaryDirectory(prefix="ege-google-") as tmp:
        fake = FakeGoogle()
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
            section("1. Без ключей вход выключен, сайт жив")
            opener, jar = make_device()
            status, _, body = request(opener, base, "/api/auth/google")
            check("старт без ключей -> 503", status == 503 and body.get("code") == "OAUTH_UNCONFIGURED",
                  (status, body))
            status, _, boot = request(opener, base, "/api/bootstrap-lite")
            check("bootstrap говорит googleEnabled=false", boot.get("auth", {}).get("googleEnabled") is False,
                  boot.get("auth"))
            check("без ключей ноль строк users", count_users(server) == 0)

            enable_google(fake, base)

            # ---------------------------------------------------------------
            section("2. Старт: редирект с подписью и кукой, база не тронута")
            opener, jar = make_device()
            status, headers, _ = request(opener, base, "/api/auth/google")
            check("старт -> 302", status == 302, status)
            target = location_of(headers)
            check("редирект ведёт к провайдеру", target.startswith(fake.base + "/authorize"), target)
            params = urllib.parse.parse_qs(urllib.parse.urlparse(target).query)
            check("state подписан и непуст", bool(params.get("state", [""])[0]), params.get("state"))
            check("redirect_uri совпадает с объявленным",
                  params.get("redirect_uri", [""])[0] == base + "/api/auth/google/callback",
                  params.get("redirect_uri"))
            check("scope запрошен openid email profile",
                  params.get("scope", [""])[0] == "openid email profile", params.get("scope"))
            # prompt=none был настоящей ошибкой: он запрещает ЛЮБОЙ интерфейс
            # Google, и «Привязать Google» у человека, залогиненного в Google
            # с другим адресом, молча упирался в отказ (видно в логах живого
            # сайта). Выбор аккаунта человек должен видеть всегда.
            check("Google всегда показывает выбор аккаунта",
                  params.get("prompt", [""])[0] == "select_account", params.get("prompt"))
            check("кука nonce выдана", bool(cookie_value(jar, "ege_oauth_nonce")))
            check("куки сессии нет", cookie_value(jar, "ege_session") is None)
            check("старт не завёл ни строки, ни сессии", count_users(server) == 0)

            # ---------------------------------------------------------------
            section("3. Подделка state: чужой, искажённый и без куки браузера")
            good_state = params["state"][0]
            for label, url in [
                ("искажённая подпись", base + "/api/auth/google/callback?code=x&state=" + good_state[:-2] + "zz"),
                ("state из чужого секрета", base + "/api/auth/google/callback?code=x&state=v1.abc.9999999999.deadbeef"),
                ("пустой state", base + "/api/auth/google/callback?code=x&state="),
            ]:
                st, hd, _ = request(opener, base, url.split(base)[1], "GET")
                fragment = fragment_of(location_of(hd))
                check(f"{label} -> входа нет", st == 302 and query_of_fragment(fragment).get("error") == "state",
                      (st, fragment))
                check(f"{label}: кука nonce сгорела", cookie_value(jar, "ege_oauth_nonce") in (None, ""),
                      cookie_value(jar, "ege_oauth_nonce"))
                check(f"{label}: строк users нет", count_users(server) == 0)

            # login-CSRF: состояние подлинное (только что выданное), но приходит
            # в браузер, который его не начинал.
            # Настоящий login-CSRF: злоумышленник начинает вход в СВОЁМ
            # браузере и скармливает жертве свой callback-адрес. Подпись здесь
            # подлинная — отбивает привязка к cookie: у жертвы нет nonce.
            opener_b, jar_b = make_device()
            st, hd, _ = request(opener_b, base, "/api/auth/google")
            csrf_state = urllib.parse.parse_qs(urllib.parse.urlparse(location_of(hd)).query)["state"][0]
            victim, victim_jar = make_device()
            st, hd, _ = request(victim, base, "/api/auth/google/callback?code=fake&state=" + csrf_state)
            fragment = fragment_of(location_of(hd))
            check("подлинное, но ЧУЖОЕ состояние отбито",
                  query_of_fragment(fragment).get("error") == "state", (st, fragment))
            check("login-CSRF не залогинил жертву", cookie_value(victim_jar, "ege_session") is None)
            check("у жертвы даже сессии не появилось", count_users(server) == 0)

            # ---------------------------------------------------------------
            section("3b. Привязка выглядит ТОЧНО как вход — те же параметры")
            # Живой комментарий: на экране входа Google показывал все аккаунты,
            # а на «Привязать Google» — ровно один (тот, что был подсказан).
            # Причина — login_hint: он ограничивает выбор. Значит внешний вид
            # привязки и входа обязан совпадать побайтно, иначе кнопка выглядит
            # сломанной.
            linker, linker_jar = make_device()
            st, _, _ = request(linker, base, "/api/profile/claim", "POST",
                               {"subject": "profile_math", "onboarded": True, "name": "Привязывающий"})
            st, _, reg = request(linker, base, "/api/auth/register", "POST",
                                 {"name": "Привязывающий", "email": "linker@example.com",
                                  "password": "super-pass-1"})
            check("аккаунт для привязки готов", st == 200, (st, reg))

            guest_g, guest_jar = make_device()
            st, hd_guest, _ = request(guest_g, base, "/api/auth/google")
            st, hd_link, _ = request(linker, base, "/api/auth/google")
            guest_params = urllib.parse.parse_qs(urllib.parse.urlparse(location_of(hd_guest)).query)
            link_params = urllib.parse.parse_qs(urllib.parse.urlparse(location_of(hd_link)).query)

            check("привязка НЕ ограничивает выбор аккаунта (никакого login_hint)",
                  "login_hint" not in link_params, link_params.get("login_hint"))
            check("привязка показывает выбор аккаунта, как вход",
                  link_params.get("prompt", [""])[0] == "select_account", link_params.get("prompt"))
            # Все параметры, кроме подписи state, обязаны совпасть с входом.
            comparable = {k: v for k, v in link_params.items() if k != "state"}
            check("набор параметров привязки == набор параметров входа",
                  comparable == {k: v for k, v in guest_params.items() if k != "state"},
                  (comparable, {k: v for k, v in guest_params.items() if k != "state"}))
            check("привязка не создана до обратного прихода от Google",
                  len(rows(server, "SELECT 1 FROM auth_identities WHERE email='linker@example.com'")) == 0)

            # ---------------------------------------------------------------
            section("4. Успешный вход нового адреса")
            opener, jar = make_device()
            before_users = count_users(server)
            # Первый вход нового адреса заводит НОВЫЙ аккаунт, а новому
            # аккаунту нужен онбординг (он и начинается с выбора предмета),
            # поэтому возврата к пикеру выбора предмета тут быть не должно.
            st, hd, body = full_google_login(opener, base, fake, expect_fragment="/dashboard")
            check("вход -> 302 в приложение", st == 302, st)
            check("сессия выдана", bool(cookie_value(jar, "ege_session")))
            check("nonce сгорел", cookie_value(jar, "ege_oauth_nonce") in (None, ""))
            # Ровно одна новая строка: вход нового адреса заводит ОДИН аккаунт.
            check("вход завёл ровно одну строку users", count_users(server) == before_users + 1,
                  (before_users, count_users(server)))
            identity = rows(server, "SELECT provider, subject, user_id, email FROM auth_identities")
            check("привязка создана", len(identity) == 1 and identity[0]["provider"] == "google", identity)
            check("привязка указывает на ту же строку, что и сессия",
                  identity and identity[0]["user_id"] ==
                  rows(server, "SELECT id FROM users")[0]["id"], identity)
            check("почта провайдера записана",
                  rows(server, "SELECT email FROM users")[0]["email"] == "guy@example.com")
            st, _, session = request(opener, base, "/api/auth/session")
            check("session: registered=true без пароля",
                  session["user"]["registered"] is True, session["user"])
            check("session: providers=[google]", session["user"]["providers"] == ["google"], session["user"])
            check("session: googleEnabled=true", session.get("google") is True, session.get("google"))
            st, _, boot = request(opener, base, "/api/bootstrap-lite")
            check("bootstrap: registered без хеша пароля", boot["auth"]["registered"] is True, boot["auth"])
            google_account = boot["accountId"]
            check("аккаунт заведён", bool(google_account), boot.get("accountId"))

            # ---------------------------------------------------------------
            section("5. Тот же Google с другого устройства — тот же аккаунт")
            opener2, jar2 = make_device()
            st, hd, _ = request(opener2, base, "/api/auth/google")
            st, hd, _ = request_url(opener2, location_of(hd))
            st, hd, _ = request_url(opener2, location_of(hd))
            st, _, session2 = request(opener2, base, "/api/auth/session")
            check("второе устройство вошло", session2.get("user", {}).get("accountId") == google_account,
                  session2.get("user"))
            check("повторный вход не завёл второго человека", count_users(server) == before_users + 1,
                  count_users(server))
            check("привязка одна", len(rows(server, "SELECT 1 FROM auth_identities")) == 1)

            # ---------------------------------------------------------------
            section("6. Занятый адрес = обычный вход, как по паролю")
            reg, reg_jar = make_device()
            st, _, _ = request(reg, base, "/api/profile/claim", "POST",
                               {"subject": "profile_math", "onboarded": True, "name": "Парольный"})
            st, _, registered = request(reg, base, "/api/auth/register", "POST",
                                        {"name": "Парольный", "email": "guy@example.com",
                                         "password": "super-pass-1"})
            check("занятый адрес не даёт зарегистрироваться дважды", st == 409, (st, registered))
            st, _, registered = request(reg, base, "/api/auth/register", "POST",
                                        {"name": "Парольный", "email": "pass@example.com",
                                         "password": "super-pass-1"})
            check("парольный аккаунт заведён", st == 200, (st, registered))
            password_account = registered["user"]["accountId"]

            # Тот же адрес, что у парольного аккаунта, и НИ ОДНОЙ привязки у
            # него нет: почта подтверждена Google, а наша регистрация почту не
            # подтверждает вообще — значит это более сильное доказательство
            # владения адресом, чем пароль. Вход обязан состояться сразу.
            fake.identity = {"sub": "google-sub-2", "email": "pass@example.com",
                             "name": "Артём", "email_verified": True}
            opener3, jar3 = make_device()
            st, hd, _ = request(opener3, base, "/api/auth/google")
            st, hd, _ = request_url(opener3, location_of(hd))
            st, hd, _ = request_url(opener3, location_of(hd))
            check("занятый адрес сразу ведёт в приложение, без экрана пароля",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") is None
                  and fragment_of(location_of(hd)).startswith("/subject"),
                  fragment_of(location_of(hd)))
            st, _, session3 = request(opener3, base, "/api/auth/session")
            check("вошёл именно в свой парольный аккаунт",
                  session3["user"]["accountId"] == password_account, session3.get("user"))
            check("сессия выдана", cookie_value(jar3, "ege_session") is not None)
            check("личность привязана к тому же аккаунту",
                  rows(server, "SELECT user_id FROM auth_identities WHERE subject='google-sub-2'")[0]["user_id"]
                  == rows(server, "SELECT id FROM users WHERE account_id=?", (password_account,))[0]["id"])
            check("провайдеры видны клиенту", session3["user"]["providers"] == ["google"], session3["user"])
            check("пароль при этом не потерян",
                  rows(server, "SELECT password_hash FROM users WHERE account_id=?",
                       (password_account,))[0]["password_hash"] is not None)

            # Аккаунт уже привязан к ДРУГОМУ Google: это не вход, а захват
            # чужой личности — второй Google-аккаунт в тот же профиль не
            # пускаем и ничего не перепривязываем.
            fake.identity = {"sub": "google-sub-attacker", "email": "pass@example.com",
                             "name": "Кто-то", "email_verified": True}
            attacker, attacker_jar = make_device()
            st, hd, _ = request(attacker, base, "/api/auth/google")
            st, hd, _ = request_url(attacker, location_of(hd))
            st, hd, _ = request_url(attacker, location_of(hd))
            check("второй Google в тот же аккаунт -> error=conflict",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") == "conflict",
                  fragment_of(location_of(hd)))
            check("конфликт не выдал сессию", cookie_value(attacker_jar, "ege_session") is None)
            check("конфликт ничего не привязал",
                  len(rows(server, "SELECT 1 FROM auth_identities WHERE subject='google-sub-attacker'")) == 0)

            section("6b. Смена почты Google меняет почту аккаунта")
            # Живой случай: аккаунт заведён на ivanovartem… по паролю, человек
            # отвязал Google и привязал другой адрес (kapel…) — почта аккаунта
            # осталась прежней, потому что писалась через COALESCE(email, ?),
            # то есть НИКОГДА не менялась. В привязке и в профиле были разные
            # почты.
            fake.identity = {"sub": "google-sub-newmail", "email": "newmail@example.com",
                             "name": "Новая почта", "email_verified": True}
            same, same_jar = make_device()
            st, _, claim2 = request(same, base, "/api/profile/claim", "POST",
                                    {"subject": "profile_math", "onboarded": True, "name": "Смена"})
            st, _, reg2 = request(same, base, "/api/auth/register", "POST",
                                  {"name": "Смена", "email": "oldmail@example.com",
                                   "password": "super-pass-1"})
            check("аккаунт со старой почтой готов", st == 200, (st, reg2))
            st, hd, _ = request(same, base, "/api/auth/google?intent=link")
            st, hd, _ = request_url(same, location_of(hd))
            st, hd, _ = request_url(same, location_of(hd))
            check("привязка нового Google прошла",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") is None,
                  fragment_of(location_of(hd)))
            st, _, session_s = request(same, base, "/api/auth/session")
            check("остались в ТОМ ЖЕ аккаунте (новый не создан)",
                  session_s["user"]["accountId"] == reg2["user"]["accountId"],
                  (session_s.get("user"), reg2["user"]["accountId"]))
            check("почта аккаунта стала почтой нового Google",
                  session_s["user"]["email"] == "newmail@example.com", session_s.get("user"))
            check("привязка записана с тем же адресом",
                  rows(server, "SELECT email FROM auth_identities WHERE subject='google-sub-newmail'")[0]["email"]
                  == "newmail@example.com")

            # Явная привязка НЕ должна пересаживать человека на чужой аккаунт.
            fake.identity = {"sub": "google-sub-stranger", "email": "pass@example.com",
                             "name": "Чужой", "email_verified": True}
            st, hd, _ = request(same, base, "/api/auth/google?intent=link")
            st, hd, _ = request_url(same, location_of(hd))
            st, hd, _ = request_url(same, location_of(hd))
            check("привязка чужого адреса -> conflict, а не вход в чужой аккаунт",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") == "conflict",
                  fragment_of(location_of(hd)))
            st, _, session_after = request(same, base, "/api/auth/session")
            check("остались в своём аккаунте",
                  session_after["user"]["accountId"] == reg2["user"]["accountId"],
                  session_after.get("user"))
            check("чужая личность не привязана",
                  len(rows(server, "SELECT 1 FROM auth_identities WHERE subject='google-sub-stranger'")) == 0)
            check("почта своего аккаунта не тронута",
                  session_after["user"]["email"] == "newmail@example.com", session_after.get("user"))

            section("6c. Новый аккаунт с входа идёт в онбординг, а не в пикер")
            # Живой цикл: вход через Google на странице входа ЗАВОДИТ новый
            # аккаунт, но сервер отправлял его на «выбери предмет» — тот же
            # экран, что у существующего аккаунта. Выбор предмета состоялся,
            # адрес оставался /subject, и пикер спрашивал снова, и снова.
            fake.identity = {"sub": "google-sub-newacc", "email": "newacc@example.com",
                             "name": "Новый", "email_verified": True}
            fresh_dev, fresh_jar = make_device()
            before_fresh = count_users(server)
            st, hd, _ = request(fresh_dev, base, "/api/auth/google")
            st, hd, _ = request_url(fresh_dev, location_of(hd))
            st, hd, _ = request_url(fresh_dev, location_of(hd))
            fragment = fragment_of(location_of(hd))
            check("новый аккаунт: сразу в приложение, без пикера выбора предмета",
                  fragment.startswith("/dashboard") and "fresh=1" in fragment, fragment)
            check("аккаунт действительно заведён", count_users(server) == before_fresh + 1,
                  count_users(server))
            st, _, fresh_boot = request(fresh_dev, base, "/api/bootstrap-lite")
            check("у нового аккаунта онбординга ещё нет — нужен онбординг",
                  fresh_boot["state"]["onboarded"] is False, fresh_boot["state"]["onboarded"])
            check("онбординг не пройден ни по одному предмету",
                  len(rows(server, "SELECT 1 FROM user_subjects WHERE user_id=(SELECT id FROM users WHERE email='newacc@example.com') AND onboarded=1")) == 0)

            # Существующий (онбордившийся) аккаунт — пикер выбора предмета, как
            # при входе по паролю: у человека уже есть прогресс по нескольким
            # предметам, молча открывать один из них нельзя.
            onboarder, ob_jar = make_device()
            st, _, cl = request(onboarder, base, "/api/profile/claim", "POST",
                                {"subject": "profile_math", "onboarded": True, "name": "Давний"})
            fake.identity = {"sub": "google-sub-old", "email": "old@example.com",
                             "name": "Давний", "email_verified": True}
            st, hd, _ = request(onboarder, base, "/api/auth/google")
            st, hd, _ = request_url(onboarder, location_of(hd))
            st, hd, _ = request_url(onboarder, location_of(hd))
            fragment = fragment_of(location_of(hd))
            check("существующий аккаунт по-прежнему получает выбор предмета",
                  fragment.startswith("/subject") and "fresh" not in fragment, fragment)

            section("7. Гость с прогрессом сохраняет профиль при входе")
            guest, guest_jar = make_device()
            st, _, claim = request(guest, base, "/api/profile/claim", "POST",
                                   {"subject": "profile_math", "onboarded": True, "name": "Гость Г"})
            guest_account = claim["accountId"]
            st, _, guest_boot = request(guest, base, "/api/bootstrap-lite")
            st, _, saved = request(guest, base, "/api/settings", "PATCH",
                                   {"subject": "profile_math",
                                    "expectedVersion": guest_boot["state"]["stateVersion"],
                                    "settings": {"onboarded": True, "name": "Гость Г"}})
            fake.identity = {"sub": "google-sub-3", "email": "guest@example.com",
                             "name": "Гость Г", "email_verified": True}
            st, hd, _ = request(guest, base, "/api/auth/google")
            st, hd, _ = request_url(guest, location_of(hd))
            st, hd, _ = request_url(guest, location_of(hd))
            check("гость вошёл через Google", cookie_value(guest_jar, "ege_session") is not None)
            st, _, session_g = request(guest, base, "/api/auth/session")
            check("accountId гостя сохранён", session_g["user"]["accountId"] == guest_account,
                  session_g["user"])
            check("имя гостя не перетёрто", rows(server, "SELECT name FROM users WHERE account_id=?",
                                                (guest_account,))[0]["name"] == "Гость Г")

            # ---------------------------------------------------------------
            section("8. Заблокированный аккаунт не получает сессию")
            conn = server.connect()
            try:
                blocked_id = conn.execute("SELECT id FROM users WHERE account_id=?",
                                          (password_account,)).fetchone()["id"]
                conn.execute("INSERT OR REPLACE INTO user_blocks(user_id, reason, created_at, blocked_until, blocked_by)"
                             " VALUES (?, 'тест', '2026-01-01T00:00:00+00:00', NULL, 1)", (blocked_id,))
                conn.commit()
            finally:
                conn.close()
            identities_before_block = len(rows(server, "SELECT 1 FROM auth_identities"))
            # Важно: именно тот Google-аккаунт, который привязан к
            # заблокированному (шаг 6 привязал google-sub-2 к парольному).
            fake.identity = {"sub": "google-sub-2", "email": "pass@example.com",
                             "name": "Кто-то", "email_verified": True}
            blocked, blocked_jar = make_device()
            st, hd, _ = request(blocked, base, "/api/auth/google")
            st, hd, _ = request_url(blocked, location_of(hd))
            st, hd, body = request_url(blocked, location_of(hd))
            check("блок -> редирект с error=blocked",
                  st == 302 and query_of_fragment(fragment_of(location_of(hd))).get("error") == "blocked",
                  (st, fragment_of(location_of(hd))))
            check("у заблокированного нет сессии", cookie_value(blocked_jar, "ege_session") is None)
            # Привязок столько, сколько было до блокировки: заблокированный
            # вход не должен ни привязываться, ни отвязываться.
            check("привязка заблокированного не тронута",
                  len(rows(server, "SELECT 1 FROM auth_identities")) == identities_before_block,
                  (identities_before_block, len(rows(server, "SELECT 1 FROM auth_identities"))))
            conn = server.connect()
            try:
                conn.execute("DELETE FROM user_blocks WHERE user_id=?", (blocked_id,))
                conn.commit()
            finally:
                conn.close()

            # ---------------------------------------------------------------
            section("9. Неподтверждённая почта и одноразовость кода")
            fake.identity = {"sub": "google-sub-4", "email": "unverified@example.com",
                             "name": "Кто-то", "email_verified": False}
            unv, unv_jar = make_device()
            st, hd, _ = request(unv, base, "/api/auth/google")
            st, hd, _ = request_url(unv, location_of(hd))
            st, hd, _ = request_url(unv, location_of(hd))
            check("email_verified=false -> error=identity",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") == "identity",
                  fragment_of(location_of(hd)))
            check("неподтверждённая почта не завела аккаунт",
                  count_users(server) == rows(server, "SELECT COUNT(*) c FROM users WHERE email IS NOT NULL")[0]["c"])
            check("нет сессии", cookie_value(unv_jar, "ege_session") is None)

            # Один и тот же код второй раз: настоящий провайдер отвечает
            # invalid_grant, и наш фейк делает то же.
            fake.identity = {"sub": "google-sub-5", "email": "replay@example.com",
                             "name": "Повтор", "email_verified": True}
            replay, replay_jar = make_device()
            st, hd, _ = request(replay, base, "/api/auth/google")
            st, hd, _ = request_url(replay, location_of(hd))
            callback = location_of(hd)
            st, hd, _ = request_url(replay, callback)
            check("первый обмен кода прошёл", st == 302 and query_of_fragment(
                fragment_of(location_of(hd))).get("error") is None, st)
            before = count_users(server)
            # Тот же адрес целиком: не проходит даже state — кука браузера уже
            # сгорела. Это защита сильнее, чем у провайдера, и она бесплатная.
            st, hd, _ = request_url(replay, callback)
            check("повтор того же callback отбит",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") == "state",
                  fragment_of(location_of(hd)))
            # А вот код, украденный у этого браузера и подсунутый СВОЕМУ
            # (у которого своё, валидное состояние), должен упереться в
            # одноразовость кода на стороне провайдера.
            thief, thief_jar = make_device()
            st, hd, _ = request(thief, base, "/api/auth/google")
            thief_state = urllib.parse.parse_qs(urllib.parse.urlparse(location_of(hd)).query)["state"][0]
            used_code = urllib.parse.parse_qs(urllib.parse.urlparse(callback).query)["code"][0]
            st, hd, _ = request(thief, base, f"/api/auth/google/callback?code={used_code}&state={thief_state}")
            check("украденный и уже использованный код отбит провайдером",
                  query_of_fragment(fragment_of(location_of(hd))).get("error") == "code",
                  fragment_of(location_of(hd)))
            check("повтор не завёл нового человека", count_users(server) == before, count_users(server))

            # ---------------------------------------------------------------
            section("10. CSRF-гейт на unlink")
            cross, cross_jar = make_device()
            # Без Origin клиент (curl/тест) проходит — это осознанное правило
            # проекта; проверяем именно чужой Origin.
            req = urllib.request.Request(base + "/api/auth/google/unlink",
                                         data=b"{}", method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("Origin", "https://evil.example")
            req.add_header("Sec-Fetch-Site", "cross-site")
            try:
                with cross.open(req, timeout=10) as response:
                    st = response.status
            except urllib.error.HTTPError as exc:
                st = exc.code
            check("cross-site POST -> 403", st == 403, st)

            # ---------------------------------------------------------------
            section("11. Отвязка: без пароля refused, с паролем — проходит")
            st, _, unlink = request(unv, base, "/api/auth/google/unlink", "POST", {})
            # Аккаунт не создан (почта не подтверждена) — гость без профиля.
            check("гость не может отвязывать", st == 401 and unlink.get("code") == "GUEST_PENDING",
                  (st, unlink))
            google_only, google_jar = make_device()
            fake.identity = {"sub": "google-sub-6", "email": "onlygoogle@example.com",
                             "name": "Только Google", "email_verified": True}
            st, hd, _ = request(google_only, base, "/api/auth/google")
            st, hd, _ = request_url(google_only, location_of(hd))
            st, hd, _ = request_url(google_only, location_of(hd))
            st, _, refused = request(google_only, base, "/api/auth/google/unlink", "POST", {})
            check("аккаунт без пароля: unlink -> 400 NO_PASSWORD",
                  st == 400 and refused.get("code") == "NO_PASSWORD", (st, refused))
            check("привязка осталась на месте",
                  len(rows(server, "SELECT 1 FROM auth_identities WHERE user_id = (SELECT id FROM users WHERE email='onlygoogle@example.com')")) == 1)
            # Аккаунт с паролем + Google отвязывается честно.
            st, _, unlinked = request(opener3, base, "/api/auth/google/unlink", "POST", {})
            check("unlink у аккаунта с паролем -> 200", st == 200 and unlinked.get("ok") is True, (st, unlinked))
            check("providers опустел", unlinked["user"]["providers"] == [], unlinked["user"])
            check("вход по паролю после отвязки работает",
                  request(opener3, base, "/api/auth/login", "POST",
                          {"email": "pass@example.com", "password": "super-pass-1"})[0] == 200)

            # ---------------------------------------------------------------
            section("12. Удаление аккаунта сносит привязку каскадом")
            conn = server.connect()
            try:
                before = conn.execute("SELECT COUNT(*) AS c FROM auth_identities").fetchone()["c"]
                target = conn.execute("SELECT id FROM users WHERE email='onlygoogle@example.com'").fetchone()["id"]
                conn.execute("DELETE FROM users WHERE id=?", (target,))
                conn.commit()
                after = conn.execute("SELECT COUNT(*) AS c FROM auth_identities").fetchone()["c"]
                check("каскад удалил строку привязки", after == before - 1, (before, after))
            finally:
                conn.close()

            # ---------------------------------------------------------------
            section("13. Сброс «весь прогресс» не рвёт вход")
            st, _, prog = request(guest, base, "/api/bootstrap-lite")
            version = prog["state"]["stateVersion"]
            st, _, ok = request(guest, base, "/api/progress", "PATCH",
                                {"subject": "profile_math", "expectedVersion": version,
                                 "progress": {"xp": {"n01_p1": 5}}})
            conn = server.connect()
            try:
                conn.execute("BEGIN")
                for table in ("user_progress", "user_hint_levels", "user_errors", "task_attempts",
                              "lesson_attempts", "lesson_step_errors", "lesson_error_history",
                              "lesson_sessions", "completed_lessons", "user_missions", "user_bosses",
                              "user_achievements", "activity_history", "forecast_history",
                              "daily_progress", "timeline", "diagnostics", "essay_submissions",
                              "essay_checks", "essay_check_history", "activity_events",
                              "user_xp_adjustments"):
                    conn.execute(f"DELETE FROM {table} WHERE user_id=(SELECT id FROM users WHERE account_id=?)",
                                 (guest_account,))
                conn.commit()
            finally:
                conn.close()
            st, _, session_g = request(guest, base, "/api/auth/session")
            check("после полного сброса вход через Google жив",
                  session_g.get("user", {}).get("accountId") == guest_account, session_g)

            print(f"\n{'ALL OK' if not failures else 'FAILURES: ' + str(failures)} — {checks} проверок")
            print("Google login: подпись state, привязка к браузеру, честный отказ вместо склейки, "
                  "блок, неподтверждённая почта, replay кода, CSRF и отвязка покрыты.")
            return 1 if failures else 0
        finally:
            httpd.shutdown()
            httpd.server_close()
            fake.stop()


if __name__ == "__main__":
    raise SystemExit(main())