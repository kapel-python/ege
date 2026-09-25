# Subject Contract

Один файл `server/subjects/<id>.json` на предмет. Имя файла обязано совпадать
с `id`. Порядок показа в UI — поле `order`.

## Поля контракта

| Поле | Откуда реально используется |
|---|---|
| `id` | API (`?subject=`, `POST /api/subject`), `user_subjects`, `SUBJECT_IDS`. snake_case, навсегда |
| `title` / `short` | `/api/subjects`, каталог, статус, админка |
| `description` | `subjectInfo.description` в `/api/subjects` и bootstrap |
| `status` | `ready` \| `coming-soon` (синонимы `locked`/`disabled` тоже понимаются как закрытые) |
| `locked` / `comingSoon` | Guards записей (`423 Locked`), очистка прогресса locked-предмета |
| `availability` | Только для locked (`"coming-soon"`); у ready опускается (default = `status`) |
| `order` | Сортировка предметов (не отдаётся в API) |
| `catalogFile` | Какой `server/<файл>` грузит `install_catalog` |
| `level` | Строка `math_levels(id, subject_id, name)` для группировки каталога |
| `forecast` | `{weights, total, scale}` или `null`. Нет шкалы — `forecast: None`, как у русского |
| `features` | Capabilities: ровно 8 флагов `lessons/practice/forecast/diagnostics/missions/bosses/daily/path`. Locked-предмет: всё `false`, кроме `path: true` |
| `metadata` | Только если есть что хранить (сейчас — только у русского). Пустой у ready опускается |
| `content` | Указатели: `topics → catalog.categories/skills`, `preparationVariants → catalog.goals`, `onboarding → catalog.diagnosticTasks`. Реестр проверяет, что ключи есть в catalog-файле |

Чего здесь нет осознанно: `icon`/`color` — попредметных иконок/тем в UI нет
(только общие `lock`/`clock`/`layers`), поле ради красоты не добавляем.
Варианты подготовки (`goals[]`: `id/label/desc`) и онбординг-задачи
(`diagnosticTasks[]`) живут в catalog-файле предмета — это данные, а не
хардкод: шкала `g60/g80/g95` у профиля и `g3/g4/g5` у базы уже доказывают,
что движок читает их из конфига.

## Валидация

`subjects_registry.validate_definition` при старте проверяет: id-формат,
непустые строки, известный статус, существование catalog-файла и наличие
в нём `categories/skills/goals/diagnosticTasks`, форму прогноза
(`len(scale) == total+1`), ровно 8 capability-флагов. Битый контракт роняет
старт с понятной ошибкой, а не молча отдаёт чужой каталог.

## Fallback

Нет каталога `subjects/` на диске (минимальный деплой) — реестр собирается
из встроенных дефиниций (`_builtin_definitions`, побайтово те же значения),
сервер стартует как раньше. Файлы есть, но битые — старт падает громко.

## Как добавить четвёртый предмет (5 шагов, правок кода — ноль)

1. `server/subjects/informatics.json` — скопировать с `russian.json`
   (locked-скелет) или `basic_math.json` (ready), поменять `id/title/short/
   description/order/catalogFile/level/features/forecast`.
2. `server/catalog_informatics.json` — контент предмета. Для locked: пустые
   `tasks/lessons/missions/bosses/achievements`, `goals: []`,
   `diagnosticTasks: []`, `daily: {skill: "", target: 0, xp: 0, title: ""}`.
   Для ready: реальные `categories/skills` + `goals[]` (варианты подготовки)
   + `diagnosticTasks[]` (онбординг) + `daily`.
3. ID всех сущностей каталога — глобально уникальные (загрузчик запрещает
   переезд id между предметами). Ссылки `skill→topic`, `task→skill`,
   `mission.tasks→tasks`, `boss→cat` — только внутри своего предмета.
4. Перезапустить сервер. Предмет сам появится в `/api/subjects`, bootstrap,
   статусе, селекторе, Path, онбординге, админке — всё читает реестр.
5. Если предмет ввёл свои `goal id` — добавить одну строку в `GOAL_LABELS`
   (`js/admin.js:115`), иначе цель покажется сырым id (только отображение).

Перевод locked → ready: `status: "ready"`, `locked/comingSoon: false`,
настоящие `features/forecast`, реальный контент в catalog. Тестовый предмет
после проверки удалить вместе с его catalog-файлом.
