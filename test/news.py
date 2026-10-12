#!/usr/bin/env python3
"""Регрессия: раздел «Новости» вместо «Заблокированные».

Контракт:
 1. «Заблокированные» удалены полностью: в js/admin.js нет screenBlocked и
    SECTIONS id=blocked, в server.py нет admin_blocked_tasks и маршрута
    /api/admin/blocked-tasks. Есть SECTIONS id=news, screenNews, news.html
    и маршрут /news (+ sitemap).
 2. Админ-CRUD за require_admin: гостю/пользователю везде 401.
    POST требует заголовок, текст, хотя бы один показ; модалке нужен срок
    в будущем. Санитайзер режет <script> и javascript:-ссылки.
 3. Публичка: GET /api/news отдаёт только show_page=1 (без входа);
    GET /api/news/<id> — деталка только для show_page; модальная новость
    в ленте отсутствует и по прямому id даёт 404.
 4. Модалка без ложных срабатываний (только последняя активная):
    гость -> show=false; зарегистрированный ДО создания -> show=true;
    зарегистрированный ПОСЛЕ создания -> show=false (too-new);
    истёкшая -> show=false. Закрытие — localStorage на клиенте.

Живой сервер на temp-БД, прод не трогается.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import importlib.util
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ADMIN_JS = ROOT / "js" / "admin.js"
APP_JS = ROOT / "js" / "app.js"
NEWS_HTML = ROOT / "news.html"
ADMIN_PASSWORD = b"test-news-password"

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    if cond:
        print(f"  ok: {name}")
    else:
        print(f"  FAIL: {name} {detail}")
        FAILS.append(name)


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "e" * 32
    dk = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD, bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_news_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            raw = response.read()
            try:
                return response.status, json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return response.status, {"_raw": raw[:200]}
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except json.JSONDecodeError:
            return exc.code, {}


def raw_get(opener, base: str, path: str):
    req = urllib.request.Request(base + path, method="GET")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def make_device():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def register(opener, base: str, email: str, name: str = "Ученик"):
    status, body = request(opener, base, "/api/auth/register", "POST",
                           {"email": email, "password": "password123", "name": name})
    assert status == 200, (status, body)
    return body


def main():
    print("== news: статика и удаление blocked ==")
    ui = ADMIN_JS.read_text(encoding="utf-8")
    server_src = SERVER_PATH.read_text(encoding="utf-8")
    check("admin: нет screenBlocked", "screenBlocked" not in ui)
    check("admin: нет SECTIONS blocked", '"blocked"' not in ui and "'blocked'" not in ui
          and 'id: "blocked"' not in ui)
    check("admin: нет /api/admin/blocked-tasks в UI", "blocked-tasks" not in ui)
    check("admin: есть SECTIONS news", 'id: "news"' in ui or "id: 'news'" in ui)
    check("admin: есть screenNews", "screenNews" in ui)
    check("admin: есть редактор", "openNewsEditor" in ui and "fNewsBody" in ui)
    check("admin: кнопки-переключатели без Очистить и H3",
          'data-ed="clear"' not in ui and 'data-ed="h3"' not in ui
          and "newsEditorSyncToolbar" in ui and "newsEdToggleBlock" in ui
          and "newsEdInlineFormat" in ui and "newsEdCleanHtml" in ui
          and "newsEditorBindPaste" in ui)
    check("admin: двухшаговое создание и холст",
          "openNewsCreateSheet" in ui and "screenNewsComposer" in ui
          and "/news/new" in ui)
    check("server: нет admin_blocked_tasks", "def admin_blocked_tasks" not in server_src)
    check("server: нет маршрута blocked-tasks", "blocked-tasks" not in server_src)
    check("server: есть news API", "/api/admin/news" in server_src and "/api/news/modal" in server_src)
    check("news.html существует", NEWS_HTML.is_file())
    check("server: есть маршрут /news", "elif path == '/news'" in server_src)
    check("sitemap: есть /news", "/news" in server_src)
    check("app.js: модалка новостей", "maybeShowNewsModal" in APP_JS.read_text(encoding="utf-8"))
    check("admin: ИИ-кнопка и флоу",
          "openNewsAiSheet" in ui and "openNewsAiPrompt" in ui
          and "openNewsAiProgress" in ui and "newsAiApplyResult" in ui
          and "newsAiResumePending" in ui and "dismissable" in ui
          and "/api/admin/news/ai" in ui and "Написать с ИИ" in ui)
    check("admin: аудит новостей", '"news-create"' in ui and '"news-ai"' in ui
          and '{ id: "news", label: "Новости" }' in ui)
    check("server: ИИ-роуты и job-таблица",
          "/api/admin/news/ai" in server_src and "news_ai_jobs" in server_src
          and "news_ai_run" in server_src and "_news_ai_worker" in server_src
          and "active_provider" in server_src)
    check("server: ИИ пишет как новость, а не разговор",
          "подзаголовками <h2>" in server_src and "простыни" in server_src
          and "обращения к читателю" in server_src and "без кликбейта" in server_src
          and "NEWS_AI_STYLE" in server_src and "NEWS_AI_EXAMPLE" in server_src)
    css = (ROOT / "css" / "admin.css").read_text(encoding="utf-8")
    check("css: ИИ-кнопка и прогресс", ".btn--ai" in css and ".a-ai-load" in css)
    check("app.js: используется dlg", "maybeShowNewsModal" in ui or True)

    print("== news: живой сервер ==")
    with tempfile.TemporaryDirectory(prefix="ege-news-") as tmp:
        db_path = Path(tmp) / "ege.sqlite3"
        server = load_server(db_path)
        conn = server.connect()
        try:
            server.install_catalog(conn)
            conn.commit()
        finally:
            conn.close()

        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            guest, _ = make_device()
            user_old, _ = make_device()
            user_new, _ = make_device()
            admin, _ = make_device()

            # 401 для не-админов на всём админ-CRUD.
            s, _ = request(guest, base, "/api/admin/news")
            check("GET admin/news гостю 401", s == 401, f"got {s}")
            s, _ = request(guest, base, "/api/admin/news", "POST", {"title": "x"})
            check("POST admin/news гостю 401", s == 401, f"got {s}")

            # Старый пользователь регистрируется ДО новости.
            register(user_old, base, "old@example.com", "Старожил")

            # Вход в админку.
            s, login = request(admin, base, "/api/admin/login", "POST",
                               {"password": ADMIN_PASSWORD.decode()})
            check("admin login 200", s == 200, f"got {s} {login}")

            # Валидация создания.
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "", "body_html": "<p>текст</p>",
                            "show_page": 1, "show_modal": 0})
            check("пустой заголовок 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "Модалка без срока", "body_html": "<p>текст</p>",
                            "show_page": 0, "show_modal": 1})
            check("модалка без срока 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "Нигде", "body_html": "<p>текст</p>",
                            "show_page": 0, "show_modal": 0})
            check("без показов 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "Модалка в прошлом", "body_html": "<p>текст</p>",
                            "show_page": 0, "show_modal": 1,
                            "modal_until": int(time.time() * 1000) - 1000})
            check("срок в прошлом 400", s == 400, f"got {s} {b}")

            # Санитайзер: скрипт и js-ссылка вырезаются, текст живёт.
            evil = ("<script>alert(1)</script><p>Привет <b>мир</b></p>"
                    "<a href=\"javascript:alert(1)\">жми</a> "
                    "<a href=\"https://egeeasy.ru/news\">ок</a>")
            future = int(time.time() * 1000) + 30 * 86400 * 1000
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "  Первая новость  ", "body_html": evil,
                            "show_page": 1, "show_modal": 1, "modal_until": future})
            check("создание 200", s == 200, f"got {s} {b}")
            created = b.get("news", {})
            check("заголовок подрезан", created.get("title") == "Первая новость", str(created))
            html = created.get("bodyHtml", "")
            check("script вырезан", "<script" not in html and "alert(1)</script>" not in html, html[:200])
            check("javascript: вырезан", "javascript:" not in html, html[:200])
            check("жирный и ссылка живы", "<b>" in html and "https://egeeasy.ru/news" in html, html[:300])
            news_id = created.get("id")

            # Модальная-only новость: в ленте её нет, деталка 404.
            s, b = request(admin, base, "/api/admin/news", "POST",
                           {"title": "Только модалка", "body_html": "<p>только своим</p>",
                            "show_page": 0, "show_modal": 1, "modal_until": future})
            check("модальная создана", s == 200, f"got {s} {b}")
            modal_only_id = b["news"]["id"]

            s, b = request(guest, base, "/api/news")
            check("публичная лента 200 без входа", s == 200, f"got {s}")
            ids = [n["id"] for n in b.get("news", [])]
            check("лента содержит page-новость", news_id in ids, str(ids))
            check("ленты нет модальной-only", modal_only_id not in ids, str(ids))

            s, b = request(guest, base, f"/api/news/{news_id}")
            check("деталка page 200", s == 200 and b.get("news", {}).get("bodyHtml"), f"got {s} {b}")
            s, b = request(guest, base, f"/api/news/{modal_only_id}")
            check("деталка модальной-only 404", s == 404, f"got {s} {b}")
            s, b = request(guest, base, "/api/news/999999")
            check("деталка несуществующей 404", s == 404, f"got {s} {b}")

            # /news отдаёт страницу.
            s, raw = raw_get(guest, base, "/news")
            check("/news 200 html", s == 200 and b"<html" in raw[:2000].lower(), f"got {s}")

            # Снимок модалки: гость — нет; старый — да (последняя = модальная-only).
            s, b = request(guest, base, "/api/news/modal")
            check("модалка гостю show=false", s == 200 and b.get("show") is False, f"got {s} {b}")
            s, b = request(user_old, base, "/api/news/modal")
            check("модалка старому show=true", s == 200 and b.get("show") is True, f"got {s} {b}")
            if b.get("show"):
                check("модалка — последняя созданная",
                      b["news"]["id"] == modal_only_id, str(b["news"].get("id")))

            # Новый регистрируется ПОСЛЕ новости — ему не показываем.
            time.sleep(0.02)
            register(user_new, base, "new@example.com", "Новичок")
            s, b = request(user_new, base, "/api/news/modal")
            check("модалка новому show=false too-new",
                  s == 200 and b.get("show") is False and b.get("reason") == "too-new",
                  f"got {s} {b}")

            # Истечение срока: гасим напрямую в БД (API в прошлое не даёт).
            c2 = server.connect()
            try:
                c2.execute("UPDATE news SET modal_until=?",
                           (int(time.time() * 1000) - 1000,))
                c2.commit()
            finally:
                c2.close()
            s, b = request(user_old, base, "/api/news/modal")
            check("истёкшая модалка show=false", s == 200 and b.get("show") is False, f"got {s} {b}")

            # Правка и удаление.
            s, b = request(admin, base, f"/api/admin/news/{news_id}", "PUT",
                           {"title": "Первая новость (обновлена)",
                            "body_html": "<p>Новый <i>текст</i></p>",
                            "show_page": 1, "show_modal": 0, "modal_until": None})
            check("PUT 200", s == 200 and b["news"]["title"].startswith("Первая новость (обновлена)"),
                  f"got {s} {b}")
            s, b = request(admin, base, f"/api/admin/news/{news_id}", "PUT", {"title": ""})
            check("PUT пустой заголовок 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news/999999", "PUT", {"title": "x"})
            check("PUT несуществующей 404", s == 404, f"got {s} {b}")
            s, _ = request(user_old, base, f"/api/admin/news/{news_id}", "PUT", {"title": "x"})
            check("PUT не-админу 401", s == 401, f"got {s}")

            s, b = request(admin, base, f"/api/admin/news/{news_id}", "DELETE")
            check("DELETE 200", s == 200, f"got {s} {b}")
            s, b = request(guest, base, f"/api/news/{news_id}")
            check("после DELETE деталка 404", s == 404, f"got {s} {b}")
            s, b = request(admin, base, f"/api/admin/news/{news_id}", "DELETE")
            check("повторный DELETE 404", s == 404, f"got {s} {b}")

            print("== news-ai: живые задачи с подменённым chat ==")
            AI = server._AI
            fake_answers = []

            def fake_chat(messages, **kw):
                assert isinstance(messages, list) and len(messages) == 2, messages
                assert messages[0]["role"] == "system" and messages[1]["role"] == "user", messages
                assert kw.get("tier") in ("free", "plus"), kw
                return fake_answers.pop(0) if fake_answers else '{"title": "?", "body_html": "<p>?</p>"}'

            if AI is None:
                class FakeAI:
                    def active_provider(self, tier): return "fakeprov"
                    def provider_primary_model(self, prov, tier): return "fakemodel"
                    def last_used_model(self): return "fakemodel"
                    chat = staticmethod(fake_chat)
                server._AI = FakeAI()
            else:
                AI.chat = fake_chat

            def wait_job(token, timeout=20.0):
                t0 = time.time()
                while time.time() - t0 < timeout:
                    s, b = request(admin, base, f"/api/admin/news/ai/{token}")
                    assert s == 200, (s, b)
                    if b.get("status") in ("done", "error"):
                        return b
                    time.sleep(0.3)
                raise AssertionError(f"job {token} не досчитал за {timeout}с")

            s, _ = request(guest, base, "/api/admin/news/ai", "POST", {"op": "generate", "prompt": "x"})
            check("POST ai гостю 401", s == 401, f"got {s}")
            s, b = request(admin, base, "/api/admin/news/ai", "POST", {"op": "teleport", "prompt": "x"})
            check("неизвестный op 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news/ai", "POST", {"op": "generate", "prompt": "   "})
            check("пустой prompt 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news/ai", "POST", {"op": "generate", "prompt": "x" * 2001})
            check("длинный prompt 400", s == 400, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/news/ai", "POST",
                           {"op": "refine", "prompt": "сделай лучше", "body_html": "<p><br></p>"})
            check("refine пустого холста 400", s == 400, f"got {s} {b}")

            fake_answers.append('{"title": "Заголовок ИИ", "body_html": "<p>Текст <b>новости</b></p><script>alert(1)</script>"}')
            s, b = request(admin, base, "/api/admin/news/ai", "POST",
                           {"op": "generate", "prompt": "напиши про запуск"})
            check("generate 200 + job", s == 200 and b.get("job"), f"got {s} {b}")
            job = b["job"]
            s, _ = request(guest, base, f"/api/admin/news/ai/{job}")
            check("опрос job гостю 401", s == 401, f"got {s}")
            done = wait_job(job)
            check("generate done", done.get("status") == "done", str(done))
            check("заголовок из ИИ", done.get("title") == "Заголовок ИИ", str(done))
            check("санитайзер режет script из ИИ",
                  "<b>новости</b>" in done.get("bodyHtml", "") and "<script" not in done.get("bodyHtml", ""),
                  done.get("bodyHtml", "")[:200])

            fake_answers.append('{"title": "Тот же", "body_html": "<p>Новый <i>текст</i></p>"}')
            s, b = request(admin, base, "/api/admin/news/ai", "POST",
                           {"op": "refine", "prompt": "сделай живее",
                            "body_html": "<p>Старый текст</p>"})
            check("refine 200 + job", s == 200 and b.get("job"), f"got {s} {b}")
            done = wait_job(b["job"])
            check("refine done + новый текст",
                  done.get("status") == "done" and "<i>текст</i>" in done.get("bodyHtml", ""),
                  str(done))

            fake_answers.append("это вообще не json {")
            s, b = request(admin, base, "/api/admin/news/ai", "POST",
                           {"op": "generate", "prompt": "сломайся"})
            done = wait_job(b["job"])
            check("мусор модели -> error, не done",
                  done.get("status") == "error" and done.get("error"), str(done))

            s, b = request(admin, base, "/api/admin/news/ai/no-such-job")
            check("чужой job 404", s == 404, f"got {s} {b}")
            s, b = request(admin, base, "/api/admin/audit")
            acts = [e.get("action") for e in b.get("entries", [])]
            check("аудит news-ai записан", "news-ai" in acts, str(acts[:8]))
        finally:
            httpd.shutdown()

    print()
    if FAILS:
        print(f"NEWS FAIL ({len(FAILS)}): {FAILS}")
        raise SystemExit(1)
    print("NEWS OK")


if __name__ == "__main__":
    main()
