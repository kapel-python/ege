# Project

## Stack
- Python 3 (FastAPI-like structure)
- SQLite (ege.sqlite3)
- HTML/JS (Vanilla JS + localStorage for theme)
- Browser-based lessons

## Commands
- install: `pip install flask` (if needed for server deps)
- test: `node test/smoke.js` и `node test/recommender.js` (сценарии движка «лучший следующий шаг») или `python3 -m py_compile server/server.py`
- lint: `python3 -m py_compile server/server.py`

## How to change code
- Правь файлы через search_replace/write.
- Не пиши «готово» без успешного diff.
- После правок запусти релевантные тесты.
- Не рефакторь мимо задачи.
