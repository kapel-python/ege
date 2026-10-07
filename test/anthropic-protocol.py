#!/usr/bin/env python3
"""Протокол Anthropic Messages (opencode.ai/zen): wire-формат, tools, перебор при проверке.

Офлайн, temp-БД: фейковый urlopen вместо сети (как test/responses-protocol.py).
  * схема: protocol=anthropic принимается, неизвестный — 400-текст;
  * запрос: POST {base}/messages, ключ в x-api-key + anthropic-version (без
    Authorization), system отдельным полем, tool_use/tool_result блоками,
    tools с input_schema, tool_choice required→any, none — без tools;
  * ответ: text + tool_use → chat-shaped message → parse_tool_message;
  * _chat_via едет на /messages у протокола anthropic;
  * проверка модели: ошибка формата (ModelProtocolUnsupported) → следующий
    протокол; ключ/баланс — перебора нет; потолок времени на модель общий.
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

tmp = tempfile.mkdtemp(prefix="ege-anthropic-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")

spec = importlib.util.spec_from_file_location("ege_ai_anthropic", ROOT / "server" / "ai.py")
assert spec and spec.loader
ai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai)

failures = 0
checks = 0
BASE = "https://opencode.ai/zen/go/v1"
KEY = "oc_sk_test"
PROTO_ERR = ('{"type":"error","error":{"type":"ModelProtocolUnsupported",'
             '"message":"Model does not support this protocol."}}')


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

    def fail(self, code: int, text: str):
        self.script.append(urllib.error.HTTPError(
            "https://x", code, f"HTTP {code}", {}, io.BytesIO(text.encode("utf-8"))))
        return self


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


MSG_BODY = {"id": "msg_1", "type": "message", "role": "assistant", "stop_reason": "end_turn",
            "model": "claude-haiku-5-5", "content": [{"type": "text", "text": "Привет!"}]}
TOOL_BODY = {"id": "msg_2", "type": "message", "role": "assistant", "stop_reason": "tool_use",
             "model": "claude-haiku-5-5",
             "content": [{"type": "text", "text": "Сейчас посмотрю."},
                         {"type": "tool_use", "id": "toolu_9", "name": "fold_web",
                          "input": {"op": "profile"}}]}
CHAT_BODY = {"choices": [{"message": {"role": "assistant", "content": "ok-chat"}}]}
RESP_BODY = {"status": "completed",
             "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok-resp"}]}]}

TOOL = {"type": "function", "function": {
    "name": "fold_web", "description": "Профиль ученика",
    "parameters": {"type": "object", "properties": {"op": {"type": "string"}}, "required": ["op"]}}}

HISTORY = [
    {"role": "system", "content": "Ты помощник"},
    {"role": "user", "content": "привет"},
    {"role": "assistant", "content": "Сейчас посмотрю.",
     "tool_calls": [{"id": "toolu_9", "type": "function",
                     "function": {"name": "fold_web", "arguments": '{"op": "profile"}'}}]},
    {"role": "tool", "tool_call_id": "toolu_9", "content": '{"ok": 1}'},
    {"role": "user", "content": "дальше"},
]


def custom_entry(protocol: str = "anthropic") -> str:
    """Запись провайдера в temp-БД, как её кладёт create (напрямую)."""
    entry = {"id": "claude", "title": "Claude", "base_url": BASE,
             "model": "claude-haiku-5-5", "api_key": KEY, "auth": "bearer",
             "use_wallet_balance": False, "merge_system": False, "protocol": protocol,
             "reasoning_effort": "", "extra_headers": {"x-opencode-session": "ege-test"},
             "enabled": True}
    ai._app_config_write(ai._CUSTOM_KEY, {"claude": entry})
    ai.reset_providers_cache()
    return "claude"


def plan(protocol: str) -> dict:
    return {"id": "claude", "base_url": BASE, "key": KEY, "auth": "bearer", "extra": {},
            "merge_system": False, "protocol": protocol,
            "extra_headers": {"x-opencode-session": "ege-test"}}


def main() -> int:
    # --- схема ---------------------------------------------------------
    clean = ai.validate_custom_payload({"id": "claude", "title": "Claude", "base_url": BASE,
                                        "model": "claude-haiku-5-5", "api_key": "k",
                                        "protocol": "anthropic"})
    check("схема: protocol=anthropic принимается", clean.get("protocol") == "anthropic", clean.get("protocol"))
    try:
        ai.validate_custom_payload({"id": "bad", "base_url": BASE, "model": "m",
                                    "api_key": "k", "protocol": "soap"})
        check("схема: неизвестный протокол отклоняется", False)
    except ValueError as exc:
        check("схема: неизвестный протокол отклоняется с подсказкой про anthropic",
              "anthropic" in str(exc), str(exc))

    # --- запрос: заголовки, system, история, tools --------------------
    with FakeHTTP() as fake:
        fake.reply(MSG_BODY)
        msg = ai._anthropic_via_message(
            "claude", HISTORY, model_value="claude-haiku-5-5", base_value=BASE, key=KEY,
            extra_headers={"x-opencode-session": "ege-test"}, tools=[TOOL], tool_choice="required")
        req = fake.requests[0]
        body, headers = req["body"], req["headers"]
        check("запрос: POST на {base}/messages", req["url"] == f"{BASE}/messages", req["url"])
        check("запрос: ключ в x-api-key, Bearer не шлём",
              headers.get("x-api-key") == KEY and "authorization" not in headers, headers)
        check("запрос: anthropic-version и доп. заголовок шлюза",
              headers.get("anthropic-version") == "2023-06-01"
              and headers.get("x-opencode-session") == "ege-test", headers)
        check("запрос: system отдельным полем, в messages его нет",
              body.get("system") == "Ты помощник"
              and all(m["role"] in ("user", "assistant") for m in body["messages"]), body.get("system"))
        msgs = body["messages"]
        check("история: tool_use блоком ассистента с input-объектом",
              msgs[1]["role"] == "assistant"
              and msgs[1]["content"][-1] == {"type": "tool_use", "id": "toolu_9",
                                             "name": "fold_web", "input": {"op": "profile"}},
              msgs[1])
        check("история: tool_result и следующий user склеены в одно сообщение",
              len(msgs) == 3 and msgs[2]["role"] == "user"
              and [b["type"] for b in msgs[2]["content"]] == ["tool_result", "text"]
              and msgs[2]["content"][0]["tool_use_id"] == "toolu_9", msgs[2])
        tool = body["tools"][0]
        check("tools: name/description/input_schema",
              tool["name"] == "fold_web" and tool["input_schema"]["required"] == ["op"]
              and "function" not in tool, tool)
        check("tool_choice required → any", body.get("tool_choice") == {"type": "any"}, body.get("tool_choice"))
        check("max_tokens по умолчанию 4096, temperature 0", body["max_tokens"] == 4096
              and body["temperature"] == 0.0, (body["max_tokens"], body["temperature"]))
        check("ответ: текст из content[]", msg.get("content") == "Привет!", msg)

    # --- none: инструменты не шлём; малый бюджет поднимается ----------
    with FakeHTTP() as fake:
        fake.reply(MSG_BODY)
        ai._anthropic_via_message("claude", HISTORY, model_value="m", base_value=BASE, key=KEY,
                                  extra_headers={}, tools=[TOOL], tool_choice="none", max_tokens=1)
        body = fake.requests[0]["body"]
        check("tool_choice none: tools не шлём", "tools" not in body and "tool_choice" not in body, body.keys())
        check("max_tokens=1 поднимается до 256 (иначе Claude отдаёт пустой ответ)",
              body["max_tokens"] == 256, body["max_tokens"])

    # --- ответ с tool_use → общий разбор ------------------------------
    parsed = ai.parse_tool_message(ai._anthropic_to_message(TOOL_BODY))
    check("tool_use → tool_calls chat-формы, текст уходит в preamble",
          parsed["tool_calls"] and parsed["tool_calls"][0]["name"] == "fold_web"
          and parsed["tool_calls"][0]["id"] == "toolu_9"
          and parsed["tool_calls"][0]["arguments"] == {"op": "profile"}
          and parsed["preamble"] == "Сейчас посмотрю.", parsed)

    # --- диспетчер: _chat_via едет на /messages -----------------------
    name = custom_entry("anthropic")
    with FakeHTTP() as fake:
        fake.reply(TOOL_BODY)
        res = ai._chat_via(name, HISTORY, tools=[TOOL])
        check("_chat_via: протокол anthropic → /messages",
              fake.requests[0]["url"] == f"{BASE}/messages" and res["tool_calls"], fake.requests[0]["url"])
    with FakeHTTP() as fake:
        fake.reply(MSG_BODY)
        text = ai._chat_via(name, [{"role": "user", "content": "привет"}])
        check("_chat_via без tools возвращает текст", text == "Привет!", text)
    custom_entry("chat")
    with FakeHTTP() as fake:
        fake.reply(CHAT_BODY)
        text = ai._chat_via(name, [{"role": "user", "content": "привет"}])
        headers = fake.requests[0]["headers"]
        check("chat: заголовки шлюза уходят и на chat (без них opencode не пускает)",
              text == "ok-chat" and headers.get("x-opencode-session") == "ege-test"
              and headers.get("authorization") == f"Bearer {KEY}", headers)
    custom_entry("anthropic")

    # --- ошибка формата: различаем с ключом/балансом -------------------
    check("формат: ModelProtocolUnsupported → miss",
          ai._is_format_miss(400, PROTO_ERR.lower()) is True)
    check("формат: 404 без маршрута → miss", ai._is_format_miss(404, "not found") is True)
    check("формат: 401 «model is not supported» — не формат",
          ai._is_format_miss(401, "model claude-haiku-5-5 is not supported") is False)
    check("формат: 402 баланс — не формат",
          ai._is_format_miss(402, "insufficient account funds") is False)
    check("формат: 429 — не формат", ai._is_format_miss(429, "") is False)

    # --- проверка модели: перебор протоколов --------------------------
    with FakeHTTP() as fake:
        fake.fail(400, PROTO_ERR).fail(400, PROTO_ERR).reply(RESP_BODY)
        res = ai.probe_one(plan("anthropic"), "gpt-6-luna", timeout=5)
        urls = [r["url"].rsplit("/", 1)[-1] for r in fake.requests]
        check("проверка: anthropic → chat → responses, ответила responses",
              res["ok"] and res["protocol"] == "responses" and urls == ["messages", "completions", "responses"],
              (res, urls))
    with FakeHTTP() as fake:
        fake.reply(MSG_BODY)
        res = ai.probe_one(plan("anthropic"), "claude-haiku-5-5", timeout=5)
        check("проверка: Claude ответил с первого протокола — один запрос",
              res["ok"] and res["protocol"] == "anthropic" and len(fake.requests) == 1, res)
    with FakeHTTP() as fake:
        fake.fail(400, '{"error":{"message":"`temperature` is deprecated for this model."}}')
        fake.reply(MSG_BODY)
        res = ai.probe_one(plan("anthropic"), "claude-haiku-5-5", timeout=5)
        check("проверка: temperature «deprecated» — повтор без temperature, модель жива",
              res["ok"] and res["protocol"] == "anthropic" and len(fake.requests) == 2
              and "temperature" not in fake.requests[1]["body"], res)
    with FakeHTTP() as fake:
        fake.fail(401, '{"error":"Неверный ключ"}')
        res = ai.probe_one(plan("anthropic"), "claude-haiku-5-5", timeout=5)
        check("проверка: 401 — перебора нет, ошибка ключа",
              not res["ok"] and len(fake.requests) == 1 and "401" in res["error"], res)
    with FakeHTTP() as fake:
        fake.fail(400, PROTO_ERR).fail(400, PROTO_ERR).fail(400, PROTO_ERR)
        res = ai.probe_one(plan("anthropic"), "dead-model", timeout=5)
        check("проверка: все протоколы отвергли — мёртв, протокол сохранённый",
              not res["ok"] and res["protocol"] == "anthropic" and len(fake.requests) == 3, res)
    with FakeHTTP() as fake:
        fake.reply(CHAT_BODY)
        res = ai.probe_one(plan("chat"), "grok-4.7", timeout=5)
        check("проверка: chat-провайдер не трогается — один запрос на chat",
              res["ok"] and res["protocol"] == "chat" and len(fake.requests) == 1, res)

    with FakeHTTP() as fake:
        fake.fail(400, PROTO_ERR).fail(400, PROTO_ERR).reply(RESP_BODY)
        first = ai.probe_one(plan("anthropic"), "memo-model", timeout=5)
        fake.reply(RESP_BODY)
        second = ai.probe_one(plan("anthropic"), "memo-model", timeout=5)
        check("память протокола: повторная проверка идёт сразу тем протоколом, что ответил",
              first["protocol"] == "responses" and second["ok"] and second["protocol"] == "responses"
              and len(fake.requests) == 4 and fake.requests[3]["url"].endswith("/responses"),
              (first, second, [r["url"].rsplit("/", 1)[-1] for r in fake.requests]))
    with FakeHTTP() as fake:
        fake.fail(401, '{"error":"Неверный ключ"}')
        broken = ai.probe_one(plan("anthropic"), "memo-model", timeout=5)
        check("память протокола: после сбоя запомненного — забываем, ошибка ключа честная",
              not broken["ok"] and (BASE, "memo-model") not in ai._probe_protocol_memory, broken)

    # --- проба черновика и карточка -----------------------------------
    with FakeHTTP() as fake:
        fake.reply(MSG_BODY)
        draft = ai.probe_draft({"base_url": BASE, "model": "claude-haiku-5-5", "api_key": KEY,
                                "protocol": "anthropic",
                                "extra_headers": {"x-opencode-session": "ege-test"}})
        req = fake.requests[0]
        check("черновик anthropic: /messages с x-api-key",
              draft["ok"] and req["url"] == f"{BASE}/messages" and req["headers"].get("x-api-key") == KEY,
              draft)
    card = ai._public_provider_card(name)
    check("карточка: протокол anthropic виден админке", card.get("protocol") == "anthropic",
          card.get("protocol"))

    print(f"\n{'ALL OK' if not failures else 'FAILED'}: {checks - failures}/{checks} checks")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
