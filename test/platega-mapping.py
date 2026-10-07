#!/usr/bin/env python3
"""Platega-маппинг без сети: конфиг, авторизация callback, сверка сумм,
активация по CONFIRMED, идемпотентность, CANCELED, confirm через заглушку
HTTP (живой шлюз не трогается — ни одного внешнего запроса, 27 проверок).

Запуск: python3 test/platega-mapping.py (из корня репозитория).
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for _k in ("EGE_PLATEGA_MERCHANT_ID", "EGE_PLATEGA_SECRET",
           "EGE_PLATEGA_METHOD", "EGE_PLATEGA_BASE_URL",
           "EGE_PLATEGA_TIMEOUT_SEC", "EGE_SUBSCRIPTION_MOCK"):
    os.environ.pop(_k, None)
os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"

spec = importlib.util.spec_from_file_location(
    "ege_platega_mapping", ROOT / "server" / "subscription.py")
assert spec and spec.loader
SUB = importlib.util.module_from_spec(spec)
spec.loader.exec_module(SUB)

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    extra = f" | {detail}" if detail != "" else ""
    print(f"{'PASS' if condition else 'FAIL'} {name}{extra}")


def make_db():
    tmp = tempfile.mkdtemp(prefix="ege-platega-map-")
    conn = sqlite3.connect(str(Path(tmp) / "t.sqlite3"))
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)")
    conn.execute("INSERT INTO users (id) VALUES (1)")
    conn.execute("INSERT INTO users (id) VALUES (2)")
    conn.commit()
    return conn


def set_platega_env():
    os.environ["EGE_PLATEGA_MERCHANT_ID"] = "74838b08-9104-4dec-acb1-d48d2687a74e"
    os.environ["EGE_PLATEGA_SECRET"] = "test-secret-not-real"


def main():
    section = lambda t: print(f"\n== {t}")

    section("конфиг и авторизация")
    check("без env не настроен", SUB.platega_enabled() is False)
    set_platega_env()
    cfg = SUB.platega_config()
    check("с env настроен", cfg is not None and SUB.platega_enabled() is True,
          str({k: v for k, v in (cfg or {}).items() if k != "secret"}))
    check("метод по умолчанию 2", (cfg or {}).get("method") == 2)
    check("auth верная", SUB.platega_webhook_auth(
        "74838b08-9104-4dec-acb1-d48d2687a74e", "test-secret-not-real") is True)
    check("auth чужой секрет", SUB.platega_webhook_auth(
        "74838b08-9104-4dec-acb1-d48d2687a74e", "nope") is False)
    check("auth пустая", SUB.platega_webhook_auth("", "") is False)

    section("webhook CONFIRMED end-to-end (без сети)")
    conn = make_db()
    co = SUB.create_checkout(conn, 1, "month", SUB.PROVIDER_PLATEGA, "key-1")
    try:
        uuid.UUID(str(co["providerPaymentId"]))
        is_uuid = True
    except ValueError:
        is_uuid = False
    check("provider_payment_id — UUID для шлюза", is_uuid, co["providerPaymentId"])
    txn = co["providerPaymentId"]
    try:
        SUB.platega_webhook(conn, "no-such-txn", "CONFIRMED", 199, "RUB")
        unknown = False
    except KeyError:
        unknown = True
    check("неизвестная транзакция 404", unknown)
    try:
        SUB.platega_webhook(conn, txn, "CONFIRMED", 100, "RUB")
        mismatch = False
    except ValueError as exc:
        mismatch = "сумма" in str(exc)
    check("чужая сумма не активирует", mismatch)
    try:
        SUB.platega_webhook(conn, txn, "CONFIRMED", 199, "USD")
        cur = False
    except ValueError:
        cur = True
    check("чужая валюта не активирует", cur)
    try:
        SUB.platega_webhook(conn, txn, "PENDING", 199, "RUB")
        bad = False
    except ValueError:
        bad = True
    check("PENDING по callback не принимаем", bad)
    before = SUB.subscription_status(conn, 1)
    res = SUB.platega_webhook(conn, txn, "CONFIRMED", 199.0, "RUB")
    after = SUB.subscription_status(conn, 1)
    check("CONFIRMED активирует", res.get("ok") is True
          and after["active"] is True and before["active"] is False,
          f"expires={after['expiresAt']}")
    exp1 = after["expiresAt"]
    res2 = SUB.platega_webhook(conn, txn, "CONFIRMED", 199, "RUB")
    after2 = SUB.subscription_status(conn, 1)
    check("повтор идемпотентен", res2.get("already") is True
          and after2["expiresAt"] == exp1)
    late = SUB.platega_webhook(conn, txn, "CANCELED", 199, "RUB")
    check("опоздавший CANCELED доступ не гасит",
          late.get("already") is True and SUB.subscription_status(conn, 1)["active"] is True)
    hist = SUB.payment_history(conn, 1)
    prov = [p for p in hist["payments"] if p["provider"] == "platega"]
    check("история хранит platega", len(prov) == 1 and prov[0]["status"] == "succeeded"
          and prov[0]["amountKopecks"] == 19900)

    section("webhook: диапазон суммы с комиссией шлюза")
    conn.execute("INSERT OR IGNORE INTO users (id) VALUES (3)")
    conn.execute("INSERT OR IGNORE INTO users (id) VALUES (4)")
    conn.execute("INSERT OR IGNORE INTO users (id) VALUES (5)")
    conn.execute("INSERT OR IGNORE INTO users (id) VALUES (6)")
    conn.commit()
    c5a = SUB.create_checkout(conn, 3, "month", SUB.PROVIDER_PLATEGA, "r-1")
    r5 = SUB.platega_webhook(conn, c5a["providerPaymentId"], "CONFIRMED", 212.93, "RUB")
    check("номинал + комиссия (+7%) активирует", r5.get("ok") is True
          and SUB.subscription_status(conn, 3)["active"] is True)
    c5b = SUB.create_checkout(conn, 4, "month", SUB.PROVIDER_PLATEGA, "r-2")
    try:
        SUB.platega_webhook(conn, c5b["providerPaymentId"], "CONFIRMED", 198.99, "RUB")
        under = False
    except ValueError:
        under = True
    check("недоплата на копейку не активирует", under
          and SUB.subscription_status(conn, 4)["active"] is False)
    c5c = SUB.create_checkout(conn, 5, "month", SUB.PROVIDER_PLATEGA, "r-3")
    try:
        SUB.platega_webhook(conn, c5c["providerPaymentId"], "CONFIRMED", 278.60, "RUB")
        over = False
    except ValueError:
        over = True
    check("+40% сверху не активирует", over
          and SUB.subscription_status(conn, 5)["active"] is False)
    c5d = SUB.create_checkout(conn, 6, "month", SUB.PROVIDER_PLATEGA, "r-4")
    r625 = SUB.platega_webhook(conn, c5d["providerPaymentId"], "CONFIRMED", 248.75, "RUB")
    check("граница +25% активирует", r625.get("ok") is True
          and SUB.subscription_status(conn, 6)["active"] is True)

    section("CANCELED по pending")
    co2 = SUB.create_checkout(conn, 2, "year", SUB.PROVIDER_PLATEGA, "key-2")
    r = SUB.platega_webhook(conn, co2["providerPaymentId"], "CANCELED", 1590, "RUB")
    check("CANCELED гасит без активации", r.get("status") == "cancelled"
          and SUB.subscription_status(conn, 2)["active"] is False)

    section("confirm_resolved: диспетчер + живой опрос через заглушку")
    calls = []

    def fake_http(cfg, method, path, body=None):
        calls.append((method, path))
        return dict(fake_http.reply)

    SUB._platega_http = fake_http
    co3 = SUB.create_checkout(conn, 2, "month", SUB.PROVIDER_PLATEGA, "key-3")
    fake_http.reply = {"status": "PENDING"}
    try:
        SUB.confirm_resolved(conn, co3["paymentId"], 2)
        pending_ok = False
    except ValueError as exc:
        pending_ok = "ещё не прошла" in str(exc)
    check("PENDING не активирует", pending_ok and
          SUB.subscription_status(conn, 2)["active"] is False)
    fake_http.reply = {"status": "CANCELED"}
    try:
        SUB.confirm_resolved(conn, co3["paymentId"], 2)
        canc_ok = False
    except ValueError as exc:
        canc_ok = "отменён" in str(exc)
    row = conn.execute("SELECT status FROM subscription_payments WHERE public_id=?",
                       (co3["paymentId"],)).fetchone()
    check("CANCELED гасит строку", canc_ok and row["status"] == "cancelled")
    co4 = SUB.create_checkout(conn, 2, "month", SUB.PROVIDER_PLATEGA, "key-4")
    fake_http.reply = {"status": "CONFIRMED"}
    res4 = SUB.confirm_resolved(conn, co4["paymentId"], 2)
    check("CONFIRMED активирует", res4.get("ok") is True
          and SUB.subscription_status(conn, 2)["active"] is True)
    check("опрос шёл в шлюз", any(p.endswith(co4["providerPaymentId"])
                                  for _, p in calls), str(calls[-1]))
    try:
        SUB.confirm_resolved(conn, co4["paymentId"], 1)
        alien = False
    except KeyError:
        alien = True
    check("чужой платёж неотличим от несуществующего", alien)
    try:
        SUB.confirm_resolved(conn, "no-such-payment", 2)
        missing = False
    except KeyError:
        missing = True
    check("неизвестный платёж 404", missing)

    section("отмена своего pending-счёта")
    cc = SUB.create_checkout(conn, 1, "month", SUB.PROVIDER_PLATEGA, "cx-1")
    cancelled = SUB.cancel_pending_payment(conn, 1, cc["paymentId"])
    row = conn.execute("SELECT status FROM subscription_payments WHERE public_id=?",
                       (cc["paymentId"],)).fetchone()
    check("свой pending отменяется", cancelled.get("status") == "cancelled"
          and row["status"] == "cancelled"
          and SUB.subscription_status(conn, 1)["active"] is True)
    try:
        SUB.cancel_pending_payment(conn, 1, cc["paymentId"])
        double_cancel = False
    except ValueError:
        double_cancel = True
    check("повторная отмена 400", double_cancel)
    try:
        SUB.confirm_resolved(conn, cc["paymentId"], 1)
        dead = False
    except ValueError:
        dead = True
    check("отменённый подтвердить нельзя", dead)
    try:
        SUB.cancel_pending_payment(conn, 2, cc["paymentId"])
        alien_cancel = False
    except KeyError:
        alien_cancel = True
    check("чужой счёт неотличим от несуществующего", alien_cancel)
    try:
        SUB.cancel_pending_payment(conn, 1, "QQQQQQQQQQ")
        missing_cancel = False
    except KeyError:
        missing_cancel = True
    check("неизвестный счёт 404", missing_cancel)

    section("mock-путь не сломан диспетчером")
    mock_co = SUB.create_checkout(conn, 1, "month", SUB.PROVIDER_MOCK, "m-1")
    mock_res = SUB.confirm_resolved(conn, mock_co["paymentId"], 1)
    check("mock confirm через диспетчер", mock_res.get("ok") is True)

    print(f"\n{checks - failures}/{checks} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
