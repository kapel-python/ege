#!/usr/bin/env python3
"""Интерактивные уроки (БЕТА): контракт backend-экосистемы.

Проверяет полный цикл без настоящего контента в каталогах (все готовые
каталоги пока без interactiveLessons):
  1. таблицы ilessons/completed_ilessons создаются миграцией;
  2. _upsert_catalog_ilesson: валидация skill, пропуск записей без сцен,
     удаление опустевшей записи, чужой skill отклоняется;
  3. hook в _install_subject_catalog принимает ключ interactiveLessons;
  4. bootstrap (full + summary) несёт только мету без сцен/text;
  5. /api/catalog-ilessons отдаёт полные сцены (200 + ETag/304);
  6. PATCH /api/state-domains принимает completedILessons (чужой id
     отбрасывается), read_state его возвращает;
  7. derive_stats платит xp один раз (анти-фарм как у обычных уроков);
  8. _prune_removed_catalog_rows удаляет урок без прогресса и хранит
     урок с прогрессом.

Свой temp-БД и живой сервер, прод не трогает.
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
    spec = importlib.util.spec_from_file_location("ege_server_ilessons", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, dict(response.headers), json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), json.loads(exc.read() or b"{}")


def main() -> int:
    failures = 0

    def check(name: str, condition: bool, detail: str = "") -> None:
        nonlocal failures
        if not condition:
            failures += 1
        print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)) if detail else ''}")

    with tempfile.TemporaryDirectory(prefix="ege-ilessons-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        conn = server.connect()
        try:
            tables = {r["name"] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            check("schema has ilessons", "ilessons" in tables)
            check("schema has completed_ilessons", "completed_ilessons" in tables)

            skill = conn.execute(
                "SELECT id FROM skills WHERE subject='profile_math' ORDER BY id LIMIT 1").fetchone()["id"]
            other_skill = conn.execute(
                "SELECT id FROM skills WHERE subject != 'profile_math' ORDER BY id LIMIT 1").fetchone()["id"]

            good = {"id": "v-test-01", "skill": skill, "title": "Визуал",
                    "subtitle": "подзаголовок", "xp": 30,
                    "scenes": [{"title": "S1", "text": "hello"},
                               {"text": "world", "visual": {"kind": "svg", "svg": "<svg/>"}}]}
            server._upsert_catalog_ilesson(conn, good, "profile_math")
            row = conn.execute("SELECT * FROM ilessons WHERE id='v-test-01'").fetchone()
            check("upsert stores row", row is not None and row["title"] == "Визуал"
                  and row["subtitle"] == "подзаголовок" and row["xp"] == 30)
            stored = json.loads(row["metadata_json"])
            check("upsert keeps scenes", [s.get("text") for s in stored["scenes"]] == ["hello", "world"])

            # Записи без сцен — не уроки: пропускаются, в БД не появляются.
            server._upsert_catalog_ilesson(conn, {"id": "v-test-empty", "skill": skill,
                                                 "title": "Пустой", "scenes": []}, "profile_math")
            server._upsert_catalog_ilesson(conn, {"id": "v-test-nos", "skill": skill,
                                                 "title": "Без ключа"}, "profile_math")
            check("scene-less rows skipped",
                  conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id IN ('v-test-empty','v-test-nos')").fetchone()["c"] == 0)

            # Чужой skill отклоняется — как у обычных уроков.
            for bad in ({"id": "v-test-bad", "skill": "no-such-skill", "title": "X",
                         "scenes": [{"text": "t"}]},
                        {"id": "v-test-cross", "skill": other_skill, "title": "X",
                         "scenes": [{"text": "t"}]}):
                try:
                    server._upsert_catalog_ilesson(conn, dict(bad), "profile_math")
                    check(f"rejects {bad['id']}", False)
                except ValueError:
                    check(f"rejects {bad['id']}", True)

            # Опустевшая запись удаляется (заглушка возвращается), но прогресс
            # ученика блокирует удаление — как в prune обычных узлов.
            server._upsert_catalog_ilesson(conn, {"id": "v-test-01", "skill": skill,
                                                 "title": "Визуал", "scenes": []}, "profile_math")
            check("emptied row pruned",
                  conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id='v-test-01'").fetchone()["c"] == 0)
            server._upsert_catalog_ilesson(conn, good, "profile_math")

            # Hook установки принимает ключ interactiveLessons из каталога.
            server._install_subject_catalog(
                conn, {"interactiveLessons": [dict(good, id="v-test-02")]},
                "profile_math", level_id="profile", subject_id="profile_math")
            check("install hook accepts key",
                  conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id='v-test-02'").fetchone()["c"] == 1)
            conn.execute("DELETE FROM ilessons WHERE id='v-test-02'")

            # Поле js (интерактивный модуль): roundtrip + строгая валидация
            # имени (имя уходит в URL загрузки скрипта).
            server._upsert_catalog_ilesson(
                conn, dict(good, id="v-test-js", js="v-trig-01"), "profile_math")
            stored_js = json.loads(conn.execute(
                "SELECT metadata_json FROM ilessons WHERE id='v-test-js'").fetchone()["metadata_json"])
            check("js field stored", stored_js.get("js") == "v-trig-01", stored_js.get("js"))
            for bad_js in ("../x", "a b", "<script>", "v_trig", "x" * 65):
                try:
                    server._upsert_catalog_ilesson(
                        conn, dict(good, id="v-test-jsbad", js=bad_js), "profile_math")
                    check(f"js rejected {bad_js!r}", False)
                except ValueError:
                    check(f"js rejected {bad_js!r}", True)
            check("bad js row absent",
                  conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id='v-test-jsbad'").fetchone()["c"] == 0)
            # Пустая строка — не модуль, а отсутствие: валидна, строка живёт.
            server._upsert_catalog_ilesson(
                conn, dict(good, id="v-test-jsempty", js=""), "profile_math")
            check("empty js accepted",
                  conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id='v-test-jsempty'").fetchone()["c"] == 1)
            conn.execute("DELETE FROM ilessons WHERE id='v-test-jsempty'")
            conn.execute("DELETE FROM ilessons WHERE id='v-test-js'")
            conn.commit()
            # Строки, пришедшие мимо install_catalog (фикстура), регистрируем
            # в live-карте вручную — прод-установка делает это сама из файлов.
            server._CATALOG_LIVE_IDS.setdefault("profile_math", {}).setdefault("ilessons", set()).add("v-test-01")

            full = server.catalog_payload(conn, "profile_math")
            meta = [x for x in full.get("interactiveLessons", []) if x.get("id") == "v-test-01"]
            check("full bootstrap carries meta", len(meta) == 1, meta)
            if meta:
                check("meta has scenesCount", meta[0].get("scenesCount") == 2, meta[0])
                check("meta has no scenes/text",
                      "scenes" not in meta[0] and "text" not in meta[0]
                      and "subtitle" not in meta[0], sorted(meta[0]))
            summary = server.catalog_summary_payload(conn, "profile_math")
            check("summary carries same meta",
                  [x for x in summary.get("interactiveLessons", []) if x.get("id") == "v-test-01"] == meta)
            details = server.catalog_ilessons_payload(conn, "profile_math")
            full_rows = [x for x in details.get("interactiveLessons", []) if x.get("id") == "v-test-01"]
            check("details carry scenes", len(full_rows) == 1
                  and [s.get("text") for s in full_rows[0]["scenes"]] == ["hello", "world"], full_rows)
            check("details js defaults empty", len(full_rows) == 1 and full_rows[0].get("js") == "", full_rows)
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        httpd.RequestHandlerClass.log_message = lambda *_a, **_k: None
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            status, headers, body = request(opener, base, "/api/catalog-ilessons?subject=profile_math")
            rows = [x for x in body.get("interactiveLessons", []) if x.get("id") == "v-test-01"]
            check("GET /api/catalog-ilessons 200 + scenes", status == 200 and len(rows) == 1
                  and len(rows[0].get("scenes", [])) == 2, (status, len(rows)))
            etag = headers.get("ETag") or headers.get("Etag")
            if etag:
                status2, _, _ = request(opener, base, "/api/catalog-ilessons?subject=profile_math",
                                        headers={"If-None-Match": etag})
                check("ETag revalidates 304", status2 == 304, status2)
            else:
                check("ETag present", False, sorted(headers))

            status, _, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Ученик",
                "selfLevel": "base", "goal": "g60"})
            assert status == 200, (status, claimed)

            conn = server.connect()
            try:
                version = server.read_state(conn, 1, "profile_math")["stateVersion"]
            finally:
                conn.close()
            status, _, patched = request(opener, base, "/api/state-domains", "PATCH", {
                "subject": "profile_math", "expectedVersion": version,
                "domains": {"completedILessons": {"v-test-01": {"ts": 1700000000000},
                                                 "v-bogus": {"ts": 1}}}})
            check("PATCH completedILessons accepted", status == 200, (status, patched))

            conn = server.connect()
            try:
                state = server.read_state(conn, 1, "profile_math")
                check("read_state returns completion",
                      state.get("completedILessons", {}).get("v-test-01", {}).get("ts") is not None,
                      state.get("completedILessons"))
                check("bogus id dropped", "v-bogus" not in state.get("completedILessons", {}))
                xp_once = server.derive_stats(conn, state, 1)["xp"]
                check("derive pays ilesson xp once", xp_once == 30, xp_once)
            finally:
                conn.close()

            # Повторная отправка той же записи XP не добавляет (анти-фарм).
            conn = server.connect()
            try:
                version = server.read_state(conn, 1, "profile_math")["stateVersion"]
            finally:
                conn.close()
            status, _, _ = request(opener, base, "/api/state-domains", "PATCH", {
                "subject": "profile_math", "expectedVersion": version,
                "domains": {"completedILessons": {"v-test-01": {"ts": 1700000000000}}}})
            conn = server.connect()
            try:
                xp_twice = server.derive_stats(conn, server.read_state(conn, 1, "profile_math"), 1)["xp"]
                check("replay adds no xp", xp_twice == xp_once, (xp_once, xp_twice))
            finally:
                conn.close()

            # Prune: урок без прогресса уходит, урок с прогрессом живёт.
            conn = server.connect()
            try:
                server._upsert_catalog_ilesson(conn, dict(good, id="v-test-gone"), "profile_math")
                conn.commit()
                keep = {t: {r["id"] for r in conn.execute(f"SELECT id FROM {t}")}
                        for t in ("lessons", "missions", "tasks", "skills", "topics")}
                loaded = {"profile_math": {
                    "lessons": [{"id": i} for i in keep["lessons"]],
                    "missions": [{"id": i} for i in keep["missions"]],
                    "tasks": [{"id": i} for i in keep["tasks"]],
                    "skills": [{"id": i} for i in keep["skills"]],
                    "categories": [{"id": i} for i in keep["topics"]],
                    "interactiveLessons": [{"id": "v-test-01"}],
                }}
                server._prune_removed_catalog_rows(conn, loaded)
                conn.commit()
                gone = conn.execute("SELECT COUNT(*) AS c FROM ilessons WHERE id='v-test-gone'").fetchone()["c"]
                kept = conn.execute("SELECT COUNT(*) AS c FROM completed_ilessons WHERE ilesson_id='v-test-01'").fetchone()["c"]
                check("prune removes unused ilesson", gone == 0, gone)
                check("prune keeps ilesson with progress", kept == 1, kept)
            finally:
                conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()

    print("FAILURES: %d" % failures if failures else "ALL ILESSONS OK")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
