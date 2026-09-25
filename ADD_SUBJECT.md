# Как добавить новый предмет

Пошаговая инструкция: что нужно, чтобы предмет появился как остальные
(профиль/база/русский) и осталось «только заполнить его заданиями».
Архитектура registry-driven: новый предмет — это **запись в реестре +
декларативный каталог**, а не ветвления `if subject` по коду.

Канонический пример locked-предмета: `russian`
(`server/server.py:236`, `server/catalog_russian.json`).
Эталон ready-предметов: `profile_math`, `basic_math`.

## 0. Договорённости

- Канонический `id` — snake_case, единожды и навсегда. Он используется
  в API (`?subject=`, `POST /api/subject`), `user_subjects`/`state`,
  каталоге и тестах. Переименование потом — миграция данных.
- ID всех сущностей каталога (topics/skills/tasks/lessons/missions/
  bosses/achievements) обязаны быть **глобально уникальными**:
  загрузчик отказывает молчаливому переезду id между предметами
  (`_assert_catalog_owner`, `server/server.py:2122`).
- Все связи проверяются до записи (`_assert_catalog_reference`,
  `server/server.py:2132`): skill→topic, task/lesson/mission→skill,
  mission.tasks→tasks, boss→topic. Чужая или отсутствующая ссылка —
  `ValueError` при `install_catalog`, а не «пустой предмет».
- Не добавлять ветвлений вида `if <новый_id>` в `js/` и `server.py`.
  Все системы читают конфиг через `subject_config()/resolve_subject()`
  (backend) и `DataAPI.subjects()/subjectInfo()` (frontend).
- Locked-предмет не получает выдуманных `0%`, `0 XP`, уровня, streak,
  прогноза и истории. Пустые массивы + `locked/coming-soon` — честно.

## 1. Backend: реестр `server/subjects/*.json` + `server/subjects_registry.py`

Контракт предмета — `server/subjects/<id>.json` (поля и валидация:
`server/subjects/README.md`). Реестр (`subjects_registry.SubjectRegistry`)
собирает из него `SUBJECTS`/`SUBJECT_IDS`, пути каталогов, `source_files`
и строки `math_levels`. `server.py` только импортирует реестр, инлайн-данных
о предметах в нём больше нет (остался fallback на случай деплоя без
`subjects/` на диске).

Чтобы добавить предмет:

1. Создать `server/subjects/<id>.json` (`id` == имя файла, snake_case):
   `title`, `short`, `description`, `status` (`ready` | `coming-soon`),
   `locked`/`comingSoon`, `order` (порядок в UI), `catalogFile`
   (`server/<файл>`), `level: {id, subjectId, name}` (строка `math_levels`),
   `forecast` (объект `{weights, total, scale}` или `None` — нет шкалы,
   будет `forecast: None`), `features` (ровно 8 capability-флагов:
   `lessons`, `practice`, `forecast`, `diagnostics`, `missions`, `bosses`,
   `daily`, `path`; для locked все учебные `False`, `path: True`),
   `content`-указатели (`topics → categories/skills`, `preparationVariants
   → goals`, `onboarding → diagnosticTasks`).
   Для locked скопировать скелет с `server/subjects/russian.json`.
2. Положить рядом catalog (`server/<catalogFile>`): для locked — пустые
   `tasks/lessons/missions/bosses/achievements`, `goals: []`,
   `diagnosticTasks: []`, нулевой `daily`. ID сущностей — глобально
   уникальные, ссылки — только внутри своего предмета (проверяет
   загрузчик, а контракт — что ключи вообще есть в файле).
3. Перезапустить сервер. Всё остальное (`INSERT subjects`, `math_levels`,
   `source_files`, пер-предметные ключи `daily/goals/diagnosticTasks/
   subjectMeta`, `_catalog_cache_key`, `contentUpdatedAt` в статусе)
   итерирует реестр — править `server.py` не нужно.

Битый контракт роняет старт с `SubjectContractError`, а не отдаёт чужой
каталог. `description` контракта отдаётся в `subjectInfo.description`
(`/api/subjects`, bootstrap) — аддитивно, старые клиенты его игнорируют.

Больше ничего в backend менять не нужно: `/api/subjects`,
`/api/bootstrap`, `/api/bootstrap-lite`, `/api/catalog-tasks`,
`/api/catalog-lessons`, `/api/status`, `/api/subject`, доменные writes,
`423 Locked` для учебных записей locked-предмета, `PATCH /api/settings`
(разрешён и для locked), subject-aware admin (`users`, `user_detail`,
`update_profile`, `grant_xp`, `reset`) — всё generic.

## 2. Каталог: `server/catalog_<id>.json`

Скопировать структуру с `server/catalog_russian.json` (locked-скелет)
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
  Для locked — как `russian_writing` в `catalog_russian.json:20`.
- `skills` (темы Пути): `{id, name, cat, order, ege, status, locked,
  comingSoon, metadata}`. `cat` обязан существовать в `categories`
  этого же предмета.
- `tasks`: `{id, skill, sub, num, diff, text, answer, hint, hints,
  solution, type: "short_answer", sourceId, status, ...}`.
  Формулы — LaTeX `\\(...\\)` / `\\[...\\]` (см. `README.md:72`).
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
- `daily`: `{skill, target, xp, title}`. Для locked — нулевой
  (`skill: ""`, `target: 0`). Для ready `skill` обязан быть доступным
  скиллом этого же предмета, иначе сервер обнуляет daily.
- `goals`: `[{id, label, desc}]` (профиль: `g60/g80/g95`; база:
  `g3/g4/g5`). Пустой locked-каталог — `[]`; цель тогда `null`, без
  подстановки чужой шкалы.
- `diagnosticTasks`: `[taskId...]` только из своих доступных заданий.
  Пустой locked-каталог — `[]`.
- `visualAssets` / `visualAudit`: `{defaultStatus, taskStatuses,
  references}`. Не нужны — оставить пустыми как у русского.

Правила наполнения:

- Только реальные задания/уроки. Заглушек и копий из других предметов
  быть не должно.
- `subjectId`: для нового предмета указывать канонический id
  (как `russian`), не `math`.
- После заполнения: снять `locked` в `SUBJECTS` и в записях каталога,
  `status: "ready"`, проставить настоящие `features`/`forecast`/`goals`.

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
  Отдельно регистрировать предмет не нужно; нужны только реальные
  `forecast.weights` + доступные навыки/задания/уроки, иначе движок
  честно вернёт пусто для locked-предмета.
- `js/app.js`: переключатель предметов, онбординг, dashboard, Path,
  profile, topbar/навигация, route guards (`EMPTY_SUBJECT_ROUTES`,
  `SUBJECT_CONTENT_ROUTES`), locked-модалка, deep links
  (`#/skill/<id>` → locked-окно для закрытой темы).
- `status.html`: рендерит `/api/status` generic-циклом; новый предмет
  появится сам.
- Админка (`js/admin.js` + backend): список/деталь пользователя,
  правка профиля, `± XP`, сбросы — subject-aware. Единственное место
  с ручным списком — `GOAL_LABELS` (`js/admin.js:115`): добавить туда
  новые `goal id`, если предмет вводит свои.

Известные общие места (не ломать, при новом предмете проверить текст):

- `forecastHelpHTML()` (`js/app.js:966`): ветка `max !== 100`
  написана под базу (21 задание); предмету с другой шкалой может
  понадобиться своя формулировка.
- `egeExamDate()` (`js/app.js:2620`): дата 8 июня — математика; подпись
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
   locked-тема видна, учебных сущностей/рекомендаций/daily/XP нет,
   онбординг не создаёт статистику; parity ready-каталогов и сценарий
   будущей публикации.
3. Добавить оба файла в `README.md` → `## Проверки`.
4. Быстрый прогон (без миллионов команд):
   `python3 test/<id>-subject.py`, `node test/<id>-subject.js`,
   `node test/smoke.js`, `node test/recommender.js`, `node test/seo.js`,
   `node test/onboarding-flow.js`, `node test/subject-switch.js`,
   `python3 test/subject-auth.py`, `python3 -m py_compile server/server.py`,
   `git diff --check`.

## 6. Перевод locked → ready (когда контент готов)

1. `SUBJECTS`: `status: "ready"`, `locked/comingSoon: False`,
   `availability: "ready"`, настоящий `forecast`, все `features: True`,
   актуальный `metadata`.
2. Каталог: `status: "ready"`, снять `locked` с категории/скиллов,
   заполнить `tasks/lessons/missions/bosses/achievements/daily/goals/
   diagnosticTasks` реальными данными.
3. Публичные страницы: перевести бейджи/тексты с «скоро» на «доступно».
4. Тесты: перевести assertions с locked на ready (пример — parity-блок
   в `test/russian-subject.js:50`).
5. Отдельный коммит + `git push`, как требует `AGENTS.md:15`.

## 7. Типичные ошибки

- Реестр не подхватил предмет: имя файла `subjects/<id>.json` не совпадает
  с `id`, нет `catalogFile` на диске или битый контракт — старт упадёт
  с `SubjectContractError` (читать текст ошибки, а не искать предмет в API).
- `daily.skill` или `diagnosticTasks` ссылаются на чужой/пустой банк —
  сервер обнуляет их, и это выглядит как «предмет сломан».
- ID сущности совпал с другим предметом — `install_catalog` упадёт.
- Выдуманные уроки/прогресс «чтобы не было пусто» — запрещено; только
  реальные данные или locked.
- Ручной `GOAL_LABELS` в админке не пополнен — цель видна как сырой id.
- Публичные тексты обновлены не везде (`main.html` + `about.html` +
  `llms.txt` + `README.md` расходятся).
