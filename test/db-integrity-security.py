#!/usr/bin/env python3
"""Целостность базы: что должно чиниться само и не тирать данные.

Аудит базы не нашёл ни одной SQL-инъекции (все 41 f-string-вставка
структурные), но нашёл дефекты вокруг неё. Здесь закрыты те, что влияют на
данные или на доступность, и каждый проверяется на живом коде.

Что проверяем:

  F1. Порядок параметров в agent.propose_action(«resolve_error» по taskId).
      Было (task_id, subject, user_id) при плейсхолдерах
      (task_id, user_id, subject): инструмент не находил ошибку НИКОГДА, а
      как только subject смог бы стать числом — выбрал бы чужую строку, и
      apply_action пометил бы чужую ошибку разобранной.
  F2. Пересборка таблиц с составным PK: DROP и RENAME обязаны откатываться
      вместе, иначе падение между ними оставляет таблицу удалённой.
  F3. _support_relax_source_check не должна молча удалить ленту обращений:
      INSERT OR IGNORE глотал нарушения NOT NULL, а DROP шёл следом.
  F4. /api/health — анонимный и читает всю базу (PRAGMA quick_check), но был
      единственным /api/ без лимита; плюс каждый запрос = полный скан.
  F6. Сброс «весь прогресс» обязан чистить essay_checks / essay_check_history /
      activity_events: load_essay_checks не требует essay_submissions, так что
      выживший кэш отдавал бы старую оценку бесплатно и навсегда.
  F10. Недостающий UNIQUE-индекс (БД от старой версии) должен
      восстанавливаться при старте, иначе ON CONFLICT роняет каждую запись.

Прод не трогаем: своя временная БД и случайный порт.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import shutil
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

# Версия правил проверки сочинений живёт в ai.py и в server.py не экспортируется.
RUBRIC_VERSION = 4


def t(name: str, ok: bool, detail: object = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"  ok  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}: {detail}")


def load_server(db_path: Path, name: str):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "9" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"db-integrity-test", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location(name, SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def boot(db_path: Path, name: str):
    """Поднимает сервер на временной БД, возвращает (модуль, base)."""
    server = load_server(db_path, name)
    conn = server.connect()
    try:
        server.install_catalog(conn)
    finally:
        conn.close()
    httpd = server.create_http_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{httpd.server_address[1]}", httpd


def get(base: str, path: str, headers: dict | None = None):
    req = urllib.request.Request(base + path)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ---------------------------------------------------------------------------
def check_agent_param_order() -> None:
    """F1: propose_action(«resolve_error» по taskId) обязан реально находить."""
    print("\n== F1. Порядок параметров в agent.py: порядок ЗНАЧЕНИЙ ==")
    with tempfile.TemporaryDirectory(prefix="ege-dbf1-") as tmp:
        server, base, httpd = boot(Path(tmp) / "f1.sqlite3", "ege_db_f1")
        try:
            # Заводим ученика и его ошибку напрямую — путь агента тут не нужен.
            conn = server.connect()
            try:
                uid, _ = server.provision_user(conn, _FakeHandler())
                server.set_current_subject(conn, uid, "profile_math")
                row = conn.execute(
                    "SELECT t.id AS task_id, t.skill_id AS skill_id, t.topic AS topic"
                    " FROM tasks t JOIN skills s ON s.id=t.skill_id"
                    " WHERE s.subject=? LIMIT 1", ("profile_math",)).fetchone()
                if row is None:
                    row = conn.execute(
                        "SELECT t.id AS task_id, t.skill_id AS skill_id, t.topic AS topic"
                        " FROM tasks t LIMIT 1").fetchone()
                assert row is not None, "каталог пуст — тест не может построить ошибку"
                task_id, skill_id, topic = row["task_id"], row["skill_id"], row["topic"] or ""
                conn.execute(
                    "INSERT INTO user_errors(user_id, subject, task_id, skill_id, topic,"
                    " kind, resolved, created_at) VALUES (?,?,?,?,?,?,0,?)",
                    (uid, "profile_math", task_id, skill_id, topic, "major", now_iso(server)))
                conn.commit()
                # Чужая ошибка того же задания — чтобы поймать подмену user_id.
                other = conn.execute("SELECT id FROM users WHERE id<>? LIMIT 1", (uid,)).fetchone()
                other_id = None
                if other is not None:
                    conn.execute(
                        "INSERT INTO user_errors(user_id, subject, task_id, skill_id, topic,"
                        " kind, resolved, created_at) VALUES (?,?,?,?,?,?,0,?)",
                        (other["id"], "profile_math", task_id, skill_id, topic, "major",
                         now_iso(server)))
                    other_id = conn.execute(
                        "SELECT id FROM user_errors WHERE user_id=? ORDER BY id DESC LIMIT 1",
                        (other["id"],)).fetchone()["id"]
                    conn.commit()
            finally:
                conn.close()

            agent = server._AGENT
            conn = server.connect()
            try:
                out = agent.propose_action(
                    conn, name="resolve_error", args={"taskId": task_id},
                    user_id=uid, subject="profile_math")
                got = int(out.get("errorId") or 0)
                t("ошибка по taskId находится (инструмент больше не мёртвый)", got > 0, out)

                conn.row_factory = sqlite3.Row
                mine = conn.execute(
                    "SELECT id FROM user_errors WHERE user_id=? AND subject='profile_math'",
                    (uid,)).fetchone()
                t("найдена именно СВОЯ ошибка, а не чужая",
                  mine is not None and int(mine["id"]) == got,
                  f"получено {got}")
                if other_id is not None:
                    got_row = conn.execute(
                        "SELECT user_id FROM user_errors WHERE id=?", (got,)).fetchone()
                    t("user_id в запросе не переставлен (нет подмены на чужого)",
                      got_row is not None and int(got_row["user_id"]) == uid,
                      dict(got_row or {}))
            finally:
                conn.close()
        finally:
            httpd.shutdown()


def now_iso(server) -> str:
    try:
        return server.now_iso()
    except Exception:
        return "2026-01-01T00:00:00Z"


class _FakeHandler:
    def __init__(self, ip: str = "127.0.0.1"):
        self.headers = {}
        self.client_address = (ip, 0)


# ---------------------------------------------------------------------------
def check_health_rate_and_cache() -> None:
    """F4: /api/health под лимитом и не сканирует базу на каждый запрос."""
    print("\n== F4. /api/health: лимит и кэш целостности ==")
    with tempfile.TemporaryDirectory(prefix="ege-dbf4-") as tmp:
        server, base, httpd = boot(Path(tmp) / "f4.sqlite3", "ege_db_f4")
        try:
            # Прямой замер: сколько раз на N вызовов открывается соединение.
            opened = {"n": 0}
            real_connect = sqlite3.connect

            class Counting:
                def __init__(self, *a, **k):
                    opened["n"] += 1
                    self._c = real_connect(*a, **k)

                def execute(self, *a, **k):
                    return self._c.execute(*a, **k)

                def close(self):
                    self._c.close()

            server.sqlite3.connect = Counting
            for _ in range(50):
                server.health_payload()
            server.sqlite3.connect = real_connect
            t("50 вызовов health_payload не читают базу 50 раз", opened["n"] <= 2,
              f"соединений: {opened['n']}")

            # И лимит на живой сервере: поток анонимных запросов упирается.
            server.HEALTH_RATE_MAX = 5
            server._health_hits.clear()
            statuses = [get(base, "/api/health")[0] for _ in range(9)]
            t("поток /api/health упирается в лимит, а не идёт бесконечно",
              429 in statuses, statuses)
            t("лимит отдаёт честный 429 с Retry-After",
              get(base, "/api/health")[0] == 429)
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
def check_reset_completeness() -> None:
    """F6: «весь прогресс» чистит кэш проверок и события активности."""
    print("\n== F6. Сброс «весь прогресс» чистит всё ==")
    with tempfile.TemporaryDirectory(prefix="ege-dbf6-") as tmp:
        server, base, httpd = boot(Path(tmp) / "f6.sqlite3", "ege_db_f6")
        try:
            conn = server.connect()
            try:
                uid, _ = server.provision_user(conn, _FakeHandler())
                server.set_current_subject(conn, uid, "profile_math")
                conn.execute(
                    "INSERT INTO essay_checks(user_id, subject, text_sha256, provider,"
                    " result_json, rubric_version, created_at) VALUES (?,?,?,?,?,?,?)",
                    (uid, "profile_math", "deadbeef", "mock", json.dumps({"total": 22}),
                     RUBRIC_VERSION, now_iso(server)))
                conn.execute(
                    "INSERT INTO essay_check_history(user_id, subject, text_sha256, provider,"
                    " result_json, rubric_version, created_at) VALUES (?,?,?,?,?,?,?)",
                    (uid, "profile_math", "deadbeef", "mock", json.dumps({"total": 22}),
                     RUBRIC_VERSION, now_iso(server)))
                conn.execute(
                    "INSERT INTO activity_events(user_id, subject, activity_date,"
                    " solved, correct, xp, created_at, event_key) VALUES (?,?,?,?,?,?,?,?)",
                    (uid, "profile_math", dt.date.today().isoformat(), 3, 2, 40,
                     now_iso(server), "evt-reset-" + str(int(time.time()))))
                conn.commit()

                probe_text = "текст сочинения, который кэшируется"
                conn.execute(
                    "UPDATE essay_checks SET text_sha256=? WHERE user_id=?",
                    (server.essay_text_hash(probe_text), uid))
                conn.commit()
                before = server.load_essay_check(
                    conn, uid, "profile_math", probe_text, rubric=0)
                t("до сброса кэш проверки отдаётся (по хэшу текста)",
                  before is not None, before)

                server.admin_reset(conn, user_id=uid, target="all-progress")
            finally:
                conn.close()

            conn = server.connect()
            try:
                for table in ("essay_checks", "essay_check_history", "activity_events"):
                    n = conn.execute(f"SELECT COUNT(*) c FROM {table} WHERE user_id=?",
                                     (uid,)).fetchone()["c"]
                    t(f"сброс «весь прогресс» чистит {table}", n == 0, f"осталось {n}")
                after = server.load_essay_check(
                    conn, uid, "profile_math", probe_text, rubric=0)
                t("после сброса старый текст не получает готовую оценку бесплатно",
                  after is None, after)
            finally:
                conn.close()
        finally:
            httpd.shutdown()


# ---------------------------------------------------------------------------
def check_index_self_heal() -> None:
    """F10: недостающий UNIQUE-индекс восстанавливается при старте."""
    print("\n== F10. Индексы для ON CONFLICT чинятся сами ==")
    db = Path(tempfile.mkdtemp(prefix="ege-dbf10-")) / "f10.sqlite3"
    try:
        server, _base, httpd = boot(db, "ege_db_f10_a")
        httpd.shutdown()
        # База «от старой версии»: таблицы есть, индексов нет.
        conn = sqlite3.connect(db)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("DROP INDEX IF EXISTS idx_essay_submissions_user_subject_client")
            conn.execute("DROP INDEX IF EXISTS idx_essay_checks_user_subject_text")
            conn.execute("DROP INDEX IF EXISTS idx_essay_checks_user_subject_task_text")
            conn.commit()
        finally:
            conn.close()

        # Новый процесс — ровно как при реальном старске сервера.
        server2 = load_server(db, "ege_db_f10_b")
        conn = server2.connect()
        try:
            server2.ensure_essay_schema(conn)
        finally:
            conn.close()

        conn = sqlite3.connect(db)
        try:
            def names(table: str) -> set[str]:
                return {r[1] for r in conn.execute(f"PRAGMA index_list({table})")}
            subs = names("essay_submissions")
            checks = names("essay_checks")
            t("UNIQUE-индекс essay_submissions восстановлен",
              "idx_essay_submissions_user_subject_client" in subs, sorted(subs))
            t("UNIQUE-индекс essay_checks восстановлен",
              "idx_essay_checks_user_subject_task_text" in checks
              and "idx_essay_checks_user_subject_text" not in checks, sorted(checks))
            # И главное: ON CONFLICT больше не падает.
            try:
                conn.execute("PRAGMA foreign_keys=OFF")
                conn.execute(
                    "INSERT INTO essay_checks(user_id,subject,task_id,text_sha256,provider,"
                    "result_json,rubric_version,created_at)"
                    " VALUES (1,'profile_math','re27_1','h1','mock','{}',1,'x')"
                    " ON CONFLICT(user_id,subject,task_id,text_sha256) DO NOTHING")
                ok = True
            except sqlite3.Error as exc:
                ok = False
                err = exc
            t("ON CONFLICT работает (раньше падал бы на каждой проверке)", ok,
              "" if ok else str(err))
            conn.rollback()
        finally:
            conn.close()
    finally:
        shutil.rmtree(db.parent, ignore_errors=True)


# ---------------------------------------------------------------------------
def check_support_rebuild_keeps_rows() -> None:
    """F3: пересборка support_messages не теряет обращения."""
    print("\n== F3. Пересборка ленты обращений не теряет строки ==")
    db = Path(tempfile.mkdtemp(prefix="ege-dbf3-")) / "f3.sqlite3"
    try:
        server, _base, httpd = boot(db, "ege_db_f3_a")
        httpd.shutdown()
        # Старая таблица: без request_key/message_digest, со старым CHECK.
        conn = sqlite3.connect(db)
        try:
            conn.execute("DROP TABLE support_messages")
            # Старая таблица ДО появления дедупликации: ни request_key, ни
            # message_digest, ни spam_score, и старый CHECK(source='contacts').
            # Именно на такой БД старая редакция миграции молча теряла всю
            # ленту: OR IGNORE отбрасывал строки по NOT NULL, а DROP шёл следом.
            conn.execute("""CREATE TABLE support_messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'new',
                created_at TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'contacts' CHECK(source = 'contacts'))""")
            conn.executemany(
                "INSERT INTO support_messages(message,status,created_at,source) VALUES (?,?,?,?)",
                [("первое обращение ученика", "new", "2026-01-01", "contacts"),
                 ("второе обращение ученика", "new", "2026-01-02", "contacts"),
                 ("третье обращение ученика", "reviewed", "2026-01-03", "contacts")])
            conn.commit()
        finally:
            conn.close()

        server2 = load_server(db, "ege_db_f3_b")
        conn = server2.connect()
        try:
            server2.ensure_support_schema(conn)
        finally:
            conn.close()

        conn = sqlite3.connect(db)
        try:
            rows = conn.execute("SELECT message FROM support_messages").fetchall()
            texts = sorted(r[0] for r in rows)
            t("все обращения пережили пересборку", len(rows) == 3, texts)
            t("тексты обращений не потеряны",
              texts == sorted(["первое обращение ученика", "второе обращение ученика",
                               "третье обращение ученика"]), texts)
        finally:
            conn.close()
    finally:
        shutil.rmtree(db.parent, ignore_errors=True)


# ---------------------------------------------------------------------------
# Токены сессий в базе — только хэши
# ---------------------------------------------------------------------------
def check_token_hashing() -> None:
    """В базе не должно быть готовых кук.

    Пара `ege_session` + `ege_admin`, прочитанная из файла БД (или бэкапа),
    открывала админку со всеми аккаунтами — это проверено на живой базе до
    правки. Теперь в базе лежит sha256, восстановить токен из которого нельзя
    (сам токен — 256 бит энтропии), а живая сессия продолжает работать.
    """
    print("\n== Токены сессий: в базе хэши, куки работают ==")
    with tempfile.TemporaryDirectory(prefix="ege-db-tok-") as tmp:
        server, base, httpd = boot(Path(tmp) / "tok.sqlite3", "ege_db_tok")
        try:
            class C:
                def __init__(self, ip): self.ip, self.jar = ip, {}
                def req(self, path, method="GET", body=None):
                    data = json.dumps(body).encode() if body is not None else None
                    r = urllib.request.Request(base + path, data=data, method=method)
                    if data: r.add_header("Content-Type", "application/json")
                    r.add_header("X-Forwarded-For", self.ip)
                    for k, v in self.jar.items():
                        r.add_header("Cookie", f"{k}={v}")
                    try:
                        with urllib.request.urlopen(r, timeout=15) as x:
                            st, payload = x.status, x.read()
                    except urllib.error.HTTPError as e:
                        st, payload = e.code, e.read()
                    for raw in x.headers.get_all("Set-Cookie") or []:
                        nm, _, rest = raw.partition("=")
                        if "Max-Age=0" in rest:
                            self.jar.pop(nm.strip(), None)
                        else:
                            self.jar[nm.strip()] = rest.split(";")[0]
                    try:
                        return st, json.loads(payload or b"{}")
                    except json.JSONDecodeError:
                        return st, {}

            c = C("10.20.0.1")
            c.req("/api/profile/claim", "POST",
                  {"subject": "profile_math", "onboarded": True, "name": "Токен"})
            st, b = c.req("/api/bootstrap")
            live_cookie = c.jar.get("ege_session")
            t("гость получил живую куку", bool(live_cookie), b)

            conn = server.connect()
            try:
                rows = conn.execute("SELECT token FROM user_sessions").fetchall()
                raw_leaks = [r["token"] for r in rows if not server._is_token_digest(r["token"])]
                t("в user_sessions нет сырых токенов", not raw_leaks, raw_leaks[:2])
                t("в базе вообще есть сессия", len(rows) > 0, len(rows))
                # Хэш токена НЕ равен самому токену и не содержит его.
                t("в базе нет самого токена",
                  all(r["token"] != live_cookie for r in rows),
                  [r["token"][:12] for r in rows[:2]])
                lego = conn.execute(
                    "SELECT value_json FROM app_config WHERE key='device_fingerprint_secret'").fetchone()
                t("секреты в app_config тоже не токены",
                    lego is None or live_cookie not in str(lego["value_json"]), None)
            finally:
                conn.close()

            # Старая (сырая) кука продолжает работать, а подделка — нет.
            class Fake:
                def __init__(self, tok): self.headers = {"X-Forwarded-For": "10.20.0.1",
                                                         "Cookie": f"ege_session={tok}"}
                def __repr__(self): return "Fake"
            conn = server.connect()
            try:
                row = server.session_row_for(conn, live_cookie)
                t("старая кука находит свою сессию после хеширования", row is not None, row)
                t("подделанный токен отклонён",
                   server.session_row_for(conn, "A" * 43) is None)
                # Легаси-строка (заведённая до хеширования) тоже работает и чинится.
                conn.execute("UPDATE user_sessions SET token=? WHERE id=?",
                             (live_cookie, int(row["session_pk"])))
                conn.commit()
                legacy = server.session_row_for(conn, live_cookie)
                t("легаси-строка по сырому токену находится", legacy is not None)
                fixed = conn.execute("SELECT token FROM user_sessions WHERE id=?",
                                     (int(row["session_pk"]),)).fetchone()["token"]
                t("легаси-строка переведена на хэш при обращении",
                   server._is_token_digest(fixed), fixed[:16])
            finally:
                conn.close()
        finally:
            httpd.shutdown()


def main() -> int:
    check_agent_param_order()
    check_health_rate_and_cache()
    check_reset_completeness()
    check_index_self_heal()
    check_support_rebuild_keeps_rows()
    check_token_hashing()
    print("\n" + "=" * 60)
    if FAILED:
        print(f"ПРОВАЛЕНО {len(FAILED)} из {PASSED + len(FAILED)}: db-integrity-security")
        for name in FAILED:
            print(f"  — {name}")
        return 1
    print(f"ЦЕЛОСТНОСТЬ БД OK: {PASSED} проверок "
          "(порядок параметров агента, лимит и кэш /api/health, полнота сброса, "
          "самолечение индексов, сохранность обращений, токены сессий как хэши)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
