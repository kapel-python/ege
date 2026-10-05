#!/usr/bin/env python3
"""Статус ИИ на странице /status: агент, инструменты, провайдеры.

Проверяет _build_public_status на живом сервере с temp-БД (прод не трогается):
  * строки agent / agent-tools / ai-providers есть, форма {id,label,ok,detail};
  * строки subscription нет осознанно (биллинг — не работа сервиса);
  * инструменты покрыты реализациями (все из AGENT_TOOLS, без missing);
  * провайдеры без ключей — честное «не настроены», а не зелёное;
  * последнее известное решает: успех новее ошибки — ok, иначе — ошибка;
  * записей нет — «нет данных», а не «всё хорошо»;
  * два подряд вызова детерминированы (никаких живых проб при чтении);
  * гостю /api/status доступен без сессии.

Всё — только метками времени в памяти, ни одного сетевого вызова.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

for key in ("EGE_CLOSEROUTER_API_KEY", "EGE_AI_API_KEY", "AI_API_KEY",
            "EGE_CLOSEROUTER_BASE_URL", "EGE_AI_BASE_URL",
            "EGE_CLOSEROUTER_MODEL", "EGE_AI_MODEL"):
    os.environ.pop(key, None)
os.environ["EGE_TRUSTED_PROXY"] = "1"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    extra = f" | {detail}" if detail != "" else ""
    print(f"{'PASS' if condition else 'FAIL'} {name}{extra}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_status_agent", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def raw(base, path):
    req = urllib.request.Request(base + path, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def status(base):
    code, body = raw(base, "/api/status")
    assert code == 200, (code, body[:200])
    return json.loads(body)


def services(base):
    return {s["id"]: s for s in status(base)["services"]}


def main():
    with tempfile.TemporaryDirectory(prefix="ege-status-agent-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        assert server._AGENT is not None, "модуль агента не загрузился"
        assert server._AI is not None, "модуль ИИ не загрузился"
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            svc = services(base)
            for sid in ("agent", "agent-tools", "ai-providers"):
                s = svc.get(sid) or {}
                check(f"строка {sid} в форме",
                      set(("id", "label", "ok", "detail")) <= set(s), s)
            check("строки subscription нет",
                  not [k for k in svc if "sub" in k], sorted(svc))
            check("инструменты покрыты",
                  svc["agent-tools"]["ok"] is True
                  and str(len(server._AGENT.AGENT_TOOLS)) in svc["agent-tools"]["detail"]
                  and "из" not in svc["agent-tools"]["detail"],
                  svc["agent-tools"]["detail"])
            check("агент готов", svc["agent"]["ok"] is True, svc["agent"]["detail"])
            check("без ключей — не настроены",
                  svc["ai-providers"]["ok"] is False
                  and "не настроены" in svc["ai-providers"]["detail"],
                  svc["ai-providers"]["detail"])

            # Конфигурируем один провайдер фейковым ключом (сети нет —
            # важны только метки времени) и играем прошлым.
            os.environ["EGE_AI_API_KEY"] = "test-key"
            server._AI.reset_providers_cache()
            now = int(time.time() * 1000)
            ai = server._AI
            ai._provider_last_ok.clear()
            ai._provider_last_err.clear()
            svc = services(base)
            check("записей нет — честное не-знание",
                  svc["ai-providers"]["ok"] is False
                  and "Нет данных" in svc["ai-providers"]["detail"],
                  svc["ai-providers"]["detail"])

            ai._provider_last_ok[("free", "gptunnel")] = now - 300_000
            svc = services(base)
            check("последний успех — успешно",
                  svc["ai-providers"]["ok"] is True
                  and "успешен" in svc["ai-providers"]["detail"],
                  svc["ai-providers"]["detail"])

            ai._provider_last_err[("free", "gptunnel")] = (now - 60_000, "AIError: boom")
            svc = services(base)
            check("ошибка новее — ошибка",
                  svc["ai-providers"]["ok"] is False
                  and "ошибка" in svc["ai-providers"]["detail"],
                  svc["ai-providers"]["detail"])

            ai._provider_last_ok[("free", "gptunnel")] = now
            first = services(base)["ai-providers"]
            second = services(base)["ai-providers"]
            check("успех новее — снова успешно", first["ok"] is True, first["detail"])
            check("повтор детерминирован",
                  first["detail"] == second["detail"], first["detail"])

            # Живой случай 04.10: весь трафик идёт в Plus-тире, а stale-ошибка
            # висит во free. После рестарта (память пуста) статус обязан брать
            # максимум по обоим тирам, а не врать по одному free.
            ai._provider_last_ok.clear()
            ai._provider_last_err.clear()
            ai.reset_router()
            ai._router_update({"lastErrorAt": now - 3_600_000}, "free")
            ai._router_update({"lastOkAt": now - 600_000}, "plus")
            ai.reset_router()
            svc = services(base)
            check("успех Plus новее stale-ошибки free — успешно",
                  svc["ai-providers"]["ok"] is True, svc["ai-providers"]["detail"])

            # То же без рестарта, но наоборот: свежая ошибка free при живом
            # успехе Plus обязана честно краснеть (побеждает последняя запись).
            ai._router_update({"lastErrorAt": now}, "free")
            ai.reset_router()
            svc = services(base)
            check("свежая ошибка free — ошибка",
                  svc["ai-providers"]["ok"] is False, svc["ai-providers"]["detail"])

            # Переживание рестарта: успех живого трафика пишется в персистентные
            # метки тем же апдейтом — после wipe памяти статус остаётся зелёным.
            ai._provider_last_ok.clear()
            ai._provider_last_err.clear()
            ai.reset_router()
            ai._note_provider_success("gptunnel", "free")
            ai._provider_last_ok.clear()
            ai._provider_last_err.clear()
            ai.reset_router()
            svc = services(base)
            check("успех пережил рестарт — успешно",
                  svc["ai-providers"]["ok"] is True, svc["ai-providers"]["detail"])

            # Ручная проба ненастроенного провайдера (сети нет — ранний возврат)
            # не трогает метки живого трафика и не красит статус.
            ai._provider_last_ok.clear()
            ai._provider_last_err.clear()
            ai.reset_router()
            os.environ.pop("EGE_AI_API_KEY", None)
            server._AI.reset_providers_cache()
            res = ai.probe_provider("gptunnel", tier="free")
            check("проба без ключа — ранний возврат", res["ok"] is False, res["error"])
            check("ручная проба не пишет метки трафика",
                  not ai._provider_last_ok and not ai._provider_last_err,
                  f"{ai._provider_last_ok} {ai._provider_last_err}")

            # Тексты ошибок и ключи наружу не едут.
            blob = json.dumps(status(base), ensure_ascii=False)
            check("без утечек", "test-key" not in blob and "boom" not in blob)
        finally:
            httpd.shutdown()
            httpd.server_close()
    print(f"\n{checks - failures}/{checks} ok")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
