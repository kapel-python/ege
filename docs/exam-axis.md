# Ось экзамена: ege / oge

Предмет принадлежит экзамену: `subjects/<id>.json` → поле `exam`
(`"ege"` — 11 класс, `"oge"` — 9 класс; отсутствует = `ege`).
Валидация — `validate_definition` в `server/subjects_registry.py`,
в API — `subjectInfo.exam` (`_public_subject_info`), на клиенте —
`DataAPI.subjectExam(id)` (`js/data.js`).

## Что выводится из оси, а не ветвится

- SEO: префикс `_exam_prefix(subject)` (`/ege` или `/oge`), подпись
  `_exam_label(subject)` (`ЕГЭ`/`ОГЭ`) — h1/title/desc/JSON-LD/крошки.
  Хабы `/ege/` и `/oge/` фильтруют предметы по оси; пустая ось — 404
  (`seo_render_index` возвращает None). Предмет чужой оси под чужим
  префиксом — 404 (`/ege/oge_math/`, `/oge/profile_math/` не существуют).
  Крошка хаба оси — переключатель ЕГЭ ⇄ ОГЭ (текущая подсвечена, вторая —
  ссылка на соседний хаб; пустая ось в переключателе прячется).
- Sitemap: оба хаба (oge — только если ось не пуста) + хабы предметов
  со своим префиксом. `robots.txt`: `Allow: /ege/` и `Allow: /oge/`.
- Фронт: заголовок прогноза, корень Пути, обратный отсчёт, цели —
  через `currentExam()`/`examLabel()` (`js/app.js`); пожелание
  goal-celebration — по `subjectExam`; ветка текста помощи прогноза —
  по экзамену, а не по `total` (у ОГЭ total 31, как и совпадающий кейс).
- Обратный отсчёт до экзамена — по своей оси (`examCountdownHTML` в `js/app.js`,
  даты — `EGE_EXAM_DAY_JUNE` для обеих осей); выдуманных дат нет.
- Агент: `SUBJECT_COMPACT`/`_SUBJECT_TITLE_FALLBACK` обязаны покрывать
  каждый id реестра (следит `test/agent-ui.js`); системный промпт —
  «выпускной экзамен (ЕГЭ или ОГЭ)», эссе-инструкции К1–К10 срабатывают
  только при наличии разбора (у oge-предметов без сочинений их нет).

## Что осью НЕ является (не переименовывать)

`ege_` — бренд, а не экзамен: БД (`ege.sqlite3`), куки (`ege_session`,
`ege_admin`), env-префикс (`EGE_*`), localStorage (`ege_core_*`),
процесс/логи (`EGE CORE`). Переименование разлогинит всех и порвёт
пути бэкапов — ось экзамена их не касается.

## Волна ОГЭ: oge_math, oge_biology, oge_society, oge_informatics, oge_history, oge_russian

`server/subjects/oge_math.json` (`exam: oge`) + `server/catalog_oge_math.json`
(сборка: `tools/apply_oge_math.py` из `tools/out/oge_*.json`,
источник — `tools/sdamgia_import.py oge <линия>`).
25 тем, прогноз identity-шкалой (веса 19×1 + 6×2 = 31, цели g3/g4/g5),
25 уроков (по одному на тему), без сочинений (эссе-конвейер закрыт — `hasEssayTasks` ложно).
Отбор заданий: `has_figure` — в отсев, кроме линий 15–17 (чертёж —
декорация, проверено чтением) и точечного allowlist `APPROVED_SRC`
(блок №1–5: отклонены задания с данными в соседнем вопросе варианта).
Формулы-картинки разрешены (парсер даёт словесный alt-текст; прецедент —
вербальные формулы живого банка профиля).

## ОГЭ-русский: oge_russian (задания №1–13)

`server/subjects/oge_russian.json` (`exam: oge`) + `server/catalog_oge_russian.json`
(сборка: `tools/apply_oge_russian.py` из `tools/out/rus_oge_*.json`,
источник — `tools/sdamgia_import.py rus_oge <линия>`; сочинения —
`tools/apply_oge_russian_essays.py`, тексты в `server/essay_texts.d/oge_src_*.json`).
13 тем, 12 уроков (включая урок сочинения), 12 миссий, 3 босса.
Прогноз identity-шкалой: 11 тестовых линий по 1 + сочинение 9 (И1–И3),
total 20, цели g3/g4/g5. Линия №12 (сжатое изложение по аудио) — locked:
слушать текст на сайте нечего, заданий у темы нет.
Сочинение №13 живёт в общем эссе-конвейере (`hasEssayTasks` истинно),
но по СВОЕЙ рубрике: И1–И3 + ГК1–ГК4 (максимум 21), объём от 70 слов.
Рубрику выбирает сервер по предмету (`essay_rubric_for_subject` в
`server/server.py` → параметр `rubric` в `ai.run_format`): у ОГЭ нет
позиции автора (К1), каскадов К1→К2/К3 и вето грамотности; гейты
«переписан исходник»/«повторы» и LanguageTool-грамотность — общие
(категории ГК1–ГК4 мапятся на те же классы ошибок, что К7–К10).
