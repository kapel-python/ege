#!/usr/bin/env python3
"""Удаление провайдеров: встроенные и свои удаляются одинаково + восстановление.

Офлайн, temp-БД (паттерн из test/ai-tiers.py):
  * DELETE встроенного пишет метку ai_deleted_providers, а не стирает код:
    провайдер исчезает из overview/known_provider_ids/effective_priority/
    _spec_for/слотов; правка/сброс/проба по нему идут путём 404 (KeyError);
  * restore снимает метку; restore неудалённого или своего — ValueError;
  * удаление в одном направлении не трогает другое (как у своих);
  * свой удаляется по-старому (запись стёрта из ai_custom_providers);
  * неизвестный id — KeyError в обе стороны.
Двойное подтверждение — фронтенд (модалка с вводом ID в js/admin.js),
здесь не покрывается.
"""
from __future__ import annotations

import importlib.util
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

tmp = tempfile.mkdtemp(prefix="ege-provider-delete-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
# Оба встроенных «настроены»: без ключей они и так вне ротации.
os.environ["EGE_CLOSEROUTER_API_KEY"] = "test-closerouter-key"
os.environ["EGE_AI_API_KEY"] = "test-gptunnel-key"

spec = importlib.util.spec_from_file_location("ege_ai_pdel", ROOT / "server" / "ai.py")
assert spec and spec.loader
ai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai)

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail))[:220] if detail else ''}")


def ids(tier):
    return [p["id"] for p in ai.providers_overview(tier)["providers"]]


# --- исходное состояние -------------------------------------------------
check("оба встроенных в списке free",
      "closerouter" in ids("free") and "gptunnel" in ids("free"), ids("free"))
check("оба настроены", ai._provider_configured("closerouter", "free")
      and ai._provider_configured("gptunnel", "free"))
check("стандартные слоты материализованы",
      ai.providers_overview("free")["slots"].get("high") == "closerouter")

# --- удаление встроенного ------------------------------------------------
ai.provider_delete("closerouter", "free")
check("closerouter исчез из overview", "closerouter" not in ids("free"), ids("free"))
check("gptunnel на месте", "gptunnel" in ids("free"))
check("метка видна в overview",
      ai.providers_overview("free").get("deletedBuiltin") == ["closerouter"])
check("provider_deleted true", ai.provider_deleted("closerouter", "free") is True)
check("known_provider_ids без удалённого",
      "closerouter" not in ai.known_provider_ids("free"))
check("ротация без удалённого",
      "closerouter" not in ai.effective_priority("free"))
try:
    ai._spec_for("closerouter", "free")
    check("_spec_for удалённого молчит", False)
except KeyError:
    check("_spec_for удалённого молчит", True)
check("слот освобождён",
      ai.providers_overview("free")["slots"].get("high") is None)
for fn in (lambda: ai.provider_set_enabled("closerouter", True, "free"),
           lambda: ai.provider_set_override("closerouter", {"model": "x"}, "free"),
           lambda: ai.provider_reset("closerouter", "free")):
    try:
        fn()
        check("правка удалённого упирается в 404-путь", False, fn)
    except KeyError:
        check("правка удалённого упирается в 404-путь", True)
try:
    ai.providers_set_slots({"high": "closerouter", "medium": None, "low": None}, "free")
    check("слот на удалённый отклоняется", False)
except ValueError:
    check("слот на удалённый отклоняется", True)
try:
    ai.custom_provider_create(ai.validate_custom_payload(
        {"id": "closerouter", "title": "t", "base_url": "https://x.example",
         "model": "m", "api_key": "k"}, tier="free"), "free")
    check("id встроенного не занимается своим", False)
except ValueError:
    check("id встроенного не занимается своим", True)
check("судья переехал на живого",
      ai.judge_provider("free") == "gptunnel", ai.judge_provider("free"))

# --- восстановление ------------------------------------------------------
card = ai.provider_restore("closerouter", "free")
check("restore вернул карточку", card.get("id") == "closerouter")
check("снова в списке", "closerouter" in ids("free"))
check("метка снята", ai.providers_overview("free").get("deletedBuiltin") == [])
try:
    ai.provider_restore("closerouter", "free")
    check("повторный restore отклоняется", False)
except ValueError:
    check("повторный restore отклоняется", True)
try:
    ai.provider_restore("gptunnel", "free")
    check("restore неудалённого отклоняется", False)
except ValueError:
    check("restore неудалённого отклоняется", True)

# --- свой: стирается по-настоящему --------------------------------------
clean = ai.validate_custom_payload(
    {"id": "tmpgw", "title": "tmp", "base_url": "https://tmp.example",
     "model": "m", "api_key": "k"}, tier="free")
ai.custom_provider_create(clean, "free")
ai.provider_set_enabled("tmpgw", False, "free")
check("свой создан и выключен", "tmpgw" in ids("free")
      and ai._provider_enabled("tmpgw", "free") is False)
ai.provider_delete("tmpgw", "free")
check("свой стёрт", "tmpgw" not in ids("free"))
ai.custom_provider_create(clean, "free")
check("повторное добавление того же id — снова включён",
      ai._provider_enabled("tmpgw", "free") is True)
ai.provider_delete("tmpgw", "free")
try:
    ai.provider_restore("tmpgw", "free")
    check("свой не восстанавливается", False)
except ValueError:
    check("свой не восстанавливается", True)

# --- неизвестный id -------------------------------------------------------
for fn in (lambda: ai.provider_delete("nosuch", "free"),
           lambda: ai.provider_restore("nosuch", "free")):
    try:
        fn()
        check("неизвестный id отклоняется", False)
    except (KeyError, ValueError):
        check("неизвестный id отклоняется", True)

# --- изоляция направлений --------------------------------------------------
_ = ai.providers_overview("plus")  # клон free при первом обращении
ai.provider_delete("closerouter", "plus")
check("удаление в plus не трогает free",
      "closerouter" in ids("free") and "closerouter" not in ids("plus"))
check("метка только в plus",
      ai.provider_deleted("closerouter", "plus") is True
      and ai.provider_deleted("closerouter", "free") is False)
ai.provider_restore("closerouter", "plus")
check("restore в plus не трогает free",
      "closerouter" in ids("plus") and "closerouter" in ids("free"))

print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
