#!/usr/bin/env python3
"""Два направления маршрутизации (free/Plus): изоляция конфигов и трафика.

Офлайн, temp-БД, фейковый urlopen вместо сети:
  * free живёт на исторических ключах, plus стартует их клоном и дальше
    независим (провайдеры, слоты, выключатели, цепочки, названия, судья,
    active, fails);
  * chat()/chat_with_tools() идут в URL своего направления (перепутанный
    тир означал бы чужие деньги и чужого судью — проверяем в обе стороны);
  * failover одного направления не двигает active другого;
  * as_judge берёт судью своего направления;
  * неизвестный тир = free (дефолт транспорта).
"""
from __future__ import annotations

import importlib.util
import json
import os
import ast
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

tmp = tempfile.mkdtemp(prefix="ege-ai-tiers-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")

spec = importlib.util.spec_from_file_location("ege_ai_tiers", ROOT / "server" / "ai.py")
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


class FakeHTTP:
    def __init__(self):
        self.requests: list = []
        self._real = ai.urllib.request.urlopen

    def __enter__(self):
        ai.urllib.request.urlopen = self._fake
        return self

    def __exit__(self, *exc):
        ai.urllib.request.urlopen = self._real
        return False

    def _fake(self, request, timeout=None):
        try:
            body = json.loads(request.data.decode("utf-8")) if request.data else {}
        except (ValueError, UnicodeDecodeError, AttributeError):
            body = {}
        self.requests.append({"url": request.full_url, "body": body})
        return _FakeResp({"choices": [{"message": {"content": "ok"}}]})


class _FakeResp:
    def __init__(self, payload: dict):
        self._raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._off = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *args):
        n = args[0] if args and args[0] is not None and args[0] >= 0 else len(self._raw)
        chunk, self._off = self._raw[self._off:self._off + n], self._off + n
        return chunk


def make_provider(pid, base, tier):
    clean = ai.validate_custom_payload({
        "id": pid, "title": pid, "base_url": base, "model": "m",
        "api_key": "k-" + pid, "auth": "bearer", "slot": None,
    }, tier=tier)
    return ai.custom_provider_create(clean, tier)


def _load_server_module():
    """Живой server.py на той же temp-БД (как в ai-agent.py): для ai_tier_for."""
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location(
        "ege_server_tiers", ROOT / "server" / "server.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _positional_tier_mismatches() -> list:
    """Все вызовы fn(..., tier) позиционно, где у fn в этом слоте не tier.

    Возвращает [(файл, строка, вызов)] — пусто означает порядок соблюдён.
    Исключения осознанные: _normalize_tier(tier) принимает что угодно,
    _tier_key(base, tier) держит тир вторым по контракту.
    """
    out = []
    for rel in ("server/ai.py", "server/server.py"):
        tree = ast.parse((ROOT / rel).read_text())
        sigs: dict[str, list] = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                params = [a.arg for a in node.args.args]
                if node.args.vararg:
                    params.append("*" + node.args.vararg.arg)
                params += [a.arg for a in node.args.kwonlyargs]
                sigs[node.name] = params
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.attr if isinstance(fn, ast.Attribute) else (
                fn.id if isinstance(fn, ast.Name) else "")
            if not name or name not in sigs or name in ("_normalize_tier", "_tier_key"):
                continue
            params = sigs[name]
            for idx, arg in enumerate(node.args):
                if isinstance(arg, ast.Name) and arg.id == "tier":
                    slot = params[idx] if idx < len(params) else None
                    if slot != "tier" and not (slot or "").startswith("*"):
                        out.append((rel, node.lineno,
                                    f"{name}(позиция {idx} = {slot})"))
    return out


def main() -> int:
    check("тир нормализуется (мусор = free)",
          ai._normalize_tier(None) == "free" and ai._normalize_tier("PLUS") == "plus"
          and ai._normalize_tier("free") == "free" and ai._normalize_tier(" x ") == "free")
    check("ключи: free исторические, plus с префиксом",
          ai._tier_key("ai_custom_providers", "free") == "ai_custom_providers"
          and ai._tier_key("ai_custom_providers", "plus") == "ai_plus_custom_providers"
          and ai._tier_key("ai_router", "plus") == "ai_plus_router")

    # free первым: plus ещё пуст
    make_provider("freegw", "https://free.test/v1", "free")
    ai.providers_set_slots({"high": "freegw", "medium": None, "low": None}, "free")
    ov_plus = ai.providers_overview("plus")
    check("plus стартует клоном free (тот же провайдер и слоты)",
          any(p["id"] == "freegw" for p in ov_plus["providers"])
          and ov_plus["slots"].get("high") == "freegw"
          and ov_plus.get("tier") == "plus",
          str(ov_plus["slots"]))
    ov_free = ai.providers_overview("free")
    check("free не задет клонированием", ov_free.get("tier") == "free"
          and any(p["id"] == "freegw" for p in ov_free["providers"]))

    # изоляция записей: plus-провайдер невидим во free
    make_provider("plusgw", "https://plus.test/v1", "plus")
    check("запись plus невидима во free",
          not any(p["id"] == "plusgw" for p in ai.providers_overview("free")["providers"])
          and any(p["id"] == "plusgw" for p in ai.providers_overview("plus")["providers"]))
    ai.providers_set_slots({"high": "plusgw", "medium": None, "low": None}, "plus")
    check("слоты независимы",
          ai.providers_overview("free")["slots"].get("high") == "freegw"
          and ai.providers_overview("plus")["slots"].get("high") == "plusgw")
    check("роутеры независимы",
          ai.effective_priority("free")[0] == "freegw"
          and ai.effective_priority("plus")[0] == "plusgw")

    # судья независим
    ai.judge_provider_set("freegw", "free")
    ai.judge_provider_set("plusgw", "plus")
    check("судья свой у каждого направления",
          ai.judge_provider("free") == "freegw" and ai.judge_provider("plus") == "plusgw"
          and ai.judge_providers_order("free")[0] == "freegw"
          and ai.judge_providers_order("plus")[0] == "plusgw")

    # трафик идёт в URL своего направления — в обе стороны
    with FakeHTTP() as fake:
        ai.chat([{"role": "user", "content": "hi"}])
        ai.chat([{"role": "user", "content": "hi"}], tier="plus")
        ai.chat([{"role": "user", "content": "hi"}], as_judge=True)
        ai.chat([{"role": "user", "content": "hi"}], as_judge=True, tier="plus")
    urls = [r["url"] for r in fake.requests]
    check("4 вызова ушли по своим направлениям",
          urls == ["https://free.test/v1/chat/completions",
                   "https://plus.test/v1/chat/completions",
                   "https://free.test/v1/chat/completions",
                   "https://plus.test/v1/chat/completions"], str(urls))

    # failover free не двигает active plus
    ai._router_update({"active": "freegw"}, "free")
    ai._router_update({"active": "plusgw"}, "plus")
    ai._note_provider_failure("freegw", ai.AIError("провайдер недоступен: X"), None, "free")
    check("отказ во free не трогает active plus",
          ai.active_provider("free") == "freegw"
          and ai.active_provider("plus") == "plusgw",
          f"{ai.active_provider('free')} / {ai.active_provider('plus')}")
    check("счётчик fails живёт в своём роутере",
          ai._fails_counts("free").get("freegw", 0) >= 1
          and ai._fails_counts("plus").get("freegw", 0) == 0,
          f"{ai._fails_counts('free')} / {ai._fails_counts('plus')}")

    # выключатель и удаление — тоже в своём направлении
    ai.provider_set_enabled("freegw", False, "plus")
    check("выключение в plus не гасит free",
          ai._provider_enabled("freegw", "free") is True
          and ai._provider_enabled("freegw", "plus") is False)
    ai.provider_set_enabled("freegw", True, "plus")
    ai.custom_provider_delete("plusgw", "plus")
    check("удаление в plus не трогает free",
          any(p["id"] == "freegw" for p in ai.providers_overview("free")["providers"])
          and not any(p["id"] == "plusgw" for p in ai.providers_overview("plus")["providers"]))

    # Класс багов «тир не в тот позиционный слот» (поймано живьём:
    # probe_models_stream(pid, wanted, tier) клал tier в budget и молча ломал
    # пинг): tier нравится только по имени — keyword либо точная позиция.
    bad = _positional_tier_mismatches()
    check("позиционный tier стоит ровно в слот tier во всех вызовах", not bad, str(bad[:3]))

    # Маппинг подписка → направление на живом server.py (temp-БД, без HTTP):
    # активна/отменённая-но-действующая → plus, всё остальное → free.
    server = _load_server_module()
    conn = server.connect()
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,"
                     " session_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)")
        for uid in (11, 12, 13):
            conn.execute("INSERT OR IGNORE INTO users(id, session_token, created_at)"
                         " VALUES(?, ?, '2026-01-01')", (uid, f"tier-test-{uid}"))
        now = int(__import__("time").time() * 1000)
        server._SUB.ensure_subscription_schema(conn)
        conn.execute("INSERT INTO subscriptions(user_id, plan, status, period,"
                     " started_at_ms, expires_at_ms, created_at_ms, updated_at_ms)"
                     " VALUES(11, 'plus', 'active', 'month', ?, ?, ?, ?)",
                     (now - 1000, now + 86400000, now - 1000, now - 1000))
        conn.execute("INSERT INTO subscriptions(user_id, plan, status, period,"
                     " started_at_ms, expires_at_ms, created_at_ms, updated_at_ms)"
                     " VALUES(12, 'plus', 'expired', 'month', ?, ?, ?, ?)",
                     (now - 90000000, now - 1000, now - 90000000, now - 90000000))
        conn.commit()
        check("ai_tier_for: активный Plus идёт в plus",
              server.ai_tier_for(conn, 11) == "plus")
        check("ai_tier_for: истекший идёт во free",
              server.ai_tier_for(conn, 12) == "free")
        check("ai_tier_for: без подписки — free",
              server.ai_tier_for(conn, 13) == "free")
    finally:
        conn.close()

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
