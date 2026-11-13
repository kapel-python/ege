#!/usr/bin/env python3
"""Стенд судьи сочинений: контракт движка офлайн + живой замер стабильности.

Зачем: баллы за сочинение ставит модель, и «стабильность» — это свойство
модели-судьи, а не LanguageTool. Здесь один корпус (test/essay-judge-bench.json)
прогоняется двумя способами:

  python3 test/essay-judge-bench.py
      Офлайн, без сети и без БД. Ответ модели взят из фикстуры, а проверяется
      то, что обязано быть детерминированным: до модели доходит промпт нужной
      рубрики (ЕГЭ/ОГЭ), схема ответа разбирается, потолки/каскады/вето/нули
      гейтов считает сервер, а не модель. Это регресс движка.

  python3 test/essay-judge-bench.py --live --repeat 3 \\
      --judge funpay --model claude-fable-5.1 --env-file /etc/ege-2026.env
      Живой замер: тот же корпус идёт в настоящую модель N раз. Печатается
      разброс по каждой работе. Гейтовые работы обязаны быть нулём ВСЕГДА;
      содержательные — попадать в полосу. Выход за полосу печатается всегда,
      а ненулевой код возврата даёт только с --strict (живой провайдер —
      не CI: сеть и политика шлюза не должны красить сборку).

Живой режим читает конфиг провайдеров (base_url/model/quirks судьи) из копии
app_config продовой БД на время прогона — прод не меняется. Ключи берутся из
окружения или из --env-file (формат KEY=VALUE, как /etc/ege-2026.env).
Грамотность в живом режиме фиксирована (0 ошибок LanguageTool): стенд меряет
именно судью, а не орфографический сервис.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AI_PATH = ROOT / "server" / "ai.py"
CORPUS_PATH = ROOT / "test" / "essay-judge-bench.json"
SOURCES_DIR = ROOT / "server" / "essay_texts.d"

failures = 0
checks = 0


def check(name: str, condition, detail: str = "") -> bool:
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
    print(f"{'PASS' if condition else 'FAIL'} {name}{(' | ' + detail) if detail else ''}")
    return bool(condition)


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def load_bench_ai(db_path: Path):
    """Загрузить server/ai.py с отдельной БД конфига (прод не трогаем)."""
    os.environ["EGE_DB_PATH"] = str(db_path)
    sys.path.insert(0, str(ROOT / "server"))
    spec = importlib.util.spec_from_file_location("ege_judge_bench_ai", AI_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def empty_config_db(path: Path) -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
    conn.commit()
    conn.close()
    return path


def copy_config_db(prod: Path, target: Path) -> Path:
    """Копия только app_config: ai.py читает оттуда провайдеров/судью."""
    src = sqlite3.connect(f"file:{prod}?mode=ro", uri=True, timeout=5.0)
    try:
        rows = src.execute("SELECT key, value_json FROM app_config").fetchall()
    finally:
        src.close()
    dst = sqlite3.connect(str(target))
    dst.execute("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
    dst.executemany("INSERT OR REPLACE INTO app_config(key, value_json) VALUES (?, ?)", rows)
    dst.commit()
    dst.close()
    return target


def load_corpus() -> list[dict]:
    data = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    cases = data.get("cases") if isinstance(data, dict) else None
    if not isinstance(cases, list) or not cases:
        raise SystemExit(f"пустой корпус: {CORPUS_PATH}")
    return cases


def source_for(case: dict) -> dict:
    source_id = str(case.get("sourceId") or "")
    path = SOURCES_DIR / f"{source_id}.json"
    if not source_id or not path.exists():
        raise SystemExit(f"{case.get('id')}: нет исходника {source_id!r} в {SOURCES_DIR}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {"problem": str(payload.get("problem") or ""),
            "text": str(payload.get("text") or "")}


def case_text(case: dict, source: dict) -> str:
    if case.get("textFrom") == "source":
        return source["text"]
    return str(case.get("text") or "")


def parse_env_file(path: str) -> None:
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"нет файла окружения: {p}")
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


# ---------------------------------------------------------------------------
# Офлайн: фикстура ответа модели -> полный конвейер run_format
# ---------------------------------------------------------------------------
def run_offline(ai, cases: list[dict]) -> None:
    section("Офлайн-контракт движка (без сети и без прод-БД)")

    original_chat, original_lt = ai.chat, ai.lt_check
    for case in cases:
        cid = case["id"]
        rubric = "oge" if case.get("rubric") == "oge" else "ege"
        source = source_for(case)
        text = case_text(case, source)
        calls: list[str] = []

        def fake_chat(messages, **kwargs):
            calls.append(str((messages[0] or {}).get("content") or ""))
            return json.dumps(case.get("judge") or {}, ensure_ascii=False)

        ai.chat = fake_chat
        ai.lt_check = lambda text, _case=case: list(_case.get("lt") or [])
        try:
            result = ai.run_format("essay", text, source="source",
                                   problem=source["problem"],
                                   source_text=source["text"], rubric=rubric)
        except Exception as exc:  # noqa: BLE001
            check(f"{cid}: проверка не падает", False, f"{type(exc).__name__}: {exc}")
            continue
        finally:
            ai.chat, ai.lt_check = original_chat, original_lt

        expect = case.get("expect") or {}
        registry = [c for c, _n, _m in ai.essay_criteria_for(rubric)]
        ids = [str(item.get("id")) for item in result.get("criteria") or []]
        check(f"{cid}: рубрика {rubric} — {len(registry)} критериев и максимум "
              f"{ai.essay_max_score_for(rubric)}",
              ids == registry and result.get("max_score") == ai.essay_max_score_for(rubric),
              f"{ids} / {result.get('max_score')}")
        check(f"{cid}: итог {expect.get('total')} (сервер считает сам)",
              result.get("total_score") == expect.get("total"),
              f"получено {result.get('total_score')}")
        check(f"{cid}: у каждого критерия есть комментарий",
              all(str(item.get("comment") or "").strip() for item in result.get("criteria") or []))
        check(f"{cid}: вердикт не пустой", bool(str(result.get("short_verdict") or "").strip()))

        gate = case.get("gate")
        if gate:
            calibration = result.get("calibration") or {}
            check(f"{cid}: детерминированный гейт {gate} сработал",
                  calibration.get("reason") == gate,
                  str(calibration.get("reason")))
            check(f"{cid}: модель на гейте не звалась (0 вызовов)", len(calls) == 0,
                  str(len(calls)))
        else:
            check(f"{cid}: модель получила промпт рубрики {rubric}",
                  len(calls) == 1 and calls[0] == ai.FORMATS["essay"]["systems"][rubric],
                  str(len(calls)))
            expected_veto = expect.get("veto")
            if expected_veto:
                calibration = result.get("calibration") or {}
                check(f"{cid}: серверное вето {expected_veto} перебило модель",
                      result.get("total_score") == 0
                      and calibration.get("reason") == expected_veto,
                      str(calibration)[:120])


# ---------------------------------------------------------------------------
# Живой режим: настоящая модель-судья
# ---------------------------------------------------------------------------
def force_judge(ai, provider: str, model: str) -> None:
    """Направить проверку строго в одного судью: без failover и без чужих моделей."""
    ai.judge_providers_order = lambda tier=None: [provider]
    ai._expand_chat_plan = lambda names, explicit_model=None, tier=None: [
        (provider, model or None)]


def run_live(ai, cases: list[dict], provider: str, model: str, repeat: int,
             strict: bool) -> int:
    section(f"Живой замер: {provider} / {model or '(модель провайдера)'}, "
            f"повторов {repeat}")
    ai.lt_check = lambda text: []          # грамотность фиксирована: меряем судью
    force_judge(ai, provider, model)

    total_runs = 0
    errors = 0
    out_of_band: list[str] = []
    for case in cases:
        cid = case["id"]
        rubric = "oge" if case.get("rubric") == "oge" else "ege"
        source = source_for(case)
        text = case_text(case, source)
        totals: list[int] = []
        reasons: list[str] = []
        run_errors: list[str] = []
        for _ in range(repeat):
            total_runs += 1
            try:
                result = ai.run_format("essay", text, source="source",
                                       problem=source["problem"],
                                       source_text=source["text"], rubric=rubric)
                totals.append(int(result.get("total_score") or 0))
                calibration = result.get("calibration") or {}
                reasons.append(str(calibration.get("reason") or "ok"))
            except Exception as exc:  # noqa: BLE001
                run_errors.append(f"{type(exc).__name__}: {exc}")
        errors += len(run_errors)
        spread = (f"{min(totals)}–{max(totals)}" if totals else "—")
        print(f"  {cid:<14} {spread:>7}  {' '.join(str(t) for t in totals) or '—':<12}"
              f" {','.join(sorted(set(reasons))) or '—'}"
              + (f"  ОШИБКИ: {run_errors[0]}" if run_errors else ""), flush=True)

        expect = case.get("live") or {}
        lo, hi = int(expect.get("min", 0)), int(expect.get("max", 10**9))
        if case.get("gate"):
            ok = bool(totals) and all(t == 0 for t in totals)
        else:
            ok = bool(totals) and all(lo <= t <= hi for t in totals)
        if not ok:
            out_of_band.append(f"{cid}: ожидалось {lo}–{hi}, получено {totals or run_errors}")

    print()
    if out_of_band:
        print("ВНЕ ПОЛОСЫ:")
        for line in out_of_band:
            print(f"  - {line}")
    if errors and errors == total_runs:
        print("\nВсе запросы упали: проверь ключ, баланс и доступность провайдера.")
        return 2
    if out_of_band:
        return 1 if strict else 0
    print("Все работы уложились в полосы.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Стенд судьи сочинений")
    ap.add_argument("--live", action="store_true",
                    help="звать настоящую модель вместо фикстур")
    ap.add_argument("--repeat", type=int, default=3, help="повторов на работу (живой режим)")
    ap.add_argument("--judge", default="funpay", help="провайдер-судья (живой режим)")
    ap.add_argument("--model", default="claude-fable-5.1", help="модель судьи (живой режим)")
    ap.add_argument("--env-file", default="", help="файл KEY=VALUE с ключами провайдеров")
    ap.add_argument("--db", default=str(ROOT / "server" / "ege.sqlite3"),
                    help="БД, откуда взять app_config провайдеров (только чтение)")
    ap.add_argument("--strict", action="store_true",
                    help="ненулевой код, если живой прогон вышел из полосы")
    ap.add_argument("--cases", default="", help="id через запятую (по умолчанию все)")
    args = ap.parse_args()

    if args.repeat < 1:
        raise SystemExit("--repeat должен быть >= 1")
    cases = load_corpus()
    if args.cases:
        wanted = {part.strip() for part in args.cases.split(",") if part.strip()}
        cases = [case for case in cases if case["id"] in wanted]
        if not cases:
            raise SystemExit("ни одна работа не выбрана")

    with tempfile.TemporaryDirectory(prefix="ege-judge-bench-") as tmp:
        db_path = Path(tmp) / "config.sqlite3"
        if args.live:
            if args.env_file:
                parse_env_file(args.env_file)
            prod = Path(args.db)
            if not prod.exists():
                raise SystemExit(f"нет БД с конфигом провайдеров: {prod}")
            copy_config_db(prod, db_path)
        else:
            empty_config_db(db_path)
        ai = load_bench_ai(db_path)
        if args.live:
            code = run_live(ai, cases, args.judge, args.model, args.repeat, args.strict)
            if code:
                return code
            return 0
        run_offline(ai, cases)

    print(f"\n{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
