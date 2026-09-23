#!/usr/bin/env python3
"""Регрессия: смена предмета не роняет авторизацию в профиле.

Баг: POST /api/subject не возвращал auth, а клиентский _applyBootstrap
безусловно заменял Store.auth на {registered: false} — профиль сразу после
смены предмета показывал «Войти или зарегистрироваться», хотя аккаунт
авторизован.

Сценарий теста:
1. авторизованный пользователь меняет предмет — ответ /api/subject обязан
   содержать auth.registered = True (профиль увидит аккаунт, не гостя);
2. быстрые повторные смены предмета туда-обратно сохраняют auth и
   приводят к предсказуемому current_subject;
3. «обновление страницы» (bootstrap без ?subject) сразу после смены
   возвращает новый предмет и авторизацию;
4. гость после смены предмета по-прежнему гость (auth не выдумывается).
"""
from __future__ import annotations

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


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_subject_auth_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def make_device():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def main():
    with tempfile.TemporaryDirectory(prefix="ege-subj-auth-") as tmp:
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
            opener, _jar = make_device()

            # Гость заходит и регистрируется — дальше все шаги от авторизованного.
            status, boot = request(opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, boot)
            account = boot["accountId"]
            status, reg = request(opener, base, "/api/auth/register", "POST", {
                "name": "Авторизованный", "email": "auth-user@example.com",
                "password": "password-auth-123",
            })
            assert status == 200, (status, reg)

            # 1. Авторизованный меняет предмет — auth обязан пережить смену.
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": "basic_math"})
            assert status == 200, (status, switched)
            assert switched["subject"] == "basic_math", switched["subject"]
            assert switched["accountId"] == account, (switched["accountId"], account)
            assert switched["auth"] == {"registered": True, "email": "auth-user@example.com"}, switched["auth"]

            # 2. Быстрые повторные смены туда-обратно: auth не теряется ни разу.
            for expected in ("profile_math", "basic_math", "profile_math"):
                status, rapid = request(opener, base, "/api/subject", "POST", {"subject": expected})
                assert status == 200, (status, rapid)
                assert rapid["subject"] == expected, rapid["subject"]
                assert rapid["auth"]["registered"] is True, rapid["auth"]
                assert rapid["auth"]["email"] == "auth-user@example.com", rapid["auth"]
                assert rapid["accountId"] == account, rapid["accountId"]

            # 3. «Обновление страницы» сразу после смены: bootstrap без ?subject
            #    возвращает последний предмет и ту же авторизацию.
            status, reloaded = request(opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, reloaded)
            assert reloaded["state"]["subject"] == "profile_math", reloaded["state"]["subject"]
            assert reloaded["catalog"]["subject"] == "profile_math", reloaded["catalog"]["subject"]
            assert reloaded["auth"] == {"registered": True, "email": "auth-user@example.com"}, reloaded["auth"]
            assert reloaded["accountId"] == account, reloaded["accountId"]

            # 4. Гость, меняющий предмет, остаётся гостем — auth не выдумывается.
            guest_opener, _ = make_device()
            status, guest_boot = request(guest_opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, guest_boot)
            status, guest_switch = request(guest_opener, base, "/api/subject", "POST", {"subject": "basic_math"})
            assert status == 200, (status, guest_switch)
            assert guest_switch["auth"] == {"registered": False, "email": None}, guest_switch["auth"]
            status, guest_reload = request(guest_opener, base, "/api/bootstrap-lite")
            assert guest_reload["auth"]["registered"] is False, guest_reload["auth"]
            assert guest_reload["state"]["subject"] == "basic_math", guest_reload["state"]["subject"]

            print("Subject-auth regression OK: смена предмета сохраняет авторизацию, гость остаётся гостем")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
