#!/usr/bin/env python3
"""Бэкенд подписки Plus: покупка, продление, отмена, история, лимиты.

Покрывает server/subscription.py и его встройку в server.py / agent.py
на живом сервере с temp-БД (прод не трогается):
  * гость везде 401; без модуля подписки — 503 (здесь модуль есть);
  * checkout: pending 19900 коп, неверный период 400, идемпотентность по
    ключу (повтор — тот же paymentId), чужой ключ — 400;
  * confirm без EGE_SUBSCRIPTION_MOCK — 503, с флагом — активация:
    статус active, expires ~+30 сут, зеркало users.subscription='plus',
    карманы u:/agent: долиты до 10/50;
  * лимиты едут за подпиской: GET /api/ai/limits → 10,
    GET /api/agent/limits → 50; повторный confirm — идемпотентный no-op;
  * продление складывается: годовой платёж растёт от конца прошлого срока;
  * cancel держит доступ до конца срока (cancelAtPeriodEnd), resume
    снимает флаг; cancel без подписки и resume после истечения — 400;
  * истечение (срок перемотан в БД): статус inactive, лимиты 5/10,
    строка переведена в expired, зеркало погашено;
  * webhook: без секрета 503, кривая подпись 403, неизвестный платёж 404,
    успех по checkout-платежу активирует, повтор — already;
  * история: свои платежи видны, чужие — нет, пагинация валидируется;
  * админ: grant активирует (платёж 0₽ manual в истории), revoke гасит
    мгновенно, оба пишут аудит; сброс «весь прогресс» подписку НЕ трогает;
    удаление аккаунта сносит подписку и платежи каскадом;
  * гейт ИИ: без флага бесплатный ходит как раньше (лимиты 10),
    с EGE_AGENT_REQUIRES_PLUS=1 — 403 SUBSCRIPTION_REQUIRED, а Plus —
    проходит гейт.
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
ADMIN_PASSWORD = b"test-subscription-admin"

os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_AI_RATE_MAX"] = "1000"
# Фиксированные длительности периодов: календарный месяц по умолчанию
# проверяется отдельно (test/platega-mapping.py), а здесь все сроки —
# про фиксированные 30/365 суток.
os.environ["EGE_PLUS_MONTH_SEC"] = str(30 * 86400)
os.environ["EGE_PLUS_YEAR_SEC"] = str(365 * 86400)
# Тесты гоняют учебный mock-шлюз: прод-ключи Platega из окружения хоста
# здесь гасим, иначе checkout уйдёт в настоящие деньги.
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
    salt = "e" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_subscription_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_device(ip="10.9.0.1"):
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar, ip


def request(dev, base, path, method="GET", body=None, ip="10.9.0.1", headers=None):
    opener, _, _ = dev
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("X-Forwarded-For", ip)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with opener.open(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def onboard(dev, base, name="Ученик", ip="10.9.0.1"):
    status, claimed = request(dev, base, "/api/profile/claim", "POST", {
        "subject": "profile_math", "onboarded": True, "name": name,
        "selfLevel": "base", "goal": "g60",
    }, ip)
    assert status == 200, (status, claimed)
    return claimed["accountId"]


def main():
    with tempfile.TemporaryDirectory(prefix="ege-subscription-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
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
                rows = c.execute(sql, args).fetchall()
                return [dict(r) for r in rows]
            finally:
                c.close()

        def db_exec(sql, args=()):
            c = server.connect()
            try:
                c.execute(sql, args)
                c.commit()
            finally:
                c.close()

        guest = make_device()
        user = make_device()
        user2 = make_device("10.9.0.2")
        admin = make_device("10.9.0.9")

        section("гость и свободный статус")
        for p, m, b in (("/api/subscription/status", "GET", None),
                        ("/api/subscription/payments", "GET", None),
                        ("/api/subscription/checkout", "POST", {"period": "month"}),
                        ("/api/subscription/cancel", "POST", {})):
            s, body = request(guest, base, p, m, b)
            check(f"гость {m} {p} → 401", s == 401, f"{s} {body}")
        target = onboard(user, base, "Плюс")
        target2 = onboard(user2, base, "Второй", "10.9.0.2")
        s, st = request(user, base, "/api/subscription/status")
        check("статус без подписки", s == 200 and st["active"] is False
              and st["plan"] is None and st["limits"] == {
                  "essay": None, "agent": None, "agentAccess": True}, st)
        s, lim = request(user, base, "/api/ai/limits")
        check("free-лимит сочинений 5", s == 200 and lim["limit"] == 5, lim)
        s, q = request(user, base, "/api/agent/limits")
        check("free-квота ИИ 10", s == 200 and q["limit"] == 10, q)

        section("checkout и confirm")
        s, body = request(user, base, "/api/subscription/checkout", "POST",
                           {"period": "semestr"})
        check("неверный период 400", s == 400, f"{s} {body}")
        s, co = request(user, base, "/api/subscription/checkout", "POST",
                         {"period": "month", "idempotencyKey": "k-1"})
        check("checkout month pending 19900",
              s == 200 and co["status"] == "pending" and co["amountKopecks"] == 19900
              and co["currency"] == "RUB" and co["mock"] is True, co)
        pid = co["paymentId"]
        check("paymentId — публичный id (10 символов, не число)",
              isinstance(pid, str) and len(pid) == 10 and not pid.isdigit()
              and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
                      for c in pid), pid)
        s, co2 = request(user, base, "/api/subscription/checkout", "POST",
                          {"period": "year", "idempotencyKey": "k-1"})
        check("повтор с тем же ключом — тот же платёж",
              s == 200 and co2["paymentId"] == pid, co2)
        s, body = request(user2, base, "/api/subscription/checkout", "POST",
                           {"period": "month", "idempotencyKey": "k-1"}, "10.9.0.2")
        check("чужой idempotencyKey 400", s == 400, f"{s} {body}")
        # Без mock-флага confirm запрещён, а не «успешен».
        os.environ.pop("EGE_SUBSCRIPTION_MOCK", None)
        s, body = request(user, base, "/api/subscription/confirm", "POST",
                           {"paymentId": pid})
        check("confirm без mock 503", s == 503, f"{s} {body}")
        os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"
        before = int(time.time() * 1000)
        s, ok = request(user, base, "/api/subscription/confirm", "POST",
                         {"paymentId": pid})
        check("confirm активирует",
              s == 200 and ok["status"] == "succeeded" and ok.get("already") is False, ok)
        exp1 = ok["expiresAt"]
        check("срок ~+30 суток",
              before + 29 * 86400 * 1000 < exp1 < before + 31 * 86400 * 1000, exp1)
        s, ok2 = request(user, base, "/api/subscription/confirm", "POST",
                          {"paymentId": pid})
        check("повторный confirm идемпотентен",
              s == 200 and ok2.get("already") is True and ok2["expiresAt"] == exp1, ok2)
        legacy = db("SELECT id FROM subscription_payments WHERE public_id=?", (pid,))
        s, ok3 = request(user, base, "/api/subscription/confirm", "POST",
                         {"paymentId": legacy[0]["id"] if legacy else -1})
        check("легаси-confirm по int id работает у владельца",
              s == 200 and ok3.get("already") is True
              and ok3.get("paymentId") == pid, ok3)
        s, body = request(user, base, "/api/subscription/checkout", "POST",
                           {"period": "month", "idempotencyKey": "k-1"})
        check("ключ завершённого платежа 409, а не старый счёт",
              s == 409, f"{s} {body}")
        s, body = request(user, base, "/api/subscription/confirm", "POST",
                           {"paymentId": True})
        check("bool paymentId 400 (не платёж №1)", s == 400, f"{s} {body}")
        s, body = request(user, base, "/api/subscription/checkout", "POST",
                           {"period": "month"}, headers={"Origin": "https://evil.example"})
        check("cross-site checkout 403", s == 403, f"{s} {body}")
        mirror = db("SELECT subscription FROM users WHERE account_id=?", (target,))
        check("зеркало users.subscription='plus'",
              mirror and mirror[0]["subscription"] == "plus", mirror)
        buckets = {r["owner"]: r["count"] for r in db(
            "SELECT owner, count FROM ai_usage WHERE owner IN ('u:' || "
            "(SELECT id FROM users WHERE account_id=?), 'agent:' || "
            "(SELECT id FROM users WHERE account_id=?))", (target, target))}
        check("карманы долиты до Plus",
              len(buckets) == 2 and min(buckets.values()) >= 10, buckets)

        section("лимиты едут за подпиской")
        s, lim = request(user, base, "/api/ai/limits")
        check("лимит сочинений стал 10", s == 200 and lim["limit"] == 10, lim)
        s, q = request(user, base, "/api/agent/limits")
        check("квота ИИ стала 50", s == 200 and q["limit"] == 50, q)
        s, st = request(user, base, "/api/subscription/status")
        check("статус active + лимиты",
              s == 200 and st["active"] is True and st["status"] == "active"
              and st["limits"] == {"essay": 10, "agent": 50, "agentAccess": True}, st)

        section("продление складывается, отмена держит срок")
        s, co = request(user, base, "/api/subscription/checkout", "POST",
                         {"period": "year"})
        assert s == 200, co
        s, ok = request(user, base, "/api/subscription/confirm", "POST",
                         {"paymentId": co["paymentId"]})
        check("год продлил от конца прошлого срока",
              s == 200 and abs(ok["expiresAt"] - (exp1 + 365 * 86400 * 1000)) < 60 * 1000, ok)
        exp2 = ok["expiresAt"]
        s, st = request(user, base, "/api/subscription/cancel", "POST", {})
        check("cancel держит доступ",
              s == 200 and st["active"] is True and st["status"] == "cancelled"
              and st["cancelAtPeriodEnd"] is True, st)
        s, lim = request(user, base, "/api/ai/limits")
        check("после cancel лимит всё ещё 10", s == 200 and lim["limit"] == 10, lim)
        s, st = request(user, base, "/api/subscription/resume", "POST", {})
        check("resume снимает флаг",
              s == 200 and st["status"] == "active" and st["cancelAtPeriodEnd"] is False, st)
        s, body = request(user2, base, "/api/subscription/cancel", "POST", {}, "10.9.0.2")
        check("cancel без подписки 400", s == 400, f"{s} {body}")

        section("истечение срока")
        db_exec("UPDATE subscriptions SET expires_at_ms=? WHERE user_id="
                "(SELECT id FROM users WHERE account_id=?)",
                (int(time.time() * 1000) - 1000, target))
        s, st = request(user, base, "/api/subscription/status")
        check("после срока inactive+expired",
              s == 200 and st["active"] is False and st["status"] == "expired", st)
        s, lim = request(user, base, "/api/ai/limits")
        check("лимит вернулся к 5", s == 200 and lim["limit"] == 5, lim)
        s, q = request(user, base, "/api/agent/limits")
        check("квота вернулась к 10", s == 200 and q["limit"] == 10, q)
        mirror = db("SELECT subscription FROM users WHERE account_id=?", (target,))
        check("зеркало погашено", mirror and mirror[0]["subscription"] is None, mirror)
        s, body = request(user, base, "/api/subscription/resume", "POST", {})
        check("resume после истечения 400", s == 400, f"{s} {body}")

        section("вебхук шлюза")
        os.environ.pop("EGE_SUBSCRIPTION_WEBHOOK_SECRET", None)
        s, body = request(user, base, "/api/subscription/webhook", "POST",
                           {"providerPaymentId": "x", "status": "succeeded", "signature": "y"})
        check("без секрета 503", s == 503, f"{s} {body}")
        os.environ["EGE_SUBSCRIPTION_WEBHOOK_SECRET"] = "wh-secret"

        def sign(ppid, st_):
            return hmac.new(b"wh-secret", f"{ppid}.{st_}".encode(),
                            hashlib.sha256).hexdigest()

        s, co = request(user, base, "/api/subscription/checkout", "POST",
                         {"period": "month"})
        assert s == 200, co
        ppid = co["providerPaymentId"]
        s, body = request(user, base, "/api/subscription/webhook", "POST",
                           {"providerPaymentId": ppid, "status": "succeeded",
                            "signature": "кривая"})
        check("кривая подпись 403", s == 403, f"{s} {body}")
        s, body = request(user, base, "/api/subscription/webhook", "POST",
                           {"providerPaymentId": "mock_нетакого",
                            "status": "succeeded", "signature": sign("mock_нетакого", "succeeded")})
        check("неизвестный платёж 404", s == 404, f"{s} {body}")
        s, wh = request(user, base, "/api/subscription/webhook", "POST",
                         {"providerPaymentId": ppid, "status": "succeeded",
                          "signature": sign(ppid, "succeeded")})
        check("вебхук активирует",
              s == 200 and wh.get("already") is False and "expiresAt" in wh, wh)
        s, st = request(user, base, "/api/subscription/status")
        check("после вебхука active", s == 200 and st["active"] is True, st)
        exp3 = st["expiresAt"]
        s, wh2 = request(user, base, "/api/subscription/webhook", "POST",
                          {"providerPaymentId": ppid, "status": "succeeded",
                           "signature": sign(ppid, "succeeded")})
        check("повтор вебхука идемпотентен",
              s == 200 and wh2.get("already") is True, wh2)
        s, st = request(user, base, "/api/subscription/status")
        check("срок не вырос дважды", s == 200 and st["expiresAt"] == exp3, st)

        section("история платежей")
        s, hist = request(user, base, "/api/subscription/payments?limit=2&offset=0")
        check("история: 2 записи и total",
              s == 200 and len(hist["payments"]) == 2 and hist["total"] >= 3
              and hist["payments"][0]["id"] > hist["payments"][1]["id"], hist)
        check("у записи есть деньги и провайдер",
              all(set(p) >= {"amountKopecks", "currency", "period", "status", "provider"}
                  for p in hist["payments"]), hist["payments"])
        s, full = request(user, base, "/api/subscription/payments?limit=50&offset=0")
        check("история отдаёт publicId того же платежа",
              s == 200 and any(p.get("publicId") == pid for p in full["payments"]),
              [p.get("publicId") for p in full["payments"]][:5])
        s, hist2 = request(user2, base, "/api/subscription/payments", "GET", None, "10.9.0.2")
        check("чужие платежи не видны", s == 200 and hist2["payments"] == [], hist2)
        s, body = request(user, base, "/api/subscription/payments?limit=500")
        check("limit вне диапазона 400", s == 400, f"{s} {body}")

        section("админ: грант, отзыв, сброс, удаление")
        s, login = request(admin, base, "/api/admin/login", "POST",
                            {"password": ADMIN_PASSWORD.decode()})
        assert s == 200, (s, login)
        s, res = request(admin, base, f"/api/admin/users/{target2}/subscription", "POST",
                         {"action": "grant", "period": "month", "note": "тест"})
        check("админ-грант активирует",
              s == 200 and res["subscription"]["active"] is True, res)
        s, hist2 = request(user2, base, "/api/subscription/payments", "GET", None, "10.9.0.2")
        manual = [p for p in hist2["payments"] if p["provider"] == "manual"]
        check("грант виден в истории как 0₽ manual",
              len(manual) == 1 and manual[0]["amountKopecks"] == 0
              and manual[0]["status"] == "succeeded", manual)
        buckets = {r["owner"]: r["count"] for r in db(
            "SELECT owner, count FROM ai_usage WHERE owner IN ('u:' || "
            "(SELECT id FROM users WHERE account_id=?), 'agent:' || "
            "(SELECT id FROM users WHERE account_id=?))", (target2, target2))}
        check("грант долил карманы", buckets.get(next(
            (k for k in buckets if k.startswith("u:")), "")) == 10, buckets)
        s, res = request(admin, base, f"/api/admin/users/{target2}/subscription", "POST",
                         {"action": "revoke"})
        check("админ-отзыв гасит мгновенно",
              s == 200 and res["subscription"]["active"] is False, res)
        s, lim = request(user2, base, "/api/ai/limits", "GET", None, "10.9.0.2")
        check("после отзыва лимит 5", s == 200 and lim["limit"] == 5, lim)
        s, body = request(admin, base, f"/api/admin/users/{target2}/subscription", "POST",
                           {"action": "zap"})
        check("неизвестное админ-действие 400", s == 400, f"{s} {body}")

        section("админ-обзор и лист ожидания")
        s, body = request(user, base, "/api/admin/subscription/overview")
        check("обзор без admin-сессии 401", s == 401, f"{s} {body}")
        s, ov = request(admin, base, "/api/admin/subscription/overview")
        base_money = ov["money"] if s == 200 else {}
        base_wait = ov["waitlist"] if s == 200 else {}
        check("обзор отдаёт все блоки",
              s == 200 and set(ov) >= {"users", "subs", "money", "waitlist",
                                       "promos", "config", "recent"}
              and ov["config"]["priceMonthKopecks"] == 19900
              and ov["config"]["plusEssay"] == 10
              and ov["config"]["freeEssay"] == 5, ov)
        s, body = request(guest, base, "/api/subscription/notify", "GET", None)
        check("гость GET notify 401", s == 401, f"{s} {body}")
        s, body = request(guest, base, "/api/subscription/notify", "POST", {})
        check("гость POST notify 401", s == 401, f"{s} {body}")
        s, st = request(user, base, "/api/subscription/notify")
        check("до клика в списке нет", s == 200 and st["joined"] is False, st)
        s, jn = request(user, base, "/api/subscription/notify", "POST", {})
        check("клик записывает", s == 200 and jn["joined"] is True, jn)
        s, jn = request(user, base, "/api/subscription/notify", "POST", {})
        check("повтор идемпотентен", s == 200 and jn["joined"] is True, jn)
        s, cnt = request(admin, base, "/api/admin/subscription/waitlist",
                         "POST", {"action": "count"})
        check("count видит ждущего",
              s == 200 and cnt["pending"] == 1
              and cnt["total"] == base_wait.get("total", 0) + 1, cnt)
        s, gr = request(admin, base, "/api/admin/subscription/waitlist",
                        "POST", {"action": "grant", "period": "month"})
        check("grant выдаёт месяц",
              s == 200 and gr["grantedCount"] == 1, gr)
        s, st = request(user, base, "/api/subscription/status")
        check("после гранта Plus активен",
              s == 200 and st["active"] is True and st["period"] == "month", st)
        s, gr = request(admin, base, "/api/admin/subscription/waitlist",
                        "POST", {"action": "grant"})
        check("повторный grant пуст, а не дубль",
              s == 200 and gr["grantedCount"] == 0, gr)
        s, body = request(admin, base, "/api/admin/subscription/waitlist",
                           "POST", {"action": "bogus"})
        check("неизвестное действие waitlist 400", s == 400, f"{s} {body}")
        s, ov = request(admin, base, "/api/admin/subscription/overview")
        check("обзор после выдачи: +1 manual-грант, оборот не вырос",
              s == 200 and ov["waitlist"]["granted"] == base_wait.get("granted", 0) + 1
              and ov["waitlist"]["pending"] == 0
              and ov["money"]["manualGrants"] == base_money.get("manualGrants", 0) + 1
              and ov["money"]["revenueKopecks"] == base_money.get("revenueKopecks", 0)
              and ov["users"]["plusActive"] >= 1, ov)
        manual_pub = db("SELECT public_id FROM subscription_payments WHERE user_id="
                        "(SELECT id FROM users WHERE account_id=?) AND provider='manual'",
                        (target2,))
        s, res = request(admin, base, f"/api/admin/users/{target2}/subscription", "POST",
                         {"action": "refund", "paymentId": manual_pub[0]["public_id"]})
        check("refund по publicId работает",
              s == 200 and res["subscription"]["active"] is False, res)
        # Доливка при активации не зависит от того, трогал ли пользователь
        # лимитные endpoints раньше: таблицы бакетов может не быть вовсе.
        db_exec("DROP TABLE ai_usage")
        u4 = make_device("10.9.0.4")
        target4 = onboard(u4, base, "Свежий", "10.9.0.4")
        s, res = request(admin, base, f"/api/admin/users/{target4}/subscription", "POST",
                         {"action": "grant", "period": "month"})
        check("грант на пустой ai_usage создаёт бакеты",
              s == 200 and res["subscription"]["active"] is True, res)
        s, lim = request(u4, base, "/api/ai/limits", "GET", None, "10.9.0.4")
        check("лимит сразу 10", s == 200 and lim["limit"] == 10, lim)
        s, res = request(admin, base, f"/api/admin/users/{target4}/subscription", "POST",
                         {"action": "refund"})
        check("refund гасит и помечает платёж",
              s == 200 and res["subscription"]["active"] is False
              and res["subscription"]["refund"]["amountKopecks"] == 0, res)
        s, hist = request(u4, base, "/api/subscription/payments", "GET", None, "10.9.0.4")
        states = {p["status"] for p in hist["payments"]}
        check("возвращённый платёж виден как refunded", states == {"refunded"}, states)
        s, body = request(admin, base, f"/api/admin/users/{target4}/subscription", "POST",
                           {"action": "refund"})
        check("повторный refund 400 (возвращать нечего)", s == 400, f"{s} {body}")
        s, body = request(admin, base, f"/api/admin/users/{target4}/subscription", "POST",
                           {"action": "refund", "paymentId": 999999})
        check("refund чужого paymentId 400", s == 400, f"{s} {body}")
        audit = db("SELECT action FROM admin_audit WHERE target_user_id="
                   "(SELECT id FROM users WHERE account_id=?) ORDER BY id", (target4,))
        check("refund в аудите",
              "subscription-refund" in [r["action"] for r in audit], audit)
        audit = db("SELECT action FROM admin_audit WHERE target_user_id="
                   "(SELECT id FROM users WHERE account_id=?) ORDER BY id", (target2,))
        acts = [r["action"] for r in audit]
        check("грант и отзыв в аудите",
              "subscription-grant" in acts and "subscription-revoke" in acts, acts)
        # Сброс прогресса — не биллинг: подписка переживает его.
        s, res = request(admin, base, f"/api/admin/users/{target}/subscription", "POST",
                         {"action": "grant", "period": "month"})
        assert s == 200, res
        s, res = request(admin, base, f"/api/admin/users/{target}/reset", "POST",
                         {"target": "all-progress"})
        assert s == 200, (s, res)
        s, st = request(user, base, "/api/subscription/status")
        check("сброс прогресса не трогает подписку",
              s == 200 and st["active"] is True, st)
        s, detail = request(admin, base, f"/api/admin/users/{target}")
        du = (detail.get("user") or {}) if s == 200 else {}
        check("деталка отдаёт подписку и платежи для карточки",
              s == 200 and (du.get("subscription") or {}).get("active") is True
              and isinstance(du.get("subscriptionPayments"), list)
              and len(du["subscriptionPayments"]) >= 1, du.get("subscription"))
        uid = db("SELECT id FROM users WHERE account_id=?", (target2,))[0]["id"]
        s, res = request(admin, base, f"/api/admin/users/{target2}/delete", "POST", {})
        assert s == 200, (s, res)
        left = db("SELECT COUNT(*) c FROM subscriptions WHERE user_id=?", (uid,))[0]["c"]
        left_pay = db("SELECT COUNT(*) c FROM subscription_payments WHERE user_id=?", (uid,))[0]["c"]
        check("удаление сносит подписку и платежи каскадом",
              left == 0 and left_pay == 0, (left, left_pay))

        section("промокоды: quote и скидка")
        s, body = request(admin, base, "/api/admin/subscription/promos", "POST",
                          {"action": "create", "code": "TEST25", "kind": "percent", "value": 25})
        check("админ заводит код", s == 200 and body["promo"]["code"] == "TEST25", body)
        s, body = request(admin, base, "/api/admin/subscription/promos", "POST",
                          {"action": "create", "code": "TEST25", "kind": "percent", "value": 10})
        check("повтор кода 400", s == 400, f"{s} {body}")
        s, body = request(admin, base, "/api/admin/subscription/promos", "POST",
                          {"action": "set_active", "code": "TEST25", "active": False})
        check("выключение кода", s == 200 and body["promo"]["active"] is False, body)
        s, body = request(user, base, "/api/subscription/promo/quote", "POST",
                          {"period": "month", "code": "test25"})
        check("выключенный код не считается", s == 400, f"{s} {body}")
        s, body = request(admin, base, "/api/admin/subscription/promos", "POST",
                          {"action": "set_active", "code": "TEST25", "active": True})
        assert s == 200, body
        s, body = request(user, base, "/api/subscription/promo/quote", "POST",
                          {"period": "month", "code": " test25 "})
        check("quote: регистр/пробелы, скидка 25%, цена вниз до рублей",
              s == 200 and body["discountKopecks"] == 5000
              and body["finalKopecks"] == 14900, body)
        s, body = request(user, base, "/api/subscription/promo/quote", "POST",
                          {"period": "week", "code": "TEST25"})
        check("чужой период 400", s == 400, f"{s} {body}")
        s, body = request(user, base, "/api/subscription/promo/quote", "POST",
                          {"code": "TEST25"})
        check("без периода — месяц по умолчанию",
              s == 200 and body["period"] == "month", body)
        s, body = request(guest, base, "/api/subscription/promo/quote", "POST",
                          {"period": "month", "code": "TEST25"})
        check("гостю quote 401", s == 401, f"{s} {body}")
        s, ov = request(admin, base, "/api/admin/subscription/overview")
        codes = [p["code"] for p in (ov.get("promos") or {}).get("list", [])] if s == 200 else []
        check("обзор показывает коды", "TEST25" in codes, codes)
        s, body = request(user, base, "/api/subscription/checkout", "POST",
                          {"period": "month", "promoCode": "TEST25",
                           "idempotencyKey": "promo-key-1"})
        check("счёт со скидкой и кодом в ответе",
              s == 200 and body["amountKopecks"] == 14900
              and body["promo"] == "TEST25", body)

        section("гейт ИИ")
        agent = server._AGENT
        assert agent is not None
        # target2 удалён выше — заводим свежего бесплатного.
        u3 = make_device("10.9.0.3")
        onboard(u3, base, "Бесплатный", "10.9.0.3")
        s, body = request(u3, base, "/api/agent/threads", "POST",
                           {"subject": "profile_math"}, "10.9.0.3")
        tid = (body.get("thread") or {}).get("id") if s == 200 else None
        assert s == 200 and tid, (s, body)
        os.environ.pop("EGE_AGENT_REQUIRES_PLUS", None)
        s, body = request(u3, base, "/api/agent/turns", "POST",
                           {"threadId": tid, "text": "привет"}, "10.9.0.3")
        check("без флага бесплатный не упирается в гейт",
              s != 403 or body.get("code") != "SUBSCRIPTION_REQUIRED", f"{s} {body}")
        os.environ["EGE_AGENT_REQUIRES_PLUS"] = "1"
        s, body = request(u3, base, "/api/agent/turns", "POST",
                           {"threadId": tid, "text": "привет"}, "10.9.0.3")
        check("с флагом бесплатный получает 403",
              s == 403 and body.get("code") == "SUBSCRIPTION_REQUIRED", f"{s} {body}")
        plus_id = db("SELECT id FROM users WHERE account_id=?", (target,))[0]["id"]
        c = server.connect()
        try:
            allowed = agent.agent_access_allowed(c, plus_id)
            free_row = c.execute(
                "SELECT id FROM users WHERE name='Бесплатный'").fetchone()
            free_allowed = agent.agent_access_allowed(
                c, int(free_row["id"]) if free_row else -1)
        finally:
            c.close()
        check("Plus проходит гейт", allowed is True, allowed)
        check("с флагом бесплатный не проходит гейт",
              free_allowed is False, free_allowed)
        os.environ.pop("EGE_AGENT_REQUIRES_PLUS", None)

    print(f"\n{checks - failures}/{checks} ok")
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
