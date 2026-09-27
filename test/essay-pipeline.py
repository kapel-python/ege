#!/usr/bin/env python3
"""End-to-end пайплайна проверки итогового сочинения (база, без streaming).

submission (POST /api/essays) → AI check (POST /api/ai/essay: существующий
route, модель К1–К6 + детерминированная грамотность К7–К10; ответ модели
сохраняется в essay_checks) → report generation (POST /api/essays/evaluation →
status 'ready' по серверной записи, клиентский result игнорируется) → result
ready (GET /api/essays) → и только потом XP через существующий attempts-flow.

Офлайн: ai.chat и ai.lt_check заглушены (как в test/ai-essay.py), своя
temp-БД и свой порт, прод не трогается. Проверяется и ошибочный сценарий:
'failed' не даёт результата, XP до 'ready' невозможен через этот flow, а
evaluation без реальной проверки (или с чужим текстом) отбивается 409 —
запись себе оценки из консоли закрыта.
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
    # Пайплайн делает больше трёх проверок на один аккаунт; дневной лимит
    # ai_usage здесь не под тестом — его покрывает test/ai-limits.py.
    os.environ["EGE_AI_USAGE_MAX"] = "1000"
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
            # Онбординг пройден: весь pipeline эссе — user-scoped, гостю без
            # профиля не отвечает (401 GUEST_PENDING).
            status, claimed = request(opener, base, "/api/profile/claim", "POST", {
                "subject": "russian", "onboarded": True, "name": "Сочинщик"})
            check("CLAIM profile before pipeline", status == 200, str(claimed)[:160])
            status, _ = request(opener, base, "/api/subject", "POST", {"subject": "russian"})
            check("SUBJECT russian", status == 200)
            ai.reset_ai_rate()

            text = words(200)
            # 1. submission — проверка НЕ завершена, XP нет
            status, sub = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_1", "skill": "russian_essay_source",
                "text": text, "id": "pipe-1"})
            check("SUBMIT ok, status submitted", status == 200 and sub.get("evaluationStatus") == "submitted", str(sub)[:160])
            check("SUBMIT returns clientId", bool(sub.get("clientId")), str(sub)[:160])
            client_id = sub.get("clientId")
            status, boot0 = request(opener, base, "/api/bootstrap?subject=russian")
            check("XP is zero right after submit", boot0["state"]["xp"] == 0, f"xp={boot0['state']['xp']}")

            # 2. до проверок готового результата нет
            status, got = request(opener, base, "/api/essays?subject=russian&taskId=re27_1")
            check("GET before checks: submitted, no result",
                  status == 200 and got["submission"]["status"] == "submitted"
                  and got["submission"]["result"] is None, str(got)[:200])

            # 3. AI check существующим route (модель + алгоритмы внутри)
            status, ai_res = request(opener, base, "/api/ai/essay", "POST", {"text": text, "taskId": "re27_1"})
            res = ai_res.get("result", {})
            check("AI 200 with 10 criteria on 22",
                  status == 200 and res.get("max_score") == 22 and len(res.get("criteria", [])) == 10,
                  f"{status} {str(ai_res)[:160]}")
            check("AI total recomputed by server", res.get("total_score") == 19, str(res.get("total_score")))
            ai.reset_ai_rate()

            # 4. report generation — оценка берётся из серверной записи о
            # проверке (её оставил /api/ai/essay), а присланный клиентом
            # result игнорируется: мусор из тела запроса ничего не портит.
            status, bad = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready",
                "result": {"total_score": 1, "max_score": 2, "criteria": []}})
            check("READY with garbage body: 200, stored AI result wins",
                  status == 200 and (bad.get("submission") or {}).get("result", {}).get("total_score") == 19,
                  f"{status} {str(bad)[:160]}")
            # 4а. Ни разу не проверенный текст: 'ready' невозможен — 409.
            # Это и есть закрытая дыра «22/22 из консоли без вызова модели».
            status, subx = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_4", "skill": "russian_essay_source",
                "text": words(160, "непроверенное"), "id": "pipe-x"})
            cidx = subx.get("clientId")
            status, unchecked = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cidx, "status": "ready", "result": res})
            check("READY without any AI check -> 409", status == 409
                  and unchecked.get("reason") == "essay_not_checked", f"{status} {unchecked}")
            # 4б. Проверка ДРУГОГО текста не подходит: связка — хэш текста.
            status, suby = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_5", "skill": "russian_essay_source",
                "text": words(160, "другой"), "id": "pipe-y"})
            cidy = suby.get("clientId")
            status, mismatched = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cidy, "status": "ready", "result": res})
            check("READY with check of a different text -> 409", status == 409
                  and mismatched.get("reason") == "essay_not_checked", f"{status} {mismatched}")
            status, unknown = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": "nope-unknown", "status": "ready", "result": res})
            check("READY unknown submission -> 404", status == 404, f"{status} {unknown}")
            status, saved = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready", "result": res})
            check("READY ok", status == 200 and saved.get("ok") is True
                  and saved["submission"]["status"] == "ready", f"{status} {str(saved)[:200]}")

            # 5. result ready — тот же submission, те же баллы
            status, got2 = request(opener, base, "/api/essays?subject=russian&taskId=re27_1")
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
            sid = (got2.get("submission") or {}).get("submissionId")
            status, by_sid = request(opener, base, f"/api/essays?subject=russian&sid={sid}")
            check("GET by short sid returns same submission",
                  status == 200 and by_sid["submission"]["submissionId"] == sid
                  and (by_sid["submission"].get("view") or {}).get("total_score") == 19, f"{status}")
            status, nosub = request(opener, base, f"/api/essays?sid={sid}")
            check("GET sid without subject (pretty link) finds it",
                  status == 200 and nosub["submission"]["submissionId"] == sid
                  and nosub.get("subject") == "russian", f"{status} {nosub}")
            status, bad_sid = request(opener, base, "/api/essays?subject=russian&sid=999999999")
            check("GET unknown sid -> 404", status == 404, f"{status}")
            status, no_id = request(opener, base, "/api/essays?subject=russian")
            check("GET without id -> 400", status == 400, f"{status}")
            # Красивый роут отдаёт ту же страницу результата.
            try:
                with opener.open(urllib.request.Request(base + f"/essay/{sid}"), timeout=10) as resp:
                    pretty_status, pretty_type, pretty_body = resp.status, resp.headers.get("Content-Type", ""), resp.read()
            except urllib.error.HTTPError as exc:
                pretty_status, pretty_type, pretty_body = exc.code, "", b""
            check("GET /essay/<sid> serves result page",
                  pretty_status == 200 and "text/html" in pretty_type
                  and "Результат проверки" in pretty_body.decode("utf-8", "replace"), f"{pretty_status} {pretty_type}")

            # 6. XP — только теперь, существующим attempts-flow
            ver = got2.get("submission") and request(opener, base, "/api/bootstrap?subject=russian")[1]["state"]["stateVersion"]
            status, att = request(opener, base, "/api/events/attempts", "POST", {
                "subject": "russian", "expectedVersion": ver,
                "events": [{"taskId": "re27_1", "skill": "russian_essay_source", "correct": True,
                            "hintLevel": 0, "seconds": 120, "id": "attempt-pipe-1"}]})
            check("ATTEMPT after ready accepted", status == 200 and att.get("ok") is True, str(att)[:160])
            status, boot1 = request(opener, base, "/api/bootstrap?subject=russian")
            check("XP earned only after pipeline", boot1["state"]["xp"] > 0, f"xp={boot1['state']['xp']}")

            # 7. ошибочный сценарий: failed — результата нет, чужой не видит
            status, sub2 = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_2", "skill": "russian_essay_source",
                "text": words(160), "id": "pipe-2"})
            cid2 = sub2.get("clientId")
            status, fail = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid2, "status": "failed"})
            check("FAILED marks not-ready", status == 200 and fail["submission"]["status"] == "failed"
                  and fail["submission"]["result"] is None, f"{status} {str(fail)[:160]}")
            status, gotf = request(opener, base, "/api/essays?subject=russian&taskId=re27_2")
            check("GET failed: no result to show", status == 200 and gotf["submission"]["status"] == "failed"
                  and gotf["submission"]["result"] is None)
            check("GET failed: no view either", gotf["submission"].get("view") is None)
            # retry после failed — как у честного клиента: сначала повторная
            # проверка моделью этого же текста, затем ready принимается
            ai.reset_ai_rate()
            status, ai_retry = request(opener, base, "/api/ai/essay", "POST",
                                       {"text": words(160), "taskId": "re27_2"})
            check("RETRY runs the AI check again first", status == 200
                  and (ai_retry.get("result") or {}).get("max_score") == 22, f"{status} {str(ai_retry)[:120]}")
            status, retry = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid2, "status": "ready", "result": ai_retry.get("result")})
            check("RETRY failed->ready ok", status == 200 and retry["submission"]["status"] == "ready")

            # Чужой, но настоящий человек: свой профиль после онбординга.
            # Проверяем изоляцию по аккаунту, а не отказ гостю без профиля.
            stranger = make_device()
            status, stranger_claim = request(stranger, base, "/api/profile/claim", "POST", {
                "subject": "russian", "onboarded": True, "name": "Чужой"})
            check("чужой профиль заведён", status == 200, str(stranger_claim)[:120])
            status, _ = request(stranger, base, "/api/subject", "POST", {"subject": "russian"})
            status, leak = request(stranger, base, "/api/essays?subject=russian&taskId=re27_1")
            check("чужой GET не видит submission (404)", status == 404, f"{status} {leak}")
            status, leak2 = request(stranger, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "failed"})
            check("чужой EVALUATION не трогает submission (404)", status == 404, f"{status} {leak2}")
            status, leak3 = request(stranger, base, f"/api/essays?subject=russian&sid={sid}")
            check("чужой sid не открывает submission (404)", status == 404, f"{status} {leak3}")
            status, mine = request(opener, base, "/api/essays?subject=russian&taskId=re27_1")
            check("свой результат цел после чужих попыток",
                  status == 200 and mine["submission"]["status"] == "ready")

            # 7б. Рубрика одна и выбирается сервером по заданию: у задания с
            # исходником — позиция автора, примеры ИЗ текста. Без исходника
            # проверки не существует, и клиент её не может включить.
            ai.reset_ai_rate()
            text27 = words(200)
            status, ai_src = request(opener, base, "/api/ai/essay", "POST",
                                    {"text": text27, "taskId": "re27_1"})
            src_names = [c["name"] for c in (ai_src.get("result") or {}).get("criteria", [])][:3]
            check("рубрика задания 27 (позиция автора)",
                  status == 200 and src_names == ["Позиция автора", "Комментарий", "Собственное отношение"],
                  f"{status} {src_names}")
            ai.reset_ai_rate()
            status, ai_plain = request(opener, base, "/api/ai/essay", "POST", {"text": text27})
            check("без задания проверки нет (нужен исходный текст)", status == 400, f"{status} {ai_plain}")
            status, ai_bad = request(opener, base, "/api/ai/essay", "POST",
                                     {"text": text27, "taskId": "re27_1", "source": "source"})
            check("клиент не может навязать режим рубрики", status == 400, f"{status} {ai_bad}")
            ai.reset_ai_rate()
            status, ai_unknown = request(opener, base, "/api/ai/essay", "POST",
                                         {"text": text27, "taskId": "nope"})
            check("неизвестное задание -> 400", status == 400, f"{status} {ai_unknown}")
            ai.reset_ai_rate()
            status, ai_free_task = request(opener, base, "/api/ai/essay", "POST",
                                           {"text": text27, "taskId": "re_1_1"})
            check("задание без исходника проверкой не является", status == 400, f"{status} {ai_free_task}")

            # идемпотентность повторной фиксации
            status, dup = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": client_id, "status": "ready", "result": res})
            check("READY idempotent", status == 200 and dup["submission"]["status"] == "ready")

            # 8. вето сквозняком: работа без позиции (К1=0) не тянет баллы
            # грамотности. Правило сервера, второй инстанции больше нет:
            # один вызов модели, итог = баллы содержания, К7–К10 обнулены,
            # поэтому сумма критериев на экране равна итогу.
            ai.reset_ai_rate()
            calls = {"n": 0}

            def scripted(messages, **kwargs):
                calls["n"] += 1
                body = model_payload()
                body["criteria"][0]["score"] = 0  # К1=0; потолок рубрики жмёт К2 -> 1
                return json.dumps(body, ensure_ascii=False)

            ai.chat = scripted
            veto_text = words(200, "мусор")
            status, sub3 = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_3", "skill": "russian_essay_source",
                "text": veto_text, "id": "pipe-3"})
            cid3 = sub3.get("clientId")
            status, ai3 = request(opener, base, "/api/ai/essay", "POST", {"text": veto_text, "taskId": "re27_3"})
            res3 = ai3.get("result", {})
            cal3 = res3.get("calibration") or {}
            crit3 = res3.get("criteria", [])
            content3 = sum(c["score"] for c in crit3[:6])
            check("VETO one AI call only", status == 200 and calls["n"] == 1,
                  f"{status} calls={calls['n']}")
            check("VETO total = content score", res3.get("total_score") == content3,
                  f"{res3.get('total_score')} vs {content3}")
            check("VETO literacy zeroed",
                  all(c["score"] == 0 for c in crit3[6:]),
                  str([(c["id"], c["score"]) for c in crit3[6:]]))
            check("VETO rubric cap applied (К1=0 -> К2<=1)",
                  next(c["score"] for c in crit3 if c["id"] == "K2") == 1)
            check("VETO recorded", cal3.get("proposed") == content3 + 12
                  and cal3.get("final") == content3 and "грамотност" in str(cal3.get("note")).lower(),
                  str(cal3))
            status, saved3 = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid3, "status": "ready", "result": res3})
            check("VETO ready persists", status == 200 and saved3["submission"]["status"] == "ready")
            status, got3 = request(opener, base, "/api/essays?subject=russian&clientId=" + cid3)
            view3 = (got3.get("submission") or {}).get("view") or {}
            check("VETO note reaches result page",
                  status == 200 and view3.get("total_score") == content3
                  and "грамотност" in str(view3.get("calibration_note")).lower(),
                  str(view3.get("calibration_note")))
            check("VETO screen arithmetic adds up",
                  sum(c["score"] for c in (view3.get("criteria") or [])) == view3.get("total_score"),
                  str(view3.get("total_score")))

            # 9. Подделка результата в evaluation: клиент прислал изменённый
            # ответ (обнулённые критерии, итог 22) — сервер берёт сохранённую
            # запись проверки, клиентское тело игнорируется полностью.
            ai.reset_ai_rate()
            ai.chat = lambda messages, **kwargs: json.dumps(model_payload(), ensure_ascii=False)
            forged_text = words(200, "проверка")
            status, sub4 = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_3", "skill": "russian_essay_source",
                "text": forged_text, "id": "pipe-4"})
            cid4 = sub4.get("clientId")
            _st, ai4 = request(opener, base, "/api/ai/essay", "POST", {"text": forged_text, "taskId": "re27_3"})
            honest = ai4.get("result", {})
            forged = json.loads(json.dumps(honest, ensure_ascii=False))
            for item in forged["criteria"]:
                item["score"] = 0
            forged["total_score"] = 22
            status, saved4 = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid4, "status": "ready", "result": forged})
            check("FORGED body ignored; stored check result wins", status == 200
                  and (saved4.get("submission") or {}).get("result", {}).get("total_score") == honest.get("total_score"),
                  str((saved4.get("submission") or {}).get("result", {}).get("total_score")))
            status, got4 = request(opener, base, "/api/essays?subject=russian&clientId=" + cid4)
            view4 = (got4.get("submission") or {}).get("view") or {}
            check("view shows the honest score, not the forged one",
                  view4.get("total_score") == honest.get("total_score"), str(view4.get("total_score")))
            # 9а. А без проверки вообще — 409: «22/22 из консоли» закрыто.
            status, sub5 = request(opener, base, "/api/essays", "POST", {
                "subject": "russian", "taskId": "re27_6", "skill": "russian_essay_source",
                "text": words(200, "консоль"), "id": "pipe-5"})
            cid5 = sub5.get("clientId")
            status, console_forged = request(opener, base, "/api/essays/evaluation", "POST", {
                "subject": "russian", "clientId": cid5, "status": "ready",
                "result": {"total_score": 22, "max_score": 22,
                           "criteria": [{"id": f"K{i}", "name": f"Критерий {i}", "score": 2,
                                          "max_score": 2, "comment": "подделка."} for i in range(1, 7)]
                                    + [{"id": "K7", "name": "К7", "score": 2, "max_score": 2, "comment": "подделка."},
                                       {"id": "K8", "name": "К8", "score": 3, "max_score": 3, "comment": "подделка."},
                                       {"id": "K9", "name": "К9", "score": 2, "max_score": 2, "comment": "подделка."},
                                       {"id": "K10", "name": "К10", "score": 5, "max_score": 5, "comment": "подделка."}]}})
            check("console-forged 22/22 without model call -> 409", status == 409
                  and console_forged.get("reason") == "essay_not_checked", f"{status} {console_forged}")
            status, got5 = request(opener, base, "/api/essays?subject=russian&clientId=" + cid5)
            check("forged submission stays submitted (no result)",
                  status == 200 and (got5.get("submission") or {}).get("status") == "submitted"
                  and (got5.get("submission") or {}).get("result") is None, str(got5)[:160])
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(f"{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
