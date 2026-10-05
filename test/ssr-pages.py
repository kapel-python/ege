#!/usr/bin/env python3
"""SSR первых кадров /status и /subscription: данные едут вместе с HTML.

Сервер вшивает JSON-блок вместо маркера <!--SSR-DATA--> (как префетч
в профиле SPA): первый кадр сразу целый, без дёргания. Проверяем:

* /status: блок ssr-status с живыми services/totals, маркера не осталось,
  сырых </script> внутри блока нет, страница отдаётся и под лимитом
  (fail-open: без вшивки, догрузка fetch).
* /subscription гостю без куки: ssr-sub {guest: true} вообще без чтения
  базы (счётчик users не растёт от просмотров).
* залогиненному: guest:false/active:false; после mock-покупки active:true
  и лимиты 10/50; notifyJoined едет в том же срезе; отмена видна как
  status cancelled при active:true.
* gzip-конвейер цел: вшивка происходит до сжатия.

Свой temp-БД и живой сервер на временном порту; прод не трогается.
"""
from __future__ import annotations

import html as html_module
import importlib.util
import json
import os
import re
import socket
import sqlite3
import tempfile
import threading
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

FAILURES: list = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_BACKUP_DISABLE"] = "1"
    os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"
    spec = importlib.util.spec_from_file_location("ege_ssr_pages", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def make_opener():
    return build_opener(HTTPCookieProcessor(CookieJar()))


def raw_request(op, base: str, path: str, method: str = "GET", body: dict | None = None,
               ip: str = "10.20.0.1", headers: dict | None = None, timeout: float = 10.0):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(base + path, data=data, method=method)
    req.add_header("X-Forwarded-For", ip)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with op.open(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except HTTPError as error:
        with error:
            return error.code, error.read(), dict(error.headers.items())


def ssr_block(page: bytes, script_id: str):
    """Сырое содержимое JSON-блока (как лежит в HTML) и распарсенный объект."""
    match = re.search(
        rb'<script id="' + script_id.encode() + rb'" type="application/json">(.*?)</script>',
        page, re.DOTALL)
    if not match:
        return None, None
    raw = match.group(1)
    try:
        return raw, json.loads(html_module.unescape(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        return raw, None


def users_count(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    finally:
        conn.close()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-ssr-pages-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        server.install_catalog(server.connect())

        port = free_port()
        httpd = server.create_http_server("127.0.0.1", port)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        time.sleep(0.4)
        base = f"http://127.0.0.1:{port}"

        print("== /status SSR")
        guest = make_opener()
        status, status_page, _ = raw_request(guest, base, "/status", ip="10.20.0.1")
        check("GET /status 200", status == 200, status)
        check("маркер заменён", b"<!--SSR-DATA-->" not in status_page)
        raw, payload = ssr_block(status_page, "ssr-status")
        check("блок ssr-status парсится", isinstance(payload, dict), type(payload))
        check("services живые",
              isinstance(payload, dict) and isinstance(payload.get("services"), list)
              and len(payload["services"]) > 0,
              str(payload)[:120] if payload else "empty")
        check("totals и now на месте",
              isinstance(payload, dict) and isinstance(payload.get("totals"), dict)
              and isinstance(payload.get("now"), int))
        check("без сырого </script> в блоке", raw is not None and b"</script" not in raw)

        before_users = users_count(db_path)
        for _ in range(3):
            raw_request(guest, base, "/status", ip="10.20.0.2")
            raw_request(guest, base, "/subscription", ip="10.20.0.2")
        check("просмотры без куки не заводят users",
              users_count(db_path) == before_users, f"{before_users}")

        print("== /subscription SSR: гость")
        status, sub_page, _ = raw_request(guest, base, "/subscription", ip="10.20.0.3")
        check("GET /subscription 200", status == 200, status)
        check("маркер заменён", b"<!--SSR-DATA-->" not in sub_page)
        _, guest_payload = ssr_block(sub_page, "ssr-sub")
        check("гость видит guest:true", guest_payload == {"guest": True}, guest_payload)

        print("== /subscription SSR: пользователь и Plus")
        user = make_opener()
        status, body, _ = raw_request(user, base, "/api/profile/claim", "POST", {
            "subject": "profile_math", "onboarded": True, "name": "ССР",
            "selfLevel": "base", "goal": "g60",
        }, ip="10.20.0.4")
        check("claim 200", status == 200, status)
        status, sub_page, _ = raw_request(user, base, "/subscription", ip="10.20.0.4")
        _, free_payload = ssr_block(sub_page, "ssr-sub")
        check("free: guest:false/active:false",
              isinstance(free_payload, dict) and free_payload.get("guest") is False
              and free_payload.get("active") is False, free_payload)

        status, co, _ = raw_request(user, base, "/api/subscription/checkout", "POST",
                                   {"period": "month"}, ip="10.20.0.4")
        co = json.loads(co) if isinstance(co, bytes) else co
        check("checkout ok", status == 200, status)
        status, _, _ = raw_request(user, base, "/api/subscription/confirm", "POST",
                                  {"paymentId": co.get("paymentId")}, ip="10.20.0.4")
        check("confirm ok", status == 200, status)
        status, sub_page, _ = raw_request(user, base, "/subscription", ip="10.20.0.4")
        _, plus_payload = ssr_block(sub_page, "ssr-sub")
        check("Plus: active:true и лимиты 10/50",
              isinstance(plus_payload, dict) and plus_payload.get("active") is True
              and (plus_payload.get("limits") or {}).get("essay") == 10
              and (plus_payload.get("limits") or {}).get("agent") == 50
              and isinstance(plus_payload.get("expiresAt"), int), plus_payload)
        check("notifyJoined bool", isinstance(plus_payload, dict)
              and isinstance(plus_payload.get("notifyJoined"), bool))

        status, _, _ = raw_request(user, base, "/api/subscription/notify", "POST",
                                  {}, ip="10.20.0.4")
        check("notify join 200", status == 200, status)
        _, joined_page = ssr_block(
            raw_request(user, base, "/subscription", ip="10.20.0.4")[1], "ssr-sub")
        check("notifyJoined:true после записи",
              isinstance(joined_page, dict) and joined_page.get("notifyJoined") is True,
              joined_page)

        status, _, _ = raw_request(user, base, "/api/subscription/cancel", "POST",
                                  {}, ip="10.20.0.4")
        check("cancel 200", status == 200, status)
        _, cancelled_page = ssr_block(
            raw_request(user, base, "/subscription", ip="10.20.0.4")[1], "ssr-sub")
        check("отмена видна: active + cancelled",
              isinstance(cancelled_page, dict) and cancelled_page.get("active") is True
              and cancelled_page.get("status") == "cancelled", cancelled_page)

        print("== конвейер и fail-open")
        status, _, gz_headers = raw_request(
            guest, base, "/subscription", ip="10.20.0.5",
            headers={"Accept-Encoding": "gzip"})
        check("gzip-ответ 200 после вшивки",
              status == 200 and gz_headers.get("Content-Encoding") == "gzip",
              f"{status} {gz_headers.get('Content-Encoding')}")
        flood_ok = True
        for _ in range(70):
            status, _, _ = raw_request(guest, base, "/status", ip="10.20.0.9")
            if status != 200:
                flood_ok = False
                break
        check("страница жива и под лимитом (fail-open)", flood_ok)

    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} ok")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
