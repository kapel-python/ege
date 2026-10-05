#!/usr/bin/env python3
"""Журнал админки: у каждого действия есть подпись и расшифровка.

Лента журнала рисуется только по двум картам в js/admin.js (AUDIT_ACTIONS
и AUDIT_DETAIL). Без этого теста новое действие бэкенда (очередной
admin_audit в server.py) показывалось бы сырым кодом — как раньше весь
раздел. Проверяется статически, без сервера:

1. каждое действие из всех admin_audit(...) в server.py есть в обеих картах;
2. категории из карты — только известные вкладки раздела;
3. классы чипов — только существующие в css/admin.css;
4. расшифровки известных форматов разбирают реальные примеры деталей.

Запуск из корня репозитория: python3 test/audit-log.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "server.py"
ADMIN_JS = ROOT / "js" / "admin.js"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)) if detail else ''}")


def map_block(source: str, name: str) -> str:
    """Тело `const NAME = {...};` (первая закрывающая на своей строке)."""
    match = re.search(r"const " + re.escape(name) + r" = \{(.*?)\n\};", source, re.S)
    assert match, f"{name} not found"
    return match.group(1)


def map_keys(block: str) -> set[str]:
    return set(re.findall(r'^\s*"?([A-Za-z0-9._\-]+)"?\s*:', block, re.M))


def main() -> int:
    server = SERVER.read_text(encoding="utf-8")
    js = ADMIN_JS.read_text(encoding="utf-8")

    actions = set(re.findall(r'admin_audit\(\s*conn\s*,\s*.*?\s*,\s*"([^"]+)"', server, re.S))
    # Сырой INSERT в admin_delete_user (транзакция удаления — хелпер с его
    # собственным commit разорвал бы атомарность) и тернарное действие
    # решения Telegram: литералы тоже считаются.
    actions |= set(re.findall(
        r'INSERT INTO admin_audit\(actor_user_id, action,.{0,150}?\(\s*\w+\s*,\s*"([^"]+)"',
        server, re.S))
    for ternary in re.findall(
            r'admin_audit\([^;]{0,200}?"([A-Za-z0-9._\-]+)"\s+if\b[^;]{0,120}?\belse\s+"([A-Za-z0-9._\-]+)"',
            server):
        actions.update(ternary)
    check("действия бэкенда найдены", len(actions) >= 20, sorted(actions))

    actions_block = map_block(js, "AUDIT_ACTIONS")
    detail_block = map_block(js, "AUDIT_DETAIL")
    action_keys = map_keys(actions_block)
    detail_keys = map_keys(detail_block)

    missing_labels = sorted(actions - action_keys)
    check("у каждого действия есть подпись", not missing_labels, missing_labels)
    missing_details = sorted(actions - detail_keys)
    check("у каждого действия есть расшифровка", not missing_details, missing_details)
    extra = sorted((action_keys | detail_keys) - actions)
    # Мусор в картах не роняет ленту, но либо действие переименовали на
    # бэкенде, либо метку забыли удалить — видно сразу.
    check("в картах нет забытых действий", not extra, extra)

    cats = set(re.findall(r'\[\s*"([a-z]+)"\s*,', actions_block))
    check("категории только известные",
          cats <= {"login", "users", "plus", "providers", "inbox"}, sorted(cats))
    check("все вкладки покрыты действиями",
          {"login", "users", "plus", "providers", "inbox"} <= cats, sorted(cats))

    chips = set(re.findall(r'"(a-chip--[a-z]+)"', actions_block))
    css = (ROOT / "css" / "admin.css").read_text(encoding="utf-8")
    unknown_chips = sorted(c for c in chips if ("." + c) not in css and c != "a-chip--accent")
    # a-chip--accent живёт в общей теме (styles.css), остальные — в admin.css.
    check("классы чипов существуют", not unknown_chips, unknown_chips)

    # Точечные примеры реальных форматов деталей (см. вызовы admin_audit).
    cases = [
        ("grant-xp", "+100 за урок", "+100 XP"),
        ("grant-xp", "-50", "-50 XP"),
        ("reset", "all-progress", "весь прогресс"),
        ("ai-limit", "limit=5 remaining=3 agent: limit=10 remaining=7", "лимит 5"),
        ("subscription-grant", "month until 1790000000000", "месяц"),
        ("subscription-refund", "payment=AbC123xYz9 19900", "199,00"),
        ("subscription-waitlist-grant", "month x12", "12"),
        ("support-read", "message 42", "№ 42"),
        ("admin-login-pending", "3C2F7C58 127.0.0.1", "3C2F-7C58"),
    ]
    for action, detail, needle in cases:
        check(f"расшифровка {action}", needle in render_detail(js, action, detail),
              (action, detail))

    print(f"\n{'ALL OK' if failures == 0 else 'FAILURES: ' + str(failures)}: {checks} проверок")
    return 1 if failures else 0


def render_detail(js: str, action: str, detail: str) -> str:
    """Мини-пересказ расшифровок из AUDIT_DETAIL на Python (зеркало логики)."""
    if action == "grant-xp":
        match = re.match(r"\s*([+-]?\d+)\s*(.*)$", detail)
        return f"{match.group(1)} XP" + (f" · {match.group(2)}" if match.group(2) else "") if match else ""
    if action == "reset":
        return {"all-progress": "весь прогресс", "streak": "серия", "errors": "ошибки",
                "daily": "подборка", "forecast": "прогноз"}.get(detail.strip(), "")
    if action == "ai-limit":
        match = re.search(r"limit=(\d+)\s+remaining=(\d+)", detail)
        return f"лимит {match.group(1)}" if match else ""
    if action == "subscription-grant":
        match = re.match(r"^(month|year)\s+until\s+(\d+)", detail)
        return "месяц" if match and match.group(1) == "month" else ""
    if action == "subscription-refund":
        match = re.match(r"payment=(\S+)\s+(\d+)", detail)
        if not match:
            return ""
        return f"{int(match.group(2)) / 100:.2f}".replace(".", ",")
    if action == "subscription-waitlist-grant":
        match = re.match(r"^(month|year)\s+x(\d+)", detail)
        return match.group(2) if match else ""
    if action == "support-read":
        match = re.search(r"message\s+(\d+)", detail)
        return f"№ {match.group(1)}" if match else ""
    if action.startswith("admin-login-"):
        parts = detail.split()
        short = parts[0].upper() if parts else ""
        return f"{short[:4]}-{short[4:]}" if len(short) == 8 else ""
    raise AssertionError(f"no mirror for {action}")


if __name__ == "__main__":
    raise SystemExit(main())
