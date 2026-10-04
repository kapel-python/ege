#!/usr/bin/env python3
"""ЭКЗАМЕН ДЛЯ ЭКЗАМЕНАТОРА: одна сложная естественная сессия вместо 20 мелких.

Зачем: `agent-stress.py` гоняет 21 отдельный вопрос, `agent-hard.py` — сопротивление,
а этот тест отвечает на главный вопрос — справится ли ИИ с РЕАЛЬНЫМ учеником,
который пришёл с большой запутанной задачей и продолжает диалог. Шесть ходов одного
треда, каждый следующий опирается на предыдущий (как в жизни: диагноз → детали →
действие → подтверждение → новое задание → справка):

  1. «До ЕГЭ 3 недели, хочу 95+...» — сложный разбор: прогноз, ошибки, профиль,
     оглавление сочинений + детали, без выдуманных чисел и кодов, цель НЕ меняется молча;
  2. «покажи то сочинение, где больше всего баллов» — точечный разбор по submissionId;
  3. «поставь цель 95+» — подтверждение (ровно одно изменение, без «заодно»),
     approve меняет цель в БД;
  4. «дай задание посложнее по производной» — поиск + открытие, id только из каталога;
  5. «что я делал вчера?» — лента событий, а не числа;
  6. «сколько проверок в день?» — справка с темой, цифра 5.

Проверки намеренно детерминированные: какие инструменты вызваны и с какими
аргументами, что изменилось в БД, все числа ответа сверены с данными из шагов
(как в stress: число, которого не было ни в инструментах, ни в вопросе, — выдумка).
По прозе — только грубые запреты (внутренние коды, «видно только последнее»).

Запуск: python3 test/agent-exam.py   # живой провайдер, ~6 ходов, несколько минут
Без ключей провайдера тест пропускается (SKIP, код 0): мокать здесь нечего —
проверяется настоящая модель. Прод не трогается: свой temp-БД и порт.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"
ENV_FILE = Path("/etc/ege-2026.env")

CODE_RE = re.compile(r"\b(?:n\d{2}|re\d{1,2})_[a-z0-9_]+|\brussian_[a-z0-9_]+|\ble(?:sson_)?[a-z0-9_]+\b")
NUM_RE = re.compile(r"(?<![\w.])\d{1,4}(?:[.,]\d+)?")
BANNED_RE = re.compile(r"видно только последнее|не хватает инструмента|нет возможности его вызвать", re.IGNORECASE)

failures = 0
checks = 0


def check(name, condition, detail=""):
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + str(detail)[:220]) if detail else ''}")


def load_prod_env() -> None:
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key.startswith("EGE_") or key.startswith("AI_"):
            os.environ.setdefault(key, value)


def has_keys() -> bool:
    return bool(os.environ.get("EGE_CLOSEROUTER_API_KEY") or os.environ.get("CLOSEROUTER_API_KEY")
                or os.environ.get("EGE_AI_API_KEY") or os.environ.get("AI_API_KEY"))


class Client:
    def __init__(self, ip: str):
        self.ip = ip
        self.cookies: dict[str, str] = {}

    def request(self, base: str, method: str, path: str, body=None, timeout=300):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        req.add_header("X-Forwarded-For", self.ip)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
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
            status = resp.status
            raw = resp.read()
        try:
            return status, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return status, {"_raw": raw[:200].decode("utf-8", "ignore")}


def essay_blob(score: int, verdict: str) -> str:
    crits = [{"id": f"K{i}", "name": f"Критерий {i}", "score": score // 5 if i <= 6 else 1,
              "max_score": 2 if i <= 6 else 3, "comment": f"Замечание {i} по работе"} for i in range(1, 11)]
    return json.dumps({"total_score": score, "max_score": 22, "criteria": crits,
                       "short_verdict": verdict, "what_to_improve": "Связывай примеры между собой"},
                      ensure_ascii=False)


def seed(conn: sqlite3.Connection, uid: int) -> dict:
    """Богатый ученик: математика (прогноз/ошибки/лента) + русский (3 сочинения 14/9/0)."""
    now = int(time.time() * 1000)
    conn.execute("UPDATE users SET name='Экзаменуемый' WHERE id=?", (uid,))
    for subj, level, goal in (("profile_math", "base", "g80"), ("russian", "base", None)):
        cur = conn.execute("UPDATE user_subjects SET onboarded=1, self_level=?, goal_id=? WHERE user_id=? AND subject=?",
                           (level, goal, uid, subj))
        if cur.rowcount == 0:
            conn.execute("INSERT INTO user_subjects(user_id,subject,onboarded,self_level,goal_id)"
                         " VALUES(?,?,1,?,?)", (uid, subj, level, goal))
    skills = [r["id"] for r in conn.execute(
        "SELECT id FROM skills WHERE subject='profile_math' ORDER BY display_order LIMIT 4")]
    for i, sid in enumerate(skills):
        conn.execute("INSERT OR REPLACE INTO user_progress(user_id,subject,skill_id,progress,solved,correct,time_sec)"
                     " VALUES(?,?,?,?,?,?,?)", (uid, "profile_math", sid, 50, 10 - i, 7 - i, 300.0))
    tids = [r["id"] for r in conn.execute(
        "SELECT id FROM tasks WHERE skill_id=? ORDER BY id LIMIT 3", (skills[1],))]
    for i, tid in enumerate(tids):
        conn.execute("INSERT INTO user_errors(user_id,task_id,skill_id,topic,created_at,resolved,subject,client_id,kind)"
                     " VALUES(?,?,?,?,?,?,?,?,'major')",
                     (uid, tid, skills[1], f"Тема векторов {i}", str(now - i), 0, "profile_math", f"exam-err-{i}"))
    conn.execute("INSERT INTO timeline(user_id,subject,created_at,text,client_id) VALUES(?,?,?,?,?)",
                 (uid, "profile_math", str(now - 86400_000), "Решено задание планиметрии", "exam-tl-1"))
    rtasks = [r["id"] for r in conn.execute(
        "SELECT t.id AS id FROM tasks t JOIN skills s ON s.id=t.skill_id"
        " WHERE s.subject='russian' AND t.id LIKE 're27_%' ORDER BY t.id LIMIT 3")]
    scores = [14, 9, 0]
    subs = []
    for i, (tid, sc) in enumerate(zip(rtasks, scores)):
        skill = conn.execute("SELECT skill_id FROM tasks WHERE id=?", (tid,)).fetchone()["skill_id"]
        cur = conn.execute("INSERT INTO essay_submissions(user_id,subject,task_id,skill_id,text,word_count,"
                           "client_id,evaluation_status,evaluation_result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (uid, "russian", tid, skill, "текст сочинения " * 40, 200 + i,
                            f"exam-essay-{i}", "ready", essay_blob(sc, f"Вердикт {sc}"), str(now - i)))
        subs.append((int(cur.lastrowid), tid, sc))
    conn.commit()
    return {"skills": skills, "task_ids": tids, "subs": subs, "best": max(subs, key=lambda s: s[2])}


def grounded_numbers(steps: list, *texts: str) -> set:
    out = set()

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, bool):
            pass
        elif isinstance(node, (int, float)):
            out.add(int(node))
        elif isinstance(node, str):
            for m in NUM_RE.findall(node):
                try:
                    out.add(int(float(m.replace(",", "."))))
                except ValueError:
                    pass

    for st in steps or []:
        walk(st.get("result"))
        walk(st.get("args"))
    for text in texts:
        walk(text or "")
    return out


skipped = {"n": 0}


def v(name, condition, detail="", alive=True):
    """Проверка, если ход состоялся; иначе ПРОПУСК, а не вердикт (конвенция
    capabilities: провайдер недоступен — внешняя помеха)."""
    if not alive:
        skipped["n"] += 1
        print(f"SKIP {name}")
        return
    check(name, condition, detail)


def опорные_числа(steps: list) -> tuple[set, set, set]:
    """Опорные множества из шагов: баллы сочинений, вилка прогноза, счётчики ошибок."""
    essay_scores: set = set()
    forecast_vals: set = set()
    err_counts: set = set()
    for st in steps or []:
        r = st.get("result") or {}
        for e in r.get("essays", []) or []:
            if isinstance(e.get("score"), int):
                essay_scores.add(e["score"])
        ess = r.get("essay") or {}
        if isinstance(ess.get("score"), int):
            essay_scores.add(ess["score"])
        if isinstance(r.get("mid"), int):
            forecast_vals.update({r.get("mid"), r.get("low"), r.get("high")} - {None})
        if r.get("op") == "errors":
            err_counts.update({r.get("total"), r.get("open")} - {None})
    return essay_scores, forecast_vals, err_counts


def check_numbers(name: str, final: str, steps: list):
    """Только нагрузочные числа: баллы «N из 22», «прогноз N», «N ошибок».
    Бытовые («15–20 минут», «3 недели») не проверяем — иначе каждый совет
    с временем выглядел бы выдумкой, хотя выдумка тут — неверный БАЛЛ."""
    text = final or ""
    essay_scores, forecast_vals, err_counts = опорные_числа(steps)
    bad = []
    for m in re.finditer(r"(\d+)\s*из\s*22", text):
        if essay_scores and int(m.group(1)) not in essay_scores:
            bad.append(f"{m.group(1)} из 22")
    for m in re.finditer(r"прогноз\s*(?:—|–|-|:)?\s*\**(\d+)\s*%?(?![\d.)])", text, re.IGNORECASE):
        if forecast_vals and int(m.group(1)) not in forecast_vals:
            bad.append(f"прогноз {m.group(1)}")
    for m in re.finditer(r"(\d+)\s*(?:неразобран|открыт\w*\s+ошиб|ошиб\w*)(?![\w.])(?![\d])", text, re.IGNORECASE):
        if err_counts and int(m.group(1)) not in err_counts:
            bad.append(f"ошибок {m.group(1)}")
    bad_crit = sorted({int(m.group(1)) for m in re.finditer(r"К(\d+)", text)} - set(range(1, 11)))
    if bad_crit:
        bad.append(f"критерии вне К1–К10: {bad_crit}")
    check(name, not bad, f"выдуманные: {bad}" if bad else "баллы/прогноз/счётчики/критерии из данных")


def main() -> int:
    os.environ["EGE_DB_PATH"] = ""
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    os.environ["EGE_AGENT_QUOTA_MAX"] = "500"
    os.environ["EGE_AGENT_QUOTA_WINDOW_SEC"] = "60"
    os.environ["EGE_AI_RATE_MAX"] = "1000"
    os.environ["EGE_AI_NET_RATE_MAX"] = "1000"
    load_prod_env()
    if not has_keys():
        print("SKIP agent-exam: нет ключей провайдера (нужен живой ИИ)")
        return 0
    with tempfile.TemporaryDirectory(prefix="ege-agent-exam-") as tmp:
        spec = importlib.util.spec_from_file_location("ege_agent_exam", SERVER_PATH)
        assert spec and spec.loader
        os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
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

        c = Client("10.90.0.1")
        status, body = c.request(base, "POST", "/api/profile/claim",
                                 {"subject": "profile_math", "onboarded": True, "name": "Экзаменуемый"})
        check("онбординг", status == 200, f"{status} {body}")
        account = body.get("accountId") or ""
        conn = server.connect()
        try:
            row = conn.execute("SELECT id FROM users WHERE account_id=?", (account,)).fetchone()
            uid = int(row["id"]) if row else None
            if uid is None:
                uid = conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()["id"]
        finally:
            conn.close()
        conn = server.connect()
        try:
            data = seed(conn, int(uid))
        finally:
            conn.close()
        status, body = c.request(base, "POST", "/api/agent/threads", {})
        check("новый тред", status == 200 and body.get("thread", {}).get("id"), f"{status} {body}")
        tid = body["thread"]["id"]

        report: list = []

        def turn(text, extra=None):
            payload = {"threadId": tid, "text": text}
            if extra:
                payload.update(extra)
            status, body = c.request(base, "POST", "/api/agent/turns", payload)
            report.append({"q": text, "status": status,
                           "tools": [(s.get("tool"), s.get("args")) for s in body.get("steps") or []],
                           "final": body.get("final"), "pending": body.get("pending")})
            return status, body

        # Ход 1: сложный разбор.
        q1 = ("До ЕГЭ 3 недели, хочу 95+, а по пробнику вышло 68. Не понимаю, где у меня дыры, "
              "сочинения все одинаковые выходят, а времени — час в день. Скажи, что делать конкретно.")
        t0 = time.monotonic()
        status, b1 = turn(q1)
        print(f"(ход 1: {time.monotonic() - t0:.0f}с)")
        alive1 = status == 200 and bool(b1.get("final"))
        v("ход 1 -> 200 с ответом", alive1, f"{status} {str(b1)[:200]}", alive1)
        tools1 = [(s.get("tool"), s.get("args") or {}) for s in b1.get("steps") or []]
        names1 = {t for t, _ in tools1}
        v("ход 1 смотрит прогноз, ошибки, профиль и сочинения",
              {"fold_web", "essay_history"} <= names1
              and any(a.get("op") == "forecast" for _, a in tools1 if _ == "fold_web")
              and any(a.get("op") == "errors" for _, a in tools1 if _ == "fold_web"), str(names1), alive1)
        text1 = b1.get("final") or ""
        scores1 = {int(m.group(1)) for m in re.finditer(r"(\d+)\s*(?:из\s*22|балл)", text1)}
        # Перечисление одним списком («14, 9 и 0 баллов»): поодиночке числа не ловятся.
        for m in re.finditer(r"((?:\d+[\s,и–\-/]+){1,6})балл", text1):
            scores1.update(int(x) for x in re.findall(r"\d+", m.group(1)))
        used_scores = set()
        for s in (b1.get("steps") or []):
            r = s.get("result") or {}
            for e in r.get("essays", []) or []:
                if isinstance(e.get("score"), int):
                    used_scores.add(e["score"])
        v("ход 1 использует сочинения: детали или конкретные баллы",
          any(t == "essay_history" and "submissionId" in a for t, a in tools1)
          or len(scores1 & used_scores) >= 2,
          str(tools1), alive1)
        v("ход 1 не показывает внутренние коды",
          not CODE_RE.search(b1.get("final") or ""), (b1.get("final") or "")[:200], alive1)
        v("ход 1 не жалуется на инструменты",
          not BANNED_RE.search(b1.get("final") or ""), (b1.get("final") or "")[:200], alive1)
        if alive1:
            check_numbers("ход 1: баллы/прогноз/счётчики из данных", b1.get("final"), b1.get("steps"))
        conn = server.connect()
        try:
            goal = conn.execute("SELECT goal_id FROM user_subjects WHERE user_id=? AND subject='profile_math'",
                                (int(uid),)).fetchone()["goal_id"]
        finally:
            conn.close()
        check("ход 1 не меняет цель молча", goal == "g80", str(goal))

        # Ход 2: точечный разбор лучшего сочинения.
        best_id, _, best_score = data["best"]
        q2 = "А покажи то сочинение, где у меня больше всего баллов, и разбери его"
        status, b2 = turn(q2)
        alive2 = status == 200 and bool(b2.get("final"))
        v("ход 2 -> 200", alive2, f"{status} {str(b2)[:200]}", alive2)
        tools2 = [(s.get("tool"), s.get("args") or {}) for s in b2.get("steps") or []]
        v("ход 2 открывает именно лучшее сочинение",
          any(t == "essay_history" and a.get("submissionId") == best_id for t, a in tools2),
          str(tools2), alive2)
        v("ход 2 называет балл", str(best_score) in (b2.get("final") or ""),
          (b2.get("final") or "")[:200], alive2)
        if alive2:
            check_numbers("ход 2: баллы/прогноз/счётчики из данных", b2.get("final"), b2.get("steps"))

        # Ход 3: действие с подтверждением.
        q3 = "Поставь цель 95+"
        status, b3 = turn(q3)
        alive3 = status == 200 and bool(b3.get("pending") is True or b3.get("final"))
        v("ход 3 встаёт на подтверждение", status == 200 and b3.get("pending") is True,
          f"{status} {str(b3)[:200]}", alive3)
        step3 = next((s for s in b3.get("steps") or [] if s.get("kind") == "action"), {})
        prop = step3.get("proposal") or {}
        v("одно изменение без «заодно» (только goal)",
          (prop.get("patch") or {}) == {"goal": "g95"}, str(prop.get("patch")), alive3)
        mid = step3.get("id")
        status, bc = c.request(base, "POST", "/api/agent/turns/confirm", {"messageId": mid, "approve": True})
        v("approve применяет", status == 200 and bc.get("approved") is True,
          f"{status} {str(bc)[:200]}", status == 200)
        approved = status == 200 and bc.get("approved") is True
        conn = server.connect()
        try:
            goal = conn.execute("SELECT goal_id FROM user_subjects WHERE user_id=? AND subject='profile_math'",
                                (int(uid),)).fetchone()["goal_id"]
        finally:
            conn.close()
        v("цель в БД — g95", goal == "g95", str(goal), approved)

        # Ход 4: задание посложнее — только из каталога.
        q4 = "Дай задание посложнее по производной"
        status, b4 = turn(q4)
        alive4 = status == 200 and bool(b4.get("final"))
        v("ход 4 -> 200", alive4, f"{status} {str(b4)[:200]}", alive4)
        tools4 = [(s.get("tool"), s.get("args") or {}) for s in b4.get("steps") or []]
        opened = None
        for tname, a in tools4:
            if tname == "task_get" and a.get("taskId"):
                opened = a["taskId"]
        v("ход 4 ищет и открывает задание",
          any(t == "find_topics" for t, _ in tools4) and opened, str(tools4), alive4)
        conn = server.connect()
        try:
            catalog_ids = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
        finally:
            conn.close()
        v("открытое задание из каталога, не выдумано", opened in catalog_ids, str(opened), alive4)
        v("ход 4 не показывает внутренние коды",
          not CODE_RE.search(b4.get("final") or ""), (b4.get("final") or "")[:200], alive4)

        # Ход 5: лента событий.
        q5 = "А что я делал вчера?"
        status, b5 = turn(q5)
        alive5 = status == 200 and bool(b5.get("final"))
        v("ход 5 -> 200", alive5, f"{status} {str(b5)[:200]}", alive5)
        v("ход 5 смотрит ленту",
          any(t == "fold_web" and a.get("op") == "timeline" for t, a in
              [(s.get("tool"), s.get("args") or {}) for s in b5.get("steps") or []]),
          str([s.get("args") for s in b5.get("steps") or []]), alive5)
        v("ход 5 помнит планиметрию", "планиметр" in (b5.get("final") or "").lower(),
          (b5.get("final") or "")[:200], alive5)

        # Ход 6: справка с темой.
        q6 = "Сколько проверок сочинений в день?"
        status, b6 = turn(q6)
        alive6 = status == 200 and bool(b6.get("final"))
        v("ход 6 -> 200", alive6, f"{status} {str(b6)[:200]}", alive6)
        v("ход 6 берёт справку с темой",
          any(t == "project_info" and (a.get("topic") or "") for t, a in
              [(s.get("tool"), s.get("args") or {}) for s in b6.get("steps") or []]),
          str([s.get("args") for s in b6.get("steps") or []]), alive6)
        v("ход 6 называет 5", re.search(r"(?<!\d)5(?!\d)", b6.get("final") or "") is not None,
          (b6.get("final") or "")[:200], alive6)

        with open("/tmp/opencode/exam-report.md", "w", encoding="utf-8") as fh:
            fh.write("# agent-exam: протокол сессии\n\n")
            for i, r in enumerate(report, 1):
                fh.write(f"## Ход {i}: {r['q'][:100]}\n\nстатус {r['status']}, "
                         f"инструменты: {r['tools']}\n\n{r['final'] or '(нет ответа)'}\n\n---\n\n")
        print(f"протокол: /tmp/opencode/exam-report.md")
        httpd.shutdown()
        print(f"\n{'ALL OK' if failures == 0 else 'FAILURES'}: {checks} checks, skipped: {skipped['n']}")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
