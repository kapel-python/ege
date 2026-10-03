#!/usr/bin/env python3
"""История сочинений GET /api/essays?history=1 (функции + контракт).

Проверяет лёгкий срез essay_history_list на temp-БД без HTTP и живых
провайдеров:
  * пустая история: items [], total 0, hasEssayTasks True, essaySkills —
    только живой навык каталога;
  * призрак прошлого (навык+задания, удалённые из файлов, но живые в БД
    из-за чужого прогресса): в essaySkills его нет — иначе кнопка
    «Написать следующее» уходила в пустой банк и тост вместо практики
    (живой случай: russian_essay перед russian_essay_source);
  * гость (None): пустой срез;
  * пагинация: кривой limit/offset — ValueError, а не 500.
"""
from __future__ import annotations

import importlib.util
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_essay_history_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    with tempfile.TemporaryDirectory(prefix="ege-essay-hist-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
            out = server.essay_history_list(conn, 1, "russian")
            check("EMPTY items/total", out.get("items") == [] and out.get("total") == 0,
                  str({k: out.get(k) for k in ("total", "limit", "offset")}))
            check("EMPTY hasEssayTasks", out.get("hasEssayTasks") is True)
            check("EMPTY essaySkills live only", out.get("essaySkills") == ["russian_essay_source"],
                  str(out.get("essaySkills")))

            # Призрак прошлого: как продовая пара russian_essay / re_* —
            # удалён из файлов, но строка в БД жива (чужой прогресс).
            conn.execute(
                "INSERT INTO skills(id, topic_id, level_id, name, display_order, subject)"
                " VALUES ('russian_essay','russian_writing','russian','Итоговое сочинение',0,'russian')")
            conn.execute(
                "INSERT INTO tasks(id, skill_id, topic, difficulty, statement, answer,"
                " explanation, task_type, metadata_json)"
                " VALUES ('re_9_9','russian_essay','t',1,'s','a','e','long_text','{}')")
            conn.commit()
            out = server.essay_history_list(conn, 1, "russian")
            check("GHOST skill excluded", out.get("essaySkills") == ["russian_essay_source"],
                  str(out.get("essaySkills")))
            check("GHOST hasEssayTasks stays true", out.get("hasEssayTasks") is True)

            out = server.essay_history_list(conn, None, "russian")
            check("GUEST empty slice", out.get("items") == [] and out.get("total") == 0)

            for bad in ({"limit": 999}, {"limit": 0}, {"offset": -1}):
                try:
                    server.essay_history_list(conn, 1, "russian", **bad)
                    check(f"BAD {bad} -> ValueError", False, "no exception")
                except ValueError:
                    check(f"BAD {bad} -> ValueError", True)
        finally:
            conn.close()
    print(f"ALL OK: {checks} checks" if not failures else f"{failures} FAILURES: {checks} checks")
    raise SystemExit(1 if failures else 0)


main()
