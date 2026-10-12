#!/usr/bin/env python3
"""Переезд на новый домен: тихая подготовка + автовключение + умный 301.

Покрывает на живом сервере с temp-БД:
  1. без EGE_PRIMARY_DOMAIN — всё как раньше: редиректов между доменами нет,
     sitemap строится от хоста запроса, /api/health без блока live;
  2. вооружён (EGE_PRIMARY_DOMAIN=lemmago.ru), но нового HTTPS-хита ещё не
     было — старый домен работает основным: 200 без редиректа, canonical
     и sitemap — старые, голый HTTP-хит на новый хост защёлку НЕ ставит;
  3. первый HTTPS-хит на новый хост (Host + X-Forwarded-Proto: https за
     доверенным прокси) — защёлка: health показывает live, флаг пережил
     бы рестарт (лежит в app_config);
  4. после включения: GET со старого хоста — 301 ровно на тот же путь+query
     нового (egeeasy.ru/dashboard/profile → lemmago.ru/dashboard/profile,
     query сохраняется), www старого — на apex нового;
  5. /api/* и /.well-known/* на старом хосте НЕ редиректятся (200/404 как
     раньше) — вебхуки и ACME-challenge целы;
  6. canonical/about, robots.txt (Sitemap:), sitemap.xml — новый домен,
     старого в них не осталось;
  7. чужой хост (не primary, не legacy) — без редиректа на новый;
  8. EGE_PRIMARY_LIVE=0 — аварийный откат: старый снова 200 без редиректа.
"""
from __future__ import annotations

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
OLD = "egeeasy.ru"
NEW = "lemmago.ru"


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    for key in ("EGE_PRIMARY_DOMAIN", "EGE_LEGACY_DOMAINS", "EGE_PRIMARY_LIVE",
                "EGE_PUBLIC_URL"):
        os.environ.pop(key, None)
    spec = importlib.util.spec_from_file_location("ege_domain_switch", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def raw_request(base: str, path: str, method: str = "GET", headers: dict | None = None):
    req = urllib.request.Request(base + path, method=method)
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with _OPENER.open(req, timeout=15) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def reset_latch(server) -> None:
    server._SITE_PRIMARY_LIVE["on"] = False
    server._SITE_PRIMARY_LIVE["loaded_at"] = 0.0
    conn = server.connect()
    try:
        conn.execute("DELETE FROM app_config WHERE key=?", (server.SITE_PRIMARY_LIVE_KEY,))
        conn.commit()
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    fails = []

    def check(name, cond, extra=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond else " :: " + extra))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="ege-domain-switch-") as tmp:
        server = load_server(Path(tmp) / "t.sqlite3")
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            # --- 1. Без env: всё как раньше. ---
            st, body, _ = raw_request(base, "/api/health")
            health = json.loads(body or b"{}")
            check("без env health ok", health.get("ok") is True, body[:80].decode("utf-8", "replace")[:80])
            check("без env не armed", health.get("domain", {}).get("armed") is False,
                  str(health.get("domain")))
            st, _, _ = raw_request(base, "/about", headers={"Host": OLD})
            check("без env старый домен без редиректа", st == 200, str(st))

            # --- 2. Вооружён, но включения ещё нет. ---
            os.environ["EGE_PRIMARY_DOMAIN"] = NEW
            st, body, _ = raw_request(base, "/about", headers={"Host": OLD})
            check("до включения старый 200", st == 200, str(st))
            st, body, headers = raw_request(base, "/dashboard?x=1", headers={"Host": OLD})
            check("до включения редиректа нет", st != 301, f"{st} {headers.get('Location')}")
            st, body, _ = raw_request(base, "/about", headers={"Host": NEW})
            check("голый HTTP-хит защёлку не ставит",
                  server.site_primary_live() is False)
            st, body, _ = raw_request(base, "/api/health", headers={"Host": NEW})
            check("до включения health live=false",
                  json.loads(body or b"{}").get("domain", {}).get("live") is False)
            st, body, _ = raw_request(base, "/sitemap.xml", headers={"Host": OLD})
            sm = body.decode("utf-8", "replace")
            check("до включения sitemap без нового домена", NEW not in sm)

            # --- 3. Первый HTTPS-хит на новый хост — защёлка. ---
            https = {"Host": NEW, "X-Forwarded-Proto": "https"}
            st, _, _ = raw_request(base, "/", headers=https)
            check("https-хит на новый принят", st in (200, 301), str(st))
            check("защёлка встала", server.site_primary_live() is True)
            conn = server.connect()
            try:
                row = conn.execute("SELECT value_json FROM app_config WHERE key=?",
                                   (server.SITE_PRIMARY_LIVE_KEY,)).fetchone()
                check("флаг пережил бы рестарт (app_config)",
                      bool(row) and json.loads(row["value_json"]) is True)
            finally:
                conn.close()

            # --- 4. Умный 301 со старого на новый. ---
            st, _, headers = raw_request(
                base, "/dashboard/profile", headers={"Host": OLD})
            check("старая глубокая ссылка 301 на тот же путь нового",
                  st == 301 and headers.get("Location") == f"https://{NEW}/dashboard/profile",
                  f"{st} {headers.get('Location')}")
            st, _, headers = raw_request(
                base, "/ege/russian/zadanie-17/?utm_source=x", headers={"Host": OLD})
            check("редирект сохраняет путь и query",
                  st == 301 and headers.get("Location") == f"https://{NEW}/ege/russian/zadanie-17/?utm_source=x",
                  f"{st} {headers.get('Location')}")
            st, _, headers = raw_request(base, "/", headers={"Host": "www." + OLD})
            check("www старого едет на apex нового",
                  st == 301 and headers.get("Location") == f"https://{NEW}/",
                  f"{st} {headers.get('Location')}")
            st, _, headers = raw_request(base, "/", headers={"Host": "www." + NEW})
            loc = headers.get("Location") or ""
            check("www нового склеивается на apex",
                  st == 301 and "www." not in loc and NEW in loc, f"{st} {loc}")

            # --- 5. API и ACME не редиректятся. ---
            st, body, _ = raw_request(base, "/api/health", headers={"Host": OLD})
            check("API на старом продолжает отдаваться",
                  st == 200 and json.loads(body or b"{}").get("domain", {}).get("live") is True,
                  str(st))
            st, _, headers = raw_request(base, "/.well-known/acme-challenge/x",
                                         headers={"Host": OLD})
            check("ACME-challenge не уезжает",
                  st != 301, f"{st} {headers.get('Location')}")

            # --- 6. Canonical/sitemap/robots — новый домен. ---
            st, body, _ = raw_request(base, "/about", headers=https)
            about = body.decode("utf-8", "replace")
            check("canonical about — новый",
                  f"https://{NEW}/about" in about, "no new canonical")
            check("старого в about не осталось",
                  f"https://{OLD}" not in about and f"https://www.{OLD}" not in about)
            st, body, _ = raw_request(base, "/robots.txt", headers=https)
            robots = body.decode("utf-8", "replace")
            check("robots Sitemap — новый",
                  f"Sitemap: https://{NEW}/sitemap.xml" in robots, robots[-120:])
            st, body, _ = raw_request(base, "/sitemap.xml", headers=https)
            sm = body.decode("utf-8", "replace")
            check("sitemap — новый домен", f"https://{NEW}/" in sm)
            check("sitemap без старого", f"https://{OLD}/" not in sm)

            # --- 7. Чужой хост не уводим. ---
            st, _, headers = raw_request(base, "/", headers={"Host": "evil.example"})
            check("чужой хост без редиректа на новый",
                  st != 301 or NEW not in (headers.get("Location") or ""),
                  f"{st} {headers.get('Location')}")

            # --- 8. Аварийный откат. ---
            os.environ["EGE_PRIMARY_LIVE"] = "0"
            try:
                st, _, headers = raw_request(base, "/", headers={"Host": OLD})
                check("откат: старый снова без редиректа", st != 301,
                      f"{st} {headers.get('Location')}")
            finally:
                os.environ.pop("EGE_PRIMARY_LIVE", None)
            reset_latch(server)
            os.environ.pop("EGE_PRIMARY_DOMAIN", None)
        finally:
            httpd.shutdown()

    print("DOMAIN-SWITCH: " + ("ALL OK" if not fails else f"{len(fails)} FAIL"))
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
