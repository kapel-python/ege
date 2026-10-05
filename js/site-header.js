/* ============================================================
   ege easy — единая шапка сайта (единственный источник разметки).
   Стили — в css/site-header.css.

   Подключение на новой странице:
     <link rel="stylesheet" href="/css/site-header.css?v=1">
     <div data-ege-header></div>
     <script defer src="/js/site-header.js?v=1"></script>
   Скрипт сам вмонтирует шапку во все [data-ege-header].
   Варианты — в шапке site-header.css.

   Кнопка темы (.eh-toggle) красится и кликается здесь же — и та,
   что вмонтирована в слот, и та, что стоит руками в своей шапке
   (лендинг main.html). Общий ключ ege_core_theme, как везде.
   ============================================================ */
(function () {
  "use strict";

  var THEME_KEY = "ege_core_theme";

  var SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
  var LOGO_BADGE = '<span class="eh-badge" aria-hidden="true">'
    + '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + "</span>";

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function paintAll() {
    var light = getTheme() === "light";
    var btns;
    try { btns = document.querySelectorAll("button.eh-toggle"); } catch (_) { return; }
    for (var i = 0; i < btns.length; i++) {
      btns[i].innerHTML = light ? MOON_ICON : SUN_ICON;
      btns[i].setAttribute("aria-label", light ? "Переключить на тёмную тему" : "Переключить на светлую тему");
      btns[i].setAttribute("aria-pressed", light ? "true" : "false");
    }
  }

  function toggleTheme() {
    var next = getTheme() === "light" ? "dark" : "light";
    try { document.documentElement.setAttribute("data-theme", next); } catch (_) {}
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    paintAll();
  }

  function toggleButtonHTML() {
    return '<button class="eh-toggle" type="button" aria-label="Переключить тему"></button>';
  }

  /* Слот: data-ege-header="back" — ссылка «← К практике» вместо CTA;
     data-cta-href / data-cta-text — свой CTA;
     data-maxw — ширина шапки под контент (ege-result: 720). */
  function build(slot) {
    var variant = slot.getAttribute("data-ege-header") || "";
    var ctaHref = slot.getAttribute("data-cta-href") || "/dashboard";
    var ctaText = slot.getAttribute("data-cta-text") || "начать подготовку";
    var maxw = slot.getAttribute("data-maxw") || "";

    var tmp = document.createElement("div");
    var right;
    if (variant === "back") {
      right = '<a class="eh-btn" href="/dashboard" onclick="if(history.length>1){history.back();return false;}">← К практике</a>';
    } else {
      right = '<a class="eh-btn" href="' + ctaHref.replace(/"/g, "") + '">'
        + ctaText.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</a>";
    }
    tmp.innerHTML = '<header class="eh-header"><div class="eh-inner">'
      + '<a href="/" class="eh-logo" aria-label="ege easy — на главную">'
      + LOGO_BADGE
      + '<span class="eh-logo-text">ege <em>easy</em></span></a>'
      + '<nav class="eh-actions" aria-label="Действия">'
      + toggleButtonHTML() + right
      + "</nav></div></header>";
    var node = tmp.firstChild;
    if (maxw) {
      try { node.querySelector(".eh-inner").style.maxWidth = String(parseInt(maxw, 10)) + "px"; } catch (_) {}
    }
    return node;
  }

  function mountStatic() {
    var slots;
    try { slots = document.querySelectorAll("[data-ege-header]"); } catch (_) { slots = []; }
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].firstChild) continue;
      try { slots[i].appendChild(build(slots[i])); } catch (_) {}
    }
    paintAll();
  }

  /* Один делегированный клик на все .eh-toggle страницы —
     повторный mountStatic обработчики не плодит. */
  function onClick(e) {
    var t = null;
    try { t = e.target && e.target.closest ? e.target.closest("button.eh-toggle") : null; } catch (_) {}
    if (t) toggleTheme();
  }

  window.SiteHeader = {
    mountStatic: mountStatic,
    paintAll: paintAll,
    toggle: toggleTheme,
    get: getTheme
  };

  try { document.addEventListener("click", onClick); } catch (_) {}
  /* Шапка должна быть в первом кадре, а не догонять контент: монтируем
     сразу при выполнении скрипта (тег стоит синхронно в конце body —
     слот уже в DOM), слушатель ниже — лишь подстраховка. mountStatic
     идемпотентен (непустые слоты пропускает), двойной вызов безопасен. */
  try { mountStatic(); } catch (_) {}
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountStatic);
  } else {
    mountStatic();
  }
})();
