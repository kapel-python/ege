# Project

## Stack
- Python 3 (FastAPI-like structure)
- SQLite (ege.sqlite3)
- HTML/JS (Vanilla JS + localStorage for theme)
- Browser-based lessons

## Commands
- install: `pip install flask` (if needed for server deps)
- test: `node test/smoke.js` и `node test/recommender.js` (сценарии движка «лучший следующий шаг»), `node test/auth-merge.js` (409-конфликт при смене аккаунта: мерж блокируется), `python3 test/auth.py` (аккаунты: guest→register→login→logout, сессии, миграция), `python3 test/auth-audit.py` (целевой аудит: привязка гостя, переключение аккаунтов, гонки, подмена id), `python3 test/onboard-subject.py` (регистрация во втором предмете), `python3 test/domain-state.py`, `python3 test/occ.py` или `python3 -m py_compile server/server.py`
- lint: `python3 -m py_compile server/server.py`

## How to change code
- Правь файлы через search_replace/write.
- Не пиши «готово» без успешного diff.
- После правок запусти релевантные тесты.
- Не рефакторь мимо задачи.
