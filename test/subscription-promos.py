#!/usr/bin/env python3
"""Поощрения Plus: промокоды и массовая выдача.

Офлайн, temp-БД (модуль subscription.py напрямую, как test/provider-delete.py
дёргает ai.py; живого сервера и шлюза нет, mock-confirm включён флагом):
  * CRUD промокодов и валидация входов (формат/тип/значение/тариф/лимит/срок);
  * quote: математика скидок, округление до рублей, чужие тарифы, истёкшие,
    исчерпанные и выключенные коды;
  * checkout со скидкой (pending на сумму со скидкой, код в payload) и код
    на 100% (активация сразу, платёж provider=promo 0₽, вне оборота);
  * счётчик использований растёт только при успешной активации, оплаченный
    счёт чтут даже при исчерпанном коде, брошенный счёт код не сжигает;
  * массовая выдача: account ID + числовые id, поводы в истории, пропуски
    с причинами, пресет листа ожидания с пометкой «выдано», лимит пачки.
"""
from __future__ import annotations

import importlib.util
import os
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

tmp = tempfile.mkdtemp(prefix="ege-sub-promos-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"

spec = importlib.util.spec_from_file_location("ege_sub_promos", ROOT / "server" / "subscription.py")
assert spec and spec.loader
sub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sub)

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail))[:220] if detail else ''}")


import sqlite3

conn = sqlite3.connect(os.environ["EGE_DB_PATH"])
conn.row_factory = sqlite3.Row
conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, account_id TEXT)")
for uid, acc in ((1, "aaa111"), (2, "bbb222"), (3, "ccc333")):
    conn.execute("INSERT INTO users (id, account_id) VALUES (?,?)", (uid, acc))
conn.commit()

PRICE_M = sub.plus_price_kopecks("month")
PRICE_Y = sub.plus_price_kopecks("year")

# --- создание и валидация ------------------------------------------------
p = sub.promo_create(conn, "leto20", "percent", 20)
check("создан percent", p["code"] == "LETO20" and p["active"] is True, p)
for bad in (lambda: sub.promo_create(conn, "leto20", "percent", 10),
            lambda: sub.promo_create(conn, "xx", "percent", 10),
            lambda: sub.promo_create(conn, "bad code!", "percent", 10),
            lambda: sub.promo_create(conn, "zero0", "percent", 0),
            lambda: sub.promo_create(conn, "big101", "percent", 101),
            lambda: sub.promo_create(conn, "cheap", "fixed", 50),
            lambda: sub.promo_create(conn, "wrng", "bogus", 10),
            lambda: sub.promo_create(conn, "perx", "percent", 10, period="week"),
            lambda: sub.promo_create(conn, "lim0", "percent", 10, max_uses=0),
            lambda: sub.promo_create(conn, "past1", "percent", 10,
                                     expires_at_ms=int(time.time() * 1000) - 1000)):
    try:
        bad()
        check("валидация входов", False)
    except ValueError:
        check("валидация входов", True)

# --- математика -----------------------------------------------------------
q = sub.promo_quote(conn, "leto20", "month")
check("percent 20 (цена вниз до рублей)",
      q["finalKopecks"] == 15900 and q["discountKopecks"] == 4000, q)
sub.promo_create(conn, "fix50", "fixed", 5000)
q = sub.promo_quote(conn, " fix50 ", "month")
check("fixed и пробелы/регистр", q["finalKopecks"] == PRICE_M - 5000, q)
sub.promo_create(conn, "odd15", "percent", 15)
q = sub.promo_quote(conn, "odd15", "month")
check("округление цены вниз до рублей",
      q["finalKopecks"] == 16900 and q["discountKopecks"] == 3000, q)
sub.promo_create(conn, "onlyear", "percent", 10, period="year")
try:
    sub.promo_quote(conn, "onlyear", "month")
    check("чужой тариф отклоняется", False)
except ValueError as e:
    check("чужой тариф отклоняется", "тариф" in str(e), e)
sub.promo_create(conn, "off1", "percent", 10)
sub.promo_set_active(conn, "off1", False)
try:
    sub.promo_quote(conn, "off1", "month")
    check("выключенный отклоняется", False)
except ValueError as e:
    check("выключенный отклоняется", "выключен" in str(e), e)
try:
    sub.promo_quote(conn, "nosuchcode", "month")
    check("неизвестный отклоняется", False)
except ValueError as e:
    check("неизвестный отклоняется", "не найден" in str(e), e)
lst = sub.promo_list(conn)
check("список кодов", len(lst) >= 5 and all("used" in r for r in lst), len(lst))

# --- checkout со скидкой ---------------------------------------------------
out = sub.create_checkout(conn, 1, "month", sub.PROVIDER_MOCK, "key-disc-1", "LETO20")
exp_final = sub.promo_quote(conn, "LETO20", "month")["finalKopecks"]
check("pending со скидкой",
      out["status"] == "pending" and out["amountKopecks"] == exp_final
      and out["promo"] == "LETO20"
      and out["discountKopecks"] == PRICE_M - exp_final,
      {k: out.get(k) for k in ("amountKopecks", "promo", "discountKopecks")})
row = conn.execute("SELECT payload_json FROM subscription_payments WHERE public_id=?",
                   (out["paymentId"],)).fetchone()
check("код в payload счёта", '"LETO20"' in (row["payload_json"] or ""))
used_before = sub.promo_get(conn, "LETO20")["used"]
check("брошенный счёт код не сжигает", used_before == 0, used_before)
res = sub.confirm_payment(conn, out["paymentId"], sub.PROVIDER_MOCK, expected_user_id=1)
check("mock-confirm активирует", res["status"] == "succeeded")
check("использование засчитано", sub.promo_get(conn, "LETO20")["used"] == 1)
try:
    sub.create_checkout(conn, 2, "month", sub.PROVIDER_MOCK, "key-bad", "NOSUCHCODE")
    check("невалидный код в checkout отклоняется", False)
except ValueError:
    check("невалидный код в checkout отклоняется", True)

# --- код на 100% ------------------------------------------------------------
sub.promo_create(conn, "free1", "percent", 100, max_uses=1)
out = sub.create_checkout(conn, 2, "month", sub.PROVIDER_MOCK, "key-free-1", "FREE1")
check("100% без счёта", out["status"] == "succeeded"
      and out["provider"] == "promo" and out["amountKopecks"] == 0, out.get("status"))
check("Plus активен", sub.subscription_status(conn, 2)["active"] is True)
try:
    sub.promo_quote(conn, "FREE1", "month")
    check("single-use исчерпан", False)
except ValueError as e:
    check("single-use исчерпан", "исчерпан" in str(e), e)
ov = sub.subscription_overview(conn)
check("промо 0₽ вне оборота, скидочный счёт — в обороте",
      ov["money"]["paidCount"] == 1 and ov["money"]["revenueKopecks"] == 15900,
      ov["money"])
check("промо в статистике", ov["promos"]["total"] >= 6
      and ov["promos"]["usedTotal"] >= 2, ov["promos"])

# --- массовая выдача ---------------------------------------------------------
sub.join_launch_waitlist(conn, 3)
bonus = sub.admin_bonus(conn, ["aaa111", "2", "ghost", "aaa111"], "month",
                        note="розыгрыш", include_waitlist=True)
got = sorted(r["userId"] for r in bonus["granted"])
check("выдано своим + ждущему", got == [1, 2, 3], bonus)
check("повод в истории",
      conn.execute("SELECT payload_json FROM subscription_payments"
                   " WHERE user_id=1 ORDER BY id DESC LIMIT 1").fetchone()["payload_json"].find("розыгрыш") >= 0)
check("пропуск с причиной",
      len(bonus["skipped"]) == 1 and bonus["skipped"][0]["reason"] == "не найден",
      bonus["skipped"])
check("лист помечен выданным", sub.launch_waitlist_stats(conn)["pending"] == 0)
check("все Plus активны", all(sub.subscription_status(conn, u)["active"] for u in (1, 2, 3)))
try:
    sub.admin_bonus(conn, [f"u{i:04d}" for i in range(501)], "month")
    check("лимит пачки", False)
except ValueError:
    check("лимит пачки", True)
try:
    sub.admin_bonus(conn, ["aaa111"], "week")
    check("период валидируется", False)
except ValueError:
    check("период валидируется", True)

# --- лимит пачки учитывает и слияние с листом ожидания ---------------------
now = int(time.time() * 1000)
for i in range(1000, 1502):
    conn.execute("INSERT INTO users (id, account_id) VALUES (?,?)",
                 (i, f"wl{i}"))
    conn.execute("INSERT OR IGNORE INTO plus_waitlist"
                 " (user_id, created_at_ms, granted_at_ms) VALUES (?,?,NULL)",
                 (i, now))
conn.commit()
try:
    sub.admin_bonus(conn, ["aaa111"], "month", include_waitlist=True)
    check("лимит учитывает лист ожидания", False)
except ValueError:
    check("лимит учитывает лист ожидания", True)
check("откат: лист не тронут",
      sub.launch_waitlist_stats(conn)["pending"] == 502,
      sub.launch_waitlist_stats(conn))

# --- удаление неиспользованных кодов ---------------------------------------
sub.promo_create(conn, "delme", "fixed", 19800)
check("delme создан", any(r["code"] == "DELME" for r in sub.promo_list(conn)))
sub.promo_delete(conn, "delme")
check("неиспользованный удалён",
      not any(r["code"] == "DELME" for r in sub.promo_list(conn)))
try:
    sub.promo_delete(conn, "DELME")
    check("повторное удаление — KeyError", False)
except KeyError:
    check("повторное удаление — KeyError", True)
try:
    sub.promo_delete(conn, "LETO20")  # использован выше (used=1)
    check("использованный не удаляется", False)
except ValueError as e:
    check("использованный не удаляется", "использовался" in str(e), e)
check("использованный на месте", any(r["code"] == "LETO20" for r in sub.promo_list(conn)))

# --- fixed — это копейки (198 ₽ = 19800), включая границы ------------------
sub.promo_create(conn, "r198", "fixed", 19800)
q = sub.promo_quote(conn, "R198", "month")
check("fixed 198 ₽ на месяц: остаток 1 ₽",
      q["discountKopecks"] == 19800 and q["finalKopecks"] == 100, q)
sub.promo_create(conn, "rfree", "fixed", 19900)
q = sub.promo_quote(conn, "RFREE", "month")
check("fixed «всё покрывает»: бесплатно",
      q["discountKopecks"] == 19900 and q["finalKopecks"] == 0, q)
sub.promo_create(conn, "rkop", "fixed", 19850)
q = sub.promo_quote(conn, "RKOP", "month")
check("fixed с копейками: цена округляется вниз до рублей",
      q["finalKopecks"] % 100 == 0 and q["finalKopecks"] == 0, q)

print(f"\n{checks - failures}/{checks} ok")
raise SystemExit(1 if failures else 0)
