# Project

## Stack
- Python 3 (FastAPI-like structure)
- SQLite (ege.sqlite3)
- HTML/JS (Vanilla JS + localStorage for theme)
- Browser-based lessons

## Карта знаний

Полные тексты переехали в `docs/` дословно из старого AGENTS.md (346 строк / 305 КБ).
Здесь — только точка входа. Детали и живые случаи — в файлах ниже.

- База и доступ: [docs/db-integrity.md](docs/db-integrity.md) (целостность БД, миграции, бюджеты, HMAC секретов), [docs/perimeter-security.md](docs/perimeter-security.md) (loopback, прокси, CSRF, лимиты, nginx, ufw, Telegram-2FA админки).
- Пользователь и профиль: [docs/profile-subjects.md](docs/profile-subjects.md) (профиль = свойство предмета), [docs/auth-guest.md](docs/auth-guest.md) (гость, устройства, сессии), [docs/auth-google.md](docs/auth-google.md) (вход через Google), [docs/support-system.md](docs/support-system.md) (системные обращения в ленту).
- ИИ: [docs/ai-providers.md](docs/ai-providers.md) (провайдеры, роутер, судья, failover, тиры, Responses API), [docs/ai-agent.md](docs/ai-agent.md) (персональный ИИ: цикл, инструменты, лента, печать, квоты), [docs/ai-limits.md](docs/ai-limits.md) (дневной бюджет проверок, антиабуз-ферма), [docs/quota-ledger.md](docs/quota-ledger.md) (журнал квот).
- Деньги: [docs/subscription-plus.md](docs/subscription-plus.md) (Plus, checkout/webhook, гранты, гейты, waitlist).
- Сочинения: [docs/essay-practice.md](docs/essay-practice.md) (один визит — одно сочинение), [docs/essay-check.md](docs/essay-check.md) (правила ФИПИ в коде, К7–К10, гейты, повтор, кэш/перепроверка, история).
- Тесты: [docs/tests.md](docs/tests.md) (все команды `python3 test/*` / `node test/*`, индекс по группам; запускать из корня репозитория).

## How to change code
- Коммит и пуш — по умолчанию ОБЯЗАТЕЛЬНЫ в конце каждой задачи: создавай отдельный публичный git-коммит с относящимися к задаче изменениями и отправляй его в настроенный удалённый репозиторий (`git push`). НЕ коммитить — только в редких случаях: файлы заведомо не нужны в git (превью, временные файлы, локальные скриншоты, мусор) или пользователь явно сказал не коммитить. Не добавляй в коммит чужие или нерелевантные изменения; если изменений нет, не создавай пустой коммит.
- Перезапуск сервера — по умолчанию ОБЯЗАТЕЛЕН при любых правках серверной части, то есть всего, кроме статики. Статика = HTML, CSS, обычные JS-файлы, изображения. Всё остальное (Python-код, `server/`, серверная конфигурация, загрузка модулей, сам процесс запуска) = серверные правки → перезапускай всегда, не угадывай «может и так подхватится». Не перезапускай только ради изменений чистой статики, если работающий сервер сам отдаёт свежие файлы; тогда достаточно обновить страницу или обойти кеш браузера.
- После правок запусти релевантные тесты.
