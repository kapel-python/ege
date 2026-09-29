/* Экран «ИИ-наставник» (#/ai) — часть SPA.
   Хром общий: топбар/сайдбар/тема/тосты/модалки берёт у приложения
   (toast, esc, icon, deviceModalRoot/closeDeviceModal), своего ничего нет.
   Вызывает render() через screenAgent(root); размонтирование — снос DOM:
   каждая асинхронная ветка сверяется с поколением mountGen. */
(function () {
  "use strict";

  var S = {
    threads: [], currentId: null, busy: false, mountGen: 0, navGen: 0, animGen: 0,
    quota: { limit: 10, remaining: 10, resetInSec: null },
    abort: null, stick: true, lock: 0, creating: null, accountId: null,
    timers: [], turn: null, pendingBail: null, newThreadId: null,
  };
  var RING = 94.25, QUOTA_FALLBACK = 10;
  var ICON_QR = "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9";
  var root = null, ui = {};

  function $(s, r) { return (r || root || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || root || document).querySelectorAll(s)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function svgIcon(d, w) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"),
        p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", w || "3.5");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    p.setAttribute("d", d); s.appendChild(p); return s;
  }
  function svgRaw(path, w) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || "2.4") +
      '" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
  }
  var CHECK_D = "M5 12.5l4.5 4.5L19 7";
  var CLOCK_D = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.4v5l3.2 2";
  var ARROW_D = "M9 6l6 6-6 6";
  function say(text) { try { toast(esc(String(text))); } catch (_) {} }

  /* ---------- движение ----------
     Ход наставника показывается как живой: пустой шаг, в который вырастает
     лоадер с названием дела, лоадер гаснет и на его месте раскрывается
     результат, потом сворачивается вся лента и печатается ответ. Всё это
    post-hoc анимация уже полученного ответа (стриминга от модели нет),
     поэтому длительности задаёт клиент, а не сервер. */
  function calm() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
  }
  var raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame
                                                          : function (f) { return setTimeout(f, 16); };
  function later(ms, fn) {
    var t = setTimeout(function () {
      var i = S.timers.indexOf(t);
      if (i >= 0) S.timers.splice(i, 1);
      fn();
    }, ms);
    S.timers.push(t);
    return t;
  }
  // Лента следует за растущим блоком покадрово: одиночный scrollTo на каждом
  // шаге на iOS обрывал плавную прокрутку и лента отставала от текста.
  function follow(ms) {
    var g = S.mountGen, end = Date.now() + ms;
    (function tick() {
      if (g !== S.mountGen) return;
      scrollDown();
      if (Date.now() < end) raf(tick);
    })();
  }
  // Плавно перелить высоту блока: пустой контейнер -> лоадер -> результат.
  // Классический приём «измерь, примени, отдай конечную высоту».
  function morph(box, change) {
    if (!box) return;
    box.style.height = "";
    var h0 = box.offsetHeight;
    try { change(); } catch (_) { return; }
    if (calm()) return;
    var h1 = box.scrollHeight;
    box.style.height = h0 + "px";
    void box.offsetHeight;
    box.style.height = h1 + "px";
    later(420, function () { box.style.height = ""; });
  }
  function stepLoader(text) {
    var l = el("span", "agent__loader");
    l.setAttribute("role", "status");
    l.appendChild(el("span", "agent__loader-dot"));
    l.appendChild(el("span", "agent__loader-text", text || "Думаю…"));
    return l;
  }
  /* Клавиатура на iOS сжимает ВИДИМУЮ область, а не layout viewport: без этого
     браузер скроллит документ, чтобы показать фокус, и весь раздел уезжал
     вверх. Слушатель один на модуль (addEventListener дедуплицирует по
     ссылке), поэтому на размонтировании его снимать не нужно. */
  function syncViewport() {
    applyKeyboardReserve();
  }

  /* Раскладка телефона. НИКАКОЙ высоты отсюда: контейнер прижат к краям
     окна средствами CSS, поэтому «провиснуть» он не может — ни при первом
     кадре, ни когда браузер не пришлёт visualViewport.resize.
     Отсюда идёт единственное число — насколько клавиатура перекрывает низ
     (--agent-kb-inset), и снимает ли она резерв под position:fixed меню.
     Раньше высота считалась в JS и была основной высотой колонки: на
     телефоне dvh меньше layout viewport, от которого считают fixed, поэтому
     контейнер всегда оставался выше низа экрана, а поле для ввода висело
     над нижним меню с зазором.
     Резерв под меню — тоже по геометрии, а не по blur: окно лимита забирает
     фокус с поля, и blur-возврат резерва поднимал композер на высоту меню. */
  var KB_MIN_PX = 120;
  function keyboardInsetPx() {
    try {
      var vv = window.visualViewport;
      if (!vv) return 0;
      var gap = (window.innerHeight || 0) - vv.height - (vv.offsetTop || 0);
      if (gap <= KB_MIN_PX) return 0;
      // Клавиатура не может занимать больше двух третей экрана: иначе это
      // не клавиатура, а устаревший замер после поворота.
      return Math.min(Math.round(gap), Math.round((window.innerHeight || 0) * 0.7));
    } catch (_) { return 0; }
  }
  function applyKeyboardReserve() {
    var inset = keyboardInsetPx();
    var on = inset > 0;
    try {
      if (on) document.documentElement.style.setProperty("--agent-kb-inset", inset + "px");
      else document.documentElement.style.removeProperty("--agent-kb-inset");
      if (on) document.documentElement.style.setProperty("--agent-bottom", "0px");
      else document.documentElement.style.removeProperty("--agent-bottom");
    } catch (_) {}
    try { if (ui.wrap) ui.wrap.classList.toggle("kb-open", on); } catch (_) {}
  }
  // Клавиатура открывается и закрывается анимацией (200-350 мс), поэтому после
  // focus/blur перемеряем ещё несколько раз — иначе резерв мигал бы на переходе.
  function settleKeyboard() {
    later(160, function () { applyKeyboardReserve(); });
    later(420, function () { applyKeyboardReserve(); });
    later(800, function () { applyKeyboardReserve(); });
  }
  try {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewport);
      window.visualViewport.addEventListener("scroll", syncViewport);
    }
  } catch (_) {}
  // Страховка: часть браузеров (и все без visualViewport) не шлёт resize по
  // нему — без этих слушателей высота/резерв остались бы от прошлого кадра.
  try {
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", function () { later(250, syncViewport); later(600, syncViewport); });
  } catch (_) {}

  /* ---------- сеть ---------- */
  function api(method, path, body, signal) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    if (signal) opts.signal = signal;
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data || {} };
      });
    });
  }
  function handleAuthError(res) {
    if (res.status === 401 && res.data && res.data.code === "GUEST_PENDING") {
      try { go("dashboard"); } catch (_) {}
      return true;
    }
    if (res.status === 403 && res.data && res.data.code === "ACCOUNT_BLOCKED") {
      try { showAccountBlocked(res.data); } catch (_) { say("Аккаунт заблокирован"); }
      return true;
    }
    return false;
  }

  /* ---------- квота ---------- */
  function pluralQ(n) {
    try {
      if (typeof aiLimitPlural === "function") return aiLimitPlural(n, "ход", "хода", "ходов");
    } catch (_) {}
    var m = Math.abs(Number(n) || 0) % 100, d = Math.abs(Number(n) || 0) % 10;
    if (d === 1 && m !== 11) return "ход";
    if (d >= 2 && d <= 4 && (m < 10 || m >= 20)) return "хода";
    return "ходов";
  }
  function quotaCacheKey() { return "ege_agent_quota:" + (S.accountId || ""); }
  function setQuota(q, cached) {
    if (!q) return;
    var limit = Math.max(1, Number(q.limit) || QUOTA_FALLBACK);
    var remaining = Math.max(0, Math.min(limit, Number(q.remaining) || 0));
    S.quota = { limit: limit, remaining: remaining, resetInSec: q.resetInSec == null ? null : Number(q.resetInSec) };
    if (ui.quotaNum) ui.quotaNum.textContent = String(remaining);
    if (ui.quotaBtn) {
      ui.quotaBtn.setAttribute("aria-label", "Осталось " + remaining + " " + pluralQ(remaining) + " из " + limit);
      ui.quotaBtn.title = "Осталось " + remaining + " из " + limit + " " + pluralQ(limit);
      ui.quotaBtn.classList.toggle("low", remaining > 0 && remaining <= 3);
      ui.quotaBtn.classList.toggle("zero", remaining === 0);
    }
    if (ui.quotaTip) {
      ui.quotaTip.textContent = "Осталось " + remaining + " из " + limit + " " + pluralQ(limit) + " сегодня";
    }
    if (ui.quotaRing) ui.quotaRing.style.strokeDashoffset = (RING * (1 - Math.min(remaining, limit) / limit)) + "px";
    if (!cached) { try { localStorage.setItem(quotaCacheKey(), JSON.stringify(S.quota)); } catch (_) {} }
  }
  function renderCachedQuota() {
    try {
      var raw = localStorage.getItem(quotaCacheKey());
      if (raw) setQuota(JSON.parse(raw), true);
    } catch (_) {}
  }
  function fmtHMS(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    function p(n) { return String(n).padStart(2, "0"); }
    return p(Math.floor(s / 3600)) + ":" + p(Math.floor((s % 3600) / 60)) + ":" + p(s % 60);
  }
  var limitTimer = null, limitPrevFocus = null;
  function openLimitModal(quota, burstRetry) {
    closeLimitModal();
    var burst = burstRetry != null;
    var limit = Math.max(1, Number(quota && quota.limit) || QUOTA_FALLBACK);
    var left = burst ? Math.max(1, Math.floor(Number(burstRetry) || 60))
                     : Math.max(0, Math.floor(Number(quota && quota.resetInSec) || 0));
    var holder = null;
    try { holder = deviceModalRoot(); } catch (_) { holder = null; }
    if (!holder) { say(burst ? "Слишком частые запросы" : "Ходы на сегодня закончились"); return; }
    limitPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    var back = el("div", "dlg-backdrop");
    var dlg = el("div", "dlg");
    dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-label", burst ? "Слишком частые запросы" : "Ходы закончились");
    var close = el("button", "dlg__close"); close.type = "button"; close.setAttribute("aria-label", "Закрыть окно");
    close.innerHTML = icon("x");
    close.addEventListener("click", closeLimitModal);
    var h = el("h3", "", burst ? "Слишком частые запросы" : "Ходы на сегодня закончились");
    var p = el("p", "", burst
      ? "Ты отправляешь запросы слишком часто. Подожди немного — черновик цел."
      : "Лимит — " + limit + " ходов в день. Каждый ход возвращается через 8 часов. Сейчас доступно: 0 из " + limit + ".");
    var timerRow = el("p", "num", (burst ? "Повтор через " : "Возврат через ") + fmtHMS(left));
    timerRow.setAttribute("role", "status");
    var actions = el("div", "dlg__actions");
    var ok = el("button", "btn btn--primary btn--sm", "Понятно");
    ok.type = "button";
    ok.addEventListener("click", closeLimitModal);
    actions.appendChild(ok);
    dlg.appendChild(close); dlg.appendChild(h); dlg.appendChild(p); dlg.appendChild(timerRow); dlg.appendChild(actions);
    back.appendChild(dlg);
    back.addEventListener("click", function (e) { if (e.target === back) closeLimitModal(); });
    back.id = "agent-limit-modal";
    holder.appendChild(back);
    document.addEventListener("keydown", limitEscHandler);
    limitTimer = setInterval(function () {
      left -= 1;
      if (left > 0) { timerRow.textContent = (burst ? "Повтор через " : "Возврат через ") + fmtHMS(left); return; }
      clearInterval(limitTimer); limitTimer = null;
      if (burst) { closeLimitModal(); return; }
      fetchQuota(true).then(function (st) {
        if (st && Number(st.remaining) > 0) closeLimitModal();
        else openLimitModal(st || quota, null);
      });
    }, 1000);
  }
  function limitEscHandler(e) {
    if (e.key === "Escape") closeLimitModal();
  }
  function closeLimitModal() {
    if (limitTimer) { clearInterval(limitTimer); limitTimer = null; }
    try { document.removeEventListener("keydown", limitEscHandler); } catch (_) {}
    var m = document.getElementById("agent-limit-modal");
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (limitPrevFocus && limitPrevFocus.focus) {
      try { limitPrevFocus.focus({ preventScroll: true }); } catch (_) {}
      limitPrevFocus = null;
    }
  }
  function fetchQuota(force) {
    return api("GET", "/api/agent/limits").then(function (res) {
      if (res.status === 200 && res.data && res.data.ok !== false) {
        setQuota(res.data);
        return S.quota;
      }
      handleAuthError(res);
      return null;
    }).catch(function () { return null; });
  }

  /* ---------- каркас ---------- */
  function threadCacheKey() { return "ege_agent_thread:" + (S.accountId || ""); }
  function saveCurrent() {
    try {
      if (S.currentId) localStorage.setItem(threadCacheKey(), String(S.currentId));
      else localStorage.removeItem(threadCacheKey());
    } catch (_) {}
  }
  function readDeepLink() {
    try {
      var p = (typeof routeParam === "function" ? routeParam() : "");
      if (p && /^\d+$/.test(p)) return Number(p);
      var saved = localStorage.getItem(threadCacheKey());
      if (saved && /^\d+$/.test(saved)) return Number(saved);
    } catch (_) {}
    return null;
  }
  function syncHash() {
    try {
      var h = S.currentId ? "#/ai/" + S.currentId : "#/ai";
      if ((location.hash || "") !== h) history.replaceState(null, "", h);
    } catch (_) {}
  }
  function fmtDate(ms) {
    try {
      var d = new Date(Number(ms));
      var now = new Date();
      if (d.toDateString() === now.toDateString()) return "Сегодня, " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      var y = new Date(now); y.setDate(now.getDate() - 1);
      if (d.toDateString() === y.toDateString()) return "Вчера";
      return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    } catch (_) { return ""; }
  }

  function buildLayout() {
    root.innerHTML = "";
    var wrap = el("div", "agent");
    var side = el("aside", "agent__threads");
    side.setAttribute("aria-label", "Чаты с наставником");
    var head = el("div", "agent__threads-head");
    head.appendChild(el("h2", "section-title", "ИИ-наставник"));
    var newBtn = el("button", "btn btn--primary btn--sm", "+ Новый чат");
    newBtn.type = "button"; newBtn.id = "agent-new";
    newBtn.addEventListener("click", function () { createThread(); nav(false); });
    head.appendChild(newBtn);
    var list = el("ul", "agent__list");
    list.id = "agent-threads";
    var foot = el("div", "agent__foot");
    foot.appendChild(el("small", "", "Раздел бесплатный"));
    var del = el("button", "agent__del", null);
    del.type = "button"; del.id = "agent-del";
    del.setAttribute("aria-label", "Удалить чат"); del.title = "Удалить чат";
    del.innerHTML = icon("x");
    del.addEventListener("click", deleteCurrent);
    foot.appendChild(del);
    side.appendChild(head); side.appendChild(list); side.appendChild(foot);

    var main = el("div", "agent__main");
    var bar = el("div", "agent__toolbar");
    var menu = el("button", "agent__menu", null);
    menu.type = "button"; menu.id = "agent-menu";
    menu.setAttribute("aria-label", "Список чатов"); menu.setAttribute("aria-expanded", "false");
    menu.innerHTML = svgRaw("M4 7h16M4 12h16M4 17h16", "2");
    menu.addEventListener("click", function () {
      var open = !wrap.classList.contains("nav-open");
      nav(open);
      if (open) { try { newBtn.focus({ preventScroll: true }); } catch (_) {} }
    });
    var title = el("h1", "agent__title", "Новый чат");
    title.id = "agent-title";
    var quota = el("button", "agent__quota", null);
    quota.type = "button"; quota.id = "agent-quota";
    quota.innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="q-track" cx="18" cy="18" r="15"/><circle class="q-ring" cx="18" cy="18" r="15" style="stroke-dashoffset:0px"/></svg>';
    var qn = el("span", "num", "10");
    qn.id = "agent-quota-num";
    quota.appendChild(qn);
    // Подсказка про остаток — наведение/фокус (чистый CSS), клик по кольцу
    // остаётся действием: обновить квоту и, если пусто, открыть окно лимита.
    var quotaWrap = el("div", "agent__quota-wrap");
    quotaWrap.id = "agent-quota-wrap";
    var quotaTip = el("span", "agent__quota-tip");
    quotaTip.id = "agent-quota-tip";
    quotaTip.setAttribute("role", "tooltip");
    quotaWrap.appendChild(quota); quotaWrap.appendChild(quotaTip);
    var tipTimer = null;
    quota.addEventListener("click", function () {
      quotaWrap.classList.add("tip");
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { quotaWrap.classList.remove("tip"); }, 2600);
      fetchQuota(true).then(function (st) {
        if (st && Number(st.remaining) <= 0) { openLimitModal(st, null); return; }
        say("Осталось " + S.quota.remaining + " из " + S.quota.limit + " " + pluralQ(S.quota.limit) + " сегодня");
      });
    });
    bar.appendChild(menu); bar.appendChild(title); bar.appendChild(quotaWrap);

    var feed = el("div", "agent__feed");
    feed.id = "agent-feed";
    feed.setAttribute("tabindex", "-1");
    var inner = el("div", "agent__feed-inner");
    var live = el("div", "agent__feed-inner");
    live.id = "agent-live";
    var empty = el("div", "agent__empty", null);
    empty.id = "agent-empty";
    empty.setAttribute("hidden", "");
    empty.innerHTML =
      '<span class="agent__empty-badge" aria-hidden="true">' + icon("ai") + "</span>" +
      '<h2>Здесь пока пусто</h2><p>Спроси про тему или свои ошибки, а я покажу, как искал ответ.</p>' +
      '<div class="agent__suggest">' +
      [["Почему я ошибаюсь в производных?", "Почему я ошибаюсь", "Разберу твои решения по теме"],
       ["Составь план подготовки на неделю", "План на неделю", "Соберу задания под твой уровень"],
       ["Объясни задание 17 с параметрами", "Задание 17", "Объясню параметры простыми словами"]
      ].map(function (s, i) {
        return '<button class="agent__suggest-card" type="button" style="--i:' + i + '" data-ask="' + esc(s[0]) + '">' +
          '<span class="agent__suggest-ic" aria-hidden="true">' + icon("ai") + "</span>" +
          '<span class="agent__suggest-tx"><b>' + esc(s[1]) + "</b><span>" + esc(s[2]) + "</span></span>" +
          '<span class="agent__suggest-go" aria-hidden="true">' + svgRaw(ARROW_D, "2.4") + "</span></button>";
      }).join("") + "</div>";
    inner.appendChild(live); inner.appendChild(empty);
    feed.appendChild(inner);

    var zone = el("div", "agent__composer-zone");
    var down = el("button", "agent__to-bottom", null);
    down.type = "button"; down.id = "agent-down";
    down.setAttribute("aria-label", "К последнему сообщению");
    down.innerHTML = svgRaw("M12 5v14M5 12l7 7 7-7", "2.4");
    down.addEventListener("click", function () { scrollDown(true, true); });
    var composer = el("div", "agent__composer");
    var input = document.createElement("textarea");
    input.id = "agent-input"; input.rows = 1;
    input.placeholder = "Спроси что-нибудь…";
    input.setAttribute("aria-label", "Твой вопрос");
    var send = el("button", "agent__send", null);
    send.type = "button"; send.id = "agent-send";
    send.setAttribute("aria-label", "Отправить");
    send.innerHTML = svgRaw("M12 19V5M5 12l7-7 7 7", "2.4");
    var stop = el("button", "agent__stop", null);
    stop.type = "button"; stop.id = "agent-stop";
    stop.setAttribute("aria-label", "Остановить"); stop.hidden = true;
    stop.innerHTML = svgRaw("M7 7h10v10H7z", "2.4");
    composer.appendChild(input); composer.appendChild(send); composer.appendChild(stop);
    var hint = el("p", "agent__hint", "Enter отправляет, Shift+Enter переносит строку");
    zone.appendChild(down); zone.appendChild(composer); zone.appendChild(hint);
    main.appendChild(bar); main.appendChild(feed); main.appendChild(zone);

    var scrim = el("div", "agent__scrim");
    scrim.addEventListener("click", function () { nav(false); });
    wrap.appendChild(side); wrap.appendChild(main); wrap.appendChild(scrim);
    root.appendChild(wrap);

    ui = { wrap: wrap, list: list, title: title, live: live, empty: empty, feed: feed,
           main: main, input: input, sendBtn: send, stopBtn: stop, composer: composer,
           quotaBtn: quota, quotaNum: qn, quotaTip: quotaTip, quotaRing: quota.querySelector(".q-ring"),
           downBtn: down, menuBtn: menu, newBtn: newBtn, ctx: null, ctxMore: null };
    wireEvents();
  }

  function nav(open) {
    if (!ui.wrap) return;
    if (!open) closeThreadMenu();
    ui.wrap.classList.toggle("nav-open", !!open);
    if (ui.menuBtn) ui.menuBtn.setAttribute("aria-expanded", String(!!open));
  }

  /* ---------- прокрутка ---------- */
  function dist() { return ui.feed.scrollHeight - ui.feed.scrollTop - ui.feed.clientHeight; }
  function scrollDown(force, smooth) {
    if (!ui.feed) return;
    if (!force && !S.stick) return;
    if (force) { S.stick = true; S.lock = Date.now() + 700; }
    var calm = false;
    try { calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
    try { ui.feed.scrollTo({ top: ui.feed.scrollHeight, behavior: smooth && !calm ? "smooth" : "auto" }); }
    catch (_) { ui.feed.scrollTop = ui.feed.scrollHeight; }
  }

  /* ---------- треды ---------- */
  function currentThread() {
    return S.threads.find(function (t) { return Number(t.id) === Number(S.currentId); }) || null;
  }
  /* Меню действий над чатом: долгое нажатие на телефоне, «⋯» на десктопе.
     Открытое меню — единственное активное (по кнопке и по строке), поэтому
     два меню в списке одновременно не живут. Закрывается по Esc, по клику
     мимо, по выбору чата и при уходе с экрана. */
  var threadMenu = { open: false, id: null, timer: null, x: 0, y: 0 };
  function closeThreadMenu() {
    threadMenu.open = false;
    threadMenu.id = null;
    if (threadMenu.timer) { try { clearTimeout(threadMenu.timer); } catch (_) {} threadMenu.timer = null; }
    if (ui.ctx) {
      try { ui.ctx.hidden = true; } catch (_) {}
      try { if (ui.ctxMore) ui.ctxMore.setAttribute("aria-expanded", "false"); } catch (_) {}
      ui.ctx = null; ui.ctxMore = null;
    }
  }
  function openThreadMenu(id) {
    var row = ui.list ? ui.list.querySelector('[data-thread="' + Number(id) + '"]') : null;
    var ctx = row ? row.querySelector(".agent__ctx") : null;
    var more = row ? row.querySelector(".agent__more") : null;
    if (!row || !ctx) return;
    var wasOpen = threadMenu.open && threadMenu.id === Number(id);
    closeThreadMenu();
    if (wasOpen) return;                       // повтор по тому же чату — закрыть
    ctx.hidden = false;
    if (more) more.setAttribute("aria-expanded", "true");
    // Ссылки на открытое меню и его кнопку: без них Esc и клик мимо закрывали
    // бы «в никуда» — само меню оставалось висеть поверх списка.
    ui.ctx = ctx; ui.ctxMore = more;
    threadMenu.open = true;
    threadMenu.id = Number(id);
    try { if (more) more.focus({ preventScroll: true }); } catch (_) {}
  }
  function ctxItem(label, iconRaw, cls, onClick) {
    var b = el("button", "agent__ctx-item" + (cls ? " " + cls : ""), null);
    b.type = "button";
    b.innerHTML = iconRaw;
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click", function () { closeThreadMenu(); onClick(); });
    return b;
  }
  // Долгое нажатие: 500 мс без движения. Движение/отмена/прокрутка — отмена,
  // обычный тап остаётся обычным тапом (открывает чат). `fired` живёт до
  // СЛЕДУЮЩЕГО pointerdown: после срабатывания тапать нельзя, иначе чат
  // открылся бы поверх только что показанного меню.
  function armLongPress(row, id) {
    var startX = 0, startY = 0, fired = false;
    function cancel() {
      if (threadMenu.timer) { try { clearTimeout(threadMenu.timer); } catch (_) {} threadMenu.timer = null; }
    }
    row.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX || 0; startY = e.clientY || 0; fired = false;
      cancel();
      threadMenu.timer = setTimeout(function () {
        threadMenu.timer = null; fired = true;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
        openThreadMenu(id);
      }, 500);
    });
    ["pointerup", "pointercancel", "pointerleave", "scroll"].forEach(function (ev) {
      row.addEventListener(ev, cancel, true);
    });
    row.addEventListener("pointermove", function (e) {
      if (!threadMenu.timer) return;
      if (Math.abs((e.clientX || 0) - startX) > 8 || Math.abs((e.clientY || 0) - startY) > 8) cancel();
    });
    // Правый клик на десктопе — тот же вход в меню.
    row.addEventListener("contextmenu", function (e) { e.preventDefault(); openThreadMenu(id); });
    return function () { var was = fired; fired = false; return was; };
  }
  function renderThreads() {
    if (!ui.list) return;
    var g = S.mountGen;
    closeThreadMenu();
    ui.list.textContent = "";
    S.threads.forEach(function (t) {
      if (g !== S.mountGen) return;
      var li = el("li", "agent__thread-row");
      li.setAttribute("data-thread", String(t.id));
      if (Number(t.id) === Number(S.newThreadId)) li.className += " new";
      var b = el("button", "agent__thread", null);
      b.type = "button";
      if (Number(t.id) === Number(S.currentId)) b.setAttribute("aria-current", "true");
      b.appendChild(el("b", "", t.title || "Новый чат"));
      b.appendChild(el("span", "", fmtDate(t.updatedAt || t.createdAt)));
      b.addEventListener("click", function () {
        if (li._armed && li._armed()) return;  // сработало долгое нажатие — тап не открывает чат
        closeThreadMenu();
        selectThread(t.id);
      });
      var more = el("button", "agent__more", null);
      more.type = "button";
      more.setAttribute("aria-label", "Действия с чатом");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.innerHTML = svgRaw("M6 12h.01M12 12h.01M18 12h.01", "2.6");
      more.addEventListener("click", function (e) { e.stopPropagation(); openThreadMenu(t.id); });
      var ctx = el("div", "agent__ctx", null);
      ctx.setAttribute("role", "menu");
      ctx.hidden = true;
      ctx.appendChild(ctxItem("Открыть чат", icon("arrow"), "", function () { selectThread(t.id); }));
      ctx.appendChild(ctxItem("Удалить чат", icon("x"), "agent__ctx-item--danger", function () { deleteThread(t.id); }));
      li.appendChild(b); li.appendChild(more); li.appendChild(ctx);
      li._armed = armLongPress(li, t.id);
      ui.list.appendChild(li);
    });
  }
  function renderThreadsSkeleton() {
    if (!ui.list || ui.list.childNodes.length) return;
    for (var i = 0; i < 3; i++) {
      var li = document.createElement("li");
      li.setAttribute("aria-hidden", "true");
      var b = el("button", "agent__thread agent__thread--loading", null);
      b.type = "button"; b.disabled = true; b.tabIndex = -1;
      var sk = el("span", "agent__skel", "");
      sk.appendChild(el("i", ""));
      sk.appendChild(el("i", ""));
      b.appendChild(sk);
      li.appendChild(b);
      ui.list.appendChild(li);
    }
  }
  function applyThreadTitle(thread) {
    if (!thread) return;
    var found = false;
    S.threads = S.threads.map(function (t) {
      if (Number(t.id) === Number(thread.id)) {
        found = true;
        return { id: t.id, subject: t.subject, title: thread.title || t.title,
                 createdAt: t.createdAt, updatedAt: Date.now() };
      }
      return t;
    });
    if (!found) return;
    renderThreads();
    var cur = currentThread();
    if (cur && ui.title) ui.title.textContent = cur.title || "Новый чат";
  }
  function selectThread(id) {
    var prev = S.currentId;
    S.navGen++;
    // Свой же тред не абортим: иначе клик по текущему чату убивал бы ход.
    if (Number(prev) !== Number(id) && S.abort) { try { S.abort.abort(); } catch (_) {} S.abort = null; }
    setBusy(false);
    S.currentId = id != null ? Number(id) : null;
    saveCurrent();
    renderThreads();
    // Подсветка «нового чата» одноразовая: второй перерисовкой она бы
    // снова проиграла въезд.
    S.newThreadId = null;
    nav(false);
    var t = currentThread();
    if (ui.title) ui.title.textContent = t ? (t.title || "Новый чат") : "Нет чатов";
    syncHash();
    loadThreadMessages();
  }
  function loadThreads() {
    var g = S.mountGen;
    renderThreadsSkeleton();
    return api("GET", "/api/agent/threads").then(function (res) {
      if (g !== S.mountGen) return;
      if (res.status === 200 && res.data && Array.isArray(res.data.threads)) {
        S.threads = res.data.threads;
        if (res.data.quota) setQuota(res.data.quota);
        renderThreads();
        var want = readDeepLink();
        var exists = want && S.threads.some(function (t) { return Number(t.id) === Number(want); });
        if (exists) { selectThread(want); return; }
        if (want && !exists) {
          try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
          S.currentId = null;
        }
        if (S.threads.length) selectThread(S.threads[0].id);
        else selectThread(null);
        return;
      }
      if (handleAuthError(res)) return;
      if (ui.list) ui.list.textContent = "";
      errorCard("Не удалось загрузить чаты.", "Попробовать снова", function () { loadThreads(); });
    }).catch(function () {
      if (g !== S.mountGen) return;
      if (ui.list) ui.list.textContent = "";
      errorCard("Нет соединения.", "Попробовать снова", function () { loadThreads(); });
    });
  }
  function createThread() {
    if (S.creating) return S.creating;
    S.creating = api("POST", "/api/agent/threads", {}).then(function (res) {
      if (res.status === 200 && res.data && res.data.thread) {
        S.threads.unshift(res.data.thread);
        // Новый чат отмечается, чтобы в списке он въехал, а не мигнул.
        S.newThreadId = res.data.thread.id;
        selectThread(res.data.thread.id);
        return res.data.thread;
      }
      if (handleAuthError(res)) return null;
      say("Не удалось создать чат");
      return null;
    }).catch(function () { say("Нет соединения"); return null; })
    .then(function (out) { S.creating = null; return out; });
    return S.creating;
  }
  // Список перерисовывается целиком, поэтому удаляемый чат показываем
  // «схлопывающимся», а не исчезающим: без этого на телефоне список дёргался.
  function collapseThreadNode(id) {
    if (!ui.list) return;
    try {
      var node = ui.list.querySelector('[data-thread="' + Number(id) + '"]');
      if (!node) return;
      var h = node.offsetHeight;
      node.style.overflow = "hidden";
      node.style.height = h + "px";
      void node.offsetHeight;
      node.classList.add("leaving");
      node.style.height = "0px";
      later(calm() ? 0 : 230, function () { try { if (node.parentNode) node.parentNode.removeChild(node); } catch (_) {} });
    } catch (_) {}
  }
  /* Удаление произвольного чата (меню в списке), а не только открытого.
     Открытый чат удаляем как раньше — с переходом на следующий; чужой просто
     выкидываем из списка, НЕ трогая текущий и летящий ход (иначе удаление
     соседнего чата посреди ответа убивало бы сам ответ). */
  function deleteThread(id) {
    var t = S.threads.filter(function (x) { return Number(x.id) === Number(id); })[0];
    if (!t) return;
    var wasCurrent = Number(S.currentId) === Number(t.id);
    if (wasCurrent && S.busy) { say("Дождись ответа — удаление во время хода потеряет его"); return; }
    if (wasCurrent) {
      S.navGen++;
      if (S.abort) { try { S.abort.abort(); } catch (_) {} S.abort = null; }
    }
    function drop() {
      collapseThreadNode(t.id);
      S.threads = S.threads.filter(function (x) { return Number(x.id) !== Number(t.id); });
      var next = S.threads[0] || null;
      if (!wasCurrent) { renderThreads(); return; }
      // Список ещё показывает чат — даём ему схлопнуться, и только потом
      // перерисовываем под следующий выбранный тред.
      later(calm() ? 0 : 230, function () { selectThread(next ? next.id : null); });
    }
    api("POST", "/api/agent/threads/" + t.id + "/delete", {}).then(function (res) {
      if (res.status === 200) { drop(); say("Чат удалён"); return; }
      if (res.status === 404 && res.data && res.data.code === "THREAD_NOT_FOUND") {
        S.threads = S.threads.filter(function (x) { return Number(x.id) !== Number(t.id); });
        var nxt = S.threads[0] || null;
        if (wasCurrent) selectThread(nxt ? nxt.id : null);
        else renderThreads();
        return;
      }
      if (handleAuthError(res)) return;
      say("Не удалось удалить чат");
    }).catch(function () { say("Нет соединения"); });
  }
  function deleteCurrent() {
    var t = currentThread();
    if (!t) return;
    deleteThread(t.id);
  }

  /* ---------- сообщения ---------- */
  function clearFeed() { if (ui.live) ui.live.textContent = ""; }
  function emptyVisible(show, hasMessages) {
    if (show === true) return true;
    if (show === false) return false;
    return !hasMessages;
  }
  function showEmpty(show) {
    if (!ui.empty) return;
    var hasMessages = !!(ui.live && ui.live.childNodes.length > 0);
    var visible = emptyVisible(show, hasMessages);
    ui.empty.hidden = !visible;
    // Инлайн-стиль вместо надежды на CSS: display:flex из темы перебивает
    // [hidden], и пустой блок оставался видимым поверх сообщений.
    ui.empty.style.display = visible ? "" : "none";
    if (visible && ui.live) ui.live.textContent = "";
  }
  function userBubble(text) {
    var d = el("div", "agent__msg-user enter", text);
    if (ui.live) ui.live.appendChild(d);
    showEmpty(false);
    scrollDown(true, true);
    return d;
  }
  // Шаг строится в двух состояниях: пустой контейнер (в него вырастает
  // лоадер) и готовое содержимое (галочка, название, кнопки, «Подробнее»).
  function stepShell(st) {
    var li = el("li", "agent__step");
    var body = el("div", "agent__tbody");
    li.appendChild(body);
    return { li: li, body: body, st: st };
  }
  function stepMark(st) {
    var mark;
    if (st.status === "needs_confirm") {
      mark = el("span", "agent__mark is-wait");
      mark.appendChild(svgIcon(CLOCK_D));
      return mark;
    }
    mark = el("span", "agent__mark" + (st.kind === "action" ? "" : " is-read"));
    mark.appendChild(svgIcon(CHECK_D));
    return mark;
  }
  function stepFill(p) {
    var st = p.st, body = p.body, li = p.li;
    body.textContent = "";
    li.className = "agent__step" + (st.kind === "action" ? " is-action" : "")
                   + (st.status === "applied" ? " is-applied" : "");
    var old = li.querySelector(".agent__mark");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    li.insertBefore(stepMark(st), body);
    body.appendChild(el("b", "", st.label || st.tool || "Шаг"));
    if (st.tool) body.appendChild(el("code", "", st.tool));
    if (st.status === "needs_confirm") {
      body.appendChild(el("p", "", "Нужно твоё подтверждение — без него ничего не меняю."));
      var acts = el("div", "agent__step-actions");
      var apply = el("button", "btn btn--primary btn--sm", "Применить");
      apply.type = "button";
      var cancel = el("button", "btn btn--ghost btn--sm", "Отмена");
      cancel.type = "button";
      apply.addEventListener("click", function () { confirmStep(st.id, true, [apply, cancel]); });
      cancel.addEventListener("click", function () { confirmStep(st.id, false, [apply, cancel]); });
      acts.appendChild(apply); acts.appendChild(cancel);
      body.appendChild(acts);
    }
    var det = document.createElement("details");
    det.className = "agent__step-detail";
    var sum = document.createElement("summary");
    sum.textContent = "Подробнее";
    det.appendChild(sum);
    var code = el("code", "", JSON.stringify({ args: st.args || {}, result: st.result || st.proposal || {} }, null, 2).slice(0, 2000));
    det.appendChild(code);
    body.appendChild(det);
  }
  function renderSteps(card, steps) {
    if (!steps || !steps.length) return null;
    var toggle = el("button", "agent__trace-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    var traceId = "agent-trace-" + Math.random().toString(36).slice(2);
    toggle.setAttribute("aria-controls", traceId);
    toggle.appendChild(svgIcon(ARROW_D, "2.4"));
    var lbl = el("span", "", "Показать шаги");
    toggle.appendChild(lbl);
    toggle.appendChild(el("span", "num", String(steps.length)));
    var trace = el("div", "agent__trace");
    trace.id = traceId;
    var inner = el("div", "agent__trace-in");
    var ol = el("ol", "agent__steps");
    var prepped = steps.map(stepShell);
    inner.appendChild(ol); trace.appendChild(inner);
    card.appendChild(toggle); card.appendChild(trace);
    return { toggle: toggle, trace: trace, ol: ol, prepped: prepped };
  }
  // Показать результат хода: пустые шаги -> лоадер -> содержимое, затем
  // сворачиваем ленту и печатаем ответ по словам. Анимация всегда уступает
  // новому ходу (animGen): два одновременных раскрытия путают и ленту, и
  // автопрокрутку.
  function revealTurn(built, paras, g) {
    var card = built.card;
    var ag = ++S.animGen;
    var prepped = built.prepped;
    var quiet = calm();
    // Суммарно ход идёт ~4.2 с: меньше двух шагов — быстро, больше шести — нет.
    var per = Math.max(500, Math.min(1600, Math.round(4200 / Math.max(1, prepped.length))));
    var stopped = false, finished = false;
    function alive() { return !stopped && g === S.mountGen && ag === S.animGen && card.parentNode; }
    function step(i) {
      if (!alive()) return;
      if (i >= prepped.length) { later(quiet ? 0 : 380, collapse); return; }
      var p = prepped[i];
      built.ol.appendChild(p.li);
      morph(p.body, function () { p.body.appendChild(stepLoader(p.st.label || p.st.tool)); });
      follow(450);
      later(quiet ? 60 : per, function () {
        if (!alive()) return;
        p.body.classList.add("is-out");
        later(quiet ? 0 : 180, function () {
          if (!alive()) return;
          morph(p.body, function () { p.body.classList.remove("is-out"); stepFill(p); });
          follow(450);
          later(quiet ? 0 : 700, function () { step(i + 1); });
        });
      });
    }
    function collapse() {
      if (!alive()) return;
      card.classList.add("done");
      built.trace.classList.remove("open");
      follow(500);
      later(quiet ? 0 : 420, write);
    }
    function write() {
      if (!alive()) return;
      if (!paras.length) { actions(); return; }
      var p = paras.shift();
      card.appendChild(p);
      var text = p.textContent, words = text.split(" ");
      p.textContent = "";
      p.classList.add("enter");
      if (quiet) { p.textContent = text; scrollDown(); write(); return; }
      p.classList.add("typing");
      var n = 0;
      (function tick() {
        if (!alive()) { p.classList.remove("typing"); p.textContent = text; return; }
        n++;
        p.textContent = words.slice(0, n).join(" ");
        scrollDown();
        if (n < words.length) later(34, tick);
        else { p.classList.remove("typing"); later(160, write); }
      })();
    }
    function actions() {
      if (!alive()) return;
      if (!built.actions) {
        var row = el("div", "agent__actions");
        [["Хочу разбор", "Разбери подробнее"], ["Что дальше?", "Что мне делать дальше?"]]
          .forEach(function (q, i) {
            var b = el("button", "agent__qr");
            b.type = "button";
            try { b.style.setProperty("--i", String(i)); } catch (_) { b.setAttribute("style", "--i:" + i); }
            b.setAttribute("data-ask", q[1]);
            b.appendChild(svgIcon(ICON_QR, "2.2"));
            b.appendChild(document.createTextNode(q[0]));
            row.appendChild(b);
          });
        card.appendChild(row);
        built.actions = row;
      }
      // Ход доигран целиком: карточку больше нечего дорисовывать, и новый
      // ход не должен трогать её шаги (иначе у пользователя сбросится
      // раскрытое «Подробнее»).
      finished = true;
      if (S.pendingBail === bail) S.pendingBail = null;
      follow(350);
    }
    // Новый ход перебил незаконченный: дорисовываем остаток разом, карточка
    // не должна остаться с лоадером или с полупустым блоком шага.
    function bail() {
      if (stopped || finished) return;
      stopped = true;
      // Показываем все шаги, даже не доигранные: свёрнутая лента и счётчик
      // на тоггле должны сходиться, иначе ход выглядит оборванным.
      prepped.forEach(function (p) { if (!p.li.parentNode) built.ol.appendChild(p.li); stepFill(p); });
      paras.forEach(function (p) { if (!p.parentNode) card.appendChild(p); });
      paras.forEach(function (p) { p.classList.remove("typing"); });
      if (built.trace && (built.trace.classList.contains("open") || !card.classList.contains("done"))) {
        card.classList.add("done");
        built.trace.classList.remove("open");
      }
      scrollDown(true, false);
    }
    built.bail = bail;
    if (built.trace) built.trace.classList.add("open");
    scrollDown(true, true);
    later(quiet ? 0 : 120, function () { step(0); });
  }
  function assistantCard(steps, finalText, animate) {
    var g = S.mountGen;
    var card = el("article", "agent__ai");
    var built = renderSteps(card, steps);
    var paras = [];
    if (finalText) {
      finalText.split(/\n\n+/).forEach(function (para) {
        if (para.trim()) paras.push(el("p", "agent__answer", para.trim()));
      });
    }
    if (g !== S.mountGen || !ui.live) return card;
    ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    if (built) built.card = card;
    function paintAll() {
      if (built) built.prepped.forEach(function (p) { built.ol.appendChild(p.li); stepFill(p); });
      paras.forEach(function (p) { card.appendChild(p); });
    }
    // Короткий ход (один шаг или пусто) анимировать незачем — это тикает
    // после перезагрузки истории, там нужен сразу готовый результат.
    if (!animate || !built || built.prepped.length + paras.length <= 1) {
      if (built) {
        if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
        paintAll();
        // Лента появляется раскрытой и тут же сворачивается: кадр между
        // ними делает сворачивание плавным, без мигания тоггла.
        built.trace.classList.add("open");
        raf(function () { built.trace.classList.remove("open"); card.classList.add("done"); });
      } else {
        paras.forEach(function (p) { card.appendChild(p); });
      }
      return card;
    }
    // Незаконченная анимация прошлого хода — дорисовать разом, иначе она
    // будет мешать новой (у обеих один токен S.animGen).
    if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
    revealTurn(built, paras, g);
    S.pendingBail = built.bail;
    return card;
  }
  function errorCard(text, btnLabel, onRetry) {
    var card = el("div", "agent__ai done");
    card.appendChild(el("p", "agent__answer", text));
    if (onRetry) {
      var acts = el("div", "agent__actions");
      var btn = el("button", "agent__qr", btnLabel || "Попробовать снова");
      btn.type = "button";
      btn.addEventListener("click", function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        onRetry();
      });
      acts.appendChild(btn);
      card.appendChild(acts);
    }
    if (ui.live) ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    return card;
  }
  function skeletonCard() {
    var card = el("article", "agent__ai");
    var trace = el("div", "agent__trace open");
    var inner = el("div", "agent__trace-in");
    var ol = el("ol", "agent__steps");
    var li = el("li", "agent__step");
    var body = el("div", "agent__tbody");
    body.appendChild(stepLoader("Думаю…"));
    li.appendChild(body); ol.appendChild(li);
    inner.appendChild(ol); trace.appendChild(inner);
    card.appendChild(trace);
    if (ui.live) ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    return card;
  }
  function loadThreadMessages() {
    var g = S.mountGen;
    clearFeed();
    if (!S.currentId) { showEmpty(true); return; }
    var wantId = S.currentId;
    api("GET", "/api/agent/threads/" + wantId).then(function (res) {
      if (g !== S.mountGen || wantId !== S.currentId) return;
      if (res.status === 200 && res.data && Array.isArray(res.data.messages)) {
        clearFeed();
        var msgs = res.data.messages;
        if (!msgs.length) { showEmpty(true); reattachTurn(); return; }
        var pending = [];
        function flushSteps(finalText) {
          if (!pending.length && !finalText) return;
          // История открывается сразу целиком, без анимации.
          assistantCard(pending.splice(0, pending.length), finalText || null, false);
        }
        msgs.forEach(function (m) {
          if (m.role === "user") { flushSteps(null); userBubble(m.content || ""); }
          else if (m.role === "assistant" && (m.content || "").trim()) flushSteps(m.content);
          else if (m.role === "tool") {
            pending.push({ id: m.id, tool: m.tool, args: m.args, result: m.result,
                           label: (m.tool || "Шаг"), kind: "read", status: m.status, proposal: m.result });
          }
        });
        flushSteps(null);
        showEmpty(false);
        scrollDown(true, false);
        reattachTurn();
        return;
      }
      if (res.status === 404) {
        try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
        S.threads = S.threads.filter(function (x) { return Number(x.id) !== Number(wantId); });
        renderThreads();
        var next = S.threads[0] || null;
        S.currentId = next ? Number(next.id) : null;
        saveCurrent();
        var t = currentThread();
        if (ui.title) ui.title.textContent = t ? (t.title || "Новый чат") : "Нет чатов";
        syncHash();
        if (t) { loadThreadMessages(); return; }
        clearFeed(); showEmpty(true);
        say("Чат не найден");
        return;
      }
      if (handleAuthError(res)) return;
      errorCard("Не удалось открыть чат.", "Попробовать снова", function () { loadThreadMessages(); });
      reattachTurn();
    }).catch(function () {
      if (g === S.mountGen) {
        errorCard("Нет соединения.", "Попробовать снова", function () { loadThreadMessages(); });
        reattachTurn();
      }
    });
  }

  /* ---------- ввод ---------- */
  function syncInput() {
    var has = ui.input && ui.input.value.trim().length > 0;
    if (ui.sendBtn) ui.sendBtn.disabled = S.busy || !has;
    if (ui.stopBtn) ui.stopBtn.hidden = !S.busy;
    if (ui.composer) ui.composer.classList.toggle("busy", S.busy);
  }
  function setBusy(b) {
    S.busy = b;
    if (ui.input) ui.input.setAttribute("placeholder", b ? "Наставник отвечает…" : "Спроси что-нибудь…");
    syncInput();
  }
  function send(text, opts) {
    text = (text || "").trim();
    if (!text || S.busy) return;
    var force = !!(opts && opts.force);
    if (!S.currentId) {
      var mg0 = S.mountGen;
      createThread().then(function (t) { if (t && S.mountGen === mg0) send(text, opts); });
      return;
    }
    var g = ++S.navGen;
    var mg = S.mountGen;
    setBusy(true);
    showEmpty(false);
    var bubble = userBubble(text);
    if (ui.input) { ui.input.value = ""; ui.input.style.height = "auto"; }
    syncInput();
    var skel = skeletonCard();
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    // Ход переживает перемонтирование экрана (render из соседней вкладки,
    // возврат из фона): промис один, обработчики цепляются заново.
    var turn = { threadId: S.currentId, text: text, ctrl: ctrl, promise: null,
                 startedAt: Date.now(), dead: false, claimedBy: -1 };
    S.abort = ctrl;
    var payload = { threadId: S.currentId, text: text };
    if (force) payload.force = true;
    turn.promise = api("POST", "/api/agent/turns", payload, ctrl ? ctrl.signal : undefined);
    S.turn = turn;
    turn.promise.then(function (res) { settleTurn(turn, g, mg, skel, bubble, text, res); })
                .catch(function (e) { failTurn(turn, g, mg, skel, text, e); });
  }
  // Подхват летящего хода после перемонтирования: те же обработчики,
  // новый пузырёк и скелетон, тот же промис (ответ не теряется).
  function reattachTurn() {
    var t = S.turn;
    if (!t || t.dead || t.claimedBy === S.mountGen) return;
    if (Date.now() - t.startedAt > 120000) { if (S.turn === t) S.turn = null; return; }
    if (Number(t.threadId) !== Number(S.currentId)) return;
    t.claimedBy = S.mountGen;
    var g = ++S.navGen, mg = S.mountGen;
    setBusy(true);
    showEmpty(false);
    var bubble = userBubble(t.text);
    var skel = skeletonCard();
    t.promise.then(function (res) { settleTurn(t, g, mg, skel, bubble, t.text, res); })
              .catch(function (e) { failTurn(t, g, mg, skel, t.text, e); });
  }
  function settleTurn(turn, g, mg, skel, bubble, text, res) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    turn.dead = true;
    if (S.turn === turn) S.turn = null;
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
    if (S.abort === turn.ctrl) S.abort = null;
    setBusy(false);
    if (res.status === 200 && res.data) {
      if (res.data.quota) setQuota(res.data.quota);
      var steps = res.data.steps || [];
      if (res.data.pending) {
        assistantCard(steps.map(function (s) {
          return { id: s.id, tool: s.tool, args: s.args, label: s.label, kind: s.kind || "action",
                   status: "needs_confirm", proposal: s.proposal };
        }), null, true);
        say("Нужно подтверждение — нажми «Применить»");
      } else {
        assistantCard(steps, res.data.final || "", true);
      }
      if (res.data.thread) applyThreadTitle(res.data.thread);
      return;
    }
    if (res.status === 400 && res.data && res.data.code === "AGENT_BUSY") {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      var wait = Math.max(1, Number(res.data.retryAfter) || 30);
      errorCard("Ход уже выполняется — сервер ещё считает прошлый ответ. Подожди ~" + wait + " с и нажми повтор.",
        "Попробовать снова", function () { send(text, { force: true }); });
      return;
    }
    if (res.status === 404 && res.data && res.data.code === "THREAD_NOT_FOUND") {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      say("Чат не найден — открываю актуальный список");
      loadThreads();
      return;
    }
    if (res.status === 429 && res.data && res.data.code === "AI_LIMIT") {
      openLimitModal({ limit: res.data.limit, remaining: res.data.remaining, resetInSec: res.data.resetInSec }, null);
      if (res.data.limit) setQuota(res.data);
      return;
    }
    if (res.status === 429) {
      openLimitModal(S.quota, Number(res.data.retryAfter) || 60);
      return;
    }
    if (handleAuthError(res)) return;
    errorCard((res.data && res.data.error) || "Наставник не смог ответить.", "Попробовать снова",
      function () { send(text, { force: true }); });
  }
  function failTurn(turn, g, mg, skel, text, e) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    if (e && e.name === "AbortError") {
      // Сервер ход не бросает: turn НЕ хороним — перемонтирование подхватит
      // тот же промис, ответ придёт в ленту сам.
      if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
      if (S.abort === turn.ctrl) S.abort = null;
      setBusy(false);
      errorCard("Остановлено. Если сервер уже считал ответ — он появится ниже.",
        "Обновить чат", function () { loadThreadMessages(); });
      setTimeout(function () { if (!S.busy && g === S.navGen && mg === S.mountGen) loadThreadMessages(); }, 4000);
      return;
    }
    turn.dead = true;
    if (S.turn === turn) S.turn = null;
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
    if (S.abort === turn.ctrl) S.abort = null;
    setBusy(false);
    errorCard("Нет соединения. Текст цел — повтори, когда появится сеть.", "Попробовать снова",
      function () { send(text, { force: true }); });
  }
  function confirmStep(messageId, approve, btns) {
    var mg = S.mountGen;
    if (btns) btns.forEach(function (b) { b.disabled = true; });
    api("POST", "/api/agent/turns/confirm", { messageId: messageId, approve: !!approve }).then(function (res) {
      if (mg !== S.mountGen) return;
      if (res.status === 200 && res.data) {
        if (res.data.quota) setQuota(res.data.quota);
        if (res.data.approved === false) {
          assistantCard([], res.data.final || "Отменено учеником.", true);
        } else if (res.data.final) {
          assistantCard(res.data.steps || [], res.data.final, true);
        } else {
          assistantCard(res.data.steps || [], null, true);
        }
        return;
      }
      if (handleAuthError(res)) return;
      if (btns) btns.forEach(function (b) { b.disabled = false; });
      errorCard((res.data && res.data.error) || "Не удалось подтвердить.", "Попробовать снова",
        function () { confirmStep(messageId, approve, null); });
    }).catch(function () {
      if (mg !== S.mountGen) return;
      if (btns) btns.forEach(function (b) { b.disabled = false; });
      errorCard("Нет соединения. Подтверждение не ушло — повтори.", "Попробовать снова",
        function () { confirmStep(messageId, approve, null); });
    });
  }

  /* ---------- события ---------- */
  var touchCoarse = false;
  try { touchCoarse = window.matchMedia("(pointer: coarse)").matches; } catch (_) {}
  function wireEvents() {
    ui.input.addEventListener("input", function () {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, 140) + "px";
      syncInput();
    });
    // Клавиатура телефона. Раньше здесь высоту колонки пинили в пикселях на
    // focus: iOS скроллил страницу к полю, blur снимал пин — и страница уже
    // не возвращалась, поле оставалось «съеденным». Теперь высоту держит CSS
    // (колонка ровно в 100dvh), а от focus/blur требуется ровно одно —
    // перемерить геометрию: нижнее меню на телефоне уходит за клавиатуру, и
    // резерв под него надо снять, но ТОЛЬКО пока клавиатура на экране.
    // Именно поэтому blur больше не включает резерв сам: окно лимита забирает
    // фокус с поля, и композер уезжал вверх на всю высоту меню. Решение —
    // спросить у visualViewport (applyKeyboardReserve), а не у события.
    // Переменная ставится на :root, а не на .agent: её читает .screen--agent,
    // а custom property вверх по дереву не поднимается (как --topbar-h).
    ui.input.addEventListener("focus", function () { settleKeyboard(); });
    ui.input.addEventListener("blur", function () { settleKeyboard(); });
    ui.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touchCoarse) {
        e.preventDefault();
        send(ui.input.value);
      }
    });
    ui.sendBtn.addEventListener("click", function () { send(ui.input.value); });
    ui.stopBtn.addEventListener("click", function () {
      var g = S.navGen, mg = S.mountGen;
      if (S.abort) { try { S.abort.abort(); } catch (_) {} }
      setBusy(false);
      setTimeout(function () { if (!S.busy && g === S.navGen && mg === S.mountGen) loadThreadMessages(); }, 4000);
    });
    ui.feed.addEventListener("scroll", function () {
      if (Date.now() > S.lock) S.stick = dist() < 120;
      if (ui.downBtn) ui.downBtn.classList.toggle("show", dist() > 200);
    });
    // Один обработчик: и тоггл шагов, и карточки-подсказки (сразу отправка,
    // без фокуса и без дубля текста в поле ввода).
    ui.feed.addEventListener("click", function (e) {
      var tg = e.target.closest ? e.target.closest(".agent__trace-toggle") : null;
      if (tg) {
        var card = tg.closest ? tg.closest(".agent__ai") : tg.parentElement;
        var tr = card ? card.querySelector(".agent__trace") : null;
        var open = tr && !tr.classList.contains("open");
        if (tr) tr.classList.toggle("open", open);
        tg.setAttribute("aria-expanded", String(!!open));
        var lbl = tg.querySelector("span:not(.num)");
        if (lbl) lbl.textContent = open ? "Скрыть шаги" : "Показать шаги";
        return;
      }
      var q = e.target.closest ? e.target.closest("[data-ask]") : null;
      if (q) { e.preventDefault(); send(q.getAttribute("data-ask")); }
    });
  }

  /* Esc и клик мимо — на уровне модуля, одним слушателем на экран: иначе
     каждый перемонт навешивал бы ещё одну копию (их копится столько, сколько
     раз открывали раздел) и Esc закрывал бы по одному обработчику за раз.
     Порядок: сначала меню чата, потом drawer. */
  function agentGlobalKey(e) {
    if (e.key !== "Escape") return;
    if (threadMenu.open) { closeThreadMenu(); return; }
    if (ui.wrap && ui.wrap.classList.contains("nav-open")) nav(false);
  }
  function agentGlobalPointer(e) {
    if (!threadMenu.open) return;
    var t = e && e.target;
    if (t && t.closest && t.closest(".agent__ctx, .agent__more")) return;
    closeThreadMenu();
  }
  try {
    document.addEventListener("keydown", agentGlobalKey);
    document.addEventListener("pointerdown", agentGlobalPointer, true);
  } catch (_) {}

  /* ---------- вход ---------- */
  function screenAgent(screenRoot) {
    S.mountGen++;
    // Летящий ход не рвём: его fetch переживает маунт, reattachTurn подхватит.
    if (S.abort && (!S.turn || S.turn.dead || S.abort !== S.turn.ctrl)) {
      try { S.abort.abort(); } catch (_) {}
      S.abort = null;
    }
    (S.timers || []).forEach(function (t) { try { clearTimeout(t); } catch (_) {} });
    S.timers = [];
    S.busy = false;
    S.navGen++;
    // Незаконченная анимация хода не должна пережить размонтирование: её
    // токен сбрасываем, карточка при следующем показе рисуется заново.
    S.animGen++;
    S.pendingBail = null;
    S.newThreadId = null;
    S.creating = null;
    closeThreadMenu();
    closeLimitModal();
    // Резерв под нижнее меню и замер высоты — состояние прошлого экрана: на
    // других разделах их читать некому, а на следующем возврате в агент
    // перемерим заново.
    try {
      document.documentElement.style.removeProperty("--agent-bottom");
      document.documentElement.style.removeProperty("--agent-kb-inset");
    } catch (_) {}
    var acc = null;
    try { acc = (typeof Store !== "undefined" && Store.accountId) || null; } catch (_) {}
    if (acc !== S.accountId) {
      S.accountId = acc;
      S.threads = []; S.currentId = null;
      S.quota = { limit: QUOTA_FALLBACK, remaining: QUOTA_FALLBACK, resetInSec: null };
    }
    root = screenRoot;
    buildLayout();
    renderCachedQuota();
    syncInput();
    syncViewport();
    showEmpty(true);
    loadThreads();
  }

  window.screenAgent = screenAgent;
  window.AgentScreen = {
    send: send, selectThread: selectThread, state: S, setQuota: setQuota,
    confirmStep: confirmStep, emptyVisible: emptyVisible, screen: screenAgent,
  };
})();
