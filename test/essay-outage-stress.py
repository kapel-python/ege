#!/usr/bin/env python3
"""Стабильность проверки сочинений, когда провайдеры отказывают.

Не про корни (упавший шлюз — внешняя помеха, её чинит failover), а про
СЛЕДСТВИЯ: что видит ученик и что происходит с деньгами/данными, когда
модели молчат, флапают или отвечают ерундой.

  * тотальный отказ всех провайдеров: 502 (а не 500/вис), жетон возвращён
    (remaining не изменился), строки проверки нет, evaluation — честный 409;
  * флап «первая попытка упала, повтор прошёл»: 200 и ровно одна трата;
  * один текст в разных заданиях: независимые проверки (модель зовётся под
    каждое задание — оценка считается под проблему, чужой кэш не отдаём),
    каждый submission привязан к своей проверке;
  * один текст в том же задании: кэш (второй проход бесплатный, cached:true);
  * наследие до миграции (строка с пустым task_id) в чужое задание не
    протекает: проверка идёт заново через модель;
  * «Было → стало» и счётчик считаются в разрезе задания;
  * параллельный даблклик одного текста: обе стороны 200, состояние
    целостно (одна строка проверки, оба submission готовы).

Офлайн: server._AI.chat подменён (как в test/ai-limits.py), lt_check пуст,
своя temp-БД и свой порт, прод не трогается.
"""
from __future__ import annotations

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

os.environ["EGE_AI_RATE_MAX"] = "1000"
os.environ["EGE_TRUSTED_PROXY"] = "1"

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def section(title):
    print(f"\n== {title}")


class Client:
    def __init__(self, ip):
        self.ip = ip
        self.cookies = {}

    def request(self, base, method, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        req.add_header("X-Forwarded-For", self.ip)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as exc:
            resp = exc
        with resp:
            for sc in resp.headers.get_all("Set-Cookie") or []:
                name, _, rest = sc.partition("=")
                value = rest.split(";")[0].strip()
                if value:
                    self.cookies[name.strip()] = value
                else:
                    self.cookies.pop(name.strip(), None)
            try:
                payload = json.loads(resp.read() or b"{}")
            except json.JSONDecodeError:
                payload = {}
            return resp.status, payload


_SEQ = [0]


def fresh_text(n=200):
    _SEQ[0] += 1
    seq = _SEQ[0]
    pool = ("память детство пример позиция автор текст отношение связь вывод "
            "вопрос письмо сад война город книга голос долг выбор имя слово вера "
            "совесть путь дом смерть время труд").split()
    return " ".join(f"{w}-{seq}-{i // len(pool)}" for i, w in enumerate((pool * ((n // len(pool)) + 1))[:n]))


def model_payload(k2_score=2):
    criteria = []
    for cid, name, mx in (("K1", "Позиция автора", 1), ("K2", "Комментарий", 3),
                          ("K3", "Собственное отношение", 2), ("K4", "Фактическая точность", 1),
                          ("K5", "Логичность речи", 2), ("K6", "Этические нормы", 1)):
        score = k2_score if cid == "K2" else (mx if mx <= 1 else mx - 1)
        criteria.append({"id": cid, "name": name, "score": score,
                         "max_score": mx, "comment": f"Комментарий к {cid}."})
    return {"total_score": 999, "max_score": 999, "short_verdict": "Разбор готов.",
            "criteria": criteria, "what_to_improve": ["Логика"],
            "recommendation": "Доработать примеры."}


def main():
    for k in ("EGE_AI_API_KEY", "EGE_AI_BASE_URL", "EGE_AI_MODEL", "AI_API_KEY",
              "AI_BASE_URL", "AI_MODEL", "DEFAULT_MODEL", "EGE_CLOSEROUTER_API_KEY",
              "CLOSEROUTER_API_KEY", "EGE_CLOSEROUTER_BASE_URL", "EGE_CLOSEROUTER_MODEL"):
        os.environ.pop(k, None)
    # Один настроенный провайдер, чтобы отказ был отказом транспорта (502),
    # а не «не настроено» (503): сам ответ всё равно из мока.
    os.environ["AI_API_KEY"] = "sk-test-outage-key"
    with tempfile.TemporaryDirectory(prefix="ege-essay-outage-") as tmp:
        os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
        os.environ["EGE_DISABLE_SYSTEMD"] = "1"
        spec = importlib.util.spec_from_file_location("ege_outage_test", SERVER_PATH)
        assert spec and spec.loader
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        ai = server._AI
        assert ai is not None

        calls = {"n": 0}
        behavior = {"mode": "ok"}
        lock = threading.Lock()

        def fake_chat(messages, **kw):
            with lock:
                calls["n"] += 1
                n = calls["n"]
            mode = behavior["mode"]
            if mode == "down":
                raise ai.AIError("провайдер недоступен: TimeoutError")
            if mode == "flaky-once":
                with lock:
                    if not behavior.get("spent"):
                        behavior["spent"] = True
                        raise ai.AIError("провайдер недоступен: TimeoutError")
            # k2 по номеру вызова: различаем проверки друг от друга
            k2 = 3 if n % 2 == 1 else 0
            return json.dumps(model_payload(k2_score=k2), ensure_ascii=False)

        ai.chat = fake_chat
        ai.lt_check = lambda text: []
        ai.reset_ai_rate()

        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def claim(client, name):
            return client.request(base, "POST", "/api/profile/claim",
                                  {"subject": "russian", "onboarded": True, "name": name})

        def limits(client):
            return client.request(base, "GET", "/api/ai/limits")

        def submit(client, task, text):
            st, body = client.request(base, "POST", "/api/essays",
                                      {"subject": "russian", "taskId": task,
                                       "skill": "russian_essay_source", "text": text, "id": f"cid-{task}-{_SEQ[0]}-{time.time_ns()}"})
            assert st == 200, f"submit {st} {body}"
            return body["clientId"]

        def essay(client, task, text, client_id):
            return client.request(base, "POST", "/api/ai/essay",
                                  {"text": text, "taskId": task, "subject": "russian",
                                   "clientId": client_id})

        def evaluate(client, client_id, status="ready"):
            return client.request(base, "POST", "/api/essays/evaluation",
                                  {"subject": "russian", "clientId": client_id, "status": status})

        def remaining(client):
            _, st = limits(client)
            return st.get("remaining")

        try:
            # --------------------------------- тотальный отказ провайдеров
            section("тотальный отказ: 502, возврат жетона, 409")
            u = Client("10.20.0.1")
            claim(u, "Ученик")
            text = fresh_text()
            cid = submit(u, "re27_1", text)
            before = remaining(u)
            behavior["mode"] = "down"
            calls["n"] = 0
            st, body = essay(u, "re27_1", text, cid)
            check("все лежат -> 502 (не 500)", st == 502, f"{st} {body}")
            check("модель дёргали (цепочка пыталась)", calls["n"] >= 1, str(calls["n"]))
            check("жетон возвращён", remaining(u) == before, f"{before} -> {remaining(u)}")
            conn = server.connect()
            try:
                n = conn.execute("SELECT COUNT(*) FROM essay_checks").fetchone()[0]
            finally:
                conn.close()
            check("строки проверки нет", n == 0, str(n))
            st, _ = evaluate(u, cid)
            check("evaluation без проверки -> 409", st == 409, str(st))

            # --------------------------------- флап: упало, повтор прошёл
            section("флап: 200 и ровно одна трата")
            behavior["mode"] = "flaky-once"
            behavior.pop("spent", None)
            calls["n"] = 0
            text2 = fresh_text()
            cid2 = submit(u, "re27_1", text2)
            before = remaining(u)
            st, body = essay(u, "re27_1", text2, cid2)
            check("повтор вытянул -> 200", st == 200 and bool(body.get("result")), f"{st}")
            check("потрачен ровно один жетон", remaining(u) == before - 1, f"{before} -> {remaining(u)}")

            # --------------------------------- один текст, разные задания
            section("один текст в разных заданиях: независимые проверки")
            behavior["mode"] = "ok"
            calls["n"] = 0
            shared = fresh_text()
            cida = submit(u, "re27_1", shared)
            st, ba = essay(u, "re27_1", shared, cida)
            check("задание 1 -> 200", st == 200, str(st))
            cidb = submit(u, "re27_2", shared)
            st, bb = essay(u, "re27_2", shared, cidb)
            check("задание 2 -> 200 (не кэш чужого)", st == 200 and not bb.get("cached"), str(bb.get("cached")))
            check("модель звалась дважды", calls["n"] == 2, str(calls["n"]))
            ta = ba["result"]["total_score"]
            tb = bb["result"]["total_score"]
            check("оценки независимы (разные K2)", ta != tb, f"{ta} vs {tb}")
            st, ea = evaluate(u, cida)
            st, eb = evaluate(u, cidb)
            check("каждый submission привязан к своей проверке",
                  ea["submission"]["result"]["total_score"] == ta
                  and eb["submission"]["result"]["total_score"] == tb,
                  f"{ea['submission']['result']['total_score']},{eb['submission']['result']['total_score']}")

            # --------------------------------- тот же текст, то же задание
            section("тот же текст в том же задании: кэш")
            calls["n"] = 0
            cidc = submit(u, "re27_1", shared)
            st, bc = essay(u, "re27_1", shared, cidc)
            check("повтор -> 200 cached", st == 200 and bc.get("cached") is True, str(bc.get("cached")))
            check("модель не звалась", calls["n"] == 0, str(calls["n"]))

            # --------------------------------- наследие без task_id
            section("наследие (task_id='') не протекает в чужое задание")
            legacy_text = fresh_text()
            conn = server.connect()
            try:
                uid = conn.execute("SELECT id FROM users WHERE name=?", ("Ученик",)).fetchone()["id"]
                conn.execute(
                    "INSERT INTO essay_checks(user_id,subject,text_sha256,task_id,provider,model,result_json,rubric_version,created_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    (uid, "russian", server.essay_text_hash(legacy_text), "",
                     "funpay", "m", json.dumps(model_payload(3), ensure_ascii=False),
                     int(ai.ESSAY_RUBRIC_VERSION), "t"))
                conn.commit()
            finally:
                conn.close()
            calls["n"] = 0
            cidl = submit(u, "re27_3", legacy_text)
            st, bl = essay(u, "re27_3", legacy_text, cidl)
            check("чужое задание -> мимо наследия, через модель",
                  st == 200 and not bl.get("cached"), f"{st} {bl.get('cached')}")
            check("модель звалась", calls["n"] == 1, str(calls["n"]))

            # --------------------------------- было/стало в разрезе задания
            section("previous/count в разрезе задания")
            st, view = u.request(base, "GET", "/api/essays?subject=russian&taskId=re27_2")
            sub = (view.get("submission") or {})
            check("у задания 2 своя история",
                  sub.get("checkCount") == 1 and (sub.get("previous") is None), str({k: sub.get(k) for k in ("checkCount", "previous")}))

            # --------------------------------- параллельный даблклик
            section("параллельный даблклик: целостность")
            u2 = Client("10.20.0.9")
            claim(u2, "Даблклик")
            dt = fresh_text()
            cidd = submit(u2, "re27_4", dt)
            before = remaining(u2)
            out = []
            def hit():
                c = Client("10.20.0.9")
                c.cookies.update(u2.cookies)
                out.append(essay(c, "re27_4", dt, cidd))
            ts = [threading.Thread(target=hit) for _ in range(2)]
            [x.start() for x in ts]
            [x.join() for x in ts]
            check("обе стороны 200", all(s == 200 for s, _ in out), str([(s, b.get("error"), b.get("code")) for s, b in out]))
            conn = server.connect()
            try:
                uid2 = conn.execute("SELECT id FROM users WHERE name=?", ("Даблклик",)).fetchone()["id"]
                n = conn.execute("SELECT COUNT(*) FROM essay_checks WHERE user_id=? AND subject=?",
                                 (uid2, "russian")).fetchone()[0]
                st1, e1 = evaluate(u2, cidd)
            finally:
                conn.close()
            check("submission готов", st1 == 200 and e1["submission"]["status"] == "ready", f"{st1}")
            check("одна строка проверки на текст+задание", n == 1, str(n))
            check("трат не больше двух", before - remaining(u2) <= 2, f"{before} -> {remaining(u2)}")
        finally:
            httpd.shutdown()
            httpd.server_close()
    print(f"\n{checks - failures}/{checks} OK")
    raise SystemExit(1 if failures else 0)


main()
