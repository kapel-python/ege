#!/usr/bin/env python3
"""End-to-end пайплайна проверки итогового сочинения (база, без streaming).

submission (POST /api/essays) → AI check (POST /api/ai/essay: существующий
route, модель К1–К6 + детерминированная грамотность К7–К10) → report
generation (POST /api/essays/evaluation → status 'ready') → result ready
(GET /api/essays) → и только потом XP через существующий attempts-flow.

Офлайн: ai.chat и ai.lt_check заглушены (как в test/ai-essay.py), своя
temp-БД и свой порт, прод не трогается. Проверяется и ошибочный сценарий:
'failed' не даёт результата, XP до 'ready' невозможен через этот flow.
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

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_essay_pipeline_test", SERVER_PATH)
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
        with opener.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read() or b"{}"
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, {}


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def words(n, w="слово"):
    return " ".join([w] * n)


def model_payload():
    criteria = []
    for cid, name, mx in (("K1", "Позиция автора", 1), ("K2", "Комментарий", 3),
                          ("K3", "Собственное отношение", 2), ("K4", "Фактическая точность", 1),
                          ("K5", "Логичность речи", 2), ("K6", "Этические нормы", 1)):
        criteria.append({"id": cid, "name": name, "score": mx if mx <= 1 else mx - 1,
                         "max_score": mx, "comment": f"Комментарий к {cid}."})
    return {"total_score": 999, "max_score": 999, "short_verdict": "Работу нужно доработать.",
            "criteria": criteria, "what_to_improve": ["Проверить логику"],
            "recommendation": "Переписать третий абзац."}


def main():
    with tempfile.TemporaryDirectory(prefix="ege-essay-pipe-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        ai = server._AI
        assert ai is not None, "AI module not loaded"
        ai.chat = lambda messages, **kw: json.dumps(model_payload(), ensure_ascii=False)
        ai.lt_check = lambda text: []
        os.environ["AI_API_KEY"] = "sk-test-pipeline-key"

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
            status, _ = request(opener, base, "/api/subject", "POST", {"subject": "russian"})
            check("SUBJECT russian", status == 200)
            ai.reset_ai_rate()

            text = words(200)
            # 1. submission — проверка НЕ завершена, XP нет
            status, sub = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re_1_1", "skill": "russian_essay",
                "text": text, "id": "pipe-1"})
            check("SUBMIT ok, status submitted", status == 200 and sub.get("evaluationStatus") == "submitted", str(sub)[:160])
            check("SUBMIT returns clientId", bool(sub.get("clientId")), str(sub)[:160])
            client_id = sub.get("clientId")
            status, boot0 = request(opener, base, "/api/bootstrap?subject=russian")
            check("XP is zero right after submit", boot0["state"]["xp"] == 0, f"xp={boot0['state']['xp']}")

            # 2. до проверок готового результата нет
            status, got = request(opener, base, "/api/essays?subject=russian&taskId=re_1_1")
            check("GET before checks: submitted, no result",
                  status == 200 and got["submission"]["status"] == "submitted"
                  and got["submission"]["result"] is None, str(got)[:200])

            # 3. AI check существующим route (модель + алгоритмы внутри)
            status, ai_res = request(opener, base, "/api/ai/essay", "POST", {"text": text})
            res = ai_res.get("result", {})
            check("AI 200 with 10 criteria on 22",
                  status == 200 and res.get("max_score") == 22 and len(res.get("criteria", [])) == 10,
                  f"{status} {str(ai_res)[:160]}")
            check("AI total recomputed by server", res.get("total_score") == 19, str(res.get("total_score")))
            ai.reset_ai_rate()

            # 4. report generation — только валидный result становится ready
            status, bad = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready",
                "result": {"total_score": 1, "max_score": 2, "criteria": []}})
            check("READY with garbage rejected (400, no fake result)", status == 400, f"{status} {bad}")
            status, unknown = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": "nope-unknown", "status": "ready", "result": res})
            check("READY unknown submission -> 404", status == 404, f"{status} {unknown}")
            status, saved = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready", "result": res})
            check("READY ok", status == 200 and saved.get("ok") is True
                  and saved["submission"]["status"] == "ready", f"{status} {str(saved)[:200]}")

            # 5. result ready — тот же submission, те же баллы
            status, got2 = request(opener, base, "/api/essays?subject=russian&taskId=re_1_1")
            r2 = got2.get("submission", {})
            check("GET after checks: ready with same scores",
                  status == 200 and r2.get("status") == "ready"
                  and (r2.get("result") or {}).get("total_score") == 19
                  and len((r2.get("result") or {}).get("criteria", [])) == 10, str(r2)[:160])
            check("GET carries saved text", r2.get("wordCount") == 200 and isinstance(r2.get("text"), str))

            # view под ege-result.html: тот же результат, схема шаблона
            view = r2.get("view") or {}
            check("VIEW present for ready", isinstance(view, dict) and view, str(view)[:120])
            check("VIEW scores/words", view.get("total_score") == 19 and view.get("max_score") == 22
                  and view.get("word_count") == 200 and view.get("word_norm_min") == 150, str(view)[:160])
            check("VIEW verdict == AI short_verdict",
                  view.get("verdict") == res.get("short_verdict") and view.get("verdict"), str(view.get("verdict"))[:80])
            check("VIEW groups content/literacy",
                  [g.get("id") for g in (view.get("groups") or [])] == ["content", "literacy"])
            crit = view.get("criteria") or []
            check("VIEW 10 criteria with max (template keys)",
                  len(crit) == 10 and all(set(("id", "group", "name", "score", "max", "comment")) <= set(c) for c in crit),
                  str(crit[0].keys()) if crit else "empty")
            check("VIEW criterion names carry K-id", crit and crit[0].get("name", "").startswith("K1")
                  and crit[6].get("group") == "literacy", str([(c.get("id"), c.get("name")) for c in crit[:2]]))
            check("VIEW improvements/recommendation from AI",
                  view.get("improvements") == res.get("what_to_improve")
                  and view.get("recommendation") == res.get("recommendation"))
            status, exact = request(opener, base, f"/api/essays?subject=russian&clientId={client_id}")
            check("GET by clientId returns exact submission",
                  status == 200 and exact["submission"]["clientId"] == client_id
                  and (exact["submission"].get("view") or {}).get("total_score") == 19, f"{status}")

            # 6. XP — только теперь, существующим attempts-flow
            ver = got2.get("submission") and request(opener, base, "/api/bootstrap?subject=russian")[1]["state"]["stateVersion"]
            status, att = request(opener, base, "/api/events/attempts", "POST", {
                "subject": "russian", "expectedVersion": ver,
                "events": [{"taskId": "re_1_1", "skill": "russian_essay", "correct": True,
                            "hintLevel": 0, "seconds": 120, "id": "attempt-pipe-1"}]})
            check("ATTEMPT after ready accepted", status == 200 and att.get("ok") is True, str(att)[:160])
            status, boot1 = request(opener, base, "/api/bootstrap?subject=russian")
            check("XP earned only after pipeline", boot1["state"]["xp"] > 0, f"xp={boot1['state']['xp']}")

            # 7. ошибочный сценарий: failed — результата нет, чужой не видит
            status, sub2 = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re_1_2", "skill": "russian_essay",
                "text": words(160), "id": "pipe-2"})
            cid2 = sub2.get("clientId")
            status, fail = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid2, "status": "failed"})
            check("FAILED marks not-ready", status == 200 and fail["submission"]["status"] == "failed"
                  and fail["submission"]["result"] is None, f"{status} {str(fail)[:160]}")
            status, gotf = request(opener, base, "/api/essays?subject=russian&taskId=re_1_2")
            check("GET failed: no result to show", status == 200 and gotf["submission"]["status"] == "failed"
                  and gotf["submission"]["result"] is None)
            check("GET failed: no view either", gotf["submission"].get("view") is None)
            # retry после failed — ready принимается
            status, retry = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid2, "status": "ready", "result": res})
            check("RETRY failed->ready ok", status == 200 and retry["submission"]["status"] == "ready")

            stranger = make_device()
            status, _ = request(stranger, base, "/api/subject", "POST", {"subject": "russian"})
            status, leak = request(stranger, base, "/api/essays?subject=russian&taskId=re_1_1")
            check("чужой GET не видит submission (404)", status == 404, f"{status} {leak}")
            status, leak2 = request(stranger, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "failed"})
            check("чужой EVALUATION не трогает submission (404)", status == 404, f"{status} {leak2}")
            status, mine = request(opener, base, "/api/essays?subject=russian&taskId=re_1_1")
            check("свой результат цел после чужих попыток",
                  status == 200 and mine["submission"]["status"] == "ready")

            # идемпотентность повторной фиксации
            status, dup = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready", "result": res})
            check("READY idempotent", status == 200 and dup["submission"]["status"] == "ready")
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
