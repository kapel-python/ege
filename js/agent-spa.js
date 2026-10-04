/* Экран «ИИ» (#/ai) — часть SPA.
   Хром общий: топбар/сайдбар/тема/тосты/модалки берёт у приложения
   (toast, esc, icon, deviceModalRoot/closeDeviceModal), своего ничего нет.
   Вызывает render() через screenAgent(root); размонтирование — снос DOM:
   каждая асинхронная ветка сверяется с поколением mountGen. */
(function () {
  "use strict";

  var S = {
    threads: [], currentId: null, busy: false, mountGen: 0, navGen: 0, animGen: 0, sendGen: 0,
    quota: { limit: 5, remaining: 5, resetInSec: null },
    abort: null, stick: true, lock: 0, creating: null, accountId: null,
    timers: [], turn: null, pendingBail: null, newThreadId: null, printing: false,
    follow: true, printTarget: null, gliding: false, glideFeed: null, progTop: null,
    cache: { accountId: null, threads: null, messages: {} },
  };
  var RING = 94.25, QUOTA_FALLBACK = 5;
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
  // Корзина, а не крестик: в эталоне удаление чата — корзина, а «×»
  // рядом с пунктом меню читался бы как «закрыть панель».
  var TRASH_D = "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3";
  var root = null, ui = {};
  /* Пока рисуется переписка из готового массива, внутренние вызовы доводки
     не нужны: история доводится один раз в конце (settleBottom), а не на
     каждый пузырёк и карточку. */
  var painting = false;

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
     Долгое нажатие (500 мс) на своё сообщение или ответ ИИ открывает
     меню у точки нажатия; тап в любом другом месте, Esc и прокрутка его
     закрывают. Действия зависят от места в ленте:
     - свой вопрос: «Скопировать» + (если он последний) «Изменить и отправить»
       (замена существующего сообщения, не новое);
     - ответ ИИ: только у последней пары «Перегенерировать» — тот же
       вопрос уходит с replaceLast, сервер ЗАМЕНЯЕТ пару «вопрос+ответ» и
       модель даёт новый ответ.
     Копирование ОТВЕТА в меню больше не держим: под каждым ответом ИИ
     есть своя кнопка «Скопировать» (addCopyRow) — на телефоне её видно сразу,
     а меню по удержанию приходилось ещё и угадывать. Свой вопрос копируется
     только тут — под ним своей кнопки нет. У более ранних сообщений ИИ
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
          if (S.busy) { say("ИИ ещё отвечает"); return; }
          regenerate(q);
        },
      });
    }
    // Пунктов нет (старый ответ ИИ: копирование — кнопкой под ответом) —
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
     Ход ИИ показывается как живой: пустой шаг, в который вырастает
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
    // Вторая стена гейта «ИИ только для Plus»: кэш фронта мог быть
    // свежее сервера (подписка истекла между экраном и ходом). Сносим кэш
    // подписки и перерисовываем раздел paywall-блоком через общий render.
    if (res.status === 403 && res.data && res.data.code === "SUBSCRIPTION_REQUIRED") {
      try {
        if (typeof Subscription !== "undefined" && Subscription && Subscription.status) {
          Subscription.status(true).catch(function () {});
        }
      } catch (_) {}
      try { if (typeof render === "function") render(); } catch (_) {}
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
    if (ui.quotaRing) ui.quotaRing.style.strokeDashoffset = (RING * (1 - Math.min(remaining, limit) / limit)) + "px";
    if (!cached) { try { localStorage.setItem(quotaCacheKey(), JSON.stringify(S.quota)); } catch (_) {} }
    syncInput();
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
  /* Модалка квоты ИИ — общая из app.js (openAiLimitModal, та же
     .dlg-система, что окно лимита проверки сочинений и инфо-диалог о модели
     на ege-result): здесь меняются только текст, иконка и подпись таймера.
     Своей сборки окна (как была) больше нет — вид, крестик, Esc, тап по фону
     и живой таймер берутся оттуда же.
     Режим «сколько осталось» (клик по кружку, лимит ещё есть) — то же окно
     без таймера и с кнопкой «Закрыть», то есть ровно инфо-диалог о модели. */
  var AGENT_QUOTA_OPTS = {
    eyebrow: "ИИ",
    icon: "clock",
    plural: function (n) { return pluralQ(n); },
    refresh: function (force) { return fetchQuota(force); },
    fallbackLimit: QUOTA_FALLBACK,
  };
  function agentQuotaText(limit, left) {
    // Апсейл — тем же правилом, что у сочинений (только бесплатный уровень,
    // limit <= 5; у Plus и грантов его нет) и только в окне исчерпания:
    // справочное окно по кружку и burst-режим его не показывают.
    var upsell = limit <= 5
      ? `<div class="dlg__upsell">Нужно больше? <a href="/subscription">ege easy <span class="plus">Plus</span></a> — 25 ходов ИИ в день.</div>`
      : "";
    return "Ход — это твой вопрос ИИ и его ответ. Доступно " +
      "<b><span data-ai-limit-left>" + left + "</span> из " + limit + "</b> " +
      pluralQ(limit) + ": израсходованные ходы возвращаются примерно по трети запаса каждые 8 часов (полный запас — за сутки)." + upsell;
  }
  function openLimitModal(quota, burstRetry) {
    if (typeof openAiLimitModal !== "function") {
      say(burstRetry != null ? "Слишком частые запросы" : "Ходы закончились");
      return;
    }
    var burst = burstRetry != null;
    var limit = Math.max(1, Number(quota && quota.limit) || QUOTA_FALLBACK);
    var left = Math.max(0, Math.min(limit, Number(quota && quota.remaining) || 0));
    openAiLimitModal(quota || { limit: limit, remaining: left }, burst ? (Math.max(1, Math.floor(Number(burstRetry) || 60))) : null, Object.assign({}, AGENT_QUOTA_OPTS, {
      icon: "clock",
      name: burst ? "Слишком частые запросы"
        : (left > 0 ? "Ходы ещё есть" : "Ходы закончились"),
      timerLabel: burst ? "Повторная попытка через" : "Возврат хода через",
      ariaLabel: burst ? "Слишком частые запросы" : "Ходы ИИ закончились",
      text: burst
        ? "Ты отправляешь вопросы ИИ слишком часто. Подожди немного — вопрос и ответ уже в переписке, ничего не потеряно."
        : (left > 0
          ? "Один ход — это твой вопрос ИИ вместе с его ответом. Ходов осталось <b>" + left + " из " + limit + "</b>."
          : agentQuotaText(limit, left)),
    }));
  }
  /* Справочное окно по клику на кружок квоты: сколько ходов осталось и как
     они тратятся. Раньше на тап всплывал тост в углу — ненадёжно (его
     перебивает другая подсказка, он живёт 2.6с и ничего не объясняет). */
  function openQuotaInfoModal() {
    if (typeof openAiLimitModal !== "function") return;
    var limit = Math.max(1, Number(S.quota.limit) || QUOTA_FALLBACK);
    var left = Math.max(0, Math.min(limit, Number(S.quota.remaining) || 0));
    openAiLimitModal({ limit: limit, remaining: left, resetInSec: S.quota.resetInSec }, null, Object.assign({}, AGENT_QUOTA_OPTS, {
      icon: "ai",
      name: left > 0 ? "Осталось " + left + " из " + limit : "Ходов пока нет",
      timer: false,
      closeText: "Закрыть",
      ariaLabel: "Ходы ИИ",
      text: left > 0
        ? "Ход — это твой вопрос ИИ и его ответ вместе с шагами. Доступно <b>" +
          left + " из " + limit + "</b> " + pluralQ(limit) + ". Израсходованные ходы возвращаются примерно по трети запаса каждые 8 часов (полный запас — за сутки)."
        : "Ходы закончились. Следующий вернётся сам — таймер появится здесь же.",
    }));
  }
  function limitEscHandler(e) {
    if (e.key === "Escape" && typeof closeAiLimitModal === "function") closeAiLimitModal();
  }
  function closeLimitModal() {
    if (typeof closeAiLimitModal === "function") closeAiLimitModal();
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
  /* Ссылки на чаты — внешние неперебираемые id (10 символов [A-Za-z0-9] в
     хэше #/ai/<ref>), внутри — прежний числовой id треда. Без символов:
     в хэше они требуют кодирования и ломаются при копипасте. Старые
     числовые ссылки (#/ai/56) работают как раньше и переписываются на
     внешнюю автоматически (syncHash), когда свой чат найден в списке. */
  var THREAD_PUBLIC_RE = /^[A-Za-z0-9]{10}$/;
  function isPublicThreadRef(s) { return typeof s === "string" && THREAD_PUBLIC_RE.test(s); }
  function isNumericThreadRef(s) {
    return typeof s === "string" && /^\d+$/.test(s) && Number(s) > 0;
  }
  function isThreadRef(s) { return isPublicThreadRef(s) || isNumericThreadRef(s); }
  function findThreadByRef(ref) {
    if (ref == null) return null;
    var s = String(ref);
    for (var i = 0; i < S.threads.length; i++) {
      var t = S.threads[i];
      if (String(t.id) === s || (t.publicId && String(t.publicId) === s)) return t;
    }
    return null;
  }
  function threadUrlRef(t) {
    if (!t) return S.currentId ? String(S.currentId) : "";
    return t.publicId ? String(t.publicId) : String(t.id);
  }
  /* Человеческие объяснения проблем с открытием чата — общей модалкой
     приложения (openConfirmDialog, та же .dlg-система, что удаление чата),
     а не тостом: чужой чат по ссылке «открывался» молча (пустой список), и
     человек не понимал, куда делся чат. Своей сборки .dlg у раздела нет.
     kinds: bad — мусор в адресе; foreign — чужая/удалённая ссылка;
     deleted — свой чат удалён (например, с другого устройства). */
  function openThreadProblem(kind) {
    var map = {
      bad: { icon: "info", title: "Ссылка сломана",
             text: "Такой чат открыть нельзя — проверь ссылку или выбери чат из списка: твои чаты на месте." },
      foreign: { icon: "lock", title: "Это не твой чат",
             text: "Ссылка ведёт в чужой или удалённый чат. Чужие переписки не открываем — показываю твои чаты." },
      deleted: { icon: "info", title: "Чат удалён",
             text: "Этот чат уже удалён — может, с другого устройства. Показываю оставшиеся чаты, прогресс и ошибки на месте." },
    };
    var m = map[kind] || map.foreign;
    try {
      if (typeof openConfirmDialog !== "function") { say(m.title + ". " + m.text); return; }
      // Один показ на адрес: фоновая сверка и повторный маунт не должны
      // складывать окна друг на друга. Ключ с аккаунтом: та же ссылка под
      // другим аккаунтом — другой показ (иначе смена аккаунта гасила бы
      // модалку «это не твой чат» ровно там, где она нужнее всего).
      var key = String(S.accountId || "") + ":" + String(kind) + ":"
        + String(S.threadProblemShownFor || "");
      if (S.threadProblemShown === key) return;
      S.threadProblemShown = key;
      openConfirmDialog({
        iconName: m.icon,
        eyebrow: "Чат с ИИ",
        title: m.title,
        text: m.text,
        cancelText: "Закрыть",
        confirmText: "Понятно",
        onConfirm: function () { try { closeDeviceModal(); } catch (_) {} },
      });
    } catch (_) { say(m.title); }
  }
  function readDeepLinkRaw() {
    try {
      var p = (typeof routeParam === "function" ? routeParam() : "");
      return String(p || "");
    } catch (_) { return ""; }
  }
  function readDeepLink() {
    // Совместимость: числовой id из старых ссылок и сохранёнок, внешний
    // public_id из новых. Возвращаем строкой — сравнение идёт по обеим
    // колонкам (findThreadByRef), а не Number(), иначе внешний id — NaN.
    try {
      var p = readDeepLinkRaw();
      if (p && isThreadRef(p)) return p;
      var saved = localStorage.getItem(threadCacheKey());
      if (saved && isThreadRef(String(saved))) return String(saved);
    } catch (_) {}
    return null;
  }
  function syncHash() {
    try {
      var cur = null;
      try { cur = currentThread(); } catch (_) { cur = null; }
      var ref = cur ? threadUrlRef(cur) : (S.currentId ? String(S.currentId) : "");
      // Свой чат по старой числовой ссылке — переписываем адрес на внешний
      // id сразу: внутренняя ссылка в адресной строке больше не живёт.
      if (cur && S.currentId && String(S.currentId) !== String(cur.id)) S.currentId = Number(cur.id);
      var h = ref ? "#/ai/" + ref : "#/ai";
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
    side.setAttribute("aria-label", "Чаты с ИИ");
    // Заголовок — своей строкой (иначе он отбирал ширину у кнопки и рвался
    // на две строки), кнопка «Новый чат» — под ним во всю ширину
    // рейла, как в эталоне: так она остаётся главным действием раздела.
    var head = el("div", "agent__threads-head");
    head.appendChild(el("h2", "section-title", "ИИ"));
    var newBtn = el("button", "btn btn--primary agent__new", null);
    newBtn.type = "button"; newBtn.id = "agent-new";
    newBtn.innerHTML = svgRaw(PLUS_D, "2.4");
    newBtn.appendChild(document.createTextNode("Новый чат"));
    newBtn.addEventListener("click", newChat);
    var list = el("ul", "agent__list");
    list.id = "agent-threads";
    side.appendChild(head); side.appendChild(newBtn); side.appendChild(list);

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
    var qn = el("span", "num", "5");
    qn.id = "agent-quota-num";
    quota.appendChild(qn);
    // Клик по кружку — сразу окно (тот же .dlg, что у проверки сочинений),
    // никаких всплывающих пилюль: текст «Осталось N из M» живёт только
    // внутри окна и в aria-label кнопки (скринридер). Пилюля-подсказка
    // удалена полностью: прятать её было бесполезно — на тач-тапе
    // совместимый mouseenter приходит ДО click и возвращал её, а следующая
    // setQuota ставила display="" заново.
    quota.addEventListener("click", function () {
      fetchQuota(true).then(function (st) {
        if (st && Number(st.remaining) <= 0) { openLimitModal(st, null); return; }
        openQuotaInfoModal();
      });
    });
    bar.appendChild(menu); bar.appendChild(title); bar.appendChild(quota);

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
      '<h2>Здесь пока пусто</h2><p>Спроси про тему или свои ошибки — шаги поиска будут видны в ответе.</p>' +
      '<div class="agent__suggest">' +
      [["Почему я ошибаюсь в производных?", "Почему я ошибаюсь", "Разберу твои решения по теме", "errors"],
       ["Составь план подготовки на неделю", "План на неделю", "Соберу задания под твой уровень", "compass"],
       ["Объясни задание 17 с параметрами", "Задание 17", "Объясню параметры", "help"]
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
           quotaBtn: quota, quotaNum: qn, quotaRing: quota.querySelector(".q-ring"),
           downBtn: down, menuBtn: menu, newBtn: newBtn, ctx: null, ctxMore: null };
    wireEvents();
  }

  /* Свайп по разделу: вправо — открыть список чатов, влево — закрыть. На
     телефоне бургер в тулбаре мелкая цель, а список чатов нужен часто; жест
     не перехватываем там, где он означает другое: поле ввода (выделение
     текста) и блоки с горизонтальной прокруткой. Порог тот же, что у
     обычных шторок: 56px по горизонтали, вертикаль отбрасывается, жест до
     0.9с — иначе «свайп» получается при перетаскивании полосы прокрутки. */
  function swipeSkips(node) {
    var n = node;
    while (n && n !== document.body) {
      if (n.tagName === "TEXTAREA" || n.tagName === "INPUT" || n.isContentEditable) return true;
      if (n.scrollWidth > n.clientWidth + 2) {
        var ox = "";
        try { ox = window.getComputedStyle(n).overflowX; } catch (_) {}
        if (ox && ox !== "visible") return true;
      }
      n = n.parentNode;
    }
    return false;
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
      // Корзина, а не крестик: «×» рядом с «Открыть чат» читался как
      // «закрыть панель».
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
        return { id: t.id, publicId: thread.publicId || t.publicId,
                 subject: t.subject, title: thread.title || t.title,
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
    // Принимаем и внешний ref из ссылки: свой чат маппим на внутренний id.
    // Чужого здесь нет (его ловит selectCurrentThread/resolve с модалкой).
    if (id != null) {
      var known = findThreadByRef(id);
      if (known) id = Number(known.id);
      else if (isNumericThreadRef(String(id))) id = Number(id);
      else return;
    } else id = null;
    var prev = S.currentId;
    var leaving = Number(prev) !== Number(id);
    // Клик по уже открытому чату, пока в нём летит ход, — ничего не делает.
    // Раньше здесь безусловно росли navGen и ехала перезагрузка сообщений:
    // она сносила оптимистичный пузырёк и скелетон, а прилетевший ответ хода
    // отбрасывался сторожем поколений — лента пустела молча, и при сбое
    // модели перезагрузка показывала вообще ничего (вопрос нигде не записан).
    // Возврат на раздел из другого экрана — другой случай: каркас только что
    // пересобран (buildLayout) и лента пуста, поэтому «ничего не делать»
    // оставляло человека с пустым чатом посреди живого хода (а после
    // перезагрузки страницы — с видом «можно отправлять», будто вопрос
    // пропал). Пустую ленту восстанавливаем: история из кэша + пузырёк и
    // скелетон через reattachTurn, ход остаётся своим (detached=false),
    // чтобы композер был занят до ответа.
    if (!leaving && S.turn && !S.turn.dead && Number(S.turn.threadId) === Number(id)) {
      if (ui.live && ui.live.childNodes.length) return;
      S.turn.detached = false;
      syncBusy();
      var _cur = currentThread();
      if (ui.title) ui.title.textContent = _cur ? (_cur.title || "Новый чат") : "Нет чатов";
      syncHash();
      var _cached = cachedMessages(id);
      if (_cached) paintMessages(_cached);
      else feedLoader("Читаем переписку…");
      reattachTurn();
      return;
    }
    S.navGen++;
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
    // Чужой для вкладки ход жил в старом чате — новому композер не держим.
    if (leaving) { S.serverBusy = null; S._busyWatch = null; }
    S.printing = false;
    syncBusy();
    S.currentId = id;
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
    var raw = readDeepLinkRaw();
    if (raw) {
      // Явный адрес чата: битый — модалка сразу, без похода в сеть.
      if (!isThreadRef(raw)) {
        try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
        S.threadProblemShownFor = raw;
        S.currentId = null;
        if (S.threads.length) selectThread(S.threads[0].id);
        else selectThread(null);
        openThreadProblem("bad");
        return;
      }
      var local = findThreadByRef(raw);
      if (local) { selectThread(local.id); return; }
      // В списке нет: свой старый за пределом сотни, чужой или удалённый.
      // Спрашиваем сервер напрямую тем же ref — он разберёт и числовой, и
      // внешний. Модалку показываем по итогу, а не вслепую.
      resolveDeepLinkFromServer(raw);
      return;
    }
    var want = readDeepLink();
    var exists = want && findThreadByRef(want);
    if (exists) { selectThread(exists.id); return; }
    if (S.threads.length) selectThread(S.threads[0].id);
    else selectThread(null);
  }
  /* Прямая проверка явной ссылки у сервера: свой (но вне сотни в списке) —
     подхватываем и открываем, чужой/удалённый — модалка + свои чаты. */
  function resolveDeepLinkFromServer(raw) {
    var g = S.mountGen;
    S.threadProblemShownFor = String(raw);
    feedLoader("Читаем переписку…");
    api("GET", "/api/agent/threads/" + encodeURIComponent(String(raw))).then(function (res) {
      if (g !== S.mountGen) return;
      if (res.status === 200 && res.data && res.data.thread) {
        var th = res.data.thread;
        if (!findThreadByRef(th.id) && !findThreadByRef(th.publicId)) {
          S.threads.unshift(th);
          cacheThreads(S.threads);
        }
        selectThread(th.id);
        return;
      }
      if (handleAuthError(res)) return;
      // Битый ref сервер тоже отбивает 400 — текст тот же, что для мусора
      // в адресе. 404 — чужой или удалённый: сервер их не различает
      // специально (иначе перебором id было бы видно, чей чат жив).
      var kind = (res.status === 400) ? "bad" : "foreign";
      try { localStorage.removeItem(threadCacheKey()); } catch (_) {}
      S.currentId = null;
      if (S.threads.length) selectThread(S.threads[0].id);
      else selectThread(null);
      openThreadProblem(kind);
    }).catch(function () {
      if (g !== S.mountGen) return;
      if (S.threads.length) selectThread(S.threads[0].id);
      else selectThread(null);
      errorCard("Нет соединения.", "Попробовать снова", function () { selectCurrentThread(); });
    });
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
  /* Открытый чат заведомо ПУСТ? Отвечаем только когда знаем наверняка — снимок
     переписки в кэше пустой. Просто «нет сообщений на экране» не годится: во
     время хода в пустом чате оптимистичный пузырёк ещё не в кэше, и проверка
     решила бы, что чат пуст, хотя ИИ там уже работает. */
  function currentChatEmpty() {
    if (S.currentId == null) return true;
    if (turnHeld()) return false;
    var msgs = cachedMessages(S.currentId);
    return Array.isArray(msgs) && msgs.length === 0;
  }
  /* «Новый чат». Если открытый чат пуст, новый не нужен — это тот же самый
     чистый лист, и второй раз показывать то же самое незачем. Раньше кнопка
     писала строку в базу на КАЖДОЕ нажатие, и десять нажатий без вопроса
     оставляли десять пустых чатов в списке: мусор, который нечего открывать и
     нечем объяснить. Поле не трогаем — недописанный вопрос не должен пропасть
     оттого, что человек нажал «Новый чат». Сервер переиспользует пустой чат и
     сам (подстраховка для старой вкладки и чужих клиентов), здесь запрос и
     строка в списке не появляются вовсе. */
  function newChat() {
    if (currentChatEmpty()) {
      showEmpty(true);
      if (ui.title) ui.title.textContent = "Новый чат";
      nav(false);
      try { if (ui.input) ui.input.focus({ preventScroll: true }); } catch (_) {}
      return;
    }
    createThread();
    nav(false);
  }
  function createThread() {
    if (S.creating) return S.creating;
    S.creating = api("POST", "/api/agent/threads", {}).then(function (res) {
      if (res.status === 200 && res.data && res.data.thread) {
        var th = res.data.thread;
        // Сервер отдаёт уже существующий ПУСТОЙ чат вместо нового — тогда он
        // уже есть в списке, и вставлять его второй раз нельзя (был бы дубль
        // строки). Въезжать в списке тоже незачем: он там уже стоит.
        var known = findThreadByRef(th.id) || findThreadByRef(th.publicId);
        if (!known) {
          S.threads.unshift(th);
          // Новый чат отмечается, чтобы в списке он въехал, а не мигнул.
          S.newThreadId = th.id;
        }
        cacheThreads(S.threads);          // новый чат сразу виден и в кэше раздела
        selectThread(Number(th.id));
        return th;
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
    if (Number(S.currentId) === Number(t.id) && S.busy) {
      say("Дождись ответа — удаление во время хода потеряет его");
      return;
    }
    askDeleteThread(t);
  }
  /* Подтверждение — общим диалогом приложения (openConfirmDialog, та же
     .dlg-система, что выход из аккаунта и завершение сессии в профиле).
     Раньше корзина сносила чат сразу, и вернуть переписку было нельзя. */
  function askDeleteThread(t) {
    if (typeof openConfirmDialog !== "function") { doDeleteThread(t); return; }
    var title = String(t.title || "Новый чат").trim();
    if (title.length > 48) title = title.slice(0, 47) + "…";
    openConfirmDialog({
      iconName: "trash",
      eyebrow: "Чат с ИИ",
      title: "Удалить чат?",
      text: `Переписка ${title ? "«<b>" + esc(title) + "</b>» " : ""}и все её шаги исчезнут безвозвратно. Прогресс и ошибки из профиля останутся на месте.`,
      confirmText: "Удалить",
      onConfirm: function () { doDeleteThread(t); },
    });
  }
  function doDeleteThread(t) {
    var wasCurrent = Number(S.currentId) === Number(t.id);
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
  /* ---------- сообщения ---------- */
  function clearFeed() { if (ui.live) ui.live.textContent = ""; }
  /* Лоадер «Читаем переписку…» (.agent__boot) живёт только пока лента пуста:
     первое сообщение в новом чате рисуется ПОВЕРХ летящего GET треда, и без
     явного снятия лоадер оставался над пузырьком и скелетоном навсегда (GET
     возвращается позже и по защите feedGen ленту уже не трогает). */
  function clearBoot() {
    if (!ui.live) return;
    try {
      ui.live.querySelectorAll(".agent__boot").forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
    } catch (_) {}
  }
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
  // Поколение ленты: каждая ЛОКАЛЬНАЯ отрисовка (пузырёк, скелетон, карточка)
  // двигает счётчик. Ответ на loadThreadMessages, пришедший ПОСЛЕ того, как
  // человек уже что-то нарисовал (отправил вопрос, получил ошибку), ленту
  // перерисовывать НЕ должен: серверный снимок старше и не знает про ход,
  // который ещё не записан (вопрос пишется в базу только после модели).
  // Без этого первое сообщение в новом чате регулярно уходило в пустоту:
  // createThread → selectThread → GET треда летит раньше, чем send рисует
  // пузырёк, а возвращается позже — и сносит его вместе со скелетоном.
  function feedTouch() { S.feedGen = (S.feedGen || 0) + 1; }
  function userBubble(text) {
    var d = el("div", "agent__msg-user enter", text);
    feedTouch();
    clearBoot();
    if (ui.live) ui.live.appendChild(d);
    showEmpty(false);
    if (!painting) scrollDown(true, true);
    return d;
  }
  // Шаг строится в двух состояниях: пустой контейнер (в него вырастает
  // лоадер) и готовое содержимое (галочка, название, кнопки, «Подробнее»).
  function stepShell(st) {
    var li = el("li", "agent__step");
    // id шага в разметке: ход, гасящий брошенное подтверждение, приходит с
    // списком dropped, и карточку надо перерисовать НА МЕСТЕ — мёртвые кнопки
    // «Применить/Отмена» на экране ждать бы нельзя (сервер уже ответит «Шаг
    // уже обработан»).
    if (st && st.id != null) li.setAttribute("data-step-id", String(st.id));
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
  // Шаг, который ученик не подтвердил и ушёл задавать другой вопрос: действие
  // НЕ применено. Раньше карточка навсегда оставалась с часиком и кнопками —
  // и нажатие давало «Шаг уже обработан».
  function stepDropped(st) {
    var p = stepShell(st);
    stepFill(p);
    return p;
  }
  function markStepDropped(id, kind, label, args, result) {
    if (!ui.live || id == null) return;
    var node = ui.live.querySelector('.agent__step[data-step-id="' + Number(id) + '"]');
    if (!node) return;
    try {
      stepFill({ li: node, body: node.querySelector(".agent__tbody"),
                 st: { id: Number(id), kind: kind || "action", label: label || "",
                       args: args || {}, result: result || {}, status: "dropped" } });
    } catch (_) {}
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
    // Сырое имя инструмента (`update_profile`, `fold_web`) в карточке шага НЕ
    // показываем: это внутренний код, а правило 5b промпта прямо запрещает
    // такое ученику («вместо fold_web говори словами»). Подпись шага уже
    // человеческая («Меняю профиль: 95+ баллов»), а технические детали —
    // в раскрытом «Подробнее» с аргументами, куда им и место.
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
    } else if (st.status === "dropped") {
      // Честная подпись вместо кнопок: предложение не применено, потому что
      // ученик его не подтвердил и задал другой вопрос.
      body.appendChild(el("p", "", "Не применено — поступил другой вопрос."));
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
    autolinkBareUrls(tmp);
    hardenLinks(tmp);
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
  /* ---------- ссылки в ответе ИИ ----------
     Разметка та же, что у жирного и курсива: модель пишет обычный markdown
     `[текст](ссылка)`, а ученику это должно выглядеть частью нашего интерфейса,
     а не чужой веб-страницей. Поэтому DOMPurify мы НЕ ограничиваем
     (она по умолчанию режет `target`, а без него ссылка открывается поверх
     приложения и человек теряет переписку), а обрабатываем ссылки сами:
     внешним — `target=_blank` + `rel=noopener`, внутренним — ничего лишнего. */
  var SAFE_SCHEME = /^(https?:|\/|\.\/|#)/i;
  function hardenLinks(root) {
    var links = (root.querySelectorAll ? root.querySelectorAll("a[href]") : []);
    Array.prototype.forEach.call(links, function (a) {
      var href = (a.getAttribute("href") || "").trim();
      // Схема, которой быть не должно (javascript:, data:), — ссылку убираем
      // совсем, текст оставляем: ИИ нельзя отдавать ученику клик,
      // выполняющий код от его имени.
      if (!SAFE_SCHEME.test(href)) { a.removeAttribute("href"); return; }
      var internal = href.charAt(0) === "/" || href.charAt(0) === "#";
      // Класс дописываем, а не переписываем: у ссылки, созданной
      // autolinkBareUrls, уже есть --raw (длинный адрес не капиталится), и
      // перезапись здесь молча его сносила — проверка на живом рендере это поймала.
      // Ссылка, ПОДПИСЬЮ которой служит сам адрес, заглавными не пишется
      // («HTTPS://OBRAZOVAKA.SDAMGIA.RU/...» нечитаем). Признак — по тексту,
      // а не по классу: такие ссылки создаёт ещё и сам markdown (проверено:
      // marked с gfm делает ссылку из голого адреса), и своего класса у них нет.
      var raw = /\bagent__link--raw\b/.test(a.className || "")
                || /^\s*https?:\/\//i.test(a.textContent || "");
      trimLinkLabel(a, href);
      a.className = "agent__link" + (internal ? " agent__link--int" : "") + (raw ? " agent__link--raw" : "");
      if (!internal) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  /* Служебные слова в подписи ссылки — «САЙТ ФИПИ», «ОТКРЫТЬ МАТЕРИАЛЫ»,
     «ПЕРЕЙТИ НА»… Кнопка сама показывает, что это ссылка, поэтому такие слова
     ученику не нужны: остаётся только название («ФИПИ», «РАЗБОР ТЕМЫ»).
     Правило есть и в промпте, но модель его регулярно нарушает (замер: на двух
     вопросах подряд выдала «ОТКРЫТЬ …»), а приводит подпись к виду мы всё
     равно можем — наша кнопка, наш текст. Режем только по краям: название в
     середине фразы не трогаем («ОЦЕНКА СОЧИНЕНИЯ ФИПИ» остаётся целиком).
     Если после этого ничего не осталось — показываем имя сайта: пустой
     кнопки быть не должно. */
  /* Слова, которые не несут смысла в подписи ссылки: «САЙТ ФИПИ»,
     «ОТКРЫТЬ МАТЕРИАЛЫ», «ПЕРЕЙТИ НА»… Кнопка сама показывает, что это
     ссылка, поэтому остаётся только название. Режем ТОЛЬКО по краям: слова
     внутри названия не трогаем («СОЧИНЕНИЕ ФИПИ» остаётся целиком). */
  var NOISE = [
    "сайт", "сайта", "сайту", "сайте", "сайтом", "сайты",
    "веб-сайт", "вебсайт", "страница", "страницы", "страницу", "странице",
    "ссылка", "ссылки", "ссылке", "ссылку", "ссылкой",
    "перейти", "перейти на", "переход", "переходы", "зайти", "зайди",
    "открыть", "открывай", "открывайте", "открыть сайт",
    "посмотреть", "смотреть", "подробнее", "подробно",
    "почитать", "почитай", "изучить", "читать",
    "нажми", "нажмите", "клик", "кликни", "кликнуть", "тут", "здесь", "вот",
    "еще", "ещё", "больше", "все", "всё",
  ];
  function trimLinkLabel(a, href) {
    var text = (a.textContent || "").trim();
    if (!text || /^https?:\/\//i.test(text)) return;   // сам адрес не режем
    var words = text.split(/\s+/).filter(Boolean);
    // Повторяем: слова-шумки могли стоять и слева, и справа («открыть сайт ФИПИ»).
    for (var pass = 0; pass < 4 && words.length; pass++) {
      var first = words[0].toLowerCase().replace(/[.,:;!?-]+$/, "");
      if (NOISE.indexOf(first) < 0) break;
      words.shift();
    }
    for (var pass2 = 0; pass2 < 4 && words.length; pass2++) {
      var last = words[words.length - 1].toLowerCase().replace(/[.,:;!?-]+$/, "");
      if (NOISE.indexOf(last) < 0) break;
      words.pop();
    }
    // Края подписи после обрезки остаются с запятой или тире («разбор темы —»),
    // а это визуальный мусор на кнопке — снимаем.
    var label = words.join(" ").replace(/^[\s\-–—:,.!?]+/, "").replace(/[\s\-–—:,.!?]+$/, "");
    if (!label) label = hostOf(href) || text;            // пустой кнопки не бывает
    a.textContent = label;
  }
  function hostOf(href) {
    var m = /^(?:https?:\/\/)?(?:[^@/]+@)?([^/?#:]+)/.exec(String(href || ""));
    return m ? m[1] : "";
  }
  /* Голый адрес в тексте (`https://fipi.ru`) приходит ссылкой из ДВУХ источников:
     markdown с gfm делает ссылку из него сам (проверено на движке; сперва здесь
     была ошибка, будто он автолинкует только `www.`), а это — страховка на
     случай иной версии или настройки. Внутри существующей ссылки и `code` не
     лезем. Схема разрешена ровно одна — http(s). */
  var BARE_URL_RE = /\bhttps?:\/\/[^\s<>()\u00ab\u00bb\[\]{}]+[^\s<>()\u00ab\u00bb\[\]{}.,;:!?'"]/gi;
  function autolinkBareUrls(root) {
    if (root.querySelectorAll === undefined) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      var p = walker.currentNode.parentNode;
      // Внутри уже готовой ссылки/кода не лезем.
      if (!p || p.nodeName === "A" || p.nodeName === "CODE") continue;
      nodes.push(walker.currentNode);
    }
    nodes.forEach(function (node) {
      var text = node.nodeValue || "";
      BARE_URL_RE.lastIndex = 0;
      if (!BARE_URL_RE.test(text)) return;
      var frag = document.createDocumentFragment();
      var last = 0, m;
      BARE_URL_RE.lastIndex = 0;
      while ((m = BARE_URL_RE.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement("a");
        a.setAttribute("href", m[0]);
        // Помечаем: сырой адрес длинный, и заглавными он нечитаем (см. CSS).
        a.className = "agent__link agent__link--raw";
        a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }
  /* Печать готового DOM: оборачиваем слова текстовых узлов в те же
     .agent__ww, что и buildTyped, — раскладка и темп не меняются. */
  function buildTypedDom(root) {
    var words = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      // Текст ВНУТРИ ссылки печатать по словам нельзя: у ссылки своя форма
      // (плашка с полями и рамкой), и отдельные слова внутри неё расползаются
      // по своей базовой линии. Поэтому ссылка печатается ЦЕЛИКОМ — одним
      // элементом в общем темпе с остальным текстом.
      if (walker.currentNode.parentNode &&
          walker.currentNode.parentNode.nodeName === "A") {
        words.push(walker.currentNode.parentNode);
        continue;
      }
      nodes.push(walker.currentNode);
    }
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
  // Финал хода: встать ровно в самый низ, чтобы кнопки и «Скопировать» были
  // в кадре, а не обрезанные ниже края. Glide-loop гасим, идём мгновенно:
  // плавный scrollTo из follow() спорил с циклом за ленту, и конец замирал
  // качелями выше низа. Ушедшего вверх (S.follow снят) не трогаем.
  function finishBottom() {
    glideStop();
    if (S.follow) scrollDown(true, false);
  }
  /* Открытие переписки: встать в самый низ МГНОВЕННО и держать низ, пока
     лента перестаёт расти. Один smooth-скролл на длинной истории (замер:
     16 000px) заканчивался на 674px выше низа — после перезагрузки человек
     оказывался на последнем абзаце ответа, а кнопки-продолжения и
     «Скопировать» уезжали под край. Причина в том, что доводку звали и на
     каждый пузырёк, и на каждую карточку: анимация начиналась заново
     десятки раз и не доезжала. Здесь — прямой progWrite (своя запись, руке
     человека не мешает) и несколько кадров подряд, пока dist() не станет
     нулём; ушедшего вверх (S.follow/S.stick сняты) и начавшийся ход не
     трогаем. */
  function settleBottom() {
    if (!ui.feed) return;
    var left = 24, stable = 0;
    (function tick() {
      if (!ui.feed || left-- <= 0) { settleLate(); return; }
      if (S.follow && S.stick && !S.busy && dist() > 1) { stable = 0; progWrite(ui.feed.scrollHeight); }
      else if (dist() <= 1) { if (++stable >= 2) { settleLate(); return; } }
      raf(tick);
    })();
  }
  /* Поздний рост ленты после перезагрузки: подгрузка шрифтов меняет переносы
     и высоту строк (плюс догрузка картинок из markdown), и низ уезжает ниже
     уже после быстрых кадров выше — человек остаётся на строку-две выше
     конца, а «Скопировать» под краем. Три точечные доводки (~2.5 с) плюс
     момент готовности шрифтов — только пока человек сам не ушёл вверх
     (S.stick) и ход не начался, иначе дёрнули бы читающего. */
  function settlePin() {
    if (!ui.feed || !S.follow || !S.stick || S.busy) return;
    if (dist() > 1) progWrite(ui.feed.scrollHeight);
  }
  function settleLate() {
    var mg = S.mountGen;
    [350, 1100, 2500].forEach(function (ms) {
      later(ms, function () { if (mg === S.mountGen) settlePin(); });
    });
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (mg === S.mountGen) settlePin(); });
      }
    } catch (_) {}
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
    list.forEach(function (q, i) { row.appendChild(askButton(q, i)); });
    card.appendChild(row);
    if (isAlive) follow(350);
    return row;
  }
  function askButton(item, i) {
    var b = el("button", "agent__qr");
    b.type = "button";
    try { b.style.setProperty("--i", String(i)); } catch (_) { b.setAttribute("style", "--i:" + i); }
    b.setAttribute("data-ask", item.ask);
    b.setAttribute("aria-label", item.label + ": " + item.ask);
    b.appendChild(svgIcon(SUGGEST_ICONS[i % SUGGEST_ICONS.length], "2.2"));
    b.appendChild(document.createTextNode(item.label));
    b.addEventListener("click", function () {
      // Ход уже идёт — кнопка не должна исчезать впустую: сервер не примет
      // второй вопрос, и человек остался бы без вариантов продолжения.
      if (S.busy) return;
      // Ноль известен заранее — кнопку не трогаем вовсе: модалку откроет
      // send(), а кнопка останется на месте до возвращения лимита.
      if (quotaOut()) return;
      // Фокус снимаем сами: иначе после ухода кнопки браузер оставлял
      // обводку на пустом месте (было видно как «залипшая» кнопка).
      try { b.blur(); } catch (_) {}
      collapseAsk(b);
    });
    return b;
  }
  // Вопрос не ушёл (сервер отказал до записи — оба 429): схлопнутая кнопка
  // возвращается на то же место, а не выглядит «сработанной». Чинится только
  // отказ до записи; неуспех после отправки чинится карточкой ошибки с
  // кнопкой повтора. replaceLast сюда не попадает: там ленту перечитывает
  // loadThreadMessages и кнопки пересобираются из данных сервера сами.
  function restoreAskButton(meta) {
    if (!meta || !meta.row || !meta.row.parentNode || !meta.ask) return;
    var row = meta.row;
    var same = row.querySelectorAll("[data-ask]");
    for (var k = 0; k < same.length; k++) {
      var it = same[k];
      if (it.classList.contains("is-gone") && it.getAttribute("data-ask") === meta.ask
          && it.parentNode) it.parentNode.removeChild(it);
    }
    var at = Math.max(0, meta.index | 0);
    var b = askButton({ label: meta.label || meta.ask, ask: meta.ask }, at);
    var kids = row.children;
    if (at < kids.length) row.insertBefore(b, kids[at]);
    else row.appendChild(b);
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
      // Ход, ЖДУЩИЙ подтверждения, сворачивать нельзя: лента с кнопками
      // «Применить/Отмена» — это то, что человек сейчас должен нажать, а
      // раньше карточка через ~4 с сама схлопывалась («Показать шаги»), и
      // приходилось снова её раскрывать, чтобы найти кнопку. Карточка без
      // действий сворачивается по-прежнему.
      var waitsConfirm = prepped.some(function (p) { return p.st && p.st.status === "needs_confirm"; });
      if (!waitsConfirm) built.trace.classList.remove("open");
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
      finishBottom();
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
    feedTouch();
    clearBoot();
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
        // То же правило и для истории: карточка, где действие ещё ждёт
        // подтверждения, остаётся раскрытой — иначе после перезагрузки чата
        // кнопки «Применить/Отмена» спрятаны под «Показать шаги».
        var historyWaits = built.prepped.some(function (p) { return p.st && p.st.status === "needs_confirm"; });
        raf(function () {
          card.classList.add("done");
          if (!historyWaits) built.trace.classList.remove("open");
        });
        // Кнопки и у истории с шагами: раньше эта ветка их не рисовала вовсе,
        // и после перезагрузки продолжение было только у ответов без шагов.
        cardFooter(card, null, asks);
      } else {
        if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
        syncBusy();
        paras.forEach(function (p) { card.appendChild(p); });
        cardFooter(card, null, asks);
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
        // Доводка в самый низ — своей, а не из quickActions: когда модель не
        // дала блок suggest, кнопок нет и quickActions выходит раньше своей
        // доводки, и конец замирал бы на уровне текста с обрезанной кнопкой
        // «Скопировать» ниже.
        finishBottom();
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
    feedTouch();
    clearBoot();
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
    feedTouch();
    clearBoot();
    if (ui.live) ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    return card;
  }
  /* ---------- живые шаги хода ----------
     POST /api/agent/turns считает до ~105 с и отвечает один раз в конце. Без
     опроса клиент показывал бы один скелетон «Думаю…» всё время, а потом пачку
     шагов с фиксированными задержками revealTurn (~2 с на шаг): сначала «долго
     думает», потом «сразу пачкой пишет». Вместо этого опрашиваем GET треда
     (там liveSteps, пока слот хода занят) и дорисовываем шаги по мере прихода:
     лоадер каждого шага длится ровно столько, сколько модель реально думала.
     Анимация остаётся (лоадер → шаг, печать ответа), но её длительности задаёт
     сеть, а не шаблон. Финал из POST авторитетен: живое превью снимается, шаги
     кладутся сразу без перепроигрывания, печатается только ответ. */
  var LIVE_POLL_MS = 1500;
  function liveStop(turn) {
    if (turn && turn.liveTimer) { try { clearInterval(turn.liveTimer); } catch (_) {} turn.liveTimer = null; }
  }
  // Снять живое превью: перед авторитетным рендером, ошибкой или уходом.
  function liveDrop(turn) {
    liveStop(turn);
    if (turn && turn.liveEl && turn.liveEl.parentNode) {
      try { turn.liveEl.parentNode.removeChild(turn.liveEl); } catch (_) {}
    }
    if (turn) { turn.liveEl = null; turn.liveOl = null; turn.liveNum = null;
                turn.liveLoader = null; turn.liveShown = 0; turn.liveSkel = null; }
  }
  // Живая карточка: та же структура, что у renderSteps (делегированный тоггл
  // в wireEvents подхватывает её сам), но шаги досыпаются по одному, а в конце
  // всегда стоит лоадер «думает дальше», пока сервер считает.
  function liveEnsure(turn) {
    if (turn.liveEl && turn.liveEl.parentNode) return turn.liveEl;
    if (!ui.live) return null;
    if (turn.liveSkel && turn.liveSkel.parentNode) {
      try { turn.liveSkel.parentNode.removeChild(turn.liveSkel); } catch (_) {}
    }
    turn.liveSkel = null;
    var card = el("article", "agent__ai");
    card.setAttribute("data-live", "1");
    var toggle = el("button", "agent__trace-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "true");
    var traceId = "agent-trace-live-" + Math.random().toString(36).slice(2);
    toggle.setAttribute("aria-controls", traceId);
    toggle.appendChild(svgIcon(ARROW_D, "2.4"));
    toggle.appendChild(el("span", "", "Скрыть шаги"));
    var num = el("span", "num", "0");
    toggle.appendChild(num);
    var trace = el("div", "agent__trace open");
    trace.id = traceId;
    var inner = el("div", "agent__trace-in");
    var ol = el("ol", "agent__steps");
    inner.appendChild(ol); trace.appendChild(inner);
    card.appendChild(toggle); card.appendChild(trace);
    var loaderLi = el("li", "agent__step");
    var loaderBody = el("div", "agent__tbody");
    loaderBody.appendChild(stepLoader("Думаю…"));
    loaderLi.appendChild(loaderBody);
    ol.appendChild(loaderLi);
    feedTouch();
    clearBoot();
    ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    turn.liveEl = card; turn.liveOl = ol; turn.liveNum = num; turn.liveLoader = loaderLi;
    return card;
  }
  // Дорисовать только новые шаги (мгновенно, без постановочных задержек:
  // реальное время уже прошло, пока сервер думал). «Подробнее» доступно
  // сразу — результат шага приехал вместе с ним.
  function liveAppendSteps(turn, steps) {
    var fresh = (steps || []).slice(turn.liveShown || 0);
    if (!fresh.length) return;
    if (!liveEnsure(turn) || !turn.liveOl) return;
    fresh.forEach(function (s) {
      var p = stepShell({ tool: s.tool, args: s.args, label: s.label,
                          kind: s.kind || "read", status: s.status,
                          result: s.result, proposal: s.proposal });
      stepFill(p);
      try { turn.liveOl.insertBefore(p.li, turn.liveLoader); } catch (_) {}
    });
    turn.liveShown = (steps || []).length;
    if (turn.liveNum) turn.liveNum.textContent = String(turn.liveShown);
    follow(450);
  }
  function livePoll(turn) {
    if (!turn || turn.dead) return;
    var tid = turn.threadId;
    if (tid == null || !ui.live || Number(S.currentId) !== Number(tid)) return;
    api("GET", "/api/agent/threads/" + Number(tid)).then(function (res) {
      if (!turn || turn.dead || !ui.live || Number(S.currentId) !== Number(tid)) return;
      if (res.status === 200 && res.data && Array.isArray(res.data.liveSteps)
          && res.data.liveSteps.length) {
        liveAppendSteps(turn, res.data.liveSteps);
      }
    }).catch(function () {});
  }
  function liveStart(turn, skel) {
    liveStop(turn);
    if (turn) { turn.liveSkel = skel || null; turn.liveShown = 0; }
    if (!turn || turn.dead) return;
    turn.liveTimer = setInterval(function () { livePoll(turn); }, LIVE_POLL_MS);
  }
  // Живой ход досмотрен: шаги уже показаны в реальном времени, и
  // перепроигрывать их с фиксированными задержками (revealTurn) — значит
  // заставить человека смотреть одно и то же дважды. Шаги кладутся сразу
  // (та же мгновенная ветка, что у истории), печатается только ответ.
  function assistantCardLive(steps, finalText, suggests) {
    var g = S.mountGen;
    var card = el("article", "agent__ai");
    if (finalText) card.setAttribute("data-answer", String(finalText));
    var built = renderSteps(card, steps);
    var paras = finalText ? mdBlocks(finalText) : [];
    if (g !== S.mountGen || !ui.live) return card;
    feedTouch();
    clearBoot();
    ui.live.appendChild(card);
    showEmpty(false);
    scrollDown(true, true);
    if (built) built.card = card;
    var asks = normalizeSuggests(suggests);
    if (built) built.suggests = asks;
    if (S.pendingBail) { try { S.pendingBail(); } catch (_) {} S.pendingBail = null; }
    syncBusy();
    if (built) {
      built.prepped.forEach(function (p) { built.ol.appendChild(p.li); stepFill(p); });
      built.trace.classList.add("open");
      // Карточка с ожиданием подтверждения остаётся раскрытой (то же правило,
      // что у истории и revealTurn): кнопки «Применить/Отмена» должны быть
      // видны сразу, а не под «Показать шаги».
      var waits = built.prepped.some(function (p) { return p.st && p.st.status === "needs_confirm"; });
      raf(function () {
        card.classList.add("done");
        if (!waits) built.trace.classList.remove("open");
      });
    }
    if (!paras.length) {
      cardFooter(card, null, asks);
      return card;
    }
    var ag = ++S.animGen, stopped = false;
    function alive() { return !stopped && g === S.mountGen && ag === S.animGen && card.parentNode; }
    function bailPlain() {
      if (stopped) return;
      stopped = true;
      glideStop();
      paras.forEach(function (p) { if (!p.parentNode) card.appendChild(p); p.classList.remove("typing"); });
      scrollDown(true, false);
    }
    S.pendingBail = bailPlain;
    (function next() {
      if (!alive()) return;
      if (!paras.length) {
        cardFooter(card, alive, asks);
        S.pendingBail = null;
        syncBusy();
        finishBottom();
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
  // Локальное зеркало серверного describe_step — ТОЛЬКО запасной путь для
  // истории без m.label (кэш, записанный до серверной подписи). Живой ход и
  // свежая история несут label от сервера; зеркало обязано совпадать с ним
  // по смыслу, дословное совпадение не требуется.
  function humanStepLabel(tool, args, result) {
    args = args || {}; result = result || {};
    function op() { return String(args.op || ""); }
    if (tool === "fold_web") {
      var o = op();
      if (o === "forecast") return "Смотрю прогноз по баллам";
      if (o === "errors") return (result.open != null ? "Смотрю твои ошибки — " + result.open + " штук" : "Смотрю твои ошибки");
      if (o === "skills") return "Смотрю навыки — " + ((result.skills || []).length) + " тем";
      if (o === "attempts") {
        var topic = (result.attempts && result.attempts[0] && result.attempts[0].topic) || "";
        if (topic) return "Смотрю попытки по теме «" + topic + "»";
        return args.taskId ? "Смотрю попытки по этому заданию" : "Смотрю попытки по навыкам";
      }
      if (o === "profile") return "Смотрю твой профиль";
      if (o === "progress") return "Смотрю общий прогресс";
      if (o === "daily") return "Смотрю дни занятий";
      if (o === "history") return "Смотрю историю за период";
      if (o === "timeline") return "Смотрю ленту твоих занятий";
      return "Смотрю прогресс";
    }
    if (tool === "lesson_get") return "Открываю урок" + (result.title ? " «" + result.title + "»" : "");
    if (tool === "task_get") return "Открываю задание" + (result.topic ? " «" + result.topic + "»" : "");
    if (tool === "essay_history") return "Смотрю твои сочинения";
    if (tool === "find_topics") return "Ищу по каталогу" + (args.query ? ": " + String(args.query).slice(0, 60) : "");
    if (tool === "plan_draft") return "Составляю черновик плана";
    if (tool === "project_info") return "Смотрю справку о сайте";
    if (tool === "update_profile") return "Меняю профиль";
    if (tool === "resolve_error") return "Отмечаю ошибку разобранной";
    if (tool === "reset_progress") return "Сбрасываю прогресс";
    return "";
  }
  // Отрисовка переписки из готового массива: кэш раздела и ответ сервера идут
  // в одну функцию, иначе кэш и сеть рисовали бы по-разному.
  function paintMessages(msgs) {
    painting = true;
    feedTouch();
    clearFeed();
    if (!msgs || !msgs.length) { painting = false; showEmpty(true); return; }
    var pending = [];
    // Кнопки-продолжения — только у ПОСЛЕДНЕГО ответа: в переписке они
    // относятся к тому, что на экране сейчас, и у каждого старого ответа
    // рисовать свои варианты значило бы превратить ленту в поле кнопок.
    // Варианты — сохранённые слова модели (suggests из базы): история
    // показывает те же кнопки, что были вживую. Нет сохранённых — нет
    // кнопок, а не дежурный набор.
    // Строго по порядку ленты: раньше пузыри пользователя рисовались сразу
    // по ходу цикла, а карточки ответов — пачкой после него, и при нескольких
    // ходах все вопросы сбивались в кучу наверх, а все ответы — вниз. Теперь
    // группы идут в том порядке, в каком сообщения лежат в базе.
    var groups = [];
    function flushSteps(finalText, suggests) {
      if (!pending.length && !finalText) return;
      groups.push({ kind: "answer", steps: pending.splice(0, pending.length),
                    final: finalText || null, suggests: suggests || [] });
    }
    msgs.forEach(function (m) {
      if (m.role === "user") { flushSteps(null); groups.push({ kind: "user", text: m.content || "" }); }
      else if (m.role === "assistant" && (m.content || "").trim()) flushSteps(m.content, m.suggests);
      else if (m.role === "tool") {
        pending.push({ id: m.id, tool: m.tool, args: m.args, result: m.result,
                       // Подпись — серверная (m.label, та же строка, что была
                       // вживую); запасной путь — локальное зеркало describe_step
                       // для кэшей, записанных до серверного label.
                       label: (m.label || humanStepLabel(m.tool, m.args, m.result) || m.tool || "Шаг"),
                       kind: "read", status: m.status, proposal: m.result });
      }
    });
    flushSteps(null);
    if (groups.length) {
      // История открывается сразу целиком, без анимации.
      var lastAnswer = -1;
      groups.forEach(function (g, i) { if (g.kind === "answer") lastAnswer = i; });
      groups.forEach(function (g, i) {
        if (g.kind === "user") userBubble(g.text);
        else assistantCard(g.steps, g.final, false, i === lastAnswer ? g.suggests : []);
      });
    }
    painting = false;
    showEmpty(false);
    // Низ — после того как лента встанет (схлопываются ленты шагов, догружается
    // шрифт): один smooth-скролл на такой высоте не доезжал.
    settleBottom();
  }
  function loadThreadMessages(force) {
    var g = S.mountGen;
    var wantId = S.currentId;
    var fg = S.feedGen || 0;
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
        // Лента новее запроса (человек отправил вопрос или получил ошибку,
        // пока GET летел) — серверный снимок её затрёт вместе с пузырём
        // и скелетоном: пропускаем перерисовку, но ход подхватываем.
        // Раньше здесь был безусловный paint — первое сообщение в новом чате
        // регулярно превращалось в пустоту: пузырёк и «Думаю…» сносились,
        // а при сбое модели перезагрузка показывала вообще ничего.
        if (!force && fg !== (S.feedGen || 0)) { reattachTurn(); showServerBusy(wantId, res); return; }
        // Ничего не изменилось — не перерисовываем: у человека останутся
        // раскрытые «Подробнее» и позиция ленты.
        if (!sameMessages(cached, msgs)) paintMessages(msgs);
        reattachTurn();
        showServerBusy(wantId, res);
        return;
      }
      if (res.status === 400 && res.data && res.data.code === "THREAD_BAD_REF") {
        S.threadProblemShownFor = String(wantId);
        if (!cached) clearFeed();
        errorCard("Ссылка на чат сломана.", "К моим чатам", function () { selectCurrentThread(); });
        openThreadProblem("bad");
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
        S.threadProblemShownFor = String(wantId);
        openThreadProblem("deleted");
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
  // Ходов заведомо нет — отправка закрыта заранее (кнопка серая через
  // :disabled, а не синяя). Финальное слово за сервером: send() при
  // известном нуле тоже не идёт в сеть, а показывает окно лимита.
  function quotaOut() {
    return Number(S.quota && S.quota.remaining) <= 0;
  }
  function syncInput() {
    var has = ui.input && ui.input.value.trim().length > 0;
    if (ui.sendBtn) ui.sendBtn.disabled = S.busy || !has || quotaOut();
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
  function liveHeld() {
    return (!!S.turn && !S.turn.dead && !S.turn.detached) || !!S.pendingBail;
  }
  function turnHeld() {
    // S.serverBusy — чужой для вкладки ход: после перезагрузки страницы
    // посреди генерации локального S.turn уже нет, но сервер всё ещё считает.
    // Композер и «Стоп» ведут себя как при живом ходе, а ожидание ответа
    // (watchAnswer) смотрит только на liveHeld — иначе оно ждало бы само себя.
    return liveHeld() || !!S.serverBusy;
  }
  function syncBusy() {
    var held = turnHeld();
    S.busy = held;
    if (!held) S.printing = false;
    if (ui.input) {
      ui.input.setAttribute("placeholder", S.printing ? "ИИ пишет ответ…"
        : (held ? "ИИ отвечает…" : (quotaOut() ? "Ходы закончились…" : "Спроси что-нибудь…")));
    }
    syncInput();
  }
  // Ответ получен, печать ещё идёт: композер остаётся закрытым до её конца.
  function beginPrinting() { S.printing = true; syncBusy(); }
  function send(text, opts) {
    text = (text || "").trim();
    if (!text) return;
    // Композер занят (летит ход или допечатывается ответ): молча глотать
    // вопрос нельзя — человек жмёт Enter и видит, что «ничего не происходит».
    if (S.busy) { if (!(opts && opts.quiet)) say("Дождись текущего ответа"); return; }
    var force = !!(opts && opts.force);
    var quiet = !!(opts && opts.quiet);      // невидимый повтор сервера
    // Ходов не осталось — в сеть не идём и ленту не трогаем: заменяющий ход
    // (перегенерировать/исправить) иначе снёс бы с экрана удачный ответ, а
    // сервер при 429 старую пару не сносит — оставались бы два вопроса
    // подряд без ответа. Тихие повторы пропускаем: это догрузка уже
    // показанного хода, а не новый вопрос. Ввод при этом цел (поле не
    // чистим), а квоту сверяем с сервером — вдруг уже вернулась.
    if (!quiet && quotaOut()) {
      editTarget = null;
      openLimitModal(S.quota, null);
      fetchQuota(true);
      return;
    }
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
    // Поколение ОТПРАВОК (а не навигации): тихий повтор протухает, только
    // если человек отправил что-то новее. Служебные скачки navGen (подхват
    // хода под новую ленту в reattachTurn) повтор не убивают — иначе
    // первое сообщение в новом чате теряло бы свои повторы и висело молча.
    var sg = ++S.sendGen;
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
                 askBtn: (opts && opts.askBtn) || null,
                 retries: quiet ? (opts && opts.retries) || 0 : 0 };
    S.abort = ctrl;
    S.turn = turn;                 // держит композер до конца хода (см. turnHeld)
    var payload = { threadId: S.currentId, text: text };
    if (force) payload.force = true;
    if (replaceLast) payload.replaceLast = true;
    turn.promise = api("POST", "/api/agent/turns", payload, ctrl ? ctrl.signal : undefined);
    syncBusy();
    // Живые шаги: опрос треда дорисовывает их во время хода. Скелетон при
    // первом шаге заменится живой карточкой сам (liveEnsure).
    liveStart(turn, skel);
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
    var mg = S.mountGen, sg = S.sendGen || 0;
    var tryNo = ((opts && opts.retries) || 0) + 1;
    later(TURN_RETRY_DELAY_MS, function () {
      if (mg !== S.mountGen || sg !== (S.sendGen || 0)) return;
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
    // Окно подхвата истекло — ход оставляем. S.turn обнуляем ВМЕСТЕ с S.abort:
    // иначе на следующем маунте abort-guard увидит «контроллер есть, хода нет»
    // и сам порвёт ещё живой запрос (nginx 499) — ровно та ловушка, что описана
    // в screenAgent. Раз мы от хода отказались, рвём его сами и честно.
    if (Date.now() - t.startedAt > REATTACH_MS) {
      if (S.turn === t) {
        S.turn = null;
        if (S.abort === t.ctrl) S.abort = null;
        try { if (t.ctrl) t.ctrl.abort(); } catch (_) {}
      }
      return;
    }
    if (Number(t.threadId) !== Number(S.currentId)) return;
    t.claimedBy = S.mountGen;
    var g = ++S.navGen, mg = S.mountGen;
    // Перемонтирование снесло живую карточку вместе со старым DOM: следующий
    // опрос построит её заново, а счётчик сбрасываем — иначе новые шаги в
    // новом DOM оказались бы пропущены как «уже показанные».
    if (t.liveEl || t.liveOl) { t.liveEl = null; t.liveOl = null; t.liveNum = null;
                                t.liveLoader = null; t.liveShown = 0; t.liveSkel = null; }
    if (!t.dead && !t.liveTimer) {
      t.liveTimer = setInterval(function () { livePoll(t); }, LIVE_POLL_MS);
    }
    syncBusy();
    showEmpty(false);
    // Пузырёк и скелетон дорисовываем ТОЛЬКО если их снесли (перерисовка
    // ленты поверх хода). Если они на месте — второй комплект дал бы дубль
    // вопроса, а из-за дубля меню переставало узнавать «последний вопрос»
    // и прятало «Изменить и отправить». Обработчики перецепляем всегда:
    // старые токены уже не совпадают.
    var bubble = null, skel = null;
    if (ui.live) {
      var kids = ui.live.querySelectorAll(".agent__msg-user");
      for (var i = 0; i < kids.length; i++) {
        if ((kids[i].textContent || "").trim() === String(t.text || "").trim()) { bubble = kids[i]; break; }
      }
      if (!bubble) bubble = userBubble(t.text);
      var loaders = ui.live.querySelectorAll(".agent__loader");
      skel = loaders.length ? loaders[loaders.length - 1].closest(".agent__ai") : null;
      if (!skel) skel = skeletonCard();
    }
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
  /* Перезагрузка страницы посреди хода: локального S.turn уже нет (состояние
     вкладки сброшено), а вопрос в базе появится только после ответа модели —
     без подстраховки лента выглядела бы как «вопрос пропал, можно отправлять».
     Сервер держит слот хода (busy + busyText) — показываем его как пузырёк и
     скелетон и ждём ответ polling-ом, вместо пустого вида. Свой живой ход
     (S.turn) уже подхвачен reattachTurn — его не трогаем. */
  function showServerBusy(wantId, res) {
    if (!res || !res.data || !res.data.busy) {
      if (S.serverBusy) { liveDrop(S.serverBusy); S.serverBusy = null; syncBusy(); }
      S._busyWatch = null;
      return;
    }
    var t = S.turn;
    if (t && !t.dead && Number(t.threadId) === Number(wantId)) {
      if (S.serverBusy) { liveDrop(S.serverBusy); S.serverBusy = null; syncBusy(); }
      S._busyWatch = null;
      return;
    }
    if (!ui.live) return;
    var bt = String((res.data && res.data.busyText) || "").trim();
    if (bt) {
      var hasBubble = false, users = ui.live.querySelectorAll(".agent__msg-user");
      for (var i = 0; i < users.length; i++) {
        if ((users[i].textContent || "").trim() === bt) { hasBubble = true; break; }
      }
      if (!hasBubble) userBubble(bt);
    }
    var skelBusy = null;
    if (!ui.live.querySelector(".agent__loader")) skelBusy = skeletonCard();
    showEmpty(false);
    // Один цикл ожидания на (чат, текст): повторные заходы loadThreadMessages,
    // пока слот занят, не должны плодить параллельные опросы.
    var wk = String(wantId) + "\n" + bt;
    // Ход чужой для вкладки (перезагрузка посреди генерации), но для человека
    // он живой: держим композер и «Стоп», как при своём ходе. Повторная
    // отправка упрётся в AGENT_BUSY — там уже есть ветка mineBusy с молчаливым
    // ожиданием, а не враньём про «сервер занят».
    // Живое превью продолжает чужой ход, а не начинается заново: объект один
    // на слот, повторные заходы лишь подхватывают его (иначе каждый фоновый
    // опрос сносил бы уже показанные шаги).
    if (!S.serverBusy || Number(S.serverBusy.threadId) !== Number(wantId)) {
      if (S.serverBusy) liveDrop(S.serverBusy);
      S.serverBusy = { threadId: wantId, text: bt, liveTimer: null, liveShown: 0,
                       liveEl: null, liveOl: null, liveNum: null,
                       liveLoader: null, liveSkel: skelBusy };
    } else {
      S.serverBusy.text = bt;
      if (skelBusy && !S.serverBusy.liveEl) S.serverBusy.liveSkel = skelBusy;
    }
    syncBusy();
    // Шаги чужого хода уже считаются на сервере (liveSteps в GET): ждать их
    // молча со скелетоном — та же «пачка в конце», только после reload.
    // Дорисовываем тем же живым путём; S.turn тут нет, опрос идёт по слоту.
    if (!S.serverBusy.liveTimer) {
      S.serverBusy.liveTimer = setInterval(function () {
        var b = S.serverBusy;
        if (!b) return;
        livePoll(b);
      }, LIVE_POLL_MS);
      livePoll(S.serverBusy);
    }
    if (S._busyWatch === wk) return;
    S._busyWatch = wk;
    watchAnswer(wantId, bt || null, WATCH_TRIES, function () { S._busyWatch = null; loadThreadMessages(true); });
  }
  /* Дождаться ответа, который сервер считает после обрыва. Раньше здесь был
     один слепой setTimeout на 4 с: ход в 20 с успевал мимо, и человек оставался
     с лентой, где ответ так и не появился. Теперь смотрим тред несколько раз
     и останавливаемся, как только ответ (или шаг) появился. */
  function watchAnswer(tid, text, tries, onGiveUp) {
    if (tid == null || Number(S.currentId) !== Number(tid)) return;
    if (liveHeld()) {
      if (tries <= 0) { if (onGiveUp) onGiveUp(); return; }
      later(WATCH_EVERY_MS, function () { watchAnswer(tid, text, tries, onGiveUp); });
      return;
    }
    turnAnswered(tid, text).then(function (answered) {
      if (Number(S.currentId) !== Number(tid)) return;
      if (answered) { loadThreadMessages(); return; }
      if (tries > 1) later(WATCH_EVERY_MS, function () { watchAnswer(tid, text, tries - 1, onGiveUp); });
      else if (onGiveUp) onGiveUp();
    });
  }
  function settleTurn(turn, g, mg, skel, bubble, text, res) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    turn.dead = true;
    // Живое превью снято: дальше — авторитетный ответ из POST. Шаги, уже
    // виденные вживую, не перепроигрываем (assistantCardLive), быстрые ходы
    // без единого опроса идут старым путём (revealTurn с его задержками).
    var sawLive = (turn.liveShown || 0) > 0;
    liveDrop(turn);
    if (S.turn === turn) S.turn = null;
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
    if (S.abort === turn.ctrl) S.abort = null;
    if (res.status === 200 && res.data) {
      if (res.data.quota) setQuota(res.data.quota);
      cacheForget(turn.threadId);        // переписка изменилась — кэш больше не её
      var steps = res.data.steps || [];
      if (res.data.pending) {
        var mapped = steps.map(function (s) {
          return { id: s.id, tool: s.tool, args: s.args, label: s.label, kind: s.kind || "action",
                   status: "needs_confirm", proposal: s.proposal };
        });
        // Ждущий подтверждения и так раскрыт: перепроигрывать нечего ни в
        // живом случае (шаги уже на экране), ни в быстром (один шаг).
        assistantCard(mapped, null, sawLive ? false : true);
        say("Нужно подтверждение — нажми «Применить»");
      } else if (sawLive) {
        assistantCardLive(steps, res.data.final || "", res.data.suggests);
      } else {
        assistantCard(steps, res.data.final || "", true, res.data.suggests);
      }
      if (res.data.thread) applyThreadTitle(res.data.thread);
      // Ход погасил брошенные подтверждения (сервер закрыл шаг needs_confirm, на
      // который ученик не нажал) — карточки перерисовываем на месте, иначе на
      // экране остались бы живые кнопки «Применить», которые дают «Шаг уже
      // обработан». Переписку не перечитываем: это потеряло бы позицию прокрутки
      // и только что допечатанный ответ.
      (res.data.dropped || []).forEach(function (id) { markStepDropped(id); });
      // Печать ответа держит композер закрытым (S.pendingBail) и снимет его
      // сама, когда допечатает последнее слово.
      return;
    }
    if (res.status === 400 && res.data && res.data.code === "AGENT_BUSY") {
      // Слот чата держит ход. Если это НАШ СОБСТВЕННЫЙ ход с тем же текстом —
      // ждать и показывать нечего: считается наш ответ, он придёт через пару
      // секунд. Живой случай 02.10, чат OromZaL0DH, 13:08:52: POST 499 (клиент
      // оборвал свой запрос — телефон ушёл в фон или экран пересобрался), следом
      // POST 400 AGENT_BUSY, ответ сервер дописал в 13:08:58. Раньше здесь
      // снимался пузырёк вопроса и показывалась карточка «Сервер ещё считает,
      // подождите 95 с» — враньё про собственный ответ, из-за которого готовый
      // ответ был виден только после перезагрузки страницы.
      //
      // busyText — вопрос, который держит слот (его кладёт сервер). Совпал с
      // нашим — это наш ход: молча ждём и дорисовываем ответ. Не совпал (или
      // сервер не сказал) — слот держит чужой ход, и «сервер занят» сказать
      // честно, сразу.
      var busyText = String((res.data && res.data.busyText) || "").trim();
      var mineBusy = !!busyText && busyText === String(text || "").trim();
      if (mineBusy) {
        syncBusy();
        watchAnswer(turn.threadId, text, WATCH_TRIES, function () {
          if (Number(S.currentId) !== Number(turn.threadId)) return;
          if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
          retryWhenFree(text, Math.max(1, Number(res.data.retryAfter) || 30),
                        { replaceLast: turn.replaceLast });
        });
        return;
      }
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      syncBusy();   // ход мёртв, ждёт модалка — её fire() сам проверит S.busy
      retryWhenFree(text, Math.max(1, Number(res.data.retryAfter) || 30),
                    { replaceLast: turn.replaceLast });
      return;
    }
    if (res.status === 400 && res.data && res.data.code === "THREAD_BAD_REF") {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      S.threadProblemShownFor = String((turn && turn.threadId) || "");
      openThreadProblem("bad");
      loadThreads();
      return;
    }
    if (res.status === 404 && res.data && res.data.code === "THREAD_NOT_FOUND") {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      S.threadProblemShownFor = String((turn && turn.threadId) || "");
      openThreadProblem("deleted");
      loadThreads();
      return;
    }
    if (res.status === 429 && res.data && res.data.code === "AI_LIMIT") {
      // Сервер отказал до записи: оптимистичный пузырёк нигде не записан —
      // снимаем, а снесённую заменой пару возвращаем из базы, иначе удачный
      // ответ пропадал бы с экрана (страховка под гейт в send() на случай
      // протухшего кэша квоты). Схлопнутая кнопка-подсказка возвращается на
      // место: вопрос не ушёл, «сработанной» она выглядеть не должна.
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      if (turn.replaceLast) loadThreadMessages(true);
      else restoreAskButton(turn.askBtn);
      openLimitModal({ limit: res.data.limit, remaining: res.data.remaining, resetInSec: res.data.resetInSec }, null);
      if (res.data.limit) setQuota(res.data);
      syncBusy();   // дальше говорит модалка, а не блокировка
      return;
    }
    if (res.status === 429) {
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      if (turn.replaceLast) loadThreadMessages(true);
      else restoreAskButton(turn.askBtn);
      openLimitModal(S.quota, Number(res.data.retryAfter) || 60);
      syncBusy();
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
      syncBusy();   // ход мёртв; без этого тихий повтор упирался в S.busy и умирал
      retrySilently(text, { retries: turn.retries || 0, replaceLast: turn.replaceLast });
      return;
    }
    // Заменяющий ход не записался: сервер старую пару НЕ сносил — вернём
    // ленту из базы, иначе вопрос и ответ пропадут с экрана.
    if (turn.replaceLast) loadThreadMessages(true);
    errorCard((res.data && res.data.error) || "ИИ не смог ответить.", "Попробовать снова",
      function () { send(text, turn.replaceLast ? { force: true, replaceLast: true } : { force: true }); });
    syncBusy();          // ни запроса, ни печати — композер разблокирован
  }
  /* AGENT_BUSY — не тупик: сервер сам сказал, через сколько освободится слот.
     Раньше здесь была только кнопка, и каждый клик до освобождения давал тот
     же 400 — вопрос застревал в ручном цикле «нажать ещё раз». Теперь ждём это
     время и повторяем сами; повтор по тому же тексту сервер отдаёт из кэша
     (без жетона), а если ход всё же не успел — это уже новый ход, как просил
     человек. Кнопка «сейчас» оставлена для нетерпеливых. */
  function retryWhenFree(text, wait, opts) {
    var g = S.navGen, mg = S.mountGen;
    var replaceLast = !!(opts && opts.replaceLast);
    var left = Math.max(1, Math.min(180, wait || 1));
    var card = errorCard("ИИ ещё отвечает на прошлый вопрос — повторю через " + left + " с.");
    var label = card.querySelector(".agent__answer");
    var row = el("div", "agent__actions");
    var btn = el("button", "agent__qr", "Повторить сейчас");
    btn.type = "button";
    row.appendChild(btn);
    card.appendChild(row);
    var started = false;
    function fire() {
      if (started || g !== S.navGen || mg !== S.mountGen) return;
      if (S.busy) { say("Дождись ответа"); return; }
      turnAnswered(S.currentId, text).then(function (answered) {
        if (g !== S.navGen || mg !== S.mountGen) return;
        started = true;
        // Ответ сервера уже есть — показываем его вместо нового вопроса.
        if (answered) { if (card.parentNode) card.parentNode.removeChild(card); loadThreadMessages(); return; }
        if (card.parentNode) card.parentNode.removeChild(card);
        // Замена обязана остаться заменой: без replaceLast исправленный вопрос
        // уходил бы НОВЫМ сообщением рядом со старой парой (дубль вместо замены).
        send(text, replaceLast ? { force: true, replaceLast: true } : { force: true });
      });
    }
    btn.addEventListener("click", fire);
    var BUSY_POLL_MS = 3000;
    function pollBusy() {
      if (started || g !== S.navGen || mg !== S.mountGen) return;
      if (S.currentId == null) return;
      api("GET", "/api/agent/threads/" + Number(S.currentId)).then(function (res) {
        if (started || g !== S.navGen || mg !== S.mountGen) return;
        // Сервер уже свободен — не ждём конец отсчёта, повторяем сразу.
        if (res.status === 200 && res.data && res.data.busy === false) { fire(); return; }
        later(BUSY_POLL_MS, pollBusy);
      }).catch(function () {
        if (!started && g === S.navGen && mg === S.mountGen) later(BUSY_POLL_MS, pollBusy);
      });
    }
    later(BUSY_POLL_MS, pollBusy);
    later(1000, function tick() {
      if (g !== S.navGen || mg !== S.mountGen) return;
      left -= 1;
      if (left > 0) {
        label.textContent = "ИИ ещё отвечает на прошлый вопрос — повторю через " + left + " с.";
        later(1000, tick);
        return;
      }
      fire();
    });
  }
  function failTurn(turn, g, mg, skel, text, e) {
    if (g !== S.navGen || mg !== S.mountGen) return;
    // Живое превью при ошибке снимаем: тихий повтор начнёт новый ход и новую
    // карточку, а ответ сервера (если он досчитал) придёт авторитетным путём.
    liveDrop(turn);
    if (e && e.name === "AbortError") {
      // Сервер ход не бросает: turn НЕ хороним — перемонтирование подхватит
      // тот же промис, ответ придёт в ленту сам.
      if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
      if (S.abort === turn.ctrl) S.abort = null;
      // Запрос отвязан от композера: ответ ещё придёт (watchAnswer), но человек
      // уже не должен ждать его гвоздя в поле ввода.
      turn.detached = true;
      syncBusy();
      errorCard("Остановлено. Если ответ уже готов — он появится ниже.",
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
    if (turn.replaceLast) loadThreadMessages(true);
    errorCard("Нет соединения. Текст цел — повтори, когда появится сеть.", "Попробовать снова",
      function () { send(text, turn.replaceLast ? { force: true, replaceLast: true } : { force: true }); });
  }
  function confirmStep(messageId, approve, btns) {
    var mg = S.mountGen;
    if (btns) btns.forEach(function (b) { b.disabled = true; });
    // Подтверждение — это ТОЖЕ ход: сервер применяет действие и зовёт модель
    // (до 90 с). Раньше композер на это время оставался свободным: «Стоп»
    // пропадал, поле принимало текст, и ученик успевал отправить следующий
    // вопрос — который сервер отбивал как занятый (400 AGENT_BUSY), а человек
    // видел ошибку на ровном месте. Держим блокировку тем же S.turn, что и
    // обычный ход, поэтому «Стоп» работает и здесь.
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var turn = { threadId: S.currentId, text: "", ctrl: ctrl, promise: null,
                 startedAt: Date.now(), dead: false, claimedBy: S.mountGen, detached: false,
                 replaceLast: false, retries: 0, isConfirm: true };
    S.abort = ctrl;
    S.turn = turn;
    syncBusy();
    // Resume после подтверждения тоже считает модель (до 90 с): живые шаги
    // опрашиваем так же, скелетона тут нет — карточка встанет в ленту сама.
    liveStart(turn, null);
    function settle() {
      if (S.turn === turn) { turn.dead = true; S.turn = null; }
      if (S.abort === ctrl) S.abort = null;
      syncBusy();
    }
    turn.promise = api("POST", "/api/agent/turns/confirm",
      { messageId: messageId, approve: !!approve }, ctrl ? ctrl.signal : undefined);
    turn.promise.then(function (res) {
      settle();
      var sawLive = (turn.liveShown || 0) > 0;
      liveDrop(turn);
      if (mg !== S.mountGen) return;
      if (res.status === 200 && res.data) {
        if (res.data.quota) setQuota(res.data.quota);
        cacheForget(S.currentId);
        if (res.data.approved === false) {
          assistantCard([], res.data.final || "Отменено учеником.", true, res.data.suggests);
        } else if (res.data.final) {
          if (sawLive) assistantCardLive(res.data.steps || [], res.data.final, res.data.suggests);
          else assistantCard(res.data.steps || [], res.data.final, true, res.data.suggests);
        } else {
          assistantCard(res.data.steps || [], null, sawLive ? false : true);
        }
        return;
      }
      if (handleAuthError(res)) return;
      if (btns) btns.forEach(function (b) { b.disabled = false; });
      errorCard((res.data && res.data.error) || "Не удалось подтвердить.", "Попробовать снова",
        function () { confirmStep(messageId, approve, null); });
    }).catch(function (e) {
      settle();
      liveDrop(turn);
      if (mg !== S.mountGen) return;
      // Обрыв по «Стоп» — это не ошибка, а решение человека; сервер ход всё
      // равно досчитает, а ответ подхватит watchAnswer.
      if (turn.detached) { watchAnswer(S.currentId, "", WATCH_TRIES); return; }
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
    // Шторка списка чатов едет ЗА ПАЛЬЦЕМ (только телефон: на десктопе рейл —
    // обычная колонка в потоке, там жест не нужен, только анимация открытия).
    // Слушатели на каркасе раздела: узел пересоздаётся на каждом маунте,
    // поэтому старые обработчики уходят вместе с ним (глобальных
    // touch-листенеров у экрана нет).
    // Позиция шторки — 1:1 от смещения пальца, без искусственных масштабов:
    // на сколько сдвинул, настолько и открылась. Отпустил — шторка сама
    // доводится анимацией до открытого/закрытого: больше половины ширины —
    // туда, быстрый флик решает сам.
    var sw = { on: false, drag: false, x0: 0, y0: 0, t0: 0, lx: 0, lt: 0, w: 0, open: false, pend: 0, raf: false };
    function drawerNodes() {
      if (!ui.wrap) return null;
      var side = ui.wrap.querySelector(".agent__threads");
      var scrim = ui.wrap.querySelector(".agent__scrim");
      if (!side || !scrim) return null;
      return { side: side, scrim: scrim };
    }
    function drawerNodes() {
      if (!ui.wrap) return null;
      var side = ui.wrap.querySelector(".agent__threads");
      var scrim = ui.wrap.querySelector(".agent__scrim");
      if (!side || !scrim) return null;
      return { side: side, scrim: scrim };
    }
    function drawerW() {
      var n = drawerNodes();
      var w = n ? n.side.offsetWidth : 0;
      // Пока шторка скрыта, offsetWidth может врать — тогда по CSS-формуле
      // ширины шторки min(86vw, 320px).
      if (!w) w = Math.min(window.innerWidth * 0.86, 320);
      return w;
    }
    // px: -w (закрыто) .. 0 (открыто). Затемнение едет вместе со шторкой.
    // display тоже берём на себя: закрытая шторка — display:none, и без
    // инлайна её не видно ни при каком transform.
    function drawerPos(px) {
      var n = drawerNodes();
      if (!n || !sw.w) return;
      px = Math.max(-sw.w, Math.min(0, px));
      n.side.style.display = "flex";
      n.side.style.transform = "translateX(" + Math.round(px) + "px)";
      n.side.style.visibility = "visible";
      n.scrim.style.visibility = "visible";
      n.scrim.style.opacity = String(Math.max(0, Math.min(1, 1 + px / sw.w)));
    }
    // Запись позиции — не чаще кадра: сырые touchmove идут чаще 60 Гц, и
    // запись стилей на каждое событие давала дёрганье.
    function drawerPosFrame(px) {
      sw.pend = px;
      if (sw.raf) return;
      sw.raf = true;
      raf(function () {
        sw.raf = false;
        drawerPos(sw.pend);
      });
    }
    function drawerMobile() {
      try { return window.matchMedia("(max-width: 900px)").matches; }
      catch (_) { return true; }
    }
    ui.wrap.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1 || swipeSkips(e.target)) { sw.on = false; return; }
      sw.on = true; sw.drag = false;
      sw.x0 = e.touches[0].clientX; sw.y0 = e.touches[0].clientY; sw.t0 = Date.now();
      sw.lx = sw.x0; sw.lt = sw.t0;
    }, { passive: true });
    ui.wrap.addEventListener("touchmove", function (e) {
      if (!sw.on || e.touches.length !== 1 || !drawerMobile()) return;
      var x = e.touches[0].clientX, y = e.touches[0].clientY;
      var dx = x - sw.x0, dy = y - sw.y0;
      if (!sw.drag) {
        // Не горизонталь (угол тот же, что был у порогового свайпа:
        // dx ≥ 1.3·|dy|) — обычный скролл ленты, жест не наш.
        if (Math.abs(dx) < Math.abs(dy) * 1.3 || Math.abs(dx) < 10) return;
        sw.drag = true;
        sw.open = ui.wrap.classList.contains("nav-open");
        sw.w = drawerW();
        if (ui.wrap) ui.wrap.classList.add("dragging");
      }
      // Горизонталь взяли на себя: ленту/страницу не скроллим.
      try { e.preventDefault(); } catch (_) {}
      sw.lx = x; sw.lt = Date.now();
      drawerPosFrame(sw.open ? Math.min(0, dx) : -sw.w + Math.max(0, dx));
    }, { passive: false });
    // Отпуск: шторка доводится обычной анимацией ОТ ПОЗИЦИИ ПАЛЬЦА, а не
    // прыжком. drawerDrop() + nav() в одном кадре давали рывок: инлайн
    // сносился раньше смены класса, и шторка сначала прыгала в крайнее
    // положение, а уже потом анимировалась. Здесь класс меняется, пока
    // инлайн ещё держит позицию пальца, а инлайн снимается следующим кадром —
    // transition идёт от пальца до цели.
    function drawerRelease(goOpen) {
      var n = drawerNodes();
      if (ui.wrap) ui.wrap.classList.remove("dragging");
      nav(goOpen);
      if (!n) return;
      try { void n.side.offsetWidth; } catch (_) {}
      raf(function () {
        if (!drawerNodes()) return;
        var cur = drawerNodes();
        cur.side.style.transform = ""; cur.side.style.visibility = "";
        cur.side.style.display = "";
        cur.scrim.style.opacity = ""; cur.scrim.style.visibility = "";
      });
    }
    function drawerEnd(e) {
      if (!sw.on) return;
      sw.on = false;
      if (!sw.drag) return;
      sw.drag = false;
      var t = (e.changedTouches && e.changedTouches[0]) || null;
      var x = t ? t.clientX : sw.lx;
      var dx = x - sw.x0;
      var v = (x - sw.lx) / Math.max(1, Date.now() - sw.lt);   // px/мс конца жеста
      var goOpen = sw.open ? !(dx < -sw.w * 0.25 || v < -0.35) : (dx > sw.w * 0.25 || v > 0.35);
      // Ведение было осмысленным — следующий синтетический click (тап после
      // свайпа) гасим, чтобы не улетать по кнопке под пальцем.
      if (Math.abs(dx) > 10) sw.suppressClick = Date.now();
      drawerRelease(goOpen);
    }
    // Один раз на маунт: гасим клик, пришедший сразу за ведением.
    ui.wrap.addEventListener("click", function (e) {
      if (sw.suppressClick && Date.now() - sw.suppressClick < 350) {
        try { e.stopPropagation(); e.preventDefault(); } catch (_) {}
        sw.suppressClick = 0;
      }
    }, true);
    ui.wrap.addEventListener("touchend", drawerEnd, { passive: true });
    ui.wrap.addEventListener("touchcancel", drawerEnd, { passive: true });
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
      // Цикл ожидания из showServerBusy уже бежит — второй не заводим.
      var serverWait = !!S.serverBusy && !(turn && !turn.dead);
      if (S.pendingBail) {
        var bail = S.pendingBail;
        S.pendingBail = null;
        try { bail(); } catch (_) {}
      } else if (turn && !turn.dead) {
        turn.detached = true;   // композер разблокируется, ответ ещё подхватим
        if (S.abort) { try { S.abort.abort(); } catch (_) {} }
      } else if (S.serverBusy) {
        // Перезагрузка посреди хода: рвать нечего (запроса вкладки нет) —
        // просто освобождаем композер, ответ подхватит уже бегущий watchAnswer.
        S.serverBusy = null;
      }
      S.printing = false;
      syncBusy();
      if (!S.pendingBail && !serverWait) watchAnswer(tid, text, WATCH_TRIES);
    });
    ui.feed.addEventListener("scroll", function () {
      // Своя доводка печати (значение сошлось точь-в-точь с progWrite) — это
      // не рука человека: S.stick/S.follow не трогаем. Иначе glide посреди
      // печати сам гасил бы следование (там dist>120 — обычное дело), и
      // финальная доводка в самый низ уже не работала бы: конец оставался бы
      // на уровне текста, а кнопки ниже обрезались.
      var own = S.progTop != null && Math.abs(ui.feed.scrollTop - S.progTop) <= 2;
      if (!own) {
        if (Date.now() > S.lock) S.stick = dist() < 120;
        // Вернулся к самому низу во время хода — снова едем вместе с текстом.
        // (Уход вверх ловится ниже по wheel/touch.)
        if (S.busy && !S.follow && dist() < 120) S.follow = true;
      }
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
      if (q) {
        e.preventDefault();
        var ask = q.getAttribute("data-ask");
        var meta = null;
        // Кнопка-подсказка уже схлопывается (её обработчик ставит is-gone
        // синхронно и срабатывает раньше делегированного): запоминаем, куда
        // вернуть, если сервер откажет до записи. Карточки пустого чата не
        // схлопываются — им возвращать нечего.
        if (q.classList && q.classList.contains("is-gone") && q.parentNode) {
          meta = { row: q.parentNode,
                   index: Array.prototype.indexOf.call(q.parentNode.children, q),
                   label: (q.textContent || "").trim(), ask: ask };
        }
        send(ask, meta ? { askBtn: meta } : null);
      }
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
    // Цикл ожидания чужого хода жил в таймерах — вместе с ними и умер:
    // при возврате showServerBusy заведёт новый, иначе ответ никто не ждёт.
    S._busyWatch = null;
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
      S.serverBusy = null; S._busyWatch = null;
      cacheDrop();                     // чужие чаты в кэше не показываем
    }
    root = screenRoot;
    // Гейт «ИИ только для Plus»: прямой заход (#/ai, #/ai/<id>) без
    // подписки упирается в paywall-блок вместо раздела — того же вида, что
    // «Мои сочинения» без Plus. Проверка идёт ДО списка чатов и квоты,
    // поэтому агент никогда не мигает перед блоком, а лишних запросов нет.
    // Пока флаг выключен, сервер отдаёт agentAccess=true всем — ветка
    // paywall мёртвая, раздел работает как раньше.
    try {
      if (typeof Subscription !== "undefined" && Subscription && Subscription.agentGate) {
        screenLoader("Проверяем доступ…");
        Subscription.agentGate().then(function (g) {
          if (S.mountGen !== mg) return;
          if (!g || g.failed) {
            root.innerHTML = '<div class="card empty">Не удалось проверить подписку.<br>'
              + '<button class="btn btn--primary btn--sm" style="margin-top:12px" onclick="render()">Попробовать снова</button></div>';
            return;
          }
          if (g.access === false) {
            try {
              if (typeof agentPaywallHTML === "function") root.innerHTML = agentPaywallHTML(!!g.guest);
              else root.innerHTML = '<div class="card empty">Раздел доступен по подписке Plus.</div>';
            } catch (_) {
              root.innerHTML = '<div class="card empty">Раздел доступен по подписке Plus.</div>';
            }
            return;
          }
          openAgentBody(mg);
        }).catch(function () {
          if (S.mountGen !== mg) return;
          root.innerHTML = '<div class="card empty">Не удалось проверить подписку.<br>'
            + '<button class="btn btn--primary btn--sm" style="margin-top:12px" onclick="render()">Попробовать снова</button></div>';
        });
        return;
      }
    } catch (_) {}
    openAgentBody(mg);
  }
  // Тело раздела после гейта: кэш мгновенно, холодный вход под лоадером.
  function openAgentBody(mg) {
    if (S.mountGen !== mg) return;
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
