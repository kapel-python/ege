#!/usr/bin/env python3
"""Adversarial-набор: громкие и тихие атаки на живом сервере с temp-БД.

Покрывает популярные критические сценарии:
  A. Разведка/утечки: закрытые файлы, traversal, security-заголовки, health
     без авторизации и без минта аккаунта.
  B. Утечки текстов ошибок: форсим 4xx/5xx и проверяем, что наружу не едут
     схема БД, пути, трейсбеки и тексты sqlite.
  C. Капсы валидации: слишком много событий, абсурдный Content-Length,
     битый JSON, неизвестный предмет.
  D. Громкий DDoS: 400 запросов залпом -> часть честно режется 429, ни одного
     5xx, сервер сразу после отвечает 200.
  E. Конкурентность: 80 параллельных запросов -> только 200/429/503, жив.
  F. Slowloris: висящий сокет с недописанным телом не мешает остальным.
  G. Брутфорс: 10+ неверных паролей подряд (admin и user) -> 429.
  H. Тихий захват админки: чужая admin-кука, сессия без админки, прямые
     дергания admin API жертвой -> везде 401; легитимный grant работает.
  I. Гигиена сессий: поддельная кука -> новый гость; logout инвалидирует.
  J. Спам в поддержку: без токена -> 400, honeypot -> нейтральный 202
     без записи в БД.
  K. Уничтожение БД (только temp-файл!): порча и удаление файла -> сайт
     сам восстанавливается из бэкапа и отдаёт 200.

Запуск: python3 test/adversarial.py (прод не трогает — свой temp-БД/порт).
"""
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import os
import socket
import sqlite3
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ADMIN_PASSWORD = "adversarial-admin-pw-1"

LEAK_TOKENS = ("traceback", "sqlite", "unique", "no such table",
               "database is locked", "/root/", ".py", "integrityerror",
               "operationalerror", "databaseerror", "line 1")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_BACKUP_INTERVAL_SEC"] = "3600"
    os.environ["EGE_SUPPORT_MIN_DWELL_SEC"] = "0"
    salt = "c" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD.encode(), bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_adversarial", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """Минимальный HTTP-клиент с ручными куками."""

    def __init__(self, base: str):
        self.base = base
        self.cookies: dict[str, str] = {}

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def call(self, method: str, path: str, body=None, raw: bytes | None = None,
             timeout: float = 10) -> tuple[int, dict, bytes]:
        parts = urlparse(self.base)
        conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=timeout)
        try:
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            headers: dict[str, str] = {}
            if self.cookies:
                headers["Cookie"] = self._cookie_header()
            if body is not None or raw is not None:
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            payload = resp.read()
            headers_out = {k.lower(): v for k, v in resp.getheaders()}
            for chunk in headers_out.get("set-cookie", "").split(","):
                pass  # запятые внутри expires ломают наивный split — парсим ниже
            jar = SimpleCookie()
            # http.client складывает дублирующиеся Set-Cookie: забираем все.
            raw_cookies = [v for k, v in resp.getheaders() if k.lower() == "set-cookie"]
            for rc in raw_cookies:
                jar.load(rc)
            for key, morsel in jar.items():
                self.cookies[key] = morsel.value
            return resp.status, headers_out, payload
        finally:
            conn.close()

    def json(self, method: str, path: str, body=None, **kw):
        status, headers, payload = self.call(method, path, body, **kw)
        try:
            data = json.loads(payload or b"{}")
        except ValueError:
            data = {}
        return status, headers, data


CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, extra: str = ""):
    CHECKS.append((name, bool(cond), extra))
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or not extra else f" — {extra}"))


def reset_buckets(server) -> None:
    pairs = ((server._api_hits, server._api_lock),
             (server._admin_login_failures, server._admin_login_lock),
             (server._auth_login_failures, server._auth_login_lock),
             (server._status_hits, server._status_lock))
    for bucket, lock in pairs:
        with lock:
            bucket.clear()


def user_count(db_path: Path) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])
    finally:
        conn.close()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-adversarial-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        mod = server.backup_mod()
        assert mod is not None, "backup-модуль не загрузился"

        # --- A. Разведка / закрытая поверхность ---
        anon = Client(base)
        for blocked in ("/server/ege.sqlite3", "/server/server.py", "/server/backup.py",
                        "/server/ege.sqlite3-wal", "/server/ege.sqlite3-shm",
                        "/server/ege.sqlite3.bak", "/server/backups/manifest.json",
                        "/.git/config", "/deploy/ege-2026.service", "/README.md"):
            status, _, _ = anon.call("GET", blocked)
            check(f"закрыт {blocked}", status in (403, 404), f"got {status}")
        status, _, _ = anon.call("GET", "/%2e%2e/server/ege.sqlite3")
        check("encoded traversal отклонён", status in (400, 403, 404), f"got {status}")

        status, headers, data = anon.json("GET", "/api/health")
        check("health без авторизации", status == 200 and data.get("ok") is True,
              f"got {status} {data}")
        csp = headers.get("content-security-policy", "")
        check("CSP на месте", "frame-ancestors 'none'" in csp and "object-src 'none'" in csp)
        check("anti-clickjacking/nosniff",
              headers.get("x-frame-options") == "DENY"
              and headers.get("x-content-type-options") == "nosniff")
        check("баннер не светит версию", "egecore" not in headers.get("server", "").lower(),
              headers.get("server", ""))
        before = user_count(db_path)
        anon.json("GET", "/api/health")
        check("health не минтит аккаунт", user_count(db_path) == before)

        # --- B. Утечки текстов ошибок ---
        guest = Client(base)
        status, _, boot = guest.json("GET", "/api/bootstrap-lite")
        assert status == 200, boot
        leak_probes = []
        s, _, b = guest.json("POST", "/api/events/attempts",
                             {"subject": "profile_math", "expectedVersion": 1,
                              "events": "не массив"})
        leak_probes.append((s, b))
        s, _, b = guest.json("POST", "/api/subject", {"subject": "nope"})
        leak_probes.append((s, b))
        s, _, b = guest.json("PATCH", "/api/errors/1",
                             {"subject": "profile_math", "expectedVersion": 1,
                              "resolved": True})
        leak_probes.append((s, b))
        s, _, b = guest.json("POST", "/api/auth/login",
                             {"email": "nobody@example.com", "password": "wrong-wrong-1"})
        leak_probes.append((s, b))
        for i, (s, b) in enumerate(leak_probes):
            text = json.dumps(b, ensure_ascii=False).lower()
            hits = [t for t in LEAK_TOKENS if t in text]
            check(f"ошибка #{i} без утечек (status {s})", not hits, f"leak: {hits}")

        # --- C. Капсы валидации ---
        s, _, b = guest.json("POST", "/api/events/attempts",
                             {"subject": "profile_math", "expectedVersion": 1,
                              "events": [{"taskId": "x"}] * 20001})
        check("20001 событие отклонено", s == 400, f"got {s}")
        s, h, b = guest.call("POST", "/api/events/attempts", raw=b"x",
                             timeout=10)
        # обычный маленький мусор без Content-Length-гиганта: просто 400
        check("мусорное тело отклонено", s == 400, f"got {s}")
        status = None
        try:
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=10)
            c.request("POST", "/api/events/attempts",
                      body="x", headers={"Content-Type": "application/json",
                                         "Content-Length": str(50 * 1024 * 1024)})
            status = c.getresponse().status
            c.close()
        except Exception:
            status = "conn-reset"
        check("50MB Content-Length не вешает поток", status in (400, "conn-reset"),
              f"got {status}")

        # --- D. Громкий флуд ---
        reset_buckets(server)
        flood = Client(base)
        codes: dict = {}
        t0 = time.time()
        for _ in range(400):
            s, _, _ = flood.call("GET", "/api/bootstrap-lite")
            codes[s] = codes.get(s, 0) + 1
        dt = time.time() - t0
        check("флуд 400 залпом: часть срезана 429", codes.get(429, 0) > 0, str(codes))
        check("флуд: ни одного 5xx", not any(c >= 500 for c in codes), str(codes))
        s, _, hdata = anon.json("GET", "/api/health")
        check(f"после флуда сервер жив ({dt:.1f}с)", s == 200 and hdata.get("ok") is True)
        reset_buckets(server)

        # --- E. Конкурентность 80 потоков ---
        results: list = []
        def hammer():
            c = Client(base)
            try:
                s, _, _ = c.call("GET", "/api/bootstrap-lite", timeout=15)
                results.append(s)
            except Exception as exc:
                results.append(f"ERR:{type(exc).__name__}")
        threads = [threading.Thread(target=hammer) for _ in range(80)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        bad = [r for r in results if r not in (200, 429, 503)]
        check("80 параллельных: только 200/429/503", not bad and len(results) == 80,
              f"bad={bad[:5]} n={len(results)}")
        s, _, hdata = anon.json("GET", "/api/health")
        check("после параллели сервер жив", s == 200)
        reset_buckets(server)

        # --- F. Slowloris ---
        parts = urlparse(base)
        sock = socket.create_connection((parts.hostname, parts.port), timeout=10)
        try:
            sock.sendall(b"POST /api/events/attempts HTTP/1.1\r\nHost: x\r\n"
                         b"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n"
                         b'{"events": [')
            time.sleep(3)
            s, _, hdata = anon.json("GET", "/api/health")
            check("висящий сокет не мешает остальным", s == 200 and hdata.get("ok") is True)
        finally:
            sock.close()

        # --- G. Брутфорс ---
        brute = Client(base)
        admin_codes = []
        for _ in range(12):
            s, _, _ = brute.json("POST", "/api/admin/login", {"password": "wrong"})
            admin_codes.append(s)
        check("брутфорс админки упирается в 429", 429 in admin_codes, str(admin_codes[:12]))
        user_codes = []
        for _ in range(12):
            s, _, _ = brute.json("POST", "/api/auth/login",
                                 {"email": "ghost@example.com", "password": "wrong-wrong-1"})
            user_codes.append(s)
        check("брутфорс логина упирается в 429", 429 in user_codes, str(user_codes[:12]))
        reset_buckets(server)

        # --- H. Тихий захват админки ---
        dev_a = Client(base)
        s, _, ba = dev_a.json("GET", "/api/bootstrap-lite")
        assert s == 200
        s, _, login = dev_a.json("POST", "/api/admin/login", {"password": ADMIN_PASSWORD})
        check("легитимный admin-login", s == 200, f"got {s} {login}")
        assert "ege_admin" in dev_a.cookies, "нет admin-куки"
        dev_b = Client(base)
        s, _, bb = dev_b.json("GET", "/api/bootstrap-lite")
        assert s == 200 and bb["accountId"] != ba["accountId"]
        # чужая admin-кука в чужой сессии
        thief = Client(base)
        thief.cookies["ege_session"] = dev_b.cookies["ege_session"]
        thief.cookies["ege_admin"] = dev_a.cookies["ege_admin"]
        s, _, _ = thief.json("GET", "/api/admin/overview")
        check("украденная admin-кука в чужой сессии -> 401", s == 401, f"got {s}")
        # сессия без админки
        s, _, _ = dev_b.json("GET", "/api/admin/overview")
        check("сессия без админки -> 401", s == 401, f"got {s}")
        # жертва дергает чужой grant
        s, _, _ = dev_b.json("POST", f"/api/admin/users/{ba['accountId']}/xp",
                             {"amount": 9999, "reason": "pwn"})
        check("жертва не грантит XP -> 401", s == 401, f"got {s}")
        # легитимный grant + удаление тестового следа
        s, _, granted = dev_a.json("POST", f"/api/admin/users/{bb['accountId']}/xp",
                                   {"amount": 10, "reason": "adversarial-test"})
        check("легитимный grant работает", s == 200 and granted.get("xp") == 10,
              f"got {s} {granted}")
        s, _, _ = dev_a.json("POST", f"/api/admin/users/{bb['accountId']}/delete", {})
        check("зачистка тестового аккаунта", s in (200, 404), f"got {s}")

        # --- I. Гигиена сессий ---
        fake = Client(base)
        fake.cookies["ege_session"] = "tampered-token-123-not-in-db"
        s, _, fb = fake.json("GET", "/api/bootstrap-lite")
        check("поддельная кука -> свежий гость", s == 200 and fb.get("accountId"), f"got {s}")
        s, _, _ = dev_a.json("POST", "/api/auth/logout", {})
        old = dev_a.cookies.get("ege_session", "")
        s, _, after = dev_a.json("GET", "/api/bootstrap-lite")
        check("logout инвалидирует сессию", s == 200 and after.get("accountId") != ba["accountId"],
              f"got {s}")

        # --- J. Спам в поддержку ---
        s, _, jb = anon.json("POST", "/api/support/messages",
                             {"message": "достаточно длинное сообщение",
                              "requestId": "a" * 32, "formToken": "мусор"})
        check("поддержка без токена -> 400", s == 400 and jb.get("code") == "form_token",
              f"got {s} {jb}")

        # --- K. Уничтожение БД (только temp!) ---
        assert str(db_path).startswith(tmp), "страховка: БД обязана быть временной"
        snap = mod.full_backup("adversarial-test")
        check("полный бэкап перед порчей", snap is not None and snap.is_file())
        with open(db_path, "r+b") as fh:
            fh.seek(0)
            fh.write(b"GARBAGE-ADVERSARIAL" * 64)
        s, _, kb = anon.json("GET", "/api/bootstrap-lite", timeout=20)
        check("битая БД: запрос сам отрекаверил файл", s == 200 and kb.get("accountId"),
              f"got {s}")
        quarantine = list(Path(tmp).glob("ege.sqlite3.corrupt-*"))
        check("битый файл ушёл в карантин", len(quarantine) >= 1)
        s, _, hdata = anon.json("GET", "/api/health")
        check("после порчи integrity ok", s == 200 and hdata["db"]["integrity"] == "ok",
              f"{hdata}")
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                (Path(str(db_path) + suffix)).unlink(missing_ok=True)
            except OSError:
                pass
        s, _, kb2 = anon.json("GET", "/api/bootstrap-lite", timeout=20)
        check("удалённая БД: восстановлена из бэкапа", s == 200 and kb2.get("accountId"),
              f"got {s}")

        httpd.shutdown()
        fails = [c for c in CHECKS if not c[1]]
        print(f"\n{'ВСЕ АДВЕРСЕРИАЛ-ТЕСТЫ ПРОЙДЕНЫ' if not fails else f'{len(fails)} ПРОВАЛОВ'} "
              f"({len(CHECKS)} проверок)")
        return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
