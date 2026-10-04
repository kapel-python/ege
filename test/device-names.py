#!/usr/bin/env python3
"""Точность названий устройств (parse_device_info).

Лестница честности: версия/модель показываются, только если они реально
известны (UA с настоящей версией, легаси-UA с моделью, Client Hints / X-Ege-*),
а не угадываются. Урезанный Chrome («Android 10; K», «Windows NT 10.0») версии
не даёт — там остаются обобщённые названия, иначе владелец Android 16 увидел
бы «Android 10».

Офлайн: дёргаем parse_device_info/parse_client_hints напрямую, без HTTP.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
import tempfile
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
        print(f"FAIL  {name}: {detail!r}")


def load_server():
    tmp = tempfile.mkdtemp(prefix="ege-devnames-")
    os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    salt = "b" * 32
    dk = hashlib.pbkdf2_hmac("sha256", b"test-admin-password", bytes.fromhex(salt), 210000)
    os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"
    spec = importlib.util.spec_from_file_location("ege_device_names_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHROME_WIN = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
REDUCED_ANDROID = ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36")
LEGACY_POCO = ("Mozilla/5.0 (Linux; Android 14; POCO F6 Pro Build/UP1A.231005.007; wv) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36")
LEGACY_SAMSUNG = ("Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36")
IPHONE_17 = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 Mobile/15E148")
IPHONE_13 = ("Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) "
             "AppleWebKit/605.1.15 Mobile/15E148")
IPAD_16 = ("Mozilla/5.0 (iPad; CPU OS 16_1 like Mac OS X) "
           "AppleWebKit/605.1.15 Mobile/15E148")
MAC_1015 = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
MAC_14 = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 "
          "Version/17.2 Safari/605.1.15")


class FakeHandler:
    def __init__(self, headers: dict):
        self.headers = dict(headers)


def main() -> int:
    server = load_server()
    p = server.parse_device_info

    # 1. Урезанный UA врёт про версию — верим ему только в generics.
    t("урезанный Android без версии", p(REDUCED_ANDROID) == ("Android-смартфон", "phone"),
      p(REDUCED_ANDROID))
    t("Windows по одному UA без версии", p(CHROME_WIN) == ("Windows PC", "desktop"),
      p(CHROME_WIN))
    t("пустой UA — Браузер", p("") == ("Браузер", "desktop"), p(""))
    t("curl — Браузер", p("curl/8.0") == ("Браузер", "desktop"), p("curl/8.0"))

    # 2. Легаси-UA с настоящей моделью и версией.
    t("POCO из легаси-UA", p(LEGACY_POCO) == ("POCO F6 Pro · Android 14", "phone"), p(LEGACY_POCO))
    t("Samsung из легаси-UA", p(LEGACY_SAMSUNG) == ("SM-G991B · Android 13", "phone"),
      p(LEGACY_SAMSUNG))

    # 3. Версии Apple/macOS из UA (Safari не урезает).
    t("iPhone iOS 17", p(IPHONE_17) == ("iPhone · iOS 17", "phone"), p(IPHONE_17))
    t("iPhone iOS 13", p(IPHONE_13) == ("iPhone · iOS 13", "phone"), p(IPHONE_13))
    t("iPad iPadOS 16", p(IPAD_16) == ("iPad · iPadOS 16", "tablet"), p(IPAD_16))
    t("Mac 10.15", p(MAC_1015) == ("MacBook · macOS 10.15", "laptop"), p(MAC_1015))
    t("Mac 14", p(MAC_14) == ("MacBook · macOS 14", "laptop"), p(MAC_14))

    # 4. Подсказки поверх урезанного UA: модель и версия.
    t("POCO F6 Pro + Android 16 из хинтов",
      p(REDUCED_ANDROID, {"model": "POCO F6 Pro", "platform": "android",
                          "version": "16", "mobile": True}) == ("POCO F6 Pro · Android 16", "phone"),
      p(REDUCED_ANDROID, {"model": "POCO F6 Pro", "platform": "android", "version": "16", "mobile": True}))
    t("Android 15 без модели", p(REDUCED_ANDROID, {"platform": "android", "version": "15"}) ==
      ("Android-смартфон · Android 15", "phone"),
      p(REDUCED_ANDROID, {"platform": "android", "version": "15"}))
    t("Windows 11 из хинтов", p(CHROME_WIN, {"platform": "windows", "version": "15"}) ==
      ("Windows 11 PC", "desktop"), p(CHROME_WIN, {"platform": "windows", "version": "15"}))
    t("Windows 10 из хинтов", p(CHROME_WIN, {"platform": "windows", "version": "10"}) ==
      ("Windows 10 PC", "desktop"), p(CHROME_WIN, {"platform": "windows", "version": "10"}))
    t("полная версия 15.0.0 режется до major",
      p(CHROME_WIN, {"platform": "windows", "version": "15.0.0"}) == ("Windows 11 PC", "desktop"),
      p(CHROME_WIN, {"platform": "windows", "version": "15.0.0"}))

    # 5. Санитария: заглушки и инъекции никогда не становятся названием.
    t("модель-заглушка K отбрасывается",
      p(REDUCED_ANDROID, {"model": "K"}) == ("Android-смартфон", "phone"),
      p(REDUCED_ANDROID, {"model": "K"}))
    t("кавычки Client Hints снимаются",
      p(REDUCED_ANDROID, {"model": '"POCO F6 Pro"', "platform": "android",
                          "version": "16", "mobile": True}) == ("POCO F6 Pro · Android 16", "phone"),
      p(REDUCED_ANDROID, {"model": '"POCO F6 Pro"'}))
    t("greased-бренд не модель",
      p(REDUCED_ANDROID, {"model": "Not/A)Brand"}) == ("Android-смартфон", "phone"),
      p(REDUCED_ANDROID, {"model": "Not/A)Brand"}))
    t("инъекция в модели не проходит",
      p(REDUCED_ANDROID, {"model": "<script>alert(1)</script>"}) == ("Android-смартфон", "phone"),
      p(REDUCED_ANDROID, {"model": "<script>"}))

    # 6. parse_client_hints: свои заголовки старше стандартных, мусор чистится.
    h = server.parse_client_hints(FakeHandler({
        "User-Agent": REDUCED_ANDROID,
        "Sec-CH-UA-Model": '"Pixel 7"',
        "Sec-CH-UA-Platform": '"Android"',
        "Sec-CH-UA-Platform-Version": '"14.0.0"',
        "Sec-CH-UA-Mobile": "?1",
    }))
    t("стандартные хинты читаются",
      h == {"model": "Pixel 7", "platform": "android", "version": "14", "mobile": True}, h)
    t("хинты дают Pixel 7",
      p(REDUCED_ANDROID, h) == ("Pixel 7 · Android 14", "phone"), p(REDUCED_ANDROID, h))
    h2 = server.parse_client_hints(FakeHandler({
        "Sec-CH-UA-Model": '"Pixel 7"',
        "X-Ege-Device-Model": "POCO F6 Pro",
        "X-Ege-OS-Version": "16",
        "X-Ege-Platform": "Android",
        "X-Ege-Mobile": "1",
    }))
    t("свои заголовки старше стандартных", h2["model"] == "POCO F6 Pro" and h2["version"] == "16", h2)
    h3 = server.parse_client_hints(FakeHandler({"Sec-CH-UA-Mobile": "?0"}))
    t("mobile ?0 читается", h3["mobile"] is False, h3)
    h4 = server.parse_client_hints(FakeHandler({}))
    t("без заголовков хинтов нет",
      h4 == {"model": "", "platform": "", "version": "", "mobile": None}, h4)

    # 7. Старые честные NT и iPad-на-Mac через JS-платформу.
    t("Windows 7 честно", p("Mozilla/5.0 (Windows NT 6.1; Win64; x64)") == ("Windows 7 PC", "desktop"),
      p("Mozilla/5.0 (Windows NT 6.1; Win64; x64)"))
    t("iPad-на-Mac через платформу (версия неизвестна — честно без неё)",
      p(MAC_1015, {"platform": "ipados"}) == ("iPad", "tablet"),
      p(MAC_1015, {"platform": "ipados"}))
    t("планшет без Mobile по хинтам",
      p("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
        {"platform": "android", "version": "14", "mobile": False}) ==
      ("Android-планшет · Android 14", "tablet"),
      p("Mozilla/5.0 (Linux; Android 10; K)"))

    # 8. Заводские коды: известный — имя, неизвестный — прячем, не шумим.
    t("заводской код POCO подменяется именем",
      p(REDUCED_ANDROID, {"model": "23113RKC6G", "platform": "android",
                          "version": "16", "mobile": True}) == ("POCO F6 Pro · Android 16", "phone"),
      p(REDUCED_ANDROID, {"model": "23113RKC6G"}))
    t("маппинг не зависит от регистра",
      p(REDUCED_ANDROID, {"model": "23113rkc6g", "platform": "android",
                          "version": "16", "mobile": True}) == ("POCO F6 Pro · Android 16", "phone"),
      p(REDUCED_ANDROID, {"model": "23113rkc6g"}))
    t("неизвестный техкод прячется, версия остаётся",
      p(REDUCED_ANDROID, {"model": "24049PC21G", "platform": "android",
                          "version": "15", "mobile": True}) == ("Android-смартфон · Android 15", "phone"),
      p(REDUCED_ANDROID, {"model": "24049PC21G"}))
    t("неизвестный техкод без версии — голый generic",
      p(REDUCED_ANDROID, {"model": "24049PC21G"}) == ("Android-смартфон", "phone"),
      p(REDUCED_ANDROID, {"model": "24049PC21G"}))
    t("человеческий код Samsung остаётся",
      p(REDUCED_ANDROID, {"model": "SM-G991B", "platform": "android",
                          "version": "14", "mobile": True}) == ("SM-G991B · Android 14", "phone"),
      p(REDUCED_ANDROID, {"model": "SM-G991B"}))

    print(f"\npassed: {PASSED}, failed: {len(FAILED)}")
    for name in FAILED:
        print(f"  — {name}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
