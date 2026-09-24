# Project

## Stack
- Python 3 (FastAPI-like structure)
- SQLite (ege.sqlite3)
- HTML/JS (Vanilla JS + localStorage for theme)
- Browser-based lessons

## Commands
- install: `pip install flask` (if needed for server deps)
- test: `python3 test/admin-inbox-security.py` (83 критические проверки Admin Inbox: видимость блока guest/юзер/admin, исчезновение при logout/отзыве/истечении сессий/admin-logout/удалении аккаунта/смене аккаунта, обход авторизации чужими и подменёнными куками и query, отсутствие утечек в bootstrap и 401, пагинация/порядок/«Прочитано»/аудит; свой temp-БД, живой сервер), `node test/admin-inbox-ui.js` (40 браузерных проверок: блока нет у гостя/юзера и НЕТ запросов к /api/admin/*, подмена localStorage не даёт блока, админ видит блок и «Прочитано» убирает обращение, блок исчезает БЕЗ reload при отзыве/истечении сессий и смене аккаунта, /admin обычному показывает форму входа, HTML в обращении не исполняется; нужен `playwright-core` и Chromium, `EGE_CHROME` — путь), `python3 test/admin-inbox.py` (контракт endpoint'ов обращений), `node test/smoke.js`, `node test/seo.js` (robots/sitemap/meta/иконки) и `node test/recommender.js` (сценарии движка «лучший следующий шаг»), `node test/auth-merge.js` (409-конфликт при смене аккаунта: мерж блокируется), `node test/security.js` (закрытые файлы, заголовки, health, valid/invalid-нарезки; нужен живой сервер + `EGE_TEST_ADMIN_PASSWORD`), `python3 test/adversarial.py` (атаки: DDoS/флуд/параллель/Slowloris, брутфорс, захват админки, порча и удаление БД — свой temp-БД/порт, прод не трогает), `python3 test/auth.py` (аккаунты: guest→register→login→logout, сессии, миграция), `python3 test/auth-audit.py` (целевой аудит: привязка гостя, переключение аккаунтов, гонки, подмена id), `python3 test/onboard-subject.py` (регистрация во втором предмете), `python3 test/subject-auth.py` (смена предмета не роняет авторизацию: auth в ответе /api/subject, быстрые повторные смены, перезагрузка), `python3 test/domain-state.py`, `python3 test/occ.py`, `python3 test/support-message.py` (быстрая форма поддержки: миграция, валидация, идемпотентность, антиспам) или `python3 -m py_compile server/server.py`
- lint: `python3 -m py_compile server/server.py`

## How to change code
- После каждой задачи создай отдельный публичный git-коммит с относящимися к ней изменениями и отправь его в настроенный удалённый репозиторий (`git push`). Не добавляй в коммит чужие или нерелевантные изменения; если изменений нет, не создавай пустой коммит.
- Не пиши «готово» без успешного diff.
- После правок запусти релевантные тесты.
- Не рефакторь мимо задачи.
