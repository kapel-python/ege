#!/usr/bin/env python3
"""Регрессия: блокировка аккаунта из админ-панели (POST .../block, .../unblock).

Исторический баг, который закрывает этот файл: пока сервер не перезапустили с
новым route, кнопка «Заблокировать» уже была в свежем js/admin.js, а backend на
POST /api/admin/users/<ref>/block ещё не знал про действие. Ветка молча
проваливалась в общий 404 `{"error": "Not found"}` в конце do_POST — тот самый
недиагностируемый «Not found», который видели в админке.

Контракт:
 1. каждое действие, которое вызывает js/admin.js, маршрутизируется backend'ом
    (статическая сверка UI -> список действий в server.py);
 2. неизвестное действие/лишний сегмент пути -> явный 404 админ-панели, а НЕ
    общий «Not found»; гостю и обычному пользователю -> 401 на всё это;
 3. block: 200 + точный payload, срок из duration, permanent = null, self-block
    запрещён, неизвестный duration -> 400, неизвестный ref -> 404 «Пользователь
    не найден» (и никакой строки в user_blocks);
 4. enforcement: заблокированный пользователь получает 403 + code
    ACCOUNT_BLOCKED на аутентифицированных endpoint'ах, админ-API остаётся
    закрытым для него (401), гостю/чужим куками блок не выдаётся;
 5. ленивое истечение: просроченная строка считается отсутствующей и удаляется;
 6. unblock: 200 + wasBlocked (true затем false), доступ возвращается, аудит
    block-user/unblock-user записан.

Живой сервер на temp-БД, прод не трогается.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import importlib.util
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ADMIN_JS = ROOT / "js" / "admin.js"
ADMIN_PASSWORD = b"test-admin-password"

# Общий 404 в конце do_POST: ответ, который нельзя отличить от «route не
# совпал». Раньше именно он приходил вместо ответа ветки /api/admin/users/.
GENERIC_NOT_FOUND = {"error": "Not found"}


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "d" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_admin_block_test", SERVER_PATH)
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


def make_device():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def check_ui_actions_are_routed():
    """Каждое действие из панели должно существовать в маршрутизации backend'а.

    Именно это расхождение («кнопка есть, action ещё нет») и давало общий
    «Not found»: статику сервер отдаёт свежей, Python — только после рестарта.
    """
    ui = ADMIN_JS.read_text(encoding="utf-8")
    server_src = SERVER_PATH.read_text(encoding="utf-8")
    ui_actions = set(re.findall(r"/api/admin/users/\$\{encodeURIComponent\(ref\)\}/([a-zA-Z]+)", ui))
    assert ui_actions, "не нашли ни одного admin-действия в js/admin.js"
    post_route = re.search(
        r'if path\.startswith\("/api/admin/users/"\):.*?parts\[5\] (?:not )?in \(([^)]*)\)',
        server_src, re.S)
    assert post_route, "не нашли список POST-действий в server.py"
    server_actions = set(re.findall(r'"([a-z]+)"', post_route.group(1)))
    put_route = re.search(
        r'if path\.startswith\("/api/admin/users/"\):.*?len\(parts\) == 6 and parts\[5\] == "([a-z]+)"',
        server_src, re.S)
    assert put_route, "не нашли PUT-маршрут профиля в server.py"
    server_actions.add(put_route.group(1))
    missing = sorted(ui_actions - server_actions)
    assert not missing, f"панель вызывает несуществующие действия: {missing} (в backend: {sorted(server_actions)})"


def main():
    check_ui_actions_are_routed()
    with tempfile.TemporaryDirectory(prefix="ege-admin-block-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
            server.ensure_block_schema(conn)
            conn.execute("INSERT INTO users(account_id, name, session_token, created_at) "
                         "VALUES ('0498k9','Артём','tok-0498k9','1700000000000')")
            conn.commit()
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            guest, _ = make_device()
            user, user_jar = make_device()
            admin, admin_jar = make_device()

            # Живой аккаунт, который будем банить (устройство -> свой id).
            status, _ = request(user, base, "/api/bootstrap-lite")
            assert status == 200, status
            status, session = request(user, base, "/api/auth/session")
            assert status == 200, (status, session)
            target = session["user"]["accountId"]

            status, login = request(admin, base, "/api/admin/login", "POST",
                                   {"password": ADMIN_PASSWORD.decode()})
            assert status == 200, (status, login)
            admin_id = login["user"]["id"]
            admin_account = login["user"]["accountId"]

            # 2. Неизвестное действие и лишний сегмент: явный 404, не общий.
            for path in (f"/api/admin/users/{target}/blockX",
                         f"/api/admin/users/{target}/block/extra",
                         f"/api/admin/users/{target}",
                         "/api/admin/users/"):
                for device, name in ((admin, "admin"), (user, "user"), (guest, "guest")):
                    status, body = request(device, base, path, "POST", {})
                    if name == "admin":
                        assert status == 404, (path, name, status, body)
                        assert body != GENERIC_NOT_FOUND, (path, body)
                        assert "неизвестный маршрут" in body["error"].lower(), (path, body)
                    else:
                        # Гость/юзер не отличают 401 от 404: админ-гейт впереди.
                        assert status == 401, (path, name, status, body)

            # 3. Бан по Account ID.
            status, body = request(admin, base, f"/api/admin/users/{target}/block", "POST",
                                   {"reason": "  спам   в обращениях  ", "duration": "1d"})
            assert status == 200, (status, body)
            assert body["ok"] is True, body
            block = body["block"]
            assert set(block) == {"userId", "reason", "createdAt", "blockedUntil",
                                  "permanent", "blockedBy"}, block
            assert block["reason"] == "спам в обращениях", block
            assert block["permanent"] is False and block["blockedBy"] == admin_id, block
            target_id = block["userId"]
            assert isinstance(block["blockedUntil"], int) and block["blockedUntil"] > int(time.time() * 1000), block

            # Бан виден в карточке и в списке, срок/причина на месте.
            status, detail = request(admin, base, f"/api/admin/users/{target}")
            assert status == 200 and detail["user"]["block"] is not None, (status, detail)
            assert detail["user"]["block"]["reason"] == "спам в обращениях", detail
            status, listing = request(admin, base, "/api/admin/users")
            listed = next(u for u in listing["users"] if u["id"] == target_id)
            assert listed["block"] and listed["block"]["reason"] == "спам в обращениях", listed

            # 4. Enforcement: заблокированный теряет доступ ко всему своему.
            for path in ("/api/auth/session", "/api/bootstrap", "/api/bootstrap-lite", "/api/subjects"):
                status, body = request(user, base, path)
                assert status == 403, (path, status, body)
                assert body.get("code") == "ACCOUNT_BLOCKED", (path, body)
                assert body.get("blocked") is True and body.get("permanent") is False, (path, body)
                assert body.get("reason") == "спам в обращениях", (path, body)
                assert "blockedBy" not in body, (path, body)  # внутренности админки не текут
            status, body = request(user, base, "/api/events/attempts", "POST", {"events": []})
            assert status == 403 and body.get("code") == "ACCOUNT_BLOCKED", (status, body)
            # Админ-API для заблокированного закрыт (иначе можно было бы снять бан самому).
            status, body = request(user, base, f"/api/admin/users/{target}/unblock", "POST", {})
            assert status == 401, (status, body)
            # Чужая админ-кука на устройстве заблокированного — тоже 401.
            forged = f"ege_session={[c.value for c in user_jar if c.name == 'ege_session'][0]}; " \
                     f"ege_admin={[c.value for c in admin_jar if c.name == 'ege_admin'][0]}"
            status, body = request(user, base, "/api/admin/users", raw_cookie=forged)
            assert status == 401, (status, body)

            # 5. Сроки: permanent без blockedUntil, остальные — с запасом; срок обновляется.
            status, perm = request(admin, base, f"/api/admin/users/{target}/block", "POST",
                                   {"duration": "permanent"})
            assert status == 200 and perm["block"]["permanent"] is True, (status, perm)
            assert perm["block"]["blockedUntil"] is None, perm
            for duration, low in (("1h", 3_500_000), ("1d", 86_000_000),
                                  ("1w", 600_000_000), ("1m", 2_500_000_000)):
                status, res = request(admin, base, f"/api/admin/users/{target}/block", "POST",
                                      {"duration": duration})
                assert status == 200, (duration, status, res)
                delta = res["block"]["blockedUntil"] - int(time.time() * 1000)
                assert low < delta, (duration, delta)
            for bad in ("10y", "", "PERMANENT", "1 hour", None, 7):
                status, body = request(admin, base, f"/api/admin/users/{target}/block", "POST",
                                       {"duration": bad})
                assert status == 400, (bad, status, body)
            # Причина режется и не ломает разметку панели.
            status, long = request(admin, base, f"/api/admin/users/{target}/block", "POST",
                                   {"reason": "<script>x</script>" + "ы" * 900, "duration": "1d"})
            assert status == 200 and len(long["block"]["reason"]) <= 500, long
            assert "<script>" in long["block"]["reason"], long  # сервер не экранирует, панель экранирует

            # 6. Себя блокировать нельзя — иначе админка осталась бы без доступа.
            status, body = request(admin, base, f"/api/admin/users/{admin_account}/block", "POST",
                                   {"duration": "1d"})
            assert status == 400, (status, body)
            status, body = request(admin, base, f"/api/admin/users/{admin_id}/block", "POST",
                                   {"duration": "1d"})
            assert status == 400, (status, body)
            status, body = request(admin, base, "/api/admin/overview")
            assert status == 200, (status, body)  # админка жива после отказа

            # 7. Неизвестный ref: понятный 404 и НИКАКОЙ строки в user_blocks.
            for ref in ("zzzzzz", "0", "999999", "0498k", "0498k9x"):
                status, body = request(admin, base, f"/api/admin/users/{ref}/block", "POST",
                                       {"duration": "1d"})
                assert status == 404, (ref, status, body)
                assert body["error"] == "Пользователь не найден", (ref, body)
                assert body != GENERIC_NOT_FOUND, (ref, body)
            conn2 = server.connect()
            try:
                rows = conn2.execute("SELECT user_id FROM user_blocks").fetchall()
                assert {r["user_id"] for r in rows} == {target_id}, [dict(r) for r in rows]
            finally:
                conn2.close()

            # 8. Unblock: снимает бан, повтор идемпотентен, доступ возвращается.
            status, body = request(admin, base, f"/api/admin/users/{target}/unblock", "POST", {})
            assert status == 200 and body == {"ok": True, "wasBlocked": True}, (status, body)
            status, body = request(admin, base, f"/api/admin/users/{target}/unblock", "POST", {})
            assert status == 200 and body == {"ok": True, "wasBlocked": False}, (status, body)
            status, body = request(user, base, "/api/bootstrap-lite")
            assert status == 200, (status, body)
            status, detail = request(admin, base, f"/api/admin/users/{target}")
            assert status == 200 and detail["user"]["block"] is None, detail

            # 9. Ленивое истечение: просроченная строка не блокирует и удаляется.
            conn3 = server.connect()
            try:
                conn3.execute("INSERT INTO user_blocks(user_id, reason, created_at, blocked_until, blocked_by) "
                              "VALUES (?,?,?,?,?)",
                              (target_id, "истёкший", int(time.time() * 1000) - 1000,
                               int(time.time() * 1000) - 500, admin_id))
                conn3.commit()
            finally:
                conn3.close()
            status, body = request(user, base, "/api/bootstrap-lite")
            assert status == 200, (status, body)
            status, detail = request(admin, base, f"/api/admin/users/{target}")
            assert status == 200 and detail["user"]["block"] is None, detail
            conn4 = server.connect()
            try:
                assert conn4.execute("SELECT COUNT(*) AS n FROM user_blocks").fetchone()["n"] == 0
            finally:
                conn4.close()

            # 10. Аудит: каждое действие оставило запись, чужих нет.
            conn5 = server.connect()
            try:
                actions = [r["action"] for r in conn5.execute(
                    "SELECT action FROM admin_audit WHERE target_user_id=? ORDER BY id", (target_id,))]
                assert actions and set(actions) == {"block-user", "unblock-user"}, actions
                blocks = [r["detail"] for r in conn5.execute(
                    "SELECT detail FROM admin_audit WHERE action='block-user' ORDER BY id")]
                assert any(d.startswith("1d ") for d in blocks), blocks
                assert any(d.startswith("permanent ") for d in blocks), blocks
                leaked = conn5.execute(
                    "SELECT COUNT(*) AS n FROM admin_audit WHERE target_user_id IS NULL").fetchone()["n"]
                assert leaked == 0, "аудит блокировок не должен терять целевого пользователя"
            finally:
                conn5.close()

            print("admin-block: OK (route/404/unknown action/durations/self/unknown ref/"
                  "enforcement/expiry/unblock/audit)")
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    main()
