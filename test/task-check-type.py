#!/usr/bin/env python3
"""Регрессия явного типа проверки заданий (`check: auto/self`).

Контракт: `check` опционален (по умолчанию `auto` — строгая сверка ответа),
legacy `selfCheck: true` нормализуется в `self` (развёрнутый ответ: поля
ввода нет, сверка с решением). Установка каталога падает с ValueError при
неизвестном `check`, конфликте явного `check` с `selfCheck: true` и фразе
«в ответ запишите» в self-задании. Проверяются сама нормализация и весь
корпус каталогов: ни одно существующее задание не должно ронять загрузчик.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server():
    fd, db_path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    os.environ["EGE_DB_PATH"] = db_path
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_task_check_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_value_error(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return True
    return False


def main() -> int:
    fails = 0

    def t(name: str, cond: bool):
        nonlocal fails
        print(("ok  " if cond else "FAIL") + " " + name)
        if not cond:
            fails += 1

    server = load_server()
    mode = server._task_check_mode

    t("по умолчанию auto", mode({"id": "x"}) == "auto")
    t("legacy selfCheck -> self", mode({"id": "x", "selfCheck": True}) == "self")
    t("явный self", mode({"id": "x", "check": "self"}) == "self")
    t("явный auto", mode({"id": "x", "check": "auto"}) == "auto")
    t("legacy + явный self не конфликтуют",
      mode({"id": "x", "check": "self", "selfCheck": True}) == "self")
    t("неизвестный check роняет загрузку",
      expect_value_error(mode, {"id": "x", "check": "grade-me-later"}))
    t("check:auto + selfCheck:true — конфликт, роняет загрузку",
      expect_value_error(mode, {"id": "x", "check": "auto", "selfCheck": True}))
    t("self + «в ответ запишите» роняет загрузку",
      expect_value_error(mode, {"id": "x", "check": "self",
                                "text": "Реши и в ответ запишите число."}))
    t("auto + «в ответ запишите» допустимо",
      mode({"id": "x", "text": "Реши и в ответ запишите число."}) == "auto")

    catalogs = sorted((ROOT / "server").glob("catalog_*.json"))
    t("каталоги найдены", len(catalogs) >= 4)
    total = 0
    corpus_ok = True
    for path in catalogs:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            print(f"FAIL {path.name}: битый JSON ({exc})")
            corpus_ok = False
            continue
        for task in data.get("tasks", []):
            total += 1
            try:
                check = mode(task)
            except ValueError as exc:
                print(f"FAIL {path.name}:{task.get('id')}: {exc}")
                corpus_ok = False
                continue
            if task.get("selfCheck") and check != "self":
                print(f"FAIL {path.name}:{task.get('id')}: selfCheck без check:self")
                corpus_ok = False
    t(f"весь корпус каталогов проходит нормализацию ({total} заданий)", corpus_ok and total > 0)

    print("TASK-CHECK-TYPE " + ("OK" if fails == 0 else f"FAILURES={fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
