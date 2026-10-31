#!/usr/bin/env python3
"""Регрессия закрытых дыр: капча без plaintext, суточный ИИ-предохранитель.

1. captcha_svg не содержит <text> вообще: код нельзя снять регуляркой из
   разметки (раньше 5 букв лежали открытым текстом и капча решалась
   скриптом за один запрос). Геометрия глифов — только <path>.
2. Каждый символ алфавита даёт непустой path (шрифт не разъехался).
3. ai_spend_daily: атомарный суточный потолок на весь сервис — ровно
   `limit` занятий, refund возвращает слот, 0 выключает предохранитель.
4. Публичный health не отдаёт имена бэкапов/размер БД.

Свои temp-БД, прод не трогает.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "a" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_security_hardening", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    fails: list[str] = []

    def check(name: str, cond: bool, extra=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else f" — {extra}"))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="ege-hardening-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")

        # --- капча: никакого plaintext ---
        svg = server.captcha_svg("AB3K9")
        check("капча: ни одной <text>-ноды", "<text" not in svg, svg[:120])
        check("капча: глифы идут путями", svg.count("<path") >= 5, svg.count("<path"))
        check("капча: SVG остаётся компактной", 1000 < len(svg) < 40000, len(svg))
        bad = [ch for ch in server.CAPTCHA_ALPHABET
               if not server.captcha_glyph_path(ch)]
        check("капча: у всех символов алфавита есть геометрия", not bad, bad)
        check("капча: неизвестный символ не роняет генерацию",
              bool(server.captcha_glyph_path("!")))

        # --- суточный предохранитель ИИ ---
        os.environ["EGE_AI_GLOBAL_DAILY_MAX_ESSAY"] = "2"
        server.ai_global_daily_limit("essay") == 2
        conn = server.connect()
        try:
            day = server.ai_global_day()
            check("ИИ-потолок: первый слот", server.ai_global_budget_take(conn, "essay", day=day))
            check("ИИ-потолок: второй слот", server.ai_global_budget_take(conn, "essay", day=day))
            check("ИИ-потолок: третий отказ",
                  not server.ai_global_budget_take(conn, "essay", day=day))
            st = server.ai_global_budget_status(conn, "essay")
            check("ИИ-потолок: статус 2/2", st["used"] == 2 and st["remaining"] == 0, st)
            server.ai_global_budget_refund(conn, "essay", day=day)
            check("ИИ-потолок: возврат освобождает слот",
                  server.ai_global_budget_take(conn, "essay", day=day))
            # другой вид — отдельный счётчик
            check("ИИ-потолок: essay не съедает agent",
                  server.ai_global_budget_take(conn, "agent", day=day))
        finally:
            conn.close()
        os.environ["EGE_AI_GLOBAL_DAILY_MAX_ESSAY"] = "0"
        conn = server.connect()
        try:
            check("ИИ-потолок: 0 выключает предохранитель",
                  all(server.ai_global_budget_take(conn, "essay") for _ in range(5)))
        finally:
            conn.close()

        # --- суточный потолок новых работ (весь сервис) ---
        os.environ["EGE_ESSAY_GLOBAL_DAILY_MAX"] = "2"
        conn = server.connect()
        try:
            server.ensure_essay_schema(conn)
            day = "2099-01-01"
            check("работы: первый слот", server.essay_store_budget_take(conn, day=day))
            check("работы: второй слот", server.essay_store_budget_take(conn, day=day))
            check("работы: третий отказ",
                  not server.essay_store_budget_take(conn, day=day))
            check("работы: другой день — свой счётчик",
                  server.essay_store_budget_take(conn, day="2099-01-02"))
        finally:
            conn.close()
        os.environ["EGE_ESSAY_GLOBAL_DAILY_MAX"] = "0"
        conn = server.connect()
        try:
            check("работы: 0 выключает потолок",
                  all(server.essay_store_budget_take(conn, day="2099-01-03")
                      for _ in range(5)))
        finally:
            conn.close()

        # --- health без разведданных о бэкапах ---
        health = server.health_payload()
        check("health: нет блока backup", "backup" not in health, health)
        check("health: нет размера БД", "sizeBytes" not in (health.get("db") or {}), health)

    if fails:
        print(f"\nFAILED: {len(fails)}")
        return 1
    print("\nSECURITY HARDENING OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
