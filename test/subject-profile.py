#!/usr/bin/env python3
"""Регрессия: профиль пользователя — свойство ПРЕДМЕТА, флаг аккаунта — производная.

Костыль, который здесь закрывается: `users.onboarded/self_level/goal_id`
дублировали профиль предмета по умолчанию, и код сравнивал предмет с
DEFAULT_SUBJECT в пяти местах. Любой новый предмет пришлось бы дописывать
руками: его профиль не отражался бы ни в админке, ни в счётчике
«онбординг прошли», а правка в нём ломала бы чужой.

Проверяется на живом сервере с temp-БД:
 1. `user_subjects` — единственный источник профиля; ветвлений по предмету по
    умолчанию в коде нет (проверяется текстом server.py);
 2. онбординг в ЛЮБОМ предмете поднимает аккаунтный флаг users.onboarded;
 3. онбординг в предмете по умолчанию НЕ обнуляет флаг, поднятый другим
    предметом, и наоборот (главный сценарий костыля);
 4. users.self_level/goal_id больше не хранят профиль предмета;
 5. админка честно считает «прошли онбординг» по всем предметам (было 27
    вместо 58), отдаёт список предметов и `withoutOnboarding`;
 6. сброс «весь прогресс» обнуляет профиль во всех предметах сразу;
 7. существующий аккаунт, прошедший онбординг, не теряет профиль при миграции;
 8. НОВЫЙ предмет, добавленный в реестр, работает без единой правки кода:
    строки начисляются ему так же, как профильному, и попадают в админку.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
SOURCE = (ROOT / "server" / "server.py").read_text(encoding="utf-8")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_subject_profile", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_device():
    jar = CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def one(conn, sql, *args):
    return conn.execute(sql, args).fetchone()


def onboard(opener, base: str, subject: str, name: str = "Ученик", **settings) -> str:
    payload = {"subject": subject, "onboarded": True, "name": name, "selfLevel": "base", "goal": "g60"}
    payload.update(settings)
    status, claimed = request(opener, base, "/api/profile/claim", "POST", payload)
    assert status == 200, (subject, status, claimed)
    return claimed["accountId"]


def admin_login(opener, base: str, server) -> None:
    salt = "b" * 32
    import hashlib
    dk = hashlib.pbkdf2_hmac("sha256", b"subject-profile-admin", bytes.fromhex(salt), 210000)
    server.ADMIN_PASSWORD_HASH = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    status, body = request(opener, base, "/api/admin/login", "POST", {"password": "subject-profile-admin"})
    assert status == 200, (status, body)


def main():
    # 1. В коде не осталось ветвлений ПРОФИЛЯ по «предмету по умолчанию».
    #    Строка — кандидат в костыль, если она говорит и про колонку профиля
    #    (onboarded/self_level/goal_id), и про сравнение предмета с дефолтом.
    #    Сравнения без колонок профиля легальны: миграция данных, созданных до
    #    появления предметов, и legacy-ключи каталога в _subject_config.
    # Строки с _subject_config — другая подсистема: allow_legacy там означает
    # «этому предмету можно читать непрефиксный legacy-ключ каталога», а
    # непрефиксные ключи install_catalog пишет ровно из предмета по умолчанию.
    # Новый предмет всегда получает собственные ключи и в этом правиле не
    # нуждается, поэтому он сюда не относится.
    PROFILE_COLUMNS = ("onboarded", "self_level", "goal_id")
    profile_branches = [
        line for line in SOURCE.splitlines()
        if re.search(r"\w*subject\w*\s*[!=]=\s*DEFAULT_SUBJECT", line)
        and any(col in line for col in PROFILE_COLUMNS)
        and "_subject_config" not in line
    ]
    assert not profile_branches, "остались ветвления профиля по предмету по умолчанию:\n" + "\n".join(profile_branches)
    # users.* больше не дублирует профиль предмета: единственная запись в
    # users.onboarded — производный флаг аккаунта из refresh_account_onboarded.
    assert "UPDATE users SET onboarded=?, self_level=?, goal_id=?" not in SOURCE, \
        "users.* снова дублирует профиль предмета"
    assert "UPDATE users SET self_level=?, goal_id=?" not in SOURCE, \
        "users.self_level/goal_id снова пишутся из профиля предмета"

    with tempfile.TemporaryDirectory(prefix="ege-subject-profile-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
            # 7. Миграция: аккаунт, прошедший онбординг ДО предметов, не теряет
            #    профиль, а аккаунт без онбординга не становится onboarded.
            legacy_on = conn.execute(
                "INSERT INTO users(session_token, created_at, onboarded, self_level, goal_id, name)"
                " VALUES ('legacy-ok', '1700000000000', 1, 'confident', 'g80', 'Давний')").lastrowid
            legacy_off = conn.execute(
                "INSERT INTO users(session_token, created_at, onboarded, name)"
                " VALUES ('legacy-no', '1700000000000', 0, 'Молчун')").lastrowid
            conn.commit()
            # Апгрейд схемы на существующей базе: миграция обязана быть
            # повторяемой и применимой к данным, созданным до предметов.
            # Ровно это происходит на реальном старте новой версии сервера.
            server._SUBJECT_SCHEMA_DONE.clear()
            server.ensure_subject_schema(conn)
            server._SUBJECT_SCHEMA_DONE.clear()
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            # Миграция идемпотентна и ленива: она отработает при первом же
            # обращении к серверу, поэтому начинаем с гостевого bootstrap.
            anon, _njar = make_device()
            status, _ = request(anon, base, "/api/bootstrap-lite")
            assert status == 200, status
            conn = server.connect()
            try:
                prof = one(conn, "SELECT onboarded, self_level, goal_id FROM user_subjects"
                                 " WHERE user_id=? AND subject='profile_math'", legacy_on)
                assert prof is not None and prof["onboarded"] == 1, dict(prof) if prof else None
                assert prof["self_level"] == "confident" and prof["goal_id"] == "g80", dict(prof)
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", legacy_on)["onboarded"] == 1
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", legacy_off)["onboarded"] == 0
                # 4. users.self_level/goal_id мёртвое зеркало — очищено миграцией.
                assert one(conn, "SELECT self_level, goal_id FROM users WHERE id=?", legacy_on)[0] is None
            finally:
                conn.close()

            # 2 + 3. Онбординг в НЕ-профильном предмете поднимает флаг аккаунта,
            #        и профильный онбординг его не сбрасывает.
            student, _jar = make_device()
            onboard(student, base, "russian", name="Русский", goal=None)
            conn = server.connect()
            try:
                uid = one(conn, "SELECT id FROM users WHERE name='Русский'")["id"]
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", uid)["onboarded"] == 1, \
                    "онбординг в русском не поднял аккаунтный флаг"
                assert one(conn, "SELECT onboarded FROM user_subjects WHERE user_id=? AND subject='russian'", uid)["onboarded"] == 1
            finally:
                conn.close()
            status, boot = request(student, base, "/api/bootstrap-lite")
            assert boot["state"]["onboarded"] is True and boot["state"]["name"] == "Русский", boot["state"]

            # Тот же человек регистрирует профильную математику: флаг аккаунта
            # обязан остаться включённым (костыль ронял бы его здесь).
            status, saved = request(student, base, "/api/settings", "PATCH", {
                "subject": "profile_math", "expectedVersion": boot["state"]["stateVersion"],
                "settings": {"onboarded": True, "name": "Русский", "selfLevel": "base", "goal": "g60"}})
            assert status == 200, (status, saved)
            conn = server.connect()
            try:
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", uid)["onboarded"] == 1
            finally:
                conn.close()

            # 5. Админка: счёт по всем предметам + список предметов + «не прошли».
            admin, _ajar = make_device()
            admin_login(admin, base, server)
            status, overview = request(admin, base, "/api/admin/overview")
            assert status == 200, (status, overview)
            conn = server.connect()
            try:
                expected = one(conn, "SELECT COUNT(DISTINCT user_id) AS c FROM user_subjects WHERE onboarded=1")["c"]
            finally:
                conn.close()
            assert overview["users"]["onboarded"] == expected, (overview["users"], expected)
            assert overview["users"]["withoutOnboarding"] == overview["users"]["total"] - expected

            status, page = request(admin, base, "/api/admin/users")
            assert status == 200, status
            listed = {u["id"]: u for u in page["users"]}
            assert listed[uid]["onboardedAny"] is True, listed[uid]
            status, wrapped = request(admin, base, f"/api/admin/users/{uid}")
            assert status == 200, (status, wrapped)
            detail = wrapped["user"]
            assert detail["onboardedAny"] is True, detail
            done_ids = {s["id"] for s in detail["onboardedSubjects"]}
            assert done_ids == {"russian", "profile_math"}, detail["onboardedSubjects"]
            assert all(s.get("title") for s in detail["onboardedSubjects"]), detail["onboardedSubjects"]
            # Открытый предмет не влияет на аккаунтный ответ: профиль по умолчанию
            # закрыт, а человек всё равно «прошёл онбординг».
            assert listed[legacy_on]["onboardedAny"] is True, listed[legacy_on]

            # 6. Сброс «весь прогресс» обнуляет профиль во всех предметах.
            status, reset = request(admin, base, f"/api/admin/users/{uid}/reset", "POST", {"target": "all-progress"})
            assert status == 200, (status, reset)
            conn = server.connect()
            try:
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", uid)["onboarded"] == 0
                rows = conn.execute("SELECT onboarded FROM user_subjects WHERE user_id=?", (uid,)).fetchall()
                assert rows and all(r["onboarded"] == 0 for r in rows), [dict(r) for r in rows]
            finally:
                conn.close()

            # 8. Новый предмет подключается ТОЛЬКО ДАННЫМИ: новый JSON в
            #    server/subjects + свой catalog-файл. Ни одной правки кода.
            #    Ниже реестр перечитывается из подготовленного каталога — ровно
            #    то, что делает старт сервера после добавления предмета.
            new_id = "informatics"
            with_new_subject = Path(tmp) / "server-with-new-subject"
            (with_new_subject / "subjects").mkdir(parents=True)
            for name in ("profile_math", "basic_math", "russian"):
                shutil.copy(ROOT / "server" / "subjects" / f"{name}.json",
                            with_new_subject / "subjects" / f"{name}.json")
            for name in ("catalog.json", "catalog_basic.json", "catalog_russian.json"):
                shutil.copy(ROOT / "server" / name, with_new_subject / name)
            (with_new_subject / "subjects" / "informatics.json").write_text(json.dumps({
                "id": new_id, "title": "Информатика", "short": "Инфо",
                "description": "Информатика: работа с текстом и алгоритмы.",
                "status": "ready", "locked": False, "comingSoon": False,
                "availability": "ready", "order": 3,
                "catalogFile": "catalog_informatics.json",
                "level": {"id": new_id, "subjectId": new_id, "name": "Информатика"},
                "forecast": None,
                "features": {"lessons": False, "practice": True, "forecast": False,
                             "diagnostics": True, "missions": False, "bosses": False,
                             "daily": False, "path": True},
                "metadata": {"availability": "ready", "topic": "Работа с текстом", "topicCount": 1},
                "content": {"topics": {"source": "catalog", "keys": ["categories", "skills"]},
                            "preparationVariants": {"source": "catalog", "key": "goals"},
                            "onboarding": {"source": "catalog", "key": "diagnosticTasks"}},
            }, ensure_ascii=False), encoding="utf-8")
            # Каталог нового предмета — копия профильного: проверяем именно
            # профиль/админку, а не наполнение каталога.
            shutil.copy(ROOT / "server" / "catalog.json", with_new_subject / "catalog_informatics.json")

            # Тот же загрузчик, что и у сервера: подключаем registry-модуль
            # вторым spec-загрузчиком, не затрагивая sys.modules.
            reg_spec = importlib.util.spec_from_file_location(
                "ege_subjects_registry_probe", ROOT / "server" / "subjects_registry.py")
            registry_mod = importlib.util.module_from_spec(reg_spec)
            reg_spec.loader.exec_module(registry_mod)
            fresh_registry = registry_mod.load_registry(server_dir=with_new_subject)
            assert new_id in fresh_registry.subjects, sorted(fresh_registry.subjects)
            # Подменяем глобалы модуля так же, как это сделал бы свежий процесс.
            server._REGISTRY = fresh_registry
            server.SUBJECTS = fresh_registry.subjects
            server.SUBJECT_IDS = tuple(fresh_registry.subjects.keys())
            server._SUBJECT_SCHEMA_DONE.clear()
            server.invalidate_catalog_cache()
            conn = server.connect()
            try:
                server.ensure_subject_schema(conn)
            finally:
                conn.close()
            assert server.is_known_subject(new_id), "новый предмет не узнаётся реестром"
            status, base_overview = request(admin, base, "/api/admin/overview")
            onboarded_before = base_overview["users"]["onboarded"]
            fresh, _fjar = make_device()
            account = onboard(fresh, base, new_id, name="Химик", goal=None)
            conn = server.connect()
            try:
                new_uid = one(conn, "SELECT id FROM users WHERE account_id=?", account)["id"]
                assert one(conn, "SELECT current_subject FROM users WHERE id=?", new_uid)["current_subject"] == new_id
                assert one(conn, "SELECT onboarded FROM users WHERE id=?", new_uid)["onboarded"] == 1
                assert one(conn, "SELECT onboarded FROM user_subjects WHERE user_id=? AND subject=?",
                           new_uid, new_id)["onboarded"] == 1
                assert one(conn, "SELECT COUNT(*) AS c FROM user_stats WHERE user_id=? AND subject=?",
                           new_uid, new_id)["c"] == 1
            finally:
                conn.close()
            status, page2 = request(admin, base, "/api/admin/users")
            fresh_item = next(u for u in page2["users"] if u["id"] == new_uid)
            assert fresh_item["onboardedAny"] is True, fresh_item
            assert fresh_item["subject"] == new_id, fresh_item
            status, wrapped2 = request(admin, base, f"/api/admin/users/{new_uid}")
            fresh_detail = wrapped2["user"]
            assert [s["id"] for s in fresh_detail["onboardedSubjects"]] == [new_id], fresh_detail
            status, overview2 = request(admin, base, "/api/admin/overview")
            # Счётчик админки вырос ровно на нового человека — новый предмет
            # учтён без единой правки кода.
            assert overview2["users"]["onboarded"] == onboarded_before + 1, (overview2["users"], onboarded_before)

            print("Subject-profile OK: профиль живёт в user_subjects, флаг аккаунта производная, "
                  "админка считает все предметы, новый предмет подхватывается без правок")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
