#!/usr/bin/env python3
"""Вход через внешнего провайдера (Google): OAuth 2.0 code flow на stdlib.

Модуль ничего не знает ни про базу, ни про сессии ученика. Его работа — три
вещи, которые не должны быть размазаны по серверу:

  1. подписать состояние (state) так, чтобы подсунуть чужой код авторизации
     было невозможно, и проверить его обратно;
  2. обменять код на токен и принести профиль владельца (sub/email/name);
  3. отдать всё это по-честному: любая сетевая/протокольная ошибка — это
     ОТКАЗ, а не «вроде вошли». Учётная запись, блокировка и сессия решаются
     в server.py, здесь их нет по построению.

Адреса и учётные данные — из окружения. Без ключа модуль просто говорит
«не настроено», сайт при этом работает как раньше (парольный вход цел).
Значения по умолчанию указывают на настоящего Google; переопределение
адресов нужно тестам (фейковый шлюз) и нестандартным стендам.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

# Куда ходим по умолчанию. Тесты и стенды подменяют этими же переменными.
AUTH_URL_DEFAULT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL_DEFAULT = "https://oauth2.googleapis.com/token"
USERINFO_URL_DEFAULT = "https://openidconnect.googleapis.com/v1/userinfo"
# openid нужен для id_token, email — для адреса, profile — для имени.
SCOPE = "openid email profile"
# Сколько живёт state: вход должен укладываться в десять минут.
STATE_TTL_SEC = 600
# Потолок одной сетевой операции к провайдеру. Вход не должен висеть дольше,
# чем терпит человек, и тем более не должен блокировать поток сервера.
HTTP_TIMEOUT_SEC = 12
MAX_RESPONSE_BYTES = 64 * 1024
USER_AGENT = "ege-core/1.0 (+oauth-login)"
STATE_VERSION = "v1"


# ---------------------------------------------------------------------------
# Ошибки: причина отказа — машинночитаемая, текст — для человека.
# Сервер переводит reason в код в адресе возврата, поэтому список закрытый и
# НЕ должен пополняться чем попало из текста провайдера.
# ---------------------------------------------------------------------------
class OAuthError(Exception):
    reason = "failed"

    def __init__(self, message: str = "", reason: str | None = None):
        super().__init__(message or reason or self.reason)
        if reason:
            self.reason = reason


class OAuthNotConfigured(OAuthError):
    """Нет client id/secret: вход через провайдера выключен, не сломан."""

    reason = "unconfigured"


class OAuthUnavailable(OAuthError):
    """Провайдер не ответил или ответил 5xx: наш запрос не доведён."""

    reason = "unavailable"


class OAuthDenied(OAuthError):
    """Человек нажал «Отмена» — это не ошибка, а его решение."""

    reason = "denied"


class OAuthBadState(OAuthError):
    """Подделанный, чужий или протухший state: запрос не наш."""

    reason = "state"


class OAuthRejected(OAuthError):
    """Провайдер отверг код (истёк, уже использован, не наш client)."""

    reason = "code"


class OAuthBadIdentity(OAuthError):
    """Ответ есть, но владельца по нему опознать нельзя."""

    reason = "identity"


def settings() -> dict[str, str]:
    """Клиент и адреса провайдера из окружения. Ничего не кэшируем."""
    return {
        "clientId": (os.environ.get("EGE_GOOGLE_CLIENT_ID") or "").strip(),
        "clientSecret": (os.environ.get("EGE_GOOGLE_CLIENT_SECRET") or "").strip(),
        "authUrl": (os.environ.get("EGE_GOOGLE_AUTH_URL") or AUTH_URL_DEFAULT).strip(),
        "tokenUrl": (os.environ.get("EGE_GOOGLE_TOKEN_URL") or TOKEN_URL_DEFAULT).strip(),
        "userinfoUrl": (os.environ.get("EGE_GOOGLE_USERINFO_URL") or USERINFO_URL_DEFAULT).strip(),
        "redirectUri": (os.environ.get("EGE_GOOGLE_REDIRECT_URI") or "").strip(),
    }


def is_configured() -> bool:
    cfg = settings()
    return bool(cfg["clientId"] and cfg["clientSecret"] and cfg["redirectUri"])


def require_configured() -> dict[str, str]:
    cfg = settings()
    if not (cfg["clientId"] and cfg["clientSecret"] and cfg["redirectUri"]):
        raise OAuthNotConfigured("google oauth is not configured")
    return cfg


def public_base_url() -> str:
    """Куда возвращаем человека после входа (окружение → localhost)."""
    return (os.environ.get("EGE_PUBLIC_URL") or "").strip().rstrip("/") or "http://localhost:2026"


# ---------------------------------------------------------------------------
# Состояние (state) и парковочный токен: подпись HMAC, без состояния в БД.
#
# Stateless здесь не компромисс, а требование: хранить state в таблице значило
# бы заводить запись на каждый клик по кнопке, а удалять её — только по таймауту
# (робот без callback оставил бы мусор навсегда). Одноразовость обеспечивает
# сам провайдер: код авторизации повторно не обменять, поэтому повторный
# callback честно падает ещё на обмене.
# ---------------------------------------------------------------------------
def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _mac(secret: str, payload: str) -> str:
    return _b64e(hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())


def new_nonce() -> str:
    return secrets.token_urlsafe(24)


def sign_state(secret: str, nonce: str, now: int | None = None) -> str:
    """state = "<nonce>.<ts>.<mac>". Подписываем nonce и время вместе."""
    if not secret:
        raise OAuthBadState("no state secret")
    ts = int(now if now is not None else time.time())
    body = f"{STATE_VERSION}.{nonce}.{ts}"
    return f"{body}.{_mac(secret, body)}"


def verify_state(secret: str, state: str, nonce_cookie: str | None, *,
                 max_age: int = STATE_TTL_SEC, now: int | None = None) -> str:
    """Вернуть nonce, если state наш, свежий и относится к этому браузеру.

    Три независимые проверки, и каждая закрывает свой класс атак:
      * mac      — состояние нельзя сочинить без серверного секрета;
      * возраст   — украденное давнее состояние не принимается;
      * nonce     — привязка к cookie этого браузера: именно она закрывает
                    login-CSRF (злоумышленник начинает вход в СВОЁМ браузере и
                    скармливает жертве свой callback — у жертвы нет cookie с
                    его nonce, поэтому подмена не проходит).
    """
    parts = str(state or "").split(".")
    if len(parts) != 4 or parts[0] != STATE_VERSION:
        raise OAuthBadState("malformed state")
    _, nonce, raw_ts, mac = parts
    if not nonce or not nonce_cookie:
        raise OAuthBadState("state without browser nonce")
    ts = _int(raw_ts)
    if ts is None:
        raise OAuthBadState("state timestamp is not a number")
    current = int(now if now is not None else time.time())
    # Расхождение в обе стороны: состояние из будущего — тоже подделка.
    if abs(current - ts) > max_age:
        raise OAuthBadState("state expired")
    if not hmac.compare_digest(_mac(secret, f"{STATE_VERSION}.{nonce}.{ts}"), mac):
        raise OAuthBadState("state signature mismatch")
    if not hmac.compare_digest(nonce, str(nonce_cookie)):
        raise OAuthBadState("state is bound to another browser")
    return nonce


# ---------------------------------------------------------------------------
# Обмен кода и профиль владельца
# ---------------------------------------------------------------------------
def authorize_url(*, state: str, cfg: dict | None = None) -> str:
    """URL, на который уходит браузер. redirect_uri — ровно зарегистрированный."""
    cfg = cfg or require_configured()
    params = {
        "client_id": cfg["clientId"],
        "redirect_uri": cfg["redirectUri"],
        "response_type": "code",
        "scope": SCOPE,
        "state": state,
        # include_granted_scopes=true: если у человека уже было согласие,
        # Google не спрашивает его заново (access_type не просим — refresh
        # токен нам не нужен, сессия живёт своей строкой user_sessions).
        "include_granted_scopes": "true",
    }
    # Ни login_hint, ни prompt=consent: выбор аккаунта должен выглядеть
    # ИДЕНТИЧНО входу и регистрации — все аккаунты Google человека, как есть.
    #
    # login_hint здесь был настоящей ошибкой: с ним Google показывал РОВНО
    # один аккаунт — тот, что был подсказан, — и «Привязать Google» выглядел
    # сломанным («а на входе мне показали всех»). prompt=consent добавил бы
    # лишний экран подтверждения, которого на входе тоже нет: кнопка без
    # подтверждений (см. finish_google_login), значит и внешний экран должен
    # быть тем же самым.
    #
    # prompt=select_account не мешает последующим входам (Google помнит
    # согласие), но гарантирует, что человек увидит, ЧТО он привязывает.
    params["prompt"] = "select_account"
    return cfg["authUrl"] + "?" + urllib.parse.urlencode(params)


def fetch_identity(code: str, *, cfg: dict | None = None, timeout: int = HTTP_TIMEOUT_SEC) -> dict:
    """Код → токен → профиль. Возвращает {subject, email, name, verified}.

    Провайдеру мы верим только в двух вещах: в подписи кода (её проверяет
    TLS и client_secret) и в email_verified. Без verified=true адрес не
    считается доказанным — иначе привязка шла бы по недоказанному email.
    """
    cfg = cfg or require_configured()
    if not str(code or "").strip():
        raise OAuthRejected("empty code")
    token = _exchange_code(str(code).strip(), cfg, timeout)
    info = _userinfo(token, cfg, timeout)
    subject = str(info.get("sub") or "").strip()
    email = str(info.get("email") or "").strip().lower()
    if not subject or len(subject) > 255:
        raise OAuthBadIdentity("provider returned no usable subject")
    if not email:
        raise OAuthBadIdentity("provider returned no email")
    if info.get("email_verified") is not True and str(info.get("email_verified")).lower() != "true":
        raise OAuthBadIdentity("provider email is not verified")
    return {
        "subject": subject,
        "email": email,
        "name": _clean_name(info.get("name")) or email.split("@", 1)[0][:40],
        "verified": True,
    }


def _exchange_code(code: str, cfg: dict, timeout: int) -> str:
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": cfg["clientId"],
        # Web-клиент обязан слать secret: без него Google отвергает обмен.
        "client_secret": cfg["clientSecret"],
        "redirect_uri": cfg["redirectUri"],
        "grant_type": "authorization_code",
    }).encode("utf-8")
    request = urllib.request.Request(cfg["tokenUrl"], data=body, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    payload = _json_call(request, timeout, denied_codes={"invalid_grant", "unauthorized_client"},
                         unavailable_codes={"server_error", "temporarily_unavailable"})
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise OAuthBadIdentity("no access token in response")
    return token


def _userinfo(token: str, cfg: dict, timeout: int) -> dict:
    request = urllib.request.Request(cfg["userinfoUrl"], method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    return _json_call(request, timeout, denied_codes={"invalid_token", "invalid_grant"})


def _json_call(request: urllib.request.Request, timeout: int, *,
               denied_codes: set[str], unavailable_codes: set[str] | None = None) -> dict:
    """Один поход к провайдеру с честной классификацией отказов.

    4xx с кодом ошибки провайдера — это «он не захотел» (наш код не тот,
    подпись не та, consent отозван), 5xx и сеть — «он не ответил». Разница
    важна ученику: в первом случае поможет повтор, во втором — «попробуй
    позже». Ошибку провайдера в текст для человека не тащим.
    """
    unavailable_codes = unavailable_codes or set()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        code = _provider_error_code(exc)
        if code in denied_codes:
            raise OAuthRejected(f"provider rejected the request: {code}") from exc
        if code in unavailable_codes or exc.code >= 500:
            raise OAuthUnavailable(f"provider HTTP {exc.code}") from exc
        raise OAuthRejected(f"provider HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise OAuthUnavailable(f"provider unreachable: {type(exc).__name__}") from exc
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise OAuthBadIdentity("provider response is not json") from exc
    if not isinstance(parsed, dict):
        raise OAuthBadIdentity("provider response is not an object")
    return parsed


def _provider_error_code(exc: urllib.error.HTTPError) -> str:
    """Код ошибки из тела ответа провайдера ('' — если разобрать нельзя)."""
    try:
        raw = exc.read(4096)
    except Exception:
        return ""
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return ""
    if isinstance(parsed, dict):
        return str(parsed.get("error") or "").strip()
    return ""


def _clean_name(value) -> str:
    text = " ".join(str(value or "").split())
    return text[:60]


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None