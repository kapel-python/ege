#!/usr/bin/env python3
"""Граничные случаи подсчёта слов и серверной валидации сочинений.

Единый алгоритм с клиентом (js/state.js countWords): слово — блок букв/цифр
(кириллица/латиница) с допустимым внутренним дефисом/апострофом. Здесь же
проверяется, что POST /api/essays сам пересчитывает слова и отклоняет текст
короче ESSAY_MIN_WORDS — даже если фронтенд обойден.
"""
from __future__ import annotations

import http.cookiejar
import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_essay_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None, raw=None):
    data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read() or b"{}"
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, {}


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def words(n, w="слово"):
    return " ".join([w] * n)


def main():
    with tempfile.TemporaryDirectory(prefix="ege-essay-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        # --- чистый юнит-подсчёт ---
        unit_cases = [
            ("", 0), ("   ", 0), ("\n\t\n", 0), ("!!!", 0), ("…«»—()", 0),
            ("слово", 1), ("  слово  ", 1),
            ("Привет, мир!", 2),
            ("какой-то", 1), ("слово - слово", 2), ("слово — слово", 2),
            ("don't", 1), ("'кавычки'", 1), ("«два слова»", 2),
            ("один\nдва\tтри", 3),
            ("много   пробелов\tи\n\nпереносов", 4),
            (words(149), 149), (words(150), 150), (words(151), 151),
            ("12 34", 2), ("a1-b2", 1),
            (words(400), 400),
        ]
        for text, want in unit_cases:
            got = server.count_essay_words(text)
            check(f"WORDS {want}: {text[:24]!r}", got == want, f"got={got}")

        # нормализация текста
        check("NORMALIZE control chars", server.normalize_essay_text("a\r\nb\x07c ") == "a\nbc")
        check("NORMALIZE non-str", server.normalize_essay_text(None) == "")
        check("NORMALIZE cap", len(server.normalize_essay_text("а" * 40000)) == 30000)

        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            opener = make_device()
            # переключаем гостя на русский (essay endpoint — user-scoped)
            status, _ = request(opener, base, "/api/subject", "POST", {"subject": "russian"})
            check("SUBJECT switch to russian", status == 200)

            def submit(text, task="re_1_1", client_id=None):
                body = {"subject": "russian", "taskId": task, "skill": "russian_essay", "text": text}
                if client_id:
                    body["id"] = client_id
                return request(opener, base, "/api/essays", "POST", body)

            status, body = submit("")
            check("API empty text rejected", status == 400, str(body))
            status, body = submit(words(1))
            check("API 1 word rejected", status == 422 and body.get("wordCount") == 1, str(body))
            status, body = submit(words(149))
            check("API 149 words rejected", status == 422 and body.get("wordCount") == 149 and body.get("minWords") == 150, str(body))
            status, body = submit(words(150), client_id="e2e-150")
            check("API 150 words accepted", status == 200 and body.get("wordCount") == 150 and body.get("evaluationStatus") == "submitted", str(body))
            status, body = submit(words(151, "другое"))
            check("API 151 words accepted", status == 200 and body.get("wordCount") == 151, str(body))
            long_text = ("Привет, мир! " * 80).strip()
            status, body = submit(long_text)
            check("API punctuation-heavy long text accepted", status == 200 and body.get("wordCount") == 160, str(body))
            status, body = submit(words(300))
            check("API 300+ words accepted", status == 200 and body.get("wordCount") == 300, str(body))
            status, body = submit("!!! … —")
            check("API punctuation-only rejected", status in {400, 422}, str(body))

            # ручной POST без фронтенда: тот же лимит
            status, body = submit(words(120))
            check("API raw POST under limit rejected", status == 422, str(body))

            # валидация задания: только long_text, только свой предмет/навык
            status, body = submit(words(200), task="re_1_1")
            check("API essay task ok", status == 200)
            status, body = request(opener, base, "/api/essays", "POST",
                                   {"subject": "russian", "taskId": "n01_p1", "skill": "n01_planimetry", "text": words(200)})
            check("API math task rejected for russian", status == 400, str(body))
            status, body = request(opener, base, "/api/essays", "POST",
                                   {"subject": "russian", "taskId": "re_1_1", "skill": "n01_planimetry", "text": words(200)})
            check("API skill/task mismatch rejected", status == 400, str(body))
            status, body = request(opener, base, "/api/essays", "POST",
                                   {"subject": "russian", "taskId": "nope", "skill": "russian_essay", "text": words(200)})
            check("API unknown task rejected", status == 400, str(body))

            # идемпотентность по client_id
            status, first = submit(words(160), client_id="e2e-idem")
            status2, second = submit(words(160), client_id="e2e-idem")
            check("API idempotent retry", status == 200 and status2 == 200, f"{status}/{status2}")

            # контент реально лежит в БД
            conn = server.connect()
            try:
                n = conn.execute("SELECT COUNT(*) AS n FROM essay_submissions").fetchone()["n"]
                wc = conn.execute("SELECT word_count FROM essay_submissions WHERE client_id='e2e-150'").fetchone()
            finally:
                conn.close()
            check("DB submissions stored", n >= 6 and wc and wc["word_count"] == 150, f"n={n}")

            # XP за сочинение приходит через обычный attempts-flow клиента
            status, boot = request(opener, base, "/api/bootstrap?subject=russian")
            version = boot["state"]["stateVersion"]
            status, saved = request(opener, base, "/api/events/attempts", "POST", {
                "subject": "russian", "expectedVersion": version,
                "events": [{"taskId": "re_1_1", "skill": "russian_essay", "correct": True,
                            "hintLevel": 0, "seconds": 120, "id": "attempt-essay-1"}],
            })
            check("ATTEMPT essay attempt accepted", status == 200 and saved.get("ok") is True, str(saved))
            status, boot2 = request(opener, base, "/api/bootstrap?subject=russian")
            check("XP essay earns XP via standard flow", boot2["state"]["xp"] > 0, f"xp={boot2['state']['xp']}")
            attempt = next((a for a in boot2["state"]["taskAttempts"] if a["taskId"] == "re_1_1"), None)
            check("HISTORY essay in attempt history", attempt is not None and attempt["correct"] is True)
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
