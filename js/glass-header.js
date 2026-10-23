/* ============================================================
   lemma go — «жидкая» шапка-таблетка (единый файл компонента).

   Один файл: разметка, стили и поведение. Подключение на странице:

     <div data-glass-header></div>
     <script src="/js/glass-header.js?v=3"></script>

   Необязательные атрибуты слота:
     data-glass-header="back" — вместо CTA ссылка «← К практике»
                                (ege-result.html);
     data-cta-href  — ссылка CTA (по умолчанию /dashboard);
     data-cta-text  — текст CTA (по умолчанию «Начать подготовку»);
     data-maxw      — максимальная ширина таблетки в px.

   Шапка закреплена сверху, но не растянута во всю ширину: это
   отдельная стеклянная капсула с отступами от краёв. При прокрутке
   она остаётся на месте и лишь чуть плотнее проявляет стекло.
   Тема — общий ключ ege_core_theme, как у остального сайта.
   ============================================================ */
(function () {
  "use strict";

  if (window.GlassHeader && window.GlassHeader.__ready) return;

  var THEME_KEY = "ege_core_theme";
  var STYLE_ID = "lgh-styles";

  var SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var CSS = [
    /* ---------- оболочка ---------- */
    ".lgh{",
      "position:fixed;top:calc(12px + env(safe-area-inset-top, 0px));left:0;right:0;",
      "z-index:300;display:flex;justify-content:center;align-items:flex-start;",
      "padding:0 clamp(10px, 2.4vw, 20px);pointer-events:none;",
      "animation:lgh-in .55s var(--ease-out, cubic-bezier(.16,1,.3,1)) both;",
      "--lgh-maxw:800px;",
      "--lgh-ink:var(--text, #0E1526);",
      "--lgh-dim:var(--text-dim, #48536B);",
      "--lgh-line:var(--hairline, rgba(15,23,42,0.08));",
    "}",
    "@keyframes lgh-in{from{opacity:0;transform:translateY(-12px);}to{opacity:1;transform:none;}}",
    ".lgh__shell{",
      "pointer-events:auto;position:relative;isolation:isolate;",
      "display:flex;align-items:center;justify-content:space-between;gap:12px;",
      "width:100%;max-width:min(var(--lgh-maxw), 100%);min-width:0;",
      "padding:9px 10px 9px 12px;border-radius:24px;",
      "background:linear-gradient(135deg, rgba(255,255,255,0.84) 0%, rgba(255,255,255,0.54) 52%, rgba(255,255,255,0.66) 100%);",
      "border:1px solid rgba(255,255,255,0.72);",
      "box-shadow:",
        "0 18px 42px -22px rgba(15,23,42,0.35),",
        "0 2px 8px -4px rgba(15,23,42,0.10),",
        "inset 0 1px 0 rgba(255,255,255,0.95),",
        "inset 0 -1px 0 rgba(15,23,42,0.05);",
      "backdrop-filter:blur(22px) saturate(190%);",
      "-webkit-backdrop-filter:blur(22px) saturate(190%);",
      "transition:background .35s var(--ease-out, cubic-bezier(.16,1,.3,1)),",
        "box-shadow .35s var(--ease-out, cubic-bezier(.16,1,.3,1)),",
        "border-color .35s ease,transform .35s var(--ease-out, cubic-bezier(.16,1,.3,1));",
    "}",
    /* Цветной «сок» внутри стекла: лёгкие зелёно-голубые переливы,
       чтобы шапка читалась как стекло, а не как серая плашка. */
    ".lgh__shell::before{",
      "content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;",
      "background:",
        "radial-gradient(120% 160% at 0% 0%, rgba(56,189,248,0.16) 0%, transparent 46%),",
        "radial-gradient(120% 170% at 100% 100%, rgba(22,192,122,0.14) 0%, transparent 52%);",
      "opacity:.9;transition:opacity .35s ease;pointer-events:none;",
    "}",
    /* Тонкий блик по верхней кромке — «жидкое стекло». */
    ".lgh__shell::after{",
      "content:'';position:absolute;left:10%;right:10%;top:-1px;height:1px;",
      "background:linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent);",
      "opacity:.75;pointer-events:none;",
    "}",
    ".lgh.is-scrolled .lgh__shell{",
      "background:linear-gradient(135deg, rgba(255,255,255,0.93) 0%, rgba(255,255,255,0.70) 52%, rgba(255,255,255,0.80) 100%);",
      "box-shadow:",
        "0 22px 48px -24px rgba(15,23,42,0.42),",
        "0 3px 10px -5px rgba(15,23,42,0.12),",
        "inset 0 1px 0 rgba(255,255,255,1),",
        "inset 0 -1px 0 rgba(15,23,42,0.06);",
    "}",

    /* ---------- тёмная тема ---------- */
    ":root[data-theme=\"dark\"] .lgh{",
      "--lgh-ink:var(--text, #F8F9FB);",
      "--lgh-line:var(--hairline, rgba(255,255,255,0.06));",
    "}",
    ":root[data-theme=\"dark\"] .lgh__shell{",
      "background:linear-gradient(135deg, rgba(26,33,47,0.82) 0%, rgba(9,13,21,0.62) 55%, rgba(15,21,32,0.72) 100%);",
      "border-color:rgba(255,255,255,0.11);",
      "box-shadow:",
        "0 24px 54px -24px rgba(0,0,0,0.82),",
        "0 2px 10px -6px rgba(0,0,0,0.55),",
        "inset 0 1px 0 rgba(255,255,255,0.10),",
        "inset 0 -1px 0 rgba(0,0,0,0.35);",
    "}",
    ":root[data-theme=\"dark\"] .lgh__shell::before{",
      "background:",
        "radial-gradient(120% 160% at 0% 0%, rgba(56,189,248,0.20) 0%, transparent 48%),",
        "radial-gradient(120% 170% at 100% 100%, rgba(110,231,183,0.16) 0%, transparent 54%);",
      "opacity:.85;",
    "}",
    ":root[data-theme=\"dark\"] .lgh__shell::after{",
      "background:linear-gradient(90deg,transparent,rgba(255,255,255,0.32),transparent);",
      "opacity:.8;",
    "}",
    ":root[data-theme=\"dark\"] .lgh.is-scrolled .lgh__shell{",
      "background:linear-gradient(135deg, rgba(30,38,54,0.92) 0%, rgba(11,16,25,0.78) 55%, rgba(18,25,38,0.86) 100%);",
    "}",

    /* ---------- логотип ---------- */
    ".lgh__brand{",
      "display:flex;align-items:center;gap:11px;min-width:0;",
      "color:var(--lgh-ink);text-decoration:none;",
      "font-family:var(--font-display, 'Manrope', system-ui, sans-serif);",
      "font-weight:800;font-size:clamp(16px,2vw,19px);letter-spacing:-0.03em;",
      "white-space:nowrap;line-height:1.3;border-radius:14px;",
    "}",
    ".lgh__brand:focus-visible{outline:2px solid var(--accent, #0277B6);outline-offset:4px;}",
    ".lgh__mark{",
      "position:relative;flex:0 0 auto;display:grid;place-items:center;",
      "width:clamp(36px, 4.6vw, 42px);height:clamp(36px, 4.6vw, 42px);",
      "border-radius:50%;",
      "background:linear-gradient(140deg,#22c07a 0%,#2dd4bf 45%,#38BDF8 100%);",
      "box-shadow:",
        "0 10px 24px -10px rgba(34,192,122,0.65),",
        "inset 0 1px 0 rgba(255,255,255,0.55),",
        "0 0 0 1px rgba(255,255,255,0.16);",
      "transition:transform .35s var(--ease-out, cubic-bezier(.16,1,.3,1));",
    "}",
    ".lgh__brand:hover .lgh__mark{transform:rotate(-6deg) scale(1.04);}",
    ".lgh__mark svg{width:52%;height:52%;display:block;}",
    ".lgh__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;padding-bottom:0.08em;margin-bottom:-0.08em;}",
    ".lgh__name em{font-style:normal;color:var(--brand, #16a34a);}",
    ":root[data-theme=\"dark\"] .lgh__name em{color:var(--brand, #6EE7B7);}",

    /* ---------- действия ---------- */
    ".lgh__actions{display:flex;align-items:center;gap:9px;flex:0 0 auto;min-width:0;}",
    ".lgh__icon{",
      "appearance:none;-webkit-appearance:none;margin:0;padding:0;",
      "width:clamp(38px,4.6vw,42px);height:clamp(38px,4.6vw,42px);border-radius:50%;",
      "display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;",
      "border:1px solid rgba(15,23,42,0.10);",
      "background:rgba(255,255,255,0.42);",
      "color:var(--lgh-ink);cursor:pointer;line-height:0;",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,0.75);",
      "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);",
      "transition:transform .22s var(--ease-out, cubic-bezier(.16,1,.3,1)),",
        "background .22s ease,border-color .22s ease,box-shadow .22s ease;",
    "}",
    ".lgh__icon:hover{",
      "transform:translateY(-1px);background:rgba(255,255,255,0.66);",
      "border-color:rgba(15,23,42,0.18);",
    "}",
    ".lgh__icon:active{transform:translateY(0) scale(0.96);}",
    ".lgh__icon:focus-visible{outline:2px solid var(--accent, #0277B6);outline-offset:2px;}",
    ".lgh__icon svg{width:19px;height:19px;display:block;transition:transform .3s var(--ease-out, cubic-bezier(.16,1,.3,1));}",
    ".lgh__icon:active svg{transform:rotate(50deg) scale(0.88);}",
    ".lgh__brand:active .lgh__mark{transform:scale(0.94);}",
    ":root[data-theme=\"dark\"] .lgh__icon{",
      "border-color:rgba(255,255,255,0.12);",
      "background:rgba(255,255,255,0.06);",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,0.08);",
    "}",
    ":root[data-theme=\"dark\"] .lgh__icon:hover{",
      "background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.22);",
    "}",

    ".lgh__cta{",
      "position:relative;overflow:hidden;",
      "display:inline-flex;align-items:center;justify-content:center;gap:8px;",
      "min-height:clamp(38px,4.6vw,42px);padding:0 clamp(16px,2.4vw,22px);",
      "border-radius:999px;border:1px solid rgba(255,255,255,0.24);",
      "background:linear-gradient(135deg,#38BDF8 0%,#3B82F6 52%,#2563EB 100%);",
      "color:#fff;text-decoration:none;white-space:nowrap;",
      "font-family:var(--font-body, 'Inter', system-ui, sans-serif);",
      "font-weight:700;font-size:clamp(12.5px,1.5vw,14px);letter-spacing:-0.01em;",
      "box-shadow:",
        "0 12px 26px -12px rgba(56,189,248,0.75),",
        "inset 0 1px 0 rgba(255,255,255,0.32);",
      "transition:transform .25s var(--ease-out, cubic-bezier(.16,1,.3,1)),",
        "box-shadow .25s var(--ease-out, cubic-bezier(.16,1,.3,1)),filter .25s ease;",
    "}",
    ".lgh__cta:hover{transform:translateY(-1px);filter:saturate(1.08) brightness(1.04);",
      "box-shadow:0 16px 32px -12px rgba(56,189,248,0.85),inset 0 1px 0 rgba(255,255,255,0.4);}",
    ".lgh__cta:active{transform:translateY(0) scale(0.98);}",
    ".lgh__cta::after{content:'';position:absolute;top:-40%;bottom:-40%;left:-30%;width:44%;",
      "background:linear-gradient(100deg,transparent,rgba(255,255,255,0.55),transparent);",
      "transform:translateX(-160%) skewX(-12deg);transition:transform .7s ease;pointer-events:none;}",
    ".lgh__cta:hover::after{transform:translateX(430%) skewX(-12deg);}",
    ".lgh__cta:focus-visible{outline:2px solid var(--accent, #0277B6);outline-offset:3px;}",
    ".lgh__cta-short{display:none;}",
    ".lgh__cta svg{width:15px;height:15px;flex:0 0 auto;}",

    /* ---------- распорка, чтобы контент не заезжал под шапку ---------- */
    ".lgh-slot{display:block;}",
    ".lgh-spacer{width:100%;pointer-events:none;}",

    /* ---------- адаптив ---------- */
    "@media (max-width:600px){",
      ".lgh{top:calc(8px + env(safe-area-inset-top, 0px));padding:0 10px;}",
      ".lgh__shell{padding:7px 7px 7px 9px;border-radius:21px;gap:8px;}",
      ".lgh__brand{gap:9px;font-size:16px;}",
      ".lgh__actions{gap:7px;}",
      ".lgh__cta{padding:0 22px;min-height:44px;font-size:14px;}",
      ".lgh__cta-long{display:none;}",
      ".lgh__cta-short{display:inline;}",
    "}",
    "@media (max-width:380px){",
      ".lgh__name{font-size:15px;}",
      ".lgh__mark{width:34px;height:34px;}",
      ".lgh__cta{padding:0 18px;font-size:13px;min-height:42px;}",
    "}",

    /* ---------- доступность / фолбэк ---------- */
    "@media (prefers-reduced-motion:reduce){",
      ".lgh{animation:none !important;}",
      ".lgh__shell,.lgh__mark,.lgh__icon,.lgh__icon svg,.lgh__cta,.lgh__cta::after{transition:none !important;}",
      ".lgh__cta::after{display:none;}",
      ".lgh__brand:hover .lgh__mark{transform:none;}",
    "}",
    "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
      ".lgh__shell{background:rgba(255,255,255,0.96);}",
      ":root[data-theme=\"dark\"] .lgh__shell{background:rgba(10,13,19,0.97);}",
      ".lgh.is-scrolled .lgh__shell{background:rgba(255,255,255,0.99);}",
      ":root[data-theme=\"dark\"] .lgh.is-scrolled .lgh__shell{background:rgba(10,13,19,0.99);}",
    "}",
  ].join("");

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function paintThemeButtons() {
    var light = getTheme() === "light";
    var btns = document.querySelectorAll("button.lgh__theme");
    for (var i = 0; i < btns.length; i++) {
      btns[i].innerHTML = light ? MOON_ICON : SUN_ICON;
      btns[i].setAttribute("aria-label", light ? "Переключить на тёмную тему" : "Переключить на светлую тему");
      btns[i].setAttribute("aria-pressed", light ? "true" : "false");
      btns[i].setAttribute("title", light ? "Тёмная тема" : "Светлая тема");
    }
  }

  function setTheme(next, persist) {
    try { document.documentElement.setAttribute("data-theme", next); } catch (_) {}
    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    }
    paintThemeButtons();
  }

  function toggleTheme() {
    setTheme(getTheme() === "light" ? "dark" : "light", true);
  }

  function build(slot) {
    var variant = slot.getAttribute("data-glass-header") || "";
    var ctaHref = (slot.getAttribute("data-cta-href") || "/dashboard").replace(/"/g, "");
    var ctaText = slot.getAttribute("data-cta-text") || "Начать подготовку";
    var maxw = parseInt(slot.getAttribute("data-maxw") || "", 10);

    var wrap = document.createElement("div");
    wrap.className = "lgh-slot";

    var header = document.createElement("header");
    header.className = "lgh";
    if (maxw > 0) header.style.setProperty("--lgh-maxw", maxw + "px");
    header.setAttribute("role", "banner");

    var safeText = String(ctaText).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var ctaHTML;
    if (variant === "back") {
      ctaHTML = '<a class="lgh__cta" href="/dashboard" onclick="if(history.length>1){history.back();return false;}">'
        + '<span class="lgh__cta-long">← К практике</span>'
        + '<span class="lgh__cta-short">← Назад</span></a>';
    } else {
      ctaHTML = '<a class="lgh__cta" href="' + ctaHref + '">'
        + '<span class="lgh__cta-long">' + safeText + '</span>'
        + '<span class="lgh__cta-short">Начать</span></a>';
    }
    header.innerHTML =
      '<div class="lgh__shell">' +
        '<a class="lgh__brand" href="/" aria-label="lemma go — на главную">' +
          '<span class="lgh__mark" aria-hidden="true">' + CHECK_ICON + '</span>' +
          '<span class="lgh__name">lemma <em>go</em></span>' +
        '</a>' +
        '<nav class="lgh__actions" aria-label="Действия">' +
          '<button class="lgh__icon lgh__theme" type="button" aria-label="Переключить тему"></button>' +
          ctaHTML +
        '</nav>' +
      '</div>';

    var spacer = document.createElement("div");
    spacer.className = "lgh-spacer";
    spacer.setAttribute("aria-hidden", "true");

    wrap.appendChild(header);
    wrap.appendChild(spacer);
    return wrap;
  }

  function syncSpacer(wrap) {
    var header = wrap.querySelector(".lgh");
    var spacer = wrap.querySelector(".lgh-spacer");
    if (!header || !spacer) return;
    var shell = header.querySelector(".lgh__shell");
    var h = shell ? shell.getBoundingClientRect().height : 0;
    var top = header.getBoundingClientRect().top;
    spacer.style.height = Math.ceil((top > 0 ? top : 0) + h + (top > 0 ? top : 0)) + "px";
  }

  function mount() {
    var slots = document.querySelectorAll("[data-glass-header]");
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.getAttribute("data-lgh-mounted") === "1") continue;
      var wrap = build(slot);
      slot.appendChild(wrap);
      slot.setAttribute("data-lgh-mounted", "1");
      syncSpacer(wrap);
      if (typeof ResizeObserver !== "undefined") {
        try {
          var ro = new ResizeObserver(function () { syncSpacer(wrap); });
          ro.observe(wrap.querySelector(".lgh__shell"));
        } catch (_) {}
      }
    }
    paintThemeButtons();
    onScroll();
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    var run = function () {
      ticking = false;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      var headers = document.querySelectorAll(".lgh");
      for (var i = 0; i < headers.length; i++) {
        if (y > 12) headers[i].classList.add("is-scrolled");
        else headers[i].classList.remove("is-scrolled");
      }
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else run();
  }

  function onClick(e) {
    var btn = null;
    try { btn = e.target && e.target.closest ? e.target.closest("button.lgh__theme") : null; } catch (_) {}
    if (btn) toggleTheme();
  }

  function onStorage(e) {
    if (!e || e.key !== THEME_KEY) return;
    if (e.newValue === "light" || e.newValue === "dark") setTheme(e.newValue, false);
  }

  injectCSS();
  try { document.addEventListener("click", onClick); } catch (_) {}
  try { window.addEventListener("scroll", onScroll, { passive: true }); } catch (_) {
    try { window.addEventListener("scroll", onScroll); } catch (__) {}
  }
  try { window.addEventListener("resize", function () {
    var slots = document.querySelectorAll("[data-glass-header]");
    for (var i = 0; i < slots.length; i++) {
      var wrap = slots[i].firstChild;
      if (wrap && wrap.className === "lgh-slot") syncSpacer(wrap);
    }
  }, { passive: true }); } catch (_) {}
  try { window.addEventListener("storage", onStorage); } catch (_) {}

  window.GlassHeader = {
    __ready: true,
    mount: mount,
    toggle: toggleTheme,
    get: getTheme,
    set: setTheme
  };

  try { mount(); } catch (_) {}
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();