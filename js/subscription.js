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
          <span class="sub-card__sub">В 4 раза больше проверок и ходов наставника. Задания, прогноз и разборы остаются бесплатными.</span>
        </span>
        <span class="chip">бесплатно</span>
      </span>
      <span class="sub-card__limits">
        <span class="sub-limit"><b>5</b> проверок в день</span>
        <span class="sub-limit"><b>10</b> ходов наставника в день</span>
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
    var essay = st.limits && st.limits.essay != null ? Number(st.limits.essay) : 20;
    var agent = st.limits && st.limits.agent != null ? Number(st.limits.agent) : 40;
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
  };
})();
