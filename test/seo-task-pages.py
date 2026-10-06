#!/usr/bin/env python3
"""Регрессия программных SEO-страниц заданий и публичного входа.

Покрывает на живом сервере с temp-БД:
 1. GET /ege/ — 200, indexable (meta robots index, без X-Robots-Tag noindex),
    canonical, ссылки на хабы предметов;
 2. GET /ege/russian/ — 200, список номеров со ссылками zadanie-N;
 3. GET /ege/russian/zadanie-17/ — 200, H1 с номером, canonical, JSON-LD
    PracticeProblem, примеры заданий, CTA с ?seo_subject=, интерактивная
    проверка без регистрации; без X-Robots-Tag; профиля в users не заводит;
 4. без слэша — 301 на канон со слэшем;
 5. неизвестный предмет / несуществующий номер — фирменная 404 с noindex;
 6. GET /sitemap.xml содержит /ege/ и zadanie-URL, но не /dashboard;
 7. robots.txt разрешает /ege/;
 8. /dashboard по-прежнему noindex (X-Robots-Tag).
"""
from __future__ import annotations

import importlib.util
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_seo_task_pages", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    fails = []

    def check(name, cond, extra=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else " :: " + extra))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="ege-seo-tasks-") as tmp:
        server = load_server(Path(tmp) / "t.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
            conn.commit()
        finally:
            conn.close()

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def get(path, follow=True):
            opener = urllib.request.build_opener() if follow else _NoRedirect()
            try:
                with opener.open(base + path, timeout=10) as response:
                    return response.status, dict(response.headers), response.read()
            except urllib.error.HTTPError as exc:
                return exc.code, dict(exc.headers), exc.read()

        st, headers, body = get("/ege/")
        text = body.decode("utf-8", "replace")
        check("хаб /ege/ 200", st == 200, str(st))
        check("хаб /ege/ без noindex", headers.get("X-Robots-Tag") is None,
              str(headers.get("X-Robots-Tag")))
        check("хаб /ege/ indexable", 'name="robots" content="index' in text)
        check("хаб /ege/ canonical", 'rel="canonical"' in text and "/ege/" in text)
        check("хаб /ege/ ведёт на предметы", "/ege/russian/" in text)

        st, _, body = get("/ege/russian/")
        text = body.decode("utf-8", "replace")
        check("хаб предмета 200", st == 200, str(st))
        check("хаб предмета со списком номеров", "zadanie-17/" in text and "zadanie-1/" in text)

        users_before = server.connect()
        try:
            n_before = int(users_before.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
        finally:
            users_before.close()
        st, headers, body = get("/ege/russian/zadanie-17/")
        text = body.decode("utf-8", "replace")
        check("страница задания 200", st == 200, str(st))
        check("страница задания без noindex", headers.get("X-Robots-Tag") is None,
              str(headers.get("X-Robots-Tag")))
        check("страница задания indexable", 'name="robots" content="index' in text)
        h1 = re.search(r"<h1>.*?</h1>", text)
        check("H1 с номером задания", bool(h1) and "17" in h1.group(0),
              h1.group(0)[:80] if h1 else "no h1")
        check("canonical страницы задания",
              'rel="canonical"' in text and "/ege/russian/zadanie-17/" in text)
        check("JSON-LD PracticeProblem", "PracticeProblem" in text)
        check("примеры заданий на странице", "seo-task" in text)
        check("CTA с seo_subject", "seo_subject=russian" in text)
        check("проверка ответа без регистрации", "seo-check" in text)
        users_after = server.connect()
        try:
            n_after = int(users_after.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
        finally:
            users_after.close()
        check("SEO-страницы не заводят профилей", n_before == 0 and n_after == 0,
              f"{n_before}->{n_after}")

        st, headers, _ = get("/ege/russian/zadanie-17", follow=False)
        check("без слэша 301 на канон", st == 301, str(st))

        st, headers, body = get("/ege/nope/")
        check("неизвестный предмет 404", st == 404, str(st))
        check("404 с noindex", headers.get("X-Robots-Tag") == "noindex, nofollow",
              str(headers.get("X-Robots-Tag")))
        st, _, _ = get("/ege/russian/zadanie-99/")
        check("несуществующий номер 404", st == 404, str(st))

        st, _, body = get("/sitemap.xml")
        sm = body.decode("utf-8", "replace")
        check("sitemap 200", st == 200, str(st))
        check("sitemap с /ege/", "/ege/" in sm)
        check("sitemap с номерами", "zadanie-17" in sm)
        check("sitemap без /dashboard", "/dashboard" not in sm)

        st, _, body = get("/robots.txt")
        check("robots разрешает /ege/", st == 200 and "Allow: /ege/" in body.decode(),
              str(st))

        st, headers, _ = get("/dashboard")
        check("/dashboard по-прежнему noindex",
              headers.get("X-Robots-Tag") == "noindex, nofollow",
              str(headers.get("X-Robots-Tag")))
        httpd.shutdown()

    print("ALL OK" if not fails else f"{len(fails)} FAILURES")
    raise SystemExit(1 if fails else 0)


class _NoRedirect(urllib.request.OpenerDirector):
    def __init__(self):
        super().__init__()
        self.add_handler(urllib.request.HTTPHandler())

    def open(self, fullurl, data=None, timeout=None):  # noqa: A003
        req = fullurl if isinstance(fullurl, urllib.request.Request) else urllib.request.Request(fullurl)
        return super().open(req, data=data, timeout=timeout or 10)


if __name__ == "__main__":
    main()
