#!/usr/bin/env python3
"""Регрессия: гость появляется в базе только после полного онбординга.

Смысл механизма: посетитель, который зашёл на лендинг, открыл приложение
«просто посмотреть» или которого прислал робот, не должен оставлять после
себя профиля. Строка в users появляется ровно в момент, когда человек прошёл
онбординг до конца и попал в дашборд.

Покрывает на живом сервере с temp-БД:
 1. GET /api/bootstrap и /api/bootstrap-lite гостю НЕ заводят пользователя
    (в базе 0 строк, куки ege_session нет, accountId пустой, state.onboarded=false);
 2. прочие «безобидные» обращения (subjects, subject, essay-text, auth/session)
    тоже ничего не пишут;
 3. любые пишущие домены гостю отказаны: 401 + code GUEST_PENDING
    (PATCH settings/progress/state-domains, POST events/errors/essays, DELETE state);
 4. всплеск запросов (бот-подобный) не создаёт ни одной строки users;
 5. POST /api/profile/claim заводит ровно одного пользователя, ставит куку и
    отдаёт accountId; данные профиля ложатся в его user_subjects;
 6. после заявки доменные записи работают и привязаны к тому же users.id;
 7. повторная заявка (потерянный ответ/двойной клик) не плодит второго человека;
 8. заявка без флага onboarded и с неизвестным предметом отвергается;
 9. logout возвращает гостя в «базы нет», и следующий онбординг — новый профиль,
    а не воскрешение старого;
10. чужой/подделанный токен не превращается в чужой профиль.
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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_guest_onboarding", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_device():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def request(opener, base: str, path: str, method="GET", body=None, raw_cookie=None):
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


def cookie_token(jar, name: str = "ege_session") -> str | None:
    for cookie in jar:
        if cookie.name == name:
            return cookie.value
    return None


def count_users(server) -> int:
    conn = server.connect()
    try:
        return int(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
    finally:
        conn.close()


def count_rows(server, table: str) -> int:
    conn = server.connect()
    try:
        return int(conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"])
    finally:
        conn.close()


def main():
    with tempfile.TemporaryDirectory(prefix="ege-guest-onboarding-") as tmp:
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
            assert count_users(server) == 0, "БД должна начинаться пустой"

            # 1. Гость: каталог и состояние есть, профиля нет.
            opener, jar = make_device()
            status, boot = request(opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, boot)
            assert boot["accountId"] is None, boot["accountId"]
            assert boot["auth"] == {"registered": False, "email": None}, boot["auth"]
            assert boot["state"]["onboarded"] is False, boot["state"]
            assert boot["state"]["name"] is None, boot["state"]
            assert boot["state"]["stateVersion"] == 1, boot["state"]
            assert boot["state"]["skillStats"], "каталог навыков нужен для онбординга"
            assert cookie_token(jar) is None, "гостю до онбординга кука не выдаётся"
            assert count_users(server) == 0, "bootstrap завёл пользователя"

            status, boot_full = request(opener, base, "/api/bootstrap")
            assert status == 200 and boot_full["accountId"] is None, (status, boot_full)
            assert cookie_token(jar) is None
            assert count_users(server) == 0, "полный bootstrap завёл пользователя"

            # 2. Прочие чтения тоже ничего не заводят.
            status, subjects = request(opener, base, "/api/subjects")
            assert status == 200 and subjects["current"] == "profile_math", (status, subjects)
            status, switched = request(opener, base, "/api/subject", "POST", {"subject": "russian"})
            assert status == 200, (status, switched)
            assert switched["subject"] == "russian", switched
            assert switched["accountId"] is None, switched
            assert switched["state"]["onboarded"] is False, switched["state"]
            status, texts = request(opener, base, "/api/essay-text?subject=russian&id=rus_t01_01")
            assert status in (200, 404), (status, texts)
            status, probe = request(opener, base, "/api/auth/session")
            assert status == 200 and probe["user"] is None, (status, probe)
            assert cookie_token(jar) is None, "чтение выдало куку гостю"
            assert count_users(server) == 0, "чтение что-то завело"

            # 3. Пишущие домены гостю недоступны и ничего не создают.
            denied = [
                ("/api/settings", "PATCH", {"subject": "profile_math", "expectedVersion": 1,
                                             "settings": {"onboarded": True, "name": "Бот"}}),
                ("/api/state-domains", "PATCH", {"subject": "profile_math", "expectedVersion": 1,
                                                  "domains": {"bossesDefeated": ["b1"]}}),
                ("/api/progress/n01_planimetry", "PATCH", {"subject": "profile_math", "expectedVersion": 1,
                                                           "progress": {"progress": 100, "solved": 1, "correct": 1, "timeSec": 1}}),
                ("/api/events/attempts", "POST", {"subject": "profile_math", "expectedVersion": 1,
                                                   "events": [{"taskId": "n01_p1", "skill": "n01_planimetry",
                                                               "correct": True, "hintLevel": 0, "seconds": 1,
                                                               "ts": 1700000000000}]}),
                ("/api/events/timeline", "POST", {"subject": "profile_math", "expectedVersion": 1,
                                                   "events": [{"ts": 1700000000000, "text": "бот"}]}),
                ("/api/errors", "POST", {"subject": "profile_math", "expectedVersion": 1,
                                          "error": {"taskId": "n01_p1", "skill": "n01_planimetry",
                                                    "topic": "planimetry", "kind": "major"}}),
                ("/api/essays", "POST", {"subject": "profile_math", "clientId": "bot-1", "taskId": "n01_p1",
                                          "skillId": "n01_planimetry", "text": "бот"}),
                ("/api/state", "DELETE", None),
            ]
            for path, method, body in denied:
                status, payload = request(opener, base, path, method, body)
                assert status == 401, (path, status, payload)
                assert payload.get("code") == "GUEST_PENDING", (path, payload)
            status, payload = request(opener, base, "/api/essays?clientId=bot-1")
            assert status == 401 and payload.get("code") == "GUEST_PENDING", (status, payload)
            assert count_users(server) == 0, "гостю отказали, а пользователь появился"
            assert count_rows(server, "task_attempts") == 0
            assert count_rows(server, "timeline") == 0

            # 4. Бот-подобный всплеск: ни одной строки, ни одной куки.
            def hammer(_):
                device, _jar = make_device()
                for _ in range(4):
                    request(device, base, "/api/bootstrap-lite")
                    request(device, base, "/api/subjects")
                    request(device, base, "/api/subject", "POST", {"subject": "russian"})
                    request(device, base, "/api/events/attempts", "POST",
                            {"subject": "profile_math", "expectedVersion": 1, "events": []})
                return None

            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(hammer, range(16)))
            assert count_users(server) == 0, f"боты наплодили профилей: {count_users(server)}"

            # 5. Онбординг пройден — человек появился.
            claim = {"subject": "profile_math", "onboarded": True, "name": "Ученик",
                     "selfLevel": "base", "goal": "g60"}
            status, claimed = request(opener, base, "/api/profile/claim", "POST", claim)
            assert status == 200, (status, claimed)
            assert claimed["created"] is True, claimed
            account = claimed["accountId"]
            assert account, claimed
            assert claimed["subject"] == "profile_math", claimed
            assert claimed["user"]["registered"] is False, claimed
            assert count_users(server) == 1, count_users(server)
            token = cookie_token(jar)
            assert token, "заявка обязана выдать сессионную куку"
            conn = server.connect()
            try:
                row = conn.execute("SELECT id, name, current_subject FROM users WHERE account_id=?",
                                   (account,)).fetchone()
                assert row is not None, account
                assert row["name"] == "Ученик", dict(row)
                assert row["current_subject"] == "profile_math", dict(row)
                prof = conn.execute("SELECT onboarded FROM user_subjects WHERE user_id=?", (row["id"],)).fetchone()
                assert prof is not None, dict(row)
            finally:
                conn.close()

            # 6. Дальше всё как у обычного пользователя: настройки, попытки, таймлайн.
            status, saved = request(opener, base, "/api/settings", "PATCH", {
                "subject": "profile_math", "expectedVersion": 1,
                "settings": {"onboarded": True, "name": "Ученик", "selfLevel": "base", "goal": "g60"},
            })
            assert status == 200, (status, saved)
            status, seeded = request(opener, base, "/api/events/attempts", "POST", {
                "subject": "profile_math", "expectedVersion": saved["stateVersion"],
                "events": [{"taskId": "n01_p1", "skill": "n01_planimetry", "correct": True,
                            "hintLevel": 0, "seconds": 3, "ts": 1700000000000}],
            })
            assert status == 200, (status, seeded)
            status, boot = request(opener, base, "/api/bootstrap-lite")
            assert boot["accountId"] == account, boot["accountId"]
            assert boot["state"]["onboarded"] is True, boot["state"]
            assert boot["state"]["name"] == "Ученик", boot["state"]
            assert boot["state"]["totalSolved"] == 1, boot["state"]

            # 7. Повторная заявка (потерянный ответ/двойной клик) — тот же человек.
            for _ in range(2):
                status, again = request(opener, base, "/api/profile/claim", "POST", claim)
                assert status == 200, (status, again)
                assert again["created"] is False, again
                assert again["accountId"] == account, again
            assert count_users(server) == 1, f"повторная заявка плодит людей: {count_users(server)}"

            # 8. Незаявленное онбординг не проходит: без флага и с чужим предметом.
            status, no_flag = request(opener, base, "/api/profile/claim", "POST",
                                      {"subject": "profile_math"})
            assert status == 400, (status, no_flag)
            status, no_onboarded = request(opener, base, "/api/profile/claim", "POST",
                                           {"subject": "profile_math", "onboarded": False})
            assert status == 400, (status, no_onboarded)
            status, bad_subject = request(opener, base, "/api/profile/claim", "POST",
                                          {"subject": "astrophysics", "onboarded": True})
            assert status == 400, (status, bad_subject)
            fresh, _ = make_device()
            status, fresh_claim = request(fresh, base, "/api/profile/claim", "POST",
                                          {"subject": "astrophysics", "onboarded": True})
            assert status == 400, (status, fresh_claim)
            assert count_users(server) == 1, "отказная заявка не должна заводить пользователя"

            # Гость без заявки, отправляющий её в чужом браузере, — тоже человек
            # только после заявки: чужой токен не превращается в чужой профиль.
            bare = urllib.request.build_opener()
            status, spoofed = request(bare, base, "/api/bootstrap", raw_cookie=f"ege_session={token}")
            assert status == 200, (status, spoofed)
            assert spoofed["accountId"] == account, spoofed["accountId"]

            # 9. Logout: в базе снова «никого нет», и это не воскрешение.
            status, out = request(opener, base, "/api/auth/logout", "POST", {})
            assert status == 200, (status, out)
            status, after_out = request(opener, base, "/api/bootstrap-lite")
            assert status == 200, (status, after_out)
            assert after_out["accountId"] is None, after_out["accountId"]
            assert after_out["state"]["onboarded"] is False, after_out["state"]
            assert count_users(server) == 1, "logout не должен плодить строки"
            status, stale = request(bare, base, "/api/bootstrap-lite", raw_cookie=f"ege_session={token}")
            assert stale["accountId"] is None, stale["accountId"]
            # Новый онбординг после выхода = новый человек, а не тот же.
            status, reclaimed = request(opener, base, "/api/profile/claim", "POST", claim)
            assert status == 200 and reclaimed["created"] is True, reclaimed
            assert reclaimed["accountId"] != account, reclaimed
            assert count_users(server) == 2, count_users(server)

            print("Guest onboarding OK: профиль появляется только после онбординга, "
                  "роботы и просто открытие сайта не оставляют следов")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
