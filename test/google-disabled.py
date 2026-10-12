#!/usr/bin/env python3
"""Рубильник EGE_GOOGLE_LOGIN_DISABLED: иностранный сервис входа выключен.

Покрывает на живом сервере с temp-БД (без внешних ключей и сети):
  1. с флагом oauth_enabled() — False даже при настроенном провайдере
     (модуль подменён стабом с is_configured()=True);
  2. с флагом GET /api/auth/google — 503 OAUTH_UNCONFIGURED, редиректа
     на accounts.google.com нет;
  3. с флагом bootstrap несёт googleEnabled=false (кнопки входа,
     регистрации и привязки не рисуются);
  4. без флага при настроенном провайдере oauth_enabled() — True
     (поведение как раньше, регресса нет).
"""
from __future__ import annotations

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


class _FakeOAuth:
    def is_configured(self):
        return True


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ.pop("EGE_GOOGLE_LOGIN_DISABLED", None)
    spec = importlib.util.spec_from_file_location("ege_google_disabled", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def get(base, path):
    req = urllib.request.Request(base + path, method="GET")
    try:
        with urllib.request.build_opener().open(req, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def main():
    fails = []

    def check(name, cond, extra=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else " :: " + extra))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="ege-google-disabled-") as tmp:
        server = load_server(Path(tmp) / "t.sqlite3")
        real_oauth = server._OAUTH
        server._OAUTH = _FakeOAuth()
        try:
            httpd = server.create_http_server("127.0.0.1", 0)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            try:
                check("без флага при ключах вход включён",
                      server.oauth_enabled() is True)

                os.environ["EGE_GOOGLE_LOGIN_DISABLED"] = "1"
                try:
                    check("с флагом вход выключен",
                          server.oauth_enabled() is False)
                    st, headers, body = get(base, "/api/auth/google")
                    payload = json.loads(body or b"{}")
                    check("с флагом старт — 503 без редиректа на Google",
                          st == 503 and payload.get("code") == "OAUTH_UNCONFIGURED"
                          and "accounts.google.com" not in (headers.get("Location") or ""),
                          f"{st} {headers.get('Location')}")
                    st, _, body = get(base, "/api/bootstrap?subject=profile_math")
                    try:
                        boot = json.loads(body or b"{}")
                    except json.JSONDecodeError:
                        boot = {}
                    auth = (boot.get("auth") or {})
                    check("с флагом bootstrap googleEnabled=false",
                          auth.get("googleEnabled") is False, str(auth.get("googleEnabled")))
                finally:
                    os.environ.pop("EGE_GOOGLE_LOGIN_DISABLED", None)
                check("после снятия флага вход снова включён",
                      server.oauth_enabled() is True)
            finally:
                httpd.shutdown()
        finally:
            server._OAUTH = real_oauth

    print("GOOGLE-DISABLED: " + ("ALL OK" if not fails else f"{len(fails)} FAIL"))
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
