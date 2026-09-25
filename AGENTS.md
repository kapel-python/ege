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
  - `node test/smoke.js`
  - `node test/seo.js` (robots/sitemap/meta/иконки)
  - `node test/recommender.js` (сценарии движка «лучший следующий шаг»)
  - `node test/auth-merge.js` (409-конфликт при смене аккаунта: мерж блокируется)
  - `python3 test/adversarial.py` (атаки: DDoS/флуд/параллель/Slowloris, брутфорс, захват админки, порча и удаление БД — свой temp-БД/порт, прод не трогает)
  - `python3 test/auth.py` (аккаунты: guest→register→login→logout, сессии, миграция)
  - `python3 test/auth-audit.py` (целевой аудит: привязка гостя, переключение аккаунтов, гонки, подмена id)
  - `python3 test/onboard-subject.py` (регистрация во втором предмете)
  - `python3 test/russian-subject.py` (API/catalog/locked-состояние и изоляция профиля)
  - `python3 test/subject-contract.py` (server-side key-shape parity, capability matrix и изоляция контента)
  - `node test/subject-ui.js` (client-side locked routes, section parity и contract completeness)
  - `node test/russian-subject.js` (locked-клиентские селекторы, parity profile/basic и синтетическая публикация)
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
  - `python3 test/store-save-e2e.py` (реальный Store.save против временного сервера: domain endpoint, без legacy `/api/state`)
  - `python3 -m py_compile server/server.py` (lint backend)
- test с внешними условиями (не часть обычного gate):
  - `node test/admin-inbox-ui.js` (40 браузерных проверок: блока нет у гостя/юзера и НЕТ запросов к /api/admin/*, подмена localStorage не даёт блока, админ видит блок и «Прочитано» убирает обращение, блок исчезает БЕЗ reload при отзыве/истечении сессий и смене аккаунта, /admin обычному показывает форму входа, HTML в обращении не исполняется; **требует** `playwright-core` и Chromium, `EGE_CHROME` — путь)
  - `node test/security.js` (закрытые файлы, заголовки, health, valid/invalid-нарезки; **требует** живой сервер и `EGE_TEST_ADMIN_PASSWORD`; `EGE_TEST_BASE` по умолчанию `http://127.0.0.1:2026`)
- не самостоятельные suites: `node test/admin.js` (ручной/live API-скрипт с сервером, БД и `EGE_TEST_ADMIN_PASSWORD`, не включать в обычный gate), `test/drive.html`, `test/visual-audit.html`, `test/nextstep-seed.html` и `test/mathvisual-demo.html` (HTML-демо/ручные страницы, открывать в браузере).
- lint: `python3 -m py_compile server/server.py`

## How to change code
- После каждой задачи создай отдельный публичный git-коммит с относящимися к ней изменениями и отправь его в настроенный удалённый репозиторий (`git push`). Не добавляй в коммит чужие или нерелевантные изменения; если изменений нет, не создавай пустой коммит.
- Не пиши «готово» без успешного diff.
- После правок запусти релевантные тесты.
- Не рефакторь мимо задачи.
