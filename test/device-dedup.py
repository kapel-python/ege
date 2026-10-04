#!/usr/bin/env python3
"""Одно устройство — одна строка в «Устройствах».

Раньше устройством называлась строка user_sessions, а строка заводилась на
каждый вход/регистрацию/заявку. Второй браузер, вебвью или curl с той же
машины превращались в отдельное устройство, и в профиле появлялось лишнее
«Браузер». Теперь устройство — это группа сессий одного клиента, собранная по
двум отпечаткам: кука браузера ege_device и HMAC сетевого адреса.

Проверяем на живом сервере с временной БД:
  1. кука устройства выдаётся живой сессии и НЕ выдаётся гостю;
  2. вкладки и перезагрузки не плодят ни сессий, ни устройств;
  3. logout → login остаётся тем же устройством (кука устройства переживает
     выход из аккаунта);
  4. второй браузер на той же машине (другой jar, куки ege_device ещё нет)
     не добавляет устройство — его подхватывает отпечаток сети;
  5. настоящее другое устройство (другая сеть) остаётся отдельным;
  6. «Завершить» сносит ВСЕ сессии устройства, чужие не трогает, отзыв
     текущего равносилен выходу;
  7. старые строки без отпечатков (мусор до миграции) схлопываются и не
     висят вторым устройством;
  8. ни IP, ни User-Agent не попадают ни в базу, ни в ответ.

Точка входа — регистрация (явное намерение, есть и без онбординга), поэтому
набор не завязан на порядок появления гостя и его профиля.
"""

from __future__ import annotations

import hashlib
import importlib.util
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "server.py"

PASSED = 0
FAILED: list[str] = []


def t(name: str, ok: bool, detail: object = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"  ok  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}: {detail}")


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    # Свой хеш админ-пароля — как в остальных тестах.
    salt = "b" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    # Разные сети клиентов задаём заголовком за доверенным прокси.
    os.environ["EGE_TRUSTED_PROXY"] = "1"
    spec = importlib.util.spec_from_file_location("ege_device_dedup_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Browser:
    """Минимальный браузер: хранит куки и умеет слать их вручную."""

    def __init__(self, base: str, ip: str = "10.0.0.7", user_agent: str | None = None):
        self.base = base
        self.ip = ip
        self.user_agent = user_agent
        self.cookies: dict[str, str] = {}

    def request(self, path: str, method: str = "GET", body=None, *, drop: tuple[str, ...] = ()):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.user_agent is not None:
            req.add_header("User-Agent", self.user_agent)
        req.add_header("X-Forwarded-For", self.ip)
        pairs = [f"{name}={value}" for name, value in self.cookies.items() if name not in drop]
        if pairs:
            req.add_header("Cookie", "; ".join(pairs))
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                status, payload, headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as exc:
            status, payload, headers = exc.code, exc.read(), exc.headers
        for raw in headers.get_all("Set-Cookie") or []:
            name, _, rest = raw.partition("=")
            value = rest.split(";")[0]
            max_age = 0
            for part in rest.split(";")[1:]:
                part = part.strip().lower()
                if part.startswith("max-age="):
                    try:
                        max_age = int(part.split("=", 1)[1])
                    except ValueError:
                        max_age = 0
            if not value or max_age == 0:
                self.cookies.pop(name.strip(), None)
            else:
                self.cookies[name.strip()] = value
        try:
            return status, json.loads(payload or b"{}")
        except json.JSONDecodeError:
            return status, {}

    def devices(self) -> list[dict]:
        status, body = self.request("/api/auth/devices")
        assert status == 200, (status, body)
        return list(body.get("devices") or [])

    def claim(self, name: str = "Ученик") -> dict:
        status, body = self.request("/api/profile/claim", "POST", {
            "subject": "profile_math", "onboarded": True, "name": name,
        })
        assert status == 200, (status, body)
        return body

    def register(self, email: str, password: str) -> tuple[int, dict]:
        return self.request("/api/auth/register", "POST", {"email": email, "password": password})

    def login(self, email: str, password: str) -> tuple[int, dict]:
        return self.request("/api/auth/login", "POST", {"email": email, "password": password})

    def logout(self) -> tuple[int, dict]:
        return self.request("/api/auth/logout", "POST", {})


def session_rows(server, user_id: int) -> list[dict]:
    conn = server.connect()
    try:
        conn.row_factory = __import__("sqlite3").Row
        rows = conn.execute(
            "SELECT id, device_name, device_type, device_key, device_net FROM user_sessions "
            "WHERE user_id=? ORDER BY id", (user_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ege-device-") as tmp:
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
            run_checks(server, base)
        finally:
            httpd.shutdown()
    print(f"\npassed: {PASSED}, failed: {len(FAILED)}")
    for name in FAILED:
        print(f"  — {name}")
    return 1 if FAILED else 0


def run_checks(server, base: str) -> None:
    chrome = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

    # 1. Куку устройства получают только живые сессии. Проверяем там, где
    #    гость действительно остаётся без профиля (accountId пустой); в старой
    #    модели, где гостю сразу заводится строка, утверждение неприменимо —
    #    там у каждого запроса есть сессия, и кука выдаётся законно.
    guest = Browser(base, user_agent=chrome)
    status, boot = guest.request("/api/bootstrap-lite")
    t("лендинг читается", status == 200)
    if boot.get("accountId") is None:
        t("гость без профиля не получает куку устройства",
          "ege_device" not in guest.cookies, guest.cookies)

    main_browser = Browser(base, ip="10.0.0.7", user_agent=chrome)
    status, reg = main_browser.register("device@example.com", "password-123")
    t("регистрация заводит профиль", status == 200 and reg["user"]["registered"], (status, reg))
    account_id = reg["user"]["accountId"]
    t("живая сессия получает куку устройства", "ege_device" in main_browser.cookies, main_browser.cookies)
    device_cookie = main_browser.cookies.get("ege_device", "")
    t("кука устройства — непрозрачный id", server.device_cookie_is_valid(device_cookie), device_cookie)

    user_id = conn_user_id(server, account_id)
    rows = session_rows(server, user_id)
    t("устройство одно", len(main_browser.devices()) == 1, main_browser.devices())
    t("отпечаток сети проставлен сразу", any(r["device_net"] for r in rows), rows)
    t("сырой IP в базе не лежит", all("10.0.0.7" not in str(v) for r in rows for v in r.values()), rows)

    # 2. Вкладки и перезагрузки: тот же браузер, параллельные запросы.
    rows_before = len(session_rows(server, user_id))
    errors: list[str] = []

    def tab() -> None:
        try:
            status, body = main_browser.request("/api/bootstrap-lite")
            if status != 200 or not body.get("accountId"):
                errors.append(f"{status} {body}")
        except Exception as exc:  # noqa: BLE001 — тест должен упасть внятно
            errors.append(repr(exc))

    threads = [threading.Thread(target=tab) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    t("8 вкладок открылись без ошибок", not errors, errors[:3])
    devices = main_browser.devices()
    t("вкладки не плодят устройства", len(devices) == 1, devices)
    t("вкладки не плодят сессий", len(session_rows(server, user_id)) == rows_before,
      (rows_before, session_rows(server, user_id)))
    t("текущее устройство помечено", bool(devices and devices[0]["current"]), devices)
    t("устройство названо по браузеру", devices and devices[0]["name"] == "Windows", devices)

    # 3. Повторная регистрация того же гостя — честный отказ, устройство то же.
    status, again = main_browser.register("device@example.com", "password-123")
    t("повторная регистрация отвергнута", status == 409, (status, again))
    t("регистрация не плодит устройств", len(main_browser.devices()) == 1, main_browser.devices())

    # 4. Выход и повторный вход — то же устройство: кука устройства переживает
    #    logout, а строка сессии пересоздаётся с тем же отпечатком.
    status, _ = main_browser.logout()
    t("выход из аккаунта", status == 200)
    t("выход НЕ стирает куку устройства", main_browser.cookies.get("ege_device") == device_cookie,
      main_browser.cookies)
    t("после выхода профиля нет", "ege_session" not in main_browser.cookies, main_browser.cookies)
    status, _ = main_browser.request("/api/auth/devices")
    t("вышедший видит 401 вместо устройств", status == 401, status)
    status, back = main_browser.login("device@example.com", "password-123")
    t("повторный вход", status == 200, (status, back))
    devices = main_browser.devices()
    t("вход-выход-вход = одно устройство", len(devices) == 1, devices)
    t("после входа у устройства одна сессия", devices and int(devices[0]["sessions"]) == 1, devices)
    rows = session_rows(server, user_id)
    t("отпечаток куки проставлен при входе", any(r["device_key"] for r in rows), rows)

    # 5. Второй браузер на той же машине (свои куки, ege_device ещё нет) —
    #    отдельное устройство не появляется: тот же отпечаток сети.
    second = Browser(base, ip="10.0.0.7", user_agent=chrome)
    status, _ = second.login("device@example.com", "password-123")
    t("второй браузер вошёл в тот же аккаунт", status == 200, status)
    devices = main_browser.devices()
    t("второй браузер не добавил устройство", len(devices) == 1, devices)
    t("обе сессии живые и в одной группе",
      devices and int(devices[0]["sessions"]) >= 2, (devices, session_rows(server, user_id)))
    t("второй браузер тоже видит одно устройство", len(second.devices()) == 1, second.devices())

    # 6. Настоящее другое устройство — другая сеть (и своя кука).
    phone = Browser(base, ip="10.9.9.9", user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                                                 "AppleWebKit/605.1.15 Mobile/15E148")
    status, _ = phone.login("device@example.com", "password-123")
    t("вход с телефона", status == 200, status)
    phone_token = phone.cookies.get("ege_session", "")
    devices = main_browser.devices()
    names = sorted(d["name"] for d in devices)
    t("телефон — отдельное устройство", len(devices) == 2, devices)
    t("названия осмысленные", names == ["Windows", "iOS 17"], names)
    phone_device = next(d for d in devices if d["name"] == "iOS 17")
    t("у телефона своя сессия", int(phone_device["sessions"]) == 1, phone_device)
    t("текущее устройство — браузер",
      any(d["current"] and d["name"] == "Windows" for d in devices), devices)

    # 7. Отзыв чужого устройства сносит его сессии и только их.
    status, _ = main_browser.request(f"/api/auth/devices/{phone_device['id']}", "DELETE")
    t("отзыв телефона", status == 200, status)
    t("сессии телефона удалены с сервера",
      all(r["id"] != phone_device["id"] for r in session_rows(server, user_id)),
      session_rows(server, user_id))
    # Прежняя кука телефона больше не открывает этот аккаунт: ни как гость
    # без профиля, ни как свежий (возможно, другой) пользователь.
    phone.cookies["ege_session"] = phone_token
    status, boot = phone.request("/api/bootstrap-lite")
    t("старая кука телефона не возвращает в аккаунт",
      status == 200 and boot.get("accountId") != account_id, (status, boot.get("accountId")))
    devices = main_browser.devices()
    t("у браузера осталась одна группа", len(devices) == 1 and int(devices[0]["sessions"]) >= 2, devices)
    t("чужой аккаунт/чужой id не отзывается", main_browser.request("/api/auth/devices/99999", "DELETE")[0] == 404)

    # 8. Отзыв устройства снимает ВСЕ его сессии: «Завершить» не оставляет
    #    половину вкладок. Чужие строки (телефона) не трогаем — их уже нет,
    #    поэтому проверяем на подставном лишнем id.
    status, _ = main_browser.request(f"/api/auth/devices/{devices[0]['id']}", "DELETE")
    t("отзыв своего устройства", status == 200, status)
    t("все сессии устройства удалены", session_rows(server, user_id) == [], session_rows(server, user_id))
    t("кука сессии сброшена", "ege_session" not in main_browser.cookies, main_browser.cookies)
    t("кука устройства пережила отзыв сессии", main_browser.cookies.get("ege_device") == device_cookie,
      main_browser.cookies)
    status, _ = second.request("/api/auth/devices")
    t("вторая сессия того же устройства тоже выбита", status == 401, status)

    # 9. Мусор до миграции: живые строки без отпечатков. Стоит браузеру один
    #    раз обратиться к сайту, как его строка и все прежние строки того же
    #    названия получают отпечатки и снова становятся одним устройством —
    #    и при этом ничего не удаляется молча.
    legacy_token = "legacy-session-token-0123456789"
    conn = server.connect()
    try:
        now_ms = int(time.time() * 1000)
        for token in (legacy_token, "legacy-dup-1", "legacy-dup-2"):
            conn.execute(
                "INSERT INTO user_sessions(user_id, token, created_at, expires_at, device_name, device_type, last_seen_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (user_id, token, server.now_iso(), now_ms + 10 ** 12, "Windows PC", "desktop", now_ms))
        conn.commit()
    finally:
        conn.close()
    main_browser.cookies["ege_session"] = legacy_token
    status, boot = main_browser.request("/api/bootstrap-lite")
    t("старая сессия жива после апгрейда", status == 200 and boot.get("accountId") == account_id, status)
    rows = session_rows(server, user_id)
    t("отпечатки проставлены при первом обращении",
      all(r["device_key"] and r["device_net"] for r in rows), rows)
    devices = main_browser.devices()
    t("старые дубли того же браузера не видны отдельными устройствами",
      len(devices) == 1 and int(devices[0]["sessions"]) == 3, devices)
    t("старые дубли не удалены молча (их можно завершить руками)",
      len(session_rows(server, user_id)) == 3, session_rows(server, user_id))
    status, _ = main_browser.request(f"/api/auth/devices/{devices[0]['id']}", "DELETE")
    t("отзыв сносит и старые дубли", status == 200 and session_rows(server, user_id) == [],
      session_rows(server, user_id))

    # 9b. Тот же путь при входе: сессия без куки (потерянной) заводит строку и
    #     подхватывает прежние строки того же браузера.
    main_browser.login("device@example.com", "password-123")
    conn = server.connect()
    try:
        conn.execute(
            "INSERT INTO user_sessions(user_id, token, created_at, expires_at, device_name, device_type, last_seen_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (user_id, "legacy-dup-3", server.now_iso(), int(time.time() * 1000) + 10 ** 12,
             "Windows PC", "desktop", int(time.time() * 1000)))
        conn.commit()
    finally:
        conn.close()
    main_browser.request("/api/bootstrap-lite")
    main_browser.login("device@example.com", "password-123")
    devices = main_browser.devices()
    t("прежняя строка подхвачена новой сессией того же браузера",
      len(devices) == 1, devices)

    # 10. Приватность ответа: только название/тип/время, без токенов, IP и UA.
    main_browser.login("device@example.com", "password-123")
    status, payload = main_browser.request("/api/auth/devices")
    blob = json.dumps(payload, ensure_ascii=False)
    t("в ответе нет токенов и отпечатков",
      "ege_session" not in blob and device_cookie not in blob and "device_key" not in blob, blob[:200])
    t("в ответе нет IP/UA", "10.0.0.7" not in blob and "Mozilla" not in blob, blob[:200])
    conn = server.connect()
    try:
        dump = json.dumps([dict(zip(("device_name", "device_type", "device_key", "device_net"), r))
                           for r in conn.execute(
                               "SELECT device_name, device_type, device_key, device_net FROM user_sessions")],
                          ensure_ascii=False)
    finally:
        conn.close()
    t("в таблице сессий нет ни IP, ни UA", "10.0.0.7" not in dump and "Mozilla" not in dump, dump[:200])

    # 11. Смена пароля/сети не ломает отпечаток: устройство остаётся тем же.
    devices_before = main_browser.devices()
    main_browser.request("/api/bootstrap-lite")
    t("смена сетевого адреса не плодит устройств (кука держит отпечаток)",
      len(main_browser.devices()) == 1, (devices_before, main_browser.devices()))

    # 11b. Мусорное «Браузер» от неопознанного клиента (curl/тест/робот):
    #      строка без отпечатков, которая с прихода отпечатков ни разу не
    #      пришла, из списка уходит сама — но только когда у аккаунта есть
    #      опознанное устройство и имя ровно запасное.
    main_browser.login("device@example.com", "password-123")
    user_id = conn_user_id(server, account_id)
    conn = server.connect()
    try:
        now_ms = int(time.time() * 1000)
        for token, name in (("junk-curl", "Браузер"), ("real-old-pc", "Windows PC")):
            conn.execute(
                "INSERT INTO user_sessions(user_id, token, created_at, expires_at, device_name, device_type, last_seen_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (user_id, token, server.now_iso(), now_ms + 10 ** 12, name, "desktop", now_ms))
        conn.commit()
    finally:
        conn.close()
    devices = main_browser.devices()
    names = sorted(d["name"] for d in devices)
    t("безымянное «Браузер» больше не показывается", all(n != "Браузер" for n in names), names)
    t("текущее устройство на месте", any(d["current"] for d in devices), devices)
    rows = session_rows(server, user_id)
    t("строка настоящего старого устройства не удалена",
      any(r["device_name"] == "Windows PC" and r["device_key"] is None for r in rows), rows)
    t("мусорной строки в базе нет",
      not any(r["device_name"] == "Браузер" and r["device_key"] is None for r in rows), rows)

    # 12. Доисторические входы одного устройства подчищаются: без куки сессии
    #     строка всё равно недостижима, но таблица не растёт вечно. Живые
    #     вкладки и соседние устройства не затрагиваются.
    main_browser.login("device@example.com", "password-123")
    user_id = conn_user_id(server, account_id)
    other = Browser(base, ip="10.9.9.9", user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                                                    "AppleWebKit/605.1.15 Mobile/15E148")
    other.login("device@example.com", "password-123")
    live_other = len(session_rows(server, user_id))
    conn = server.connect()
    try:
        now_ms = int(time.time() * 1000)
        real_key = conn.execute("SELECT device_key FROM user_sessions WHERE user_id=? AND device_key IS NOT NULL "
                                "ORDER BY id LIMIT 1", (user_id,)).fetchone()[0]
        # 40 доисторических входов того же браузера: токенов у человека нет.
        for i in range(40):
            conn.execute(
                "INSERT INTO user_sessions(user_id, token, created_at, expires_at, device_name, device_type, "
                "device_key, device_net, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (user_id, f"rev-token-{i}", server.now_iso(), now_ms + 10 ** 12, "Windows PC", "desktop",
                 real_key, "stale-net", now_ms - (i + 1) * 60_000))
        conn.commit()
    finally:
        conn.close()
    t("до подчистки строк было много", len(session_rows(server, user_id)) > 41, len(session_rows(server, user_id)))
    devices = main_browser.devices()
    t("одно устройство после потока входов", len(devices) == 2, devices)
    browser_device = next(d for d in devices if d["current"])
    t("живых сессий устройства не больше лимита",
      int(browser_device["sessions"]) <= server.DEVICE_SESSION_REVISIONS_MAX, browser_device)
    rows = session_rows(server, user_id)
    t("подчистка не съела соседнее устройство",
      any(r["device_name"] == "iOS 17" for r in rows), rows)
    t("текущая сессия выжила", any(r["id"] == browser_device["id"] for r in rows), rows)


def conn_user_id(server, account_id: str) -> int:
    conn = server.connect()
    try:
        row = conn.execute("SELECT id FROM users WHERE account_id=?", (account_id,)).fetchone()
        assert row, account_id
        return int(row["id"])
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
