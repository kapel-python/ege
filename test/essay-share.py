#!/usr/bin/env python3
"""Публичные ссылки на сочинения («Поделиться» на ege-result.html).

Приватная ссылка — 10-значный public_id в essay_submissions (только свой,
рядом с легаси /essay/<int>); публичная — отдельный токен в
essay_share_links (одна ссылка на сочинение, всем без входа через
GET /api/shared/essay и страницу /s/<token>).

Покрывает: выдачу public_id при отправке, чтение по pub, 404 чужого,
идемпотентное создание, публичное чтение без личных данных, отзыв,
новую ссылку после отзыва, каскад при удалении сочинения, статику.
Свой temp-БД, живой сервер, прод не трогает.
"""
from __future__ import annotations

import http.cookiejar
import importlib.util
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

PUB_RE = re.compile(r"^[A-Za-z0-9]{10}$")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_share_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=10) as response:
            raw = response.read() or b"{}"
            try:
                return response.status, json.loads(raw)
            except json.JSONDecodeError:
                return response.status, {"_raw": raw[:200].decode("utf-8", "replace")}
    except urllib.error.HTTPError as exc:
        payload = exc.read() or b"{}"
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, {}


def request_raw(opener, base: str, path: str):
    req = urllib.request.Request(base + path, method="GET")
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read() or b""


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


def model_result():
    maxes = {"K1": 1, "K2": 3, "K3": 2, "K4": 1, "K5": 2,
             "K6": 1, "K7": 3, "K8": 3, "K9": 3, "K10": 3}
    names = {"K1": "Позиция автора", "K2": "Комментарий", "K3": "Собственное отношение",
             "K4": "Фактическая точность", "K5": "Логичность речи", "K6": "Этические нормы",
             "K7": "Орфография", "K8": "Пунктуация", "K9": "Грамматика", "K10": "Речевые нормы"}
    criteria = [{"id": cid, "name": names[cid], "score": mx if mx <= 1 else mx - 1,
                 "max_score": mx, "comment": f"Комментарий к {cid}."} for cid, mx in maxes.items()]
    return {"total_score": 999, "max_score": 999, "short_verdict": "Хорошая работа.",
            "criteria": criteria, "what_to_improve": ["Проверить логику"],
            "recommendation": "Так держать."}


def main():
    with tempfile.TemporaryDirectory(prefix="ege-share-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
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
            stranger = make_device()
            guest = make_device()

            status, _ = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "russian", "onboarded": True, "name": "Делящийся"})
            check("CLAIM owner", status == 200)
            status, _ = request(opener, base, "/api/subject", "POST", {"subject": "russian"})
            check("SUBJECT russian", status == 200)
            status, _ = request(stranger, base, "/api/profile/claim", "POST", {
                "subject": "russian", "onboarded": True, "name": "Чужой"})
            check("CLAIM stranger", status == 200)

            # Гость не создаёт ссылок: 401, как у всех доменов ученика.
            status, _ = request(guest, base, "/api/essays/share", "POST", {"sid": 1})
            check("SHARE guest 401", status == 401, f"got={status}")

            text = words(200)
            status, sub = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_1", "skill": "russian_essay_source",
                "text": text, "id": "share-1"})
            check("SUBMIT ok", status == 200, f"got={status}")
            pub = (sub or {}).get("publicId") or ""
            sid = int((sub or {}).get("submissionId") or 0)
            check("SUBMIT publicId 10-char non-digit",
                  bool(PUB_RE.match(pub or "")) and not (pub or "").isdigit() and sid > 0,
                  f"pub={pub!r} sid={sid}")

            status, by_sid = request(opener, base,
                                     f"/api/essays?subject=russian&sid={sid}")
            got = (by_sid or {}).get("submission") or {}
            check("GET by sid: same publicId, no token yet",
                  status == 200 and got.get("publicId") == pub and not got.get("shareToken"),
                  f"got={status}")

            status, by_pub = request(opener, base,
                                     f"/api/essays?subject=russian&pub={pub}")
            check("GET by pub: same submission",
                  status == 200 and (by_pub.get("submission") or {}).get("submissionId") == sid,
                  f"got={status}")

            status, _ = request(opener, base,
                                "/api/essays?subject=russian&pub=AbCdEfGh12")
            check("GET by unknown pub 404", status == 404, f"got={status}")

            # Делиться непроверенным нельзя: публичная страница показала бы
            # «проверка не завершена» вместо результата.
            status, early = request(opener, base, "/api/essays/share", "POST",
                                    {"publicId": pub})
            check("SHARE before ready 409",
                  status == 409 and (early or {}).get("code") == "ESSAY_NOT_READY",
                  f"got={status} {str(early)[:120]}")

            # Доводим до ready напрямую через движок (pipeline идёт тем же
            # путём, здесь важна только готовая запись, а не вызов модели).
            conn2 = server.connect()
            try:
                uid = conn2.execute(
                    "SELECT id FROM users ORDER BY id LIMIT 1").fetchone()[0]
                server.ensure_essay_schema(conn2)
                server.store_essay_check(conn2, int(uid), "russian", text,
                                         "test", model_result(), task_id="re27_1")
                conn2.commit()
                saved = server.save_essay_evaluation(conn2, int(uid), "russian", {
                    "clientId": got.get("clientId"), "status": "ready"})
                conn2.commit()
                check("SEED ready via engine", saved.get("status") == "ready")
            finally:
                conn2.close()

            status, mk = request(opener, base, "/api/essays/share", "POST",
                                 {"publicId": pub})
            token = (mk or {}).get("token") or ""
            check("SHARE create 200 + url",
                  status == 200 and bool(PUB_RE.match(token or ""))
                  and (mk or {}).get("url") == f"/s/{token}" and (mk or {}).get("created") is True,
                  f"got={status} {str(mk)[:160]}")

            status, mk2 = request(opener, base, "/api/essays/share", "POST",
                                  {"sid": sid})
            check("SHARE idempotent same token",
                  status == 200 and (mk2 or {}).get("token") == token
                  and (mk2 or {}).get("created") is False,
                  f"got={status} {str(mk2)[:160]}")

            status, own = request(opener, base,
                                  f"/api/essays?subject=russian&sid={sid}")
            check("OWNER sees shareToken",
                  status == 200 and ((own.get("submission") or {}).get("shareToken") or "") == token,
                  f"got={status}")

            # Публичное чтение гостем: тот же отчёт, но без личных полей.
            status, shared = request(guest, base,
                                     f"/api/shared/essay?token={token}")
            ssub = (shared or {}).get("submission") or {}
            view = ssub.get("view") or {}
            leaked = [k for k in ("clientId", "submissionId", "publicId", "shareToken",
                                  "user_id", "userId", "email", "accountId")
                      if k in ssub]
            check("SHARED guest 200 same scores",
                  status == 200 and view.get("total_score") == 15
                  and view.get("max_score") == 22 and len(view.get("criteria") or []) == 10,
                  f"got={status} total={view.get('total_score')}")
            check("SHARED no personal fields", status == 200 and not leaked,
                  f"leaked={leaked}")
            check("SHARED has text+task",
                  bool(ssub.get("text")) and ssub.get("taskId") == "re27_1",
                  f"task={ssub.get('taskId')}")

            status, _ = request(guest, base, "/api/shared/essay?token=ZzZzZzZzZ1")
            check("SHARED unknown token 404", status == 404, f"got={status}")
            status, _ = request(guest, base, "/api/shared/essay?token=abc")
            check("SHARED bad token 404", status == 404, f"got={status}")
            status, _ = request(guest, base, "/api/shared/essay")
            check("SHARED no token 404", status == 404, f"got={status}")

            # Чужой приватный id не открывается и не шарится.
            status, _ = request(stranger, base,
                                f"/api/essays?subject=russian&sid={sid}")
            check("STRANGER sid 404", status == 404, f"got={status}")
            status, _ = request(stranger, base,
                                f"/api/essays?subject=russian&pub={pub}")
            check("STRANGER pub 404", status == 404, f"got={status}")
            status, _ = request(stranger, base, "/api/essays/share", "POST",
                                {"sid": sid})
            check("STRANGER share 404", status == 404, f"got={status}")
            status, _ = request(stranger, base,
                                f"/api/essays/share?token={token}", "DELETE")
            check("STRANGER revoke 404", status == 404, f"got={status}")
            status, _ = request(guest, base,
                                f"/api/essays/share?token={token}", "DELETE")
            check("GUEST revoke 401", status == 401, f"got={status}")

            # Отзыв: ссылка умирает сразу, у владельца кнопка снова
            # «Поделиться», старая ссылка — 404 неотличимый от «нет».
            status, rev = request(opener, base,
                                   f"/api/essays/share?token={token}", "DELETE")
            check("REVOKE owner 200",
                  status == 200 and (rev or {}).get("revoked") is True,
                  f"got={status} {str(rev)[:120]}")
            status, _ = request(guest, base, f"/api/shared/essay?token={token}")
            check("SHARED after revoke 404", status == 404, f"got={status}")
            status, own2 = request(opener, base,
                                    f"/api/essays?subject=russian&sid={sid}")
            check("OWNER token cleared",
                  status == 200 and not ((own2.get("submission") or {}).get("shareToken") or ""),
                  f"got={status}")
            status, rev2 = request(opener, base,
                                    f"/api/essays/share?token={token}", "DELETE")
            check("REVOKE twice 404", status == 404, f"got={status}")

            # Новая ссылка после отзыва — новый токен, старый мёртв.
            status, mk3 = request(opener, base, "/api/essays/share", "POST",
                                  {"publicId": pub})
            token2 = (mk3 or {}).get("token") or ""
            check("SHARE recreate new token",
                  status == 200 and bool(PUB_RE.match(token2 or ""))
                  and token2 != token and (mk3 or {}).get("created") is True,
                  f"got={status} same={token2 == token}")
            status, _ = request(guest, base, f"/api/shared/essay?token={token2}")
            check("SHARED new token 200", status == 200, f"got={status}")

            # Дешёвый ping живости для открытой страницы (без тела отчёта):
            # им же сторожится отзыв в реальном времени.
            status, ping = request(guest, base,
                                   f"/api/shared/essay?token={token2}&ping=1")
            check("SHARED ping 200 without body",
                  status == 200 and (ping or {}).get("ok") is True
                  and "submission" not in (ping or {}),
                  f"got={status} {str(ping)[:120]}")
            status, _ = request(guest, base,
                                "/api/shared/essay?token=ZzZzZzZzZ1&ping=1")
            check("SHARED ping unknown 404", status == 404, f"got={status}")
            status, _ = request(guest, base, "/api/shared/essay?ping=1")
            check("SHARED ping empty 404", status == 404, f"got={status}")

            # Статика: /s/<token> и /essay/<ref> отдают ту же страницу.
            for url, name in ((f"/s/{token2}", "STATIC /s/<token>"),
                              (f"/essay/{pub}", "STATIC /essay/<public_id>"),
                              (f"/essay/{sid}", "STATIC /essay/<int> (legacy)")):
                code, body = request_raw(guest, base, url)
                ok = code == 200 and "Результат проверки".encode("utf-8") in body
                check(name, ok, f"got={code}")

            # Каскад: удаление сочинения гасит и ссылку (FK ON DELETE CASCADE).
            conn3 = server.connect()
            try:
                server.ensure_essay_schema(conn3)
                conn3.execute("DELETE FROM essay_submissions WHERE id=?", (sid,))
                conn3.commit()
                left = conn3.execute(
                    "SELECT 1 FROM essay_share_links WHERE token=?",
                    (token2,)).fetchone()
                check("CASCADE share gone with submission", left is None)
            finally:
                conn3.close()
            status, _ = request(guest, base, f"/api/shared/essay?token={token2}")
            check("SHARED after delete 404", status == 404, f"got={status}")

            # Карта и история отдают publicId для приватных ссылок практики.
            status, st = request(opener, base,
                                 "/api/essays?subject=russian&statuses=1")
            check("STATUSES ok without sid", status == 200, f"got={status}")
        finally:
            try:
                httpd.shutdown()
            except Exception:
                pass
        print(f"\n{checks - failures}/{checks} passed")
        raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
