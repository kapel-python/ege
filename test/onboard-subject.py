#!/usr/bin/env python3
"""Регрессия: регистрация на втором предмете (basic_math) не теряется.

Сценарий из жизни (аккаунт 0498k9): пользователь с историей в профильной
математике создаёт аккаунт в базовой математике. Профиль имеет версию 144,
строка нового предмета — версию 1; если клиент штампует снапшот версией
старого предмета, сервер отвечает 409 и экран регистрации возвращается.

Тест проверяет оба конца контракта:
1. снапшот предмета с ЧУЖОЙ версией отклоняется (409) — OCC жива;
2. регистрация с СВОЕЙ версией сохраняется целиком (onboarded/имя/уровень);
3. у предмета без шкалы целей ориентир необязателен и нормализуется в null,
   а не валит всю настройку 400-й ошибкой.
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


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_onboard_subject", SERVER_PATH)
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


def main():
    with tempfile.TemporaryDirectory(prefix="ege-onboard-") as tmp:
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
            import http.cookiejar
            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

            status, boot = request(opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, boot)
            profile_version = boot["state"]["stateVersion"]
            assert boot["state"]["subject"] == "profile_math", boot["state"]["subject"]

            # История в профиле: версия уходит вперёд, как у реального аккаунта.
            status, seeded = request(opener, base, "/api/events/timeline", "POST", {
                "subject": "profile_math", "expectedVersion": profile_version,
                "events": [{"ts": 1700000000000, "text": "Профиль с историей"}],
            })
            assert status == 200, (status, seeded)
            profile_version = seeded["stateVersion"]

            # Переключение на базовую математику — как POST /api/subject в клиенте.
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": "basic_math"})
            assert status == 200, (status, switched)
            own_version = switched["state"]["stateVersion"]
            assert own_version == 1, own_version
            assert switched["state"]["stateVersion"] != profile_version, "версии предметов обязаны быть своими"

            # 1) Чужая версия (профильная) — обязана отклоняться: OCC не ослаблена.
            status, conflict = request(opener, base, "/api/settings", "PATCH", {
                "subject": "basic_math", "expectedVersion": profile_version,
                "settings": {"onboarded": True, "name": "Артём", "selfLevel": "base", "goal": "g60"},
            })
            assert status == 409, (status, conflict)
            assert conflict.get("currentVersion") == own_version, conflict

            # 2) Своя версия предмета — регистрация сохраняется целиком.
            status, saved = request(opener, base, "/api/settings", "PATCH", {
                "subject": "basic_math", "expectedVersion": own_version,
                "settings": {"onboarded": True, "name": "Артём", "selfLevel": "base", "goal": "g60"},
            })
            assert status == 200, (status, saved)
            assert saved["settings"]["onboarded"] is True, saved
            assert saved["settings"]["name"] == "Артём", saved
            assert saved["settings"]["selfLevel"] == "base", saved
            # 3) У базы нет шкалы целей: ориентир необязателен и не валит запись.
            assert saved["settings"]["goal"] is None, saved

            status, after = request(opener, base, "/api/bootstrap")
            assert status == 200, (status, after)
            state = after["state"]
            assert state["subject"] == "basic_math", state["subject"]
            assert state["onboarded"] is True, state
            assert state["name"] == "Артём", state
            assert state["selfLevel"] == "base", state

            # Профильный предмет не пострадал от регистрации в базе.
            status, profile = request(opener, base, "/api/bootstrap?subject=profile_math")
            assert status == 200, (status, profile)
            assert "Профиль с историей" in [item["text"] for item in profile["state"]["timeline"]], profile["state"]["timeline"]

            print("Onboarding-subject regression OK: регистрация во втором предмете сохраняется, OCC не ослаблена")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()