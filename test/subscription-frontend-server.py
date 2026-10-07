#!/usr/bin/env python3
"""Вспомогательный запуск temp-сервера для test/subscription-frontend.js.

Печатает `PORT=<порт>` и живёт до SIGTERM. Отдельным процессом его
поднимает сам JS-тест, руками запускать не нужно.
"""
import hashlib
import importlib.util
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

tmp = tempfile.mkdtemp(prefix="ege-subfront-e2e-")
os.environ["EGE_DB_PATH"] = str(Path(tmp) / "ege.sqlite3")
os.environ["EGE_DISABLE_SYSTEMD"] = "1"
os.environ["EGE_TRUSTED_PROXY"] = "1"
os.environ["EGE_SUBSCRIPTION_MOCK"] = "1"
# E2E на учебном mock: прод-ключи Platega из окружения хоста гасим.
for _k in ("EGE_PLATEGA_MERCHANT_ID", "EGE_PLATEGA_SECRET",
           "EGE_PLATEGA_METHOD", "EGE_PLATEGA_BASE_URL",
           "EGE_PLATEGA_TIMEOUT_SEC"):
    os.environ.pop(_k, None)
salt = "e" * 32
dk = hashlib.pbkdf2_hmac("sha256", b"e2e-admin", bytes.fromhex(salt), 210000)
os.environ["EGE_ADMIN_PASSWORD_HASH"] = f"pbkdf2_sha256$210000${salt}${dk.hex()}"

spec = importlib.util.spec_from_file_location("ege_subfront_e2e", ROOT / "server" / "server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
httpd = module.create_http_server("127.0.0.1", 0)
print(f"PORT={httpd.server_address[1]}", flush=True)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
