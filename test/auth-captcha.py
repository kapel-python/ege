#!/usr/bin/env python3
"""Регрессия адаптивной капчи регистрации/входа/онбординга.

Контракт (своя капча, без внешних ключей):
1. обычная первая регистрация/заявка идёт БЕЗ капчи (200);
2. GET /api/auth/captcha отдаёт {id, svg, expiresInSec} (+debugCode в тестах);
3. всплеск регистраций с IP (мягкий порог) → 422 CAPTCHA_REQUIRED с челленджем;
4. неверное решение → 422 CAPTCHA_INVALID со СВЕЖИМ челленджем;
5. решённая/чужая/протухшая картинка одноразовая (повтор → снова REQUIRED);
6. верное решение → 200, аккаунт заводится;
7. honeypot/одноразовая почта/plus-адрес/слишком быстрая отправка → капча с 1-й заявки;
8. вход: после 5 неудач — 429 CAPTCHA_REQUIRED, с решением — проверка пароля
   идёт своим чередом (401 неверный / 200 верный);
9. жёсткий объём → 429 даже с решённой капчей;
10. claim онбординга под всплеском — тот же гейт (422 → решение → 200);
11. глобальный щит ловит распределённую ферму;
12. FIFO-капы таблиц: флуд выдачей/заявками не растит базу бесконечно;
13. в проде debugCode нет.

Свои temp-БД и живой сервер, прод не трогает. Решения берутся из
debugCode (EGE_CAPTCHA_DEBUG=1) — в проде этого поля нет.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
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


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_CAPTCHA_DEBUG"] = "1"
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    salt = "a" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_captcha_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None, ip: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if ip is not None:
        req.add_header("X-Forwarded-For", ip)
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read() or b"{}")
        except (ValueError, OSError):
            payload = {}
        return exc.code, payload


def fresh_client():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def solve(payload422):
    ch = (payload422 or {}).get("captcha") or {}
    assert ch.get("id") and ch.get("debugCode"), payload422
    return ch["id"], ch["debugCode"]


def main():
    fails = []

    def check(name, cond, extra=""):
        print(("ok  " if cond else "FAIL") + " " + name + ("" if cond else f" — {extra}"))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="ege-captcha-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        # Глобальный щит не мешает точечным секциям: каждую проверяем отдельно.
        server.REG_GLOBAL_SOFT = 10 ** 9
        server.REG_GLOBAL_HARD = 10 ** 9
        httpd = server.create_http_server("127.0.0.1", 0)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"

            # --- 1-2. Чистая регистрация без капчи; форма челленджа ---
            c0, _ = fresh_client()
            status, data = request(c0, base, "/api/auth/captcha", ip="10.1.0.1")
            check("GET captcha 200 с полями", status == 200 and data.get("captcha", {}).get("id")
                  and data["captcha"].get("svg", "").startswith("<svg")
                  and data["captcha"].get("expiresInSec") == 300
                  and data["captcha"].get("debugCode"), (status, str(data)[:160]))
            texts = data["captcha"]["svg"].count("<text")
            check("в картинке 5 символов", texts == 5, texts)
            status, reg = request(c0, base, "/api/auth/register", "POST", {
                "name": "Чистый", "email": "clean@example.com", "password": "secret-pass-1",
            }, ip="10.1.0.1")
            check("первая регистрация без капчи 200", status == 200, (status, reg))

            # --- 3-6. Всплеск с одного IP: мягкий порог → капча → решение ---
            ip = "10.2.0.2"
            for i in range(5):
                c, _ = fresh_client()
                status, _ = request(c, base, "/api/auth/register", "POST", {
                    "name": f"Обычный {i}", "email": f"plain-{i}@example.com",
                    "password": "secret-pass-1",
                }, ip=ip)
                check(f"регистрация {i + 1}/5 без капчи", status == 200, status)
            c, _ = fresh_client()
            status, need = request(c, base, "/api/auth/register", "POST", {
                "name": "Фермер", "email": "farm-6@example.com", "password": "secret-pass-1",
            }, ip=ip)
            check("6-я с IP → 422 CAPTCHA_REQUIRED с челленджем",
                  status == 422 and need.get("code") == "CAPTCHA_REQUIRED"
                  and (need.get("captcha") or {}).get("id"), (status, str(need)[:200]))
            cid, code = solve(need)
            status, bad = request(c, base, "/api/auth/register", "POST", {
                "name": "Фермер", "email": "farm-6@example.com", "password": "secret-pass-1",
                "captchaId": cid, "captcha": "XXXXX",
            }, ip=ip)
            check("неверное решение → 422 CAPTCHA_INVALID со свежим челленджем",
                  status == 422 and bad.get("code") == "CAPTCHA_INVALID"
                  and (bad.get("captcha") or {}).get("id") not in (None, cid), (status, str(bad)[:200]))
            cid2, code2 = solve(bad)
            status, ok = request(c, base, "/api/auth/register", "POST", {
                "name": "Фермер", "email": "farm-6@example.com", "password": "secret-pass-1",
                "captchaId": cid2, "captcha": code2.lower(),
            }, ip=ip)
            check("верное решение (нижний регистр) → 200", status == 200, (status, ok))
            status, replay = request(c, base, "/api/auth/register", "POST", {
                "name": "Фермер", "email": "farm-7@example.com", "password": "secret-pass-1",
                "captchaId": cid2, "captcha": code2,
            }, ip=ip)
            check("повтор гашёной картинки → снова 422 REQUIRED",
                  status == 422 and replay.get("code") == "CAPTCHA_REQUIRED", (status, str(replay)[:200]))

            # --- 7. honeypot / мусорная почта / rapid — с первой заявки ---
            c, _ = fresh_client()
            status, honey = request(c, base, "/api/auth/register", "POST", {
                "name": "Бот", "email": "bot@example.com", "password": "secret-pass-1",
                "website": "http://spam.example",
            }, ip="10.3.0.3")
            check("заполненный honeypot → 422 REQUIRED с 1-й заявки",
                  status == 422 and honey.get("code") == "CAPTCHA_REQUIRED", (status, str(honey)[:160]))
            cid, code = solve(honey)
            status, ok = request(c, base, "/api/auth/register", "POST", {
                "name": "Бот", "email": "bot@example.com", "password": "secret-pass-1",
                "website": "http://spam.example", "captchaId": cid, "captcha": code,
            }, ip="10.3.0.3")
            check("honeypot + решение → 200", status == 200, (status, str(ok)[:160]))

            c, _ = fresh_client()
            status, disp = request(c, base, "/api/auth/register", "POST", {
                "name": "Временный", "email": "user@mailinator.com", "password": "secret-pass-1",
            }, ip="10.4.0.4")
            check("одноразовая почта → 422 REQUIRED", status == 422
                  and disp.get("code") == "CAPTCHA_REQUIRED", (status, str(disp)[:160]))
            cid, code = solve(disp)
            status, ok = request(c, base, "/api/auth/register", "POST", {
                "name": "Временный", "email": "user2@mailinator.com", "password": "secret-pass-1",
                "captchaId": cid, "captcha": code,
            }, ip="10.4.0.4")
            check("мусорная почта + решение → 200", status == 200, (status, str(ok)[:160]))

            c, _ = fresh_client()
            status, plus = request(c, base, "/api/auth/register", "POST", {
                "name": "Плюсовщик", "email": "farm+1@gmail.com", "password": "secret-pass-1",
            }, ip="10.16.0.16")
            check("plus-адрес → 422 REQUIRED с 1-й заявки", status == 422
                  and plus.get("code") == "CAPTCHA_REQUIRED", (status, str(plus)[:160]))

            c, _ = fresh_client()
            status, rapid = request(c, base, "/api/auth/register", "POST", {
                "name": "Торопыга", "email": "rapid@example.com", "password": "secret-pass-1",
                "startedAt": str(int(time.time() * 1000)),
            }, ip="10.5.0.5")
            check("отправка быстрее 1.5с → 422 REQUIRED", status == 422
                  and rapid.get("code") == "CAPTCHA_REQUIRED", (status, str(rapid)[:160]))
            c, _ = fresh_client()
            status, slow = request(c, base, "/api/auth/register", "POST", {
                "name": "Вдумчивый", "email": "slow@example.com", "password": "secret-pass-1",
                "startedAt": str(int(time.time() * 1000) - 60_000),
            }, ip="10.5.0.5")
            check("отправка через минуту → 200 без капчи", status == 200, (status, str(slow)[:160]))

            # --- 8. Вход: после 5 неудач — капча, дальше по паролю ---
            ip = "10.6.0.6"
            c, _ = fresh_client()
            status, reg = request(c, base, "/api/auth/register", "POST", {
                "name": "Входящий", "email": "login@example.com", "password": "right-pass-1",
            }, ip=ip)
            assert status == 200, (status, reg)
            for _ in range(5):
                status, _ = request(c, base, "/api/auth/login", "POST", {
                    "email": "login@example.com", "password": "wrong-pass",
                }, ip=ip)
                assert status == 401, status
            status, gate = request(c, base, "/api/auth/login", "POST", {
                "email": "login@example.com", "password": "right-pass-1",
            }, ip=ip)
            check("6-й вход с IP → 429 CAPTCHA_REQUIRED",
                  status == 429 and gate.get("code") == "CAPTCHA_REQUIRED"
                  and (gate.get("captcha") or {}).get("id"), (status, str(gate)[:200]))
            cid, code = solve(gate)
            status, wrong = request(c, base, "/api/auth/login", "POST", {
                "email": "login@example.com", "password": "wrong-pass",
                "captchaId": cid, "captcha": code,
            }, ip=ip)
            check("капча + неверный пароль → честный 401", status == 401, (status, wrong))
            status, gate2 = request(c, base, "/api/auth/login", "POST", {
                "email": "login@example.com", "password": "right-pass-1",
            }, ip=ip)
            check("без решения — снова 429 с НОВЫМ челленджем",
                  status == 429 and (gate2.get("captcha") or {}).get("id") not in (None, cid),
                  (status, str(gate2)[:200]))
            cid2, code2 = solve(gate2)
            status, good = request(c, base, "/api/auth/login", "POST", {
                "email": "login@example.com", "password": "right-pass-1",
                "captchaId": cid2, "captcha": code2,
            }, ip=ip)
            check("капча + верный пароль → 200", status == 200, (status, str(good)[:200]))

            # --- 9. Жёсткий объём: 429 даже с решением ---
            old_hard = server.REG_IP_HOUR_HARD
            server.REG_IP_HOUR_HARD = 2
            try:
                ip = "10.7.0.7"
                for i in range(2):
                    c, _ = fresh_client()
                    status, _ = request(c, base, "/api/auth/register", "POST", {
                        "name": f"Штамп {i}", "email": f"hard-{i}@example.com",
                        "password": "secret-pass-1",
                    }, ip=ip)
                    assert status == 200, (i, status)
                c, _ = fresh_client()
                status, need = request(c, base, "/api/auth/register", "POST", {
                    "name": "Штамп 2", "email": "hard-2@example.com",
                    "password": "secret-pass-1",
                }, ip=ip)
                # hard=2: третья попытка уже за жёстким порогом
                check("за жёстким порогом → 429 без капчи",
                      status == 429 and need.get("code") == "RATE_LIMITED"
                      and not need.get("captcha"), (status, str(need)[:200]))
            finally:
                server.REG_IP_HOUR_HARD = old_hard

            # --- 10. Claim онбординга под всплеском — тот же гейт ---
            ip = "10.8.0.8"
            for i in range(5):
                c, _ = fresh_client()
                status, _ = request(c, base, "/api/profile/claim", "POST", {
                    "subject": "profile_math", "onboarded": True, "name": f"Гость {i}",
                }, ip=ip)
                check(f"заявка {i + 1}/5 без капчи", status == 200, status)
            c, _ = fresh_client()
            status, need = request(c, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Гость 6",
            }, ip=ip)
            check("6-я заявка → 422 CAPTCHA_REQUIRED",
                  status == 422 and need.get("code") == "CAPTCHA_REQUIRED", (status, str(need)[:200]))
            cid, code = solve(need)
            status, ok = request(c, base, "/api/profile/claim", "POST", {
                "subject": "profile_math", "onboarded": True, "name": "Гость 6",
                "captchaId": cid, "captcha": code,
            }, ip=ip)
            check("заявка + решение → 200", status == 200, (status, str(ok)[:200]))

            # --- 11. Глобальный щит ловит распределённую ферму ---
            server.REG_GLOBAL_SOFT = 3
            try:
                _conn = server.connect()
                try:
                    _conn.execute("DELETE FROM reg_rate_hits")
                    _conn.commit()
                finally:
                    _conn.close()
                for i, fake in enumerate(("10.11.1.1", "10.12.2.2", "10.13.3.3")):
                    c, _ = fresh_client()
                    status, _ = request(c, base, "/api/auth/register", "POST", {
                        "name": f"Рассеянный {i}", "email": f"spread-{i}@example.com",
                        "password": "secret-pass-1",
                    }, ip=fake)
                    assert status == 200, (i, status)
                c, _ = fresh_client()
                status, need = request(c, base, "/api/auth/register", "POST", {
                    "name": "Рассеянный 3", "email": "spread-3@example.com",
                    "password": "secret-pass-1",
                }, ip="10.14.9.9")
                check("всплеск по сайту → 422 даже с чистого IP",
                      status == 422 and need.get("code") == "CAPTCHA_REQUIRED", (status, str(need)[:200]))
            finally:
                server.REG_GLOBAL_SOFT = 10 ** 9

            # --- 12. Капы таблиц: флуд не растит базу бесконечно ---
            old_cmax, old_rmax = server.CAPTCHA_CHALLENGES_MAX, server.REG_RATE_HITS_MAX
            server.CAPTCHA_CHALLENGES_MAX = 10
            try:
                c, _ = fresh_client()
                for _ in range(12):
                    status, _ = request(c, base, "/api/auth/captcha", ip="10.17.0.17")
                    assert status == 200, status
                conn = server.connect()
                try:
                    n = conn.execute("SELECT COUNT(*) AS c FROM captcha_challenges").fetchone()["c"]
                finally:
                    conn.close()
                check("выдача капч упирается в FIFO-капу", n <= 10, n)
            finally:
                server.CAPTCHA_CHALLENGES_MAX = old_cmax
            server.REG_RATE_HITS_MAX = 20
            try:
                for i in range(25):
                    c, _ = fresh_client()
                    status, _ = request(c, base, "/api/auth/register", "POST", {
                        "name": f"Штамп-капа {i}", "email": f"cap-{i}@example.com",
                        "password": "secret-pass-1",
                    }, ip=f"10.18.{i}.1")
                    assert status == 200, (i, status)
                conn = server.connect()
                try:
                    n = conn.execute("SELECT COUNT(*) AS c FROM reg_rate_hits").fetchone()["c"]
                finally:
                    conn.close()
                check("счётчик скорости упирается в FIFO-капу", n <= 20, n)
            finally:
                server.REG_RATE_HITS_MAX = old_rmax

            # --- 13. В проде debugCode нет ---
            del os.environ["EGE_CAPTCHA_DEBUG"]
            try:
                c, _ = fresh_client()
                status, data = request(c, base, "/api/auth/captcha", ip="10.15.0.9")
                check("без DEBUG флага кода-ответа нет",
                      status == 200 and "debugCode" not in (data.get("captcha") or {}), (status, data))
            finally:
                os.environ["EGE_CAPTCHA_DEBUG"] = "1"
        finally:
            httpd.shutdown()
            thread.join(timeout=10)
    print("CAPTCHA REGRESSION " + ("OK" if not fails else f"FAILURES: {fails}"))
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
