#!/usr/bin/env python3
"""Автобэкапы SQLite и автовосстановление для EGE CORE.

Схема (простая и предсказуемая, без внешних зависимостей):
- полные бэкапы 2 раза в сутки (по умолчанию 04:00 и 16:00 MSK), хранятся
  сжатыми (gzip), ротация — последние 14;
- «минутные» инкрементальные снимки каждую минуту, но пишутся только когда
  БД реально изменилась (сравнение sha256 дайджеста — в простое диск не
  растёт, при БД ~1.5 МБ каждый снимок дешёвый и всегда консистентный, т.к.
  снимается через онлайн-API sqlite3 backup, а не копированием живого файла);
  ротация — последние 180 штук + удаление старше 24 часов;
- manifest.json фиксирует последний полный/минутный бэкап и дайджест БД;
- ensure_db_healthy() вызывается на старте ДО миграций: битый/пустой файл
  уходит в карантин (*.corrupt-<ts>), на его место встаёт новейший здоровый
  бэкап (проверенный PRAGMA quick_check); если здоровых нет — старт с чистой
  БД (сайт работает, данные теряются, но это лучше падения);
- /api/health отдаёт backup_status() — видно, когда был последний бэкап.

Все функции потокобезопасны на уровне «не уронить сервер»: фоновый поток
перехватывает любые исключения и только пишет в stderr. Модуль не имеет
побочных эффектов при импорте — поток стартует только через start_loop().
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

MSK = ZoneInfo("Europe/Moscow")

FULL_KEEP_DEFAULT = 14
MINUTELY_KEEP_DEFAULT = 180
MINUTELY_MAX_AGE_SEC = 24 * 3600
FULL_INTERVAL_SEC = 12 * 3600  # страховка: полный не реже раза в 12 часов


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def db_path() -> Path:
    env = (os.environ.get("EGE_DB_PATH") or "").strip()
    if env:
        return Path(env)
    return _root() / "server" / "ege.sqlite3"


def backup_dir() -> Path:
    env = (os.environ.get("EGE_BACKUP_DIR") or "").strip()
    if env:
        return Path(env)
    return db_path().parent / "backups"


def full_dir() -> Path:
    return backup_dir() / "full"


def minutely_dir() -> Path:
    return backup_dir() / "minutely"


def manifest_path() -> Path:
    return backup_dir() / "manifest.json"


def interval_sec() -> float:
    try:
        return max(10.0, float(os.environ.get("EGE_BACKUP_INTERVAL_SEC", "60")))
    except (TypeError, ValueError):
        return 60.0


def disabled() -> bool:
    return os.environ.get("EGE_BACKUP_DISABLE") == "1"


def full_times() -> list:
    """Пары (час, минута) полных бэкапов из EGE_BACKUP_FULL_TIMES."""
    raw = (os.environ.get("EGE_BACKUP_FULL_TIMES") or "04:00,16:00").strip()
    out = []
    for part in raw.split(","):
        part = part.strip()
        try:
            h_s, m_s = part.split(":")
            h, m = int(h_s), int(m_s)
            if 0 <= h <= 23 and 0 <= m <= 59:
                out.append((h, m))
        except (ValueError, AttributeError):
            continue
    return out or [(4, 0), (16, 0)]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _unique_dst(directory: Path, prefix: str) -> Path:
    """Путь вида prefix-<ts>.sqlite3.gz; при коллизии в одну секунду — -2, -3."""
    base = f"{prefix}-{_stamp()}"
    candidate = directory / f"{base}.sqlite3.gz"
    n = 2
    while candidate.exists():
        candidate = directory / f"{base}-{n}.sqlite3.gz"
        n += 1
    return candidate


def _stamp(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), MSK).strftime("%Y%m%d-%H%M%S")


def file_sha256(path: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def read_manifest() -> dict:
    try:
        raw = manifest_path().read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, UnicodeError):
        return {}


def write_manifest(patch: dict) -> dict:
    """Атомарно слить patch в manifest. Никогда не бросает."""
    try:
        backup_dir().mkdir(parents=True, exist_ok=True)
        data = read_manifest()
        data.update(patch)
        tmp = manifest_path().with_name(f".manifest.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, manifest_path())
        return data
    except OSError:
        return read_manifest()


def sqlite_backup_into(src: Path, dst_gz: Path) -> None:
    """Консистентный онлайн-снапшот через sqlite3 backup API + gzip.

    Копирование файла БД вживую небезопасно (рваный файл под записью);
    backup API отдаёт целостный снапшот даже под нагрузкой.
    """
    tmp_db = dst_gz.with_name(f".{dst_gz.name}.{os.getpid()}.partial")
    tmp_gz = dst_gz.with_name(f".{dst_gz.name}.{os.getpid()}.tmp")
    try:
        source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=10.0)
    except sqlite3.Error as exc:
        raise RuntimeError(f"cannot open source db: {exc}") from exc
    try:
        target = sqlite3.connect(str(tmp_db), timeout=30.0)
        try:
            with target:
                source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    try:
        with open(tmp_db, "rb") as fin, gzip.open(tmp_gz, "wb", compresslevel=6) as fout:
            shutil.copyfileobj(fin, fout, 1024 * 1024)
        os.replace(tmp_gz, dst_gz)
    finally:
        for tmp in (tmp_db, tmp_gz):
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


def verify_backup(path_gz: Path) -> bool:
    """True, когда распакованный бэкап проходит PRAGMA quick_check."""
    tmp = path_gz.with_name(f".verify.{os.getpid()}.sqlite3")
    try:
        with gzip.open(path_gz, "rb") as fin, open(tmp, "wb") as fout:
            shutil.copyfileobj(fin, fout, 1024 * 1024)
        conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True, timeout=10.0)
        try:
            row = conn.execute("PRAGMA quick_check").fetchone()
            return bool(row and row[0] == "ok")
        finally:
            conn.close()
    except (OSError, sqlite3.Error, EOFError):
        return False
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _prune(directory: Path, keep: int, max_age_sec: float | None = None) -> None:
    try:
        files = directory.glob("*.sqlite3.gz")
    except OSError:
        return
    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    files = sorted(files, key=lambda p: (mtime(p), p.name))
    now = time.time()
    doomed = set(files[:-keep]) if len(files) > keep else set()
    if max_age_sec is not None:
        for path in files:
            try:
                if now - path.stat().st_mtime > max_age_sec:
                    doomed.add(path)
            except OSError:
                continue
    for path in doomed:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def full_backup(reason: str = "scheduled") -> Path | None:
    """Полный бэкап + ротация. Возвращает путь или None при неудаче."""
    src = db_path()
    if not src.is_file() or src.stat().st_size == 0:
        return None
    full_dir().mkdir(parents=True, exist_ok=True)
    dst = _unique_dst(full_dir(), "full")
    try:
        sqlite_backup_into(src, dst)
        if not verify_backup(dst):
            dst.unlink(missing_ok=True)
            print(f"EGE CORE backup: full snapshot failed verification ({reason})",
                  file=sys.stderr, flush=True)
            return None
        _prune(full_dir(), FULL_KEEP_DEFAULT)
        write_manifest({"last_full": dst.name, "last_full_at": _now_ms(),
                        "last_db_sha": file_sha256(src)})
        print(f"EGE CORE backup: full {dst.name} ({reason})", flush=True)
        return dst
    except (OSError, RuntimeError, sqlite3.Error) as exc:
        try:
            dst.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"EGE CORE backup: full failed ({reason}): {exc}", file=sys.stderr, flush=True)
        return None


def minutely_tick() -> Path | None:
    """Минутный снимок, только если БД изменилась. Возвращает путь/None."""
    src = db_path()
    if not src.is_file() or src.stat().st_size == 0:
        return None
    sha = file_sha256(src)
    manifest = read_manifest()
    if sha and sha == manifest.get("last_db_sha") and manifest.get("last_minutely"):
        return None  # простоя не было изменений — диск не трогаем
    minutely_dir().mkdir(parents=True, exist_ok=True)
    dst = _unique_dst(minutely_dir(), "snap")
    try:
        sqlite_backup_into(src, dst)
        if not verify_backup(dst):
            dst.unlink(missing_ok=True)
            return None
        _prune(minutely_dir(), MINUTELY_KEEP_DEFAULT, MINUTELY_MAX_AGE_SEC)
        write_manifest({"last_minutely": dst.name, "last_minutely_at": _now_ms(),
                        "last_db_sha": sha})
        return dst
    except (OSError, RuntimeError, sqlite3.Error) as exc:
        try:
            dst.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"EGE CORE backup: minutely failed: {exc}", file=sys.stderr, flush=True)
        return None


def _full_due(last_full_at: int | None) -> bool:
    now = time.time()
    if not last_full_at:
        return True
    if now - last_full_at / 1000 > FULL_INTERVAL_SEC:
        return True
    # Наступило ли плановое время после последнего полного бэкапа.
    today = datetime.fromtimestamp(now, MSK).date()
    last = datetime.fromtimestamp(last_full_at / 1000, MSK)
    for h, m in full_times():
        slot = datetime(today.year, today.month, today.day, h, m, tzinfo=MSK).timestamp()
        if last.timestamp() < slot <= now:
            return True
    return False


def db_integrity(path: Path | None = None) -> str:
    """'ok' | 'missing' | 'empty' | 'corrupt: ...' — только чтение."""
    target = path or db_path()
    try:
        if not target.exists():
            return "missing"
        if target.stat().st_size == 0:
            return "empty"
    except OSError as exc:
        return f"corrupt: cannot stat ({exc})"
    try:
        conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True, timeout=5.0)
        try:
            row = conn.execute("PRAGMA quick_check").fetchone()
            if not row or row[0] != "ok":
                return f"corrupt: {row[0] if row else 'no result'}"
            # Пустой валидный файл (создан коннектом, но install не бежал) —
            # это не «ok»: запросы всё равно упадут с 'no such table'.
            schema = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                                  "AND name='users'").fetchone()
            return "ok" if schema else "empty-schema"
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return f"corrupt: {exc}"


def _candidates_newest_first() -> list:
    """Все бэкапы от новейших к старейшим (по mtime: минутные свежее полных)."""
    out = []
    for directory in (minutely_dir(), full_dir()):
        try:
            out.extend(directory.glob("*.sqlite3.gz"))
        except OSError:
            continue
    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    return sorted(out, key=lambda p: (mtime(p), p.name), reverse=True)


def latest_healthy() -> Path | None:
    for path in _candidates_newest_first():
        if verify_backup(path):
            return path
    return None


def _install_snapshot(path_gz: Path, dest: Path) -> None:
    tmp = dest.with_name(f".restore.{os.getpid()}.sqlite3")
    with gzip.open(path_gz, "rb") as fin, open(tmp, "wb") as fout:
        shutil.copyfileobj(fin, fout, 1024 * 1024)
    os.replace(tmp, dest)
    # Хвосты WAL/журнала от битого файла не должны пережить восстановление:
    # SQLite иначе попытается накатить чужой WAL поверх здорового снапшота.
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            dest.with_name(dest.name + suffix).unlink(missing_ok=True)
        except OSError:
            pass


def ensure_db_healthy() -> str:
    """Проверка/восстановление БД на старте. Возвращает короткий статус."""
    if disabled():
        return "backups-disabled"
    target = db_path()
    try:
        state = db_integrity(target)
    except Exception as exc:  # pragma: no cover - защитный пояс
        state = f"corrupt: {exc}"
    if state == "ok":
        return "ok"
    try:
        donor = latest_healthy()
        if donor is None:
            if state not in ("missing", "empty", "empty-schema"):
                # Битый файл без бэкапов: в карантин для экспертизы, дальше
                # чистая установка через install_catalog. Пустой/отсутствующий
                # файл не трогаем — установка заполнит его на месте.
                quarantine = target.with_name(f"{target.name}.corrupt-{_stamp()}")
                try:
                    target.replace(quarantine)
                    print(f"EGE CORE recovery: {state}; moved to {quarantine.name}",
                          file=sys.stderr, flush=True)
                except OSError as exc:
                    print(f"EGE CORE recovery: cannot quarantine ({exc})",
                          file=sys.stderr, flush=True)
                    return f"quarantine-failed: {state}"
            else:
                print(f"EGE CORE recovery: db {state}; no backups yet",
                      file=sys.stderr, flush=True)
            print("EGE CORE recovery: no healthy backup — starting fresh",
                  file=sys.stderr, flush=True)
            return "fresh"
        if target.exists():
            quarantine = target.with_name(f"{target.name}.corrupt-{_stamp()}")
            try:
                target.replace(quarantine)
                print(f"EGE CORE recovery: {state}; moved to {quarantine.name}",
                      file=sys.stderr, flush=True)
            except OSError as exc:
                print(f"EGE CORE recovery: cannot quarantine ({exc})",
                      file=sys.stderr, flush=True)
                return f"quarantine-failed: {state}"
        target.parent.mkdir(parents=True, exist_ok=True)
        _install_snapshot(donor, target)
        if db_integrity(target) == "ok":
            print(f"EGE CORE recovery: restored {donor.name}", flush=True)
            write_manifest({"restored_from": donor.name, "restored_at": _now_ms()})
            return f"restored:{donor.name}"
        print("EGE CORE recovery: restored snapshot failed check — starting fresh",
              file=sys.stderr, flush=True)
        return "restore-failed"
    except Exception as exc:  # стартовать надо в любом случае
        print(f"EGE CORE recovery failed: {exc}", file=sys.stderr, flush=True)
        return f"error: {exc}"


def backup_status() -> dict:
    """Лёгкий статус для /api/health (только manifest + размер файла)."""
    manifest = read_manifest()
    try:
        size = db_path().stat().st_size if db_path().exists() else 0
    except OSError:
        size = 0
    return {"lastFull": manifest.get("last_full"),
            "lastFullAt": manifest.get("last_full_at"),
            "lastMinutely": manifest.get("last_minutely"),
            "lastMinutelyAt": manifest.get("last_minutely_at"),
            "restoredFrom": manifest.get("restored_from"),
            "dbSizeBytes": size}


def tick_once() -> None:
    """Одна итерация планировщика: минутный снимок + полный по расписанию."""
    minutely_tick()
    manifest = read_manifest()
    if _full_due(manifest.get("last_full_at")):
        full_backup("scheduled")


def start_loop(stop: threading.Event) -> threading.Thread:
    """Фоновый поток бэкапов. Все ошибки — в stderr, поток не падает."""
    def run() -> None:
        # Первый минутный снимок сразу, чтобы свежая БД была покрыта.
        try:
            if not disabled():
                minutely_tick()
        except Exception as exc:
            print(f"EGE CORE backup loop: {exc}", file=sys.stderr, flush=True)
        while not stop.wait(interval_sec()):
            try:
                if not disabled():
                    tick_once()
            except Exception as exc:
                print(f"EGE CORE backup loop: {exc}", file=sys.stderr, flush=True)

    thread = threading.Thread(target=run, name="ege-backup", daemon=True)
    thread.start()
    return thread


def list_backups() -> list:
    rows = []
    for path in _candidates_newest_first():
        try:
            stat = path.stat()
            rows.append({"name": path.name, "dir": path.parent.name,
                         "bytes": stat.st_size, "mtime": int(stat.st_mtime * 1000)})
        except OSError:
            continue
    return rows


def restore_backup(name: str) -> str:
    """Вручную поставить бэкап на место БД. Возвращает статус-строку.

    name: 'latest' либо имя файла из list_backups(). Текущий файл БД уходит
    в карантин (*.pre-restore-<ts>), бэкап проверяется ДО установки.
    Вызывать при остановленном сервере (иначе живые коннекты продолжат
    писать в старый inode, а новые увидят восстановленный файл).
    """
    if name == "latest":
        donor = latest_healthy()
        if donor is None:
            return "no healthy backup found"
    else:
        donor = None
        for directory in (minutely_dir(), full_dir()):
            candidate = directory / Path(name).name
            try:
                if candidate.is_file():
                    donor = candidate
                    break
            except OSError:
                continue
        if donor is None:
            return f"backup not found: {name}"
        if not verify_backup(donor):
            return f"backup failed verification: {donor.name}"
    target = db_path()
    try:
        if target.exists():
            quarantine = target.with_name(f"{target.name}.pre-restore-{_stamp()}")
            target.replace(quarantine)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
        _install_snapshot(donor, target)
        state = db_integrity(target)
        if state == "ok":
            write_manifest({"restored_from": donor.name, "restored_at": _now_ms()})
            return f"restored:{donor.name}"
        return f"restore-failed: {state}"
    except OSError as exc:
        return f"restore-failed: {exc}"
