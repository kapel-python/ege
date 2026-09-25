# Subject Contract

Один файл `server/subjects/<id>.json` на предмет. Рекомендуемое имя —
`<id>.json`; если имя файла не совпадает с `id`, загрузчик добавляет только
warning и продолжает работу. Порядок показа в UI — поле `order`.

## Поля контракта

| Поле | Откуда реально используется |
|---|---|
| `id` | API (`?subject=`, `POST /api/subject`), `user_subjects`, `SUBJECT_IDS`. snake_case, навсегда |
| `title` / `short` | `/api/subjects`, каталог, статус, админка |
| `description` | `subjectInfo.description` в `/api/subjects` и bootstrap |
| `status` | `ready` \| `coming-soon` (синонимы `locked`/`disabled` тоже понимаются как закрытые) |
| `locked` / `comingSoon` | Guards записей (`423 Locked`), очистка прогресса locked-предмета |
| `availability` | Необязательное значение; обычно строка `coming-soon` у locked, у ready его можно опустить (default = `status`). Значение приводится к строке, но семантическая согласованность не проверяется |
| `order` | Сортировка предметов (не отдаётся в API) |
| `catalogFile` | Обычно bare basename вроде `catalog_informatics.json`; реестр соединяет `server_dir / catalogFile`, поэтому префикс `server/` в JSON не нужен |
| `level` | Объект `{id, subjectId, name}` для строки `math_levels(id, subject_id, name)`; проверяются непустые строки, но не уникальность или смысл связей |
| `forecast` | `{weights, total, scale}` или JSON `null`. Нет шкалы — `forecast: null`, как у русского; проверяется только форма объекта |
| `features` | Capabilities: ровно 8 boolean-флагов `lessons/practice/forecast/diagnostics/missions/bosses/daily/path`. Для locked обычно `false` везде, кроме `path: true`, но это соглашение, а не проверка registry |
| `metadata` | Необязательный объект; любой dict принимается, схема и семантика не валидируются |
| `content` | Указатели: `topics → catalog.categories/skills`, `preparationVariants → catalog.goals`, `onboarding → catalog.diagnosticTasks`. Реестр проверяет форму указателей и наличие ключей в catalog-файле |

Чего здесь нет осознанно: `icon`/`color` — попредметных иконок/тем в UI нет
(только общие `lock`/`clock`/`layers`), поле ради красоты не добавляем.
Варианты подготовки (`goals[]`: `id/label/desc`) и онбординг-задачи
(`diagnosticTasks[]`) живут в catalog-файле предмета — это данные, а не
хардкод: шкала `g60/g80/g95` у профиля и `g3/g4/g5` у базы уже доказывают,
что движок читает их из конфига.

## Валидация

`subjects_registry.validate_definition` при старте проверяет структуру:
id-формат, непустые строки, известный статус, типы `order`/`locked`/
`comingSoon`, непустой `catalogFile` и читаемый JSON-объект каталога,
непустые строки `level`, форму `forecast` (`weights` — непустой объект,
`total` — положительное целое, `len(scale) == total+1`), ровно 8
boolean-`features`, форму `content`-указателей и наличие указанных в них
ключей (`categories/skills/goals/diagnosticTasks`). `metadata` проверяется
только как объект. `load_definitions` также отклоняет повторяющиеся
subject-id и отсутствие default subject.

Это не семантический валидатор. В частности, registry не проверяет
уникальность `level.id`, согласованность `status`/`locked`/`availability`
с `features`, схему или смысл `metadata`, покрытие навыков и корректность
значений `forecast.weights`, числовой диапазон/монотонность `scale`,
а также содержимое `goals` и `diagnosticTasks`. Невалидные ссылки внутри
каталога (skill→topic, task/lesson/mission→skill, mission.tasks→tasks,
boss→topic) ловятся отдельно при `install_catalog`; `daily.skill` и
`diagnosticTasks` фильтруются при построении payload. Битый найденный
контракт роняет старт с понятной ошибкой, а не молча отдаёт чужой каталог.

## Fallback

Если в `server/subjects/` не найден ни один `*.json` (каталог отсутствует
или пуст), `_builtin_definitions()` в `server/subjects_registry.py`
подставляет встроенные определения — это единственный fallback, и он не
находится в `server.py`. Если сам модуль реестра нельзя загрузить,
`server.py` завершает startup с `RuntimeError`; второй набор subject-данных
не создаётся. Если файлы есть, но битые, загрузка падает с
`SubjectContractError`.

## Как добавить четвёртый предмет (5 шагов, правок кода — ноль)

1. `server/subjects/informatics.json` — скопировать с `russian.json`
   (locked-скелет) или `basic_math.json` (ready), поменять `id/title/short/
   description/order/catalogFile/level/features/forecast`. Имя файла
   `<id>.json` рекомендуется, но несовпадение имени и `id` — warning.
2. `server/catalog_informatics.json` — контент предмета. Для locked: пустые
   `tasks/lessons/missions/bosses/achievements`, `goals: []`,
   `diagnosticTasks: []`, `daily: {skill: "", target: 0, xp: 0, title: ""}`.
   Для ready: реальные `categories/skills` + `goals[]` (варианты подготовки)
   + `diagnosticTasks[]` (онбординг) + `daily`.
3. Не давать существующему id одной сущности переехать к другому предмету:
   загрузчик проверяет ownership для поддерживаемых связей
   (`skill→topic`, `task/lesson/mission→skill`, `mission.tasks→tasks`,
   `boss→cat`). Уникальность между типами сущностей, дубли внутри одного
   каталога и семантика `goals`/`daily`/`diagnosticTasks` не проверяются
   автоматически.
4. Перезапустить сервер. Предмет сам появится в `/api/subjects`, bootstrap,
   статусе, селекторе, Path, онбординге, админке — всё читает реестр.
5. Если предмет ввёл свои `goal id` — добавить одну строку в `GOAL_LABELS`
   в `js/admin.js`, иначе цель покажется сырым id (только отображение).

Перевод locked → ready: `status: "ready"`, `locked/comingSoon: false`,
настоящие `features/forecast`, реальный контент в catalog. Не редактируй
генерируемый `SUBJECTS`: он собирается из JSON-реестра. Тестовый предмет
после проверки удалить вместе с его catalog-файлом.
