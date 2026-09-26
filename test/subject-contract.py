#!/usr/bin/env python3
"""Durable server-side subject contract and isolation regression.

The test boots the real handler on an ephemeral port with a temporary SQLite
file.  It never reads or writes the production database.
"""
from __future__ import annotations

import http.cookiejar
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = ROOT / "server"
SERVER_PATH = SERVER_DIR / "server.py"
SUBJECTS = ("profile_math", "basic_math", "russian")
CATALOG_FILES = {
    "profile_math": "catalog.json",
    "basic_math": "catalog_basic.json",
    "russian": "catalog_russian.json",
}
REQUIRED_FEATURES = frozenset(
    {"lessons", "practice", "forecast", "diagnostics", "missions", "bosses", "daily", "path"}
)
ENDPOINTS = (
    "/api/subjects",
    "/api/status",
    "/api/bootstrap",
    "/api/bootstrap-lite",
    "/api/catalog-tasks",
    "/api/catalog-lessons",
)

# These fields contain subject-owned instances (skill ids, visual status ids,
# subject metadata, or the optional forecast config), not response fields.
# Their *presence* is part of the API envelope; their per-subject entries are
# data and are covered by the isolation/ownership checks below.  Treating them
# as keyed maps keeps structural parity meaningful when one subject is
# legitimately empty.  Collections use their stable [] marker rather than the
# incidental optional fields of whichever task happens to sort first.
DYNAMIC_MAP_SUFFIXES = (
    ".achievements",
    ".activity",
    ".bossesDefeated",
    ".completedLessons",
    ".forecast",
    ".lessonSessions",
    ".lessonStepErrors",
    ".metadata",
    ".missionProgress",
    ".missionsDone",
    ".skillStats",
    ".visualAudit",
)
MATH_ID_RE = re.compile(r"^(?:n[012]|b[012])(?:[A-Za-z0-9_]*)")
FORBIDDEN_CONTENT_FIELDS = frozenset({"text", "answer", "solution", "steps"})


def load_server(db_path: Path):
    os.environ["EGE_DB_PATH"] = str(db_path)
    os.environ["EGE_DISABLE_SYSTEMD"] = "1"
    spec = importlib.util.spec_from_file_location("ege_subject_contract_test", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(opener, base: str, path: str):
    try:
        with opener.open(base + path, timeout=10) as response:
            body = json.loads(response.read() or b"{}")
            return response.status, body
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def make_device():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def endpoint_path(endpoint: str, subject: str) -> str:
    if endpoint in {"/api/subjects", "/api/status"}:
        return endpoint
    return f"{endpoint}?subject={subject}"


def key_paths(value: Any, path: str = "$") -> set[str]:
    """Return the stable API-envelope key paths for one response.

    Dictionaries recurse.  Lists use the explicitly allowed ``[]`` marker.
    Subject-keyed maps are structural leaves: comparing ``n01_*`` with ``b01_*``
    or comparing ``{}`` with populated state would compare data, not shape.
    """
    if isinstance(value, dict):
        paths = {path}
        for key, child in value.items():
            child_path = f"{path}.{key}"
            paths.add(child_path)
            if not child_path.endswith(DYNAMIC_MAP_SUFFIXES):
                paths.update(key_paths(child, child_path))
        return paths
    if isinstance(value, list):
        return {f"{path}[]"}
    return {path}


def scan_without_registry(value: Any, path: tuple[str, ...] = ()):
    """Yield (path, key, scalar) while excluding only catalog.subjects."""
    if path == ("catalog", "subjects"):
        return
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = path + (str(key),)
            yield child_path, str(key), child
            yield from scan_without_registry(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from scan_without_registry(child, path + (f"[{index}]",))
    else:
        yield path, "", value


def format_path(parts: tuple[str, ...]) -> str:
    return "$" + "".join(f".{part}" if not part.startswith("[") else part for part in parts)


def main() -> int:
    failures = 0
    checks = 0

    def check(name: str, condition: bool, detail: str = "") -> None:
        nonlocal failures, checks
        checks += 1
        if not condition:
            failures += 1
        suffix = f" | {detail}" if detail else ""
        print(f"{'PASS' if condition else 'FAIL'} {name}{suffix}")

    with tempfile.TemporaryDirectory(prefix="ege-subject-contract-") as tmp:
        server = load_server(Path(tmp) / "ege.sqlite3")
        conn = server.connect()
        try:
            server.install_catalog(conn)
        finally:
            conn.close()

        # Suppress the stdlib access log so this guard's PASS/FAIL output is
        # readable.  The handler still executes the same real HTTP requests.
        httpd = server.create_http_server("127.0.0.1", 0)
        httpd.RequestHandlerClass.log_message = lambda *_args, **_kwargs: None
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            opener = make_device()
            payloads: dict[tuple[str, str], dict] = {}
            for endpoint in ENDPOINTS:
                for subject in SUBJECTS:
                    status, body = request(opener, base, endpoint_path(endpoint, subject))
                    assert status == 200, (endpoint, subject, status, body)
                    assert isinstance(body, dict), (endpoint, subject, type(body).__name__)
                    payloads[(endpoint, subject)] = body

                shapes = {subject: key_paths(payloads[(endpoint, subject)]) for subject in SUBJECTS}
                reference = shapes["profile_math"]
                mismatches = []
                for subject in ("basic_math", "russian"):
                    missing = sorted(reference - shapes[subject])
                    extra = sorted(shapes[subject] - reference)
                    if missing or extra:
                        mismatches.append(
                            f"{subject}: missing={missing}; unexpected={extra}"
                        )
                check(
                    f"KEY-SHAPE PARITY {endpoint} ({len(reference)} paths)",
                    not mismatches,
                    "; ".join(mismatches),
                )

            contracts: dict[str, dict] = {}
            contract_errors: list[str] = []
            for path in sorted((SERVER_DIR / "subjects").glob("*.json")):
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                    contracts[path.stem] = raw
                except (OSError, ValueError) as exc:
                    contract_errors.append(f"{path.name}: {exc}")

            missing_subjects = sorted(set(SUBJECTS) - set(contracts))
            check(
                "CAPABILITY MATRIX subject coverage",
                not contract_errors and not missing_subjects,
                "; ".join(contract_errors + [f"missing={item}" for item in missing_subjects]),
            )

            expected_matrices = {
                "profile_math": {key: True for key in REQUIRED_FEATURES},
                "basic_math": {key: True for key in REQUIRED_FEATURES},
                "russian": {key: key in {"path", "practice"} for key in REQUIRED_FEATURES},
            }
            for subject, contract in sorted(contracts.items()):
                features = contract.get("features")
                exact = isinstance(features, dict) and set(features) == REQUIRED_FEATURES
                booleans = exact and all(type(features[key]) is bool for key in REQUIRED_FEATURES)
                expected = expected_matrices.get(subject)
                matrix_ok = booleans and (expected is None or features == expected)
                matrix = (
                    ",".join(f"{key}={str(features[key]).lower()}" for key in sorted(features))
                    if isinstance(features, dict)
                    else repr(features)
                )
                check(f"CAPABILITY MATRIX {subject}", matrix_ok, matrix)

            russian_tasks = payloads[("/api/catalog-tasks", "russian")]
            served_russian_tasks = russian_tasks.get("tasks") or []
            # Свободные темы (итоговое) и работа с текстом (задание 27): у
            # вторых обязан быть sourceTextId, у первых — не бывает.
            russian_re27 = [t for t in served_russian_tasks if t.get("skill") == "russian_essay_source"]
            check(
                "RUSSIAN CONTENT task details",
                len(served_russian_tasks) == 8
                and len(russian_re27) == 8
                and all(t.get("type") == "long_text" for t in served_russian_tasks)
                and all(t.get("sourceTextId") for t in russian_re27)
                and russian_tasks.get("visualAssets") == []
                and isinstance(russian_tasks.get("visualAudit"), dict),
                f"tasks={len(served_russian_tasks)} (re27={len(russian_re27)}), "
                f"visualAssets={len(russian_tasks.get('visualAssets') or [])}, "
                f"visualAudit={type(russian_tasks.get('visualAudit')).__name__}",
            )

            russian_lessons = payloads[("/api/catalog-lessons", "russian")]
            check(
                "RUSSIAN CONTENT lesson details (no lessons yet)",
                russian_lessons.get("lessons") == [],
                f"lessons={len(russian_lessons.get('lessons') or [])}",
            )

            russian_boot = payloads[("/api/bootstrap", "russian")]
            russian_catalog = russian_boot.get("catalog") or {}
            russian_missions = russian_catalog.get("missions") or []
            empty_catalog_keys = ("lessons", "bosses", "achievements", "goals", "diagnosticTasks")
            catalog_shape_ok = (
                russian_catalog.get("forecast") is None
                and all(russian_catalog.get(key) == [] for key in empty_catalog_keys)
                and len(russian_catalog.get("tasks") or []) == 8
                and russian_missions == []
                and isinstance(russian_catalog.get("daily"), dict)
                and (russian_catalog.get("daily") or {}).get("target") == 0
            )
            check(
                "RUSSIAN CONTENT bootstrap catalog",
                catalog_shape_ok,
                f"forecast={russian_catalog.get('forecast')!r}, "
                f"tasks={len(russian_catalog.get('tasks') or [])}, missions={len(russian_missions)}",
            )

            russian_state = russian_boot.get("state") or {}
            empty_daily = {"date": None, "solved": 0, "done": False, "taskIds": []}
            skill_stats = russian_state.get("skillStats") or {}
            zero_bucket = {"progress": 0, "solved": 0, "correct": 0, "timeSec": 0}
            state_isolated = (
                set(skill_stats) == {"russian_essay_source"}
                and all(v == zero_bucket for v in skill_stats.values())
                and russian_state.get("achievements") == {}
                and russian_state.get("forecastHistory") == []
                and russian_state.get("diagnostics") == []
                and russian_state.get("taskAttempts") == []
                and russian_state.get("errors") == []
                and russian_state.get("xp") == 0
                and russian_state.get("daily") == empty_daily
            )
            check(
                "RUSSIAN ISOLATION bootstrap state",
                state_isolated,
                "skillStats=zero bucket for russian_essay_source only, achievements={}, histories/attempts/errors=[], xp=0, daily=[]",
            )

            scanned_russian = list(scan_without_registry(russian_boot))
            math_identifiers = sorted(
                {
                    scalar
                    for _path, key, scalar in scanned_russian
                    if isinstance(scalar, str)
                    and MATH_ID_RE.match(scalar if not key else key)
                }
            )
            check(
                "RUSSIAN ISOLATION math identifiers",
                not math_identifiers,
                f"matches={math_identifiers or 'none'}; registry excluded",
            )

            forbidden_paths = sorted(
                {
                    format_path(path + (key,))
                    for path, key, _scalar in scanned_russian
                    if key in FORBIDDEN_CONTENT_FIELDS
                }
            )
            # Открытый предмет честно отдаёт тексты своих заданий: поля
            # text/answer/solution допустимы ТОЛЬКО внутри catalog.tasks, а
            # поля steps (шаги уроков) не должны встречаться нигде.
            content_fields_in_tasks = {p for p in forbidden_paths if p.startswith("$.catalog.tasks[")}
            steps_paths = [p for p in forbidden_paths if p.endswith(".steps")]
            check(
                "RUSSIAN CONTENT task content fields",
                forbidden_paths == sorted(content_fields_in_tasks) and not steps_paths,
                f"text/answer/solution/steps={forbidden_paths or 'none'}; registry excluded",
            )

            skill_sets = {
                subject: {
                    str(skill.get("id"))
                    for skill in (payloads[("/api/bootstrap", subject)].get("catalog") or {}).get("skills", [])
                    if isinstance(skill, dict) and skill.get("id") is not None
                }
                for subject in ("profile_math", "basic_math")
            }
            prefixes = {"profile_math": "n", "basic_math": "b"}
            ownership_ok = True
            ownership_evidence = []
            for subject, skill_ids in skill_sets.items():
                catalog = payloads[("/api/bootstrap", subject)].get("catalog") or {}
                weights = (catalog.get("forecast") or {}).get("weights") or {}
                foreign_ids = set(
                    skill_sets["basic_math"] if subject == "profile_math" else skill_sets["profile_math"]
                )
                foreign_ids.add("russian_essay")
                leaks = sorted(
                    {
                        scalar
                        for path, _key, scalar in scan_without_registry(payloads[("/api/bootstrap", subject)])
                        if isinstance(scalar, str) and scalar in foreign_ids
                    }
                )
                subject_ok = (
                    bool(skill_ids)
                    and catalog.get("subject") == subject
                    and all(skill_id.startswith(prefixes[subject]) for skill_id in skill_ids)
                    and not (skill_ids & foreign_ids)
                    and isinstance(weights, dict)
                    and bool(weights)
                    and set(weights).issubset(skill_ids)
                    and not leaks
                )
                ownership_ok = ownership_ok and subject_ok
                ownership_evidence.append(
                    f"{subject}: skills={len(skill_ids)} ({prefixes[subject]}*), "
                    f"weights={len(weights)} owned, foreign={leaks or 'none'}"
                )
            check("NO CROSS-SUBJECT LEAK content ownership", ownership_ok, "; ".join(ownership_evidence))

            # Visual payloads are subject data too.  Read the same catalog files
            # that install_catalog() uses, then compare both full-payload routes
            # by id membership rather than by collection size.
            source_asset_ids: dict[str, set[str]] = {}
            source_entity_ids: dict[str, set[str]] = {}
            source_audit_ids: dict[str, set[str]] = {}
            visual_source_errors: list[str] = []
            for subject, filename in CATALOG_FILES.items():
                try:
                    source = json.loads((SERVER_DIR / filename).read_text(encoding="utf-8"))
                    if not isinstance(source, dict):
                        raise ValueError("catalog root is not an object")
                    assets = source.get("visualAssets", [])
                    tasks = source.get("tasks", [])
                    skills = source.get("skills", [])
                    audit = source.get("visualAudit", {})
                    valid_assets = isinstance(assets, list) and all(
                        isinstance(item, dict) and isinstance(item.get("id"), str)
                        for item in assets
                    )
                    valid_entities = (
                        isinstance(tasks, list)
                        and isinstance(skills, list)
                        and all(
                            isinstance(item, dict) and isinstance(item.get("id"), str)
                            for item in tasks + skills
                        )
                    )
                    statuses = audit.get("taskStatuses", {}) if isinstance(audit, dict) else None
                    valid_audit = isinstance(audit, dict) and isinstance(statuses, dict)
                    if not (valid_assets and valid_entities and valid_audit):
                        raise ValueError("invalid visual ownership fields")
                    source_asset_ids[subject] = {item["id"] for item in assets}
                    source_entity_ids[subject] = {item["id"] for item in tasks + skills}
                    source_audit_ids[subject] = set(statuses)
                except (OSError, TypeError, ValueError) as exc:
                    visual_source_errors.append(f"{filename}: {exc}")
                    source_asset_ids[subject] = set()
                    source_entity_ids[subject] = set()
                    source_audit_ids[subject] = set()

            # Do not subtract the local set here: a copied foreign id must not
            # become self-authorizing merely because it was repeated locally.
            foreign_asset_ids = {
                subject: {
                    asset_id
                    for other, ids in source_asset_ids.items()
                    if other != subject
                    for asset_id in ids
                }
                for subject in SUBJECTS
            }
            foreign_entity_ids = {
                subject: {
                    entity_id
                    for other, ids in source_entity_ids.items()
                    if other != subject
                    for entity_id in ids
                }
                for subject in SUBJECTS
            }

            visual_ownership_ok = not visual_source_errors
            visual_evidence: list[str] = []
            for subject in SUBJECTS:
                own_assets = source_asset_ids[subject]
                own_entities = source_entity_ids[subject]
                subject_ok = True
                russian_mask_ok = True
                subject_evidence: list[str] = []
                for endpoint in ("/api/catalog-tasks", "/api/bootstrap"):
                    payload = payloads[(endpoint, subject)]
                    if endpoint == "/api/catalog-tasks":
                        served_assets_value = payload.get("visualAssets")
                        served_audit = payload.get("visualAudit")
                    else:
                        bootstrap_catalog = payload.get("catalog")
                        served_assets_value = (
                            bootstrap_catalog.get("visualAssets")
                            if isinstance(bootstrap_catalog, dict)
                            else None
                        )
                        served_audit = (
                            bootstrap_catalog.get("visualAudit")
                            if isinstance(bootstrap_catalog, dict)
                            else None
                        )

                    assets_well_formed = isinstance(served_assets_value, list) and all(
                        isinstance(item, dict) and isinstance(item.get("id"), str)
                        for item in served_assets_value
                    )
                    statuses = served_audit.get("taskStatuses", {}) if isinstance(served_audit, dict) else None
                    audit_well_formed = isinstance(served_audit, dict) and isinstance(statuses, dict)
                    served_asset_ids = (
                        {item["id"] for item in served_assets_value}
                        if assets_well_formed
                        else set()
                    )
                    served_audit_ids = set(statuses) if audit_well_formed else set()

                    unowned_assets = served_asset_ids - own_assets
                    foreign_only_assets = served_asset_ids & (foreign_asset_ids[subject] - own_assets)
                    cross_subject_assets = served_asset_ids & foreign_asset_ids[subject]
                    unowned_audit = served_audit_ids - own_entities
                    foreign_only_audit = served_audit_ids & (foreign_entity_ids[subject] - own_entities)
                    cross_subject_audit = served_audit_ids & foreign_entity_ids[subject]
                    endpoint_ok = (
                        assets_well_formed
                        and audit_well_formed
                        and not unowned_assets
                        and not foreign_only_assets
                        and not cross_subject_assets
                        and not unowned_audit
                        and not foreign_only_audit
                        and not cross_subject_audit
                    )
                    if subject == "russian":
                        mask_ok = served_assets_value == [] and not served_audit_ids
                        russian_mask_ok = russian_mask_ok and mask_ok
                        endpoint_ok = endpoint_ok and mask_ok
                    subject_ok = subject_ok and endpoint_ok
                    label = endpoint.rsplit("/", 1)[-1]
                    subject_evidence.append(
                        f"{label}: assets[not-owned={sorted(unowned_assets) or 'none'}, "
                        f"foreign={sorted(cross_subject_assets) or 'none'}]; "
                        f"audit[not-owned={sorted(unowned_audit) or 'none'}, "
                        f"foreign={sorted(cross_subject_audit) or 'none'}]"
                    )

                source_foreign_assets = sorted(source_asset_ids[subject] & foreign_asset_ids[subject])
                source_foreign_audit = sorted(source_audit_ids[subject] & foreign_entity_ids[subject])
                if source_foreign_assets:
                    subject_evidence.append(f"catalog-foreign-assets={source_foreign_assets}")
                if source_foreign_audit:
                    subject_evidence.append(f"catalog-foreign-audit={source_foreign_audit}")
                if subject == "russian":
                    subject_evidence.append(
                        f"locked-mask={'verified' if russian_mask_ok else 'FAILED'}"
                    )
                visual_evidence.append(f"{subject}: " + "; ".join(subject_evidence))
                visual_ownership_ok = visual_ownership_ok and subject_ok

            check(
                "NO CROSS-SUBJECT LEAK visual ownership",
                visual_ownership_ok,
                "; ".join(visual_source_errors + visual_evidence),
            )

            registry_errors = list(contract_errors)
            for path in sorted((SERVER_DIR / "subjects").glob("*.json")):
                try:
                    contract = json.loads(path.read_text(encoding="utf-8"))
                    subject = contract.get("id")
                    if subject != path.stem:
                        registry_errors.append(f"{path.name}: id={subject!r}")
                    catalog_file = contract.get("catalogFile")
                    if not isinstance(catalog_file, str) or not catalog_file.strip():
                        registry_errors.append(f"{path.name}: invalid catalogFile")
                        continue
                    catalog_path = SERVER_DIR / catalog_file
                    if not catalog_path.is_file():
                        registry_errors.append(f"{path.name}: missing {catalog_file}")
                        continue
                    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
                    for field in ("subject", "subjectId"):
                        if field in catalog and catalog[field] != subject:
                            registry_errors.append(
                                f"{catalog_path.name}: {field}={catalog[field]!r}, expected {subject!r}"
                            )
                except (OSError, ValueError) as exc:
                    registry_errors.append(f"{path.name}: {exc}")
            check(
                "REGISTRY CONSISTENCY ids/catalog ownership",
                not registry_errors and bool(contracts),
                "; ".join(registry_errors) or f"contracts={len(contracts)}, all declarations valid",
            )
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
            assert not thread.is_alive(), "temporary HTTP server thread did not stop"

    print(f"{'ALL OK' if not failures else str(failures) + ' FAILURES'}: {checks} checks")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
