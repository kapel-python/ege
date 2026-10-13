#!/usr/bin/env python3
"""Регрессия файлов данных ЕГЭ-информатики (№9/17/22/24/26/27).

Контракт:
  * задания 6 «файловых» навыков либо несут files:[{assetId, name}],
    либо остаются без файлов (нет вложения в источнике — честно без кнопки);
  * каждый files[].assetId резолвится в visualAssets (type "file"),
    файл существует в assets/informatics/, src версионирован ?v=<хеш>;
  * taskVisualHtml (js/app.js) рендерит синюю кнопку <a download>;
  * живой сервер на temp-БД: файл отдаётся 200 с верным Content-Type,
    SEO-страница номера содержит ссылку скачивания.

    python3 test/inf-files.py
"""
from __future__ import annotations

import hashlib
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
CATALOG = ROOT / "server" / "catalog_informatics.json"
SERVER_PATH = ROOT / "server" / "server.py"

SKILLS = ["inf09_sheet", "inf17_sequence", "inf22_processes",
          "inf24_strings", "inf26_sort", "inf27_data"]
EXPECTED_CT = {".txt": "text/plain", ".csv": "text/csv",
               ".ods": "oasis.opendocument", ".xls": "ms-excel",
               ".xlsx": "spreadsheetml"}


def main() -> int:
    fails = 0

    def t(name: str, cond: bool, extra: str = ""):
        nonlocal fails
        print(("ok  " if cond else "FAIL") + " " + name + ("" if cond or not extra else f" :: {extra}"))
        if not cond:
            fails += 1

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    assets = {a.get("id"): a for a in data.get("visualAssets", []) if isinstance(a, dict)}
    tasks = [x for x in data.get("tasks", []) if x.get("skill") in SKILLS]
    t("6 файловых навыков присутствуют", len(tasks) > 400, str(len(tasks)))
    with_files = [x for x in tasks if x.get("files")]
    without = [x for x in tasks if not x.get("files")]
    t("большинство заданий подключено к файлам", len(with_files) >= len(tasks) * 0.8,
      f"{len(with_files)}/{len(tasks)}")
    print(f"  без файлов ({len(without)}): " + ", ".join(x["id"] for x in without[:12])
          + (" ..." if len(without) > 12 else ""))

    refs_ok, files_ok, version_ok = True, True, True
    bad = []
    for x in with_files:
        if not isinstance(x["files"], list) or not x["files"]:
            refs_ok = False
            bad.append(x["id"])
            continue
        for f in x["files"]:
            a = assets.get((f or {}).get("assetId"))
            if not a or a.get("type") != "file" or not a.get("src"):
                refs_ok = False
                bad.append(f"{x['id']}->{(f or {}).get('assetId')}")
                continue
            src = str(a["src"]).split("?", 1)[0]
            p = ROOT / src
            if not p.exists() or p.stat().st_size == 0:
                files_ok = False
                bad.append(f"{x['id']}:{src} missing")
                continue
            digest = hashlib.md5(p.read_bytes()).hexdigest()[:10]
            if str(a["src"]) != f"{src}?v={digest}":
                version_ok = False
                bad.append(f"{x['id']}:{src} unversioned")
    t("files[].assetId резолвятся в visualAssets type=file", refs_ok, "; ".join(bad[:5]))
    t("файлы существуют и непусты", files_ok, "; ".join(bad[:5]))
    t("src версионированы ?v=<хеш содержимого>", version_ok, "; ".join(bad[:5]))

    app = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
    t("taskFilesHtml определён и зовётся из taskVisualHtml",
      "function taskFilesHtml(" in app and "taskFilesHtml(task, context)" in app)
    t("кнопка: синяя, ссылка, download-атрибут",
      'btn btn--primary' in app and 'task-file-btn' in app and 'download="' in app)
    styles = (ROOT / "css" / "styles.css").read_text(encoding="utf-8")
    t("стили .task-files на месте", ".task-files" in styles and ".task-file-btn" in styles)

    # Чужие предметы не задеты: inf-file-реестр только в информатике.
    others_ok = True
    for path in sorted((ROOT / "server").glob("catalog_*.json")):
        if path.name == "catalog_informatics.json":
            continue
        blob = path.read_text(encoding="utf-8")
        if "inf-file-" in blob:
            others_ok = False
            bad.append(path.name)
    t("другие каталоги не содержат inf-file-ссылок", others_ok, "; ".join(bad[:5]))

    # --- живой сервер на temp-БД ---
    os.environ["EGE_DB_PATH"] = str(Path(tempfile.mkdtemp(prefix="ege-inf-files-")) / "ege.sqlite3")
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_inf_files_test", SERVER_PATH)
    assert spec and spec.loader
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    conn = server.connect()
    try:
        server.install_catalog(conn)
    finally:
        conn.close()
    httpd = server.create_http_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

        def get(path: str):
            req = urllib.request.Request(base + path, method="GET")
            try:
                with opener.open(req, timeout=15) as r:
                    return r.status, r.headers.get("Content-Type", ""), r.read()
            except urllib.error.HTTPError as e:
                return e.code, "", e.read() or b""

        # bootstrap несёт files и file-ассеты
        req = urllib.request.Request(base + "/api/bootstrap?subject=informatics", method="GET")
        with opener.open(req, timeout=15) as r:
            boot = json.loads(r.read())
        btasks = {x["id"]: x for x in boot["catalog"].get("tasks", [])}
        bassets = {a.get("id"): a for a in boot["catalog"].get("visualAssets", [])}
        sample = next((x for x in with_files[:5] if x["id"] in btasks and btasks[x["id"]].get("files")), None)
        t("API отдаёт files у заданий", sample is not None, "нет files в bootstrap")
        dl_ok, ct_ok, byte_ok = False, False, False
        if sample is not None:
            f = btasks[sample["id"]]["files"][0]
            a = bassets.get(f.get("assetId"))
            src = (a.get("src") or "").split("?", 1)[0] if a else ""
            if src:
                st, ct, blob = get("/" + src)
                want = next((v for k, v in EXPECTED_CT.items() if src.endswith(k)), "octet-stream")
                dl_ok = (st == 200 and len(blob) > 0)
                ct_ok = want in (ct or "")
                byte_ok = blob == (ROOT / src).read_bytes()
                t("скачивание файла: 200 + тело", dl_ok, f"{src} -> {st} {len(blob)}b")
                t("верный Content-Type", ct_ok, f"{src} -> {ct!r}")
                t("байты совпадают с assets", byte_ok, src)
            else:
                t("скачивание файла: 200 + тело", False, "нет src в bootstrap")
                t("верный Content-Type", False, "")
                t("байты совпадают с assets", False, "")
        # SEO-страница линии с файлами содержит кнопку скачивания
        st, _, hub = get("/ege/informatics/zadanie-17/")
        t("SEO /ege/informatics/zadanie-17/ 200", st == 200, str(st))
        if st == 200:
            page = hub.decode("utf-8", errors="replace")
            t("SEO содержит ссылку скачивания файла",
              "seo-file-btn" in page and "download=" in page and "inf-file-" in page)
        else:
            t("SEO содержит ссылку скачивания файла", False, "")
    finally:
        httpd.shutdown()
        httpd.server_close()

    print("INF-FILES " + ("OK" if fails == 0 else f"FAILURES={fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
