#!/usr/bin/env python3
"""Стресс и абуз подписки Plus: гонки, кривые входы, чужое, состояния, ферма.

Бьёт по server/subscription.py и его обвязке в server.py на живом сервере
с temp-БД (прод не трогается, наружу ни одного запроса):
  * параллельный даблклик: N одновременных checkout с одним idempotencyKey
    (1 pending, остальные — тот же paymentId, без 500); N параллельных
    confirm одного paymentId (одно продление, остальные already:true);
    параллельные cancel+resume и grant+revoke (всегда JSON, без 500);
  * доливка карманов при частичной трате — ровно до полного, не выше;
    грант админа выше Plus переживает покупку (Plus чужие гранты не режет);
  * кривые входы: period/paymentId/provider/key/limit/offset/webhook;
  * чужое: confirm чужого paymentId (public и легаси-int), чужие payments, refund чужого,
    админ-действия несуществующему, повторный refund, refund pending;
  * состояния: cancel/resume без подписки, resume после истечения, confirm
    failed/cancelled/refunded, стэкинг продлений, confirm после истечения;
  * mock выключен (503 без подписки), смена цены между checkout и confirm;
  * ферма (Plus не перетекает на новый аккаунт), CSRF, бан, время, сброс,
    каскад удаления, переживание переподключения, флуд (429, не 500).
"""
from __future__ import annotations

import hashlib
import hmac
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
ADMIN_PASSWORD = b"test-subscription-abuse"

os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"
# Mock-режим тестов: прод-ключи Platega из окружения хоста гасим, иначе
# checkout уйдёт в настоящие деньги.
for _k in ("EGE_PLATEGA_MERCHANT_ID", "EGE_PLATEGA_SECRET",
           "EGE_PLATEGA_METHOD", "EGE_PLATEGA_BASE_URL",
           "EGE_PLATEGA_TIMEOUT_SEC"):
    os.environ.pop(_k, None)

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    extra = f" | {detail}" if detail != "" else ""
    print(f"{'PASS' if condition else 'FAIL'} {name}{extra}")


def section(title):
    print(f"\n== {title}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "a" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_sub_abuse_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_device(ip="10.8.0.1"):
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar, ip


def cookie_header(jar):
    return "; ".join(f"{c.name}={c.value}" for c in jar)


def request(dev, base, path, method="GET", body=None, ip="10.8.0.1", headers=None):
    opener, _, _ = dev
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("X-Forwarded-For", ip)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with opener.open(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b"{}"
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"_non_json": raw[:200].decode("utf-8", "replace")}


def raw_request(base, path, method="GET", body=None, ip="10.8.0.1",
                headers=None, timeout=20):
    """Запрос без общей куки — для параллельных потоков (своя кука на поток)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("X-Forwarded-For", ip)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b"{}"
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"_non_json": raw[:200].decode("utf-8", "replace")}


def onboard(dev, base, name="Ученик", ip="10.8.0.1"):
    status, claimed = request(dev, base, "/api/profile/claim", "POST", {
        "subject": "profile_math", "onboarded": True, "name": name,
        "selfLevel": "base", "goal": "g60",
    }, ip)
    assert status == 200, (status, claimed)
    return claimed["accountId"]


def parallel(n, fn):
    barrier = threading.Barrier(n)
    out = [None] * n

    def run(i):
        barrier.wait()
        try:
            out[i] = fn(i)
        except Exception as exc:  # noqa: BLE001 — фиксируем, а не роняем
            out[i] = ("EXC", {"error": f"{type(exc).__name__}: {exc}"})

    threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert all(o is not None for o in out), "поток завис"
    return out


def is_json(body):
    return isinstance(body, dict) and "_non_json" not in body


def main():
    with tempfile.TemporaryDirectory(prefix="ege-sub-abuse-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        assert server._SUB is not None, "модуль подписки не загрузился"
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def db(sql, args=()):
            c = server.connect()
            try:
                return [dict(r) for r in c.execute(sql, args).fetchall()]
            finally:
                c.close()

        def db_exec(sql, args=()):
            c = server.connect()
            try:
                c.execute(sql, args)
                c.commit()
            finally:
                c.close()

        def uid_of(account_id):
            rows = db("SELECT id FROM users WHERE account_id=?", (account_id,))
            assert rows, account_id
            return int(rows[0]["id"])

        def buckets(user_id):
            return {r["owner"]: (r["count"], r["timer_ms"]) for r in db(
                "SELECT owner, count, timer_ms FROM ai_usage WHERE owner IN (?, ?)",
                (f"u:{user_id}", f"agent:{user_id}"))}

        admin = make_device("10.8.0.9")
        s, login = request(admin, base, "/api/admin/login", "POST",
                           {"password": ADMIN_PASSWORD.decode()}, "10.8.0.9")
        assert s == 200, (s, login)

        # --- Параллельный даблклик checkout ---
        section("гонка checkout: 8 потоков, один ключ")
        uA = make_device("10.8.1.1")
        aA = onboard(uA, base, "ГонщикА", "10.8.1.1")
        ckA = cookie_header(uA[1])
        res = parallel(8, lambda i: raw_request(
            base, "/api/subscription/checkout", "POST",
            {"period": "month", "idempotencyKey": "race-key-1"},
            "10.8.1.1", {"Cookie": ckA}))
        statuses = [s for s, _ in res]
        pids = [b.get("paymentId") for _, b in res if isinstance(b, dict)]
        rows = db("SELECT COUNT(*) c FROM subscription_payments WHERE idempotency_key=?",
                  ("race-key-1",))
        check("все 8 checkout 200 и JSON",
              all(s == 200 for s in statuses) and all(is_json(b) for _, b in res),
              f"{statuses} {res}")
        check("один paymentId на всех", len(set(pids)) == 1, f"{pids}")
        check("в БД одна строка на ключ", rows[0]["c"] == 1, rows)
        check("ни одного 500/трейсбека", all(s != 500 for s in statuses), f"{statuses}")

        # --- Параллельный confirm ---
        section("гонка confirm: 6 потоков, один платёж")
        uB = make_device("10.8.1.2")
        aB = onboard(uB, base, "ГонщикБ", "10.8.1.2")
        s, co = request(uB, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.2")
        assert s == 200, co
        pidB = co["paymentId"]
        ckB = cookie_header(uB[1])
        res = parallel(6, lambda i: raw_request(
            base, "/api/subscription/confirm", "POST", {"paymentId": pidB},
            "10.8.1.2", {"Cookie": ckB}))
        statuses = [s for s, _ in res]
        fresh = [b.get("already") is False for _, b in res if isinstance(b, dict)]
        exps = [b.get("expiresAt") for _, b in res if isinstance(b, dict)]
        s, st = request(uB, base, "/api/subscription/status", ip="10.8.1.2")
        check("все 6 confirm 200 и JSON",
              all(s0 == 200 for s0 in statuses) and all(is_json(b) for _, b in res),
              f"{statuses}")
        check("ровно одно настоящее продление", sum(fresh) == 1, f"{res}")
        check("expiresAt у всех один", len(set(exps)) == 1, f"{exps}")
        check("подписка активна, срок совпал",
              st["active"] is True and st["expiresAt"] == exps[0], st)

        # --- Параллельные cancel+resume ---
        section("гонка cancel+resume")
        uC = make_device("10.8.1.3")
        aC = onboard(uC, base, "ГонщикВ", "10.8.1.3")
        s, co = request(uC, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.3")
        assert s == 200, co
        os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"
        s, _ = request(uC, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co["paymentId"]}, "10.8.1.3")
        assert s == 200, s
        ckC = cookie_header(uC[1])
        res = parallel(6, lambda i: raw_request(
            base, "/api/subscription/cancel" if i % 2 == 0 else "/api/subscription/resume",
            "POST", {}, "10.8.1.3", {"Cookie": ckC}))
        statuses = [s for s, _ in res]
        # resume вне cancelled — честный 400 (гонка сама ставит такие ходы):
        # важно, что нет 500 и все ответы — JSON.
        check("cancel/resume под гонкой: только 200/400, всё JSON, без 500",
              all(s0 in (200, 400) for s0 in statuses)
              and all(is_json(b) for _, b in res)
              and all(s0 != 500 for s0 in statuses),
              f"{statuses}")
        s, st = request(uC, base, "/api/subscription/status", ip="10.8.1.3")
        check("финал консистентен: доступ жив",
              s == 200 and st["active"] is True
              and st["status"] in ("active", "cancelled"), st)
        if st["status"] == "cancelled":
            s, _ = request(uC, base, "/api/subscription/resume", "POST", {}, "10.8.1.3")
            check("стабилизация resume 200", s == 200, s)
        else:
            check("стабилизация: уже active, resume не нужен", True, st["status"])

        # --- Параллельные grant+revoke ---
        section("гонка grant+revoke из админки")
        uD = make_device("10.8.1.4")
        aD = onboard(uD, base, "ГонщикГ", "10.8.1.4")
        ckAdm = cookie_header(admin[1])
        res = parallel(8, lambda i: raw_request(
            base, f"/api/admin/users/{aD}/subscription", "POST",
            {"action": "grant", "period": "month"} if i % 2 == 0 else {"action": "revoke"},
            "10.8.0.9", {"Cookie": ckAdm}))
        statuses = [s for s, _ in res]
        # revoke без строки — честный 400 (гонка сама ставит такие ходы):
        # важно, что нет 500 и все ответы — JSON.
        check("grant/revoke под гонкой: только 200/400, всё JSON, без 500",
              all(s0 in (200, 400) for s0 in statuses)
              and all(is_json(b) for _, b in res),
              f"{statuses}")
        s, res_g = request(admin, base, f"/api/admin/users/{aD}/subscription",
                           "POST", {"action": "grant", "period": "month"}, "10.8.0.9")
        check("стабилизация грантом 200", s == 200, f"{s} {res_g}")

        # --- Доливка при частичной трате ---
        section("доливка карманов: частичная трата → ровно до полного")
        uE = make_device("10.8.1.5")
        aE = onboard(uE, base, "Плательщик", "10.8.1.5")
        uE_id = uid_of(aE)
        s, co = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co
        s, _ = request(uE, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co["paymentId"]}, "10.8.1.5")
        assert s == 200, s
        now_ms = int(time.time() * 1000)
        db_exec("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                (2, now_ms, f"u:{uE_id}"))
        db_exec("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                (5, now_ms, f"agent:{uE_id}"))
        s, co2 = request(uE, base, "/api/subscription/checkout", "POST",
                         {"period": "month"}, "10.8.1.5")
        assert s == 200, co2
        s, _ = request(uE, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co2["paymentId"]}, "10.8.1.5")
        assert s == 200, s
        bk = buckets(uE_id)
        check("u: долит ровно до 10",
              bk.get(f"u:{uE_id}", (None,))[0] == 10, bk)
        check("agent: долит ровно до 50",
              bk.get(f"agent:{uE_id}", (None,))[0] == 50, bk)
        check("таймеры погашены (карман полон)",
              bk.get(f"u:{uE_id}", (0, 1))[1] is None
              and bk.get(f"agent:{uE_id}", (0, 1))[1] is None, bk)

        # --- Грант выше Plus переживает покупку ---
        section("грант 500 + покупка Plus: грант живёт")
        s, res = request(admin, base, f"/api/admin/users/{aE}/ailimit", "POST",
                         {"limit": 500, "remaining": 500}, "10.8.0.9")
        assert s == 200, (s, res)
        s, lim = request(uE, base, "/api/ai/limits", ip="10.8.1.5")
        assert s == 200 and lim["limit"] == 500 and lim["remaining"] == 500, lim
        s, co3 = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co3
        s, _ = request(uE, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co3["paymentId"]}, "10.8.1.5")
        assert s == 200, s
        s, lim = request(uE, base, "/api/ai/limits", ip="10.8.1.5")
        bk = buckets(uE_id)
        check("покупка не срезала грант: limit 500",
              s == 200 and lim["limit"] == 500, lim)
        check("остаток гранта цел (500, не 20)",
              s == 200 and lim["remaining"] == 500, lim)
        check("бакет u: не перезаписан на 20",
              bk.get(f"u:{uE_id}", (None,))[0] == 500, bk)

        # --- Исчерпание → Plus → 10 (легальный путь) ---
        section("исчерпанный лимит + Plus = 10/10")
        uE2 = make_device("10.8.1.7")
        aE2 = onboard(uE2, base, "Исчерпанный", "10.8.1.7")
        uE2_id = uid_of(aE2)
        now_ms = int(time.time() * 1000)
        db_exec("INSERT OR IGNORE INTO ai_usage(owner,count,timer_ms) VALUES (?,?,?)",
                (f"u:{uE2_id}", 5, None))
        db_exec("UPDATE ai_usage SET count=0, timer_ms=? WHERE owner=?",
                (now_ms, f"u:{uE2_id}"))
        s, lim = request(uE2, base, "/api/ai/limits", ip="10.8.1.7")
        check("исчерпан: remaining 0", s == 200 and lim["remaining"] == 0, lim)
        s, co = request(uE2, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.7")
        assert s == 200, co
        s, _ = request(uE2, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co["paymentId"]}, "10.8.1.7")
        assert s == 200, s
        s, lim = request(uE2, base, "/api/ai/limits", ip="10.8.1.7")
        check("после покупки 10/10",
              s == 200 and lim["limit"] == 10 and lim["remaining"] == 10, lim)

        # --- Тик срезает накрутку выше потолка ---
        section("прямая накрутка в БД срезается тиком")
        db_exec("UPDATE ai_usage SET count=?, timer_ms=? WHERE owner=?",
                (9999, int(time.time() * 1000) - 2 * 8 * 3600 * 1000, f"u:{uE2_id}"))
        s, lim = request(uE2, base, "/api/ai/limits", ip="10.8.1.7")
        check("после тика remaining в пределах лимита",
              s == 200 and lim["remaining"] <= lim["limit"], lim)

        # --- Кривые входы checkout ---
        section("кривые входы")
        for bad, name in (({"period": "gold"}, "period=gold"),
                          ({"period": ""}, "period=''"),
                          ({"period": None}, "period=None"),
                          ({"period": 123}, "period=123"),
                          ({"period": "MONTH "}, "period='MONTH ' ok")):
            s, body = request(uE, base, "/api/subscription/checkout", "POST",
                              bad, "10.8.1.5")
            if name.endswith("ok"):
                check(f"checkout {name} → 200", s == 200, f"{s} {body}")
            else:
                check(f"checkout {name} → 400 JSON",
                      s == 400 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/checkout", "POST",
                          {"period": "month", "provider": "gateway"}, "10.8.1.5")
        check("подмена provider в checkout игнорируется (остаётся mock)",
              s == 200 and body.get("provider") == "mock", f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/checkout", "POST",
                          {"period": "month", "idempotencyKey": "x" * 200}, "10.8.1.5")
        check("ключ длиной 200 → 400", s == 400 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/checkout", "POST",
                          {"period": "month", "idempotencyKey": 123}, "10.8.1.5")
        check("нестроковый ключ → 400", s == 400 and is_json(body), f"{s} {body}")

        # --- Кривые confirm ---
        section("кривые confirm")
        for bad, name, want in (
                ({"paymentId": "abc"}, "paymentId='abc'", 404),
                ({"paymentId": -5}, "paymentId=-5", 404),
                ({"paymentId": 999999}, "paymentId=999999", 404),
                ({"paymentId": 0}, "paymentId=0", 404),
                ({"paymentId": 5.0}, "paymentId=5.0", 400),
                ({"paymentId": "   "}, "paymentId='   '", 400),
                ({"paymentId": False}, "paymentId=false", 400),
                ({}, "без paymentId", 400),
                ({"paymentId": None}, "paymentId=None", 400),
                ({"providerPaymentId": "mock_нетакого"}, "чужой providerPaymentId", 404)):
            s, body = request(uE, base, "/api/subscription/confirm", "POST",
                              bad, "10.8.1.5")
            check(f"confirm {name} → {want} JSON",
                  s == want and is_json(body), f"{s} {body}")
        # confirm платежом в терминальном статусе
        s, co = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co
        ppid = co["providerPaymentId"]
        secret = "wh-abuse-secret"
        os.environ["EGE_SUBSCRIPTION_WEBHOOK_SECRET"] = secret

        def sign(ppid_, st_):
            return hmac.new(secret.encode(), f"{ppid_}.{st_}".encode(),
                            hashlib.sha256).hexdigest()

        s, wh = request(uE, base, "/api/subscription/webhook", "POST",
                        {"providerPaymentId": ppid, "status": "failed",
                         "signature": sign(ppid, "failed")}, "10.8.1.5")
        check("webhook failed помечает платёж", s == 200 and wh.get("status") == "failed", wh)
        s, body = request(uE, base, "/api/subscription/confirm", "POST",
                          {"paymentId": co["paymentId"]}, "10.8.1.5")
        check("confirm failed-платежа → 400", s == 400 and is_json(body), f"{s} {body}")

        # --- Чужое ---
        section("чужое трогать нельзя")
        uV = make_device("10.8.1.6")
        aV = onboard(uV, base, "Жертва", "10.8.1.6")
        s, coV = request(uV, base, "/api/subscription/checkout", "POST",
                         {"period": "month"}, "10.8.1.6")
        assert s == 200, coV
        s, body = request(uE, base, "/api/subscription/confirm", "POST",
                          {"paymentId": coV["paymentId"]}, "10.8.1.5")
        check("confirm чужого paymentId → 404", s == 404 and is_json(body),
              f"{s} {body}")
        victim_int = db("SELECT id FROM subscription_payments WHERE public_id=?",
                        (coV["paymentId"],))
        s, body = request(uE, base, "/api/subscription/confirm", "POST",
                          {"paymentId": victim_int[0]["id"]}, "10.8.1.5")
        check("confirm чужого int id (легаси-форма) → 404",
              s == 404 and is_json(body), f"{s} {body}")
        s, stV = request(uV, base, "/api/subscription/status", ip="10.8.1.6")
        check("жертва не активировалась чужими руками",
              s == 200 and stV["active"] is False, stV)
        s, body = request(uE, base, "/api/subscription/confirm", "POST",
                          {"providerPaymentId": coV["providerPaymentId"]}, "10.8.1.5")
        check("confirm чужого providerPaymentId → 404",
              s == 404 and is_json(body), f"{s} {body}")
        s, histE = request(uE, base, "/api/subscription/payments", ip="10.8.1.5")
        pubsE = {p.get("publicId") for p in histE.get("payments", [])}
        check("в чужой истории нет своих платежей",
              s == 200 and coV["paymentId"] not in pubsE, pubsE)
        s, body = request(admin, base, f"/api/admin/users/{aE}/subscription", "POST",
                          {"action": "refund", "paymentId": coV["paymentId"]}, "10.8.0.9")
        check("refund чужого paymentId → 400", s == 400 and is_json(body), f"{s} {body}")
        s, body = request(admin, base, "/api/admin/users/no-such-user-xyz/subscription",
                          "POST", {"action": "grant", "period": "month"}, "10.8.0.9")
        check("grant несуществующему → 404", s == 404 and is_json(body), f"{s} {body}")
        s, body = request(admin, base, "/api/admin/users/no-such-user-xyz/subscription",
                          "POST", {"action": "revoke"}, "10.8.0.9")
        check("revoke несуществующему → 404", s == 404 and is_json(body), f"{s} {body}")
        s, body = request(admin, base, f"/api/admin/users/{aV}/subscription",
                          "POST", {"action": "revoke"}, "10.8.0.9")
        check("revoke без подписки → 400", s == 400 and is_json(body), f"{s} {body}")
        # повторный refund и refund pending
        s, res = request(admin, base, f"/api/admin/users/{aE}/subscription", "POST",
                         {"action": "refund"}, "10.8.0.9")
        assert s == 200, (s, res)
        refunded_pid = res["subscription"]["refund"]["paymentId"]
        s, body = request(admin, base, f"/api/admin/users/{aE}/subscription", "POST",
                          {"action": "refund", "paymentId": refunded_pid}, "10.8.0.9")
        check("повторный refund того же платежа → 400",
              s == 400 and is_json(body), f"{s} {body}")
        s, body = request(admin, base, f"/api/admin/users/{aV}/subscription", "POST",
                          {"action": "refund", "paymentId": coV["paymentId"]}, "10.8.0.9")
        check("refund pending-платежа → 400", s == 400 and is_json(body), f"{s} {body}")
        # вернуть uE подписку для дальнейших секций
        s, co = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co
        s, _ = request(uE, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co["paymentId"]}, "10.8.1.5")
        assert s == 200, s

        # --- Состояния ---
        section("состояния подписки")
        s, body = request(uV, base, "/api/subscription/cancel", "POST", {}, "10.8.1.6")
        check("cancel без подписки → 400", s == 400 and is_json(body), f"{s} {body}")
        s, body = request(uV, base, "/api/subscription/resume", "POST", {}, "10.8.1.6")
        check("resume без cancelled → 400", s == 400 and is_json(body), f"{s} {body}")
        # стэкинг двух разных платежей складывается
        s, st0 = request(uE, base, "/api/subscription/status", ip="10.8.1.5")
        assert s == 200, st0
        exp0 = st0["expiresAt"]
        s, co1 = request(uE, base, "/api/subscription/checkout", "POST",
                         {"period": "month"}, "10.8.1.5")
        assert s == 200, co1
        s, ok1 = request(uE, base, "/api/subscription/confirm", "POST",
                         {"paymentId": co1["paymentId"]}, "10.8.1.5")
        assert s == 200, ok1
        s, co2 = request(uE, base, "/api/subscription/checkout", "POST",
                         {"period": "month"}, "10.8.1.5")
        assert s == 200, co2
        before = int(time.time() * 1000)
        s, ok2 = request(uE, base, "/api/subscription/confirm", "POST",
                         {"paymentId": co2["paymentId"]}, "10.8.1.5")
        month_ms = 30 * 86400 * 1000
        check("два confirm складываются, не перезаписывают",
              s == 200 and abs(ok2["expiresAt"] - (ok1["expiresAt"] + month_ms)) < 120 * 1000,
              (ok1.get("expiresAt"), ok2))
        check("стэкинг растёт от прошлого срока, а не от now",
              ok2["expiresAt"] > before + month_ms, ok2["expiresAt"] - before)
        # cancel держит доступ + re-checkout в конце срока (by design)
        s, st = request(uE, base, "/api/subscription/cancel", "POST", {}, "10.8.1.5")
        check("cancel держит доступ до конца срока (by design)",
              s == 200 and st["active"] is True and st["status"] == "cancelled", st)
        s, lim = request(uE, base, "/api/ai/limits", ip="10.8.1.5")
        check("после cancel лимит Plus жив", s == 200 and lim["limit"] >= 10, lim)
        s, _ = request(uE, base, "/api/subscription/resume", "POST", {}, "10.8.1.5")
        check("resume возвращает active", s == 200, s)
        # confirm после истечения подписки — новый срок от now
        db_exec("UPDATE subscriptions SET expires_at_ms=?, status='expired' WHERE user_id=?",
                (int(time.time() * 1000) - 5000, uE_id))
        s, co = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co
        before = int(time.time() * 1000)
        s, ok = request(uE, base, "/api/subscription/confirm", "POST",
                        {"paymentId": co["paymentId"]}, "10.8.1.5")
        check("confirm после истечения: новый срок от now",
              s == 200 and before + 29 * 86400 * 1000 < ok["expiresAt"]
              < before + 31 * 86400 * 1000, ok)
        s, body = request(uV, base, "/api/subscription/resume", "POST", {}, "10.8.1.6")
        check("resume вечной не-cancelled → 400", s == 400 and is_json(body),
              f"{s} {body}")

        # --- Пагинация истории ---
        section("пагинация payments")
        for q, name in (("?limit=0", "limit=0"), ("?limit=500", "limit=500"),
                        ("?limit=abc", "limit=abc"), ("?limit=-1", "limit=-1"),
                        ("?offset=-1", "offset=-1"), ("?offset=1000000000000", "offset=1e12"),
                        ("?offset=abc", "offset=abc")):
            s, body = request(uE, base, f"/api/subscription/payments{q}", ip="10.8.1.5")
            check(f"payments{q} → 400 JSON", s == 400 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/payments?limit=", ip="10.8.1.5")
        check("payments?limit= treated as absent → 200 default 50 (by design: "
              "parse_qs отбрасывает пустое значение)",
              s == 200 and body.get("limit") == 50, f"{s} {str(body)[:120]}")
        s, hist = request(uE, base, "/api/subscription/payments?limit=2&offset=1",
                          ip="10.8.1.5")
        check("сдвиг offset=1 валиден",
              s == 200 and hist["offset"] == 1 and len(hist["payments"]) <= 2, hist)

        # --- Webhook-абуз ---
        section("вебхук: подписи, повторы, статусы")
        s, co = request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")
        assert s == 200, co
        ppid = co["providerPaymentId"]
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "succeeded",
                           "signature": "кривая"}, "10.8.1.5")
        check("кривая подпись → 403", s == 403 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "succeeded",
                           "signature": ""}, "10.8.1.5")
        check("пустая подпись → 403", s == 403 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "succeeded"}, "10.8.1.5")
        check("без подписи → 403", s == 403 and is_json(body), f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": "mock_нетакого", "status": "succeeded",
                           "signature": sign("mock_нетакого", "succeeded")}, "10.8.1.5")
        check("неизвестный платёж → 404", s == 404 and is_json(body), f"{s} {body}")
        s, wh1 = request(uE, base, "/api/subscription/webhook", "POST",
                         {"providerPaymentId": ppid, "status": "succeeded",
                          "signature": sign(ppid, "succeeded")}, "10.8.1.5")
        check("валидный вебхук активирует",
              s == 200 and wh1.get("already") is False, wh1)
        expW = wh1.get("expiresAt")
        s, wh2 = request(uE, base, "/api/subscription/webhook", "POST",
                         {"providerPaymentId": ppid, "status": "succeeded",
                          "signature": sign(ppid, "succeeded")}, "10.8.1.5")
        check("повтор успеха — already без двойного продления",
              s == 200 and wh2.get("already") is True, wh2)
        s, st = request(uE, base, "/api/subscription/status", ip="10.8.1.5")
        check("срок не вырос дважды", s == 200 and st["expiresAt"] == expW, st)
        s, wh3 = request(uE, base, "/api/subscription/webhook", "POST",
                         {"providerPaymentId": ppid, "status": "failed",
                          "signature": sign(ppid, "failed")}, "10.8.1.5")
        check("failed после succeeded не откатывает (already, by design)",
              s == 200 and wh3.get("already") is True, wh3)
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "refunded",
                           "signature": sign(ppid, "refunded")}, "10.8.1.5")
        check("неизвестный статус вебхука → 400", s == 400 and is_json(body),
              f"{s} {body}")
        os.environ.pop("EGE_SUBSCRIPTION_WEBHOOK_SECRET", None)
        s, body = request(uE, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "succeeded",
                           "signature": "x"}, "10.8.1.5")
        check("без секрета → 503", s == 503 and is_json(body), f"{s} {body}")
        os.environ["EGE_SUBSCRIPTION_WEBHOOK_SECRET"] = secret
        # энтропия provider_payment_id
        ids = {co["providerPaymentId"] for _ in range(3) for co in
               [request(uE, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.5")[1]]}
        import re as _re
        check("providerPaymentId уникальны и вида mock_<24hex>",
              len(ids) == 3 and all(_re.fullmatch(r"mock_[0-9a-f]{24}", i) for i in ids),
              ids)
        pubs = {co["paymentId"] for _ in range(3) for co in
                [request(uE, base, "/api/subscription/checkout", "POST",
                         {"period": "month"}, "10.8.1.5")[1]]}
        check("paymentId публичные: уникальны, 10 символов, не числа",
              len(pubs) == 3 and all(
                  isinstance(p, str) and len(p) == 10 and not p.isdigit()
                  and _re.fullmatch(r"[A-Za-z0-9]{10}", p) for p in pubs),
              pubs)

        # --- Оплата без денег ---
        section("оплата без денег")
        os.environ.pop("EGE_SUBSCRIPTION_MOCK", None)
        uM = make_device("10.8.1.8")
        aM = onboard(uM, base, "Халявщик", "10.8.1.8")
        s, co = request(uM, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.8")
        assert s == 200, co
        s, body = request(uM, base, "/api/subscription/confirm", "POST",
                          {"paymentId": co["paymentId"]}, "10.8.1.8")
        check("confirm при выключенном mock → 503", s == 503 and is_json(body),
              f"{s} {body}")
        s, st = request(uM, base, "/api/subscription/status", ip="10.8.1.8")
        check("подписки без денег нет", s == 200 and st["active"] is False, st)
        os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"

        # --- Смена цены между checkout и confirm ---
        section("смена тарифа в окружении между checkout и confirm")
        os.environ["EGE_PLUS_PRICE_MONTH_KOP"] = "9900"
        s, co = request(uM, base, "/api/subscription/checkout", "POST",
                        {"period": "month"}, "10.8.1.8")
        assert s == 200 and co["amountKopecks"] == 9900, co
        os.environ["EGE_PLUS_PRICE_MONTH_KOP"] = "19900"
        s, ok = request(uM, base, "/api/subscription/confirm", "POST",
                       {"paymentId": co["paymentId"]}, "10.8.1.8")
        check("confirm после смены цены не падает (сумма из checkout)",
              s == 200 and ok.get("already") is False, f"{s} {ok}")
        rows = db("SELECT amount_kopecks FROM subscription_payments WHERE public_id=?",
                  (co["paymentId"],))
        check("сумма платежа зафиксирована (9900)", rows[0]["amount_kopecks"] == 9900, rows)
        os.environ.pop("EGE_PLUS_PRICE_MONTH_KOP", None)

        # --- Ферма ---
        section("ферма: Plus не перетекает на новый аккаунт")
        uF = make_device("10.8.1.5")
        aF = onboard(uF, base, "Фермер", "10.8.1.5")
        s, st = request(uF, base, "/api/subscription/status", ip="10.8.1.5")
        check("новый аккаунт без подписки", s == 200 and st["active"] is False, st)
        s, lim = request(uF, base, "/api/ai/limits", ip="10.8.1.5")
        check("у фермера free-лимит 5", s == 200 and lim["limit"] == 5, lim)
        s, q = request(uF, base, "/api/agent/limits", ip="10.8.1.5")
        check("у фермера квота 10", s == 200 and q["limit"] == 10, q)

        # --- CSRF ---
        section("CSRF-гейт")
        for p, b in (("/api/subscription/checkout", {"period": "month"}),
                     ("/api/subscription/confirm", {"paymentId": 1}),
                     ("/api/subscription/cancel", {})):
            s, body = request(uE, base, p, "POST", b, "10.8.1.5",
                              headers={"Origin": "https://evil.example"})
            check(f"cross-site POST {p} → 403", s == 403 and is_json(body),
                  f"{s} {body}")
        s, body = request(uE, base, "/api/subscription/checkout", "POST",
                          {"period": "month"}, "10.8.1.5")
        check("без Origin проходит (не браузер)", s == 200 and is_json(body),
              f"{s} {body}")

        # --- Бан ---
        section("заблокированный платит мимо")
        uG = make_device("10.8.2.1")
        aG = onboard(uG, base, "Бандит", "10.8.2.1")
        s, res = request(admin, base, f"/api/admin/users/{aG}/block", "POST",
                         {"duration": "1h", "reason": "абуз"}, "10.8.0.9")
        assert s == 200, (s, res)
        for p, m, b in (("/api/subscription/checkout", "POST", {"period": "month"}),
                         ("/api/subscription/status", "GET", None)):
            if m == "GET":
                s, body = request(uG, base, p, m, b, "10.8.2.1")
            else:
                s, body = request(uG, base, p, m, b, "10.8.2.1")
            check(f"бану {m} {p} → 403", s == 403 and is_json(body), f"{s} {body}")
        s, res = request(admin, base, f"/api/admin/users/{aG}/unblock", "POST",
                         {}, "10.8.0.9")
        assert s == 200, (s, res)
        s, body = request(uG, base, "/api/subscription/checkout", "POST",
                          {"period": "month"}, "10.8.2.1")
        check("после разбана checkout снова 200", s == 200, f"{s} {body}")

        # --- Время только серверное ---
        section("время считает сервер")
        far_future = int(time.time() * 1000) + 10 * 365 * 86400 * 1000
        db_exec("UPDATE subscriptions SET expires_at_ms=?, status='active' WHERE user_id=?",
                (far_future, uE_id))
        s, st = request(uE, base, "/api/subscription/status", ip="10.8.1.5")
        check("срок в будущем → active", s == 200 and st["active"] is True, st["expiresAt"])
        db_exec("UPDATE subscriptions SET expires_at_ms=? WHERE user_id=?",
                (int(time.time() * 1000) - 1000, uE_id))
        s, st = request(uE, base, "/api/subscription/status", ip="10.8.1.5")
        check("срок в прошлом → inactive+expired",
              s == 200 and st["active"] is False and st["status"] == "expired", st)
        s, _ = request(uE, base, "/api/subscription/resume", "POST", {}, "10.8.1.5")
        check("resume по истёкшей → 400", s == 400, s)

        # --- Сброс и каскад ---
        section("сброс прогресса и удаление")
        s, res = request(admin, base, f"/api/admin/users/{aV}/subscription", "POST",
                         {"action": "grant", "period": "month"}, "10.8.0.9")
        assert s == 200, res
        s, res = request(admin, base, f"/api/admin/users/{aV}/reset", "POST",
                         {"target": "all-progress"}, "10.8.0.9")
        assert s == 200, (s, res)
        s, st = request(uV, base, "/api/subscription/status", ip="10.8.1.6")
        check("сброс не тронул подписку", s == 200 and st["active"] is True, st)
        s, hist = request(uV, base, "/api/subscription/payments", ip="10.8.1.6")
        check("сброс не тронул платежи", s == 200 and len(hist["payments"]) >= 1, hist)
        v_id = uid_of(aV)
        s, res = request(admin, base, f"/api/admin/users/{aV}/delete", "POST",
                         {}, "10.8.0.9")
        assert s == 200, (s, res)
        left = db("SELECT COUNT(*) c FROM subscriptions WHERE user_id=?", (v_id,))[0]["c"]
        left_pay = db("SELECT COUNT(*) c FROM subscription_payments WHERE user_id=?",
                      (v_id,))[0]["c"]
        check("удаление снесло подписку и платежи",
              left == 0 and left_pay == 0, (left, left_pay))

        # --- Переживание переподключения ---
        section("состояние переживает новое соединение")
        s, co = request(uM, base, "/api/subscription/checkout", "POST",
                        {"period": "year", "idempotencyKey": "persist-1"}, "10.8.1.8")
        assert s == 200, co
        c2 = server.connect()
        try:
            row = c2.execute("SELECT status FROM subscription_payments WHERE public_id=?",
                             (co["paymentId"],)).fetchone()
            persist_ok = row is not None and row["status"] == "pending"
        finally:
            c2.close()
        check("pending виден из нового соединения", persist_ok, co["paymentId"])
        server2 = load_server(db_path)
        c3 = server2.connect()
        try:
            sub = c3.execute("SELECT status FROM subscriptions WHERE user_id="
                             "(SELECT id FROM users WHERE account_id=?)",
                             (aM,)).fetchone()
            st_ok = sub is not None and sub["status"] == "active"
        finally:
            c3.close()
        check("подписка пережила повторную загрузку модуля", st_ok, aM)

        # --- Бэкфилл public_id ---
        section("бэкфилл public_id для строк без него")
        db_exec("UPDATE subscription_payments SET public_id=NULL WHERE public_id=?",
                (co["paymentId"],))
        server._SUB._SCHEMA_DONE.clear()
        s, _ = request(uM, base, "/api/subscription/status", ip="10.8.1.8")
        assert s == 200, s
        rows = db("SELECT id FROM subscription_payments WHERE public_id IS NULL")
        check("старые строки получили public_id", rows == [], rows)
        rows = db("SELECT public_id, COUNT(*) c FROM subscription_payments"
                  " GROUP BY public_id HAVING c > 1")
        check("дублей public_id нет", rows == [], rows)

        # --- Флуд ---
        section("флуд checkout: 429, а не 500")
        uH = make_device("10.8.9.9")
        onboard(uH, base, "Флудер", "10.8.9.9")
        ckH = cookie_header(uH[1])
        results = []
        for i in range(320):
            s, body = raw_request(base, "/api/subscription/checkout", "POST",
                                  {"period": "month"}, "10.8.9.9", {"Cookie": ckH})
            results.append((s, body))
            if not is_json(body):
                break
        codes = [s for s, _ in results]
        check("все ответы JSON даже под флудом",
              all(is_json(b) for _, b in results), codes[-3:])
        check("флуд получил 429", 429 in codes, f"429×{codes.count(429)} 500×{codes.count(500)}")
        check("ни одного 500 под флудом", 500 not in codes, codes[:5])

    print(f"\n{checks - failures}/{checks} ok")
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
