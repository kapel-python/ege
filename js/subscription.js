/* ============================================================
   ege easy Plus — карточка подписки в профиле (SPA).
   Компактная ссылка на страницу управления (/subscription/manage):
   вся карточка кликабельна, внутри одна кнопка «Управлять».
   Управление, история и покупка живут на странице, здесь только
   живой статус. Зависимости — глобалы приложения (ApiClient, Store,
   esc, icon, progressBar, plural). Файл грузится до js/app.js,
   вызывается из screenProfile после отрисовки.
   ============================================================ */
var Subscription = (function () {
  "use strict";

  var cache = { accountId: null, status: null, at: 0 };
  var FRESH_MS = 30000;
  var PRICE_MONTH = 99;
  var PRICE_YEAR = 990;

  function accountId() {
    try { return Store.accountId || null; } catch (_) { return null; }
  }

  /* Статус с коротким кэшем на аккаунт: смена аккаунта чужую
     подписку не показывает. */
  function status(force) {
    var id = accountId();
    if (!id) return Promise.resolve({ guest: true });
    if (!force && cache.accountId === id && cache.status && (Date.now() - cache.at) < FRESH_MS) {
      return Promise.resolve(cache.status);
    }
    return ApiClient.get("/api/subscription/status")
      .then(function (st) {
        cache = { accountId: id, status: st || {}, at: Date.now() };
        return cache.status;
      })
      .catch(function (err) {
        // Гость без профиля: сервер отвечает 401 GUEST_PENDING — это не
        // ошибка сети, а состояние. Карточка покажет бесплатный план.
        if (err && (err.status === 401 || err.status === 403)) {
          return { guest: true };
        }
        return null;
      });
  }

  function fmtDate(ms) {
    var t = Number(ms);
    if (!t) return "—";
    try {
      return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    } catch (_) { return String(ms); }
  }

  /* Гейт наставника «только для Plus» (флаг EGE_AGENT_REQUIRES_PLUS).
     Сервер уже отвечает 403 SUBSCRIPTION_REQUIRED на turns/confirm, когда
     флаг включён, а limits.agentAccess в /api/subscription/status несёт
     готовое решение (флаг + подписка). Здесь только чтение этого решения:
     true — раздел открыт, false — закрыт (известный запрет),
     null — неизвестно (гость/сеть/нет кэша — fail-open для навигации,
     сервер всё равно держит вторую стену).
     Пока флаг выключен, сервер всегда отдаёт agentAccess=true, поэтому
     навигация и раздел ведут себя как раньше без единой правки. */
  function agentAccessFromStatus(st) {
    if (!st || typeof st !== "object") return null;
    if (st.guest) return null;
    if (!st.limits || typeof st.limits !== "object") return true;
    if (st.limits.agentAccess === false) return false;
    return true;
  }

  /* Синхронный срез из кэша — для отрисовки хрома без мигания.
     Сети здесь нет: неизвестно — null, вызыватель показывает раздел
     (fail-open), а точное решение доберёт ensureAgentAccess() до хрома. */
  function cachedAgentAccess() {
    try {
      var id = accountId();
      if (!id) return null;
      if (cache.accountId !== id || !cache.status) return null;
      return agentAccessFromStatus(cache.status);
    } catch (_) {
      return null;
    }
  }

  /* Точное решение с сетью (кэш 30 с на аккаунт, как у status).
     null — честная неизвестность (сеть легла): навигация показывает
     раздел, экран — ошибку с повтором, а не paywall. */
  function ensureAgentAccess() {
    var id = accountId();
    if (!id) return Promise.resolve(null);
    return status(false).then(function (st) {
      if (!st) return null;
      return agentAccessFromStatus(st);
    });
  }

  /* Полный гейт для экрана #/ai: доступ, гость ли, активен ли Plus.
     Экран ждёт его под лоадером, поэтому агент никогда не мигает
     перед paywall. */
  function agentGate() {
    var id = accountId();
    if (!id) return Promise.resolve({ access: null, guest: true, active: false });
    return status(false).then(function (st) {
      if (!st) return { access: null, guest: false, active: false, failed: true };
      if (st.guest) return { access: null, guest: true, active: false };
      return { access: agentAccessFromStatus(st), guest: false, active: !!st.active, status: st };
    });
  }

  function daysLeft(expiresAt) {
    var ms = Number(expiresAt) - Date.now();
    if (!(ms > 0)) return 0;
    return Math.ceil(ms / 86400000);
  }

  function periodFrac(st) {
    var start = Number(st && st.startedAt), end = Number(st && st.expiresAt);
    if (!(end > start)) return 0;
    var frac = (end - Date.now()) / (end - start);
    return Math.min(1, Math.max(0, frac));
  }

  function freeCardHTML() {
    return `
    <a class="card sub-card" href="/subscription/manage" aria-label="Управление подпиской Plus">
      <span class="sub-card__top">
        <span class="sub-card__mark" aria-hidden="true">${icon("crown")}</span>
        <span class="sub-card__who">
          <span class="sub-card__name">ege easy <span class="plus">Plus</span></span>
          <span class="sub-card__sub">Лимиты выше: больше проверок и ходов наставника. Задания, прогноз и разборы остаются бесплатными.</span>
        </span>
        <span class="chip">бесплатно</span>
      </span>
      <span class="sub-card__limits">
        <span class="sub-limit"><b>5</b> проверок в день</span>
        <span class="sub-limit"><b>5</b> ходов наставника в день</span>
        <span class="sub-limit"><b>${PRICE_MONTH} ₽</b> в месяц · <b>${PRICE_YEAR} ₽</b> в год</span>
      </span>
      <span class="sub-card__actions">
        <span class="btn btn--primary btn--sm">Управлять</span>
      </span>
    </a>`;
  }

  function plusCardHTML(st) {
    var cancelled = st.status === "cancelled" || st.cancelAtPeriodEnd === true;
    var left = daysLeft(st.expiresAt);
    var leftText = left <= 0 ? "срок вышел" : left + " " + plural(left, "день", "дня", "дней");
    var pill = cancelled
      ? `<span class="chip chip--warn">без продления</span>`
      : `<span class="chip chip--success">активен</span>`;
    var essay = st.limits && st.limits.essay != null ? Number(st.limits.essay) : 10;
    var agent = st.limits && st.limits.agent != null ? Number(st.limits.agent) : 25;
    return `
    <a class="card sub-card sub-card--plus" href="/subscription/manage" aria-label="Управление подпиской Plus">
      <span class="sub-card__top">
        <span class="sub-card__mark" aria-hidden="true">${icon("crown")}</span>
        <span class="sub-card__who">
          <span class="sub-card__name">ege easy <span class="plus">Plus</span> ${pill}</span>
          <span class="sub-card__sub">${cancelled
            ? "Автопродление выключено — доступ до " + esc(fmtDate(st.expiresAt)) + "."
            : "Продление " + esc(fmtDate(st.expiresAt)) + " · " + esc(st.period === "year" ? "год" : "месяц") + "."}</span>
        </span>
      </span>
      <span class="sub-card__limits">
        <span class="sub-limit"><b>${essay}</b> проверок в день</span>
        <span class="sub-limit"><b>${agent}</b> ходов наставника в день</span>
      </span>
      <span class="sub-card__meter">
        ${progressBar(periodFrac(st) * 100)}
        <span class="sub-card__meter-label">Осталось <b>${esc(leftText)}</b> подписки</span>
      </span>
      <span class="sub-card__actions">
        <span class="btn btn--soft btn--sm">Управлять</span>
      </span>
    </a>`;
  }

  /* Точка монтирования из screenProfile: узел #sub-card уже в DOM,
     сюда кладём карточку-ссылку по живому статусу. */
  function mountCard() {
    var box;
    try { box = document.getElementById("sub-card"); } catch (_) { box = null; }
    if (!box) return;
    status(false).then(function (st) {
      var live;
      try { live = document.getElementById("sub-card"); } catch (_) { live = null; }
      if (!live) return;
      if (!st) {
        live.innerHTML = `<div class="card"><div class="empty">Не удалось загрузить подписку. <button class="btn btn--soft btn--sm" type="button" onclick="Subscription.mountCard()">Попробовать снова</button></div></div>`;
        return;
      }
      live.innerHTML = (st.active ? plusCardHTML(st) : freeCardHTML());
    });
  }

  return {
    status: status,
    mountCard: mountCard,
    cachedAgentAccess: cachedAgentAccess,
    ensureAgentAccess: ensureAgentAccess,
    agentGate: agentGate,
  };
})();
