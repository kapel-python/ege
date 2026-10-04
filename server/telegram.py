#!/usr/bin/env python3
"""Второй фактор входа в админку: подтверждение через Telegram-бота (stdlib).

Пароль админки — единственный фактор — недостаточен: подсмотренный,
утекший или подобранный пароль сразу открывал панель со всеми аккаунтами.
Поэтому при настроенном боте верный пароль НЕ открывает сессию, а создаёт
заявку (pending): сервер шлёт владельцу сообщение с IP/временем/клиентом и
кнопками «Подтвердить / Отклонить», а браузер ждёт решения опросом статуса.

Почему опрос, а не webhook Telegram:
  * сервер слушает только loopback за nginx — входящий webhook потребовал бы
    публичного URL и регистрации его у Telegram;
  * опрос getUpdates идёт тем же исходящим HTTPS, что и sendMessage, — NAT
    и прокси не мешают, новых открытых портов нет.

Модуль ничего не знает про базу и сессии: транспорт Bot API и разбор
решений. Заявки, привязка к браузеру и куки — дело server.py.

Настройка (всё из окружения, читается при каждом вызове — без кэша):
  EGE_TELEGRAM_BOT_TOKEN    — токен от @BotFather (обязателен для включения);
  EGE_TELEGRAM_ADMIN_CHAT_ID — числовой id владельца (@userinfobot), бот
    должен видеть личный чат с ним (обязателен для включения);
  EGE_TELEGRAM_API_URL      — база Bot API, по умолчанию api.telegram.org;
    переопределение нужно только тестам (фейковый шлюз).
Без обеих обязательных переменных is_configured() ложно и вход работает
как раньше — только по паролю (документированное поведение, а не тихий
отказ: иначе неотправленный бот запирал бы админа из панели).
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL_DEFAULT = "https://api.telegram.org"
HTTP_TIMEOUT_SEC = 10
MAX_RESPONSE_BYTES = 256 * 1024
USER_AGENT = "ege-core/1.0 (+admin-telegram)"

# Префикс callback_data кнопок: "egeadm:<SHORT>:ok|no" (влезает в лимит 64 Б).
CALLBACK_PREFIX = "egeadm"


class TelegramError(Exception):
    """Транспорт или протокол Bot API: сообщение не ушло / ответ не разобран."""


def settings() -> dict[str, str]:
    """Токен, чат и база API из окружения. Ничего не кэшируем."""
    return {
        "botToken": (os.environ.get("EGE_TELEGRAM_BOT_TOKEN") or "").strip(),
        "chatId": (os.environ.get("EGE_TELEGRAM_ADMIN_CHAT_ID") or "").strip(),
        "apiUrl": (os.environ.get("EGE_TELEGRAM_API_URL") or API_URL_DEFAULT).strip().rstrip("/")
        or API_URL_DEFAULT,
    }


def is_configured() -> bool:
    cfg = settings()
    return bool(cfg["botToken"] and cfg["chatId"])


def require_configured() -> dict[str, str]:
    cfg = settings()
    if not (cfg["botToken"] and cfg["chatId"]):
        raise TelegramError("telegram bot is not configured")
    return cfg


def _api_call(method: str, payload: dict | None = None, *,
              cfg: dict | None = None, timeout: int = HTTP_TIMEOUT_SEC) -> dict:
    """Один вызов Bot API. Возвращает поле result; всё остальное — TelegramError."""
    cfg = cfg or require_configured()
    url = f"{cfg['apiUrl']}/bot{cfg['botToken']}/{method}"
    data = None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        raise TelegramError(f"telegram HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise TelegramError(f"telegram unreachable: {type(exc).__name__}") from exc
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise TelegramError("telegram response is not json") from exc
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        raise TelegramError("telegram refused the request")
    result = parsed.get("result")
    if not isinstance(result, dict) and not isinstance(result, list):
        raise TelegramError("telegram response has no result")
    return result  # type: ignore[return-value]


def approval_keyboard(short: str) -> dict:
    """Клавиатура решения: callback_data несёт только короткий код заявки."""
    return {"inline_keyboard": [
        [{"text": "✅ Подтвердить", "callback_data": f"{CALLBACK_PREFIX}:{short}:ok"}],
        [{"text": "⛔ Отклонить", "callback_data": f"{CALLBACK_PREFIX}:{short}:no"}],
    ]}


def send_login_request(*, short: str, code: str, ip: str, when: str,
                       client: str, ttl_sec: int) -> int | None:
    """Сообщение владельцу с кнопками решения. Возвращает message_id (или None).

    Бросает TelegramError, когда сообщение не ушло: вызыватель обязан откатить
    заявку, а не оставить её висеть без уведомления владельца.
    """
    cfg = require_configured()
    ttl_min = max(1, int(round(ttl_sec / 60)))
    text = (
        "🔐 Вход в админ-панель ege easy\n\n"
        f"Код: {code}\n"
        f"IP: {ip}\n"
        f"Время: {when}\n"
        f"Клиент: {client}\n\n"
        "Если это ты — нажми «Подтвердить».\n"
        "Если нет — «Отклонить»: сессия не откроется.\n"
        f"Код действует {ttl_min} мин."
    )
    result = _api_call("sendMessage", {
        "chat_id": cfg["chatId"],
        "text": text,
        "reply_markup": approval_keyboard(short),
    }, cfg=cfg)
    if isinstance(result, dict):
        try:
            return int(result.get("message_id"))
        except (TypeError, ValueError):
            return None
    return None


def fetch_updates(offset: int | None) -> tuple[list, int | None]:
    """Забрать решения владельца. Возвращает (updates, max_update_id|None).

    timeout=0: немедленный ответ, без висения. Опрос идёт из обработчика
    статуса заявки, поэтому висеть здесь нельзя — браузер ждёт.
    """
    cfg = require_configured()
    params = {"timeout": 0, "limit": 100}
    if offset is not None:
        params["offset"] = offset
    url = f"{cfg['apiUrl']}/bot{cfg['botToken']}/getUpdates?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, method="GET",
                                     headers={"Accept": "application/json",
                                              "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
            raw = response.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        raise TelegramError(f"telegram HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise TelegramError(f"telegram unreachable: {type(exc).__name__}") from exc
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise TelegramError("telegram response is not json") from exc
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        raise TelegramError("telegram refused the request")
    updates = parsed.get("result")
    if not isinstance(updates, list):
        raise TelegramError("telegram updates are not a list")
    max_id = None
    for item in updates:
        try:
            value = int(item.get("update_id"))
        except (TypeError, ValueError, AttributeError):
            continue
        if max_id is None or value > max_id:
            max_id = value
    return updates, max_id


def parse_decision(update: object, chat_id: str) -> tuple[str, str] | None:
    """(short, 'approved'|'denied') из callback владельца — иначе None.

    Чужой чат игнорируется молча: кнопки видит только владелец, но
    callback_data могла быть переслана — честь имеет только нажатие из
    настроенного чата (совпадение message.chat.id ИЛИ from.id).
    """
    try:
        if not isinstance(update, dict):
            return None
        callback = update.get("callback_query")
        if not isinstance(callback, dict):
            return None
        data = str(callback.get("data") or "")
        parts = data.split(":")
        if len(parts) != 3 or parts[0] != CALLBACK_PREFIX:
            return None
        _, short, action = parts
        if not short or action not in ("ok", "no"):
            return None
        people = set()
        message = callback.get("message")
        if isinstance(message, dict) and isinstance(message.get("chat"), dict):
            people.add(str(message["chat"].get("id") or ""))
        sender = callback.get("from")
        if isinstance(sender, dict):
            people.add(str(sender.get("id") or ""))
        if str(chat_id) not in people:
            return None
        return short, ("approved" if action == "ok" else "denied")
    except Exception:
        return None


def send_text(chat_id: str | int, text: str) -> None:
    """Обычное сообщение в чат. Ошибки — вызывателю (там best-effort)."""
    cfg = require_configured()
    _api_call("sendMessage", {"chat_id": str(chat_id), "text": text}, cfg=cfg)


def parse_command(update: object) -> tuple[str, str] | None:
    """(chat_id, команда) из входящего сообщения — иначе None.

    Понимаем только команды ('/start', '/help'): обычный текст игнорируется
    молча, иначе бот отвечал бы на каждое слово. Суффикс '@имябота' (команда
    из группы) отрезаем.
    """
    try:
        if not isinstance(update, dict):
            return None
        message = update.get("message")
        if not isinstance(message, dict):
            return None
        text = str(message.get("text") or "").strip()
        if not text.startswith("/"):
            return None
        command = text[1:].split(None, 1)[0].split("@", 1)[0].strip().lower()
        if not command:
            return None
        chat = message.get("chat")
        if not isinstance(chat, dict):
            return None
        chat_id = str(chat.get("id") or "")
        if not chat_id:
            return None
        return chat_id, command
    except Exception:
        return None


def start_reply(is_owner: bool, chat_id: str) -> str:
    """Текст ответа на /start: владельцу — подтверждение привязки, чужому —
    только его id (по нему владелец привяжет чат) и ничего лишнего."""
    if is_owner:
        return (
            "🔐 Это служебный бот входа в админ-панель ege easy.\n\n"
            "Этот чат привязан как владелец: заявки на вход с кодом, "
            "IP и кнопками «Подтвердить / Отклонить» приходят сюда.\n\n"
            "Команды: /start — это сообщение."
        )
    return (
        "🔐 Это служебный бот входа в админ-панель ege easy.\n\n"
        f"Этот чат ({chat_id}) не привязан как владелец — заявки сюда "
        "приходить не будут."
    )


def answer_callback(callback_id: str, text: str = "") -> None:
    """Убрать «часики» на кнопке. Best-effort: исход решения уже в базе."""
    try:
        _api_call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text[:200]})
    except TelegramError:
        pass


def mark_message(message_id: int, *, approved: bool, code: str) -> None:
    """Подписать сообщение итогом (best-effort, исход уже решён без этого)."""
    try:
        cfg = require_configured()
        verdict = "✅ Вход подтверждён" if approved else "⛔ Вход отклонён"
        _api_call("editMessageText", {
            "chat_id": cfg["chatId"],
            "message_id": message_id,
            "text": f"{verdict} (код {code}).",
        }, cfg=cfg)
    except TelegramError:
        pass


def now_msk(when_ms: int | None = None) -> str:
    """'05.10.2026 12:00 МСК' — время заявки человеческими словами."""
    try:
        from zoneinfo import ZoneInfo
        import datetime as dt
        stamp = (when_ms if when_ms is not None else int(time.time() * 1000)) / 1000
        moment = dt.datetime.fromtimestamp(stamp, ZoneInfo("Europe/Moscow"))
        return moment.strftime("%d.%m.%Y %H:%M МСК")
    except Exception:
        return ""
