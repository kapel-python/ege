"""Единый реестр предметов (Subject Registry).

Канонический Subject Contract живёт в ``server/subjects/<id>.json``:
один файл на предмет описывает и реестр (id/title/short/status/features),
и загрузчик (catalogFile/level/forecast). ``server/server.py`` импортирует
этот модуль и строит из него ``SUBJECTS``/``SUBJECT_IDS``/пути каталогов,
поэтому новый предмет — это новый JSON + его catalog, а не правки в пяти
местах ``server.py``.

Обратная совместимость: если каталог ``subjects/`` недоступен или пуст,
реестр собирается из встроенных дефиниций (побайтово те же значения, что
раньше лежали инлайн в ``server.py``), и сервер стартует как раньше.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

CONTRACT_VERSION = 1

DEFAULT_SUBJECT = "profile_math"

# Единственный допустимый набор capability-флагов. Расширять только вместе
# с фронтендом (DataAPI.subjectFeature) и бэкендом (_public_subject_info).
REQUIRED_FEATURES = ("lessons", "practice", "forecast", "diagnostics",
                     "missions", "bosses", "daily", "path")

_READY_STATUSES = {"ready"}
_KNOWN_STATUSES = {"ready", "coming-soon", "locked", "disabled", "unavailable"}

_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class SubjectContractError(ValueError):
    """Некорректный subjects/<id>.json: сервер не стартует с битым реестром."""


def _builtin_definitions() -> dict:
    """Побайтовые копии значений, раньше лежавших инлайн в server.py.

    Используются только как fallback, если subjects/*.json недоступны.
    """
    profile_weights = {
        "n01_planimetry": 1, "n02_vectors": 1, "n03_stereometry": 1, "n04_probability": 1,
        "n05_prob_theorems": 1, "n06_random_var": 1, "n07_equations": 1, "n08_expressions": 1,
        "n09_derivative": 1, "n10_applied": 1, "n11_word_problems": 1, "n12_functions": 1,
        "n14_trig_eq": 2, "n15_stereometry": 3, "n13_financial": 2, "n18_planimetry": 2,
        "n16_inequality": 3, "n17_optimization": 4, "n19_parameter": 2, "n20_numbers": 2,
    }
    profile_scale = [
        0, 6, 12, 17, 22, 27, 34, 40, 46, 52, 58, 64, 70, 72, 74, 76, 78,
        80, 82, 84, 86, 88, 90, 92, 94, 95, 96, 97, 98, 99, 100, 100, 100,
    ]
    basic_weights = {
        "b01_wordcalc": 1, "b02_units": 1, "b03_tables": 1, "b04_formulas": 1,
        "b05_probability": 1, "b06_choice": 1, "b07_functions": 1, "b08_logic": 1,
        "b09_grid": 1, "b10_practplan": 1, "b11_practstereo": 1, "b12_planimetry": 1,
        "b13_stereometry": 1, "b14_fractions": 1, "b15_percent": 1, "b16_expressions": 1,
        "b17_equations": 1, "b18_inequalities": 1, "b19_integers": 1,
        "b20_wordprob": 1, "b21_nonstandard": 1,
    }
    full_features = {key: True for key in REQUIRED_FEATURES}
    locked_features = {key: (key == "path") for key in REQUIRED_FEATURES}
    content_refs = {
        "topics": {"source": "catalog", "keys": ["categories", "skills"]},
        "preparationVariants": {"source": "catalog", "key": "goals"},
        "onboarding": {"source": "catalog", "key": "diagnosticTasks"},
    }
    return {
        "profile_math": {
            "id": "profile_math", "title": "Профильная математика", "short": "Профиль",
            "description": "Профильная математика (ЕГЭ): полный курс с уроками, практикой, диагностикой и прогнозом баллов.",
            "status": "ready", "locked": False, "comingSoon": False, "order": 0,
            "catalogFile": "catalog.json",
            "level": {"id": "profile", "subjectId": "math", "name": "Профильный уровень"},
            "forecast": {"weights": profile_weights, "total": 32, "scale": profile_scale},
            "features": dict(full_features),
            "content": {key: dict(value) for key, value in content_refs.items()},
        },
        "basic_math": {
            "id": "basic_math", "title": "Базовая математика", "short": "База",
            "description": "Базовая математика (ЕГЭ): полный курс с уроками, практикой, диагностикой и прогнозом оценки.",
            "status": "ready", "locked": False, "comingSoon": False, "order": 1,
            "catalogFile": "catalog_basic.json",
            "level": {"id": "basic", "subjectId": "math", "name": "Базовый уровень"},
            "forecast": {"weights": basic_weights, "total": 21,
                         "scale": list(range(22))},
            "features": dict(full_features),
            "content": {key: dict(value) for key, value in content_refs.items()},
        },
        "russian": {
            "id": "russian", "title": "Русский язык", "short": "Русский",
            "description": "Первый раздел русского языка готовится к публикации.",
            "status": "coming-soon", "locked": True, "comingSoon": True,
            "availability": "coming-soon", "order": 2,
            "catalogFile": "catalog_russian.json",
            "level": {"id": "russian", "subjectId": "russian", "name": "Русский язык"},
            "forecast": None,
            "features": dict(locked_features),
            "metadata": {"availability": "coming-soon", "locked": True,
                         "topic": "Итоговое сочинение", "topicCount": 1},
            "content": {key: dict(value) for key, value in content_refs.items()},
        },
    }


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SubjectContractError(f"subject contract not found: {path}")
    except (OSError, ValueError) as exc:
        raise SubjectContractError(f"subject contract unreadable {path}: {exc}")


def validate_definition(raw: dict, *, source: str, server_dir: Path) -> dict:
    """Проверить один subjects/<id>.json и вернуть нормализованную дефиницию."""
    if not isinstance(raw, dict):
        raise SubjectContractError(f"{source}: contract must be a JSON object")
    sid = raw.get("id")
    if not isinstance(sid, str) or not _ID_RE.match(sid):
        raise SubjectContractError(f"{source}: bad id {sid!r} (snake_case required)")
    for key in ("title", "short", "description"):
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip():
            raise SubjectContractError(f"{source} ({sid}): {key} must be a non-empty string")
    status = str(raw.get("status", "ready")).strip().lower().replace("_", "-")
    if status == "comingsoon":
        status = "coming-soon"
    if status not in _KNOWN_STATUSES:
        raise SubjectContractError(f"{source} ({sid}): unknown status {status!r}")
    for key in ("locked", "comingSoon"):
        if key in raw and not isinstance(raw[key], bool):
            raise SubjectContractError(f"{source} ({sid}): {key} must be boolean")
    order = raw.get("order", 0)
    if not isinstance(order, int):
        raise SubjectContractError(f"{source} ({sid}): order must be int")
    catalog_file = raw.get("catalogFile")
    if not isinstance(catalog_file, str) or not catalog_file.strip():
        raise SubjectContractError(f"{source} ({sid}): catalogFile must be a filename")
    catalog_path = server_dir / catalog_file.strip()
    catalog = _read_json(catalog_path)
    if not isinstance(catalog, dict):
        raise SubjectContractError(f"{source} ({sid}): catalog {catalog_file} must be a JSON object")
    level = raw.get("level")
    if not isinstance(level, dict):
        raise SubjectContractError(f"{source} ({sid}): level must be an object")
    for key in ("id", "subjectId", "name"):
        if not isinstance(level.get(key), str) or not level[key].strip():
            raise SubjectContractError(f"{source} ({sid}): level.{key} must be a non-empty string")
    forecast = raw.get("forecast")
    if forecast is not None:
        if not isinstance(forecast, dict):
            raise SubjectContractError(f"{source} ({sid}): forecast must be an object or null")
        weights = forecast.get("weights")
        total = forecast.get("total")
        scale = forecast.get("scale")
        if not isinstance(weights, dict) or not weights:
            raise SubjectContractError(f"{source} ({sid}): forecast.weights must be a non-empty object")
        if not isinstance(total, int) or total <= 0:
            raise SubjectContractError(f"{source} ({sid}): forecast.total must be a positive int")
        if not isinstance(scale, list) or len(scale) != total + 1:
            raise SubjectContractError(
                f"{source} ({sid}): forecast.scale must be a list of total+1 numbers")
    features = raw.get("features")
    if not isinstance(features, dict) or set(features) != set(REQUIRED_FEATURES):
        raise SubjectContractError(
            f"{source} ({sid}): features must define exactly {sorted(REQUIRED_FEATURES)}")
    if not all(isinstance(features[key], bool) for key in REQUIRED_FEATURES):
        raise SubjectContractError(f"{source} ({sid}): every feature flag must be boolean")
    content = raw.get("content")
    if not isinstance(content, dict):
        raise SubjectContractError(f"{source} ({sid}): content pointers must be an object")
    for pointer, keys in (("preparationVariants", ("goals",)),
                          ("onboarding", ("diagnosticTasks",)),
                          ("topics", ("categories", "skills"))):
        ref = content.get(pointer)
        if not isinstance(ref, dict) or ref.get("source") != "catalog":
            raise SubjectContractError(
                f"{source} ({sid}): content.{pointer} must point at the subject catalog")
        expected = (ref.get("key"),) if "key" in ref else tuple(ref.get("keys", ()))
        if tuple(expected) != keys:
            raise SubjectContractError(
                f"{source} ({sid}): content.{pointer} must reference {list(keys)}")
        for key in keys:
            if key not in catalog:
                raise SubjectContractError(
                    f"{source} ({sid}): catalog {catalog_file} is missing {key!r}")
    metadata = raw.get("metadata", {})
    if not isinstance(metadata, dict):
        raise SubjectContractError(f"{source} ({sid}): metadata must be an object")
    definition = {
        "id": sid, "title": raw["title"].strip(), "short": raw["short"].strip(),
        "description": raw["description"].strip(), "status": status,
        "locked": bool(raw.get("locked", False)),
        "comingSoon": bool(raw.get("comingSoon", False)),
        "order": order, "catalogFile": catalog_file.strip(),
        "level": {"id": level["id"].strip(), "subjectId": level["subjectId"].strip(),
                  "name": level["name"].strip()},
        "forecast": forecast, "features": {key: bool(features[key]) for key in REQUIRED_FEATURES},
        "metadata": dict(metadata),
        "content": {"topics": {"source": "catalog", "keys": ["categories", "skills"]},
                    "preparationVariants": {"source": "catalog", "key": "goals"},
                    "onboarding": {"source": "catalog", "key": "diagnosticTasks"}},
    }
    if "availability" in raw:
        definition["availability"] = str(raw["availability"]).strip()
    return definition


def discover_definition_files(subjects_dir: Path) -> list[Path]:
    if not subjects_dir.is_dir():
        return []
    return sorted(subjects_dir.glob("*.json"))


def load_definitions(*, server_dir: Path | None = None) -> tuple[dict, list[str], bool]:
    """Загрузить все дефиниции. Возвращает (definitions, warnings, from_files).

    ``from_files`` False означает fallback на встроенные дефиниции.
    """
    root = Path(server_dir) if server_dir is not None else Path(__file__).resolve().parent
    subjects_dir = root / "subjects"
    files = discover_definition_files(subjects_dir)
    warnings: list[str] = []
    if not files:
        warnings.append(f"subjects/ is empty or missing at {subjects_dir}; using built-in registry")
        return _builtin_definitions(), warnings, False
    definitions: dict[str, dict] = {}
    for path in files:
        raw = _read_json(path)
        if not isinstance(raw, dict):
            raise SubjectContractError(f"{path.name}: contract must be a JSON object")
        if path.stem != str(raw.get("id", "")):
            warnings.append(f"{path.name}: filename does not match id {raw.get('id')!r}")
        definition = validate_definition(raw, source=path.name, server_dir=root)
        sid = definition["id"]
        if sid in definitions:
            raise SubjectContractError(f"duplicate subject id: {sid}")
        definitions[sid] = definition
    if DEFAULT_SUBJECT not in definitions:
        raise SubjectContractError(
            f"default subject {DEFAULT_SUBJECT!r} is missing from subjects/")
    ordered = dict(sorted(definitions.items(), key=lambda item: (item[1]["order"], item[0])))
    return ordered, warnings, True


def to_compat_subjects(definitions: dict) -> dict:
    """Сжать дефиниции до формата, который ожидает остальной server.py/API.

    Загрузочные ключи (order/catalogFile/level/content) отбрасываются здесь —
    их потребляют source_files/math_levels/cache-key через accessors ниже.
    Поле description отдаётся в subjectInfo как часть контракта.
    """
    subjects: dict[str, dict] = {}
    for sid, definition in definitions.items():
        entry: dict = {
            "id": sid, "title": definition["title"], "short": definition["short"],
            "description": definition.get("description", ""),
            "status": definition.get("status", "ready"),
            "locked": bool(definition.get("locked", False)),
            "comingSoon": bool(definition.get("comingSoon", False)),
            "forecast": definition.get("forecast"),
            "features": dict(definition.get("features", {})),
        }
        if "availability" in definition:
            entry["availability"] = definition["availability"]
        if definition.get("metadata"):
            entry["metadata"] = dict(definition["metadata"])
        subjects[sid] = entry
    return subjects


class SubjectRegistry:
    """Всё, что server.py раньше держал в 5 захардкоженных местах."""

    def __init__(self, *, server_dir: Path | None = None):
        root = Path(server_dir) if server_dir is not None else Path(__file__).resolve().parent
        self.server_dir = root
        self.definitions, self.warnings, self.from_files = load_definitions(server_dir=root)
        self.subjects = to_compat_subjects(self.definitions)
        self.ids = tuple(self.definitions.keys())
        self.default = DEFAULT_SUBJECT

    def catalog_path(self, subject: str) -> Path:
        return self.server_dir / self.definitions[subject]["catalogFile"]

    def catalog_paths(self) -> list[Path]:
        return [self.catalog_path(sid) for sid in self.ids]

    def source_files(self) -> tuple:
        """Кортеж (path, subject, level_id) для install_catalog."""
        return tuple((self.catalog_path(sid), sid, self.definitions[sid]["level"]["id"])
                     for sid in self.ids)

    def level_rows(self) -> list[tuple]:
        """Строки math_levels(id, subject_id, name)."""
        return [(definition["level"]["id"], definition["level"]["subjectId"],
                 definition["level"]["name"]) for definition in self.definitions.values()]

    def forecast_of(self, subject: str):
        return self.definitions[subject].get("forecast")


def load_registry(*, server_dir: Path | None = None) -> SubjectRegistry:
    return SubjectRegistry(server_dir=server_dir)
