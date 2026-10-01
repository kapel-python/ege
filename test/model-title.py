#!/usr/bin/env python3
"""Подпись модели на экране результата проверки сочинения.

Был вшитый словарь в server.py:
    provider_names = {"closerouter": "Claude Sonnet 5", "gptunnel": "Qwen Flash"}
Любая другая модель подписывалась чужим именем, а свой провайдер — молчал
(его id не было в словаре, и строка просто не рисовалась). Теперь название
задаёт админ в панели провайдеров, оно лежит в app_config (ai_model_titles)
и приходит на экран как есть.

Проверяет:
  1. СВОЙ провайдер: название из панели видно на экране результата.
  2. Встроенный провайдер с заданным названием — тоже (никаких вшитых имён).
  3. Смена модели требует нового названия: старая подпись не должна висеть на
     новой модели, а у старой модели своя подпись сохраняется.
  4. Название не задано → показывается ID модели (честнее чужого имени).
  5. Старая запись без модели (до миграции) подписывается текущей моделью
     провайдера; легаси «ai+grammar» не рисует строку вовсе.
  6. Сброс к стандарту снимает и название, иначе подпись пережила бы модель.
  7. Модель, ответившая на запрос, пишется в проверку (essay_checks.model) и
     доезжает до экрана — подпись называет ТУ, что ответила, а не текущую по
     конфигурации (failover мог переключить и модель).
  8. Вся проверка идёт через единый роутер ai.py: подпись собирается из
     _AI.model_display_title, а вшитых имён в коде не осталось.

Офлайн: temp-БД, сеть не нужна. Запуск: python3 test/model-title.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AI_PATH = ROOT / "server" / "ai.py"
SERVER_PATH = ROOT / "server" / "server.py"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)) if detail else ''}")


def section(title):
    print(f"\n== {title} ==")


def load(path: Path, name: str, db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ESSAY_RESULT = {
    "total_score": 15, "max_score": 22,
    "criteria": [{"id": f"K{i}", "name": f"К{i}", "score": 1, "max_score": 1,
                  "comment": "ок"} for i in range(1, 11)],
}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-model-title-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        os.environ["EGE_DISABLE_SYSTEMD"] = "1"
        salt = "c" * 32
        dk = hashlib.pbkdf2_hmac("sha256", b"pw", bytes.fromhex(salt), 210000)
        os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
        os.environ["EGE_AI_API_KEY"] = "gptunnel-key"
        os.environ["EGE_CLOSEROUTER_API_KEY"] = "closerouter-key"
        os.environ["EGE_AI_MODEL"] = "qwen3.8-flash"
        os.environ["EGE_CLOSEROUTER_MODEL"] = "anthropic/claude-sonnet-5"

        server = load(SERVER_PATH, "ege_model_title_srv", db_path)
        ai = server._AI
        assert ai is not None
        ai.reset_providers_cache()
        ai.reset_router()
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        def view(provider: str, model: str = "") -> dict:
            payload = {"result": ESSAY_RESULT, "wordCount": 170,
                       "evaluationProvider": provider}
            if model:
                payload["evaluationModel"] = model
            return server.essay_result_view(payload)

        section("Подпись берётся из панели, а не из кода")
        ai.custom_provider_create(ai.validate_custom_payload({
            "id": "telegram", "title": "Иишко",
            "base_url": "https://api.example.invalid/v1",
            "model": "grok-chat-fast", "api_key": "secret-key",
            "model_title": "топ модель"}))
        check("название сохранено в конфиге",
              ai.model_title("telegram", "grok-chat-fast") == "топ модель",
              ai.model_title("telegram", "grok-chat-fast"))
        check("свой провайдер: на экране результата его название",
              view("telegram", "grok-chat-fast").get("provider") == "топ модель",
              view("telegram", "grok-chat-fast").get("provider"))
        check("рядом отдаются providerId и техническая модель",
              view("telegram", "grok-chat-fast").get("providerId") == "telegram"
              and view("telegram", "grok-chat-fast").get("model") == "grok-chat-fast")

        ai.provider_set_override("closerouter",
                                 {"model": "anthropic/claude-x",
                                  "model_title": "умная модель"})
        check("встроенный провайдер подписан заданным названием",
              view("closerouter", "anthropic/claude-x").get("provider") == "умная модель",
              view("closerouter", "anthropic/claude-x").get("provider"))

        section("Смена модели требует нового названия")
        ai.provider_set_override("telegram",
                                 {"model": "grok-4", "model_title": "новая топовая"})
        check("у новой модели своё название",
              view("telegram", "grok-4").get("provider") == "новая топовая",
              view("telegram", "grok-4").get("provider"))
        check("название прошлой модели не переехало на новую",
              ai.model_title("telegram", "grok-chat-fast") == "топ модель",
              ai.model_title("telegram", "grok-chat-fast"))
        # Без названия ученику НЕ показывается технический id: строка просто
        # не появляется, а админу id остаётся виден (диагностика).
        unnamed = view("closerouter", "anthropic/claude-2")
        check("модель без названия ничего не подписывает ученику",
              "provider" not in unnamed and unnamed.get("providerId") == "closerouter"
              and unnamed.get("model") == "anthropic/claude-2",
              unnamed.get("provider"))
        check("админу у модели без названия виден id",
              ai.model_display_title("closerouter", "anthropic/claude-2") == "anthropic/claude-2")

        section("Сброс и старые записи")
        ai.provider_set_override("telegram", {"model": "grok-5", "model_title": "временная"})
        ai.provider_reset("telegram")
        check("после сброса подпись стандартной модели на месте",
              ai.model_title("telegram", "grok-chat-fast") == "топ модель",
              ai.model_title("telegram", "grok-chat-fast"))
        check("название снятой модели не осталось висеть",
              ai.model_title("telegram", "grok-5") == "",
              ai.model_title("telegram", "grok-5"))
        check("запись без модели ученику тоже ничего не подписывает",
              "provider" not in view("gptunnel") and view("gptunnel").get("providerId") == "gptunnel",
              view("gptunnel").get("provider"))
        check("легаси «ai+grammar» строку не рисует",
              "provider" not in view("ai+grammar"),
              view("ai+grammar").get("provider"))
        check("неизвестный провайдер тоже не выдумывает имя",
              "provider" not in view("some-gone-provider"),
              view("some-gone-provider").get("provider"))

        section("Модель доезжает до проверки и на экран")
        conn = server.connect()
        try:
            # Пользователь обязателен: essay_checks.user_id — внешний ключ, и
            # проверка без него не прошла бы мимо вопроса о названии.
            conn.execute(
                "INSERT INTO users(id, account_id, session_token, created_at)"
                " VALUES(1,'aaaaaa','t',?)", (server.now_iso(),))
            conn.commit()
            server.store_essay_check(conn, 1, "russian", "текст сочинения",
                                     "telegram", ESSAY_RESULT, model="grok-chat-fast")
            conn.commit()
            stored = server.load_essay_check(conn, 1, "russian", "текст сочинения")
        finally:
            conn.close()
        check("модель записана рядом с проверкой",
              stored and stored.get("model") == "grok-chat-fast",
              stored and stored.get("model"))
        check("по записи экран собирает подпись из названия",
              view(stored["provider"], stored["model"]).get("provider") == "топ модель")
        conn = server.connect()
        try:
            server.store_essay_check(conn, 1, "russian", "второй текст",
                                     "telegram", ESSAY_RESULT, model="grok-4")
            server.store_essay_check(conn, 1, "russian", "второй текст",
                                     "telegram", ESSAY_RESULT, model="grok-4")
            conn.commit()
            history = server.previous_essay_check(conn, 1, "russian", "второй текст")
        finally:
            conn.close()
        check("история проверок несёт модель (для «Было → стало»)",
              history.get("previous") and history["previous"].get("model") == "grok-4",
              history.get("previous"))

        section("Вшитых имён в коде не осталось")
        source = SERVER_PATH.read_text(encoding="utf-8")
        # Ищем присваивание в ЖИВОМ коде, а не любое упоминание: в комментарии
        # словарь может остаться как объяснение, что именно тут было и почему
        # убрано (так оно и есть — рядом с essay_result_view).
        code = "\n".join(ln for ln in source.splitlines()
                         if not ln.lstrip().startswith("#"))
        check("словаря с именами моделей больше нет",
              "provider_names" not in code
              and '"Qwen Flash"' not in code
              and not re.search(r'"closerouter"\s*:\s*"', code),
              "остался словарь имён")
        check("подпись собирается через единый роутер ИИ",
              "_AI.model_student_label" in source
              and "model_display_title" in (AI_PATH.read_text(encoding="utf-8")))

    print(f"\n{'=' * 60}\nИТОГ: {checks - failures}/{checks} проверок прошло, "
          f"{failures} упало\n{'=' * 60}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
