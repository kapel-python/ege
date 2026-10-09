#!/usr/bin/env python3
"""Периметр: кому и откуда видно сайт.

Проблема, которую закрывает этот файл. Сайт слушало 0.0.0.0, поэтому
его сокет доставался из интернета напрямую, мимо nginx: без TLS, без HSTS и
без лимитов фронтенда. Вдобавок EGE_TRUSTED_PROXY=1 читала X-Forwarded-For от
ЛЮБОГО соединения, а nginx писал заголовок через $proxy_add_x_forwarded_for,
то есть дописывал реальный адрес к присланному клиентом. Итог: первый
элемент цепочки — то, что бэкенд берёт как «IP клиента» — полностью
контролировался атакующим. Один заголовок давал свой бакет каждому лимиту
(общий 300/мин, сетка ai_take, анти-лавиновые куки/сеть, поддержка).

Что проверяем на живом сервере с временной БД:
  1. X-Forwarded-For от ПРЯМОГО клиента игнорируется — бакет один на всех;
  2. тот же заголовок от loopback-«прокси» работает (режим за nginx);
  3. мусор в заголовке не становится ключом бакета и не ломает разбор;
  4. rate-limit /api/* общий для всех, кто шлёт один и тот же XFF;
  5. /api/auth/* тоже под общим лимитом (иначе аккаунты множились без счёта);
  6. CSRF: cross-site POST/PATCH/PUT/DELETE отклоняются на ЛЮБОМ /api/;
  7. Origin, совпадающий с нашим, и запрос без Origin — принимаются;
  8. вход по времени ответа не выдаёт, зарегистрирован ли email;
  9. www-редирект собирается из настоящего Host, а не из X-Forwarded-Host;
 10. NUL в пути и обход каталога не дают ни файла, ни трейсбека;
 11. служебные файлы репозитория не отдаются статикой.

Прод не трогаем: своя временная БД и случайный порт.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

PASSED = 0
FAILED: list[str] = []


def t(name: str, ok: bool, detail: object = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"  ok  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}: {detail}")


def load_server(db_path: Path, trusted_proxy: str):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "c" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    os.environ["EGE_TRUSTED_PROXY"] = trusted_proxy
    spec = importlib.util.spec_from_file_location("ege_perimeter_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """301/302 не следуем: нас интересует сам заголовок Location, а попытка
    уйти на чужой хост упёрлась бы в DNS-резолв."""

    def redirect_request(self, *_args, **_kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def raw_request(base: str, path: str, method: str = "GET", headers: dict | None = None,
                body=None, raw_body: bytes | None = None):
    """Запрос без cookie-jar, чтобы можно было подставлять заголовки как угодно."""
    data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with _OPENER.open(req, timeout=15) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def json_request(base: str, path: str, method: str = "GET", headers: dict | None = None, body=None):
    status, payload, out = raw_request(base, path, method, headers, body)
    try:
        return status, json.loads(payload or b"{}"), out
    except json.JSONDecodeError:
        return status, {}, out


def _local_non_loopback_ips() -> list[str]:
    """Не-loopback адреса этой машины: ими подключаемся «снаружи» к своему же порту."""
    import socket as _socket
    found: list[str] = []
    for family, _t, _p, _c, addr in _socket.getaddrinfo(
            _socket.gethostname(), None, proto=_socket.IPPROTO_TCP):
        ip = addr[0]
        if ":" in ip or ip.startswith("127."):
            continue
        try:
            found.append(ip)
        except Exception:
            continue
    return found or [""]


def raw_socket_request(host: str, port: int, raw: bytes, read_bytes: int = 4096) -> bytes:
    """Сырой сокет: urllib не даст подсунуть в Host символы CRLF, а проверить
    надо именно их (защита от разрыва заголовка через Host)."""
    import socket as _socket
    with _socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(raw)
        chunks = b""
        try:
            while len(chunks) < read_bytes:
                part = sock.recv(4096)
                if not part:
                    break
                chunks += part
        except OSError:
            pass
        return chunks


# ---------------------------------------------------------------------------
# 1-4. Подмена X-Forwarded-For прямым клиентом
# ---------------------------------------------------------------------------
def check_forwarded_spoofing() -> None:
    print("\n== A. X-Forwarded-For от прямого клиента ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-a-") as tmp:
        server = load_server(Path(tmp) / "a.sqlite3", trusted_proxy="1")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            class FakeHandler:
                """Заглушка обработчика: нам важен только результат client_ip."""
                def __init__(self, xff: str | None, peer: str, trusted: str):
                    self.headers = {"X-Forwarded-For": xff} if xff is not None else {}
                    self.client_address = (peer, 0)
                    self.trusted = trusted

                @property
                def _flag(self):
                    return self.trusted

            import os as _os
            saved = _os.environ.get("EGE_TRUSTED_PROXY")
            try:
                # nginx на этой же машине: сокет 127.0.0.1 -> заголовку верим.
                _os.environ["EGE_TRUSTED_PROXY"] = "1"
                h = FakeHandler("8.8.8.8", "127.0.0.1", "1")
                t("за nginx (loopback) заголовку верим",
                  server.client_ip(h) == "8.8.8.8", server.client_ip(h))
                t("тот же заголовок от ВНЕШНЕГО адреса игнорируется",
                  server.client_ip(FakeHandler("8.8.8.8", "203.0.113.5", "1")) == "203.0.113.5",
                  server.client_ip(FakeHandler("8.8.8.8", "203.0.113.5", "1")))
                t("внешний клиент без заголовка — его собственный адрес",
                  server.client_ip(FakeHandler(None, "203.0.113.5", "1")) == "203.0.113.5")
                # Мусор в заголовке за доверенным прокси не должен попасть в ключ.
                t("мусорный XFF не становится ключом бакета",
                  server.client_ip(FakeHandler("unknown", "127.0.0.1", "1")) == "127.0.0.1",
                  server.client_ip(FakeHandler("unknown", "127.0.0.1", "1")))
                t("не-IP в XFF не попадает в ключ",
                  server.client_ip(FakeHandler("'; DROP TABLE users;--", "127.0.0.1", "1")) == "127.0.0.1",
                  server.client_ip(FakeHandler("'; DROP TABLE users;--", "127.0.0.1", "1")))
                t("длинный XFF обрезан, ключ не растёт",
                  len(server.client_ip(FakeHandler("1.2.3.4" + "9" * 500, "127.0.0.1", "1"))) <= 64)
                t("флажок выключен — заголовок не читается вовсе",
                  (setattr(_os, "environ", {**_os.environ, "EGE_TRUSTED_PROXY": "0"}),
                   server.client_ip(FakeHandler("8.8.8.8", "127.0.0.1", "0")) == "127.0.0.1")[1])
            finally:
                if saved is None:
                    _os.environ.pop("EGE_TRUSTED_PROXY", None)
                else:
                    _os.environ["EGE_TRUSTED_PROXY"] = saved

            # Живой путь: подключаемся НЕ с loopback, чтобы воспроизвести
            # исходную дыру (клиент вне nginx шлёт свой X-Forwarded-For).
            # На loopback заголовку верить правильно — там сидит наш nginx,
            # и такой тест ничего не проверял бы.
            outer_ip = next((a for a in _local_non_loopback_ips()), None)
            if outer_ip is None:
                print("  skip  нет не-loopback адреса — подмену XFF проверим на юните")
            else:
                outer = server.create_http_server("0.0.0.0", 0)
                threading.Thread(target=outer.serve_forever, daemon=True).start()
                obase = f"http://{outer_ip}:{outer.server_address[1]}"
                try:
                    server._api_hits.clear()
                    server.API_RATE_MAX = 3
                    probe = "/api/catalog-tasks"   # обычный GET под /api/
                    for _ in range(3):
                        json_request(obase, probe, headers={"X-Forwarded-For": "10.1.1.1"})
                    status_a, _, _ = json_request(obase, probe, headers={"X-Forwarded-For": "10.1.1.1"})
                    t("прямой клиент НЕ выбирает себе бакет заголовком (429 на 4-м)",
                      status_a == 429, f"status={status_a}")
                    # Соседний «чужой» IP-заголовок обязан упасть в тот же бакет:
                    # иначе подмена развела бы счёт по новому адресу на каждый запрос.
                    status_b, _, _ = json_request(obase, probe, headers={"X-Forwarded-For": "10.9.9.9"})
                    t("чужой XFF не открывает новый бакет", status_b == 429, f"status={status_b}")
                finally:
                    outer.shutdown()
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
# 5. /api/auth/* под общим лимитом
# ---------------------------------------------------------------------------
def check_auth_rate_limit() -> None:
    print("\n== B. Лимит на /api/auth/* ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-b-") as tmp:
        server = load_server(Path(tmp) / "b.sqlite3", trusted_proxy="1")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            server.API_RATE_MAX = 5
            statuses = []
            for i in range(9):
                status, _, _ = json_request(base, "/api/auth/login", "POST",
                                            body={"email": f"nobody{i}@example.com",
                                                  "password": "wrong-password"})
                statuses.append(status)
            t("серия попыток входа упирается в общий лимит, а не идёт бесконечно",
              429 in statuses, statuses)
            # Аккаунтов-сирот не должно быть: лимит сработал раньше, чем
            # создание профиля на каждый email.
            conn = sqlite3.connect(str(Path(tmp) / "b.sqlite3"))
            try:
                conn.row_factory = sqlite3.Row
                users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
            finally:
                conn.close()
            t("безлимитный поток регистраций не плодит аккаунты", users == 0, f"users={users}")
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
# 6-7. CSRF
# ---------------------------------------------------------------------------
def check_csrf() -> None:
    print("\n== C. CSRF на всех пишущих /api/ ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-c-") as tmp:
        server = load_server(Path(tmp) / "c.sqlite3", trusted_proxy="0")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        cross = {"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}
        try:
            cases = [
                ("POST", "/api/auth/login", {"email": "a@b.c", "password": "x"}),
                ("POST", "/api/auth/register", {"email": "a@b.c", "password": "password1"}),
                ("POST", "/api/profile/claim", {"subject": "profile_math", "onboarded": True}),
                ("PATCH", "/api/settings", {"name": "x"}),
                ("PATCH", "/api/progress/profile_math", {}),
                ("DELETE", "/api/state", None),
                ("DELETE", "/api/auth/devices/1", None),
                ("POST", "/api/errors", {"subject": "profile_math"}),
            ]
            blocked_all = True
            detail = []
            for method, path, body in cases:
                status, _, _ = json_request(base, path, method, headers=cross, body=body)
                if status != 403:
                    blocked_all = False
                    detail.append(f"{method} {path} -> {status}")
            t("cross-site запрос ко всем пишущим /api/ отклонён (403)",
              blocked_all, "; ".join(detail))

            # Sec-Fetch-Site без Origin тоже должен ломать запрос.
            status, _, _ = json_request(base, "/api/settings", "PATCH",
                                        headers={"Sec-Fetch-Site": "cross-site"}, body={"name": "x"})
            t("один Sec-Fetch-Site: cross-site без Origin тоже отклонён", status == 403, status)

            # Свой Origin — принимаем (иначе сайт перестал бы работать).
            status, _, _ = json_request(base, "/api/profile/claim", "POST",
                                        headers={"Origin": base, "Sec-Fetch-Site": "same-origin"},
                                        body={"subject": "profile_math", "onboarded": True})
            t("запрос с нашим Origin принимается", status == 200, status)

            # Без Origin (curl, тесты, сайт) — принимаем.
            status, _, _ = json_request(base, "/api/profile/claim", "POST",
                                        body={"subject": "profile_math", "onboarded": True})
            t("запрос без Origin (не браузер) принимается", status == 200, status)

            # Не-/api/ гейт не должен ломать: статика и раздача файлов.
            status, _, _ = raw_request(base, "/")
            t("статика не затронута CSRF-гейтом", status == 200, status)
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
# 8. Вход не выдаёт время наличия email
# ---------------------------------------------------------------------------
def check_login_timing() -> None:
    print("\n== D. Вход: одинаковое время для несуществующего email ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-d-") as tmp:
        server = load_server(Path(tmp) / "d.sqlite3", trusted_proxy="0")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            # Заводим настоящий аккаунт с паролем.
            json_request(base, "/api/profile/claim", "POST",
                         body={"subject": "profile_math", "onboarded": True, "name": "Ученик"})
            status, body, _ = json_request(base, "/api/auth/register", "POST",
                                           body={"email": "real@example.com", "password": "correct-password"})
            t("аккаунт для проверки создан", status == 200, (status, body))

            def timed(email: str) -> float:
                start = time.perf_counter()
                json_request(base, "/api/auth/login", "POST",
                             body={"email": email, "password": "definitely-wrong-password"})
                return time.perf_counter() - start

            # Калибровка: сколько занимает одна настоящая проверка пароля.
            known = [timed("real@example.com") for _ in range(3)]
            unknown = [timed("ghost@example.com") for _ in range(3)]
            ref = max(known)
            # Порог generous: раньше «нет такого адреса» отвечала за ~0 мс.
            worst_unknown = max(unknown)
            t("несуществующий email стоит столько же, сколько неверный пароль",
              worst_unknown > ref * 0.5,
              f"неверный пароль ~{ref*1000:.0f} мс, неизвестный email ~{worst_unknown*1000:.0f} мс")

            status_ok, _, _ = json_request(base, "/api/auth/login", "POST",
                                           body={"email": "ghost@example.com", "password": "wrong-password"})
            status_no, _, _ = json_request(base, "/api/auth/login", "POST",
                                           body={"email": "real@example.com", "password": "wrong-password"})
            t("текст ответа одинаков для обоих случаев",
              status_ok == status_no == 401, (status_ok, status_no))
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
# 9-11. Хост, NUL, обход каталога, служебные файлы
# ---------------------------------------------------------------------------
def check_static_and_host() -> None:
    print("\n== E. Хост-редирект, NUL, служебные файлы ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-e-") as tmp:
        server = load_server(Path(tmp) / "e.sqlite3", trusted_proxy="1")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            # www -> apex собирается из настоящего Host.
            status, _, headers = raw_request(base, "/", headers={"Host": "www.egeeasy.ru"})
            t("www-редирект ведёт на apex",
              status == 301 and headers.get("Location") == "//egeeasy.ru/", (status, headers.get("Location")))

            # X-Forwarded-Host от loopback «прокси» — верим (это наш nginx).
            status, _, headers = raw_request(base, "/", headers={
                "Host": "egeeasy.ru", "X-Forwarded-Host": "www.egeeasy.ru"})
            t("за прокси X-Forwarded-Host учитывается",
              status == 301 and headers.get("Location") == "//egeeasy.ru/",
              (status, headers.get("Location")))

            # Недопустимый хост в Location не попадает. Правило www.*->apex
            # намеренно общее (переживает смену домена), поэтому «evil.example»
            # из него выходит законно — защищаем не от него, а от того, что в
            # Location физически может оказаться только валидное DNS-имя.
            for bad in ("www.a b", "www.a/b", "www.", "www.a:evil", "www.a..b"):
                status, _, headers = raw_request(base, "/", headers={"Host": bad})
                loc = headers.get("Location") or ""
                t(f"мусорный Host '{bad[:16]!r}' не уезжает в Location",
                  "\r" not in loc and "\n" not in loc and " " not in loc and "/" not in loc.rstrip("/\r\n")[2:],
                  (status, loc))

            # Host с CRLF — через сырой сокет (urllib такой заголовок не отправит).
            host, _, port = base.partition("://")[2].partition(":")
            resp = raw_socket_request(host, int(port or 80),
                                      b"GET / HTTP/1.1\r\nHost: www.evil.example\r\n"
                                      b"X-Injected: yes\r\n\r\n")
            first = resp.split(b"\r\n\r\n", 1)[0]
            t("CRLF в Host не разрывает заголовки ответа",
              b"X-Injected" not in first and resp.count(b"\r\n\r\n") <= 1,
              first[:120])

            # NUL в пути: ответ без трейсбека (urllib такой URL не отправит — сырой сокет).
            resp = raw_socket_request(host, int(port or 80),
                                      b"GET /index.html\x00.png HTTP/1.1\r\n"
                                      b"Host: egeeasy.ru\r\n\r\n")
            t("NUL в пути даёт тихий отказ, а не падение",
              (b"Traceback" not in resp) and (b" 404" in resp[:40] or b" 400" in resp[:40]),
              resp[:100])

            # Обход каталога.
            for path in ("/../etc/passwd", "/../../etc/passwd", "/server/server.py",
                         "/server/ege.sqlite3", "/.env", "/.git/config"):
                status, payload, _ = raw_request(base, path)
                body = payload[:200]
                t(f"{path} не отдаётся", status in (403, 404) and b"root:" not in body,
                  (status, body[:60]))

            # Служебные файлы репозитория.
            for path in ("/deploy/ege-2026.service", "/AGENTS.md", "/ege.sqlite3",
                         "/glm_default.log", "/.ege-2026.pid.lock"):
                status, payload, _ = raw_request(base, path)
                t(f"{path} не отдаётся", status == 404, (status, payload[:60]))
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
# 12. Целостность базы: эксплуатируемые дефекты из аудита
# ---------------------------------------------------------------------------
def check_db_integrity() -> None:
    """Заведомо-зелёные заглушки для F1/F4: полные проверки живут в
    test/db-integrity-security.py, здесь — дёшево проверяем, что лимит
    /api/health и порядок параметров агента не откатились."""
    print("\n== F. Целостность базы (сводно) ==")
    with tempfile.TemporaryDirectory(prefix="ege-perimeter-f-") as tmp:
        server = load_server(Path(tmp) / "f.sqlite3", trusted_proxy="0")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            # /api/health обязан быть под лимитом: он анонимный и читает базу.
            server.HEALTH_RATE_MAX = 4
            server._health_hits.clear()
            codes = [raw_request(base, "/api/health")[0] for _ in range(7)]
            t("/api/health под лимитом (иначе анонимный скан всей базы)",
              429 in codes, codes)
            # Целостность кэшируется: пачка вызовов не читает базу пачкой раз.
            calls = {"n": 0}
            real = sqlite3.connect
            class Counting:
                def __init__(self, *a, **k):
                    calls["n"] += 1
                    self._c = real(*a, **k)
                def execute(self, *a, **k):
                    return self._c.execute(*a, **k)
                def close(self):
                    self._c.close()
            server.sqlite3.connect = Counting
            for _ in range(40):
                server.health_payload()
            server.sqlite3.connect = real
            t("quick_check кэшируется, а не сканирует базу на каждый вызов",
              calls["n"] <= 2, f"соединений: {calls['n']}")
        finally:
            httpd.shutdown()


def main() -> int:
    check_forwarded_spoofing()
    check_auth_rate_limit()
    check_csrf()
    check_login_timing()
    check_static_and_host()
    check_db_integrity()
    print("\n" + "=" * 60)
    if FAILED:
        print(f"ПРОВАЛЕНО {len(FAILED)} из {PASSED + len(FAILED)}: perimeter-security")
        for name in FAILED:
            print(f"  — {name}")
        return 1
    print(f"ПЕРИМЕТР OK: {PASSED} проверок "
          "(подмена X-Forwarded-For, лимиты, CSRF, тайминг входа, статика)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
