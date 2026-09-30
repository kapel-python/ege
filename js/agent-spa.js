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
    timers: [], turn: null, pendingBail: null, newThreadId: null, printing: false,
    follow: true, printTarget: null, gliding: false, glideFeed: null, progTop: null,
    cache: { accountId: null, threads: null, messages: {} },
  };
  var RING = 94.25, QUOTA_FALLBACK = 10;
  /* Окно подхвата хода (после перемонтирования экрана) и параметры ожидания
     ответа, который сервер считает после обрыва на клиенте. REATTACH_MS
     заведомо больше потолка хода на сервере (90 с цикла + вызов финала) —
     иначе ответ приходит в обработчики прошлого монтажа и пропадает.
     Ожидание после обрыва (~96 с) на тот же потолок: ждать дольше смысла нет,
     у человека уже есть кнопка «Обновить чат». */
  var REATTACH_MS = 300000;
  var WATCH_TRIES = 12, WATCH_EVERY_MS = 8000;
  // Сколько тредов держим в кэше раздела: хватает для переходов туда-обратно
  // и не даёт памяти вкладки расти с историей.
  var MAX_CACHED_THREADS = 6;
  /* Значки подсказок — из эталона (agent_preview.html): у первого ответа
     «дай задачи» галочка, у второго «что дальше» — вопрос. Раньше обе
     кнопки рисовали одну иконку и читались одинаково. */
  var ICON_TASKS = "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9";
  var ICON_HELP = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 17h.01";
  /* Запасных шаблонных кнопок нет осознанно: кнопки — это слова модели, а не
     форма. Сервер отдаёт готовый список (модель придумала его под свой ответ)
     и хранит его в базе рядом с ответом, поэтому история показывает те же
     кнопки, что были вживую. Нет списка — нет кнопок, а не дежурный набор. */
  var PLUS_D = "M12 5v14M5 12h14";
  // Корзина, а не крестик: в эталоне удаление чата — корзина, и «×» рядом
  // с текстом «Раздел бесплатный» читался как «закрыть панель».
  var TRASH_D = "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3";
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

  /* ---------- копирование ----------
     Clipboard API + запасной путь через textarea (http/старые браузеры),
     тот же приём, что в app.js. */
  function copyText(text) {
    text = String(text || "");
    if (!text) return;
    function legacy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); say("Скопировано"); } catch (_) { say("Не удалось скопировать"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { say("Скопировано"); }, legacy);
    } else legacy();
  }

  /* ---------- черновик ученика ----------
     Недописанный вопрос переживает перезагрузку, уход в другой чат и
     перемонтирование экрана: одна строка localStorage на аккаунт.
     Ключ привязан к accountId, поэтому чужой черновик не показывается;
     очистка — при отправке (send) и при стирании поля. */
  function draftKey() { return "ege_agent_draft:" + (S.accountId || ""); }
  function saveDraft() {
    try {
      var v = ui.input ? ui.input.value : "";
      if (v) localStorage.setItem(draftKey(), v);
      else localStorage.removeItem(draftKey());
    } catch (_) {}
  }
  function restoreDraft() {
    var v = "";
    try { v = localStorage.getItem(draftKey()) || ""; } catch (_) {}
    if (!v || !ui.input) return;
    ui.input.value = v;
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 140) + "px";
    syncInput();
  }

  /* ---------- меню сообщения ----------
     Долгое нажатие (500 мс) на своё сообщение или ответ наставника открывает
     меню у точки нажатия; тап в любом другом месте, Esc и прокрутка его
     закрывают. Действия зависят от места в ленте:
     - свой вопрос: «Скопировать» + (если он последний) «Изменить и отправить»
       (замена существующего сообщения, не новое);
     - ответ наставника: только у последней пары «Перегенерировать» — тот же
       вопрос уходит с replaceLast, сервер ЗАМЕНЯЕТ пару «вопрос+ответ» и
       модель даёт новый ответ.
     Копирование ОТВЕТА в меню больше не держим: под каждым ответом наставника
     есть своя кнопка «Скопировать» (addCopyRow) — на телефоне её видно сразу,
     а меню по удержанию приходилось ещё и угадывать. Свой вопрос копируется
     только тут — под ним своей кнопки нет. У более ранних сообщений наставника
     пунктов не остаётся, и меню просто не открывается: «изменить» середину
     переписки означало бы переписать всю историю после неё. */
  var msgMenu = { node: null, timer: null };
  function closeMsgMenu() {
    if (!msgMenu.node) return;
    try { if (msgMenu.node.parentNode) msgMenu.node.parentNode.removeChild(msgMenu.node); } catch (_) {}
    msgMenu.node = null;
  }
  function openMsgMenu(x, y, items) {
    closeMsgMenu();
    var m = el("div", "agent__msgmenu");
    m.setAttribute("role", "menu");
    items.forEach(function (it) {
      var b = el("button", "agent__msgmenu-i", null);
      b.type = "button";
      b.innerHTML = svgRaw(it.icon, "2.2");
      b.appendChild(document.createTextNode(it.label));
      b.addEventListener("click", function () { closeMsgMenu(); it.run(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    // Не вылезаем за экран: сначала меряем, потом ставим.
    var w = m.offsetWidth, h = m.offsetHeight;
    var left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    var top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    m.style.left = left + "px";
    m.style.top = top + "px";
    msgMenu.node = m;
  }
  var ICON_COPY = "M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1";
  var ICON_RETRY = "M3 12a9 9 0 1 0 3-6.7M3 4v5h5";
  var ICON_EDIT = "M4 20h4L20 8l-4-4L4 16v4z";
  function answerText(card) {
    // Сырой markdown ответа: textContent уже отрендеренного HTML теряет
    // ** и списки, а копировать человек хочет то, что написала модель.
    if (card && card.dataset && card.dataset.answer) return card.dataset.answer;
    var parts = [];
    card.querySelectorAll(".agent__answer").forEach(function (n) {
      var t = (n.textContent || "").trim();
      if (t) parts.push(t);
    });
    return parts.join("\n\n");
  }
  function msgMenuFor(e, node) {
    var isUser = node.classList.contains("agent__msg-user");
    var card = isUser ? null : node.closest(".agent__ai");
    var text = isUser ? (node.textContent || "").trim() : answerText(card || node);
    if (!text) return;
    var last = isUser ? lastUserBubble() : lastAssistantCard();
    var isLast = (isUser ? node === last : !!card && card === last);
    var items = [];
    if (isUser) items.push({ label: "Скопировать", icon: ICON_COPY, run: function () { copyText(text); } });
    if (isLast) {
      if (isUser) {
        items.push({
          label: "Изменить и отправить",
          icon: ICON_EDIT,
          run: function () { editLastQuestion(text); },
        });
      }
      items.push({
        label: isUser ? "Перегенерировать ответ" : "Перегенерировать",
        icon: ICON_RETRY,
        run: function () {
          var q = isUser ? text : questionBeforeCard(card);
          if (!q) { say("Вопрос не найден"); return; }
          if (S.busy) { say("Наставник ещё отвечает"); return; }
          regenerate(q);
        },
      });
    }
    // Пунктов нет (старый ответ наставника: копирование — кнопкой под ответом) —
    // пустое меню не показываем.
    if (!items.length) return;
    openMsgMenu(e.clientX || 8, e.clientY || 8, items);
  }
  // Последний пузырёк ученика и последняя карточка ответа в ленте.
  function lastUserBubble() {
    var out = null;
    if (ui.live) ui.live.querySelectorAll(".agent__msg-user").forEach(function (n) { out = n; });
    return out;
  }
  function lastAssistantCard() {
    var out = null;
    if (ui.live) ui.live.querySelectorAll(".agent__ai").forEach(function (n) {
      if (n.hasAttribute("data-answer")) out = n;
    });
    return out;
  }
  // Вопрос ученика, стоящий в ленте перед карточкой ответа.
  function questionBeforeCard(card) {
    var prev = null;
    if (card && ui.live) {
      var kids = ui.live.childNodes;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] === card) break;
        if (kids[i].classList && kids[i].classList.contains("agent__msg-user")) prev = kids[i];
      }
    }
    return prev ? (prev.textContent || "").trim() : "";
  }
  // «Изменить и отправить»: последний вопрос ЗАМЕНЯЕТСЯ (replaceLast),
  // новый ход встаёт на его место, а не дублирует переписку.
  var editTarget = null;
  function editLastQuestion(text) {
    if (!ui.input) return;
    editTarget = text;
    ui.input.value = text;
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 140) + "px";
    syncInput();
    try { ui.input.focus({ preventScroll: true }); } catch (_) {}
  }
  // «Перегенерировать»: тот же вопрос уходит с replaceLast — сервер сносит
  // последнюю пару и отвечает заново. force не нужен (кэш replaceLast обходит).
  function regenerate(q) {
    send(q, { replaceLast: true });
  }

  /* ---------- движение ----------
     Ход наставника показывается как живой: пустой шаг, в который вырастает
     лоадер с названием дела, лоадер гаснет и на его месте раскрывается
     результат, потом сворачивается вся лента и печатается ответ. Всё это
    post-hoc анимация уже полученного ответа (стриминга от модели нет),
     поэтому длительности задаёт клиент, а не сервер. */
  function calm() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
  }
  // Есть ли сеть. navigator может отсутствовать (старый движок, песочница) —
  // тогда считаем, что сеть есть: повтор сам упрётся в ту же ошибку и уступит
  // место карточке «Нет соединения».
  function online() {
    try { return !(typeof navigator !== "undefined" && navigator.onLine === false); }
    catch (_) { return true; }
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
  // Первый кадр — с плавным доводом (блок мог вырасти резко, например на
  // длинном шаге), дальше мгновенно: перезапуск smooth на каждом кадре
  // дёргал бы ленту вместо того, чтобы вести её за текстом.
  function follow(ms) {
    var g = S.mountGen, end = Date.now() + ms, first = true;
    (function tick() {
      if (g !== S.mountGen) return;
      scrollDown(false, first);
      first = false;
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
    // Заголовок — своей строкой (иначе он отбирал ширину у кнопки и рвался
    // на «ИИ- / НАСТАННИК»), кнопка «Новый чат» — под ним во всю ширину
    // рейла, как в эталоне: так она остаётся главным действием раздела.
    var head = el("div", "agent__threads-head");
    head.appendChild(el("h2", "section-title", "ИИ-наставник"));
    var newBtn = el("button", "btn btn--primary agent__new", null);
    newBtn.type = "button"; newBtn.id = "agent-new";
    newBtn.innerHTML = svgRaw(PLUS_D, "2.4");
    newBtn.appendChild(document.createTextNode("Новый чат"));
    newBtn.addEventListener("click", function () { createThread(); nav(false); });
    var list = el("ul", "agent__list");
    list.id = "agent-threads";
    var foot = el("div", "agent__foot");
    foot.appendChild(el("small", "", "Раздел бесплатный"));
    var del = el("button", "agent__del", null);
    del.type = "button"; del.id = "agent-del";
    del.setAttribute("aria-label", "Удалить чат"); del.title = "Удалить чат";
    del.innerHTML = svgRaw(TRASH_D, "2");
    del.addEventListener("click", deleteCurrent);
    foot.appendChild(del);
    side.appendChild(head); side.appendChild(newBtn); side.appendChild(list); side.appendChild(foot);

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
      [["Почему я ошибаюсь в производных?", "Почему я ошибаюсь", "Разберу твои решения по теме", "errors"],
       ["Составь план подготовки на неделю", "План на неделю", "Соберу задания под твой уровень", "compass"],
       ["Объясни задание 17 с параметрами", "Задание 17", "Объясню параметры простыми словами", "help"]
      ].map(function (s, i) {
        return '<button class="agent__suggest-card" type="button" style="--i:' + i + '" data-ask="' + esc(s[0]) + '">' +
          '<span class="agent__suggest-ic" aria-hidden="true">' + icon(s[3]) + "</span>" +
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
  // Столько пикселей до низа считаем «резким прыжком»: дальше доводим
  // плавно, рядом с краем — мгновенно (иначе каждый кадр перезапускал бы
  // плавную прокрутку и текст дёргался).
  var SMOOTH_FROM = 240;
  function scrollDown(force, smooth) {
    if (!ui.feed) return;
    if (!force && !S.stick) return;
    if (force) { S.stick = true; S.lock = Date.now() + 700; }
    var far = dist() > SMOOTH_FROM;
    var behavior = (smooth || far) && !calm() ? "smooth" : "auto";
    try { ui.feed.scrollTo({ top: ui.feed.scrollHeight, behavior: behavior }); }
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
    // На телефоне плашка меню раскрывается ПОД строкой (её видно целиком), и у
    // нижних строк списка снизу для неё места нет — тогда открываем вверх.
    // Меряем после показа: скрытый блок не имеет размеров.
    ctx.classList.remove("up");
    var listBox = ui.list ? ui.list.getBoundingClientRect() : null;
    if (listBox) {
      var rowBox = row.getBoundingClientRect();
      if (rowBox.top + ctx.offsetHeight > listBox.bottom - 4) ctx.classList.add("up");
    }
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
      // Корзина, а не крестик: «×» рядом с «Открыть чат» читался как «закрыть
      // панель» (та же путаница, что была с кнопкой удаления в подвале рейла).
      ctx.appendChild(ctxItem("Удалить чат", svgRaw(TRASH_D, "2.2"), "agent__ctx-item--danger", function () { deleteThread(t.id); }));
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
    cacheThreads(S.threads);           // заголовок из первого сообщения — тоже в кэш
    renderThreads();
    var cur = currentThread();
    if (cur && ui.title) ui.title.textContent = cur.title || "Новый чат";
  }
  function selectThread(id) {
    var prev = S.currentId;
    S.navGen++;
    var leaving = Number(prev) !== Number(id);
    // Свой же тред не абортим: иначе клик по текущему чату убивал бы ход.
    if (leaving && S.abort) { try { S.abort.abort(); } catch (_) {} S.abort = null; }
    // Недопечатанный ответ доигрываем разом.
    if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
    // Уходим в другой чат — его ход закрыт (fetch оборван, ответ допишется в
    // базу и появится, когда чат откроют снова). Остаёмся в том же — ход
    // доживает: S.turn нельзя терять, иначе следующий маунт/guard оборвёт
    // запрос и ученик получит «Нет соединения» вместо ответа.
    if (leaving) S.turn = null;
    else if (S.turn && !S.turn.dead) S.turn.detached = true;
    S.printing = false;
    syncBusy();
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
  /* ---------- кэш раздела ----------
     Тот же приём, что на остальных экранах (AdminInbox): данные живут в
     состоянии модуля, привязаны к аккаунту и при возврате на раздел рисуются
     сразу, а сеть только тихо сверяет их на фоне. Без этого каждый переход
     «Путь → ИИ → Путь → ИИ» начинался с пустой колонки и загрузки. */
  function cacheOn() { return S.cache && S.cache.accountId === S.accountId; }
  function cacheHasThreads() { return cacheOn() && Array.isArray(S.cache.threads) && S.cache.threads.length > 0; }
  function cacheDrop() { S.cache = { accountId: S.accountId, threads: null, messages: {} }; }
  function cacheThreads(list) { if (!cacheOn()) cacheDrop(); S.cache.threads = list; }
  function cachedMessages(id) {
    if (!cacheOn() || id == null) return null;
    var hit = S.cache.messages[id];
    return hit && Array.isArray(hit.msgs) ? hit.msgs : null;
  }
  function cacheMessages(id, msgs) {
    if (id == null) return;
    if (!cacheOn()) cacheDrop();
    S.cache.messages[id] = { msgs: msgs, at: Date.now() };
    var keys = Object.keys(S.cache.messages);
    if (keys.length <= MAX_CACHED_THREADS) return;
    keys.sort(function (a, b) { return S.cache.messages[a].at - S.cache.messages[b].at; });
    for (var i = 0; i < keys.length - MAX_CACHED_THREADS; i++) delete S.cache.messages[keys[i]];
  }
  function sameMessages(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = a.length - 1; i >= 0; i--) {
      if (Number(a[i].id) !== Number(b[i].id) || a[i].role !== b[i].role) return false;
    }
    return true;
  }
  // После хода переписку в кэше больше не переписываем вручную (ответ пришёл
  // одним куском JSON) — просто выбрасываем: иначе возврат на раздел показал
  // бы историю без последнего ответа, пока сеть догоняет.
  function cacheForget(id) {
    if (S.cache && S.cache.messages && id != null) delete S.cache.messages[id];
  }
  /* Экранная анимация приложения (та же, что на остальных разделах) держится
     до ответа списка чатов: раньше кадр рисовался сразу и человек видел
     «Здесь пока пусто» вместо загрузки. Своего лоадера у раздела нет. */
  function screenLoader(sub) {
    if (!root) return;
    try {
      if (typeof loaderHTML === "function") root.innerHTML = loaderHTML(sub || "Открываем чаты…");
    } catch (_) {}
  }
  /* Пока едет переписка открытого чата, колонка не должна быть пустой — но и
     пустой блок показывать рано: про него ещё неизвестно, пуст ли чат. */
  function feedLoader(sub) {
    if (!ui.live) return;
    try {
      if (typeof loaderHTML !== "function") return;
      clearFeed();
      var box = el("div", "agent__boot");
      box.innerHTML = loaderHTML(sub || "Читаем переписку…");
      ui.live.appendChild(box);
      showEmpty(false);
    } catch (_) {}
  }
  function selectCurrentThread() {
    var want = readDeepLink();
    var exists = want && S.threads.some(function (t) { return Number(t.id) === Number(want); });
    if (exists) { selectThread(want); return; }
    if (want) {
      try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
      S.currentId = null;
    }
    if (S.threads.length) selectThread(S.threads[0].id);
    else selectThread(null);
  }
  function loadThreads(cb) {
    var g = S.mountGen;
    // Скелетон списка — только когда показывать нечего: при кэше он бы стёр
    // готовые строки на ровном месте (а на холодном входе каркаса ещё нет,
    // и ui.list пуст — скелетон просто некуда).
    if (ui.list && !cacheHasThreads()) renderThreadsSkeleton();
    return api("GET", "/api/agent/threads").then(function (res) {
      if (g !== S.mountGen) return null;
      if (res.status === 200 && res.data && Array.isArray(res.data.threads)) {
        S.threads = res.data.threads;
        if (res.data.quota) setQuota(res.data.quota);
        cacheThreads(res.data.threads);
        if (cb) { cb(true); return res.data.threads; }
        renderThreads();
        // Чат мог быть удалён с другого устройства — тогда переезжаем.
        if (S.currentId == null || !S.threads.some(function (t) { return Number(t.id) === Number(S.currentId); })) {
          selectCurrentThread();
        }
        return res.data.threads;
      }
      if (handleAuthError(res)) { if (cb) cb(false); return null; }
      if (ui.list) ui.list.textContent = "";
      if (cb) cb(false);
      else errorCard("Не удалось загрузить чаты.", "Попробовать снова", function () { loadThreads(); });
      return null;
    }).catch(function () {
      if (g !== S.mountGen) return null;
      if (ui.list) ui.list.textContent = "";
      if (cb) cb(false);
      else errorCard("Нет соединения.", "Попробовать снова", function () { loadThreads(); });
      return null;
    });
  }
  function createThread() {
    if (S.creating) return S.creating;
    S.creating = api("POST", "/api/agent/threads", {}).then(function (res) {
      if (res.status === 200 && res.data && res.data.thread) {
        S.threads.unshift(res.data.thread);
        cacheThreads(S.threads);          // новый чат сразу виден и в кэше раздела
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
      cacheForget(t.id);
      S.threads = S.threads.filter(function (x) { return Number(x.id) !== Number(t.id); });
      cacheThreads(S.threads);          // удалённый чат не должен вернуться из кэша
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
  /* ---------- печать ответа ----------
     Приём взят с лендинга ([data-type] в main.html) — режим fade: слова
     проявляются на месте. Первый вариант был по режиму mask (слово выезжает
     из-под обрезающей маски) и с курсором; обе вещи оказались плохими:
     маска с overflow резала глифы по горизонтали, а курсор не удавалось
     положить ВНУТРЬ строки (insertBefore с соседним узлом маски кидал его
     в конец абзаца, где он вставал отдельной строкой — синяя полоска под
     текстом и +23px высоты, которые исчезали в конце печати: экран дёргался
     дважды на ход). Теперь в печати нет ничего, что меняет раскладку:
     слова — обычные инлайн-блоки с opacity/transform, DOM собирается один
     раз, дальше на слово вешается класс. */
  /* ---------- markdown ответа ----------
     Модель отвечает markdown (**жирный**, списки, `код`); рендерят его
     библиотеки из vendor/md (marked + DOMPurify), а не самописный парсер.
     HTML проходит через DOMPurify, поэтому innerHTML здесь безопасен;
     без санитайзера или без marked — откат на обычный текст. */
  function mdBlocks(finalText) {
    var text = String(finalText || "");
    if (!text.trim()) return [];
    var html = null;
    if (window.marked && typeof window.marked.parse === "function") {
      try {
        var raw = window.marked.parse(text, { gfm: true, breaks: true });
        html = window.DOMPurify
          ? window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
          : null;                 // без санитайзера чужой HTML не вставляем
      } catch (_) { html = null; }
    }
    if (!html) {
      var paras = [];
      text.split(/\n\n+/).forEach(function (para) {
        if (para.trim()) paras.push(el("p", "agent__answer", para.trim()));
      });
      return paras;
    }
    /* Один элемент на узел верхнего уровня (абзац, список, цитата), а не весь
       ответ одним блоком: блоки дописываются в ленту по одному, и пустое
       будущее никогда не занимает больше текущего абзаца. Раньше весь ответ
       лежал одним .agent__md — park отрабатывал один раз на старте (а поднять
       первую строку к краю тогда физически нельзя: выше начала контента уйти
       некуда), и дальше вьюпорт стоял и показывал сотни пикселей
       ненапечатанного на все секунды печати. */
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var out = [];
    Array.prototype.forEach.call(tmp.childNodes, function (node) {
      if (node.nodeType === 3) {
        if (!node.nodeValue || !node.nodeValue.trim()) return;
        out.push(el("p", "agent__answer", node.nodeValue.trim()));
        return;
      }
      if (node.nodeType !== 1) return;
      if (!node.textContent || !node.textContent.trim()) return;  // пустые <p></p> от разметки
      var box = el("div", "agent__answer agent__md");
      box.setAttribute("data-md", "1");
      box.appendChild(node);
      out.push(box);
    });
    if (!out.length) return [el("p", "agent__answer", text.trim())];
    return out;
  }
  /* Печать готового DOM: оборачиваем слова текстовых узлов в те же
     .agent__ww, что и buildTyped, — раскладка и темп не меняются. */
  function buildTypedDom(root) {
    var words = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
        var word = el("span", "agent__ww", part);
        frag.appendChild(word);
        words.push(word);
      });
      node.parentNode.replaceChild(frag, node);
    });
    return words;
  }
  function buildTyped(p, text) {
    p.textContent = "";
    var words = [];
    String(text).split("\n").forEach(function (line) {
      var row = el("span", "agent__wl");
      line.split(" ").forEach(function (w, i) {
        if (!w) return;                       // подряд идущие пробелы схлопнутся сами
        if (i) row.appendChild(document.createTextNode(" "));   // разделитель между словами
        var word = el("span", "agent__ww", w);
        row.appendChild(word);
        words.push(word);
      });
      p.appendChild(row);
    });
    return words;
  }
  /* Лента идёт вровень с ПЕЧАТАЮЩИМСЯ текстом, а не с его концом. Абзац
     занимает финальную высоту с первого кадра (все слова в DOM, невидимые —
     opacity), поэтому прыжок «в самый низ» на только что дописанном абзаце
     показывал пустое место будущих слов на все секунды печати: сайт кидал в
     конец сообщения, которого ещё не было. Настоящий низ написанного —
     нижняя граница последнего ПРОЯВИВШЕГОСЯ слова: её держим у края ленты
     (PRINT_GAP от низа). Слово уже видно — стоим. Вверх не тянем (человек
     ушёл читать — S.stick снят), шаг ограничен, чтобы длинная строка не
     прыгала кадрами. Программный скролл держит S.lock, иначе обработчик
     scroll принял бы наше же движение за «человек ушёл вверх» и снял бы
     S.stick посреди печати. */
  var PRINT_GAP = 18;
  /* Плавная доводка за печатью. Слова проявляются каждые 24–45 мс, и прямой
     scrollTop += на каждое слово давал микродёрганье — глаз видит отдельные
     рывки. Вместо этого слово лишь двигает ЦЕЛЬ (S.printTarget), а один rAF-
     цикл тянет ленту к цели (~22% дистанции за кадр): рывки сливаются в ровное
     движение с лёгким отставанием от рубежа печати. Цикл один на весь ответ;
     спокойный режим (calm) — мгновенно, без анимации. Все программные записи
     идут через progWrite, который запоминает выставленное значение: по нему
     scroll-хендлер отличает нашу доводку от руки человека. */
  function progWrite(v) { S.progTop = v; ui.feed.scrollTop = v; }
  function printGlideTo(top) {
    if (!ui.feed) return;
    S.printTarget = Math.max(0, Math.min(top, ui.feed.scrollHeight));
    if (calm()) { progWrite(S.printTarget); S.printTarget = null; return; }
    if (!S.gliding || S.glideFeed !== ui.feed) {
      S.gliding = true; S.glideFeed = ui.feed;
      raf(printGlideTick);
    }
  }
  function printGlideTick() {
    var feed = S.glideFeed;
    if (!feed || feed !== ui.feed || !S.follow || S.printTarget == null) { S.gliding = false; return; }
    var d = S.printTarget - feed.scrollTop;
    if (Math.abs(d) <= 1) { S.printTarget = null; S.gliding = false; return; }
    progWrite(feed.scrollTop + d * 0.22);
    raf(printGlideTick);
  }
  function glideStop() { S.printTarget = null; }
  function followPrint(word) {
    if (!word || !ui.feed || !S.follow) return;
    var fr = ui.feed.getBoundingClientRect(), wr = word.getBoundingClientRect();
    // Слово ушло под край ленты — цель доводки двигается так, чтобы слово
    // встало на PRINT_GAP от низа. Слово видно — ничего не делаем.
    var need = wr.bottom - (fr.bottom - PRINT_GAP);
    if (need <= 4) return;
    printGlideTo(ui.feed.scrollTop + Math.min(need, Math.round(fr.height * 0.6)));
  }
  /* Начало абзаца: первая строка встаёт на линию печати (низ ленты минус
     PRINT_GAP) — сразу, а не когда печать до неё доползёт. Абзац дописан
     целиком (все слова уже в DOM), поэтому любая другая стоянка показывает
     пустоту будущих слов: верх абзаца вверху ленты — сотни пикселей пустоты
     под написанным на все секунды печати (замер: зазор 400px, вьюпорт стоит),
     прыжок в самый низ — ту же пустоту. Дальше печать ведёт followPrint.
     Ушёл читать (S.stick снят) — не трогаем. Маленькие доводки мгновенные,
     большие (>120px) — плавным glide: он и есть «ехать вместе», а дёрганья
     нет, потому что followPrint во время glide молчит (слово ещё выше края).
     Верх виден и почти на линии (первые 160px сверху) — стоим: печать сама
     спустится к краю за секунду, дёргать ленту ради неё незачем. */
  function parkParagraph(p) {
    if (!ui.feed || !S.follow || !p) return;
    var fr = ui.feed.getBoundingClientRect(), pr = p.getBoundingClientRect();
    // Первая строка абзаца должна встать на линию печати.
    var targetTop = fr.bottom - PRINT_GAP - Math.min(pr.height, 28);
    var delta = pr.top - targetTop;
    // На линии (или чуть ниже — доклеит followPrint) либо чуть выше (печать
    // сама спустится к краю): стоим.
    if (delta <= 4 && delta >= -160) return;
    printGlideTo(ui.feed.scrollTop + delta);
  }
  // Темп под длину: короткий ответ печатается внятно, длинный не растягивается
  // на полминуты (шаг 900 мс на весь текст, но не медленнее 24 и не быстрее 45).
  function printPara(p, isAlive, done) {
    if (calm()) { if (done) done(); return; }   // контент уже собран в p
    var words = p.getAttribute && p.getAttribute("data-md") ? buildTypedDom(p) : buildTyped(p, p.textContent);
    p.classList.add("typing");
    var step = Math.max(24, Math.min(45, Math.round(900 / Math.max(1, words.length))));
    var i = 0;
    (function tick() {
      if (!isAlive()) {                       // ход перебит/размонтирован — дорисовываем текст
        p.classList.remove("typing");
        words.forEach(function (w) { w.classList.add("is-in"); });
        return;
      }
      if (i >= words.length) {
        p.classList.remove("typing");
        if (done) done();
        return;
      }
      words[i].classList.add("is-in");
      followPrint(words[i]);
      i++;
      later(step, tick);
    })();
  }
  /* ---------- кнопки-продолжения под ответом ----------
     Названия и текст приходят от модели (сервер вырезает служебный блок
     ```suggest из ответа и отдаёт готовые {label, ask}), поэтому кнопки
     контекстные: под разбором ошибок — «разбери ошибку», под прогнозом —
     «что подтянуть». Были две заглушки «Хочу разбор»/«Что дальше?» — они не
     имели отношения ни к ответу, ни к вопросу человека.

     Нажатие: кнопка уходит (схлопывается по ширине), соседние уезжают на её
     место, и сразу уходит тот вопрос, который модель положила внутрь,
     короткое название кнопки в чат не отправляется. Фокус с кнопки снимаем
     руками: остаточная обводка после нажатия выглядела как «кнопка ещё
     нажата».
     Значки разные по позиции, как в эталоне. */
  var SUGGEST_ICONS = [ICON_TASKS, ICON_HELP, ICON_TASKS];
  // Зазор .agent__actions (gap), который схлопывание гасит вместе с шириной.
  var GUTTER_PX = 8;
  // Нормализация серверного списка (структура, не содержимое): слова модели
  // проходят как есть — хоть «я умный». Пустой список и null/undefined значат
  // одно и то же: кнопок нет, подстановки не будет.
  function normalizeSuggests(raw) {
    var out = [];
    (raw || []).forEach(function (s) {
      if (!s) return;
      var label, ask;
      if (typeof s === "string") { ask = s; label = s.slice(0, 28); }
      else { ask = s.ask || s.text || ""; label = s.label || String(ask).slice(0, 28); }
      ask = String(ask).trim();
      if (!ask) return;
      out.push({ label: String(label).trim() || ask.slice(0, 28), ask: ask });
    });
    return out.slice(0, 3);
  }
  // Схлопнуть кнопку по ширине и убрать: соседние уезжают на её место плавно
  // (ширина и отступ анимируются, а не прыгают).
  function collapseAsk(btn) {
    if (!btn || btn.classList.contains("is-gone")) return;
    btn.classList.add("is-gone");
    btn.setAttribute("aria-hidden", "true");
    try { btn.disabled = true; } catch (_) {}
    if (calm()) { if (btn.parentNode) btn.parentNode.removeChild(btn); return; }
    var w = btn.offsetWidth;
    // Ширину и отступ фиксируем в px, чтобы переход шёл от реального размера:
    // flex-элемент без явной ширины анимировать нечем.
    btn.style.width = w + "px";
    btn.style.marginRight = GUTTER_PX + "px";
    void btn.offsetWidth;
    btn.style.width = "0px";
    btn.style.marginRight = "0px";
    later(320, function () { if (btn.parentNode) btn.parentNode.removeChild(btn); });
  }
  function quickActions(card, isAlive, suggests) {
    var list = normalizeSuggests(suggests);
    if (!list.length) return null;
    var row = el("div", "agent__actions");
    list.forEach(function (q, i) {
      var b = el("button", "agent__qr");
      b.type = "button";
      try { b.style.setProperty("--i", String(i)); } catch (_) { b.setAttribute("style", "--i:" + i); }
      b.setAttribute("data-ask", q.ask);
      b.setAttribute("aria-label", q.label + ": " + q.ask);
      b.appendChild(svgIcon(SUGGEST_ICONS[i % SUGGEST_ICONS.length], "2.2"));
      b.appendChild(document.createTextNode(q.label));
      b.addEventListener("click", function () {
        // Ход уже идёт — кнопка не должна исчезать впустую: сервер не примет
        // второй вопрос, и человек остался бы без вариантов продолжения.
        if (S.busy) return;
        // Фокус снимаем сами: иначе после ухода кнопки браузер оставлял
        // обводку на пустом месте (было видно как «залипшая» кнопка).
        try { b.blur(); } catch (_) {}
        collapseAsk(b);
      });
      row.appendChild(b);
    });
    card.appendChild(row);
    if (isAlive) follow(350);
    return row;
  }
  /* Копирование ответа — своей кнопкой ПОД ответом, а не в меню по
     удержанию: на телефоне меню надо ещё дождаться, а кнопку видно сразу и
     промахнуться по ней нельзя. Текст берём сырым (data-answer), чтобы в
     буфер ушли markdown и списки, а не текст отрендеренного HTML. */
  function addCopyRow(card) {
    if (!card || !card.querySelector(".agent__answer")) return null;
    var row = el("div", "agent__copy-row");
    var btn = el("button", "agent__copy", null);
    btn.type = "button";
    var lbl = el("span", "agent__copy-lbl", "Скопировать");
    btn.appendChild(svgIcon(ICON_COPY, "2.2"));
    btn.appendChild(lbl);
    btn.addEventListener("click", function () {
      var text = answerText(card);
      if (!text) { say("Нечего копировать"); return; }
      copyText(text);
      // Короткое подтверждение прямо на кнопке: тост про то, что копия ушла,
      // здесь лишний (копирование — обычное дело, а не событие).
      if (btn.classList.contains("is-done")) return;
      btn.classList.add("is-done");
      lbl.textContent = "Скопировано";
      later(1600, function () {
        if (!btn.parentNode) return;
        btn.classList.remove("is-done");
        lbl.textContent = "Скопировать";
      });
    });
    row.appendChild(btn);
    card.appendChild(row);
    return row;
  }
  // Подпись ответ + кнопки-продолжения + копирование — в одном месте, чтобы
  // порядок не разъезжался между ветками анимации и истории.
  function cardFooter(card, isAlive, asks) {
    var row = quickActions(card, isAlive, asks);
    addCopyRow(card);
    return row;
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
      // Доводка заканчивается ДО первого абзаца (write на 420 мс): иначе цикл
      // follow тянул бы ленту в самый низ полного (ещё не напечатанного)
      // абзаца и спорил бы с parkParagraph за скролл.
      follow(350);
      later(quiet ? 0 : 420, write);
    }
    function write() {
      if (!alive()) return;
      if (!paras.length) { actions(); return; }
      var p = paras.shift();
      card.appendChild(p);
      // Раскладка абзаца готова с первого кадра (все слова в DOM), поэтому
      // подводим ленту один раз — к началу абзаца, а по ходу печати она идёт
      // за последним проявившимся словом (followPrint).
      beginPrinting();
      parkParagraph(p);
      printPara(p, alive, function () { later(quiet ? 0 : 140, write); });
    }
    function actions() {
      if (!alive()) return;
      // Кнопки рисуем один раз на карточку: bail() может позвать actions()
      // повторно, а второй набор на той же карточке — это дубль кнопок.
      if (!built.actions) {
        built.actions = cardFooter(card, alive, built.suggests) || true;
      }
      // Ход доигран целиком: карточку больше нечего дорисовывать, и новый
      // ход не должен трогать её шаги (иначе у пользователя сбросится
      // раскрытое «Подробнее»).
      finished = true;
      if (S.pendingBail === bail) S.pendingBail = null;
      syncBusy();          // ответ дописан — композер снова свободен
      follow(350);
    }
    // Новый ход перебил незаконченный: дорисовываем остаток разом, карточка
    // не должна остаться с лоадером или с полупустым блоком шага.
    function bail() {
      if (stopped || finished) return;
      stopped = true;
      glideStop();
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
  function assistantCard(steps, finalText, animate, suggests) {
    var g = S.mountGen;
    var card = el("article", "agent__ai");
    if (finalText) card.setAttribute("data-answer", String(finalText));   // сырой markdown для «Скопировать»
    var built = renderSteps(card, steps);
    var paras = finalText ? mdBlocks(finalText) : [];
    if (g !== S.mountGen || !ui.live) return card;
    ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    if (built) built.card = card;
    /* Кнопки-продолжения — только слова модели из suggests (сервер вырезал
       служебный блок ```suggest и хранит список рядом с ответом). Нет списка —
       нет кнопок: дежурный набор был бы заглушкой, не имеющей отношения
       к ответу. Пустой массив и null/undefined — одно и то же. */
    var asks = normalizeSuggests(suggests);
    if (built) built.suggests = asks;
    function paintAll() {
      if (built) built.prepped.forEach(function (p) { built.ol.appendChild(p.li); stepFill(p); });
      paras.forEach(function (p) { card.appendChild(p); });
    }
    // История (animate=false) рисуется сразу целиком: после перезагрузки
    // анимировать уже полученный ответ незачем.
    if (!animate) {
      if (built) {
        if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
        syncBusy();
        paintAll();
        // Лента появляется раскрытой и тут же сворачивается: кадр между
        // ними делает сворачивание плавным, без мигания тоггла.
        built.trace.classList.add("open");
        raf(function () { built.trace.classList.remove("open"); card.classList.add("done"); });
        // Кнопки и у истории с шагами: раньше эта ветка их не рисовала вовсе,
        // и после перезагрузки продолжение было только у ответов без шагов.
        cardFooter(card, null, asks);
        scrollDown(true, true);
      } else {
        if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
        syncBusy();
        paras.forEach(function (p) { card.appendChild(p); });
        cardFooter(card, null, asks);
        scrollDown(true, true);
      }
      return card;
    }
    // Незаконченная анимация прошлого хода — дорисовать разом, иначе она
    // будет мешать новой (у обеих один токен S.animGen).
    if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
    if (built) {
      // revealTurn сам собирает bail (built.bail) — блокировку печати ставим
      // сразу за ним, в том же кадре: между этими строками браузер не рисует.
      revealTurn(built, paras, g);
      S.pendingBail = built.bail;
      syncBusy();
      return card;
    }
    // Ответ без шагов (короткий ход: поздороваться, уточнить) печатается
    // так же, как после шагов. Раньше он выпадал разом — и именно это
    // выглядело «дёргано»: у человека глаз уже привык к печати по ходу.
    var ag = ++S.animGen, stopped = false;
    function alive() { return !stopped && g === S.mountGen && ag === S.animGen && card.parentNode; }
    // Свой bail: «Стоп»/новый ход во время печати выкладывают остаток разом.
    function bailPlain() {
      if (stopped) return;
      stopped = true;
      glideStop();
      paras.forEach(function (p) { if (!p.parentNode) card.appendChild(p); p.classList.remove("typing"); });
      scrollDown(true, false);
    }
    S.pendingBail = bailPlain;      // своя блокировка печати (общая уже снята выше)
    (function next() {
      if (!alive()) return;
      if (!paras.length) {
        cardFooter(card, alive, asks);
        S.pendingBail = null;
        syncBusy();
        return;
      }
      var p = paras.shift();
      card.appendChild(p);
      beginPrinting();
      parkParagraph(p);
      printPara(p, alive, function () { later(calm() ? 0 : 140, next); });
    })();
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
  // Отрисовка переписки из готового массива: кэш раздела и ответ сервера идут
  // в одну функцию, иначе кэш и сеть рисовали бы по-разному.
  function paintMessages(msgs) {
    clearFeed();
    if (!msgs || !msgs.length) { showEmpty(true); return; }
    var pending = [];
    // Кнопки-продолжения — только у ПОСЛЕДНЕГО ответа: в переписке они
    // относятся к тому, что на экране сейчас, и у каждого старого ответа
    // рисовать свои варианты значило бы превратить ленту в поле кнопок.
    // Варианты — сохранённые слова модели (suggests из базы): история
    // показывает те же кнопки, что были вживую. Нет сохранённых — нет
    // кнопок, а не дежурный набор.
    var groups = [];
    function flushSteps(finalText, suggests) {
      if (!pending.length && !finalText) return;
      groups.push({ steps: pending.splice(0, pending.length), final: finalText || null,
                    suggests: suggests || [] });
    }
    msgs.forEach(function (m) {
      if (m.role === "user") { flushSteps(null); userBubble(m.content || ""); }
      else if (m.role === "assistant" && (m.content || "").trim()) flushSteps(m.content, m.suggests);
      else if (m.role === "tool") {
        pending.push({ id: m.id, tool: m.tool, args: m.args, result: m.result,
                       label: (m.tool || "Шаг"), kind: "read", status: m.status, proposal: m.result });
      }
    });
    flushSteps(null);
    if (groups.length) {
      // История открывается сразу целиком, без анимации.
      groups[groups.length - 1].last = true;
      groups.forEach(function (g) { assistantCard(g.steps, g.final, false, g.last ? g.suggests : []); });
    }
    showEmpty(false);
    scrollDown(true, false);
  }
  function loadThreadMessages() {
    var g = S.mountGen;
    var wantId = S.currentId;
    if (wantId == null) { clearFeed(); showEmpty(true); return; }
    // Кэш рисуется мгновенно, сеть не ждём; без кэша — экранная анимация
    // внутри ленты (не пустой блок: про emptiness ещё не знаем).
    var cached = cachedMessages(wantId);
    if (cached) paintMessages(cached);
    else feedLoader("Читаем переписку…");
    return api("GET", "/api/agent/threads/" + wantId).then(function (res) {
      if (g !== S.mountGen || wantId !== S.currentId) return;
      if (res.status === 200 && res.data && Array.isArray(res.data.messages)) {
        var msgs = res.data.messages;
        cacheMessages(wantId, msgs);
        // Ничего не изменилось — не перерисовываем: у человека останутся
        // раскрытые «Подробнее» и позиция ленты.
        if (!sameMessages(cached, msgs)) paintMessages(msgs);
        reattachTurn();
        return;
      }
      if (res.status === 404) {
        try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
        cacheForget(wantId);
        S.threads = S.threads.filter(function (x) { return Number(x.id) !== Number(wantId); });
        cacheThreads(S.threads);
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
      if (!cached) clearFeed();
      errorCard("Не удалось открыть чат.", "Попробовать снова", function () { loadThreadMessages(); });
      reattachTurn();
    }).catch(function () {
      if (g === S.mountGen) {
        if (!cached) clearFeed();
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
  /* Ход «в процессе» — это ИЛИ запрос, который считает сервер, ИЛИ печать уже
     полученного ответа. Раньше флаг ставили и снимали руками в семи местах, и
     снимали слишком рано: ответ приходит из сети целиком (стриминга нет), а
     печать идёт ещё несколько секунд — композер успевал разблокироваться, и
     человек отправлял второе сообщение, пока первое ещё дописывалось (а
     «Стоп» исчезал уже после первого шага). Теперь флаг ВЫВОДИТСЯ из
     состояния: держат либо живой запрос (S.turn), либо недопечатанный ответ
     (S.pendingBail). Отвязанный «Стоп»-ом запрос (detached) держит уже не
     композер, а только подхват ответа после обрыва. */
  function turnHeld() {
    return (!!S.turn && !S.turn.dead && !S.turn.detached) || !!S.pendingBail;
  }
  function syncBusy() {
    var held = turnHeld();
    S.busy = held;
    if (!held) S.printing = false;
    if (ui.input) {
      ui.input.setAttribute("placeholder", S.printing ? "Наставник пишет ответ…"
        : (held ? "Наставник отвечает…" : "Спроси что-нибудь…"));
    }
    syncInput();
  }
  // Ответ получен, печать ещё идёт: композер остаётся закрытым до её конца.
  function beginPrinting() { S.printing = true; syncBusy(); }
  function send(text, opts) {
    text = (text || "").trim();
    if (!text || S.busy) return;
    var force = !!(opts && opts.force);
    var quiet = !!(opts && opts.quiet);      // невидимый повтор сервера
    // Отправка из «Изменить и отправить» всегда заменяет последний вопрос.
    var replaceLast = !!((opts && opts.replaceLast) || editTarget !== null);
    editTarget = null;
    // Явный вопрос — человек хочет ответ: следование включается заново.
    // Невидимый повтор (quiet) идёт фоном и чужой выбор «я ушёл читать» чтит.
    if (!quiet) { S.follow = true; S.printTarget = null; S.progTop = null; }
    if (!S.currentId) {
      var mg0 = S.mountGen;
      createThread().then(function (t) { if (t && S.mountGen === mg0) send(text, replaceLast ? { force: force, replaceLast: true } : opts); });
      return;
    }
    var g = ++S.navGen;
    var mg = S.mountGen;
    showEmpty(false);
    // Заменяющий ход: старая пара «вопрос+ответ» уходит из ленты СРАЗУ —
    // сервер снесёт её в базе только при успехе, но показывать и дубль,
    // и новый вопрос одновременно нельзя. При неуспехе failTurn вернёт
    // текст в поле, а переписка перечитается с сервера (она цела).
    if (replaceLast && !quiet) {
      var oldCard = lastAssistantCard();
      var oldBubble = lastUserBubble();
      if (oldCard && oldCard.parentNode) oldCard.parentNode.removeChild(oldCard);
      if (oldBubble && oldBubble.parentNode) oldBubble.parentNode.removeChild(oldBubble);
      cacheForget(S.currentId);
    }
    // Невидимый повтор: пузырёк, скелетон и вопрос уже на экране — второй раз
    // их не рисуем, иначе человек увидел бы дубль вопроса.
    var bubble = null;
    if (quiet && ui.live) {
      var users = ui.live.querySelectorAll(".agent__msg-user");
      bubble = users.length ? users[users.length - 1] : null;
    } else {
      bubble = userBubble(text);
    }
    if (!quiet && ui.input) { ui.input.value = ""; ui.input.style.height = "auto"; }
    if (!quiet) { try { localStorage.removeItem(draftKey()); } catch (_) {} }
    syncInput();
    // Скелетон рисуем и при невидимом повторе: свой прошлый уже снят вместе с
    // ошибкой, и человек должен видеть, что работа идёт.
    var skel = skeletonCard();
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    // Ход переживает перемонтирование экрана (render из соседней вкладки,
    // возврат из фона): промис один, обработчики цепляются заново.
    var turn = { threadId: S.currentId, text: text, ctrl: ctrl, promise: null,
                 startedAt: Date.now(), dead: false, claimedBy: -1, replaceLast: replaceLast,
                 retries: quiet ? (opts && opts.retries) || 0 : 0 };
    S.abort = ctrl;
    S.turn = turn;                 // держит композер до конца хода (см. turnHeld)
    var payload = { threadId: S.currentId, text: text };
    if (force) payload.force = true;
    if (replaceLast) payload.replaceLast = true;
    turn.promise = api("POST", "/api/agent/turns", payload, ctrl ? ctrl.signal : undefined);
    syncBusy();
    turn.promise.then(function (res) { settleTurn(turn, g, mg, skel, bubble, text, res); })
                .catch(function (e) { failTurn(turn, g, mg, skel, text, e); });
  }

  /* Невидимый повтор сбоя сервера. Живёт на клиенте, потому что к этому
     моменту сервер уже вернул 500/502/503/обрыв — своих попыток у него не
     осталось. Работает только для сбоев «попробуй ещё раз» (не для «вопрос
     плохой» и не для лимитов), только с текстом, который сервер уже видел, и
     не больше TURN_CLIENT_RETRIES раз. Ученик видит не ошибку, а чуть более
     долгое ожидание: пузырёк и скелетон на месте, ничего не мигает и не
     перерисовывается. */
  var TURN_CLIENT_RETRIES = 2, TURN_RETRY_DELAY_MS = 1200;
  function retrySilently(text, opts) {
    var mg = S.mountGen;
    var tryNo = ((opts && opts.retries) || 0) + 1;
    later(TURN_RETRY_DELAY_MS, function () {
      if (mg !== S.mountGen) return;
      // Повтор не должен обгонять живой ход: пока он идёт, вопрос уже
      // обрабатывается, и второй запрос сервер отвергнет как занятый.
      if (S.busy && S.turn && !S.turn.dead) { retrySilently(text, { retries: tryNo - 1 }); return; }
      send(text, { force: true, quiet: true, retries: tryNo,
                   replaceLast: !!(opts && opts.replaceLast) });
    });
  }
  // Подхват летящего хода после перемонтирования: те же обработчики,
  // новый пузырёк и скелетон, тот же промис (ответ не теряется).
  function reattachTurn() {
    var t = S.turn;
    if (!t || t.dead || t.claimedBy === S.mountGen) return;
    // Окно подхвата должно быть ЗАКАЛЮЧАТЕЛЬНЕЕ потолка хода на сервере
    // (90 с цикла + вызов финала): иначе ответ живого хода приходит в
    // обработчики прошлого монтажа, их токены уже не совпадают — и ход
    // пропадает молча, вместе с вопросом ученика.
    if (Date.now() - t.startedAt > REATTACH_MS) { if (S.turn === t) S.turn = null; return; }
    if (Number(t.threadId) !== Number(S.currentId)) return;
    t.claimedBy = S.mountGen;
    var g = ++S.navGen, mg = S.mountGen;
    syncBusy();
    showEmpty(false);
    var bubble = userBubble(t.text);
    var skel = skeletonCard();
    t.promise.then(function (res) { settleTurn(t, g, mg, skel, bubble, t.text, res); })
              .catch(function (e) { failTurn(t, g, mg, skel, t.text, e); });
  }
  /* Ответил ли сервер на этот вопрос. Ход живёт и после аборта на клиенте
     («Стоп», ушедшая сеть) — сервер считает его до конца, и тогда повторный
     вопрос вернул бы то же самое ещё за жетон. Поэтому перед повтором
     спрашиваем тред: если после нашего вопроса уже есть шаг или ответ —
     показываем готовое, а не спрашиваем заново. */
  function turnAnswered(tid, text) {
    if (tid == null) return Promise.resolve(false);
    return api("GET", "/api/agent/threads/" + Number(tid)).then(function (res) {
      if (res.status !== 200 || !res.data || !Array.isArray(res.data.messages)) return false;
      var msgs = res.data.messages, lastUser = -1, i;
      for (i = 0; i < msgs.length; i++) if (msgs[i].role === "user") lastUser = i;
      if (lastUser < 0) return false;
      if (text != null && (msgs[lastUser].content || "").trim() !== String(text).trim()) return false;
      return msgs.length - 1 > lastUser;   // после вопроса есть шаг или ответ
    }).catch(function () { return false; });
  }
  /* Дождаться ответа, который сервер считает после обрыва. Раньше здесь был
     один слепой setTimeout на 4 с: ход в 20 с успевал мимо, и человек оставался
     с лентой, где ответ так и не появился. Теперь смотрим тред несколько раз
     и останавливаемся, как только ответ (или шаг) появился. */
  function watchAnswer(tid, text, tries) {
    if (tid == null || tries <= 0 || Number(S.currentId) !== Number(tid)) return;
    if (S.busy) { later(WATCH_EVERY_MS, function () { watchAnswer(tid, text, tries); }); return; }
    turnAnswered(tid, text).then(function (answered) {
      if (Number(S.currentId) !== Number(tid)) return;
      if (answered) { loadThreadMessages(); return; }
      if (tries > 1) later(WATCH_EVERY_MS, function () { watchAnswer(tid, text, tries - 1); });
    });
  }
  function settleTurn(turn, g, mg, skel, bubble, text, res) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    turn.dead = true;
    if (S.turn === turn) S.turn = null;
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
    if (S.abort === turn.ctrl) S.abort = null;
    if (res.status === 200 && res.data) {
      if (res.data.quota) setQuota(res.data.quota);
      cacheForget(turn.threadId);        // переписка изменилась — кэш больше не её
      var steps = res.data.steps || [];
      if (res.data.pending) {
        assistantCard(steps.map(function (s) {
          return { id: s.id, tool: s.tool, args: s.args, label: s.label, kind: s.kind || "action",
                   status: "needs_confirm", proposal: s.proposal };
        }), null, true);
        say("Нужно подтверждение — нажми «Применить»");
      } else {
        assistantCard(steps, res.data.final || "", true, res.data.suggests);
      }
      if (res.data.thread) applyThreadTitle(res.data.thread);
      // Печать ответа держит композер закрытым (S.pendingBail) и снимет его
      // сама, когда допечатает последнее слово.
      return;
    }
    if (res.status === 400 && res.data && res.data.code === "AGENT_BUSY") {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      retryWhenFree(text, Math.max(1, Number(res.data.retryAfter) || 30));
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
    // Сбой модели на сервере — повторяем НЕВИДИМО: человек видит только более
    // долгое ожидание. Сервер уже сказал «попробуй ещё раз», своих попыток у
    // него не осталось, а у ученика жетон не списан (точка невозврата — после
    // записи ответа). Только эти статусы: 400/404/429 — не «сбой», а решение
    // сервера, повтор их не изменит.
    var retryable = res.status === 500 || res.status === 502 || res.status === 503;
    if (retryable && (turn.retries || 0) < TURN_CLIENT_RETRIES && S.currentId != null) {
      retrySilently(text, { retries: turn.retries || 0, replaceLast: turn.replaceLast });
      return;
    }
    // Заменяющий ход не записался: сервер старую пару НЕ сносил — вернём
    // ленту из базы, иначе вопрос и ответ пропадут с экрана.
    if (turn.replaceLast) loadThreadMessages();
    errorCard((res.data && res.data.error) || "Наставник не смог ответить.", "Попробовать снова",
      function () { send(text, turn.replaceLast ? { force: true, replaceLast: true } : { force: true }); });
    syncBusy();          // ни запроса, ни печати — композер разблокирован
  }
  /* AGENT_BUSY — не тупик: сервер сам сказал, через сколько освободится слот.
     Раньше здесь была только кнопка, и каждый клик до освобождения давал тот
     же 400 — вопрос застревал в ручном цикле «нажать ещё раз». Теперь ждём это
     время и повторяем сами; повтор по тому же тексту сервер отдаёт из кэша
     (без жетона), а если ход всё же не успел — это уже новый ход, как просил
     человек. Кнопка «сейчас» оставлена для нетерпеливых. */
  function retryWhenFree(text, wait) {
    var g = S.navGen, mg = S.mountGen;
    var left = Math.max(1, Math.min(180, wait || 1));
    var card = errorCard("Сервер ещё считает прошлый ответ — повторю через " + left + " с.");
    var label = card.querySelector(".agent__answer");
    var row = el("div", "agent__actions");
    var btn = el("button", "agent__qr", "Повторить сейчас");
    btn.type = "button";
    row.appendChild(btn);
    card.appendChild(row);
    var started = false;
    function fire() {
      if (started || g !== S.navGen || mg !== S.mountGen) return;
      if (S.busy) { say("Дождись текущего ответа"); return; }
      turnAnswered(S.currentId, text).then(function (answered) {
        if (g !== S.navGen || mg !== S.mountGen) return;
        started = true;
        // Ответ сервера уже есть — показываем его вместо нового вопроса.
        if (answered) { if (card.parentNode) card.parentNode.removeChild(card); loadThreadMessages(); return; }
        if (card.parentNode) card.parentNode.removeChild(card);
        send(text, { force: true });
      });
    }
    btn.addEventListener("click", fire);
    later(1000, function tick() {
      if (g !== S.navGen || mg !== S.mountGen) return;
      left -= 1;
      if (left > 0) {
        label.textContent = "Сервер ещё считает прошлый ответ — повторю через " + left + " с.";
        later(1000, tick);
        return;
      }
      fire();
    });
  }
  function failTurn(turn, g, mg, skel, text, e) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    if (e && e.name === "AbortError") {
      // Сервер ход не бросает: turn НЕ хороним — перемонтирование подхватит
      // тот же промис, ответ придёт в ленту сам.
      if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
      if (S.abort === turn.ctrl) S.abort = null;
      // Запрос отвязан от композера: ответ ещё придёт (watchAnswer), но человек
      // уже не должен ждать его гвоздя в поле ввода.
      turn.detached = true;
      syncBusy();
      errorCard("Остановлено. Если сервер уже считал ответ — он появится ниже.",
        "Обновить чат", function () { loadThreadMessages(); });
      watchAnswer(turn.threadId, text, WATCH_TRIES);
      return;
    }
    turn.dead = true;
    if (S.turn === turn) S.turn = null;
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
    if (S.abort === turn.ctrl) S.abort = null;
    syncBusy();
    // Ход перебит/размонтирован, повтор в воздухе. Обрыв соединения — тот же
    // сбой, что и 502: запрос мог не дойти, а мог дойти и потерять ответ. Обе
    // ветки лечит повтор: если сервер ход считает, ответ придёт кэшем или
    // через AGENT_BUSY, если не считает — это обычный вопрос.
    if ((turn.retries || 0) < TURN_CLIENT_RETRIES && S.currentId != null && online()) {
      retrySilently(text, { retries: turn.retries || 0, replaceLast: turn.replaceLast });
      return;
    }
    // Заменяющий ход не дошёл: старую пару клиент уже снял с ленты, а сервер
    // её НЕ сносил (снос — в транзакции успеха). Возвращаем ленту из базы.
    if (turn.replaceLast) loadThreadMessages();
    errorCard("Нет соединения. Текст цел — повтори, когда появится сеть.", "Попробовать снова",
      function () { send(text, turn.replaceLast ? { force: true, replaceLast: true } : { force: true }); });
  }
  function confirmStep(messageId, approve, btns) {
    var mg = S.mountGen;
    if (btns) btns.forEach(function (b) { b.disabled = true; });
    api("POST", "/api/agent/turns/confirm", { messageId: messageId, approve: !!approve }).then(function (res) {
      if (mg !== S.mountGen) return;
      if (res.status === 200 && res.data) {
        if (res.data.quota) setQuota(res.data.quota);
        cacheForget(S.currentId);
        if (res.data.approved === false) {
          assistantCard([], res.data.final || "Отменено учеником.", true, res.data.suggests);
        } else if (res.data.final) {
          assistantCard(res.data.steps || [], res.data.final, true, res.data.suggests);
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
      saveDraft();
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
    // Меню сообщения: ДОЛГОЕ нажатие (500 мс) на свой пузырёк или текст
    // ответа — как у списка чатов. Обычный клик/выделение текста не трогаем;
    // правый клик на десктопе — тот же вход в меню. Отмена: отпускание,
    // уход пальца, движение больше 8px.
    ui.feed.addEventListener("pointerdown", function (e) {
      var node = e.target.closest ? e.target.closest(".agent__msg-user, .agent__answer") : null;
      if (!node || !ui.feed.contains(node)) return;
      if (e.target.closest && (e.target.closest("button") || e.target.closest("a"))) return;
      var x = e.clientX || 0, y = e.clientY || 0;
      var pt = { clientX: x, clientY: y };
      function cancel() {
        if (msgMenu.timer) { try { clearTimeout(msgMenu.timer); } catch (_) {} msgMenu.timer = null; }
      }
      cancel();
      msgMenu.timer = setTimeout(function () {
        msgMenu.timer = null;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
        msgMenuFor(pt, node);
      }, 500);
      ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
        ui.feed.addEventListener(ev, cancel, { once: true, capture: true });
      });
      var move = function (mv) {
        if (!msgMenu.timer) { ui.feed.removeEventListener("pointermove", move); return; }
        if (Math.abs((mv.clientX || 0) - x) > 8 || Math.abs((mv.clientY || 0) - y) > 8) {
          cancel();
          ui.feed.removeEventListener("pointermove", move);
        }
      };
      ui.feed.addEventListener("pointermove", move);
    });
    ui.feed.addEventListener("contextmenu", function (e) {
      var node = e.target.closest ? e.target.closest(".agent__msg-user, .agent__answer") : null;
      if (!node || !ui.feed.contains(node)) return;
      e.preventDefault();
      msgMenuFor(e, node);
    });
    // Один раз на документ (маунтов экрана может быть много): при отсутствии
    // меню обработчики ничего не делают. Любой тап в другом месте — закрыть.
    if (!msgMenu.wired) {
      msgMenu.wired = true;
      document.addEventListener("pointerdown", function (e) {
        if (msgMenu.node && !msgMenu.node.contains(e.target)) closeMsgMenu();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeMsgMenu();
      });
    }
    ui.feed.addEventListener("scroll", function () { closeMsgMenu(); }, { passive: true });
    ui.stopBtn.addEventListener("click", function () {
      // «Стоп» работает на обоих этапах хода. Пока считает сервер — обрываем
      // запрос; пока печатается уже полученный ответ — выкладываем остаток
      // текста разом (bail), потому что останавливать тут нечего.
      var turn = S.turn;
      var text = turn && !turn.dead ? turn.text : null;
      var tid = turn && !turn.dead ? turn.threadId : S.currentId;
      if (S.pendingBail) {
        var bail = S.pendingBail;
        S.pendingBail = null;
        try { bail(); } catch (_) {}
      } else if (turn && !turn.dead) {
        turn.detached = true;   // композер разблокируется, ответ ещё подхватим
        if (S.abort) { try { S.abort.abort(); } catch (_) {} }
      }
      S.printing = false;
      syncBusy();
      if (!S.pendingBail) watchAnswer(tid, text, WATCH_TRIES);
    });
    ui.feed.addEventListener("scroll", function () {
      if (Date.now() > S.lock) S.stick = dist() < 120;
      // Вернулся к самому низу во время хода — снова едем вместе с текстом.
      // (Уход вверх ловится ниже по wheel/touch: сам scroll отличить не может —
      // программная доводка тоже двигает ленту.)
      if (S.busy && !S.follow && dist() < 120) S.follow = true;
      if (ui.downBtn) ui.downBtn.classList.toggle("show", dist() > 200);
    });
    // Рука человека во время хода: колесо/палец вверх — «я почитаю выше»,
    // дальше печать идёт без доводки. Программные скроллы таких событий не
    // дают, только живой жест, поэтому путать не с чем.
    ui.feed.addEventListener("wheel", function (e) {
      if (S.busy && e.deltaY < 0) S.follow = false;
    }, { passive: true });
    var touchY = null;
    ui.feed.addEventListener("touchstart", function (e) {
      try { touchY = e.touches[0].clientY; } catch (_) { touchY = null; }
    }, { passive: true });
    ui.feed.addEventListener("touchmove", function (e) {
      if (!S.busy || touchY == null) return;
      try {
        if (e.touches[0].clientY > touchY + 8) S.follow = false;  // палец вниз = лента вверх
        touchY = e.touches[0].clientY;
      } catch (_) {}
    }, { passive: true });
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
        // Развернутая лента шагов вытолкнула ответ вниз: если он и так был у
        // нижнего края, плавно доводим ленту за растущим блоком (как в
        // эталоне) — иначе открытые шаги оказываются за краем экрана.
        if (open && dist() < 200) later(380, function () { scrollDown(true, true); });
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
    var mg = S.mountGen;
    // Ссылки на узлы прошлого маунта выбрасываем сразу: до buildLayout каркаса
    // ещё нет, и старые (уже отсоединённые роутером) узлы принимать нельзя —
    // иначе скелетон/очистка списка уехали бы в никуда.
    ui = {};
    // Летящий ход не рвём: его fetch переживает маунт, reattachTurn подхватит.
    if (S.abort && (!S.turn || S.turn.dead || S.abort !== S.turn.ctrl)) {
      try { S.abort.abort(); } catch (_) {}
      S.abort = null;
    }
    (S.timers || []).forEach(function (t) { try { clearTimeout(t); } catch (_) {} });
    S.timers = [];
    // Живой ход на этом экране закрывается, но САМ ОН ОСТАЁТСЯ в S.turn: его
    // fetch переживает пересборку экрана, ответ подхватит reattachTurn.
    // Обнулять S.turn здесь нельзя — тогда на СЛЕДУЮЩЕМ маунте условие
    // `S.abort && !S.turn` в abort-guard выше становится истиной и рвёт
    // запрос на живом ходу: nginx пишет 499, ученик видит «Нет соединения»,
    // а повтор упирается в AGENT_BUSY (400). Замерено вживую 30.09.
    // Композер такой ход не держит — для этого detached, а не null.
    if (S.turn && !S.turn.dead) S.turn.detached = true;
    S.printing = false;
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
      cacheDrop();                     // чужие чаты в кэше не показываем
    }
    root = screenRoot;
    if (cacheHasThreads()) {
      // Возврат на раздел в открытой вкладке: каркас и переписка рисуются из
      // кэша мгновенно, сеть только сверяет их на фоне.
      mountFrame();
      loadThreads();
      return;
    }
    // Холодный первый вход: экранная анимация приложения держится до ответа
    // списка чатов, и только потом появляется раздел. Пустой блок внутри
    // показать можно лишь когда мы уже знаем, что чатов нет.
    screenLoader("Открываем чаты…");
    loadThreads(function first(ok) {
      if (S.mountGen !== mg) return;
      mountFrame();
      if (!ok) errorCard("Не удалось загрузить чаты.", "Попробовать снова", function () { loadThreads(); });
    });
  }
  function mountFrame() {
    buildLayout();
    renderCachedQuota();
    restoreDraft();
    syncInput();
    syncViewport();
    if (cacheHasThreads()) { S.threads = S.cache.threads; renderThreads(); }
    selectCurrentThread();
  }

  window.screenAgent = screenAgent;
  window.AgentScreen = {
    send: send, selectThread: selectThread, state: S, setQuota: setQuota,
    confirmStep: confirmStep, emptyVisible: emptyVisible, screen: screenAgent,
  };
})();
