#!/usr/bin/env python3
"""Целевой E2E/регрессионный аудит системы аккаунтов.

Трассировка: frontend-контракт (fetch) -> API -> session/auth -> SQLite ->
повторная загрузка. Каждый сценарий — то, что реально может сделать
пользователь; данные сидятся через те же endpoint'ы, что использует клиент.
Проверяется сохранность, разделение и неподменяемость данных при регистрации,
привязке гостя, login/logout и переключении аккаунтов.
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
SERVER_PATH = ROOT / "server" / "server.py"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    print(("ok   " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "c" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"audit-admin-pw", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_auth_audit", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base, path, method="GET", body=None, raw_cookie=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if raw_cookie:
        req.add_header("Cookie", raw_cookie)
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def device():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def token_of(jar: http.cookiejar.CookieJar) -> str | None:
    for cookie in jar:
        if cookie.name == "ege_session":
            return cookie.value
    return None


def fp(state: dict) -> dict:
    """Нормализованный отпечаток всех пользовательских доменов."""
    return {
        # name намеренно исключён: регистрация законно обновляет имя — оно
        # сверяется отдельными точечными проверками.
        "onboarded": state.get("onboarded"),
        "goal": state.get("goal"), "selfLevel": state.get("selfLevel"),
        "xp": state.get("xp"), "totalSolved": state.get("totalSolved"),
        "totalCorrect": state.get("totalCorrect"), "bestSeries": state.get("bestSeries"),
        "streak": state.get("streak"),
        "skillStats": state.get("skillStats"),
        "taskAttempts": sorted((a.get("id") or f'{a["taskId"]}:{a["ts"]}') for a in state.get("taskAttempts", [])),
        "errors": sorted(e["taskId"] for e in state.get("errors", [])),
        "timeline": sorted(t["text"] for t in state.get("timeline", [])),
        "diagnostics": sorted((d.get("id") or str(d.get("ts"))) for d in state.get("diagnostics", [])),
        "achievements": sorted(state.get("achievements", {}).keys()),
        "missionsDone": sorted(state.get("missionsDone", {}).keys()),
        "missionProgress": state.get("missionProgress"),
        "forecastHistory": state.get("forecastHistory"),
        "completedLessons": sorted(state.get("completedLessons", {}).keys()),
        "dailyHistory": sorted(json.dumps(d, sort_keys=True) for d in state.get("dailyHistory", [])),
        "activity": state.get("activity"),
        "hintLevels": state.get("hintLevels"),
    }


class Session:
    """«Устройство» поверх cookiejar с текущей stateVersion."""

    def __init__(self, base: str, opener=None, jar=None):
        self.base = base
        if opener is None:
            opener, jar = device()
        self.opener, self.jar = opener, jar
        self.version = None

    def req(self, path, method="GET", body=None, raw_cookie=None):
        return request(self.opener, self.base, path, method, body, raw_cookie)

    def bootstrap(self, subject=None):
        path = "/api/bootstrap" + (f"?subject={subject}" if subject else "")
        status, payload = self.req(path)
        assert status == 200, (path, status, payload)
        self.version = payload["state"]["stateVersion"]
        return payload

    def settings(self, subject, **settings):
        status, payload = self.req("/api/settings", "PATCH",
                                   {"subject": subject, "expectedVersion": self.version, "settings": settings})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def domains(self, subject, **domains):
        status, payload = self.req("/api/state-domains", "PATCH",
                                   {"subject": subject, "expectedVersion": self.version, "domains": domains})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def attempts(self, subject, events):
        status, payload = self.req("/api/events/attempts", "POST",
                                   {"subject": subject, "expectedVersion": self.version, "events": events})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def timeline(self, subject, events):
        status, payload = self.req("/api/events/timeline", "POST",
                                   {"subject": subject, "expectedVersion": self.version, "events": events})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def add_error(self, subject, error):
        status, payload = self.req("/api/errors", "POST",
                                   {"subject": subject, "expectedVersion": self.version, "error": error})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def progress(self, subject, skill_id, progress):
        status, payload = self.req(f"/api/progress/{skill_id}", "PATCH",
                                   {"subject": subject, "expectedVersion": self.version, "progress": progress})
        assert status == 200, (status, payload)
        self.version = payload["stateVersion"]
        return payload

    def switch_subject(self, subject):
        status, payload = self.req("/api/subject", "POST", {"subject": subject})
        assert status == 200, (status, payload)
        self.version = payload["state"]["stateVersion"]
        return payload

    def register(self, name, email, password):
        return self.req("/api/auth/register", "POST", {"name": name, "email": email, "password": password})

    def login(self, email, password):
        return self.req("/api/auth/login", "POST", {"email": email, "password": password})

    def logout(self):
        return self.req("/api/auth/logout", "POST", {})


def seed_guest(s: Session, marker: str, catalog: dict, subject="profile_math") -> dict:
    """Реалистичный прогресс гостя: настройки, попытки (XP), навык, ошибка,
    диагностика, достижения, миссия, прогноз, урок, история."""
    tasks = [t for t in catalog["tasks"] if t.get("skill")]
    t1, t2 = tasks[0], tasks[3]
    s.bootstrap()
    s.settings(subject, onboarded=True, name=f"Гость {marker}", selfLevel="base", goal="g60")
    s.attempts(subject, [
        {"id": f"att-{marker}-1", "taskId": t1["id"], "skill": t1["skill"], "correct": True,
         "hintLevel": 0, "seconds": 42, "ts": 1700000000001},
        {"id": f"att-{marker}-2", "taskId": t2["id"], "skill": t2["skill"], "correct": False,
         "hintLevel": 1, "seconds": 77, "ts": 1700000000002},
    ])
    s.progress(subject, t1["skill"], {"progress": 55, "solved": 2, "correct": 1, "timeSec": 119})
    s.add_error(subject, {"clientId": f"err-{marker}-1", "taskId": t2["id"], "skill": t2["skill"],
                          "ts": 1700000000003, "sub": "тема ошибки"})
    s.domains(subject,
              diagnostics=[{"id": f"diag-{marker}-1", "taskId": t1["id"], "correct": True, "ts": 1700000000004}],
              achievements={f"ach-{marker}": {"ts": 1700000000005}},
              missionsDone={f"mis-{marker}": {"ts": 1700000000006}},
              missionProgress={f"mis-{marker}": 3},
              forecastHistory=[{"date": "2026-09-01", "low": 60, "high": 72, "mid": 66}],
              completedLessons={f"les-{marker}": {"ts": 1700000000007}},
              lessonSessions={f"les-{marker}": {"step": 2, "draft": True}})
    s.timeline(subject, [{"id": f"tl-{marker}-1", "ts": 1700000000008, "text": f"Прогресс {marker}"}])
    boot = s.bootstrap()
    assert boot["state"]["xp"] > 0, f"XP не начислен из попыток: {boot['state']['xp']}"
    return fp(boot["state"])


def db_query(server, sql, args=()):
    conn = server.connect()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def main():
    with tempfile.TemporaryDirectory(prefix="ege-audit-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()
        httpd = server.create_http_server("127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        bare = urllib.request.build_opener()
        try:
            # ---------- S1/S14/S21: гость -> полный прогресс -> регистрация ----------
            dev1 = Session(base)
            catalog = dev1.bootstrap()["catalog"]
            guest_fp = seed_guest(dev1, "A1", catalog)
            account_a = dev1.bootstrap()["accountId"]
            users_before = db_query(server, "SELECT COUNT(*) c FROM users")[0]["c"]

            status, reg = dev1.register("Пользователь А", "a@ex.com", "password-a-123")
            check("S1: регистрация гостя -> 200", status == 200, f"{status} {reg}")
            boot = dev1.bootstrap()
            check("S1: accountId не изменился при привязке", boot["accountId"] == account_a)
            check("S1: ВСЕ домены сохранены у того же пользователя", fp(boot["state"]) == guest_fp,
                  f"diff: {json.dumps({k: (guest_fp[k], fp(boot['state'])[k]) for k in guest_fp if guest_fp[k] != fp(boot['state'])[k]}, ensure_ascii=False)[:600]}")
            check("S1: имя из формы регистрации применилось", boot["state"]["name"] == "Пользователь А",
                  boot["state"]["name"])
            check("S1: auth.registered=true, email выставлен",
                  boot["auth"] == {"registered": True, "email": "a@ex.com"}, str(boot["auth"]))
            check("S1: XP/уровень живы после привязки", boot["state"]["xp"] > 0 and boot["state"]["totalSolved"] == 2)
            fp_a = fp(boot["state"])

            # ---------- S2/S3: смена предмета до регистрации + разделение ----------
            dev2 = Session(base)
            pm_fp_dev2 = seed_guest(dev2, "B0", catalog)  # прогресс в профильной
            dev2.switch_subject("basic_math")
            boot_bm = dev2.bootstrap()
            dev2.settings("basic_math", onboarded=True, name="Гость B0", selfLevel="base")
            dev2.timeline("basic_math", [{"id": "tl-B0-bm", "ts": 1700000000010, "text": "Базовая математика B0"}])
            bm_fp = fp(dev2.bootstrap()["state"])
            account_b = dev2.bootstrap()["accountId"]
            dev2.switch_subject("profile_math")
            status, reg_b = dev2.register("Пользователь Б", "b@ex.com", "password-b-123")
            check("S2: регистрация после смены предмета -> 200", status == 200, f"{status} {reg_b}")
            boot_pm = dev2.bootstrap()
            check("S2: профильная математика цела после привязки", fp(boot_pm["state"]) == pm_fp_dev2)
            boot_bm2 = dev2.bootstrap("basic_math")
            check("S3: данные базовой сохранены после привязки", fp(boot_bm2["state"]) == bm_fp)
            check("S3: предметы не смешаны (base не видит профильные тексты)",
                  "Прогресс B0" not in boot_bm2["state"]["timeline"] and "Базовая математика B0" not in boot_pm["state"]["timeline"])
            fp_b = fp(boot_pm["state"])

            # ---------- S20: refresh на границе register ----------
            boot_again = dev2.bootstrap()
            check("S20: register -> bootstrap идемпотентен", fp(boot_again["state"]) == fp_b)
            check("S13: accountId стабилен между предметами",
                  boot_bm2["accountId"] == boot_pm["accountId"] == account_b)

            # ---------- S4/S5: logout -> гость, без авто-возврата ----------
            old_token = token_of(dev1.jar)
            status, _ = dev1.logout()
            check("S4: logout -> 200", status == 200)
            boot = dev1.bootstrap()
            check("S4: после logout аккаунт не продолжается автоматически",
                  boot["accountId"] != account_a and boot["auth"]["registered"] is False,
                  f"accountId={boot['accountId']}")
            status, stale = request(bare, base, "/api/bootstrap-lite", raw_cookie=f"ege_session={old_token}")
            check("S5: refresh со старой кукой -> НЕ аккаунт A",
                  stale["accountId"] != account_a and stale["auth"]["registered"] is False,
                  f"accountId={stale['accountId']}")
            guest_fp2 = seed_guest(dev1, "A2fresh", catalog)
            fresh_texts = [t["text"] for t in dev1.bootstrap()["state"]["timeline"]]
            check("S5: новый гость отделён от A (свои данные, пустая история A)",
                  "Прогресс A1" not in fresh_texts and "Прогресс A2fresh" in fresh_texts,
                  f"{fresh_texts}")

            # ---------- S8/S6: login в B, гостевые данные НЕ приписываются ----------
            status, login_b = dev1.login("b@ex.com", "password-b-123")
            check("S6: login B -> 200", status == 200, f"{status} {login_b}")
            boot = dev1.bootstrap()
            check("S6: открыт именно аккаунт B", boot["accountId"] == account_b)
            check("S6: fingerprint B совпадает с эталоном", fp(boot["state"]) == fp_b)
            check("S8: гостевые данные свежего гостя НЕ попали в B",
                  "Прогресс A2fresh" not in json.dumps(boot["state"], ensure_ascii=False))

            # ---------- S7/S15/S22: logout -> login A -> данные A ----------
            dev1.logout()
            status, login_a = dev1.login("a@ex.com", "password-a-123")
            check("S7: обратный login A -> 200", status == 200, f"{status} {login_a}")
            boot = dev1.bootstrap()
            check("S7: восстановлены именно данные A", fp(boot["state"]) == fp_a,
                  f"diff: {json.dumps({k: (fp_a[k], fp(boot['state'])[k]) for k in fp_a if fp_a[k] != fp(boot['state'])[k]}, ensure_ascii=False)[:600]}")
            check("S22: в данных A нет остатков B",
                  "Прогресс B0" not in json.dumps(boot["state"], ensure_ascii=False))

            # ---------- S9: регистрация на чужой email ----------
            dev3 = Session(base)
            seed_guest(dev3, "C1", catalog)
            c_fp = fp(dev3.bootstrap()["state"])
            status, dup = dev3.register("Злоумышленник", "a@ex.com", "password-z-123")
            check("S9: чужой email -> 409", status == 409, f"{status} {dup}")
            boot = dev3.bootstrap()
            check("S9: гость остался гостем со своими данными",
                  boot["auth"]["registered"] is False and fp(boot["state"]) == c_fp)
            dev3.logout()
            status, back = dev3.login("a@ex.com", "password-a-123")
            boot = dev3.bootstrap()
            check("S9: аккаунт A не подменён/не слит — его данные эталонные",
                  status == 200 and fp(boot["state"]) == fp_a and boot["state"]["name"] == "Пользователь А")

            # ---------- S10/S11: двойной submit и гонки ----------
            dev4 = Session(base)
            seed_guest(dev4, "D1", catalog)
            d_fp = fp(dev4.bootstrap()["state"])
            s1, r1 = dev4.register("Двойной", "d@ex.com", "password-d-123")
            s2, r2 = dev4.register("Двойной", "d@ex.com", "password-d-123")
            check("S10: повторный submit -> первый 200, второй 409",
                  s1 == 200 and s2 == 409, f"{s1}/{s2}")
            check("S10: данные не задвоены", fp(dev4.bootstrap()["state"]) == d_fp)
            users_mid = db_query(server, "SELECT COUNT(*) c FROM users")[0]["c"]
            status, _ = dev4.login("d@ex.com", "password-d-123")
            check("S11: после гонки login работает", status == 200)

            # гонка: одновременная регистрация из двух потоков (разные email)
            dev5 = Session(base)
            seed_guest(dev5, "E1", catalog)
            box = {}
            def reg_thread(tag, email):
                box[tag] = dev5.register("Гонка", email, "password-e-123")
            th1 = threading.Thread(target=reg_thread, args=("r1", "e1@ex.com"))
            th2 = threading.Thread(target=reg_thread, args=("r2", "e2@ex.com"))
            th1.start(); th2.start(); th1.join(); th2.join()
            codes = sorted([box["r1"][0], box["r2"][0]])
            check("S11: конкурентная регистрация -> один 200, один 409",
                  codes == [200, 409], f"{box}")
            dev5.logout()
            row = db_query(server, "SELECT id, email FROM users WHERE email IN ('e1@ex.com','e2@ex.com')")
            ok_e1, _ = dev5.login("e1@ex.com", "password-e-123")
            dev5.logout()
            ok_e2, _ = dev5.login("e2@ex.com", "password-e-123")
            # Пост-фикс: ровно ОДИН email победил гонку — он и должен входить;
            # проигравший честно отсутствует (401), а не живёт призраком.
            check("S11: победитель гонки единственный — входит только он",
                  sorted([ok_e1, ok_e2]) == [200, 401] and row[0]["email"] in ("e1@ex.com", "e2@ex.com"),
                  f"e1={ok_e1} e2={ok_e2} winner={row[0]['email']}")
            check("S11: ровно одна строка users для обоих email гонки (последний победил)",
                  len(row) == 1, f"{row}")
            users_after_race = db_query(server, "SELECT COUNT(*) c FROM users")[0]["c"]
            # 7 = A1, B0, A2fresh(гость после logout dev1), C1, D1, E1, гость dev6.
            # Login переиспользует/перепривязывает сессию и не минтит новых юзеров.
            check("S10/S11: дубликатных пользователей не создано",
                  users_after_race == 7, f"expected 7, got {users_after_race} (users_before={users_before})")

            # гонка: одновременный login в A и B из одной сессии
            dev6 = Session(base)
            dev6.bootstrap()
            box2 = {}
            def login_thread(tag, email, pw):
                box2[tag] = dev6.login(email, pw)
            ta = threading.Thread(target=login_thread, args=("A", "a@ex.com", "password-a-123"))
            tb = threading.Thread(target=login_thread, args=("B", "b@ex.com", "password-b-123"))
            ta.start(); tb.start(); ta.join(); tb.join()
            check("S11: гонка login A/B -> оба 200", box2["A"][0] == 200 and box2["B"][0] == 200, f"{box2}")
            boot = dev6.bootstrap()
            check("S11: после гонки сессия принадлежит ровно одному аккаунту",
                  boot["accountId"] in (account_a, account_b))
            dev6.logout()

            # ---------- S12: register -> немедленный refresh ----------
            dev7 = Session(base)
            seed_guest(dev7, "F1", catalog)
            f_fp = fp(dev7.bootstrap()["state"])
            status, _ = dev7.register("Момент", "f@ex.com", "password-f-123")
            boot = dev7.bootstrap()
            boot2 = dev7.bootstrap()
            check("S12: register -> мгновенный refresh консистентен",
                  status == 200 and fp(boot["state"]) == f_fp and fp(boot2["state"]) == f_fp)
            dev7.logout()

            # ---------- S16: чистый клиент (без кук/localStorage) -> login -> свои данные ----------
            dev8 = Session(base)
            status, _ = dev8.login("a@ex.com", "password-a-123")
            boot = dev8.bootstrap()
            check("S16: вход с чистого устройства отдаёт серверные данные A",
                  status == 200 and fp(boot["state"]) == fp_a)
            dev8.logout()

            # ---------- S17: подмена идентификаторов ----------
            dev9 = Session(base)
            dev9.bootstrap()
            dev9.settings("profile_math", onboarded=True, name="Подмена", goal="g60",
                          **{"userId": 1, "accountId": account_a, "id": 1})
            hdr_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(dev9.jar))
            req = urllib.request.Request(base + "/api/bootstrap-lite")
            req.add_header("X-User-Id", "1")
            req.add_header("Cookie", f"ege_session={token_of(dev9.jar)}; user_id=1; account={account_a}")
            with hdr_opener.open(req, timeout=15) as resp:
                spoof_boot = json.loads(resp.read())
            check("S17: идентичность не подменяется телом/заголовками/cookie",
                  spoof_boot["accountId"] == dev9.bootstrap()["accountId"] and spoof_boot["accountId"] != account_a)
            check("S17: данные A недостижимы через подмену",
                  "Прогресс A1" not in json.dumps(spoof_boot["state"], ensure_ascii=False))

            # ---------- S18: истёкшая сессия ----------
            dev10 = Session(base)
            status, _ = dev10.login("a@ex.com", "password-a-123")
            tok = token_of(dev10.jar)
            conn = server.connect()
            try:
                conn.execute("UPDATE user_sessions SET expires_at=0 WHERE token=?", (tok,))
                conn.commit()
            finally:
                conn.close()
            boot = dev10.bootstrap()
            check("S18: истёкшая сессия -> новый гость, не «остались авторизованы»",
                  boot["auth"]["registered"] is False and boot["accountId"] != account_a)
            dev11 = Session(base)
            status, _ = dev11.login("a@ex.com", "password-a-123")
            check("S18: серверные данные A не потеряны — повторный login эталонен",
                  status == 200 and fp(dev11.bootstrap()["state"]) == fp_a)
            dev11.logout()

            # ---------- S19: повторный login уже авторизованного ----------
            dev12 = Session(base)
            dev12.login("a@ex.com", "password-a-123")
            first = dev12.bootstrap()["accountId"]
            status, _ = dev12.login("a@ex.com", "password-a-123")
            second = dev12.bootstrap()
            check("S19: повторный login -> тот же аккаунт, данные целы",
                  status == 200 and second["accountId"] == first and fp(second["state"]) == fp_a)
            dev12.logout()

            # ---------- S24: backend напрямую — старые идентификаторы ----------
            dev1.login("b@ex.com", "password-b-123")
            b_now = token_of(dev1.jar)
            dev1.logout()
            status, a_stale = request(bare, base, "/api/bootstrap", raw_cookie=f"ege_session={b_now}")
            check("S24: кука после logout не отдаёт данные прежнего аккаунта",
                  a_stale["accountId"] != account_b and "Прогресс B0" not in json.dumps(a_stale["state"], ensure_ascii=False))
            status, acc_probe = request(bare, base, f"/api/bootstrap?accountId={account_a}")
            check("S24: accountId в query не является способом доступа",
                  acc_probe["accountId"] != account_a)
            status, admin_probe = request(bare, base, "/api/admin/users")
            check("S24: admin API без admin-сессии -> 401", status == 401)

            # ---------- Итог по БД: дубликатов нет, аккаунты живы ----------
            emails = db_query(server, "SELECT email FROM users WHERE email IS NOT NULL ORDER BY email")
            expected_emails = {"a@ex.com", "b@ex.com", "d@ex.com", "f@ex.com", row[0]["email"]}
            check("БД: зарегистрированные аккаунты на месте (a,b,d,f + победитель гонки)",
                  {r["email"] for r in emails} == expected_emails,
                  f"{[r['email'] for r in emails]}")
            probe = Session(base)
            dead = []
            for email, pw in [("a@ex.com", "password-a-123"), ("b@ex.com", "password-b-123"),
                              ("d@ex.com", "password-d-123"), ("f@ex.com", "password-f-123"),
                              (row[0]["email"], "password-e-123")]:
                st, _ = probe.login(email, pw)
                probe.logout()
                if st != 200:
                    dead.append((email, st))
            check("БД: каждый зарегистрированный аккаунт доступен (login 200, данные на сервере)",
                  not dead, f"{dead}")

            failed = [r for r in RESULTS if not r[1]]
            print(f"\n{'=' * 60}\nАУДИТ: {len(RESULTS) - len(failed)}/{len(RESULTS)} проверок прошло")
            if failed:
                print("ПРОВАЛЫ:")
                for name, _, detail in failed:
                    print(f"  - {name} {detail}")
            return 1 if failed else 0
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
