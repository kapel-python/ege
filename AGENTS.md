# Project

## Stack
- Python 3 (FastAPI-like structure)
- SQLite (ege.sqlite3)
- HTML/JS (Vanilla JS + localStorage for theme)
- Browser-based lessons

## Commands
- install: `pip install flask` (if needed for server deps)
- test: запускать из корня репозитория; обычные команды не требуют внешних сервисов, а Python-тесты с `temp-БД` поднимают свои серверы и не трогают прод.
  - `python3 test/admin-inbox-security.py` (83 критические проверки Admin Inbox: видимость блока guest/юзер/admin, исчезновение при logout/отзыве/истечении сессий/admin-logout/удалении аккаунта/смене аккаунта, обход авторизации чужими и подменёнными куками и query, отсутствие утечек в bootstrap и 401, пагинация/порядок/«Прочитано»/аудит; свой temp-БД, живой сервер)
  - `python3 test/admin-inbox.py` (контракт endpoint'ов обращений)
  - `python3 test/admin-block.py` (контракт бана: маршрут `POST /api/admin/users/<ref>/block|unblock`, сверка действий панели с backend'ом, явный 404 вместо общего «Not found», сроки/self-block/неизвестный ref, 403 ACCOUNT_BLOCKED, ленивое истечение, аудит; свой temp-БД, живой сервер)
  - `node test/smoke.js`
  - `node test/seo.js` (robots/sitemap/meta/иконки)
  - `node test/recommender.js` (сценарии движка «лучший следующий шаг»)
  - `node test/auth-merge.js` (409-конфликт при смене аккаунта: мерж блокируется)
  - `python3 test/adversarial.py` (атаки: DDoS/флуд/параллель/Slowloris, брутфорс, захват админки, порча и удаление БД — свой temp-БД/порт, прод не трогает)
  - `python3 test/auth.py` (аккаунты: guest→register→login→logout, сессии, миграция)
  - `python3 test/auth-audit.py` (целевой аудит: привязка гостя, переключение аккаунтов, гонки, подмена id)
  - `python3 test/onboard-subject.py` (регистрация во втором предмете)
  - `python3 test/russian-subject.py` (API/каталог практики «Сочинение по тексту» (задание 27): 8 исходников 150–400 слов, GET /api/essay-text, серверный приём сочинений и изоляция профиля)
  - `python3 test/subject-contract.py` (server-side key-shape parity, capability matrix и изоляция контента)
  - `node test/subject-ui.js` (client-side routes открытого предмета, section parity и contract completeness)
  - `node test/russian-subject.js` (клиентские селекторы открытого русского, countWords, parity profile/basic и синтетическая публикация)
  - `node test/subject-switch.js` (смена предмета сверяется с загруженным каталогом)
  - `node test/forecast.js` (веса, шкала, давность, насыщение, интервал и top-gains)
  - `node test/onboarding-flow.js` (шаги онбординга, выбор предмета и pending-сессия)
  - `node test/tab-leader.js` (единственный writer и синхронизация вкладок)
  - `node test/lesson-timer.js` (активное время урока, pause/resume)
  - `node test/deeplinks.js` (маршруты, подсказки формата, matching сессий и labels)
  - `python3 test/subject-auth.py` (смена предмета не роняет авторизацию: auth в ответе /api/subject, быстрые повторные смены, перезагрузка)
  - `python3 test/domain-state.py` (append-only события и независимые patch-домены)
  - `python3 test/occ.py` (optimistic concurrency control для независимых доменов)
  - `python3 test/support-message.py` (быстрая форма поддержки: миграция, валидация, идемпотентность, антиспам)
  - `python3 test/essay-submission.py` (длинные текстовые ответа: единый подсчёт слов с клиентом, POST /api/essays — 149 отклонено / 150 принято, идемпотентность; temp-БД)
  - `python3 test/essay-pipeline.py` (pipeline проверки сочинения: submission → AI check (POST /api/ai/essay) → POST /api/essays/evaluation (ready/failed) → GET /api/essays (view под ege-result.html) → XP только после ready через attempts-flow; изоляция чужих submission; temp-БД, AI замокан)
  - `python3 test/ai-essay.py` (регрессия AI-оценки: transport, парсер JSON, валидатор К1–К6, детерминированная грамотность К7–К10, калибровка итога второй инстанцией, единая рубрика задания 27, endpoint POST /api/ai/essay; офлайн, temp-БД; live-режим — `EGE_AI_LIVE=1`)
  - `node test/essay-words.js` (паритет клиентского countWords с серверным алгоритмом, граничные случаи)
  - `python3 test/store-save-e2e.py` (реальный Store.save против временного сервера: domain endpoint, без legacy `/api/state`)
  - `python3 -m py_compile server/server.py` (lint backend)
- test с внешними условиями (не часть обычного gate):
  - `node test/admin-inbox-ui.js` (40 браузерных проверок: блока нет у гостя/юзера и НЕТ запросов к /api/admin/*, подмена localStorage не даёт блока, админ видит блок и «Прочитано» убирает обращение, блок исчезает БЕЗ reload при отзыве/истечении сессий и смене аккаунта, /admin обычному показывает форму входа, HTML в обращении не исполняется; **требует** `playwright-core` и Chromium, `EGE_CHROME` — путь)
  - `node test/security.js` (закрытые файлы, заголовки, health, valid/invalid-нарезки; **требует** живой сервер и `EGE_TEST_ADMIN_PASSWORD`; `EGE_TEST_BASE` по умолчанию `http://127.0.0.1:2026`)
  - `node test/essay-visual.js` (визуальные проверки pipeline сочинения: скриншоты desktop/mobile × light/dark, 149/150 слов, единый лоадер с текстами проверки, кнопка «Посмотреть результат →» → ege-result.html с 10 реальными критериями либо честная ошибка без XP; **требует** `playwright-core` и Chromium, `EGE_CHROME` — путь; скриншоты в `screenshots/`)
- не самостоятельные suites: `node test/admin.js` (ручной/live API-скрипт с сервером, БД и `EGE_TEST_ADMIN_PASSWORD`, не включать в обычный gate), `test/drive.html`, `test/visual-audit.html`, `test/nextstep-seed.html` и `test/mathvisual-demo.html` (HTML-демо/ручные страницы, открывать в браузере).
- lint: `python3 -m py_compile server/server.py`

## How to change code
- Создавай отдельный публичный git-коммит с относящимися к задаче изменениями и отправляй его в настроенный удалённый репозиторий (`git push`) только тогда, когда изменения действительно нужно зафиксировать в истории Git: задача или пользователь явно потребовали коммита либо изменение завершает согласованный этап работы. Не коммить автоматически каждую мелкую, промежуточную, конфигурационную или документационную правку. Не добавляй в коммит чужие или нерелевантные изменения; если изменений нет, не создавай пустой коммит.
- Перезапускай сервер только тогда, когда без перезапуска нельзя применить или проверить изменения: например, изменены Python-код, серверная конфигурация, загрузка модулей или сам процесс запуска. Не перезапускай сервер ради изменений только в статике и клиентских файлах (HTML, CSS, обычные JS-файлы, изображения), если работающий сервер сам отдаёт свежие файлы; достаточно обновить страницу или обойти кеш браузера.
- Не пиши «готово» без успешного diff.
- После правок запусти релевантные тесты.
- Не рефакторь мимо задачи.
