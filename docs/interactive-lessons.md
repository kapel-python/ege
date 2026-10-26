# Интерактивные (визуальные) уроки — БЕТА

Короткий визуальный формат поверх классических пошаговых уроков: 4–8 сцен
(текст + опциональный SVG/HTML) вместо шагов с проверкой ответа. Привязан
к ТЕМЕ (skillId), а не к записи каталога уроков. Пока уроков нет — везде
красивая заглушка, а не «битая» ссылка.

## Контракт

- Источник правды — каталог предмета (`server/catalog*.json`), ключ
  `"interactiveLessons"`. Отсутствие ключа = отсутствие контента.
- Запись: `{id, skill, title, subtitle?, xp, scenes: [{title?, text,
  visual?}]}`. `visual` — `{kind: "svg"|"html", svg|html: "<...>"}`,
  вставляется как есть (источник доверенный — наш каталог, чужой HTML
  не вставлять). Текст сцены идёт через `mathText`, KaTeX работает.
- id — с префиксом `v-` (не пересекаться с id обычных уроков/заданий).
- Запись без непустых сцен — не урок: upsert её пропускает, а ранее
  установленная строка удаляется (прогресс учеников блокирует удаление,
  как обычный prune). Пустой `scenes` в details тоже отбрасывается.
- `skill` обязан существовать в этом же предмете (чужой отклоняется
  `ValueError`, как у обычных уроков). Locked-флаг из metadata чтится.

## Backend (`server/server.py`)

- Таблицы: `ilessons(id, skill_id, title, subtitle, xp, metadata_json)` и
  `completed_ilessons(user_id, subject, ilesson_id, completed_at)` —
  создаются миграцией (`SCHEMA` + `IF NOT EXISTS`), subject в PK сразу.
- Установка: `_upsert_catalog_ilesson` + hook в `_install_subject_catalog`;
  prune и `_CATALOG_LIVE_IDS` знают ключ `interactiveLessons`.
- Bootstrap (full и summary) несёт только МЕТУ
  `{id, skill, title, xp, scenesCount, _meta: true}` — без сцен и text.
  Причина: контракт `test/subject-contract.py` разрешает content-поля
  только внутри `$.catalog.tasks[*]` / `$.catalog.lessons[*]`, а сцены
  несут `text`. Полные сцены отдаёт отдельный срез
  `GET /api/catalog-ilessons` (с ETag/304, как tasks/lessons).
- Состояние: домен `completedILessons` (`{id: {ts}}`) — default_state,
  read_state (с live-фильтром), `PATCH /api/state-domains` (валидация id,
  анти-абьюз потолок `MAX_STATE_DICT`), сброс `all-progress`, каскад при
  удалении аккаунта через FK.
- XP: `derive_stats` платит `xp` записи один раз по факту в
  `completedILessons` (PK не даёт дублей — тот же анти-фарм, что у обычных
  уроков). В теорию навыка (40%) интерактив НЕ входит осознанно: она
  по-прежнему только за классические уроки. Повтор не платит.
- Серия (`touch_streak` через `streak_days`): завершение считается учёбой,
  как обычный урок. Сессий/попыток/ошибок по шагам нет — сцены статичны,
  resume не нужен.
- Админка: обзор (`catalog.ilessons`, `learning.completedILessons`) и
  карточка пользователя (`ilessonsCompleted/ilessonsTotal`).
- Гейт витрины — только доступность предмета, без `features.lessons`:
  предмет с `lessons: false` может запускать визуальный формат.
  Тема, у которой есть только интерактивный урок, считается открытой
  (`topicHasLearningContent`), прогноз (`FORECAST_THEORY_WEIGHT`) его
  не учитывает.

## Frontend

- `js/data.js`: коллекция `interactiveLessons`; селекторы `ilessons()`,
  `ilesson(id)`, `ilessonsBySkill(skillId)`, `ilessonScenesCount()`,
  `ilessonForAccess()`, `ilessonsReady()`; `detailsReady()` ждёт и этот
  срез. Мета без сцен в выборку не попадает.
- `js/state.js`: `Store.ensureDetails()` тянет и `/api/catalog-ilessons`;
  домен `completedILessons` в save/merge; `completeInteractiveLesson()`
  (плоский бонус, timeline, streak, одноразовость).
- `js/app.js`: роут `#/ilesson/<skillId>` (`screenInteractiveLesson` —
  урок / скелет с фоновой догрузкой / заглушка), кнопка с БЕТА-бейджем
  в модалке темы (с пометкой «пройден»), секция в «Тренировке»
  (видна только при наличии уроков).
- `js/interactive-lessons.js`: `openInteractiveLesson(skillId)` +
  `INTERACTIVE_LESSON_CATALOG_TEMPLATE` (шаблон записи каталога).

## Тесты

- `python3 test/interactive-lessons.py` — backend-цикл: схема, upsert,
  мета/детали, endpoint+ETag, state-roundtrip, XP-антифарм, prune.
- `node test/interactive-lessons-ui.js` — фронт: селекторы, топик-хелперы,
  завершение, экран, wiring модалки/секции/роута.

## Как добавить урок (шпаргалка)

1. В `server/catalog_<id>.json` добавь запись в `"interactiveLessons"`
   (шаблон — `INTERACTIVE_LESSON_CATALOG_TEMPLATE`).
2. Перезапусти сервер (`install_catalog` подхватит).
3. Проверь: кнопка в модалке темы, `#/ilesson/<skillId>`, секция
   в «Тренировке», `python3 test/interactive-lessons.py`.
