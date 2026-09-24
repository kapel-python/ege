/* ============================================================
   ege easy — единый футер сайта (единственный источник разметки).
   Стили — в css/footer.css (подхватывает токены хоста).

   Подключение на новой странице:
     <link rel="stylesheet" href="css/footer.css">
     <div data-ege-footer></div>
     <script defer src="js/footer.js"></script>
   Скрипт сам вмонтирует футер во все [data-ege-footer].

   Приложение (SPA, index.html): слот #siteFooterSlot, показом
   управляет Footer.sync(route) из render() в js/app.js.
   Страницы-исключения — в Footer.BLACKLIST ниже.
   ============================================================ */
(function () {
  "use strict";

  var FOOTER_HTML =
    '<footer class="ef-footer">' +
      '<div class="ef-inner">' +
        '<div class="ef-grid">' +
          '<div class="ef-brand">' +
            '<a class="ef-logo" href="/" aria-label="ege easy — на главную">' +
              '<span class="ef-badge" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
              "</span>" +
              "<span>ege <em>easy</em></span>" +
            "</a>" +
            '<span class="ef-tagline">ЕГЭ без стресса</span>' +
            '<p class="ef-text">Понятная подготовка к ЕГЭ: теория по шагам, практика на реальных заданиях и видимый прогресс.</p>' +
          "</div>" +
          '<nav class="ef-col" aria-label="Платформа">' +
            "<h3>Платформа</h3>" +
            "<ul>" +
              '<li><a class="ef-link" data-app-route="dashboard">Дашборд <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
              '<li><a class="ef-link" data-app-route="path">Темы и путь <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
              '<li><a class="ef-link" data-app-route="training">Тренировка <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
              '<li><a class="ef-link" data-app-route="errors">Работа над ошибками <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
            "</ul>" +
          "</nav>" +
          '<nav class="ef-col" aria-label="Компания">' +
            "<h3>Компания</h3>" +
            "<ul>" +
              '<li><a class="ef-link" href="/about">О нас <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
              '<li><a class="ef-link" href="/contacts">Контакты <span class="ef-arr" aria-hidden="true">→</span></a></li>' +
              '<li><a class="ef-link" href="/status">Статус <span class="ef-mini ef-mini--live">live</span></a></li>' +
            "</ul>" +
          "</nav>" +
        "</div>" +
        '<div class="ef-bottom">' +
          '<span>© <span data-ef-year>2026</span> ege easy — Готовься к ЕГЭ так, чтобы понимать, а не угадывать</span>' +
        "</div>" +
      "</div>" +
    "</footer>";

  /* Чёрный список: здесь футер НЕ показываем.
     - login/register/subject: вход, регистрация и выбор предмета —
       минималистичные флоу, лишний хром только отвлекает (subject
       к тому же chrome-locked до явного выбора);
     - онбординг: оверлей во весь экран, render() уходит в ранний
       return до sync — плюс явный hide() в той ветке. */
  var BLACKLIST = { login: true, register: true, subject: true };

  /* Ссылки платформы: внутри приложения — SPA-хэш без перезагрузки,
     снаружи — абсолютный путь на приложение. */
  function resolveLinks(root) {
    var inApp = false;
    try { inApp = !!document.getElementById("screen"); } catch (_) {}
    var links = root.querySelectorAll("a[data-app-route]");
    for (var i = 0; i < links.length; i++) {
      var r = links[i].getAttribute("data-app-route");
      links[i].setAttribute("href", inApp ? "#/" + r : "/dashboard#/" + r);
    }
  }

  function stampYear(root) {
    try {
      var el = root.querySelector("[data-ef-year]");
      if (el) el.textContent = String(new Date().getFullYear());
    } catch (_) {}
  }

  function build() {
    var tmp = document.createElement("div");
    tmp.innerHTML = FOOTER_HTML;
    var node = tmp.firstChild;
    resolveLinks(node);
    stampYear(node);
    return node;
  }

  /* Статика (лендинг, статус, будущие страницы): монтирование
     во все слоты [data-ege-footer]. */
  function mountStatic() {
    var slots;
    try { slots = document.querySelectorAll("[data-ege-footer]"); } catch (_) { return; }
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].firstChild) continue;
      try { slots[i].appendChild(build()); } catch (_) {}
    }
  }

  /* Приложение: слот #siteFooterSlot (.main, после #screen).
     Вызывается в конце render(); чёрный список и оверлей онбординга
     футер скрывают. Повторный вызов узел не плодит. */
  function sync(route) {
    var slot;
    try { slot = document.getElementById("siteFooterSlot"); } catch (_) { return; }
    if (!slot) return;
    var blocked = !!BLACKLIST[route];
    try { if (document.getElementById("onboard-overlay")) blocked = true; } catch (_) {}
    if (blocked) { slot.innerHTML = ""; return; }
    if (slot.firstChild) return;
    try { slot.appendChild(build()); } catch (_) {}
  }

  function hide() {
    try {
      var slot = document.getElementById("siteFooterSlot");
      if (slot) slot.innerHTML = "";
    } catch (_) {}
  }

  window.Footer = { BLACKLIST: BLACKLIST, sync: sync, hide: hide, mountStatic: mountStatic };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountStatic);
  } else {
    mountStatic();
  }
})();
