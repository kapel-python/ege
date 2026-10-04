#!/usr/bin/env python3
"""Responses-протокол (opencode.ai/zen): wire-формат, маппинг tools, effort.

Офлайн, temp-БД: фейковый urlopen вместо сети.
  * схема: validate/create/update держат protocol/reasoning_effort/
    extra_headers (плохие имена/значения/зарезервированные — 400-тексты),
    сброс помнит их из defaults, update без ключей не затирает;
  * запрос: POST {base}/responses, instructions отдельно, история треда
    (обе формы tool_calls) — function_call/function_call_output, tools —
    плоские function-объекты, tool_choice только явный, заголовки
    (Bearer + x-opencode-session), effort из записи или явный поверх;
  * max_tokens=1 у responses поднимается до пробного минимума (иначе вечный
    incomplete без текста и живой провайдер выглядел бы мёртвым);
  * ответ: message+function_call → {text, tool_calls, preamble} общим
    парсером; incomplete без содержимого — AIError (повторяемый), пустой
    complete — AIFormatError;
  * судья (as_judge) без явного effort едет на high, наставник — как сказано
    вызывающим; chat-провайдеры идут старым путём без новых полей.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

tmp = tempfile.mkdtemp(prefix="ege-responses-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")

spec = importlib.util.spec_from_file_location("ege_ai_responses", ROOT / "server" / "ai.py")
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
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail))[:240] if detail else ''}")


class FakeHTTP:
    """Подмена urlopen: очередь ответов/ошибок + запись запросов."""

    def __init__(self):
        self.script: list = []
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
        headers = {k.lower(): v for k, v in (request.header_items()
                                             if hasattr(request, "header_items") else [])}
        try:
            headers.update({k.lower(): v for k, v in request.unredirected_hdrs.items()})
        except AttributeError:
            pass
        self.requests.append({"url": request.full_url, "body": body, "headers": headers})
        if not self.script:
            raise AssertionError("фейк: сценарий пуст, а запрос пришёл")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return _FakeResp(item)

    def reply(self, payload: dict):
        self.script.append(payload)
        return self


class _FakeResp:
    def __init__(self, payload: dict):
        self._raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *args):
        return self._raw


def http_error(url: str, code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, f"HTTP {code}", {}, io.BytesIO(b"{}"))


RESP_BODY = {
    "id": "resp_test",
    "object": "response",
    "status": "completed",
    "model": "muse-spark-1.3-contributor",
    "output": [
        {"type": "message", "content": [{"type": "output_text", "text": "Сейчас соберу всё."}]},
        {"type": "function_call", "call_id": "call_1", "name": "fold_web",
         "arguments": '{"op": "profile"}'},
    ],
    "usage": {"output_tokens": 50},
}


def make_custom(entry_extra: dict | None = None) -> str:
    """Запись responses-провайдера в temp-БД (напрямую, как её положит create)."""
    entry = {
        "id": "opencode",
        "title": "Opencode",
        "base_url": "https://opencode.ai/zen/go/v1",
        "model": "muse-spark-1.3-contributor",
        "api_key": "oc_sk_test",
        "auth": "bearer",
        "use_wallet_balance": False,
        "merge_system": False,
        "protocol": "responses",
        "reasoning_effort": "minimal",
        "extra_headers": {"x-opencode-session": "ege-test"},
        "enabled": True,
    }
    if entry_extra:
        entry.update(entry_extra)
    ai._app_config_write(ai._CUSTOM_KEY, {"opencode": entry})
    ai.reset_providers_cache()
    return "opencode"


def main() -> int:
    # --- схема ---------------------------------------------------------
    try:
        ai.validate_custom_payload({"id": "bad proto", "base_url": "https://x.io/v1",
                                    "model": "m", "api_key": "k", "protocol": "soap"})
        check("protocol мимо списка отвергается", False)
    except ValueError:
        check("protocol мимо списка отвергается", True)
    try:
        ai.validate_custom_payload({"id": "p2", "base_url": "https://x.io/v1",
                                    "model": "m", "api_key": "k",
                                    "reasoning_effort": "ultra"})
        check("effort мимо списка отвергается", False)
    except ValueError:
        check("effort мимо списка отвергается", True)
    for bad_headers, label in (
            ({"Authorization": "x"}, "Authorization переопределить нельзя"),
            ({"X-Ok": "a\nb"}, "перенос строки в значении запрещён"),
            ({"плохо": "x"}, "нелатиница в имени запрещена"),
            ({f"h{i}": "v" for i in range(9)}, "больше 8 заголовков нельзя")):
        try:
            ai.validate_custom_payload({"id": "p3", "base_url": "https://x.io/v1",
                                        "model": "m", "api_key": "k",
                                        "extra_headers": bad_headers})
            check(label, False)
        except ValueError:
            check(label, True)
    clean = ai.validate_custom_payload({"id": "opencode", "title": "Opencode",
                                        "base_url": "https://opencode.ai/zen/go/v1/",
                                        "model": "muse-spark-1.3-contributor",
                                        "api_key": "oc_sk_test", "auth": "bearer",
                                        "protocol": "responses", "reasoningEffort": "minimal",
                                        "extraHeaders": {"x-opencode-session": "ege-test"},
                                        "slot": "high", "model_title": "Spark"})
    check("validate чистит новые поля (camelCase тоже)",
          clean["protocol"] == "responses" and clean["reasoning_effort"] == "minimal"
          and clean["extra_headers"] == {"x-opencode-session": "ege-test"}
          and clean["base_url"] == "https://opencode.ai/zen/go/v1", str(clean))
    entry = ai.custom_provider_create(clean)
    check("create кладёт поля и в defaults",
          entry["protocol"] == "responses"
          and entry["defaults"]["reasoning_effort"] == "minimal"
          and entry["defaults"]["extra_headers"] == {"x-opencode-session": "ege-test"},
          str({k: entry.get(k) for k in ("protocol", "reasoning_effort", "extra_headers")}))
    ai.custom_provider_update("opencode", {"model": "muse-spark-1.4"})
    customs, _, _, _ = ai._admin_snapshot()
    check("update без новых ключей их не затирает",
          customs["opencode"]["protocol"] == "responses"
          and customs["opencode"]["extra_headers"] == {"x-opencode-session": "ege-test"}
          and customs["opencode"]["model"] == "muse-spark-1.4",
          str({k: customs["opencode"].get(k) for k in ("protocol", "extra_headers", "model")}))
    card = ai._public_provider_card("opencode")
    check("карточка показывает protocol/effort/имена заголовков без значений и ключа",
          card["protocol"] == "responses" and card["reasoningEffort"] == "minimal"
          and card["extraHeaderNames"] == ["x-opencode-session"]
          and card["keySet"] is True and "oc_sk_test" not in json.dumps(card),
          str({k: card.get(k) for k in ("protocol", "reasoningEffort",
                                        "extraHeaderNames", "keySet", "keyHint")}))

    # --- запрос ---------------------------------------------------------
    pid = make_custom()
    tools = [{"type": "function",
              "function": {"name": "fold_web", "description": "Срез",
                           "parameters": {"type": "object",
                                          "properties": {"op": {"type": "string"}}}}}]
    messages = [
        {"role": "system", "content": "Ты наставник."},
        {"role": "user", "content": "как дела"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c0", "name": "fold_web", "arguments": {"op": "errors"}}]},
        {"role": "tool", "tool_call_id": "c0", "content": '{"open": 3}'},
    ]
    with FakeHTTP() as fake:
        fake.reply(dict(RESP_BODY))
        out = ai._chat_via(pid, messages, tools=tools)
        req = fake.requests[0]
    check("URL — /responses, а не chat/completions",
          req["url"] == "https://opencode.ai/zen/go/v1/responses", req["url"])
    body = req["body"]
    check("system едет в instructions, а не в input",
          body.get("instructions") == "Ты наставник."
          and all(m.get("role") != "system" for m in body.get("input", [])), str(body)[:200])
    kinds = [m.get("type") for m in body.get("input", [])]
    check("история треда — function_call + function_call_output",
          kinds == ["message", "function_call", "function_call_output"], str(kinds))
    fco = [m for m in body["input"] if m.get("type") == "function_call_output"][0]
    check("результат инструмента привязан по call_id",
          fco["call_id"] == "c0" and fco["output"] == '{"open": 3}', str(fco))
    check("tools — плоские function-объекты, tool_choice без просьбы нет",
          body.get("tools") == [{"type": "function", "name": "fold_web", "description": "Срез",
                                 "parameters": {"type": "object",
                                                "properties": {"op": {"type": "string"}}}}]
          and "tool_choice" not in body, str(body.get("tools")))
    check("заголовки: Bearer + x-opencode-session",
          req["headers"].get("authorization") == "Bearer oc_sk_test"
          and req["headers"].get("x-opencode-session") == "ege-test",
          str(req["headers"]))
    check("effort из записи (minimal) уезжает в reasoning",
          body.get("reasoning") == {"effort": "minimal"}, str(body.get("reasoning")))
    check("ответ разобран общим контрактом (текст+вызовы, вызовы главнее)",
          out["text"] == "Сейчас соберу всё." and len(out["tool_calls"]) == 1
          and out["tool_calls"][0]["name"] == "fold_web"
          and out["preamble"] == "Сейчас соберу всё.", str(out)[:200])

    with FakeHTTP() as fake:
        fake.reply(dict(RESP_BODY))
        ai._chat_via_message(pid, messages, tools=tools, tool_choice="auto",
                             reasoning_effort="high", max_tokens=1)
        body = fake.requests[0]["body"]
    check("явные tool_choice/effort бьют default записи",
          body.get("tool_choice") == "auto"
          and body.get("reasoning") == {"effort": "high"}, str(body.get("reasoning")))
    check("max_tokens=1 у responses поднимается до пробного минимума",
          body.get("max_output_tokens") == ai.RESPONSES_PROBE_MAX_TOKENS,
          str(body.get("max_output_tokens")))
    # entry без effort: поле reasoning отсутствует
    make_custom({"reasoning_effort": ""})
    with FakeHTTP() as fake:
        fake.reply({"id": "r", "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": "привет"}]}]})
        text = ai._chat_via(pid, [{"role": "user", "content": "привет"}])
        body = fake.requests[0]["body"]
    check("плоский ответ без tools — текст, без reasoning при пустом effort",
          text == "привет" and "reasoning" not in body, f"{text!r} {body.get('reasoning')}")
    make_custom()

    # --- ошибки ----------------------------------------------------------
    with FakeHTTP() as fake:
        fake.script.append(http_error("https://opencode.ai/zen/go/v1/responses", 400))
        try:
            ai._chat_via_message(pid, messages)
            check("400 responses — AIError", False)
        except ai.AIError as exc:
            check("400 responses — AIError", "400" in str(exc), str(exc))
    with FakeHTTP() as fake:
        fake.reply({"id": "r", "status": "incomplete", "output": []})
        try:
            ai._chat_via_message(pid, messages)
            check("incomplete без содержимого — AIError (повторяемый)", False)
        except ai.AIError:
            check("incomplete без содержимого — AIError (повторяемый)", True)
    with FakeHTTP() as fake:
        fake.reply({"id": "r", "status": "completed", "output": []})
        try:
            ai._chat_via_message(pid, messages)
            check("пустой complete — AIFormatError", False)
        except ai.AIFormatError:
            check("пустой complete — AIFormatError", True)
    with FakeHTTP() as fake:
        fake.script.append(http_error("https://opencode.ai/zen/go/v1/responses", 429))
        try:
            ai._chat_via_message(pid, messages)
            check("429 responses — AIError перегрузка", False)
        except ai.AIError as exc:
            check("429 responses — AIError перегрузка", "перегружен" in str(exc), str(exc))

    # --- effort по умолчанию: судья high, остальные — как сказано -----------
    seen: dict = {}
    real_via = ai._chat_via

    def spy_via(provider, msgs, **kw):
        seen.update(kw)
        return "ok"

    ai._chat_via = spy_via
    try:
        ai.chat([{"role": "user", "content": "hi"}])
        check("обычный chat без effort — как сказано (None)",
              seen.get("reasoning_effort") is None, str(seen))
        ai.chat([{"role": "user", "content": "hi"}], as_judge=True)
        check("судья без явного effort едет на high",
              seen.get("reasoning_effort") == "high", str(seen))
        ai.chat([{"role": "user", "content": "hi"}], as_judge=True,
                reasoning_effort="minimal")
        check("явный effort бьёт судейский default",
              seen.get("reasoning_effort") == "minimal", str(seen))
    finally:
        ai._chat_via = real_via

    # --- chat-протокол не задет ------------------------------------------
    ai._app_config_write(ai._CUSTOM_KEY, {"plain": {
        "id": "plain", "title": "Plain", "base_url": "https://plain.test/v1",
        "model": "m", "api_key": "k", "auth": "bearer",
        "use_wallet_balance": False, "merge_system": False, "enabled": True}})
    ai.reset_providers_cache()
    with FakeHTTP() as fake:
        fake.reply({"choices": [{"message": {"content": "hi"}}]})
        text = ai._chat_via("plain", [{"role": "user", "content": "hi"}])
        req = fake.requests[0]
    check("chat-провайдер без новых полей — старый путь (/chat/completions)",
          text == "hi" and req["url"] == "https://plain.test/v1/chat/completions"
          and "reasoning" not in req["body"], req["url"])
    spec = ai._spec_for("plain")
    check("спека без полей: protocol chat, effort пусто, заголовков нет",
          spec["protocol"] == "chat" and spec["reasoning_effort"] == ""
          and spec["extra_headers"] == {}, str({k: spec.get(k) for k in ("protocol",)}))

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
