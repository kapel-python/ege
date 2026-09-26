#!/usr/bin/env python3
"""Backup temp-file hygiene: the backup dirs must not grow without bound.

Regression for a real leak. verify_backup() unpacks a snapshot to
`.verify.<pid>.sqlite3`, runs PRAGMA quick_check and deletes that one file.
SQLite creates `-wal`/`-shm` next to it even for a read-only connection, and
those sidecars survived forever: _prune() only globs `*.sqlite3.gz`, so
nothing ever reclaimed them. One leaked pair per verify, ~194 candidates
scanned by latest_healthy() on a corrupt start.

Own temp DB and temp backup dir; the production ones are never touched.
"""
from __future__ import annotations

import gzip
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUP_PATH = ROOT / "server" / "backup.py"

FAILURES: list = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def load_backup(db_path: Path, backup_dir: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_BACKUP_DIR"] = str(backup_dir)
    os.environ["EGE_BACKUP_INTERVAL_SEC"] = "10"
    spec = importlib.util.spec_from_file_location("ege_backup_hygiene", BACKUP_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_db(path: Path) -> None:
    """WAL-mode database, like the real install (server.py sets journal_mode)."""
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT)")
        conn.execute("INSERT INTO users(email) VALUES ('a@example.com')")
        conn.commit()
    finally:
        conn.close()


def temp_files(directory: Path) -> list:
    """Every file in the dir that backup.py considers its own temp scratch."""
    if not directory.is_dir():
        return []
    return sorted(p.name for p in directory.iterdir()
                  if p.is_file() and p.name.startswith("."))


def age(path: Path, seconds: float) -> None:
    when = time.time() - seconds
    os.utime(path, (when, when))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="ege-backup-hygiene-"))
    db_path = tmp / "ege.sqlite3"
    backups = tmp / "backups"
    try:
        backup = load_backup(db_path, backups)
        minutely = backups / "minutely"
        full = backups / "full"

        print("verify_backup() must not leak SQLite sidecars")
        make_db(db_path)
        seed = minutely / "snap-seed.sqlite3.gz"
        minutely.mkdir(parents=True, exist_ok=True)
        backup.sqlite_backup_into(db_path, seed)
        check("seed snapshot verifies", backup.verify_backup(seed))
        leaked = temp_files(minutely)
        check("no temp files after verify_backup", leaked == [], f"leaked: {leaked}")

        print("a healthy backup still verifies (no false negative)")
        check("verify still returns True", backup.verify_backup(seed))
        check("still no temp files", temp_files(minutely) == [],
              f"leaked: {temp_files(minutely)}")

        print("minutely_tick() and full_backup() must not leak")
        for _ in range(3):
            backup.minutely_tick()
        check("minutely_tick left no temp files", temp_files(minutely) == [],
              f"leaked: {temp_files(minutely)}")
        made = backup.full_backup("test")
        check("full_backup produced a snapshot", made is not None and made.is_file())
        check("full dir left no temp files", temp_files(full) == [],
              f"leaked: {temp_files(full)}")
        check("db dir left no temp files", temp_files(tmp) == [],
              f"leaked: {temp_files(tmp)}")

        print("_is_temp_name() must not endanger the live database")
        name = backup._is_temp_name
        check("live wal is protected", name("ege.sqlite3-wal") is False)
        check("live shm is protected", name("ege.sqlite3-shm") is False)
        check("live db is protected", name("ege.sqlite3") is False)
        check("snapshot is protected", name("snap-20260926-120000.sqlite3.gz") is False)
        check("manifest is protected", name("manifest.json") is False)
        check("verify main is swept", name(".verify.4242.sqlite3") is True)
        check("verify wal is swept", name(".verify.4242.sqlite3-wal") is True)
        check("verify shm is swept", name(".verify.4242.sqlite3-shm") is True)
        check("restore temp is swept", name(".restore.4242.sqlite3") is True)
        check("manifest temp is swept", name(".manifest.4242.tmp") is True)
        check("partial is swept", name(".snap-x.sqlite3.gz.4242.partial") is True)

        print("sweep_temp_files() reclaims old junk only")
        old_verify = minutely / ".verify.999.sqlite3"
        old_wal = minutely / ".verify.999.sqlite3-wal"
        old_shm = minutely / ".verify.999.sqlite3-shm"
        old_restore = tmp / ".restore.999.sqlite3"
        old_manifest = backups / ".manifest.999.tmp"
        old_partial = minutely / ".snap-old.sqlite3.gz.999.partial"
        for path in (old_verify, old_wal, old_shm, old_restore, old_manifest, old_partial):
            path.write_bytes(b"stale")
            age(path, 7200)
        fresh = minutely / ".verify.1000.sqlite3-wal"
        fresh.write_bytes(b"in-flight")
        live_wal = tmp / "ege.sqlite3-wal"
        live_wal.write_bytes(b"live database wal")
        age(live_wal, 7200)

        removed = backup.sweep_temp_files()
        check("sweep removed the stale ones", removed == 6, f"removed={removed}")
        for path in (old_verify, old_wal, old_shm, old_restore, old_manifest, old_partial):
            check(f"gone: {path.name}", not path.exists())
        check("fresh in-flight temp kept", fresh.exists())
        check("live db wal kept", live_wal.exists())
        check("real snapshot kept", seed.is_file())
        check("full snapshot kept", made is not None and made.is_file())
        check("manifest kept", (backups / "manifest.json").is_file())
        # Гарантия проверена — убираем, чтобы дальше «пустой каталог» означало
        # именно отсутствие мусора, а не наличие нашего же файла.
        fresh.unlink()

        print("tick_once() sweeps every iteration")
        stale = minutely / ".verify.1001.sqlite3-shm"
        stale.write_bytes(b"stale")
        age(stale, 7200)
        backup.tick_once()
        check("tick_once swept the stale file", not stale.exists())
        check("tick_once left no temp files", temp_files(minutely) == [],
              f"leaked: {temp_files(minutely)}")

        print("ensure_db_healthy() sweeps at startup")
        boot = minutely / ".verify.1002.sqlite3"
        boot.write_bytes(b"left by a killed process")
        age(boot, 7200)
        check("startup reports ok", backup.ensure_db_healthy() == "ok")
        check("startup swept the orphan", not boot.exists())
        check("db still healthy", backup.db_integrity() == "ok")

        print("repeat verifies stay flat (no unbounded growth)")
        for _ in range(25):
            backup.verify_backup(seed)
        check("25 verifies leaked nothing", temp_files(minutely) == [],
              f"leaked: {temp_files(minutely)}")

        print("/api/health reports the temp-file count")
        status = backup.backup_status()
        check("tempFiles present", "tempFiles" in status, f"keys={sorted(status)}")
        check("tempFiles is 0 when clean", status["tempFiles"] == 0,
              f"tempFiles={status['tempFiles']}")
        canary = full / ".verify.4243.sqlite3-wal"
        canary.write_bytes(b"junk")
        check("count sees junk without deleting it", backup.backup_status()["tempFiles"] == 1)
        check("counting did not clean up", canary.exists())
        canary.unlink()
        check("count back to 0", backup.backup_status()["tempFiles"] == 0)

        print("corrupt-db recovery still works and leaves no junk")
        db_path.write_bytes(b"this is not a sqlite file at all")
        fresh_db = tmp / "ege.sqlite3"
        check("integrity sees corruption", backup.db_integrity() != "ok")
        status = backup.ensure_db_healthy()
        check("recovered from a backup", status.startswith("restored:"), status)
        check("integrity is ok again", backup.db_integrity() == "ok")
        check("recovery left no temp files", temp_files(minutely) == [],
              f"leaked: {temp_files(minutely)}")
        check("recovery left no temp in db dir", temp_files(tmp) == [],
              f"leaked: {temp_files(tmp)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}/{CHECKS} — {', '.join(FAILURES[:6])}")
        return 1
    print(f"PASS: {CHECKS} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
