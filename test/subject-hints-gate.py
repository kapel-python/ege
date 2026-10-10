#!/usr/bin/env python3
"""Гейт единой системы подсказок в реестре предметов.

У каждой темы ready-предмета обязан быть metadata.hints — ровно три непустые
строки. Без него практика, миссии, боссы, «ежедневка» и повторение откатываются
к лестнице задания, а у ЕГЭ-банков это шаблон формата ответа, поэтому тема
остаётся без помощи. Отсутствие подсказок — такая же ошибка контракта, как
пустые goals или diagnosticTasks: предмет не добавляется.

Тест не лезет в продакшн-БД: каталог-фикстура собирается во временном
каталоге, реальные каталоги читаются только на проверку данных.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = ROOT / "server"
REGISTRY = SERVER_DIR / "subjects_registry.py"

FEATURES = {"lessons": True, "practice": True, "forecast": True, "diagnostics": True,
            "missions": True, "bosses": True, "daily": True, "path": True}
CONTENT = {"topics": {"source": "catalog", "keys": ["categories", "skills"]},
           "preparationVariants": {"source": "catalog", "key": "goals"},
           "onboarding": {"source": "catalog", "key": "diagnosticTasks"}}


def load_registry():
    spec = importlib.util.spec_from_file_location("ege_subject_hints_gate", REGISTRY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def catalog(skills: list[dict]) -> dict:
    return {
        "subject": "probe", "subjectId": "probe",
        "categories": [{"id": "c1", "name": "Раздел"}],
        "skills": skills,
        "tasks": [{"id": "t1", "skill": "p01"}],
        "goals": [{"id": "g60", "label": "60+ баллов"}],
        "diagnosticTasks": ["t1"],
    }


def skill(sid: str, hints) -> dict:
    return {"id": sid, "name": f"тема {sid}", "cat": "c1", "order": 1, "ege": "№1",
            "metadata": {} if hints is None else {"hints": hints}}


def contract(status: str = "ready") -> dict:
    return {"id": "probe", "title": "Probe", "short": "P", "description": "d",
            "status": status, "catalogFile": "catalog_probe.json",
            "level": {"id": "probe", "subjectId": "probe", "name": "Probe"},
            "features": dict(FEATURES), "content": json.loads(json.dumps(CONTENT))}


def main() -> int:
    reg = load_registry()
    failures = 0
    checks = 0

    def check(name: str, condition: bool, detail: str = "") -> None:
        nonlocal failures, checks
        checks += 1
        if not condition:
            failures += 1
        print(f"{'PASS' if condition else 'FAIL'} {name}" + (f" | {detail}" if detail and not condition else ""))

    def build(tmp: Path, skills: list[dict]) -> None:
        (tmp / "catalog_probe.json").write_text(
            json.dumps(catalog(skills), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def guard(skills: list[dict], status: str = "ready") -> str:
        """Вернуть текст ошибки контракта (пусто — если контракт принят)."""
        with tempfile.TemporaryDirectory(prefix="ege-hints-gate-") as raw:
            tmp = Path(raw)
            build(tmp, skills)
            try:
                reg.validate_definition(contract(status), source="probe.json", server_dir=tmp)
                return ""
            except reg.SubjectContractError as exc:
                return str(exc)

    good = ["С чего начать.", "Ключевое правило темы.", "Проверка и ловушка."]

    check("полный каталог: три подсказки у каждой темы — контракт принимается",
          guard([skill("p01", good), skill("p02", good)]) == "",
          guard([skill("p01", good), skill("p02", good)]))

    two = guard([skill("p01", good), skill("p02", good[:2])])
    check("две подсказки вместо трёх — предмет не добавляется",
          "p02" in two and "трёх подсказок" in two, two)

    no_meta = guard([skill("p01", good), skill("p02", None)])
    check("тема вообще без metadata — предмет не добавляется",
          "p02" in no_meta, no_meta)

    empty = guard([skill("p01", good[:2] + ["   "])])
    check("пустая третья подсказка — не считается", "p01" in empty, empty)

    nonstr = guard([skill("p01", [good[0], good[1], 42])])
    check("подсказка не строкой — не считается", "p01" in nonstr, nonstr)

    four = guard([skill("p01", good + ["лишняя"])])
    check("четыре подсказки вместо трёх — не считается", "p01" in four, four)

    check("пустой список skills — отдельная ошибка",
          "non-empty skills" in guard([]), guard([]))

    # Реальный реестр: каждый ready-предмет обязан иметь подсказки у всех тем.
    definitions, _warnings, from_files = reg.load_definitions(server_dir=SERVER_DIR)
    check("реестр предметов загружается из файлов", from_files and bool(definitions))

    missing: list[str] = []
    for sid, definition in definitions.items():
        catalog_path = SERVER_DIR / definition["catalogFile"]
        source = json.loads(catalog_path.read_text(encoding="utf-8"))
        for item in source.get("skills", []):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            if definition.get("status") != "ready":
                continue
            hints = (item.get("metadata") or {}).get("hints")
            if not (isinstance(hints, list) and len(hints) == 3
                    and all(isinstance(h, str) and h.strip() for h in hints)):
                missing.append(f"{sid}/{item['id']}")
    check("все ready-предметы: у каждой темы три подсказки", not missing, ";".join(missing))

    # Клиент читает ровно skill.metadata.hints (см. topicHintLevels в js/app.js).
    client_reads = 'skill.metadata.hints' in (ROOT / "js" / "app.js").read_text(encoding="utf-8")
    check("клиент читает тот же путь, что проверяет гейт", client_reads)

    print(f"{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
