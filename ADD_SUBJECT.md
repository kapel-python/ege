# Как добавить новый предмет

Пошаговая инструкция: что нужно, чтобы предмет появился как остальные
(профиль/база/русский) и осталось «только заполнить его заданиями».
Архитектура registry-driven: новый предмет — это **запись в реестре +
декларативный каталог**, а не ветвления `if subject` по коду.

Эталон минимального ready-предмета с одной темой: `russian`
(`server/subjects/russian.json`, `server/catalog_russian.json`) —
открыта практика итогового сочинения без уроков и прогноза.
Эталон полноценных ready-предметов: `profile_math`, `basic_math`.

## 0. Договорённости

- Канонический `id` — snake_case, единожды и навсегда. Он используется
  в API (`?subject=`, `POST /api/subject`), `user_subjects`/`state`,
  каталоге и тестах. Переименование потом — миграция данных.
- Загрузчик не даёт уже существующему id одной сущности молча переехать
  к другому предмету (`_assert_catalog_owner` и связанные проверки
  владельца в `server/server.py`). Это не отдельная проверка уникальности
  id между разными типами сущностей или дублей внутри одного каталога.
- Перед записью каталога проверяются только ссылки, для которых есть
  ownership-проверка: skill→topic, task/lesson/mission→skill,
  mission.tasks→tasks и boss→topic (`_assert_catalog_reference` в
  `server/server.py`). Отсутствующая или чужая ссылка даёт `ValueError`
  при `install_catalog`. `daily.skill` и `diagnosticTasks` не являются
  частью этой проверки: payload затем нормализует/фильтрует их.
- Не добавлять ветвлений вида `if <новый_id>` в `js/` и `server.py`.
  Все системы читают конфиг через `subject_config()/resolve_subject()`
  (backend) и `DataAPI.subjects()/subjectInfo()` (frontend).
- Locked-предмет не получает выдуманных `0%`, `0 XP`, уровня, streak,
  прогноза и истории. Пустые массивы + `locked/coming-soon` — честно.

## 1. Backend: реестр `server/subjects/*.json` + `server/subjects_registry.py`

Контракт предмета — `server/subjects/<id>.json` (поля и валидация:
`server/subjects/README.md`). Реестр (`subjects_registry.SubjectRegistry`)
собирает из него `SUBJECTS`/`SUBJECT_IDS`, пути каталогов, `source_files`
и строки `math_levels`. `server.py` загружает этот модуль и строит из
него данные; в `server.py` больше нет ни inline-`SUBJECTS`, ни forecast
weights, ни per-subject catalog paths.
Единственный fallback — `_builtin_definitions()` внутри
`server/subjects_registry.py`: он используется, когда в `server/subjects/`
не найден ни один `*.json` (каталог отсутствует или пуст). Если сам
`server/subjects_registry.py` не удаётся загрузить, startup падает с
`RuntimeError`, а не запускает вторую копию данных; битые найденные
контракты дают `SubjectContractError`.

Проверка `validate_definition` — структурная: она проверяет форму полей,
известный статус, каталог, ровно восемь boolean-`features`, ссылки
`content` на наличие ключей и длину `scale`. Она не проверяет, например,
уникальность `level.id`, согласованность `status`/`locked`/`availability`
с `features`, схему или смысл `metadata`, покрытие навыков `forecast.weights`,
числовые значения и монотонность `scale`, а также содержимое `goals` и
`diagnosticTasks`. Эти ограничения нужно соблюдать самому разработчику;
невалидные ссылки каталога отдельно ловятся при `install_catalog`.

Чтобы добавить предмет:

1. Создать `server/subjects/<id>.json`. Рекомендуемое имя — `<id>.json`
   (сам `id` обязан быть snake_case); несовпадение имени файла и `id`
   даёт только warning, а не ошибку старта. Заполнить `title`, `short`,
   `description`, `status` (`ready` | `coming-soon`), `locked`/`comingSoon`,
   `order` (порядок в UI), `catalogFile` (например, `"catalog_informatics.json"`;
   реестр соединяет `server_dir / catalogFile`, поэтому префикс `server/`
   в JSON не нужен), `level: {id, subjectId, name}` (строка `math_levels`),
   `forecast` (объект `{weights, total, scale}` или `null` — нет шкалы;
   это JSON-значение `null`), `features` (ровно 8
   capability-флагов: `lessons`, `practice`, `forecast`, `diagnostics`,
   `missions`, `bosses`, `daily`, `path`; для locked-скелета обычно ставят
   все учебные `false`, а `path: true`, но реестр проверяет только форму
   и boolean-типы, а не согласованность с `status`/`locked`),
   `content`-указатели (`topics → categories/skills`, `preparationVariants
   → goals`, `onboarding → diagnosticTasks`). `availability` и `metadata`
   необязательны; их семантика и взаимная согласованность не валидируются.
   Для locked скопировать форму полей с любого действующего контракта
   (`server/subjects/russian.json` — пример минимального ready, поля те же).
2. Положить catalog в `server/` под basename из `catalogFile`: для locked —
   пустые `tasks/lessons/missions/bosses/achievements`, `goals: []`,
   `diagnosticTasks: []`, нулевой `daily`. Загрузчик проверяет владение
   уже существующими id и перечисленные в разделе 0 ссылки, но не является
   полной проверкой уникальности или семантики содержимого каталога.
3. Перезапустить сервер. Всё остальное (`INSERT subjects`, `math_levels`,
   `source_files`, пер-предметные ключи `daily/goals/diagnosticTasks/
   subjectMeta`, `_catalog_cache_key`, `contentUpdatedAt` в статусе)
   итерирует реестр — править `server.py` не нужно.

Битый найденный контракт роняет старт с `SubjectContractError`, а не отдаёт
чужой каталог. `description` контракта отдаётся в `subjectInfo.description`
(`/api/subjects`, bootstrap) — аддитивно, старые клиенты его игнорируют.

Больше ничего в backend менять не нужно: `/api/subjects`,
`/api/bootstrap`, `/api/bootstrap-lite`, `/api/catalog-tasks`,
`/api/catalog-lessons`, `/api/status`, `/api/subject`, доменные writes,
`423 Locked` для учебных записей locked-предмета, `PATCH /api/settings`
(разрешён и для locked), subject-aware admin (`users`, `user_detail`,
`update_profile`, `grant_xp`, `reset`) — всё generic.

## 2. Каталог: `server/catalog_<id>.json`

Скопировать структуру с `server/catalog_russian.json` (минимальный
ready-каталог: одна тема, практика без уроков)
и наполнять по образцу полей из `server/catalog.json` (ready-профиль)
и `server/catalog_basic.json` (пример с `subject` в записях).

Верх уровня:

```json
{
  "subject": "<id>",
  "subjectId": "<id>",
  "title": "<Название> (ЕГЭ)",
  "status": "coming-soon",
  "locked": true,
  "comingSoon": true,
  "availability": "coming-soon",
  "features": {
    "lessons": false, "practice": false, "forecast": false,
    "diagnostics": false, "missions": false, "bosses": false,
    "daily": false, "path": true
  },
  "description": "...",
  "categories": [],
  "skills": [],
  "tasks": [],
  "lessons": [],
  "missions": [],
  "bosses": [],
  "achievements": [],
  "daily": { "skill": "", "target": 0, "xp": 0, "title": "" },
  "goals": [],
  "diagnosticTasks": [],
  "visualAssets": [],
  "visualAudit": { "defaultStatus": "not-published", "taskStatuses": {}, "references": [] }
}
```

Сущности (все примеры — из живых каталогов):

- `categories`: `{id, name, short, subject?, status, locked, ...}`.
  Для locked-раздела добавить `status: "locked"`, `locked/comingSoon: true`
  (как это было у `russian_writing` до публикации русского).
- `skills` (темы Пути): `{id, name, cat, order, ege, status, locked,
  comingSoon, metadata}`. `cat` обязан существовать в `categories`
  этого же предмета.
- `tasks`: `{id, skill, sub, num, diff, text, answer, hint, hints,
  solution, type: "short_answer", sourceId, status, ...}`.
  Формулы — LaTeX `\\(...\\)` / `\\[...\\]` (см. раздел
  `README.md` «Математические формулы»).
  `skill` обязан существовать в этом же предмете.
- `lessons`: `{id, skill, title, xp, steps: [{id, type, title, text,
  ...}]}`. Типы шагов: `EXPLANATION`, `FOCUS`, `ACTION`, `VALIDATION`,
  `FEEDBACK` и др. (см. `test/deeplinks.js`).
- `missions`: `{id, skill, title, desc, tasks: [taskIds], xp, diff}`.
  Каждый `taskId` обязан существовать в этом же предмете.
- `bosses`: `{id, cat, title, desc, size, xp, unlockAt}`.
  `cat` обязан существовать в `categories` этого же предмета.
- `achievements`: `{id, name, desc, icon}`. Сервер отдаёт их только
  для unlocked-предмета; клиент показывает собственные записи каталога
  без подмешивания чужих бейджей.
- `daily`: `{skill, target, xp, title}`. Для locked payload принудительно
  нулевой (`skill: ""`, `target: 0`). Для ready непустой `skill` должен
  быть доступным скиллом этого же предмета; при невалидном skill или
  неположительном `target` сервер обнуляет daily.
- `goals`: `[{id, label, desc}]` (профиль: `g60/g80/g95`; база:
  `g3/g4/g5`). Пустой locked-каталог — `[]`; цель тогда `null`, без
  подстановки чужой шкалы.
- `diagnosticTasks`: `[taskId...]` только из своих доступных заданий.
  Пустой locked-каталог — `[]`.
- `visualAssets` / `visualAudit`: `{defaultStatus, taskStatuses,
  references}`. Не нужны — оставить пустыми как у русского.

Правила наполнения:

- Только реальные задания/уроки. Заглушек и копий из других предметов
  быть не должно; это требование к контенту, которое загрузчик не проверяет.
- `subjectId`: для нового предмета указывать канонический id
  (как `russian`), не `math`.
- После заполнения: снять `locked` в `server/subjects/<id>.json` и в
  записях каталога, поставить `status: "ready"`, а затем проставить
  реальные `features`/`forecast`/`goals`. Не редактируй генерируемый
  `SUBJECTS`: он собирается из JSON-реестра.

## 3. Frontend: менять код НЕ нужно (проверить)

`js/data.js`, `js/state.js`, `js/app.js`, `css/styles.css` —
registry-driven, отдельных веток под предметы нет:

- `DataAPI`: реестр (`subjects`), нормализация каталога, доступность
  (`isSubjectAvailable`/`isSubjectLocked`), учебные accessors
  (`availableSkills()`, `*ForAccess()`), `practiceTasks()`, `lessons()`,
  `missions()`, `bosses()`, `achievements()`, `daily()`, `goals()`,
  `diagnosticTasks()`, `forecastConfig()`. Locked-метаданные видны через
  `skills()/categories()`, учебные селекторы закрыты.
- `Store` (`js/state.js`): subject-scoped состояние, онбординг,
  переключение предметов без мержа, изоляция auth/аккаунтов/сессий,
  очистка XP/streak/attempts/diagnostics/Daily/forecast для locked.
- Рекомендации (`nextStepCandidates()`/`bestNextStep()` в `js/state.js`,
  `test/recommender.js`): чистая функция от доступного каталога.
  Отдельно регистрировать предмет не нужно; для работающего прогноза
  нужны реальные `forecast.weights`, доступные навыки и структурированная
  шкала. Если их нет или предмет locked, движок честно вернёт пусто.
- `js/app.js`: переключатель предметов, онбординг, dashboard, Path,
  profile, topbar/навигация, route guards (`EMPTY_SUBJECT_ROUTES`,
  `SUBJECT_CONTENT_ROUTES`), locked-модалка, deep links
  (`#/skill/<id>` → locked-окно для закрытой темы).
- `status.html`: рендерит `/api/status` generic-циклом; новый предмет
  появится сам.
- Админка (`js/admin.js` + backend): список/деталь пользователя,
  правка профиля, `± XP`, сбросы — subject-aware. Единственное место
  с ручным списком — `GOAL_LABELS` в `js/admin.js`: добавить туда
  новые `goal id`, если предмет вводит свои.

Известные общие места (не ломать, при новом предмете проверить текст):

- `forecastHelpHTML()` в `js/app.js`: ветка `max !== 100`
  написана под базу (21 задание); предмету с другой шкалой может
  понадобиться своя формулировка.
- `egeExamDate()` в `js/app.js`: дата 8 июня — математика; подпись
  «до ЕГЭ осталось» общая для всех предметов.

## 4. Публичные страницы и метаданные

- `main.html`: meta/og/twitter-description, JSON-LD `Course` нового
  предмета, ответ FAQ «Какие предметы доступны», hero-текст, секция
  `#subjects` (карточка + бейдж `Доступно`/`Скоро`).
- `about.html`: meta/og-description, `hero-sub`, `subj-note` с составом
  курсов.
- `index.html`: meta description приложения.
- `llms.txt`: раздел `## Предметы` — одна строка на предмет.
- `site.webmanifest`: `description` — только если меняется wording.
- `status.html`: meta description.
- `README.md`: первый абзац, `## Структура контента`, блок `## Проверки`.

`robots.txt`/`sitemap.xml`: менять не нужно (в sitemap только лендинг;
`/dashboard`, `/admin`, `/api/*` закрыты).

## 5. Тесты

1. Скопировать `test/russian-subject.py` → `test/<id>-subject.py`:
   проверка `/api/subjects` (id/status/locked/features),
   `/api/bootstrap`, `/api/catalog-tasks`, `/api/catalog-lessons`,
   изоляция переключения туда-обратно, `423` на учебную запись locked,
   нулевые counts в `/api/status`.
2. Скопировать `test/russian-subject.js` → `test/<id>-subject.js`:
   locked-тема и категория видны, tasks/lessons/missions/diagnostics/
   achievements/daily/recommendations пусты, а `applyOnboarding` не создаёт
   XP или учебную статистику; отдельными блоками проверяются parity
   profile/basic и синтетический сценарий будущей публикации. Это не
   полная браузерная проверка UI: тест не исполняет UI-сценарии и не
   проверяет bosses, goals или реальный серверный forecast-контракт
   (в synthetic future-блоке есть только базовая проверка `forecastConfig`).
3. Добавить оба файла в `README.md` → `## Проверки`.
4. Быстрый прогон (без миллионов команд):
   `python3 test/<id>-subject.py`, `node test/<id>-subject.js`,
   `node test/smoke.js`, `node test/recommender.js`, `node test/seo.js`,
   `node test/onboarding-flow.js`, `node test/subject-switch.js`,
   `python3 test/subject-auth.py`, `python3 -m py_compile server/server.py`,
   `git diff --check`.

## 6. Перевод locked → ready (когда контент готов)

1. В `server/subjects/<id>.json`: `status: "ready"`,
   `locked/comingSoon: false`, убрать `availability` или явно поставить
   `"ready"`, задать настоящий `forecast` и реальные capability-флаги
   `features` (не обязательно механически все `true`), актуальный
   `metadata`; `SUBJECTS` не редактируется.
2. Каталог: `status: "ready"`, снять `locked` с категории/скиллов,
   заполнить `tasks/lessons/missions/bosses/achievements/daily/goals/
   diagnosticTasks` реальными данными.
3. Публичные страницы: перевести бейджи/тексты с «скоро» на «доступно».
4. Тесты: перевести assertions с locked на ready; ориентир — parity-блок
   для `profile_math`/`basic_math` в `test/russian-subject.js`.
5. Отдельный коммит + `git push`, как требует раздел
   `How to change code` в `AGENTS.md`.

## 7. Типичные ошибки

- Реестр не подхватил предмет: несовпадение имени
  `subjects/<id>.json` и `id` даёт только warning; старт с `SubjectContractError`
  означает отсутствующий/битый `catalogFile` или другой битый контракт
  (читать текст ошибки, а не искать предмет в API).
- `daily.skill` или `diagnosticTasks` ссылаются на чужой/пустой банк —
  сервер обнуляет их, и это выглядит как «предмет сломан».
- ID сущности совпал с другим предметом — `install_catalog` упадёт.
- Выдуманные уроки/прогресс «чтобы не было пусто» — запрещено; только
  реальные данные или locked.
- Ручной `GOAL_LABELS` в админке не пополнен — цель видна как сырой id.
- Публичные тексты обновлены не везде (`main.html` + `about.html` +
  `llms.txt` + `README.md` расходятся).
