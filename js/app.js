/* ============================================================
   ege easy — UI / router / screens
   ============================================================ */

/* ---------------- SVG icons ---------------- */

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="9" r="2.2"/><circle cx="8" cy="19" r="2.2"/><path d="M8 6.2l7.7 2M16.5 11l-6.7 6"/></svg>',
  training: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  errors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  trials: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22c4.4 0 7-2.8 7-6.5 0-3-2-5.5-3.5-7C14 7 13 5.5 13 3c-3 2-5 5-5 8-1-.5-1.8-1.5-2-3-1.5 1.6-3 4-3 6.5C3 19.2 7.6 22 12 22z"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  "eye-off": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.5 5.2A9.5 9.5 0 0 1 12 5c5 0 8.5 4.5 10 7-.4.7-1.2 1.8-2.3 2.9M6.6 6.6C4.1 8.1 2.6 10.4 2 12c1.5 2.5 5 7 10 7 1.6 0 3-.5 4.3-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.6-2.4 2-2.4 3.3"/><circle cx="12.1" cy="16.7" r="0.5" fill="currentColor" stroke="none"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4.5"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2.5-8h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/><path d="M3 13h6l1.5 2.5h3L15 13h6"/></svg>',
};

function icon(name) {
  // дефолтный размер 1em: CSS-правила компонентов (px) переопределяют атрибуты
  return (ICONS[name] || ICONS.target).replace("<svg ", '<svg width="1em" height="1em" style="vertical-align:-0.15em" ');
}

/* Theme is deliberately independent from progress state: wiping progress
   must not erase a visual preference, and one shared HTML attribute styles
   every route, modal and future component through the existing CSS tokens. */
const Theme = {
  key: "ege_core_theme",
  current() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; },
  apply(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "";
    try { localStorage.setItem(this.key, dark ? "dark" : "light"); } catch (e) {}
  },
  toggle() { this.apply(this.current() === "dark" ? "light" : "dark"); renderTopbar(); },
};

/* ====================== РОУТЕР ====================== */

const mainHTML = document.createElement('template');
mainHTML.innerHTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Подготовка к ЕГЭ — математика, русский язык, обществознание</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Space+Grotesk:wght@500;600;700&amp;display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0a0b0f;
    --card:#13141c;
    --card-border:rgba(255,255,255,0.07);
    --card-border-strong:rgba(255,255,255,0.14);
    --text:#f2f3f7;
    --text-dim:#9297ab;
    --text-faint:#5c6072;

    --indigo:#6d70f2;
    --indigo-dim:rgba(109,112,242,0.14);
    --amber:#e5a86a;
    --amber-dim:rgba(229,168,106,0.14);
    --green:#3ddc97;
    --green-dim:rgba(61,220,151,0.14);
    --red:#fb6f6f;
    --red-dim:rgba(251,111,111,0.14);

    --radius-lg:22px;
    --radius-md:16px;
    --radius-sm:10px;
    --container:1120px;

    --font-body:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --font-display:'Space Grotesk',var(--font-body);
  }

  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}

  body{
    margin:0;
    background:var(--bg);
    color:var(--text);
    font-family:var(--font-body);
    -webkit-font-smoothing:antialiased;
    line-height:1.5;
  }

  a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:rgba(109,112,242,0.18);}

  h1,.cta-card h2,.logo{font-family:var(--font-display);}

  .wrap{
    max-width:var(--container);
    margin:0 auto;
    padding:0 24px;
    padding-left:max(24px, env(safe-area-inset-left));
    padding-right:max(24px, env(safe-area-inset-right));
  }

  /* ---------- header ---------- */
  header{
    border-bottom:1px solid var(--card-border);
    position:sticky;
    top:0;
    background:rgba(10,11,15,0.9);
    backdrop-filter:blur(8px);
    z-index:10;
  }
  .header-inner{
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:16px 0;
    padding-top:max(16px, calc(env(safe-area-inset-top) + 8px));
    gap:12px;
  }
  .logo{
    display:flex;
    align-items:center;
    gap:10px;
    font-weight:600;
    font-size:15px;
    color:var(--text);
    min-width:0;
    flex:1 1 auto;
  }
  .logo-easy{
    display:flex;
    align-items:center;
    gap:10px;
    font-weight:700;
    font-size:17px;
    letter-spacing:-0.01em;
    text-transform:lowercase;
    flex-shrink:0;
  }
  .logo-easy .easy-badge{
    width:34px;
    height:34px;
    border-radius:50%;
    background:linear-gradient(135deg,#22c07a 0%,#6d70f2 130%);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 6px 16px -6px rgba(34,192,122,0.55);
    flex-shrink:0;
  }
  .logo-easy .easy-badge svg{width:18px;height:18px;}
  .logo-easy em{font-style:normal;color:var(--green);}
</style>
</head>
<body>
<div class="wrap">
  <header class="header">
    <div class="header-inner">
      <div class="logo logo-easy">
        <span class="easy-badge"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span>ege <em>easy</em></span>
      </div>
    </div>
  </header>
</div>
</body>
</html>`;

/* ====================== РОУТЕР ====================== */

const dashboardHTML = document.createElement('template');
dashboardHTML.innerHTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ege easy — подготовка к ЕГЭ</title>
<meta name="description" content="Платформа подготовки к ЕГЭ с отдельными предметами, честным прогрессом и locked-состояниями.">
<script>
  /* Saved choice wins; on the first visit (no saved value) follow the device
     theme, so the onboarding/diagnostic screens never force light mode.
     Runs before styles paint to avoid a theme flash. */
  try {
    var savedTheme = localStorage.getItem("ege_core_theme");
    if (savedTheme === "dark") {
      document.documentElement.dataset.theme = "dark";
    } else if (!savedTheme && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.dataset.theme = "dark";
    }
  } catch (e) {}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="css/styles.css">
<link rel="stylesheet" href="css/lesson.css">
</head>
<body>
<div id="app" class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar__logo sidebar__logo--easy">
      <span class="easy-badge"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="easy-name">ege <em>easy</em></span>
      <span class="logo-sub">подготовка без стресса</span>
    </div>
    <nav class="sidebar__nav" id="sidebarNav"></nav>
    <div class="sidebar__footer" id="sidebarFooter"></div>
  </aside>

  <div class="main">
    <header class="topbar" id="topbar"></header>
    <main class="screen" id="screen"></main>
  </div>

  <nav class="bottomnav" id="bottomnav"></nav>
</div>

<div id="modal-root"></div>
<div id="device-modal-root"></div>
<div id="toast-root" class="toast-root"></div>

<script src="js/data.js"></script>
<script src="js/state.js"></script>
<script src="js/app.js"></script>
</body>
</html>`;

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================
   Блокировка аккаунта: глобальное полноэкранное состояние.
   Backend возвращает 403 + code ACCOUNT_BLOCKED на ЛЮБОМ
   authenticated запросе (см. reject_if_blocked в server.py);
   ApiClient транслирует это в событие ege:account-blocked.
   Окно намеренно нельзя закрыть: нет крестика, Esc и клика по
   backdrop — только «Вернуться на главную» (лендинг /).
   Визуально — та же .dlg-система, что у устройств в профиле.
   ============================================================ */

let accountBlocked = null;

function isBlockedError(e) {
  return !!(e && (e.code === "ACCOUNT_BLOCKED"
    || (e.payload && (e.payload.code === "ACCOUNT_BLOCKED" || e.payload.blocked === true))));
}

function blockedDetail(e) {
  if (e && e.payload && typeof e.payload === "object") return e.payload;
  if (e && typeof e === "object" && (e.code === "ACCOUNT_BLOCKED" || e.blocked === true)) return e;
  return null;
}

function fmtBlockedUntil(payload) {
  if (!payload) return "Бессрочно";
  if (payload.permanent || payload.blockedUntil == null) return "Бессрочно";
  const d = new Date(Number(payload.blockedUntil));
  if (Number.isNaN(d.getTime())) return "Бессрочно";
  try {
    return "До " + d.toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return "Бессрочно"; }
}

function blockedModalRoot() {
  let root = null;
  try { root = document.getElementById("blocked-modal-root"); } catch (_) { root = null; }
  if (!root) {
    try {
      root = document.createElement("div");
      root.id = "blocked-modal-root";
      document.body.appendChild(root);
    } catch (_) { return null; }
  }
  return root;
}

function showAccountBlocked(payload) {
  const info = (payload && typeof payload === "object") ? payload : {};
  accountBlocked = info;
  try { window.__egeBlocked = info; } catch (_) {}
  const root = blockedModalRoot();
  if (!root) return;
  // Старый интерфейс за модалкой не должен оставаться рабочим: чистим экран,
  // чтобы назад/вперёд и stale-DOM не давали кликабельный кэш.
  try {
    const screen = document.getElementById("screen");
    if (screen) screen.innerHTML = "";
  } catch (_) {}
  const reason = typeof info.reason === "string" ? info.reason.trim() : "";
  root.innerHTML = `
    <div class="dlg-backdrop dlg-backdrop--blocked">
      <div class="dlg dlg--blocked" role="dialog" aria-modal="true" aria-label="Доступ ограничен">
        <div class="dlg__eyebrow">Доступ ограничен</div>
        <div class="dlg-device">
          <div class="dlg-device__icon" aria-hidden="true">${icon("lock")}</div>
          <div class="dlg-device__name">Твой аккаунт заблокирован</div>
        </div>
        <div class="dlg__text">Ты пока не можешь пользоваться разделами ege easy. Главная страница остаётся доступной.</div>
        <div class="dlg-kv">
          <div class="dlg-kv__row dlg-kv__row--col"><span>Причина</span><span>${reason ? esc(reason) : "Причина не указана."}</span></div>
          <div class="dlg-kv__row"><span>Срок</span><span>${esc(fmtBlockedUntil(info))}</span></div>
        </div>
        <div class="dlg__actions dlg__actions--single">
          <button class="btn btn--primary" type="button" onclick="location.href='/'">Вернуться на главную</button>
        </div>
      </div>
    </div>`;
  // Фокус для скринридеров; закрывающих слушателей нет осознанно:
  // ни Esc, ни клик по backdrop окно не закрывают.
  try {
    const dlg = root.querySelector(".dlg");
    if (dlg) { dlg.setAttribute("tabindex", "-1"); dlg.focus({ preventScroll: true }); }
  } catch (_) {}
}

function hideAccountBlocked() {
  accountBlocked = null;
  try { window.__egeBlocked = null; } catch (_) {}
  try {
    const root = document.getElementById("blocked-modal-root");
    if (root) root.innerHTML = "";
  } catch (_) {}
}

try {
  window.addEventListener("ege:account-blocked", (e) => {
    try { showAccountBlocked((e && e.detail) || {}); } catch (_) {}
  });
  window.addEventListener("ege:account-unblocked", () => {
    try { hideAccountBlocked(); } catch (_) {}
  });
} catch (_) {}

/* Единственный рендерер математики проекта.
   Новый формат данных: inline `\\(...\\)`, крупная формула `\\[...\\]`.
   Нормализация ниже сохраняет совместимость со старыми строками каталога. */
function mathText(value) {
  const source = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  const supers = { "⁰":"0", "¹":"1", "²":"2", "³":"3", "⁴":"4", "⁵":"5", "⁶":"6", "⁷":"7", "⁸":"8", "⁹":"9", "⁻":"-", "ⁿ":"n" };
  const subs = { "₀":"0", "₁":"1", "₂":"2", "₃":"3", "₄":"4", "₅":"5", "₆":"6", "₇":"7", "₈":"8", "₉":"9", "₋":"-", "ₙ":"n" };
  // Сбалансированные скобки: `2^(log_2(log_2(x)))` и `log_2(log_2(x))`
  // нельзя разобрать классом [^()]+ — сканируем до парной закрывающей.
  const closeParen = (text, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (!depth) return i; }
      else if (c === "\n") return -1;
    }
    return -1;
  };
  // Все формы логарифма одним проходом слева направо. Обязательно ДО
  // правил степеней/подстрочников ниже: те превратили бы `log₂(8)`
  // в `log_{2}(8)` (курсивный «log» вместо прямого) и `log_2x` в `log_{2x}`.
  // Понимает: log_2(x), log_a(b), log_10(x), log₀.₆(x), log_2x, log_4²x,
  // вложенные log_2(log_2(x)) — аргумент разбирается рекурсивно.
  const convertLog = (text) => {
    const re = /(^|[^A-Za-z])log(?:_(\d+(?:\.\d+)?|[A-Za-z])([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]*)|_?((?:[₀₁₂₃₄₅₆₇₈₉₋]+(?:\.[₀₁₂₃₄₅₆₇₈₉₋]+)?))((?:[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)?))?/gi;
    let out = "", cursor = 0, m;
    while ((m = re.exec(text))) {
      const after = m.index + m[0].length;
      const next = text[after] || "";
      const asciiBase = m[2], asciiPow = m[3], uniBase = m[4], uniPow = m[5];
      // `log` внутри слова (catalog, dialog, logarithm) — не наша конструкция.
      if (!asciiBase && !uniBase && /[A-Za-z0-9_]/.test(next)) {
        out += text.slice(cursor, m.index + m[0].length);
        cursor = m.index + m[0].length;
        continue;
      }
      let base = "";
      if (asciiBase) base = asciiBase;
      else if (uniBase) base = [...uniBase].map((c) => (c === "." ? "." : (subs[c] || c))).join("");
      let pow = "";
      if (asciiPow || uniPow) pow = [...(asciiPow || uniPow)].map((c) => supers[c] || c).join("");
      // Аргумент в скобках (пробел между log и скобкой допускаем).
      let j = after;
      while (text[j] === " ") j++;
      let cmd;
      if (!base && !pow && next !== "(" && text[j] !== "(") {
        cmd = "\\log "; // голое упоминание `log` в тексте — прямой шрифт
        out += text.slice(cursor, m.index) + m[1] + cmd;
        cursor = after;
        continue;
      }
      cmd = `\\log${base ? `_{${base}}` : ""}${pow ? `^{${pow}}` : ""}`;
      if (text[j] === "(") {
        const end = closeParen(text, j);
        if (end < 0) {
          out += text.slice(cursor, m.index) + m[1] + cmd + text.slice(after, j + 1);
          cursor = j + 1;
          continue;
        }
        cmd += `\\left(${convertLog(text.slice(j + 1, end))}\\right)`;
        out += text.slice(cursor, m.index) + m[1] + cmd;
        cursor = end + 1;
      } else {
        out += text.slice(cursor, m.index) + m[1] + cmd + " ";
        cursor = after;
      }
    }
    return out + text.slice(cursor);
  };
  // Остаток `основание^(...)` со скобками внутри (простой случай [^()]+
  // разобран ниже основной цепочкой): 2^(\log_{2}\left(9\right)).
  const convertCaret = (text) => {
    let out = text, guard = 0;
    for (;;) {
      const m = /([A-Za-zА-Яа-я0-9)}\]])\^\(/.exec(out);
      if (!m || guard++ > 20) break;
      const openIdx = m.index + m[0].length - 1;
      const end = closeParen(out, openIdx);
      if (end < 0) break;
      out = `${out.slice(0, m.index)}${m[1]}^{${out.slice(openIdx + 1, end)}}${out.slice(end + 1)}`;
    }
    return out;
  };
  const normalizeLegacy = (text) => {
    // Legacy catalog strings contain bare expressions (x², √(...), log_a(x)).
    // Collect the whole Latin/numeric/operator run before adding delimiters;
    // wrapping individual superscripts was the source of mixed typography.
    const convert = (raw) => convertCaret(convertLog(raw)
      .replace(/([A-Za-zА-Яа-я0-9])⃗/g, "\\vec{$1}")
      .replace(/([A-Za-zА-Яа-я0-9π∞θτωΔαεΣ)])([⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁻]+)/g, (_m, base, power) => `${base}^{${[...power].map((c) => supers[c] || c).join("")}}`)
      .replace(/([A-Za-zА-Яа-я0-9π∞θτωΔαεΣ)])([₀₁₂₃₄₅₆₇₈₉₋ₙ]+)/g, (_m, base, sub) => `${base}_{${[...sub].map((c) => subs[c] || c).join("")}}`)
      .replace(/([A-Za-zА-Яа-я0-9π∞θτωΔαεΣ)])\^\(([^()\n]+)\)/g, "$1^{$2}")
      .replace(/([A-Za-zА-Яа-я0-9π∞θτωΔαεΣ)])\^([−-]?[A-Za-zА-Яа-я0-9]+)/g, "$1^{$2}")
      // A bare multi-letter subscript (S_CDE, S_ABF, S_MAK, ...) reaches this
      // point unbraced -- LaTeX/KaTeX subscripts only the first character
      // after `_` unless braced, so "S_CDE" rendered as "S" with a small "C"
      // followed by a normal-size "DE" instead of the whole label small.
      // Single-letter subscripts (x_B) already scope correctly and are left
      // alone; Cyrillic subscripts are handled earlier (need `\text{}`, not
      // just braces, since raw Cyrillic is invalid KaTeX math-mode content).
      .replace(/([A-Za-zА-Яа-я0-9)])_([A-Za-z0-9]{2,})/g, "$1_{$2}")
      .replace(/√\(([^()\n]+)\)/g, "\\sqrt{$1}")
      .replace(/√([A-Za-zА-Яа-я0-9]+)/g, "\\sqrt{$1}")
      .replace(/\(([^()\n]+)\)\s*\/\s*(\d+(?:\.\d+)?[A-Za-z]+|\d+(?:\.\d+)?|[A-Za-zА-Яа-я][A-Za-zА-Яа-я0-9]*)/g, "\\frac{$1}{$2}")
      .replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, "\\frac{$1}{$2}")
      .replace(/\blog_([A-Za-z0-9.]+)\(([^()\n]+)\)/gi, "\\log_{$1}\\left($2\\right)")
      .replace(/\blog([₀₁₂₃₄₅₆₇₈₉₋]+)\(([^()\n]+)\)/gi, (_x, base, arg) => `\\log_{${[...base].map((c) => subs[c] || c).join("")}}\\left(${arg}\\right)`)
      .replace(/(^|[^A-Za-z\\])(sin|cos|tan)(?=[A-Za-z0-9_(^⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁻])/gi, "$1\\$2 ")
      .replace(/±/g, "\\pm")
      .replace(/∠/g, "\\angle ")
      .replace(/∥/g, "\\parallel ")
      .replace(/Σ/g, "\\Sigma ")
      .replace(/α/g, "\\alpha ")
      .replace(/ε/g, "\\varepsilon ")
      .replace(/∞/g, "\\infty ")
      .replace(/∪/g, "\\cup ")
      .replace(/∩/g, "\\cap ")
      .replace(/⊥/g, "\\perp ")
      .replace(/∈/g, "\\in ")
      .replace(/≠/g, "\\ne ")
      .replace(/≤/g, "\\le ")
      .replace(/≥/g, "\\ge ")
      .replace(/≈/g, "\\approx ")
      .replace(/⇒/g, "\\Rightarrow ")
      .replace(/⟺/g, "\\iff ")
      .replace(/→/g, "\\to ")
      .replace(/×/g, "\\times ")
      .replace(/·/g, "\\cdot ")
      .replace(/%/g, "\\%")
      .replace(/π/g, "\\pi ")
      .replace(/θ/g, "\\theta ")
      .replace(/τ/g, "\\tau ")
      .replace(/ω/g, "\\omega ")
      .replace(/Δ/g, "\\Delta ")
      .replace(/⌊/g, "\\lfloor ")
      .replace(/⌋/g, "\\rfloor ")
      .replace(/−/g, "-"));
    const mathRun = /(?:√|[A-Za-z0-9(∠\-−π∞θτωΔ|])(?:[A-Za-z0-9π∞θτωΔ′°'^⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁻₀₁₂₃₄₅₆₇₈₉₋ₙ_()+{}\-−*/=·×.,;:<>|\[%√\]\\ ±⃗∠∥Σαε∞∪∩⊥≈→⇒⟺≤≥≠∈⌊⌋]|√)*/g;
    return text.replace(mathRun, (run, offset, full) => {
      let trimmed = run.trim();
      if (!trimmed || !(/[0-9=√^⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁻₀₁₂₃₄₅₆₇₈₉₋ₙ∠∥Σαε∞∪⃗×·≈→⇒⟺≤≥≠∈∩⊥|%θτωΔ⌊⌋]|\b(?:log|sin|cos|tan)\b/i.test(trimmed))) return run;
      const lead = run.slice(0, run.indexOf(trimmed));
      let trail = run.slice(run.indexOf(trimmed) + trimmed.length);
      // Точка в конце предложения (…+ 1). Сейчас она заглатывается внутрь
      // формулы и рисуется жирным внутри KaTeX — как на скриншоте
      // «X × (1.2² + 1.2 + 1).» Выносим её в обычный текст.
      let dot = "";
      if (trimmed.length > 1 && trimmed.endsWith(".")) {
        const next = (full && full[offset + run.length]) || "";
        if (next === "" || next === "\n" || /\s/.test(next) || /[А-Яа-яЁё]/.test(next)) {
          trimmed = trimmed.slice(0, -1);
          dot = ".";
        }
      }
      return `${lead}\\(${convert(trimmed)}\\)${dot}${trail}`;
    });
  };
  const protectExplicit = /\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)/g;
  // A bare "letter_кириллица" subscript (S_бок, V_шара, P_осн, ...) is
  // common in catalog solution text but the legacy math-run detector above
  // never offers it to convert(): its continuation charset is Latin/digit
  // only, so the run stops dead at the underscore, "S_" alone doesn't look
  // like math (no digit/symbol), and "бок" never starts a run either --
  // the whole thing falls through as literal, unrendered text. Cyrillic is
  // also invalid raw KaTeX math-mode content (it errors), so this needs an
  // explicit `\text{}`-wrapped span of its own, generated inline here and
  // protected the same way an already-explicit \(...\) block is below.
  const bareCyrillicSubscript = /([A-Za-zА-Яа-я0-9)])_([а-яёА-ЯЁ]+(?:\.[а-яёА-ЯЁ]+)*)/g;
  const protectPattern = new RegExp(`${protectExplicit.source}|${bareCyrillicSubscript.source}`, "g");
  const normalize = (text) => {
    let out = "", cursor = 0, match;
    while ((match = protectPattern.exec(text))) {
      out += normalizeLegacy(text.slice(cursor, match.index));
      out += match[1] != null ? `\\(${match[1]}_{\\text{${match[2]}}}\\)` : match[0];
      cursor = match.index + match[0].length;
    }
    return out + normalizeLegacy(text.slice(cursor));
  };
  const render = (latex, display) => {
    if (window.katex) {
      try { return window.katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: "ignore" }); } catch (_) {}
    }
    return `<span class="math-fallback">${esc(latex)}</span>`;
  };
  const normalized = normalize(source);
  const chunks = [];
  let cursor = 0;
  const re = /\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g;
  let match;
  while ((match = re.exec(normalized))) {
    if (match.index > cursor) chunks.push(esc(normalized.slice(cursor, match.index)).replace(/\n/g, "<br>"));
    chunks.push(render(match[1] || match[2], !!match[1]));
    cursor = match.index + match[0].length;
  }
  if (!chunks.length) return esc(normalized).replace(/\n/g, "<br>");
  if (cursor < normalized.length) chunks.push(esc(normalized.slice(cursor)).replace(/\n/g, "<br>"));
  return chunks.join("");
}

function fmtTime(sec) {
  const value = finiteNumber(sec, 0);
  sec = Math.max(0, Math.round(value));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

const RU_MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/* Дата вида YYYY-MM-DD → «10 сентября». Невалидный ввод — как есть. */
function ruDateGenitive(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return String(dateStr || "");
  const month = RU_MONTHS_GEN[Number(m[2]) - 1];
  if (!month) return String(dateStr || "");
  return `${Number(m[3])} ${month}`;
}

function forecastTrendLabel(trend) {
  if (!trend) return "Динамика появится после второго дня подготовки";
  const when = ruDateGenitive(trend.fromDate);
  if (trend.delta === 0) return `Без изменений с ${when}`;
  return `${trend.delta > 0 ? "▲" : "▼"} ${trend.delta > 0 ? "+" : ""}${trend.delta} с ${when}`;
}

/* Покрытие прогноза: сколько уроков пройдено и по скольким темам
   у алгоритма уже есть данные (урок или практика). Полное покрытие —
   все уроки закрыты и все темы с весом покрыты. */
function forecastCoverage() {
  const lessons = DataAPI.lessons();
  const done = lessons.filter((l) => !!Store.state.completedLessons[l.id]).length;
  const lessonPct = lessons.length ? Math.round((done / lessons.length) * 100) : 100;
  const skills = DataAPI.skills().filter((s) => skillEgeWeight(s.id) > 0);
  const now = Date.now();
  let covered = 0;
  for (const s of skills) {
    const hasLesson = DataAPI.lessonsBySkill(s.id).some((l) => !!Store.state.completedLessons[l.id]);
    if (hasLesson || forecastSkillMastery(s.id, now) >= 25) covered++;
  }
  return {
    lessonPct, doneLessons: done, totalLessons: lessons.length,
    covered, totalSkills: skills.length,
    full: lessonPct === 100 && covered === skills.length,
  };
}

function forecastNoteHTML() {
  const c = forecastCoverage();
  if (c.full) return "Прогноз на основе всех пройденных уроков — оценка относительно точная. Это ориентир, а не официальный балл.";
  if (!c.totalLessons) return "Прогноз может быть точнее: данных пока мало. Чтобы прогноз стал точнее — проходи уроки и практику";
  return `Прогноз может быть точнее: у тебя пройдено ${c.lessonPct}% уроков (${c.doneLessons} из ${c.totalLessons}). Чтобы прогноз стал точнее — проходи уроки и практику`;
}

function safeForecast() {
  // Пустой/coming-soon предмет не должен получать чужие веса профиля:
  // state.js исторически оставляет fallback-конфиг, а UI обязан показывать
  // честное «скоро», а не 0–12 баллов из несуществующих тем.
  try {
    const state = subjectContentState();
    if (state && (state.empty || state.locked)) return { low: 0, high: 0, mid: 0, empty: true };
  } catch (_) {}
  let value = null;
  try { value = forecast(); } catch (_) { value = null; }
  if (!value || typeof value !== "object") return { low: 0, high: 0, mid: 0, empty: true };
  const low = finiteNumber(value.low, 0);
  const high = finiteNumber(value.high, 0);
  const mid = finiteNumber(value.mid, 0);
  if (![low, high, mid].every(Number.isFinite)) return { low: 0, high: 0, mid: 0, empty: true };
  return { ...value, low, high, mid, empty: !!value.empty || (!value.empty && high < low) };
}

function stars(n) {
  let out = "";
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= n ? "" : "off"}">★</span>`;
  return `<span class="stars">${out}</span>`;
}

function progressBar(pct, cls = "") {
  const value = finiteNumber(pct, 0);
  const safePct = Math.min(100, Math.max(0, value));
  return `<div class="progress ${cls}"><div class="progress__fill" style="width:${safePct}%"></div></div>`;
}

/* Один формат лестницы помощи для задач и data-driven уроков.
   Контент урока задаёт три точных уровня; старые задачи получают
   честный промежуточный шаг, пока их банк не расширен отдельными подсказками. */
function hintLevelsFor(item) {
  if (Array.isArray(item.hints) && item.hints.length >= 3) return item.hints.slice(0, 3);
  const first = item.hint || "Вернись к условию и выдели известные данные.";
  return [
    first,
    "Раздели решение на один ближайший вычислительный шаг и проверь знак, единицы и условие ответа.",
    item.solution || first,
  ];
}

/* Visual material belongs to the task, so every flow can render it through
   this one helper. Missing or malformed assets stay local to the task card. */
function taskVisualHtml(task, context = "task") {
  // MathVisual: a declarative spec (task.mathVisual) is rendered live by
  // js/mathvisual.js instead of pointing at a static image. This placeholder
  // just carries the spec; mountMathVisuals() (a MutationObserver set up once
  // at boot) fills it in once the markup below is actually in the DOM.
  if (task && task.mathVisual) {
    const spec = esc(JSON.stringify(task.mathVisual));
    const ratio = Number(task.mathVisual.ratio);
    const ratioStyle = Number.isFinite(ratio) && ratio > 0 ? ' style="--visual-ratio:' + esc(String(ratio)) + '"' : "";
    // Плейсхолдер живёт без содержимого, пока Vendor.ensureMath() не подтянет
    // ~1,2 МБ вендора и MathVisualMount не смонтирует диаграмму. Пустой div
    // с рамкой выглядел как «блок без рисунка» (особенно в светлой теме) и
    // оставался таким навсегда, если вендор не загрузился. Поэтому внутри
    // сразу лежит видимый текст-заглушка: до монтирования — «загружается»,
    // после успешного рендера движок заменяет innerHTML доской.
    return '<div class="task-visual mathvisual-host" data-mathvisual="' + spec + '" data-visual-context="' + esc(context) + '"' + ratioStyle + '>' +
      '<div class="task-visual__fallback" style="display:block" role="status">Рисунок загружается…</div></div>';
  }
  const visual = task && task.visual;
  if (!visual) return "";
  if (!visual.assetId) {
    // Источник прямо требует рисунок ("Рисунок: ОБЯЗАТЕЛЕН"), но официальный
    // чертёж недоступен в этой сборке — честно показываем это, а не молчим.
    if (!visual.required) return "";
    return '<div class="task-visual task-visual--missing" role="status">' +
      '<div class="task-visual__fallback" style="display:block">' +
      'Официальный рисунок этого задания недоступен в этой сборке' +
      (visual.note ? ': ' + esc(visual.note) : '.') + '</div></div>';
  }
  const asset = DataAPI.visualAsset(visual.assetId);
  if (!asset || !asset.src) {
    return '<div class="task-visual task-visual--missing" role="status">Визуальный материал недоступен.</div>';
  }
  const type = asset.type || visual.type || "image";
  const label = asset.alt || visual.alt || "Визуальный материал задания";
  const ratio = Number(asset.ratio || visual.ratio);
  const ratioStyle = Number.isFinite(ratio) && ratio > 0 ? ' style="--visual-ratio:' + esc(String(ratio)) + '"' : "";
  const src = esc(asset.src);
  const caption = asset.caption || visual.caption;
  return '<figure class="task-visual task-visual--' + esc(type) + '" data-visual-context="' + esc(context) + '"' + ratioStyle + '>' +
    '<img src="' + src + '" alt="' + esc(label) + '" loading="lazy" decoding="async" onerror="this.closest(\'.task-visual\').classList.add(\'task-visual--broken\');this.style.display=\'none\';">' +
    '<div class="task-visual__fallback" role="status">Визуальный материал недоступен.</div>' +
    (caption ? '<figcaption>' + mathText(caption) + '</figcaption>' : "") +
    '</figure>';
}

/* ---------------- toast ---------------- */

function toast(html, type = "", iconName = null) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", "status");
  el.innerHTML = `${iconName ? icon(iconName) : ""}<div>${html}</div>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 350);
  }, 3400);
}

/* ---------------- account id copy ---------------- */

function copyAccountId(btn) {
  const id = btn.dataset.accountId || "";
  if (!id) return;
  const wrap = btn.closest(".account-id-wrap");
  const feedback = wrap ? wrap.querySelector(".account-id__feedback") : null;
  const iconEl = btn.querySelector(".account-id__icon");
  const announce = () => {
    if (iconEl) iconEl.innerHTML = icon("check");
    btn.classList.add("account-id--copied");
    if (feedback) feedback.classList.add("is-visible");
    clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(() => {
      if (iconEl) iconEl.innerHTML = icon("copy");
      btn.classList.remove("account-id--copied");
      if (feedback) feedback.classList.remove("is-visible");
    }, 1800);
  };
  const legacyCopy = () => {
    const ta = document.createElement("textarea");
    ta.value = id;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, id.length);
    try { document.execCommand("copy"); announce(); } catch (e) { /* clipboard unavailable in this browser */ }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(id).then(announce).catch(legacyCopy);
  } else {
    legacyCopy();
  }
}

/* ---------------- modal ---------------- */

let modalPrevFocus = null;

function openModal(html, ariaLabel) {
  const root = document.getElementById("modal-root");
  modalPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-wrap"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(ariaLabel || "Информация")}">
        <div class="modal__grab" aria-hidden="true"><span></span></div>
        <button class="modal__close" onclick="closeModal()" aria-label="Закрыть окно">${icon("x")}</button>
        ${html}
      </div></div>
    </div>`;
  document.addEventListener("keydown", modalEscHandler);
  const modal = root.querySelector(".modal");
  if (modal) { modal.setAttribute("tabindex", "-1"); modal.focus({ preventScroll: true }); }
}

function modalEscHandler(e) {
  if (e.key === "Escape") {
    closeModal();
    return;
  }
  if (e.key !== "Tab") return;
  // Диалог не должен выпускать фокус на страницу под ним. Это особенно важно
  // для информационного locked-окна: после него пользователь возвращается к
  // выбранной теме, а не к скрытой кнопке урока/практики.
  const modal = document.querySelector("#modal-root .modal");
  if (!modal) return;
  const focusable = [...modal.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((node) => node.getClientRects().length > 0);
  if (!focusable.length) {
    e.preventDefault();
    modal.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
    e.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function closeModal() {
  const root = document.getElementById("modal-root");
  if (!root.innerHTML) return;
  root.innerHTML = "";
  document.removeEventListener("keydown", modalEscHandler);
  if (modalPrevFocus && modalPrevFocus.isConnected) {
    modalPrevFocus.focus({ preventScroll: true });
  }
  modalPrevFocus = null;
}

/* ---------------- modal swipe-to-close ----------------
   Один механизм на все окна: тянем модалку вниз — она едет за
   пальцем/мышью и закрывается, если отпустить после порога
   (четверть высоты окна, 90–150px) или быстрым броском вниз.
   Жест работает от верхней части окна (верхние 60% высоты
   или ручка) и только когда контент не проскроллен — иначе жест
   остаётся обычным скроллом. Мышь едет через pointer-события,
   палец — через touch-события с preventDefault: без него браузер
   одновременно крутит внутренний скролл и обрывает жест через
   pointercancel — отсюда дёрганье на телефонах. Слушатели висят
   глобально один раз, поэтому покрывают каждое окно из openModal
   без правок вызовов. */

const modalSwipe = { modal: null, pid: null, tid: null, startY: 0, startTop: 0, lastY: 0, lastT: 0, vy: 0, dy: 0, shown: 0, dragging: false, fromGrab: false };

function modalSwipeThreshold(m) {
  const h = (m && m.offsetHeight) || 420;
  return Math.min(Math.max(h * 0.24, 90), 150);
}

function modalSwipeSuppressClick() {
  const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener("click", stop, true);
  setTimeout(() => window.removeEventListener("click", stop, true), 350);
}

function modalSwipeTop(m) {
  try { return m.getBoundingClientRect().top; } catch (_) { return 0; }
}

function modalSwipeBegin(modal, y, fromGrab) {
  const s = modalSwipe;
  s.modal = modal;
  s.startY = s.lastY = y; s.lastT = performance.now();
  s.vy = 0; s.dy = 0; s.shown = 0; s.dragging = false;
  s.fromGrab = fromGrab;
  try { s.startTop = y - modalSwipeTop(modal); } catch (_) { s.startTop = 0; }
}

function modalSwipeMove(m, y) {
  const s = modalSwipe;
  const now = performance.now();
  if (now > s.lastT) {
    const v = (y - s.lastY) / Math.max(1, now - s.lastT);
    s.vy = s.vy * 0.6 + v * 0.4;
    s.lastY = y; s.lastT = now;
  }
  const d = y - s.startY;
  if (!s.dragging) {
    if (d < 10) return false;
    if (m.scrollTop > 8) return false; // контент проскроллен — это скролл
    if (!s.fromGrab && s.startTop > Math.max(200, m.offsetHeight * 0.6)) return false; // жест от верха
    s.dragging = true;
    m.classList.add("modal--drag");
  }
  s.dy = Math.max(0, d);
  const th = modalSwipeThreshold(m);
  s.shown = s.dy <= th ? s.dy : th + (s.dy - th) * 0.55; // мягкое сопротивление за порогом
  m.style.transform = `translateY(${s.shown}px)`;
  const bd = m.closest ? m.closest(".modal-backdrop") : null;
  if (bd) bd.style.opacity = String(Math.max(0.2, 1 - s.shown / (m.offsetHeight * 1.3)));
  return true;
}

function modalSwipeFinish() {
  const s = modalSwipe;
  const m = s.modal;
  const wasDrag = s.dragging, shown = s.shown, vy = s.vy;
  s.pid = null; s.tid = null; s.modal = null; s.dragging = false; s.dy = 0; s.shown = 0;
  if (!m || !m.isConnected || !wasDrag) return;
  m.classList.remove("modal--drag");
  const bd = m.closest ? m.closest(".modal-backdrop") : null;
  if (shown >= modalSwipeThreshold(m) || (vy > 0.55 && shown > 48)) {
    modalSwipeSuppressClick(); // гасим клик, долетевший после броска
    m.classList.add("modal--dismiss");
    m.style.transform = `translateY(${(m.offsetHeight || 420) + 60}px)`;
    if (bd) { bd.style.transition = "opacity .18s ease-in"; bd.style.opacity = "0"; }
    setTimeout(closeModal, 190);
  } else {
    if (shown > 24) modalSwipeSuppressClick();
    m.classList.add("modal--snap");
    m.style.transform = "";
    if (bd) bd.style.opacity = "";
    setTimeout(() => m.classList.remove("modal--snap"), 300);
  }
}

/* Мышь (ПК): pointer-событий хватает, скролл-конфликта нет. */
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") return;
  if (e.button !== 0) return;
  const t = e.target;
  const modal = t && t.closest ? t.closest("#modal-root .modal") : null;
  if (!modal) return;
  if (t === modal && e.offsetX > modal.clientWidth) return; // тащат скроллбар, не окно
  modalSwipe.pid = e.pointerId;
  modalSwipeBegin(modal, e.clientY, !!(t.closest && t.closest(".modal__grab")));
}, { passive: true });

window.addEventListener("pointermove", (e) => {
  const s = modalSwipe;
  if (e.pointerType !== "mouse") return;
  if (s.pid === null || e.pointerId !== s.pid) return;
  if (!s.modal || !s.modal.isConnected) { s.pid = null; return; }
  const d = e.clientY - s.startY;
  if (!s.dragging && d < -12) { s.pid = null; return; } // потянули вверх — не наш жест
  modalSwipeMove(s.modal, e.clientY);
}, { passive: true });

function modalSwipeMouseEnd(e) {
  if (e.pointerType !== undefined && e.pointerType !== "mouse") return;
  if (e.pointerId !== undefined && e.pointerId !== modalSwipe.pid) return;
  modalSwipeFinish();
}
window.addEventListener("pointerup", modalSwipeMouseEnd, { passive: true });
window.addEventListener("pointercancel", modalSwipeMouseEnd, { passive: true });

/* Палец (телефон): отдельные touch-события. move — непассивный, чтобы
   preventDefault гасил нативный скролл, пока окно едет за пальцем. */
document.addEventListener("touchstart", (e) => {
  if (modalSwipe.tid !== null) return;
  const tc = e.changedTouches && e.changedTouches[0];
  if (!tc) return;
  const t = e.target;
  const modal = t && t.closest ? t.closest("#modal-root .modal") : null;
  if (!modal) return;
  modalSwipe.tid = tc.identifier;
  modalSwipeBegin(modal, tc.clientY, !!(t.closest && t.closest(".modal__grab")));
}, { passive: true });

document.addEventListener("touchmove", (e) => {
  const s = modalSwipe;
  if (s.tid === null || !s.modal || !s.modal.isConnected) return;
  let tc = null;
  const list = e.changedTouches || e.touches;
  for (let i = 0; i < (list ? list.length : 0); i++) {
    if (list[i].identifier === s.tid) { tc = list[i]; break; }
  }
  if (!tc) return;
  const d = tc.clientY - s.startY;
  if (!s.dragging) {
    if (d < 10) { if (d < -12) { s.tid = null; s.modal = null; } return; }
    if (s.modal.scrollTop > 8) { s.tid = null; s.modal = null; return; }
    if (!s.fromGrab && s.startTop > Math.max(200, s.modal.offsetHeight * 0.6)) { s.tid = null; s.modal = null; return; }
  }
  if (e.cancelable) e.preventDefault(); // давим нативный скролл — окно едет ровно за пальцем
  modalSwipeMove(s.modal, tc.clientY);
}, { passive: false });

document.addEventListener("touchend", (e) => {
  if (modalSwipe.tid === null) return;
  const list = e.changedTouches || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === modalSwipe.tid) { modalSwipeFinish(); return; }
  }
}, { passive: true });
document.addEventListener("touchcancel", (e) => {
  if (modalSwipe.tid === null) return;
  const list = e.changedTouches || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === modalSwipe.tid) { modalSwipeFinish(); return; }
  }
}, { passive: true });

/* ---------------- контекстные подсказки ----------------
   Единая система объяснений элементов интерфейса.
   Два типа точек входа:
   - helpDot(key): маленькая иконка "?" рядом с элементом;
   - кликабельный существующий блок (streak-chip): onclick + CSS-класс.
   Тексты опираются только на реальную логику из js/state.js. */

const HELP = {
  xp: {
    title: "Опыт и уровни",
    body: `
      <p><b>Опыт (XP)</b> — это очки за учёбу. Их дают за каждое задание — даже если ответ неправильный, без очков не останешься.</p>
      <p>За правильный ответ очков больше. А если брал подсказку или уже решал это задание раньше — получишь меньше.</p>
      <p>Ещё очки дают за исправленные ошибки, пройденные уроки и тренировки, а за каждый новый уровень — бонус <b>+50</b>. Полоска «столько-то из столько-то» показывает, сколько осталось до следующего уровня.</p>`,
  },
  streak: {
    title: "Серия дней",
    body: `
      <p>Серия — это сколько <b>дней подряд</b> ты занимаешься.</p>
      <p>Чтобы день засчитался, достаточно позаниматься: решить задание или пройти урок. Ошибаться можно — главное, что позанимался.</p>
      <p>Пропустил день — серия начнётся заново.</p>
      <p>Огонёк растёт вместе с серией: от <b>7 дней</b> он красный, а от <b>31 дня</b> — фиолетовый, и искр становится больше.</p>`,
  },
  nextstep: {
    title: "Что делать сейчас",
    body: `
      <p>Здесь мы подсказываем, чем лучше заняться прямо сейчас: закончить начатый урок, повторить ошибки или потренировать слабую тему.</p>
      <p>Совет каждый раз подбирается под тебя — что сейчас полезнее всего.</p>
      <p>Но это только совет: все разделы всегда открыты, можешь заниматься чем хочешь.</p>`,
  },
  forecast: {
    title: "Прогноз результата ЕГЭ",
    body: `
      <p>Примерная оценка твоего балла на ЕГЭ: освоение каждой темы умножается на её цену в первичных баллах (вторая часть весит больше первой), а сумма переводится в тестовые баллы по шкале этого года.</p>
      <p>Старые ответы постепенно «выцветают»: месяц назад — вдвое легче сегодняшних. А ширина диапазона показывает уверенность: мало данных — широко, много свежей практики — узко.</p>
      <p>Точность зависит от покрытия: пройдены все уроки и по каждой теме есть данные — прогноз относительно точный; если часть уроков и тем ещё не закрыта, диапазон шире и цифра менее надёжна. Проходи уроки и практику — точность вырастет. Как оценка менялась по дням, видно в «Статистике».</p>`,
  },
  skills: {
    title: "Навыки",
    body: `
      <p>Процент показывает, насколько хорошо ты знаешь тему: <b>40</b> даёт пройденный урок (теория, начатый урок даёт часть пропорционально пройденным шагам), <b>60</b> — решённые задания (практика): у каждого задания темы равная доля, она засчитывается сразу после верного ответа. Подсказки, разбор и показ решения снижают долю задания, а повторы сверх неё не дают.</p>
      <p>Подписи простые: не начата — тему ещё не трогал, слабое место — по теме есть попытки, но точность ответов низкая, пройден (от 70%) — хороший результат, освоен (от 90%) — тема выучена отлично. Мало занимался, но отвечал верно — это «в процессе», а не слабое место. Точность считается за всё время, поэтому старые ошибки приходится перекрывать серией верных ответов.</p>
      <p>Нажми на тему — там урок, тренировка и твои ошибки.</p>`,
  },
  path: {
    title: "Путь",
    body: `
      <p>Карта всех тем экзамена и твой прогресс по каждой.</p>
      <p>Идти можно в любом порядке — всё открыто сразу, запретов нет.</p>
      <p>Нажми на тему — откроются урок, тренировка и твои ошибки.</p>`,
  },
  training: {
    title: "Тренировка",
    body: `
      <p><b>Уроки</b> объясняют тему по шагам с самого начала. Очки дают только за первое прохождение, повтор нужен просто для закрепления.</p>
      <p><b>Тренировки</b> — задания ЕГЭ по теме. Пройдёшь весь список до конца — получишь награду.</p>
      <p>Если бросил на середине — продолжишь с того же места.</p>`,
  },
  errors: {
    title: "Ошибки",
    body: `
      <p>Здесь собираются все твои ошибки — по темам. Это список того, что стоит повторить.</p>
      <p>Нажми «Повторить слабые места» — подберём похожие задания. Правильный ответ закроет ошибку и даст <b>+15 очков</b>.</p>`,
  },
  trials: {
    title: "Испытания",
    body: `
      <p><b>Ежедневная задача</b> — короткая подборка на сегодня. За выполнение дают очки, за повтор — нет.</p>
      <p><b>Боссы</b> открываются, когда хорошо прокачана вся группа тем. Какая тема попадётся — заранее не видно, как на настоящем экзамене. Чтобы победить, реши правильно больше половины заданий. Победа даёт очки и усиливает всю группу тем.</p>`,
  },
};

/* Текст подсказки прогноза зависит от шкалы предмета: у профиля баллы
   переводятся из первичных в стобалльные (вторая часть весит больше),
   у базы каждое задание — 1 балл из 21, итог — оценка 2–5. */
function forecastHelpHTML() {
  const max = (typeof forecastTotal === "function") ? forecastTotal() : 100;
  const common = `
      <p>Старые ответы постепенно «выцветают»: месяц назад — вдвое легче сегодняшних. А ширина диапазона показывает уверенность: мало данных — широко, много свежей практики — узко.</p>
      <p>Точность зависит от покрытия: пройдены все уроки и по каждой теме есть данные — прогноз относительно точный; если часть уроков и тем ещё не закрыта, диапазон шире и цифра менее надёжна. Проходи уроки и практику — точность вырастет. Как оценка менялась по дням, видно в «Статистике».</p>`;
  if (max !== 100) {
    return `
      <p>Примерный итог базового ЕГЭ: каждое из 21 заданий даёт 1 балл, поэтому прогноз показывает, сколько заданий ты решишь (7+ баллов — оценка «3», 12+ — «4», 17+ — «5»). Все темы весят одинаково.</p>`
      + common;
  }
  return `
      <p>Примерная оценка твоего балла на ЕГЭ: освоение каждой темы умножается на её цену в первичных баллах (вторая часть весит больше первой), а сумма переводится в тестовые баллы по шкале этого года.</p>`
    + common;
}

function openHelp(key) {
  if (key === "forecast" && typeof forecastHelpHTML === "function") {
    openModal(`
    <div class="stat-label">Подсказка</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">Прогноз результата ЕГЭ</div>
    <div class="help-body">${forecastHelpHTML()}</div>
    <div style="margin-top:22px;display:flex;justify-content:flex-end">
      <button class="btn btn--primary" onclick="closeModal()">Понятно</button>
    </div>`, "Прогноз результата ЕГЭ");
    return;
  }
  const h = HELP[key];
  if (!h) return;
  openModal(`
    <div class="stat-label">Подсказка</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${h.title}</div>
    <div class="help-body">${h.body}</div>
    <div style="margin-top:22px;display:flex;justify-content:flex-end">
      <button class="btn btn--primary" onclick="closeModal()">Понятно</button>
    </div>`, h.title);
}

function helpDot(key) {
  return `<button class="help-dot" type="button" onclick="event.stopPropagation();openHelp('${key}')" aria-label="Что это означает?" title="Что это означает?">${icon("help")}</button>`;
}

/* ---------------- level up ---------------- */

function showLevelUp(to) {
  const root = document.getElementById("modal-root");
  const div = document.createElement("div");
  div.className = "levelup-overlay";
  div.innerHTML = `
    <div class="levelup-box">
      <div class="levelup-box__label">НОВЫЙ УРОВЕНЬ</div>
      <div class="levelup-box__level">${to}</div>
      <div class="levelup-box__sub">Новый уровень подготовки</div>
    </div>`;
  div.onclick = () => div.remove();
  root.appendChild(div);
  setTimeout(() => div.remove(), 2600);
}

Store.on("levelup", ({ to }) => { showLevelUp(to); renderTopbar(); });
Store.on("achievement", (a) => toast(`Достижение разблокировано: <b>«${a.name}»</b>`, "toast--ach", "crown"));
Store.on("dailydone", ({ xp }) => toast(`Ежедневная задача выполнена <b class="mono">+${xp} XP</b>`, "toast--xp", "zap"));
Store.on("xp", () => renderTopbar());
Store.on("persistenceerror", (err) => {
  if (isBlockedError(err)) return; // бан показывает модалку, тост не нужен
  toast("Не удалось сохранить прогресс. Попробуй ещё раз.", "toast--error", "x");
});
// Синхронизация вкладок — внутренний механизм. Обычному пользователю не
// нужны сообщения о merge, отложенном обновлении или выборе главной вкладки.
Store.on("externalupdate", () => { try { render(); } catch (_) {} });

/* ============================================================
   Router
   ============================================================ */

const NAV = [
  { route: "dashboard", label: "Главная", ic: "dashboard" },
  { route: "path",      label: "Путь",      ic: "path" },
  { route: "training",  label: "Тренировка",ic: "training" },
  { route: "errors",    label: "Ошибки",    ic: "errors" },
  { route: "trials",    label: "Испытания", ic: "trials" },
  { route: "stats",     label: "Статистика",ic: "stats" },
  { route: "profile",   label: "Профиль",   ic: "profile" },
];

function isSubjectChoiceLocked() {
  try { return !!pendingSubjectChoice; } catch (_) { return false; }
}

function go(route, param) {
  // Пикер «Какой предмет открываем?» после входа: хром (сайдбар/топбар/
  // нижняя навигация) заблокирован, а программные переходы наружу
  // возвращаем на subject — иначе можно уйти в профиль и т.д. до выбора.
  try {
    if (isSubjectChoiceLocked() && route !== "subject" && route !== "login" && route !== "register") {
      route = "subject";
      param = undefined;
    }
  } catch (_) {}
  if (route !== "errors") resolvedErrorsExpanded = false;
  const h = "#/" + route + (param ? "/" + encodeURIComponent(param) : "");
  // Тот же адрес повторно — просто перерисовать (возврат в уже открытый урок/сессию).
  if (location.hash === h) render();
  else location.hash = h;
}

function currentRoute() {
  const h = location.hash.replace(/^#\//, "");
  return h.split("/")[0] || "dashboard";
}

/* Параметр глубокого маршрута: #/lesson/<id>, #/practice/<missionId>,
   #/boss/<bossId>, #/skill/<skillId>. После перезагрузки страницы
   пользователь возвращается ровно туда, где был. */
function routeParam() {
  const h = location.hash.replace(/^#\//, "");
  const i = h.indexOf("/");
  return i < 0 ? "" : decodeURIComponent(h.slice(i + 1));
}

/* Ленивая загрузка тяжёлой математики: katex (269 КБ) + jsxgraph (947 КБ) +
   mathvisual нужны только экранам с заданиями/уроками, а не первому экрану.
   Грузятся один раз по требованию, дальше — мгновенно из кэша.
   «Ошибки» и «Испытания» — лёгкие списки без формул: им хватает
   bootstrap-lite (скиллы/боссы/стабы с sub), детали и вендор не ждём.
   Сессии, стартующие с их кнопок (review/daily/boss/session), свой гейт
   сохраняют — цена переезжает на момент клика, где ожидание уместно. */
const NEEDS_DETAILS = new Set(["session", "practice", "boss", "daily", "review", "lesson"]);

/* Экраны, на которых пользователь действительно занимается: один общий
   режим фокуса для урока, практики, миссии, босса и остальных заданий.
   На мобильном в нём не показывается нижняя навигация, а на всех
   устройствах скрывается футер — это не список с выбором раздела,
   а непрерывная работа над конкретным заданием. */
const TASK_FOCUS_ROUTES = new Set(["session", "practice", "boss", "daily", "review", "lesson"]);

/* Маршруты с живой сессией: перезагрузка восстанавливает место, а не
   сбрасывает на список. */
const SESSION_ROUTES = new Set(["session", "practice", "boss", "daily", "review"]);

const Vendor = {
  _mathPromise: null,

  loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-vendor-src="${src}"]`)) { resolve(); return; }
      const el = document.createElement("script");
      el.src = src;
      el.defer = true;
      el.dataset.vendorSrc = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
      document.head.appendChild(el);
    });
  },

  ensureCss(href) {
    if (document.querySelector(`link[data-vendor-href="${href}"]`)) return;
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = href;
    el.dataset.vendorHref = href;
    // Вендорный CSS встаёт ДО наших стилей — как было в index.html до
    // ленивой загрузки. Иначе его shorthand (.katex{font:normal ...} в
    // katex.min.css) оказывается позже нашего (.katex{font-weight:700})
    // при равной специфичности и цифры теряют жирность.
    const anchor = document.querySelector('link[rel="stylesheet"]:not([data-vendor-href])');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else document.head.appendChild(el);
  },

  ensureMath() {
    if (window.katex && window.MathVisual && typeof JXG !== "undefined") return Promise.resolve();
    if (this._mathPromise) return this._mathPromise;
    this._mathPromise = (async () => {
      // katex и jsxgraph независимы — параллельно; mathvisual после jsxgraph,
      // чтобы применился его стартовый патч JXG-опций, как при обычном порядке.
      await Promise.all([
        window.katex ? null : this.loadScript("vendor/katex/katex.min.js"),
        (typeof JXG !== "undefined") ? null : this.loadScript("vendor/jsxgraph/jsxgraphcore.js"),
      ]);
      this.ensureCss("vendor/katex/katex.min.css");
      this.ensureCss("vendor/jsxgraph/jsxgraph.css");
      if (!window.MathVisual) await this.loadScript("js/mathvisual.js?v=3");
      // Экрану, который ждал библиотеку, уже есть DOM с плейсхолдерами —
      // монтируем их сразу, наблюдатель MutationObserver подхватит будущие.
      try { MathVisualMount.mountWithin(document.body); } catch (_) {}
    }).call(this).catch((error) => { this._mathPromise = null; throw error; });
    return this._mathPromise;
  },
};

let renderSeq = 0;
let lastHash = "";

async function render() {
  // Заблокированный аккаунт: обычный интерфейс не рисуем вообще —
  // только полноэкранное окно. Возврат из него — через лендинг.
  if (accountBlocked || (typeof window !== "undefined" && window.__egeBlocked)) {
    if (!accountBlocked) accountBlocked = window.__egeBlocked;
    try { showAccountBlocked(accountBlocked || {}); } catch (_) {}
    return;
  }
  if (!Store.ready || !Store.state) return;
  // Отложённое обновление из соседней вкладки: тренировка/урок уже закрыты
  // (иначе checkExternalUpdate не откладывал бы), подтягиваем свежее
  // состояние с сервера до отрисовки — экран никогда не рисует stale-снапшот.
  if (Store.pendingExternalUpdate && !(typeof Session !== "undefined" && Session && Session.cur)
      && !(typeof Lesson !== "undefined" && Lesson && Lesson.cur)) {
    // Если обновление было отложено во время локального save, сначала
    // дожидаемся его. Иначе загрузка свежего bootstrap могла бы затереть
    // только что закрытую ошибку до попадания на сервер.
    if (Store.lastSyncedState && JSON.stringify(Store.state) !== JSON.stringify(Store.lastSyncedState)) {
      try { await Store.pendingSave; } catch (_) {}
      if (Store.lastSyncedState && JSON.stringify(Store.state) !== JSON.stringify(Store.lastSyncedState)) {
        // Незавершённый локальный save — внутреннее состояние синхронизации.
        // Следующий render повторит попытку; пользовательский toast здесь был
        // ложным сообщением об «обновлении из другой вкладки».
        return;
      }
    }
    try {
      await Store.load();
      // Очищаем флаг только после успешного ответа. При сетевой ошибке
      // pendingExternalUpdate должен сохраниться, иначе следующий render
      // снова покажет устаревшее состояние и потеряет возможность догрузить
      // закрытые ошибки.
      Store.pendingExternalUpdate = false;
    } catch (e) {
      if (isBlockedError(e)) { try { showAccountBlocked(blockedDetail(e) || {}); } catch (_) {} return; }
      // Не сбрасываем флаг: фоновый refresh повторится при следующем render.
      // Технические детали синхронизации обычному пользователю не показываем.
      return;
    }
    if (accountBlocked) { try { showAccountBlocked(accountBlocked); } catch (_) {} return; }
    if (!Store.ready || !Store.state) return;
  }
  const route = currentRoute();
  // Уход со страницы урока тоже ставит таймер на паузу: возвращение через
  // день не должно превращать урок в многочасовой сеанс.
  if (route !== "lesson" && typeof Lesson !== "undefined" && Lesson.cur) {
    pauseLessonClock();
    Lesson.cur = null;
  }
  // После входа предмет не угадываем по current_subject: пока пользователь
  // явно не выбрал предмет, любой раздел уводит на экран выбора (кроме
  // login/register — туда ведёт сам flow входа/выхода).
  if (pendingSubjectChoice && route !== "subject" && route !== "login" && route !== "register") { go("subject"); return; }
  // Экраны входа/регистрации доступны и до онбординга: после logout свежий
  // гостевой профиль ещё не onboarded, но попасть в аккаунт он должен суметь.
  if (!Store.state.onboarded && route !== "login" && route !== "register") { Onboarding.show(); try { if (window.Footer) Footer.hide(); } catch (_) {} return; }
  Onboarding.hide();
  // Убираем старый футер сразу, ещё до ленивой загрузки формул. На фокусных
  // маршрутах это не даёт старому контенту мигнуть во время перехода.
  try { if (window.Footer) Footer.sync(route); } catch (_) {}
  // Смена адреса закрывает старое модальное окно (справка helpDot адрес не
  // меняет и потому не страдает; окно навыка для #/skill открывает конец render).
  if (location.hash !== lastHash) {
    lastHash = location.hash;
    try { closeModal(); } catch (_) {}
    try { closeDeviceModal(); } catch (_) {}
  }
  const param = routeParam();
  // Подсветка в меню: глубокий маршрут относится к своему разделу.
  const navRoute = navRouteForRoute(route);
  syncChromeForRoute(route, navRoute);
  updateDocumentTitle(route);
  const screen = document.getElementById("screen");
  const subjectState = subjectContentState();
  const my = ++renderSeq;
  let mathFailed = false;

  // Сначала отсекаем состояния без контента, до загрузки заданий и создания
  // сессии. Иначе прямой #/lesson/<id> или #/practice/<id> мог превратить
  // честную заглушку в пустой экран/неработающую кнопку. Path и skill
  // остаются доступными: там пользователь должен увидеть реальную
  // зарегистрированную тему и понять, почему она закрыта.
  if (subjectState.empty && EMPTY_SUBJECT_ROUTES.has(route)) {
    screen.innerHTML = "";
    screenEmptySubject(screen, route);
    // Футер — часть единого chrome. На пустом/locked предмете он нужен так же,
    // как на готовом; скрываем только на task-фокусных маршрутах (см. Footer).
    try { if (window.Footer) Footer.sync(route); } catch (_) {}
    window.scrollTo(0, 0);
    return;
  }
  if (subjectState.locked && SUBJECT_CONTENT_ROUTES.has(route)) {
    screen.innerHTML = "";
    screenSubjectUnavailable(screen, true, route);
    try { if (window.Footer) Footer.sync(route); } catch (_) {}
    window.scrollTo(0, 0);
    return;
  }
  if (NEEDS_DETAILS.has(route)) {
    // Экран с заданиями: ждём полные тексты и математические библиотеки.
    // Пока грузится — скелетон вместо пустоты; ушедшую навигацию не трогаем.
    screen.innerHTML = loaderHTML("Тянем задания и формулы…");
    try {
      await Store.ensureDetails();
    } catch (error) {
      if (my !== renderSeq) return;
      if (isBlockedError(error)) { try { showAccountBlocked(blockedDetail(error) || {}); } catch (_) {} return; }
      screen.innerHTML = `<div class="card" style="max-width:420px;margin:64px auto;text-align:center">Не удалось загрузить задания.<br><button class="btn btn--primary btn--sm" style="margin-top:12px" onclick="render()">Попробовать снова</button></div>`;
      return;
    }
    // Без katex/jsxgraph экран всё равно отрисуется plain-формулами.
    // Ниже MathVisualMount заменит незагруженные схемы короткой понятной
    // заглушкой; служебную ошибку вендора обычному пользователю не показываем.
    try {
      await Vendor.ensureMath();
    } catch (error) {
      mathFailed = true;
    }
    if (my !== renderSeq || currentRoute() !== route) return;
  }
  // Глубокие маршруты: восстановить место вместо сброса на список.
  if (route === "lesson") {
    if (!(await ensureLessonForRoute(param))) {
      if (my !== renderSeq) return;
      go("path"); return;
    }
    if (my !== renderSeq || currentRoute() !== route) return;
  }
  if (SESSION_ROUTES.has(route)) {
    if (!Session.cur || !sessionMatchesRoute(Session.cur, route, param)) {
      if (!restoreSessionFromStorage(route, param) && !freshSessionForRoute(route, param)) {
        if (my !== renderSeq) return;
        go("training"); return;
      }
    }
    if (my !== renderSeq || currentRoute() !== route) return;
  }
  const fn = {
    dashboard: screenDashboard,
    path: screenPath,
    skill: screenPath,
    training: screenTraining,
    session: screenSession,
    practice: screenSession,
    boss: screenSession,
    daily: screenSession,
    review: screenSession,
    lesson: screenLesson,
    errors: screenErrors,
    trials: screenTrials,
    stats: screenStats,
    profile: screenProfile,
    login: screenLogin,
    register: screenRegister,
    subject: screenLoginSubject,
  }[route] || screenDashboard;
  // Категория «locked» может иметь реальную зарегистрированную тему, поэтому
  // путь/карточка навыка не должны повторно скрываться здесь как пустой предмет.
  // Все контентные маршруты уже отсечены выше по subjectState.
  screen.innerHTML = "";
  screen.style.animation = "none";
  void screen.offsetWidth;
  screen.style.animation = "";
  fn(screen);
  // ensureMath внутри ждал вендор ДО отрисовки контента, а его внутренний
  // mountWithin ловил только уже существующие плейсхолдеры. Домонтируем то,
  // что только что отрисовал fn(); при упавшем вендоре превращаем
  // несмонтированное в читаемый текст вместо пустых блоков.
  try {
    if (typeof MathVisualMount !== "undefined") {
      MathVisualMount.mountWithin(document.body);
      if (mathFailed) MathVisualMount.failUnmounted(screen);
    }
  } catch (_) {}
  // Глубокая ссылка на навык: карта + открытое окно темы.
  // Временно закрытая тема — то же окно «недоступна», а не обычное.
  const routeSkill = route === "skill" && param ? subjectSkillById(param) : null;
  if (routeSkill) {
    try {
      if (topicIsLocked(routeSkill)) openLockedSkillModal(param);
      else openSkillModal(param);
    } catch (_) {}
  }
  try { if (window.Footer) Footer.sync(route); } catch (_) {}
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);

/* Заголовок вкладки повторяет текущий раздел — удобно ориентироваться,
   когда открыто несколько вкладок или вкладка свёрнута. */
const ROUTE_TITLES = {
  dashboard: "Главная", path: "Путь", skill: "Тема", training: "Тренировка",
  session: "Тренировка", practice: "Практика", boss: "Босс-испытание",
  daily: "Ежедневная задача", review: "Повторение ошибок", lesson: "Урок",
  errors: "Ошибки", trials: "Испытания", stats: "Статистика", profile: "Профиль",
  login: "Вход", register: "Регистрация", subject: "Выбор предмета",
};

function updateDocumentTitle(route) {
  const label = ROUTE_TITLES[route] || ROUTE_TITLES.dashboard;
  try {
    const state = subjectContentState();
    if (state.locked && SUBJECT_CONTENT_ROUTES.has(route)) {
      document.title = `${subjectDisplayName(state.info)} — закрытая тема — ege easy`;
      return;
    }
    if (state.empty && EMPTY_SUBJECT_ROUTES.has(route)) {
      document.title = `${subjectDisplayName(state.info)} — материалы скоро — ege easy`;
      return;
    }
  } catch (_) {}
  document.title = `${label} — ege easy`;
}

/* ============================================================
   Предметы: переключатель и пустое состояние.
   Вся предметная логика читается из каталога (DataAPI.subjects()),
   ветвлений под конкретные предметы в коде нет.
   ============================================================ */

/* ---------------- registry-driven subject/topic presentation ----------------

   Каталог subjects — единственный источник названий и состава курса.  В
   интерфейсе не нужно знать id конкретного предмета: одинаково корректно
   показываются профиль, база и новые предметы (например, русский язык).
   `locked`/`status`/`features` в реестре дополняются проверкой реальных
   ресурсов, потому что lite-bootstrap содержит только метаданные. */

const TOPIC_LOCKED_VALUES = new Set(["locked", "unavailable", "disabled", "hidden"]);
const SUBJECT_CONTENT_ROUTES = new Set([
  "training", "session", "practice", "boss", "daily", "review", "lesson",
  "errors", "trials", "stats",
]);

function asSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

/* DataAPI intentionally hides locked subjects from learning selectors.  Path
   still needs their read-only registry rows, so read the raw catalog through
   this narrow adapter.  It works with the normal `skills/categories` shape as
   well as the lockedTopics/topics aliases used by transitional backends. */
function rawCatalogCollection(name, aliases = []) {
  let catalog = null;
  try { catalog = DataAPI && DataAPI.catalog; } catch (_) { catalog = null; }
  if (!catalog || typeof catalog !== "object") return [];
  for (const key of [name, ...aliases]) {
    const value = catalog[key];
    if (Array.isArray(value)) {
      const current = (typeof DataAPI.currentSubject === "function" ? DataAPI.currentSubject() : "");
      return value.filter((item) => {
        if (!item || typeof item !== "object") return false;
        const owner = item.subject || item.subjectId || item.subject_id;
        return !owner || !current || String(owner) === String(current);
      });
    }
  }
  return [];
}

function registryTopicFromSubjectInfo(info = subjectInfoSafe()) {
  if (!info || typeof info !== "object") return null;
  if (info.features && info.features.path === false) return null;
  const metadata = info.metadata && typeof info.metadata === "object" ? info.metadata : {};
  const rawTopic = metadata.topic || metadata.topicName || metadata.name;
  const topicValue = Array.isArray(rawTopic) ? rawTopic[0] : rawTopic;
  const topicName = topicValue && typeof topicValue === "object"
    ? (topicValue.title || topicValue.name)
    : topicValue;
  if (!topicName) return null;
  const subjectId = String(info.id || (typeof DataAPI !== "undefined" && DataAPI.currentSubject ? DataAPI.currentSubject() : "") || "subject");
  const topicId = String(metadata.topicId || metadata.topic_id || metadata.skillId || metadata.skill_id || `${subjectId}_registry_topic`);
  const categoryId = String(metadata.categoryId || metadata.category_id || metadata.category || `${subjectId}_topics`);
  const locked = subjectInfoLocked(info) || metadata.locked === true || metadata.comingSoon === true || metadata.published === false;
  return {
    id: topicId,
    name: String(topicName),
    subject: subjectId,
    cat: categoryId,
    order: Number.isFinite(Number(metadata.order)) ? Number(metadata.order) : 0,
    ege: metadata.ege || null,
    status: info.status || (locked ? "locked" : "ready"),
    locked: !!locked,
    comingSoon: !!locked,
    metadata: { ...metadata, kind: "topic" },
    registryOnly: true,
  };
}

function subjectSkillById(idOrSkill) {
  if (idOrSkill && typeof idOrSkill === "object") return idOrSkill;
  const wanted = String(idOrSkill == null ? "" : idOrSkill);
  if (!wanted) return null;
  const found = subjectSkills().find((skill) => String(skill && skill.id) === wanted);
  if (found) return found;
  try { return DataAPI.skill(wanted) || null; } catch (_) { return null; }
}

function subjectSkills() {
  const publicSkills = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.skills ? DataAPI.skills() : []);
  if (publicSkills.length) return publicSkills;
  const rawSkills = rawCatalogCollection("skills", ["lockedTopics", "locked_topics"]);
  if (rawSkills.length) return rawSkills;
  // A transitional payload may expose only topic records.  Keep only records
  // that look like skills and normalise their category field for Path.
  const topicRecords = rawCatalogCollection("topics").filter((item) => {
    const kind = item && (item.kind || (item.metadata && item.metadata.kind));
    return item && (item.skill || item.topicId || item.topic_id || kind === "topic");
  }).map((item) => ({
    ...item,
    cat: item.cat || item.topicId || item.topic_id || item.category || "locked-topics",
  }));
  if (topicRecords.length) return topicRecords;
  const registryTopic = registryTopicFromSubjectInfo();
  return registryTopic ? [registryTopic] : [];
}

function subjectCategories() {
  const publicCategories = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.categories ? DataAPI.categories() : []);
  if (publicCategories.length) return publicCategories;
  const rawCategories = rawCatalogCollection("categories", ["topics", "lockedTopics", "locked_topics"]);
  if (rawCategories.length) return rawCategories;
  const topic = registryTopicFromSubjectInfo();
  if (!topic) return [];
  const info = subjectInfoSafe();
  return [{
    id: topic.cat,
    name: String(info.metadata && (info.metadata.section || info.metadata.categoryName) || info.title || "Темы предмета"),
    short: info.short || "",
    subject: topic.subject,
    status: topic.status,
    locked: topic.locked,
    comingSoon: topic.comingSoon,
    metadata: { kind: "subject-section", availability: info.availability || info.status || "coming-soon" },
  }];
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeNumber(value) {
  return Math.max(0, finiteNumber(value, 0));
}

function subjectInfoSafe(id) {
  try {
    return (typeof DataAPI !== "undefined" && DataAPI.subjectInfo
      ? DataAPI.subjectInfo(id)
      : null) || {};
  } catch (_) {
    return {};
  }
}

function subjectDisplayName(subject) {
  const value = subject && typeof subject === "object"
    ? (subject.title || subject.name || subject.short || (subject.metadata && (subject.metadata.topic || subject.metadata.name)))
    : subject;
  const text = String(value == null ? "" : value).trim();
  return text || "Предмет";
}

function subjectDisplayShort(subject) {
  const value = subject && typeof subject === "object"
    ? (subject.short || subject.title || subject.name || (subject.metadata && (subject.metadata.topic || subject.metadata.name)))
    : subject;
  const text = String(value == null ? "" : value).trim();
  return text || subjectDisplayName(subject);
}

function subjectDisplayTitle(id) {
  return subjectDisplayName(subjectInfoSafe(id));
}

function subjectInfoLocked(subject) {
  if (!subject || typeof subject !== "object") return false;
  const metadata = subject.metadata && typeof subject.metadata === "object" ? subject.metadata : {};
  if (subject.locked === true || subject.comingSoon === true || metadata.locked === true || metadata.comingSoon === true) return true;
  const status = String(subject.status || subject.availability || metadata.availability || "").toLowerCase().replace(/_/g, "-");
  return ["locked", "unavailable", "disabled", "coming-soon", "soon"].includes(status);
}

function subjectFeature(subject, key) {
  const features = subject && subject.features;
  if (!features || typeof features !== "object" || !Object.prototype.hasOwnProperty.call(features, key)) return true;
  const value = features[key];
  return !(value === false || value === 0 || value === "false" || value === "off");
}

function subjectAvailabilityLabel(subject) {
  const metadata = subject && subject.metadata && typeof subject.metadata === "object" ? subject.metadata : {};
  const status = String(subject && subject.status || metadata.availability || "").toLowerCase().replace(/_/g, "-");
  if (subject && (subject.locked === true || subject.comingSoon === true || metadata.locked === true || metadata.comingSoon === true)) return "скоро";
  if (["soon", "empty", "planned", "coming-soon", "coming_soon", "locked", "unavailable", "disabled", "hidden"].includes(status)) return "скоро";
  if (status === "partial" || status === "limited") return "частично";
  const hasFeature = ["lessons", "practice", "forecast"].some((key) => subjectFeature(subject, key));
  return hasFeature ? "" : "пока закрыто";
}

function topicDisplayName(topic) {
  return subjectDisplayName(topic && typeof topic === "object"
    ? topic
    : { title: topic });
}

function topicCategory(topic) {
  if (!topic) return null;
  const categoryId = topic.cat || topic.category;
  try {
    const category = DataAPI.category(categoryId);
    if (category) return category;
  } catch (_) {}
  return subjectCategories().find((category) => String(category && category.id) === String(categoryId)) || null;
}

function topicCategoryName(topic) {
  const category = topicCategory(topic);
  return subjectDisplayName(category || { title: "Темы предмета" });
}

function topicHasLesson(topic) {
  if (!topic || !topic.id) return false;
  try {
    return DataAPI.lessonsBySkill(topic.id).some((lesson) => (
      Array.isArray(lesson && lesson.steps) ? lesson.steps.length > 0
        : nonNegativeNumber(lesson && lesson.stepsCount) > 0
    ));
  } catch (_) {
    return false;
  }
}

function topicHasPractice(topic) {
  if (!topic || !topic.id) return false;
  try {
    return DataAPI.practiceTasksBySkill(topic.id).length > 0
      || DataAPI.missions().some((mission) => mission && mission.skill === topic.id && missionPracticeIds(mission).length > 0);
  } catch (_) {
    return false;
  }
}

function topicHasLearningContent(topic) {
  return topicHasLesson(topic) || topicHasPractice(topic);
}

function topicExplicitlyLocked(topic) {
  if (!topic || typeof topic !== "object") return false;
  if (topic.locked === true || topic.available === false || topic.enabled === false) return true;
  const status = String(topic.status || topic.availability || topic.contentStatus || (topic.metadata && topic.metadata.availability) || "").toLowerCase().replace(/_/g, "-");
  return TOPIC_LOCKED_VALUES.has(status) || status === "locked" || status === "coming-soon";
}

function topicIsLocked(topic) {
  if (!topic) return true;
  if (subjectInfoLocked(subjectInfoSafe())) return true;
  if (topicExplicitlyLocked(topic)) return true;
  try {
    if (typeof TEMP_LOCKED_SKILLS !== "undefined" && TEMP_LOCKED_SKILLS.has(topic.id)) return true;
  } catch (_) {}
  // Отсутствие урока и заданий — тоже честный locked-state, а не кнопка,
  // которая ведёт в пустую модалку или nonexistent deep-link.
  return !topicHasLearningContent(topic);
}

function topicStatus(topic) {
  return topicIsLocked(topic) ? "locked" : skillStatus(topic);
}

function topicLockReason(topic) {
  if (!topic) return "Тема пока недоступна.";
  const explicit = topic.lockedReason || topic.lockReason || topic.reason;
  if (explicit) return String(explicit);
  const info = subjectInfoSafe();
  // Сначала различаем новый registry-lock и старый math-lock. В новом
  // TEMP_LOCKED_SKILLS.has() тоже отражает registry, поэтому Drawing reason
  // нельзя применять ко всем закрытым темам.
  if (topicExplicitlyLocked(topic) || subjectInfoLocked(info)) {
    if (!topicHasLesson(topic) && !topicHasPractice(topic)) {
      return "Для этой темы пока нет урока и заданий для практики. Мы не показываем пустые кнопки — тема вернётся вместе с материалами.";
    }
    return "Материалы предмета пока готовятся. Тема откроется, когда выйдет полноценный урок или задания для практики.";
  }
  try {
    if (typeof TEMP_LOCKED_SKILLS !== "undefined" && TEMP_LOCKED_SKILLS.has(topic.id)) {
      return "Тема временно недоступна: задания требуют официальных чертежей, которых пока нет в сборке. Урок появится вместе с материалами.";
    }
  } catch (_) {}
  if (String(info.status || "").toLowerCase() !== "ready") {
    return "Материалы предмета пока готовятся. Тема откроется, когда выйдет полноценный урок или задания для практики.";
  }
  return "Тема пока закрыта. Доступные материалы появятся здесь после подключения каталога.";
}

function subjectContentState() {
  const skills = subjectSkills();
  const info = subjectInfoSafe();
  const hasSkills = skills.length > 0;
  const registryLocked = subjectInfoLocked(info);
  const hasContent = hasSkills && !registryLocked && skills.some((skill) => !topicIsLocked(skill));
  const subjectStatus = String(info.status || "").toLowerCase();
  const explicitEmpty = subjectStatus === "empty"
    || (!hasSkills && ["planned", "soon"].includes(subjectStatus));
  return {
    skills,
    info,
    empty: !hasSkills || explicitEmpty,
    locked: hasSkills && (registryLocked || !hasContent) && !explicitEmpty,
    hasContent,
  };
}

function subjectLearningUnavailable(state = subjectContentState()) {
  return !!(state && (state.empty || state.locked));
}

function subjectNavItems() {
  let state = null;
  try { state = subjectContentState(); } catch (_) { state = null; }
  if (!state || (!state.empty && !state.locked)) return NAV;
  // Единый chrome: locked-предмет с зарегистрированными темами показывает
  // то же меню, что готовый. Недоступный контент честно закрыт route-guard'ом
  // (заглушка вместо пустых переходов), а не отсутствием пункта меню.
  // Урезаем только пустой предмет без единой темы — там показывать нечего.
  if (!state.empty && asSafeArray(state.skills).length) return NAV;
  return NAV.filter((item) => ["dashboard", "path", "profile"].includes(item.route));
}

function pathProgressForSkills(skills) {
  const playable = asSafeArray(skills).filter((skill) => skill && !topicIsLocked(skill));
  if (!playable.length) return null;
  return Math.round(playable.reduce((sum, skill) => sum + nonNegativeNumber(skillProgress(skill.id)), 0) / playable.length);
}

function pathProgressLabel(skills) {
  const progress = pathProgressForSkills(skills);
  return progress == null ? "материалы готовятся" : `${progress}% освоено`;
}

function lockedTopicCountLabel(count) {
  const n = Math.max(0, Math.round(nonNegativeNumber(count)));
  if (n === 1) return "Одна тема пока закрыта";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} темы пока закрыты`;
  return `${n} тем пока закрыты`;
}

function subjectStateCardHTML(state = subjectContentState(), options = {}) {
  const info = state.info || subjectInfoSafe();
  const skills = asSafeArray(state.skills);
  const name = subjectDisplayName(info);
  const topic = state.locked && skills.length === 1 ? skills[0] : null;
  const title = state.empty ? "Материалы пока готовятся" : "Тема пока закрыта";
  const text = state.empty
    ? `В разделе «${name}» уже заведён отдельный прогресс. Уроки, задания и прогноз появятся после подключения материалов.`
    : topic
      ? `Тема «${topicDisplayName(topic)}» зарегистрирована в курсе, но её урок и практика ещё не подключены. Мы не показываем пустые переходы — карта и профиль уже работают.`
      : `В разделе «${name}» пока нет доступных уроков или заданий. Выберите другой предмет или загляните позже.`;
  const compact = options.compact ? " subject-state-card--compact" : "";
  return `<section class="subject-state-card subject-state-card--${state.empty ? "empty" : "locked"}${compact}" role="status" aria-live="polite">
    <div class="subject-state-card__icon">${icon(state.empty ? "clock" : "lock")}</div>
    <div class="subject-state-card__content">
      <div class="subject-state-card__title">${esc(title)}</div>
      <div class="subject-state-card__text">${esc(text)}</div>
      ${topic ? `<div class="subject-state-card__topic"><span class="subject-state-card__topic-dot" aria-hidden="true"></span>${esc(topicDisplayName(topic))}</div>` : ""}
    </div>
    <div class="subject-state-card__actions">
      ${state.locked && topic ? `<button class="btn btn--soft btn--sm" type="button" onclick="go('path')">${icon("path")} Открыть карту тем</button>` : ""}
      ${state.empty ? `<button class="btn btn--soft btn--sm" type="button" onclick="go('dashboard')">На главную</button>` : ""}
      ${subjectSwitcherHTML() ? `<span class="subject-state-card__switch-label">или выбери предмет:</span>${subjectSwitcherHTML()}` : ""}
    </div>
  </section>`;
}

/* Каждый раздел locked/empty-предмета показывает СВОЮ структуру и свой
   честный пустой список — как у готового предмета, только без выдуманных
   уроков/заданий. Раньше guard в render() отправлял training/errors/trials/
   stats в одну общую карточку, из-за чего они выглядели одинаково.
   `route` — имя раздела; null = общий экран (главная/профиль). */
const SUBJECT_SECTION_COPY = {
  training: {
    title: "Тренировка",
    sub: "Уроки разбирают тему по шагам, тренировки закрепляют её на заданиях ЕГЭ.",
    empty: "Уроки и тренировки появятся здесь вместе с материалами предмета.",
  },
  errors: {
    title: "Ошибки",
    sub: "Каждая ошибка — это точка роста. Повторяй слабые места, пока они не закроются.",
    empty: "Список ошибок появится после первых заданий. Пока повторять нечего.",
  },
  trials: {
    title: "Испытания",
    sub: "Проверки на прочность: ежедневная подборка, смешанное испытание и боссы по веткам навыков.",
    empty: "Ежедневная подборка, смешанное испытание и боссы появятся вместе с заданиями.",
  },
  stats: {
    title: "Статистика",
    sub: "Аналитика подготовки: активность, точность и динамика прогноза.",
    empty: "Графики активности и прогноза появятся после первых заданий.",
    help: "skills",
  },
  // У по-настоящему пустого предмета (без единой темы) Path/skill тоже
  // должны выглядеть разделом, а не голой карточкой без заголовка.
  path: {
    title: "Путь",
    sub: "Карта тем предмета: зарегистрированные темы и статус их материалов.",
    empty: "Карта тем появится вместе с материалами предмета.",
    help: "path",
  },
  skill: {
    title: "Тема",
    sub: "Материалы выбранной темы: теория, практика и статус готовности.",
    empty: "Тема появится вместе с материалами предмета.",
  },
  // Task-маршруты тоже не должны сливаться в одну заглушку: у каждого
  // своё имя и объяснение, почему задания недоступны.
  session: {
    title: "Тренировка",
    sub: "Здесь решаются задания по темам.",
    empty: "Задания этой тренировки появятся вместе с материалами предмета.",
  },
  practice: {
    title: "Практика",
    sub: "Закрепление выбранной темы на заданиях ЕГЭ.",
    empty: "Практика по этой теме появится вместе с материалами предмета.",
  },
  boss: {
    title: "Босс-испытание",
    sub: "Проверка ветки навыков после её прохождения.",
    empty: "Боссы появятся, когда у темы будут задания.",
  },
  daily: {
    title: "Ежедневная задача",
    sub: "Короткая подборка заданий на сегодня.",
    empty: "Ежедневная подборка появится вместе с заданиями предмета.",
  },
  review: {
    title: "Повторение ошибок",
    sub: "Возврат к заданиям, которые ещё не закрыты.",
    empty: "Список ошибок появится после первых заданий. Пока повторять нечего.",
  },
  lesson: {
    title: "Урок",
    sub: "Теория темы по шагам с закреплением.",
    empty: "Урок откроется, когда материалы темы будут подключены.",
  },
};

/* Родитель task-экрана: session/practice ведут в training,
   boss/daily/review — в trials, lesson — в path.  Этот список нельзя
   получать из navRouteForRoute() для пустого предмета: там скрытые
   разделы схлопываются в path, а выход должен оставаться в родителе. */
function taskParentRoute(route) {
  return route === "session" || route === "practice" ? "training"
    : route === "boss" || route === "daily" || route === "review" ? "trials"
    : route === "lesson" ? "path"
    : null;
}

function subjectSectionEmptyStateHTML(state = subjectContentState(), route = null) {
  const copy = route ? SUBJECT_SECTION_COPY[route] : null;
  if (!copy) return subjectStateCardHTML(state);
  // helpDot есть не для всех разделов; без явного ключа не рисуем лишний «?».
  const helpKey = copy.help || (route === "training" || route === "session" ? "training"
    : route === "errors" || route === "review" ? "errors"
    : route === "trials" ? "trials" : null);
  const taskExitRoute = state && (state.empty || state.locked) && TASK_FOCUS_ROUTES.has(route)
    ? taskParentRoute(route)
    : null;
  const taskExitLabel = taskExitRoute === "path" ? "К карте тем"
    : taskExitRoute === "trials" ? "К испытаниям" : "К тренировке";
  const taskExit = taskExitRoute
    ? `<div style="margin-top:16px"><button class="btn btn--ghost btn--sm" type="button" onclick="go('${taskExitRoute}')">${icon("arrow")} ${taskExitLabel}</button></div>`
    : "";
  return `
    <div class="page-head">
      <div class="page-title">${esc(copy.title)}${helpKey ? ` ${helpDot(helpKey)}` : ""}</div>
      <div class="page-sub">${esc(copy.sub)}</div>
    </div>
    <div class="card empty">${esc(copy.empty)}${taskExit}</div>`;
}

function screenSubjectUnavailable(root, locked = false, route = null) {
  const state = subjectContentState();
  if (!locked) state.empty = true;
  const info = state.info || subjectInfoSafe();
  root.innerHTML = route && SUBJECT_SECTION_COPY[route]
    ? subjectSectionEmptyStateHTML(state, route)
    : `
    <div class="page-head">
      <div class="page-title">${esc(subjectDisplayName(info))}</div>
      <div class="page-sub">${locked ? "тема пока закрыта · материалы появятся из реестра" : "отдельный прогресс · материалы скоро"}</div>
    </div>
    ${subjectStateCardHTML(state)}`;
}

// Маршруты, которым нужен контент каталога: в пустом предмете вместо них
// показываем заглушку «Материалы пока готовятся».
const EMPTY_SUBJECT_ROUTES = new Set([
  "path", "skill", "training", "session", "practice", "boss", "daily",
  "review", "lesson", "errors", "trials", "stats",
]);

function subjectSwitcherHTML() {
  const subjects = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.subjects ? DataAPI.subjects() : []);
  if (subjects.length < 2) return "";
  const cur = typeof DataAPI !== "undefined" && DataAPI.currentSubject ? DataAPI.currentSubject() : "";
  return `<select class="subject-select" onchange="switchSubjectFromUI(this)" aria-label="Выбрать предмет" title="Переключить предмет">
    ${subjects.map((s) => {
      const status = subjectAvailabilityLabel(s);
      return `<option value="${esc(s.id)}" ${s.id === cur ? "selected" : ""}>${esc(subjectDisplayName(s))}${status ? ` · ${esc(status)}` : ""}</option>`;
    }).join("")}
  </select>`;
}

/* Пилюли предметов для профиля вместо нативного селекта: оба предмета
   видны сразу, у недоступного — бейдж «скоро». */
function subjectPickerHTML() {
  const subjects = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.subjects ? DataAPI.subjects() : []);
  if (subjects.length < 2) return "";
  const cur = DataAPI.currentSubject();
  return `<div class="subject-picker" role="group" aria-label="Выбрать предмет">`
    + subjects.map((s) => {
        const active = s.id === cur;
        const status = subjectAvailabilityLabel(s);
        return `<button type="button" class="subject-pill${active ? " subject-pill--active" : ""}${status ? " subject-pill--soon" : ""}"
          onclick="switchSubjectFromUI('${esc(s.id)}')" aria-pressed="${active}" aria-label="Открыть предмет ${esc(subjectDisplayName(s))}">
          <span class="subject-pill__name">${esc(subjectDisplayName(s))}</span>
          ${status ? `<span class="subject-pill__badge">${esc(status)}</span>` : ""}
        </button>`;
      }).join("")
    + `</div>`;
}

/* Одна кнопка с текущим предметом в профиле: открывает диалог выбора
   на той же dlg-системе, что и остальные подтверждения. Пилюли
   subjectPickerHTML оставлены для совместимости. */
function subjectCurrentButtonHTML() {
  const subjects = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.subjects ? DataAPI.subjects() : []);
  const info = subjectInfoSafe();
  const title = subjectDisplayName(info);
  if (subjects.length < 2) return `<b>${esc(title)}</b>`;
  const sub = subjectCourseLabel(info);
  return `<button type="button" class="subject-current" onclick="askSubjectDialog()" aria-haspopup="dialog" aria-label="Сменить предмет">
    <span class="subject-current__icon" aria-hidden="true">${icon("layers")}</span>
    <span class="subject-current__body">
      <span class="subject-current__name">${esc(title)}</span>
      ${sub ? `<span class="subject-current__sub">${esc(sub)}</span>` : ""}
    </span>
    <span class="subject-current__chev" aria-hidden="true">›</span>
  </button>`;
}

/* Диалог выбора предмета: та же структура модалки (device-modal-root +
   .dlg-backdrop/.dlg), но со списком красивых карточек предметов. */
function askSubjectDialog() {
  const root = deviceModalRoot();
  const subjects = asSafeArray(typeof DataAPI !== "undefined" && DataAPI.subjects ? DataAPI.subjects() : []);
  if (!root || subjects.length < 2) return;
  const cur = DataAPI.currentSubject();
  try {
    if (!(deviceModalPrevFocus && deviceModalPrevFocus.isConnected)) {
      deviceModalPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  } catch (_) {}
  const cards = subjects.map((s) => {
    const active = s.id === cur;
    const status = subjectAvailabilityLabel(s);
    return `<button type="button" class="subj-card${active ? " subj-card--active" : ""}"
        onclick="chooseSubjectFromDialog('${esc(s.id)}')"${active ? ` aria-current="true"` : ""}>
      <span class="subj-card__badge">${esc(subjectDisplayShort(s))}</span>
      <span class="subj-card__body">
        <span class="subj-card__name">${esc(subjectDisplayName(s))}</span>
        <span class="subj-card__sub">${esc(subjectCourseLabel(s))}${status ? ` · <span class="subj-card__soon">${esc(status)}</span>` : ""}</span>
      </span>
      <span class="subj-card__check" aria-hidden="true">${active ? icon("check") : icon("arrow")}</span>
    </button>`;
  }).join("");
  root.innerHTML = `
    <div class="dlg-backdrop" onclick="if(event.target===this)closeDeviceModal()">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="Выбор предмета">
        <button class="dlg__close" type="button" onclick="closeDeviceModal()" aria-label="Закрыть окно">${icon("x")}</button>
        <div class="dlg__eyebrow">Предмет</div>
        <div class="dlg-device">
          <div class="dlg-device__icon" aria-hidden="true">${icon("layers")}</div>
          <div class="dlg-device__name">Какой предмет открываем?</div>
        </div>
        <div class="dlg__text">Прогресс, ошибки и статистика хранятся отдельно по каждому предмету — переключение ничего не стирает.</div>
        <div class="subj-list">${cards}</div>
        <div class="dlg__actions">
          <button class="btn btn--soft" type="button" onclick="closeDeviceModal()">Закрыть</button>
        </div>
      </div>
    </div>`;
  document.removeEventListener("keydown", deviceModalEscHandler);
  document.addEventListener("keydown", deviceModalEscHandler);
  const dlg = root.querySelector(".dlg");
  if (dlg) { dlg.setAttribute("tabindex", "-1"); dlg.focus({ preventScroll: true }); }
}

function chooseSubjectFromDialog(id) {
  if (!id || subjectSwitching) return;
  try {
    if (id === DataAPI.currentSubject()) { closeDeviceModal(); return; }
  } catch (_) {}
  switchSubjectFromUI(id);
}

/* Честная подпись состава курса для выбора предмета: собирается из features
   предмета (уроки/практика/прогноз), а не из захардкоженной строки. Полный
   набор — «Полный курс», иначе перечисляем только то, что реально есть. */
function subjectCourseLabel(s) {
  if (!s) return "";
  const status = String(s.status || "").toLowerCase();
  if (subjectInfoLocked(s) || (status && status !== "ready" && status !== "partial" && status !== "limited")) {
    return "Материалы пока готовятся — можно занять место";
  }
  // Не подменяем отсутствующие features дефолтом DataAPI: новый предмет
  // может иметь только карту тем, и тогда подпись должна честно говорить об
  // этом, а не обещать несуществующие уроки/практику.
  const f = s.features && typeof s.features === "object"
    ? s.features
    : ((typeof DataAPI !== "undefined" && DataAPI.subjectFeatures)
      ? DataAPI.subjectFeatures(s.id)
      : { lessons: true, practice: true, forecast: true });
  const parts = [];
  if (subjectFeature(s, "lessons") && f.lessons !== false) parts.push("уроки");
  if (subjectFeature(s, "practice") && f.practice !== false) parts.push("тренировки");
  if (subjectFeature(s, "forecast") && f.forecast !== false) parts.push("прогноз");
  if (parts.length >= 3) return "Полный курс: уроки, тренировки, прогноз";
  if (!parts.length) return "Пока доступна только карта тем";
  const titled = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(", ");
  return `${titled} — без лишнего`;
}

async function switchSubjectFromUI(sel) {
  const id = typeof sel === "string" ? sel : (sel && sel.value);
  if (!id || id === DataAPI.currentSubject() || subjectSwitching) return;
  subjectSwitching = true;
  try {
    // Мгновенный отклик: лоадер на экране сразу, а не после ответа сети —
    // иначе клик выглядит зависшим, пока летят save + POST /api/subject.
    try { document.getElementById("screen").innerHTML = loaderHTML("Открываем предмет…"); } catch (_) {}
    // Сессии и уроки другого предмета недействительны — сбрасываем до смены.
    try { Session.cur = null; } catch (_) {}
    try { pauseLessonClock(); } catch (_) {}
    try { Lesson.cur = null; } catch (_) {}
    try { localStorage.removeItem("ege_core_session"); } catch (_) {}
    // Смена адреса закрывает модалки только при смене хэша (см. render) —
    // на том же адресе окно прежнего предмета пережило бы переключение.
    try { closeModal(); } catch (_) {}
    try { closeDeviceModal(); } catch (_) {}
    await Store.switchSubject(id);
    subjectSwitching = false;
    // Предмет выбран явно через профиль: онбординг нового предмета не должен
    // переспрашивать предмет — show() стартует сразу с вопросов.
    try {
      if (typeof Onboarding !== "undefined" && Onboarding) {
        Onboarding.presetSubject = id;
        try { sessionStorage.setItem("ege_onboard_preset_subject", id); } catch (_) {}
      }
    } catch (_) {}
    if (!Store.state.onboarded) { render(); return; }
    if (location.hash && location.hash !== "#/dashboard") location.hash = "#/dashboard";
    render();
  } catch (error) {
    subjectSwitching = false;
    try { toast("Не удалось переключить предмет", "toast--error", "x"); } catch (_) {}
    render();
  }
}

function subjectEmptyHTML() {
  const state = subjectContentState();
  return subjectStateCardHTML({ ...state, empty: true });
}

function screenEmptySubject(root, route = null) {
  const state = subjectContentState();
  root.innerHTML = subjectSectionEmptyStateHTML({ ...state, empty: true }, route);
}

/* ============================================================
   Chrome: sidebar / bottomnav / topbar
   ============================================================ */

function navRouteForRoute(route) {
  const mapped = route === "practice" ? "training"
    : route === "boss" || route === "daily" || route === "review" ? "trials"
    : route === "skill" || route === "lesson" ? "path" : route;
  // Прямая ссылка на закрытый контент не должна оставлять меню без активного
  // пункта. Если вычисленный пункт скрыт урезанным chrome (пустой предмет без
  // единой темы) — подсвечиваем карту тем. У locked-предмета с темами chrome
  // полный, и пункт подсвечивается сам.
  if (SUBJECT_CONTENT_ROUTES.has(route)) {
    try {
      if (subjectLearningUnavailable()) {
        const visible = new Set(subjectNavItems().map((n) => n.route));
        if (!visible.has(mapped)) return "path";
      }
    } catch (_) {}
  }
  return mapped;
}

/* Один переключатель режима для всех task-экранов. На обычных маршрутах
   класс снимается, поэтому мобильная навигация возвращается автоматически. */
function applyTaskFocusMode(route) {
  try {
    const app = document.getElementById("app");
    if (!app) return;
    app.classList.toggle("task-focus", TASK_FOCUS_ROUTES.has(route));
  } catch (_) {}
}

function syncChromeForRoute(route, navRoute = navRouteForRoute(route)) {
  applyTaskFocusMode(route);
  renderSidebar(navRoute);
  renderBottomNav(navRoute, route);
  renderTopbar();
}

/* После экрана результата адрес меняется через replaceState и hashchange не
   срабатывает. Вернуть хром здесь явно, иначе скрытая на время задания
   навигация осталась бы скрытой и на экране итогов. */
function restoreChromeAfterResult(route) {
  try {
    syncChromeForRoute(route);
    if (window.Footer) Footer.sync(route);
  } catch (_) {}
}

function renderSidebar(active) {
  const locked = isSubjectChoiceLocked();
  try { document.getElementById("app").classList.toggle("chrome-locked", locked); } catch (_) {}
  const nav = document.getElementById("sidebarNav");
  if (locked) {
    nav.setAttribute("aria-disabled", "true");
    nav.innerHTML = NAV.map((n) => `
      <span class="nav-item is-disabled" aria-disabled="true" tabindex="-1" title="Сначала выбери предмет">
        ${icon(n.ic)}<span>${n.label}</span>
      </span>`).join("");
    document.getElementById("sidebarFooter").innerHTML = `
      <span style="font-size:12px">Сначала выбери предмет…</span>`;
    return;
  }
  nav.removeAttribute("aria-disabled");
  const navItems = subjectNavItems();
  const openErrors = Store.state.errors.filter((e) => !e.resolved).length;
  nav.innerHTML = navItems.map((n) => `
    <a class="nav-item ${n.route === active ? "active" : ""}" href="#/${n.route}">
      ${icon(n.ic)}<span>${n.label}</span>
      ${n.route === "errors" && openErrors ? `<span class="nav-badge">${openErrors}</span>` : ""}
    </a>`).join("");
  // На главной прогноз уже подробно показан в карточке. В меню держим
  // только навигацию: служебная надпись про SQLite и второй прогноз лишь
  // занимают место и дублируют один и тот же показатель.
  document.getElementById("sidebarFooter").innerHTML = "";
}

function renderBottomNav(active, route = currentRoute()) {
  const locked = isSubjectChoiceLocked();
  const focused = TASK_FOCUS_ROUTES.has(route);
  const bottom = document.getElementById("bottomnav");
  if (locked || focused) {
    // На выборе предмета и на активном задании нижнее меню скрываем полностью:
    // disabled-ссылки без стилей `.bottomnav a` выглядели «сырыми», а на
    // задании меню вообще не должно предлагать случайный переход.
    bottom.setAttribute("aria-disabled", "true");
    bottom.setAttribute("aria-hidden", "true");
    bottom.setAttribute("hidden", "");
    bottom.style.display = "none";
    bottom.innerHTML = "";
    return;
  }
  bottom.removeAttribute("aria-disabled");
  bottom.removeAttribute("aria-hidden");
  bottom.removeAttribute("hidden");
  bottom.style.display = "";
  const items = subjectNavItems().filter((n) => ["dashboard", "path", "training", "errors", "profile"].includes(n.route));
  bottom.innerHTML = items.map((n) => `
    <a href="#/${n.route}" class="${n.route === active ? "active" : ""}">${icon(n.ic)}<span>${n.label}</span></a>`).join("");
}

/* Уровень огня серии: 0–6 дней — обычный, 7–30 — красный, 31+ — фиолетовый.
   Один класс для шапки, главной и профиля — цвета и сила искр заданы в CSS. */
function streakTier(days) {
  const d = Number(days) || 0;
  if (d >= 31) return "streak-chip--inferno";
  if (d >= 7) return "streak-chip--hot";
  return "";
}

/* Высота верхней панели нужна липкой шапке сессии: без неё «Назад» и «Выйти»
   заезжали под topbar и пропадали. Панель переносится на узких экранах, поэтому
   меряем её фактическую высоту, а не считаем в CSS. */
function syncTopbarHeight() {
  try {
    const bar = document.getElementById("topbar");
    if (!bar) return;
    const h = Math.round(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--topbar-h", `${h}px`);
  } catch (_) {}
}
try {
  window.addEventListener("resize", syncTopbarHeight);
  window.addEventListener("orientationchange", syncTopbarHeight);
} catch (_) {}

function renderTopbar() {
  syncTopbarHeight();
  if (isSubjectChoiceLocked()) {
    document.getElementById("topbar").innerHTML = `
      <div class="topbar__spacer"></div>
      <span class="chip">Сначала выбери предмет…</span>
      <div class="topbar__spacer"></div>`;
    return;
  }
  if (!Store.state.onboarded) { document.getElementById("topbar").innerHTML = ""; return; }
  const li = levelInfo();
  const dark = Theme.current() === "dark";
  // В шапке оставляем только быстрый контекст: уровень, статус предмета
  // и серию. Подробный прогноз уже находится в одноимённой карточке на
  // главной — второй чип здесь был бы дублированием.
  const subjectState = subjectContentState();
  const locked = subjectLearningUnavailable(subjectState);
  const lockedInfo = locked ? (subjectState.info || subjectInfoSafe()) : null;
  const lockedStatus = locked ? (subjectState.locked ? "Карта тем · скоро" : "Материалы скоро") : "";
  const streak = nonNegativeNumber(Store.state.streak);
  document.getElementById("topbar").innerHTML = `
    <div class="level-chip">
      <span class="level-chip__badge">УР. ${esc(li.level)}</span>
      <div>
        <div class="level-chip__bar">${progressBar(li.pct, "progress--thin")}</div>
        <div class="level-chip__xp">${esc(nonNegativeNumber(li.current))} / ${esc(nonNegativeNumber(li.need))} XP</div>
      </div>
    </div>
    ${locked ? `<span class="chip chip--locked hide-mobile">${icon("lock")} ${esc(subjectDisplayName(lockedInfo))}</span>` : ""}
    <div class="topbar__spacer"></div>
    ${locked ? `<span class="chip chip--locked hide-mobile">${esc(lockedStatus)}</span>` : ""}
    <button class="btn btn--ghost theme-toggle" type="button" onclick="Theme.toggle()" aria-label="${dark ? "Включить светлую тему" : "Включить тёмную тему"}" aria-pressed="${dark}" title="${dark ? "Включить светлую тему" : "Включить тёмную тему"}">${icon(dark ? "sun" : "moon")}</button>
    <div class="streak-chip streak-chip--clickable ${streakTier(streak)}" title="Серия дней подряд — нажми, чтобы узнать, как это работает" role="button" tabindex="0" onclick="openHelp('streak')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHelp('streak')}">${icon("flame")} ${streak} дн</div>`;
}

/* ============================================================
   Screen: Главная
   ============================================================ */

/* ============================================================
   Admin Inbox — «Обращения» поверх дашборда (только администратор)
   Витрина сообщений со страницы «Контакты»:
   - блок рендерится, только когда сервер в bootstrap прислал
     isAdmin: true (решает backend через admin_sessions, фронт лишь
     отображает; из localStorage флаг никогда не читается);
   - лента — только НЕПРОЧИТАННЫЕ (GET .../support-messages?status=new
     за тем же require_admin, что у всей /admin);
   - единственное действие — «Прочитано» (POST .../<id>/read: new ->
     reviewed, идемпотентно). Прочитанное исчезает из ленты и больше
     в блоке не появляется; в БД строка остаётся. Никаких reply/edit/
     delete/email/Telegram действий;
   - раскрытие карточек и «показать ещё» — локальное состояние UI.
   ============================================================ */

const AdminInbox = {
  messages: [],
  total: 0,
  newCount: 0,
  limit: 20,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  accountId: null, // чей кэш лежит в messages; смена аккаунта → сброс
  expanded: {}, // id -> true, переживает перерисовки дашборда
  reading: {}, // id -> true, пока летит POST .../read (защита от даблклика)
  reset() {
    this.messages = [];
    this.total = 0;
    this.newCount = 0;
    this.hasMore = false;
    this.loading = false;
    this.loadingMore = false;
    this.error = null;
    this.accountId = null;
    this.expanded = {};
    this.reading = {};
  },
};

const ADMIN_INBOX_STATUS = { new: "Новый", reviewed: "Просмотрено", resolved: "Решено", archived: "В архиве" };

function adminInboxVisible() {
  try { return Store.isAdmin === true; } catch (_) { return false; }
}

function formatInboxDate(ts) {
  const ms = Number(ts);
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return String(ts); }
}

function adminInboxMessageHTML(m) {
  const id = Number(m.id) || 0;
  const open = !!AdminInbox.expanded[id];
  const status = ADMIN_INBOX_STATUS[m.status] || String(m.status || "—");
  const isNew = m.status === "new";
  return `
  <article class="aib-msg${open ? " open" : ""}">
    <button type="button" class="aib-msg__head" onclick="toggleAdminMessage(${id})"
        aria-expanded="${open ? "true" : "false"}" aria-label="Обращение № ${id}${isNew ? ", новое" : ""}">
      <span class="aib-msg__head-main">
        <span class="aib-msg__meta">${esc(formatInboxDate(m.createdAt))} · № ${id}</span>
        <span class="aib-msg__text">${esc(m.message || "")}</span>
      </span>
      ${isNew ? `<span class="chip chip--accent aib-pill">Новый</span>` : `<span class="chip aib-pill">${esc(status)}</span>`}
    </button>
    ${open ? `<div class="aib-msg__full">
      <div class="aib-msg__full-row"><span>Статус</span><b>${esc(status)}</b></div>
      <div class="aib-msg__full-row"><span>Получено</span><b>${esc(formatInboxDate(m.createdAt))}</b></div>
      <div class="aib-msg__full-row"><span>Номер</span><b class="mono">№ ${id}</b></div>
      <div class="aib-msg__actions">
        <button class="btn btn--soft btn--sm" type="button" data-aib-read="${id}"
            onclick="markAdminMessageRead(${id})"${AdminInbox.reading[id] ? " disabled" : ""}>${icon("check")} Прочитано</button>
      </div>
    </div>` : ""}
  </article>`;
}

function adminInboxListHTML() {
  if (AdminInbox.loading && !AdminInbox.messages.length) {
    return `<div class="aib-skeleton" aria-hidden="true"></div><div class="aib-skeleton" aria-hidden="true"></div>`;
  }
  if (AdminInbox.error && !AdminInbox.messages.length) {
    return `<div class="aib-error"><span>${esc(AdminInbox.error)}</span> <button class="btn btn--ghost btn--sm" type="button" onclick="refreshAdminInbox(true)">Попробовать снова</button></div>`;
  }
  if (!AdminInbox.messages.length) {
    return `<div class="aib-empty">Новых обращений нет.</div>`;
  }
  return AdminInbox.messages.map(adminInboxMessageHTML).join("");
}

function adminInboxFootHTML() {
  if (AdminInbox.error && AdminInbox.messages.length) {
    return `<div class="aib-more aib-error"><span>${esc(AdminInbox.error)}</span> <button class="btn btn--ghost btn--sm" type="button" onclick="loadMoreAdminInbox()">Ещё раз</button></div>`;
  }
  if (AdminInbox.loadingMore) return `<div class="aib-more"><span class="aib-counts">загружаем…</span></div>`;
  if (AdminInbox.hasMore) {
    const left = Math.max(0, AdminInbox.total - AdminInbox.messages.length);
    return `<div class="aib-more"><button class="btn btn--ghost btn--sm" type="button" onclick="loadMoreAdminInbox()">Показать ещё${left > 0 ? ` · осталось ${left}` : ""}</button></div>`;
  }
  return "";
}

function adminInboxCountsHTML() {
  if (AdminInbox.accountId === null && !AdminInbox.messages.length) {
    return `<span class="aib-counts aib-counts--loading">загружаем…</span>`;
  }
  // Лента — только новые: счётчик один, честный с сервера.
  return `<span class="aib-counts"><b class="mono">${AdminInbox.newCount}</b>&nbsp;новых</span>`;
}

function adminInboxHTML() {
  // Не админ — блока нет в DOM вообще (не скрыт CSS, а не отрендерен),
  // и fetch ниже не выполняется: обычный пользователь не получает ни
  // разметки, ни данных обращений.
  if (!adminInboxVisible()) return "";
  return `
  <section class="card card--glow admin-inbox" id="adminInbox" aria-label="Обращения пользователей">
    <div class="aib-head">
      <span class="aib-badge" aria-hidden="true">${icon("inbox")}</span>
      <div class="aib-head__titles">
        <div class="aib-title">Обращения</div>
        <div class="aib-sub">со страницы «Контакты» · отметь прочитанное, чтобы скрыть</div>
      </div>
      <span class="chip chip--accent aib-admin-chip">ADMIN</span>
    </div>
    <div class="aib-counts-row">${adminInboxCountsHTML()}</div>
    <div class="aib-list" id="adminInboxList">${adminInboxListHTML()}</div>
    <div class="aib-foot" id="adminInboxFoot">${adminInboxFootHTML()}</div>
  </section>`;
}

function paintAdminInbox() {
  try {
    const box = document.getElementById("adminInbox");
    if (!box || !adminInboxVisible()) return;
    const counts = box.querySelector(".aib-counts-row");
    const list = document.getElementById("adminInboxList");
    const foot = document.getElementById("adminInboxFoot");
    if (counts) counts.innerHTML = adminInboxCountsHTML();
    if (list) list.innerHTML = adminInboxListHTML();
    if (foot) foot.innerHTML = adminInboxFootHTML();
  } catch (_) {}
}

/* 401/403 от inbox-эндпоинта = сервер не признал admin-сессию (истекла,
   отозвана, чужая). Безопасное состояние: флаг сбрасываем, кэш трём,
   блок убираем из DOM точечно, без полного ререндера посреди тренировки. */
function adminInboxAuthFail(error) {
  if (error && (error.status === 401 || error.status === 403)) {
    try { Store.isAdmin = false; } catch (_) {}
    try { AdminInbox.reset(); } catch (_) {}
    try {
      const node = document.getElementById("adminInbox");
      if (node) node.remove();
    } catch (_) {}
    return true;
  }
  return false;
}

async function fetchAdminInboxPage(offset, append) {
  const payload = await ApiClient.get(`/api/admin/support-messages?limit=${AdminInbox.limit}&offset=${offset}&status=new`);
  const list = Array.isArray(payload.messages) ? payload.messages : [];
  AdminInbox.messages = append ? AdminInbox.messages.concat(list) : list;
  AdminInbox.total = Number(payload.total) || 0;
  AdminInbox.newCount = Number(payload.newCount) || 0;
  AdminInbox.hasMore = AdminInbox.messages.length < AdminInbox.total;
  try { AdminInbox.accountId = Store.accountId || null; } catch (_) {}
}

async function refreshAdminInbox(force) {
  if (!adminInboxVisible() || AdminInbox.loading) return;
  try {
    if (Store.accountId !== AdminInbox.accountId) AdminInbox.reset();
  } catch (_) { AdminInbox.reset(); }
  if (!force && AdminInbox.messages.length) {
    // Кэш уже на экране: тихо сверяем первую страницу (свежие счётчики),
    // раскрытые карточки при этом не схлопываем, скелетон не показываем.
    try { await fetchAdminInboxPage(0, false); } catch (error) {
      if (adminInboxAuthFail(error)) return;
    }
    paintAdminInbox();
    return;
  }
  AdminInbox.loading = true;
  AdminInbox.error = null;
  paintAdminInbox();
  try {
    await fetchAdminInboxPage(0, false);
  } catch (error) {
    if (adminInboxAuthFail(error)) return;
    AdminInbox.error = "Не удалось загрузить обращения.";
  }
  AdminInbox.loading = false;
  paintAdminInbox();
}

async function loadMoreAdminInbox() {
  if (!adminInboxVisible() || AdminInbox.loadingMore || !AdminInbox.hasMore) return;
  AdminInbox.loadingMore = true;
  AdminInbox.error = null;
  try {
    const foot = document.getElementById("adminInboxFoot");
    if (foot) foot.innerHTML = adminInboxFootHTML();
  } catch (_) {}
  try {
    await fetchAdminInboxPage(AdminInbox.messages.length, true);
  } catch (error) {
    if (adminInboxAuthFail(error)) return;
    AdminInbox.error = "Не удалось догрузить обращения.";
  }
  AdminInbox.loadingMore = false;
  paintAdminInbox();
}

/* Единственное пишущее действие inbox: отметить обращение прочитанным.
   Сервер переводит new -> reviewed идемпотентно; лента status=new его
   больше не отдаёт, поэтому после успеха тихо перечитываем первую
   страницу — счётчики и порядок всегда честные, раскрытые соседние
   карточки не схлопываем. Даблклик и гонки закрыты флагом reading. */
async function markAdminMessageRead(id) {
  id = Number(id) || 0;
  if (!id || !adminInboxVisible() || AdminInbox.reading[id]) return;
  AdminInbox.reading[id] = true;
  try {
    const btn = document.querySelector(`[data-aib-read="${id}"]`);
    if (btn) btn.disabled = true;
  } catch (_) {}
  try {
    await ApiClient.post(`/api/admin/support-messages/${id}/read`, {});
    delete AdminInbox.expanded[id];
    await fetchAdminInboxPage(0, false);
    paintAdminInbox();
    try { toast("Обращение отмечено прочитанным", "", "check"); } catch (_) {}
  } catch (error) {
    if (adminInboxAuthFail(error)) return;
    try { toast("Не удалось отметить обращение. Попробуй ещё раз.", "toast--error", "x"); } catch (_) {}
    paintAdminInbox();
  } finally {
    delete AdminInbox.reading[id];
  }
}

function queueAdminInboxLoad() {
  if (!adminInboxVisible()) return;
  try {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => refreshAdminInbox(false), { timeout: 1500 });
    else setTimeout(() => refreshAdminInbox(false), 50);
  } catch (_) {
    refreshAdminInbox(false);
  }
}

function toggleAdminMessage(id) {
  id = Number(id) || 0;
  if (!id) return;
  if (AdminInbox.expanded[id]) delete AdminInbox.expanded[id];
  else AdminInbox.expanded[id] = true;
  try {
    const box = document.getElementById("adminInboxList");
    if (box && adminInboxVisible()) box.innerHTML = adminInboxListHTML();
  } catch (_) {}
}

function screenDashboard(root) {
  const s = Store.state;
  const subjectState = subjectContentState();
  // Пустой/закрытый предмет не должен получать виртуальные «0/1», прогноз
  // по чужим весам или ежедневную задачу без единого задания. Это отдельный
  // понятный экран, а не набор декоративных статистик.
  if (subjectState.empty || subjectState.locked) {
    const info = subjectState.info || subjectInfoSafe();
    root.innerHTML = `
      ${adminInboxHTML()}
      <div class="page-head">
        <div class="page-title">Главная</div>
        <div class="page-sub">${esc(subjectDisplayName(info))} · ${subjectState.empty ? "материалы скоро" : "тема пока закрыта"}</div>
      </div>
      ${subjectStateCardHTML(subjectState)}`;
    try { queueAdminInboxLoad(); } catch (_) {}
    return;
  }
  const li = levelInfo();
  const f = safeForecast();
  const trend = forecastTrend();
  const act = todayActivity();
  const errors = asSafeArray(s.errors);
  const openErrors = errors.filter((e) => e && !e.resolved).length;
  const d = DataAPI.daily() || {};
  ensureDailyChallenge();
  const dailyIds = asSafeArray(dailyTaskIds());
  const dailyGoal = Math.max(0, dailyIds.length || nonNegativeNumber(d.target));
  const dailyDone = s.daily && s.daily.date === todayStr() && !!s.daily.done;
  const dailySolved = s.daily && s.daily.date === todayStr() ? nonNegativeNumber(s.daily.solved) : 0;
  const openLesson = mostRecentOpenLesson();
  const missions = asSafeArray(DataAPI.missions()).filter((m) => m && missionPracticeIds(m).length && (!DataAPI.skill(m.skill) || !topicIsLocked(DataAPI.skill(m.skill))));
  const activeMission = !openLesson && (missions.find((m) => missionProgress(m) > 0 && !(s.missionsDone || {})[m.id])
    || missions.find((m) => !(s.missionsDone || {})[m.id]));

  /* Главный навигатор обучения: кандидаты пересчитываются при каждом
     рендере, поэтому после любого результата блок показывает актуальный
     лучший шаг. Альтернативы показываем открыто — пользователь свободен. */
  const steps = safeNextStepCandidates();
  const step = steps[0] || null;
  const alts = steps.slice(1, 3);
  const topGainRaw = forecastTopGains(1).find((item) => item && DataAPI.skill(item.skillId) && !topicIsLocked(DataAPI.skill(item.skillId))) || null;
  const topGain = topGainRaw ? { gain: nonNegativeNumber(topGainRaw.gain), skillId: topGainRaw.skillId, shortName: String(topGainRaw.name || "тема").replace(/^№\d+\s*[—–-]\s*/, "") } : null;
  const cov = forecastCoverage();
  const goal = forecastGoalNum();

  /* Блок «Требуют внимания» показывает только реальные проблемы: открытые
     ошибки и темы с плохой точностью. Темы, которые просто ещё не тронуты
     (0%), или темы со стабильно верными ответами, но маленьким объёмом —
     не слабые места. */
  const weakSpots = subjectSkills()
    .filter((sk) => sk && !topicIsLocked(sk) && skillNeedsAttention(sk.id))
    .map((sk) => ({ sk, prog: nonNegativeNumber(skillProgress(sk.id)), errs: openErrorCount(sk.id) }))
    .sort((a, b) => (a.prog - b.prog) || (b.errs - a.errs))
    .slice(0, 4);

  root.innerHTML = `
    ${adminInboxHTML()}
    <div class="page-head">
      <div class="page-title">Главная</div>
      <div class="page-sub">цель: ${goalLabel()} • до ЕГЭ осталось ${egeCountdownLabel()}</div>
    </div>

    <div class="hero">
      <div class="card card--glow">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <div class="stat-label">Уровень подготовки</div>
            <div class="stat-num">УРОВЕНЬ ${esc(li.level)}</div>
          </div>
          <div style="text-align:right">
            <div class="stat-label">Опыт ${helpDot("xp")}</div>
            <div class="mono" style="font-size:17px;font-weight:700">${esc(nonNegativeNumber(li.current))} <span style="color:var(--muted)">/ ${esc(nonNegativeNumber(li.need))} XP</span></div>
          </div>
        </div>
        <div style="margin-top:16px">${progressBar(li.pct)}</div>
        <div style="margin-top:18px;font-size:13px;color:var(--text-2)">
          ${dailyGoal ? `Сегодня: <b class="mono">${Math.min(nonNegativeNumber(act.solved), dailyGoal)} / ${dailyGoal}</b> заданий` : "Ежедневная подборка пока не создана"}
        </div>
        <div style="margin-top:12px;max-width:340px">${progressBar(dailyGoal ? Math.min(nonNegativeNumber(act.solved) / dailyGoal, 1) * 100 : 0, "progress--thin progress--success")}</div>
      </div>

      <div class="card forecast-card forecast-hero">
        ${f.empty ? `
        <div class="stat-label">Прогноз результата ЕГЭ ${helpDot("forecast")}</div>
        <div class="forecast-empty">
          <div class="forecast-empty__icon">${icon("stats")}</div>
          <div class="forecast-empty__title">Прогноз появится позже</div>
          <div class="forecast-empty__text">Пока считать не по чему: проходи уроки и практику — после первых шагов здесь будет твой диапазон баллов и шкала до цели.</div>
          <button class="btn btn--primary btn--sm" onclick="go('path')">Открыть путь</button>
        </div>` : `
        <div class="forecast-hero__top">
          <div class="stat-label">Прогноз результата ЕГЭ ${helpDot("forecast")}</div>
          <span class="forecast-trend ${trend && trend.delta > 0 ? "forecast-trend--up" : trend && trend.delta < 0 ? "forecast-trend--down" : ""}">${forecastTrendLabel(trend)}</span>
        </div>
        <div class="forecast-mid">${f.mid}<small>баллов</small></div>
        <div class="forecast-range">диапазон <b class="mono">${f.low}–${f.high}</b>${goal != null ? (f.mid >= goal ? ` · цель ${goal}+ достигнута` : ` · до цели ${goal}+ осталось <b class="mono">${goal - f.mid}</b>`) : ""}</div>
        ${(() => { const scale = forecastScale(); const max = Math.max(1, scale.length ? scale[scale.length - 1] : forecastTotal()); const pct = (v) => Math.min(100, Math.max(0, (v / max) * 100)); return `
        <div class="forecast-scale__labels forecast-scale__labels--top"><span>0</span>${goal != null ? `<span>${max}</span>` : `<span>${Math.round(max / 2)}</span><span>${max}</span>`}</div>
        <div class="forecast-scale" role="img" aria-label="Шкала прогноза: ${f.mid} из ${max}${goal != null ? `, цель ${goal}` : ""}">
          <div class="forecast-scale__fill" style="width:${pct(f.mid)}%"></div>
          ${goal != null ? `<div class="forecast-scale__goal" style="left:calc(${pct(goal)}% - 1px)"></div>` : ""}
        </div>
        ${goal != null ? (() => { const gc = pct(goal); const ga = gc <= 12 ? "left" : gc >= 88 ? "right" : "center"; return `<div class="forecast-scale__labels forecast-scale__labels--goal"><span class="goal goal--${ga}" style="left:${gc}%">цель ${goal}</span></div>`; })() : ""}`; })()}
        ${topGain ? `<button class="forecast-gain-btn" onclick="go('skill', '${topGain.skillId}')" title="Открыть тему">Закрой «${esc(topGain.shortName)}» — будет <b class="mono">+${topGain.gain}</b><span class="go">→</span></button>` : ""}
        ${cov.totalLessons ? `<div class="forecast-cover">
          <div class="forecast-cover__row"><span>Уроки: ${cov.doneLessons} из ${cov.totalLessons}</span><span>Темы с данными: ${cov.covered} из ${cov.totalSkills}</span></div>
          ${progressBar(cov.lessonPct, "progress--thin")}
        </div>` : ""}
        <div class="forecast-note">${forecastNoteHTML()}</div>`}
      </div>
    </div>

    ${DataAPI.isSubjectEmpty() ? subjectEmptyHTML() : ""}

    ${!DataAPI.isSubjectEmpty() && step ? `
    <div class="card nextstep">
      <div class="nextstep__head">
        <span class="nextstep__label">${icon("zap")} Что делать сейчас ${helpDot("nextstep")}</span>
        <span class="nextstep__freedom">Это совет, а не приказ — все разделы открыты, выбирай любой</span>
      </div>
      <div class="nextstep__title">${esc(step.text)}</div>
      <div class="nextstep__reason">${esc(step.reason)}</div>
      <div class="nextstep__actions">
        <button class="btn btn--primary btn--lg" onclick="runNextStep(0)">Начать ${icon("arrow")}</button>
        <div class="nextstep__alts">
          ${alts.map((a, i) => `
            <button class="btn btn--ghost btn--sm" onclick="runNextStep(${i + 1})" title="${esc(a.reason)}">
              ${icon(a.icon)}<span>${esc(a.text)}</span>
            </button>`).join("")}
        </div>
      </div>
    </div>` : ""}

    <div class="section-title">Быстрый доступ</div>
    <div class="action-cards">
      <div class="card card--hover action-card" role="button" tabindex="0" onclick="continueTraining()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();continueTraining()}" aria-label="Продолжить обучение">
        <div class="action-card__icon">${icon("training")}</div>
        <div><div class="action-card__title">Продолжить обучение</div>
        <div class="action-card__sub">${openLesson ? `Урок «${openLesson.lesson.title}» — шаг ${Math.min(nonNegativeNumber(openLesson.session.idx) + 1, Math.max(1, DataAPI.lessonStepsCount(openLesson.lesson)))}/${DataAPI.lessonStepsCount(openLesson.lesson)}` : activeMission ? `«${activeMission.title}» — ${missionProgress(activeMission)}/${missionPracticeCount(activeMission)}` : "Текущая тема по рекомендации"}</div></div>
      </div>
      <div class="card card--hover action-card action-card--warn" role="button" tabindex="0" onclick="${openErrors ? "startErrorsReview()" : "go('errors')"}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${openErrors ? "startErrorsReview()" : "go('errors')"}}" aria-label="Повторить ошибки">
        <div class="action-card__icon">${icon("rotate")}</div>
        <div><div class="action-card__title">Повторить ошибки</div>
        <div class="action-card__sub">${openErrors ? `Открыто ошибок: ${openErrors}` : "Все ошибки закрыты"}</div></div>
      </div>
      <div class="card card--hover action-card action-card--success" role="button" tabindex="0" onclick="${dailyGoal ? "startDaily()" : "go('trials')"}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${dailyGoal ? "startDaily()" : "go('trials')"}}" aria-label="Ежедневная задача">
        <div class="action-card__icon">${icon("zap")}</div>
        <div><div class="action-card__title">Ежедневная задача</div>
        <div class="action-card__sub">${dailyGoal ? (dailyDone ? "Выполнена · можно повторить без награды" : `${dailySolved} / ${dailyGoal} · +${esc(nonNegativeNumber(d.xp))} XP`) : "Подборка появится после подключения заданий"}</div></div>
      </div>
      <div class="card card--hover action-card action-card--violet" role="button" tabindex="0" onclick="go('trials')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();go('trials')}" aria-label="Испытания">
        <div class="action-card__icon">${icon("crown")}</div>
        <div><div class="action-card__title">Испытания</div>
        <div class="action-card__sub">Боссы и смешанная проверка формы</div></div>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:34px">
      <div>
        <div class="section-title" style="margin-top:0">Навыки ${helpDot("skills")}</div>
        <div class="card" style="padding:10px 8px">
          ${subjectSkills().map((sk) => {
            const st = (s.skillStats && s.skillStats[sk.id]) || { solved: 0, correct: 0 };
            const solved = nonNegativeNumber(st.solved);
            const acc = solved ? Math.round(nonNegativeNumber(st.correct) / solved * 100) : 0;
            const locked = topicIsLocked(sk);
            const action = locked ? `openLockedSkillModal('${esc(sk.id)}')` : `go('skill', '${esc(sk.id)}')`;
            return `
            <div class="skill-row${locked ? " skill-row--locked" : ""}" role="button" tabindex="0" onclick="${action}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${action}}" aria-label="${locked ? "Посмотреть информацию о закрытой теме" : "Открыть тему"} ${esc(topicDisplayName(sk))}">
              <div class="skill-row__name">${esc(topicDisplayName(sk))}</div>
              ${locked ? `<div class="skill-row__locked-label">${icon("lock")} Материалы скоро</div>`
                : `${progressBar(skillProgress(sk.id))}
              <div class="skill-row__pct">${nonNegativeNumber(skillProgress(sk.id))}%</div>`}
              <div class="skill-row__tip">
                ${locked ? "Материалы пока закрыты<br>" : `Решено: <b>${solved}</b> · точность: <b>${acc}%</b><br>`}
                Статус: ${statusLabel(topicStatus(sk))}<br>
                ${locked ? "Нажми, чтобы узнать почему" : "Нажми, чтобы открыть детали"}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div>
        <div class="section-title" style="margin-top:0">Требуют внимания</div>
        <div class="card">
          ${DataAPI.isSubjectEmpty() ? `<div class="empty">Навыков пока нет — они появятся вместе с материалами предмета.</div>`
          : weakSpots.length ? weakSpots.map(({ sk, prog, errs }) => `
            <div class="skill-row" role="button" tabindex="0" onclick="go('skill', '${sk.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();go('skill', '${sk.id}')}" aria-label="Открыть тему ${esc(sk.name)}">
              <div class="skill-row__name">${sk.name}</div>
              ${progressBar(prog)}
              <div class="skill-row__pct">${prog}%</div>
              <div class="skill-row__tip">
                ${errs ? `Открыто ошибок: <b>${errs}</b><br>` : "Ошибок нет — просто мало освоено<br>"}
                Нажми, чтобы открыть тему
              </div>
            </div>`).join("")
          : `<div class="empty">Слабых мест нет — все навыки в хорошем состоянии. Поддерживай форму испытаниями.</div>`}
        </div>
      </div>
    </div>`;
  // Inbox догружается отдельным защищённым запросом и только для
  // администратора; обычные пользователи этот fetch не выполняют вообще.
  try { queueAdminInboxLoad(); } catch (_) {}
}

/* Исполнитель шага из умного блока: кандидаты пересчитываются в момент
   нажатия, а не берутся с прошлого рендера — действие всегда соответствует
   актуальному состоянию знаний. */
function nextStepActionable(candidate) {
  if (!candidate || !candidate.action) return false;
  const payload = candidate.payload || {};
  try {
    if (candidate.action === "finish-lesson" || candidate.action === "lesson") {
      const lesson = DataAPI.lesson(payload.lessonId);
      const skill = lesson && DataAPI.skill(lesson.skill);
      return !!lesson && DataAPI.lessonStepsCount(lesson) > 0 && (!skill || (!topicExplicitlyLocked(skill) && topicHasLesson(skill)));
    }
    if (candidate.action === "errors-review") return asSafeArray(Store.state.errors).some((e) => e && !e.resolved);
    if (candidate.action === "practice") {
      const mission = DataAPI.mission(payload.missionId);
      const skill = mission && DataAPI.skill(mission.skill);
      return !!mission && missionPracticeIds(mission).length > 0 && (!skill || !topicIsLocked(skill));
    }
    if (candidate.action === "boss") {
      const boss = DataAPI.bosses().find((item) => item && item.id === payload.bossId);
      return !!boss && bossUnlocked(boss) && DataAPI.practiceTasks().some((task) => DataAPI.skill(task.skill) && DataAPI.skill(task.skill).cat === boss.cat);
    }
    if (candidate.action === "daily") return dailyTaskIds().length > 0;
    if (candidate.action === "mixed") return DataAPI.practiceTasks().length > 0;
  } catch (_) {
    return false;
  }
  return false;
}

function safeNextStepCandidates() {
  if (subjectContentState().locked) return [];
  try {
    return asSafeArray(nextStepCandidates()).filter(nextStepActionable);
  } catch (_) {
    return [];
  }
}

function runNextStep(index = 0) {
  const c = safeNextStepCandidates()[index];
  if (!c) return;
  switch (c.action) {
    case "finish-lesson":
    case "lesson": Lesson.start(c.payload.lessonId); break;
    case "errors-review": startErrorsReview(); break;
    case "practice": startMission(c.payload.missionId); break;
    case "boss": startBoss(c.payload.bossId); break;
    case "daily": startDaily(); break;
    case "mixed": startMixedTrial(); break;
    default: go(c.route ? c.route.replace("#/", "") : "dashboard");
  }
}

/* Цель текущего предмета с healing: в состояниях эры пустой базы goal может
   отсутствовать или ссылаться на чужую шкалу — для отображения берём первую
   цель шкалы предмета (как defaultGoal()), иначе у базы нет риски на шкале. */
function currentGoal() {
  const list = (typeof DataAPI !== "undefined" && DataAPI.goals) ? (DataAPI.goals() || []) : [];
  const g = list.find((x) => x && x.id === Store.state.goal);
  return g || (list.length ? list[0] : null);
}
function goalLabel() {
  const g = currentGoal();
  return g ? g.label : "не выбрана";
}

/* Число цели для шкалы прогноза в баллах предмета: сначала ищем порог вида
   «12+ баллов» в desc (у базы цель — оценка, а баллы лежат в описании:
   «12+ баллов — уверенный результат»), иначе — первое число label
   («80+ баллов» у профиля). Нет цели — нет метки, шкала остаётся чистой. */
function forecastGoalNum() {
  const g = currentGoal();
  if (!g) return null;
  const d = String(g.desc || "").match(/(\d+)\s*\+/);
  if (d) return Number(d[1]);
  const m = String(g.label || "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

/* Дата профильной математики в основной период — 8 июня.
   Если в этом году экзамен уже прошёл, считаем до 8 июня следующего года.
   Все расчёты — по московскому календарю (Europe/Moscow), а не по
   локальному часовому поясу браузера. */
function moscowDayParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow", day: "numeric", month: "numeric", year: "numeric",
  }).formatToParts(date || new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function egeExamDate(from) {
  const t = moscowDayParts(from || new Date());
  const todayKey = Date.UTC(t.y, t.m - 1, t.d);
  let examKey = Date.UTC(t.y, 5, 8);
  if (todayKey > examKey) examKey = Date.UTC(t.y + 1, 5, 8);
  return new Date(examKey);
}

function egeMonthExact(n) {
  return `${n} ${plural(n, "месяц", "месяца", "месяцев")}`;
}

/* Форма после «чуть больше / чуть меньше»: эти слова требуют
   родительного падежа — «месяца» (1) или «месяцев» (2+). */
function egeMonthGenitive(n) {
  return n === 1 ? "месяца" : `${n} месяцев`;
}

/* Человеческий остаток до ЕГЭ на русском: дни → недели → месяцы.
   Покрывает «1 месяц», «2 месяца», «5 месяцев», «полгода»,
   «полтора месяца», «чуть меньше месяца», «почти месяц»,
   «чуть больше месяца», «почти N …», «чуть больше N …». */
function egeCountdownLabel(now) {
  const t = moscowDayParts(now || new Date());
  const todayKey = Date.UTC(t.y, t.m - 1, t.d);
  const examKey = egeExamDate(now || new Date()).getTime();
  const d = Math.round((examKey - todayKey) / 86400000);
  if (d <= 0) return "сегодня";
  if (d === 1) return "1 день";
  if (d < 7) return `${d} ${plural(d, "день", "дня", "дней")}`;
  if (d === 7) return "1 неделя";
  if (d <= 10) return "чуть больше недели";
  if (d <= 13) return "почти 2 недели";
  if (d === 14) return "2 недели";
  if (d <= 17) return "чуть больше 2 недель";
  if (d <= 20) return "почти 3 недели";
  if (d <= 23) return "3 недели";
  if (d <= 26) return "чуть меньше месяца";
  if (d <= 30) return "почти месяц";
  if (d <= 37) return "1 месяц";
  if (d <= 48) return "чуть больше месяца";
  if (d <= 56) return "полтора месяца";
  if (d <= 66) return "почти 2 месяца";
  if (d >= 350) return "почти год";
  if (d >= 168 && d <= 198) return "полгода";
  const mExact = d / 30.44;
  const r = Math.max(2, Math.round(mExact));
  if (r >= 12) return "почти год";
  const delta = mExact - r;
  if (Math.abs(delta) <= 0.18) return egeMonthExact(r);
  if (delta > 0.18) return `чуть больше ${egeMonthGenitive(r)}`;
  return `почти ${egeMonthExact(r)}`;
}

function statusLabel(st) {
  return {
    "locked": "заблокирован",
    "not-started": "не начата",
    "weak": "слабое место",
    "in-progress": "в процессе",
    "completed": "пройден",
    "mastered": "освоен",
  }[st] || "неизвестно";
}

function continueTraining() {
  const s = Store.state;
  if (subjectContentState().locked) return go("path");
  // Незавершённый урок — самое дешёвое следующее действие: доучить то, что
  // уже открыто, а не начинать новую сессию по свободной практике.
  const openLesson = mostRecentOpenLesson();
  if (openLesson) return Lesson.start(openLesson.lessonId);
  const missions = asSafeArray(DataAPI.missions()).filter((m) => m && missionPracticeIds(m).length);
  const active = missions.find((m) => missionProgress(m) > 0 && !(s.missionsDone || {})[m.id]);
  if (active) return startMission(active.id);
  // Единый поток тренировки — через миссию темы (награда и прогресс),
  // свободная практика отдельной сущностью больше не представлена.
  const available = subjectSkills().filter((sk) => sk && !topicIsLocked(sk));
  const worst = available.length ? weakestSkill() : null;
  const mission = worst && missions.find((m) => m.skill === worst.id);
  if (mission) return startMission(mission.id);
  const fallbackSkill = (worst && !topicIsLocked(worst)) ? worst : available.find((sk) => topicHasPractice(sk));
  // Запасной вариант без миссии: весь банк темы, без усечения — состав
  // практики всегда равен реально доступным заданиям.
  const tasks = orderedTasks(DataAPI.practiceTasksBySkill(fallbackSkill ? fallbackSkill.id : "")).map((t) => t.id);
  if (!tasks.length) return go("path");
  Session.start({ title: fallbackSkill ? `Тренировка: ${topicDisplayName(fallbackSkill)}` : "Тренировка", taskIds: tasks, mode: "quick" });
}

/* ============================================================
   Screen: Путь (skill tree)
   ============================================================ */

function screenPath(root) {
  const allSkills = subjectSkills().filter(Boolean);
  const categories = subjectCategories().filter(Boolean);
  const groups = [];
  const seen = new Set();
  for (const category of categories) {
    const skills = allSkills.filter((skill) => skill.cat === category.id).sort((a, b) => nonNegativeNumber(a.order) - nonNegativeNumber(b.order));
    if (skills.length) {
      groups.push({ id: category.id, name: subjectDisplayName(category), skills });
      skills.forEach((skill) => seen.add(skill.id));
    }
  }
  // Старый/частичный реестр может прислать тему без категории. Не теряем
  // её из Path и не показываем `undefined` в заголовке.
  const orphans = allSkills.filter((skill) => !seen.has(skill.id)).sort((a, b) => nonNegativeNumber(a.order) - nonNegativeNumber(b.order));
  if (orphans.length) groups.push({ id: "__topics", name: "Темы предмета", skills: orphans });

  if (!allSkills.length) {
    root.innerHTML = `
      <div class="page-head">
        <div class="page-title">Путь ${helpDot("path")}</div>
        <div class="page-sub">Карта тем предмета появится вместе с материалами.</div>
      </div>
      ${subjectStateCardHTML({ ...subjectContentState(), empty: true })}`;
    return;
  }

  const branches = groups.map((group) => {
    const progressLabel = pathProgressLabel(group.skills);
    return `
      <div class="tree-branch">
        <div class="tree-branch__title">${esc(group.name.toUpperCase())} <span>${esc(progressLabel)}</span></div>
        <div class="tree-nodes">
          ${group.skills.map((skill) => {
            const status = topicStatus(skill);
            const locked = status === "locked";
            const progressValue = nonNegativeNumber(skillProgress(skill.id));
            const openAction = locked ? `openLockedSkillModal('${esc(skill.id)}')` : `go('skill', '${esc(skill.id)}')`;
            const ege = skill.ege || skill.examNumber || "тема ЕГЭ";
            return `
            <div class="tree-node tree-node--${status}" data-topic-locked="${locked ? "true" : "false"}" onclick="${openAction}" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${openAction}}" aria-label="${locked ? "Посмотреть информацию о закрытой теме" : "Открыть тему"} ${esc(topicDisplayName(skill))}"${locked ? ' aria-haspopup="dialog"' : ""}>
              <div class="tree-node__dot"></div>
              <div class="tree-node__body">
                <div class="tree-node__name">${esc(topicDisplayName(skill))}
                  <span class="chip ${statusChipClass(status)} tree-node__status">${statusLabel(status)}</span>
                </div>
                ${locked ? `<div class="tree-node__meta"><span>${icon("lock")} Материалы темы пока закрыты</span></div>`
                  : `<div class="tree-node__meta">
                    <div class="tree-node__bar">${progressBar(progressValue, "progress--thin progress--gauge")}</div>
                    <span class="mono">${progressValue}%</span>
                    <span>· ${esc(ege)}</span>
                  </div>`}
              </div>
              <div class="tree-node__lock">${icon(locked ? "lock" : "arrow")}</div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");

  const info = subjectInfoSafe();
  const pathState = subjectContentState();
  const lockedCount = allSkills.filter((skill) => topicIsLocked(skill)).length;
  const pathDescription = pathState.locked
    ? "Карта тем предмета: зарегистрированные темы и статус их материалов."
    : pathState.empty
      ? "Карта тем предмета появится вместе с материалами."
      : "Карта тем ЕГЭ и твой прогресс по каждой.";
  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Путь ${helpDot("path")}</div>
      <div class="page-sub">${esc(pathDescription)} ${lockedCount ? "Закрытые темы отмечены замком — они не ведут в пустые уроки или практику." : "Нажми на тему — увидишь доступные материалы."}</div>
    </div>
    <div class="path-map">
      <div class="tree-root"><div class="tree-root__node">ЕГЭ<small>${esc(subjectDisplayName(info))} · ${esc(pathProgressLabel(allSkills))}</small></div></div>
      <div class="tree-connector-v"></div>
      <div class="tree-branches${groups.length === 1 ? " tree-branches--single" : ""}">${branches}</div>
    </div>
    ${lockedCount ? `<div class="path-locked-note">${icon("lock")} ${lockedTopicCountLabel(lockedCount)}: карта сохраняет её название, но не показывает несуществующие уроки и задания.</div>` : ""}`;
}

function overallProgress() {
  return pathProgressForSkills(subjectSkills().filter(Boolean));
}

function statusChipClass(st) {
  return { "locked": "chip--locked", "not-started": "", "weak": "chip--danger", "in-progress": "chip--accent", "completed": "chip--success", "mastered": "chip--success" }[st] || "";
}

/* Закрытая тема: тот же стиль окна, что и у обычной темы, но без кнопок
   на несуществующие уроки/практику. Причина берётся из registry или из
   фактического наличия ресурсов, поэтому это не привязка к русскому предмету. */
function openLockedSkillModal(skillId) {
  const sk = subjectSkillById(skillId);
  if (!sk) return;
  const category = topicCategory(sk);
  const categoryName = category ? subjectDisplayName(category) : "Темы предмета";
  const ege = sk.ege || sk.examNumber || "тема ЕГЭ";
  const hasLesson = topicHasLesson(sk);
  openModal(`
    <div class="stat-label">${esc(categoryName)} · ${esc(ege)}</div>
    <div class="skill-modal__title">${esc(topicDisplayName(sk))}</div>
    <div style="margin-top:6px"><span class="chip chip--locked">${icon("lock")} ${statusLabel("locked")}</span></div>
    <div class="topic-lock-message">
      ${icon("lock")}
      <div>${esc(topicLockReason(sk))}</div>
    </div>
    ${hasLesson ? `<div class="topic-lock-note">У этой темы уже есть урок, но практика и дополнительные материалы ещё не подключены.</div>` : ""}
    <div class="skill-modal__actions">
      <button class="btn btn--primary" onclick="closeModal()">Понятно</button>
    </div>`, "Информация о закрытой теме");
}

function openSkillModal(skillId) {
  const sk = subjectSkillById(skillId);
  if (!sk) return;
  if (topicIsLocked(sk)) return openLockedSkillModal(skillId);
  const st = (Store.state.skillStats && Store.state.skillStats[skillId]) || { solved: 0, correct: 0 };
  const solved = nonNegativeNumber(st.solved);
  const acc = solved ? Math.round(nonNegativeNumber(st.correct) / solved * 100) : 0;
  const status = topicStatus(sk);
  const skillErrors = asSafeArray(Store.state.errors).filter((e) => e && e.skill === skillId && !e.resolved);
  const subs = [...new Set(skillErrors.map((e) => e.sub).filter(Boolean))];
  const missions = asSafeArray(DataAPI.missions()).filter((m) => m && m.skill === skillId);
  const doneMissions = Store.state.missionsDone || {};
  const mission = missions.find((m) => !doneMissions[m.id] && missionPracticeIds(m).length)
    || missions.find((m) => missionPracticeIds(m).length);
  const lessons = asSafeArray(DataAPI.lessonsBySkill(skillId)).filter((lesson) => DataAPI.lessonStepsCount(lesson) > 0);
  const lessonErrs = lessonStepErrorsBySkill(skillId);
  const category = topicCategory(sk);
  const categoryName = category ? subjectDisplayName(category) : "Темы предмета";
  const ege = sk.ege || sk.examNumber || "тема ЕГЭ";

  openModal(`
    <div class="stat-label">${esc(categoryName)} · ${esc(ege)}</div>
    <div class="skill-modal__title">${esc(topicDisplayName(sk))}</div>
    <div style="margin-top:6px"><span class="chip ${statusChipClass(status)}">${statusLabel(status)}</span></div>

    <div style="margin:20px 0 8px">${progressBar(skillProgress(skillId))}</div>
    <div class="skill-modal__stats">
      <div><div class="skill-modal__stat-num">${nonNegativeNumber(skillProgress(skillId))}%</div><div class="stat-label">освоение навыка</div></div>
      <div><div class="skill-modal__stat-num">${solved}</div><div class="stat-label">решено задач</div></div>
      <div><div class="skill-modal__stat-num">${acc}%</div><div class="stat-label">правильных</div></div>
    </div>
    ${(() => {
      const b = skillProgressBreakdown(skillId);
      const thMax = b.lessonTotal ? 40 : 0;
      const prMax = b.lessonTotal ? 60 : 100;
      const split = b.lessonTotal
        ? 'теория <b>' + b.theory + '</b> из 40 · практика <b>' + b.practice + '</b> из 60'
        : 'урока по теме нет — весь прогресс из практики: <b>' + b.practice + '</b> из 100';
      let hint;
      if (b.total >= 90) hint = 'Тема освоена — так держать.';
      else if (b.lessonTotal && b.lessonDone < b.lessonTotal) hint = 'Пройди урок — это сразу +40 к освоению.';
      else {
        const k = practiceSolvesToTarget(skillId, 90);
        hint = k > 0
          ? 'До «освоена» (90%): примерно ' + k + ' ' + plural(k, 'верный ответ', 'верных ответа', 'верных ответов') + ' подряд.'
          : 'Точность сильно просела из-за старых ошибок — понадобится длинная серия верных ответов, чтобы её выправить.';
      }
      return '<div style="margin-top:12px;font-size:13px;color:var(--muted)">Из чего складывается: ' + split + '.<br>' + hint + '</div>';
    })()}

    <div style="margin-top:20px">
      <div class="stat-label" style="margin-bottom:8px">Типичные ошибки</div>
      ${subs.length ? `<div class="error-subtopics">${subs.map((x) => `<span class="chip chip--danger">${esc(x)}</span>`).join("")}</div>` : `<div style="font-size:13px;color:var(--muted)">Пока не выявлены — так держать.</div>`}
    </div>

    ${lessonErrs.length ? `
    <div style="margin-top:16px">
      <div class="stat-label" style="margin-bottom:8px">Сложные шаги в уроках</div>
      <div class="error-subtopics">${lessonErrs.map((e) => {
        const types = Object.keys(e.types || {});
        const label = humanLessonError(types.length ? types[0] : null);
        const times = e.count > 1 ? ` · ${e.count} ${plural(e.count, "раз", "раза", "раз")}` : "";
        return `<span class="chip chip--warn">${esc(label)}${times}</span>`;
      }).join("")}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Перепройди урок — верный ответ на этом шаге снимет отметку.</div>
    </div>` : ""}

    <div class="skill-modal__actions">
      ${lessons.length ? `<button class="btn btn--primary" onclick="closeModal();Lesson.start('${esc(lessons[0].id)}')">${icon("bulb")} ${Store.state.completedLessons && Store.state.completedLessons[lessons[0].id] ? "Повторить урок" : "Пройти урок"}</button>` : `<span class="stat-label">Для этой темы урок пока не добавлен.</span>`}
      ${mission ? `<button class="btn ${lessons.length ? "btn--soft" : "btn--primary"}" onclick="closeModal();startMission('${esc(mission.id)}')">${icon("target")} Практика</button>` : ""}
      ${!mission && asSafeArray(DataAPI.practiceTasksBySkill(skillId)).length ? `<button class="btn btn--ghost" onclick="closeModal();startSkillPractice('${esc(skillId)}')">Практика</button>` : ""}
      ${!mission && !asSafeArray(DataAPI.practiceTasksBySkill(skillId)).length ? `<span class="stat-label">Заданий в банке пока нет.</span>` : ""}
    </div>`, "Информация о теме");
}

/* Человеческая подпись ошибки шага урока для модалки темы.
   В каталоге ~100 технических errorType («Ошибка в вычислении…»,
   «Арифметическая ошибка…», «Забыли разделить на 3»…) — приводим их
   к виду «Ты ошибся …» там, где это грамматически безопасно, остальное
   показываем как есть (они уже простым языком). Название урока в чип
   не тянем: оно длинное и уже есть в кнопке «Пройти урок». */
function humanLessonError(raw) {
  const t = String(raw || "").trim();
  if (!t) return "Ты ошибся в учебном шаге";
  // \b с кириллицей в JS не работает (\w — только ASCII), поэтому граница — (?=\s).
  let m = t.match(/^Ошибка\s+(в|во|при|с|со|на|по|о|об)(?=\s)(.*)$/i);
  if (m) return `Ты ошибся ${m[1].toLowerCase()}${m[2]}`;
  m = t.match(/^(Арифметическая|Комплексная)\s+ошибка\s+(.*)$/i);
  if (m) return `Ты допустил ${/^комплексная/i.test(m[1]) ? "комплексную" : "арифметическую"} ошибку ${m[2]}`;
  return t;
}

/* Единая точка входа в практику по теме: набор заданий темы и есть миссия,
   поэтому идём через неё (прогресс, награда, продолжение с места остановки).
   Прямой запуск списком остаётся только как запасной вариант для тем без
   миссии. */
function startSkillPractice(skillId) {
  const skill = subjectSkillById(skillId);
  if (!skill) { go("path"); return; }
  if (topicIsLocked(skill)) return toast("Тема пока закрыта — урок и практика ещё не подключены", "", "lock");
  const mission = asSafeArray(DataAPI.missions()).find((m) => m && m.skill === skillId && missionPracticeIds(m).length);
  if (mission) return startMission(mission.id);
  const tasks = orderedTasks(DataAPI.practiceTasksBySkill(skillId)).map((t) => t.id);
  if (!tasks.length) return toast("В этой теме пока нет заданий для практики", "", "bulb");
  Session.start({ title: `Тренировка: ${topicDisplayName(skill)}`, taskIds: tasks, mode: "quick" });
}

/* ============================================================
   Screen: Тренировка (уроки + тренировки по темам)
   ============================================================ */

function screenTraining(root) {
  const state = subjectContentState();
  if (state.empty || state.locked) return screenSubjectUnavailable(root, state.locked, "training");
  const missions = asSafeArray(DataAPI.missions());
  const lessons = asSafeArray(DataAPI.lessons());
  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Тренировка ${helpDot("training")}</div>
      <div class="page-sub">Здесь проходит обучение: уроки разбирают тему с нуля по шагам, тренировки закрепляют её на заданиях ЕГЭ.</div>
    </div>

    ${lessons.length > 0 ? `
    <div class="section-title">Уроки — сначала разобраться</div>
    <div class="grid grid--3">
      ${lessons.map((lesson) => {
        const sk = DataAPI.skill(lesson.skill);
        const done = !!Store.state.completedLessons[lesson.id];
        const session = Store.state.lessonSessions && Store.state.lessonSessions[lesson.id];
        const inProgress = !!session;
        const stepsTotal = DataAPI.lessonStepsCount(lesson);
        const stepNow = inProgress && stepsTotal ? Math.min(((session.idx || 0)) + 1, stepsTotal) : 0;
        const progress = inProgress && stepsTotal ? Math.round(((session.idx || 0) / stepsTotal) * 100) : 0;
        const statusText = inProgress && !done
          ? 'в процессе · шаг ' + stepNow + ' из ' + stepsTotal
          : inProgress && done
            ? 'завершён · повтор: шаг ' + stepNow + ' из ' + stepsTotal
            : done ? 'завершён' : 'не начат';
        const btnLabel = inProgress
          ? 'Продолжить · шаг ' + stepNow + ' из ' + stepsTotal
          : done ? 'Пройти ещё раз' : 'Начать урок';
        return `
        <div class="card card--hover lesson-card ${done ? "lesson-card--done" : ""}">
          <div class="mission-card__top">
            <div>
              <div class="mission-card__title">${icon("bulb")} ${lesson.title} ${inProgress ? '<span class="chip chip--warn" style="margin-left:6px">в процессе</span>' : done ? '<span class="chip chip--success" style="margin-left:6px">✓</span>' : ""}</div>
              <div class="mission-card__path">${sk.name} · ${stepsTotal} шагов · ${statusText}</div>
            </div>
            <div class="mission-card__reward"><span class="chip chip--accent mono">+${lesson.xp} XP</span></div>
          </div>
          ${inProgress ? `<div class="mission-card__foot">
            <div class="mission-card__bar">${progressBar(progress)}</div>
            <span class="mono">${stepsTotal ? Math.min((session.idx || 0) + 1, stepsTotal) : ""} / ${stepsTotal}</span>
          </div>` : ''}
          <button class="btn ${inProgress || !done ? "btn--primary" : "btn--soft"} btn--sm" style="align-self:flex-start" onclick="Lesson.start('${lesson.id}')">
            ${btnLabel}
          </button>
        </div>`;
      }).join("")}
    </div>` : ''}

    <div class="section-title">Тренировки по темам — потом закрепить</div>
    <div class="grid grid--3">
      ${missions.map((m) => {
        const sk = DataAPI.skill(m.skill);
        const done = !!Store.state.missionsDone[m.id];
        const prog = missionProgress(m);
        // Состав тренировки — весь банк темы, а не тройка из каталога.
        const taskCount = missionPracticeIds(m).length;
        // Finished the task list without clearing the completion bar (see
        // sessionFinish): startMission() restarts it from scratch, so the
        // button should say so instead of a misleading "Продолжить".
        const exhausted = !done && taskCount > 0 && prog >= taskCount;
        const freeCount = sk ? DataAPI.practiceTasksBySkill(sk.id).length : 0;
        return `
        <div class="card card--hover mission-card ${done ? "mission-card--done" : ""}">
          <div class="mission-card__top">
            <div>
              <div class="mission-card__title">${m.title} ${done ? '<span class="chip chip--success" style="margin-left:6px">✓</span>' : ""}</div>
              <div class="mission-card__path">${sk ? sk.name : "Тема"} · ${esc(m.desc || "Закрепление темы на заданиях")}</div>
            </div>
            <div class="mission-card__reward"><span class="chip chip--accent mono">+${m.xp} XP</span></div>
          </div>
          <div>${stars(m.diff)}</div>
          ${taskCount ? `<div class="mission-card__foot">
            <div class="mission-card__bar">${progressBar((done ? taskCount : prog) / taskCount * 100, done ? "progress--success" : "")}</div>
            <span class="mono">${done ? taskCount : prog} / ${taskCount}</span>
          </div>` : `<div class="stat-label">Заданий для этого блока пока нет${freeCount ? ` · в теме доступно ${freeCount}` : ""}.</div>`}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${taskCount ? `<button class="btn ${done ? "btn--soft" : "btn--primary"} btn--sm" onclick="startMission('${m.id}')">
              ${done || exhausted ? "Пройти ещё раз" : prog > 0 ? "Продолжить" : "Начать тренировку"}
            </button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
    `;
}

function startMission(missionId) {
  const m = DataAPI.mission(missionId);
  if (!m) { go("training"); return; }
  const skill = subjectSkillById(m.skill);
  if (skill && topicIsLocked(skill)) return toast("Тема пока закрыта — практика ещё не подключена", "", "lock");
  // Тренировка идёт по всему банку темы (missionPracticeIds), а не по
  // урезанной тройке из каталога: количество заданий = реальные доступные.
  const allIds = missionPracticeIds(m);
  if (!allIds.length) return toast("В этой теме пока нет заданий для практики", "", "bulb");
  // A mission can reach the end of its task list without being marked done
  // (the completion bar wasn't met — see sessionFinish). Resuming "from"
  // that point would slice an empty task list, so treat it the same as a
  // fresh restart instead of silently handing Session.start nothing to do.
  const rawFrom = (Store.state.missionsDone[missionId] || missionProgress(m) >= allIds.length) ? 0 : missionProgress(m);
  const from = Math.min(Math.max(rawFrom, 0), Math.max(allIds.length - 1, 0));
  Session.start({
    title: `Миссия: ${m.title}`,
    taskIds: allIds.slice(from),
    mode: "mission",
    missionId,
    xpReward: m.xp,
    offset: from,
    total: allIds.length,
  });
}

/* ============================================================
   Session engine — экран решения заданий
   ============================================================ */

const Session = {
  cur: null,
  timerInt: null,

  start({ title, taskIds, mode, missionId = null, bossId = null, xpReward = 0, offset = 0, total = null, hideTopic = false, errorMap = null }) {
    if (!taskIds.length) { toast("Нет заданий для этой тренировки", "", "x"); return; }
    this.cur = {
      title, taskIds, mode, missionId, bossId, xpReward, offset,
      total: total || taskIds.length,
      hideTopic, errorMap,
      idx: 0,
      results: [],
      hintsUsed: 0,
      startTs: Date.now(),
      taskStartTs: Date.now(),
      answered: false,
      hintLevel: 0,
      attempts: 0,
      gainedXp: 0,
    };
    // Глубокий маршрут сессии: перезагрузка возвращает в ту же практику/босса.
    const r = mode === "mission" ? ["practice", missionId]
      : mode === "boss" ? ["boss", bossId]
      : mode === "daily" ? ["daily"]
      : mode === "errors" ? ["review"] : ["session"];
    go(r[0], r[1]);
    persistSession();
  },

  task() { return DataAPI.task(this.cur.taskIds[this.cur.idx]); },

  stopTimer() { if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; } },
};

/* Глубокие маршруты сессий: место внутри практики/босса/повторения
   переживает перезагрузку. Позиция дублируется в localStorage (мгновенно,
   без сервера); миссия дополнительно опирается на missionProgress. */
function persistSession() {
  try {
    const S = Session.cur;
    if (!S) { localStorage.removeItem("ege_core_session"); return; }
    localStorage.setItem("ege_core_session", JSON.stringify({
      title: S.title, taskIds: S.taskIds, mode: S.mode,
      missionId: S.missionId, bossId: S.bossId, xpReward: S.xpReward,
      offset: S.offset, total: S.total, idx: S.idx, errorMap: S.errorMap,
      essayDraftByTask: S.essayDraftByTask || {},
    }));
  } catch (_) {}
}

function sessionMatchesRoute(S, route, param) {
  if (!S) return false;
  if (route === "practice") return S.mode === "mission" && S.missionId === param;
  if (route === "boss") return S.mode === "boss" && S.bossId === param;
  if (route === "daily") return S.mode === "daily";
  if (route === "review") return S.mode === "errors";
  if (route === "session") return true;
  return false;
}

function restoreSessionFromStorage(route, param) {
  let d = null;
  try { d = JSON.parse(localStorage.getItem("ege_core_session") || "null"); } catch (_) { return false; }
  if (!d || !Array.isArray(d.taskIds) || !d.taskIds.length) return false;
  if (route !== "session" && !sessionMatchesRoute(d, route, param)) return false;
  const ids = d.taskIds.filter((id) => DataAPI.task(id));
  if (!ids.length) return false;
  Session.cur = {
    title: String(d.title || "Тренировка"), taskIds: ids, mode: d.mode,
    missionId: d.missionId || null, bossId: d.bossId || null, xpReward: d.xpReward || 0,
    offset: d.offset || 0, total: d.total || ids.length,
    hideTopic: d.mode === "boss", errorMap: d.errorMap || null,
    idx: Math.min(Math.max(d.idx || 0, 0), ids.length - 1),
    results: [], hintsUsed: 0, startTs: Date.now(), taskStartTs: Date.now(),
    answered: false, hintLevel: 0, attempts: 0, gainedXp: 0,
    essayDraftByTask: d.essayDraftByTask || {},
  };
  return true;
}

/* Чистый старт сессии для глубокого маршрута, когда восстанавливать
   нечего (первый заход или wiped storage). Зеркалит startMission/startBoss/
   startDaily/startErrorsReview, но без навигации — вызывающий render()
   уже находится на нужном адресе. */
function freshSessionForRoute(route, param) {
  if (route === "practice") {
    const m = DataAPI.mission(param);
    if (!m) return false;
    const allIds = missionPracticeIds(m);
    if (!allIds.length) return false;
    const rawFrom = (Store.state.missionsDone[param] || missionProgress(m) >= allIds.length) ? 0 : missionProgress(m);
    const from = Math.min(Math.max(rawFrom, 0), Math.max(allIds.length - 1, 0));
    Session.cur = {
      title: `Миссия: ${m.title}`, taskIds: allIds.slice(from), mode: "mission",
      missionId: param, bossId: null, xpReward: m.xp, offset: from, total: allIds.length,
      hideTopic: false, errorMap: null, idx: 0, results: [], hintsUsed: 0,
      startTs: Date.now(), taskStartTs: Date.now(), answered: false, hintLevel: 0, attempts: 0, gainedXp: 0,
    };
  } else if (route === "boss") {
    const boss = DataAPI.bosses().find((b) => b.id === param);
    if (!boss || !bossUnlocked(boss)) return false;
    const pool = DataAPI.practiceTasks().filter((t) => DataAPI.skill(t.skill).cat === boss.cat);
    Session.cur = {
      title: boss.title, taskIds: mixedSampleTaskIds(pool, boss.size), mode: "boss",
      missionId: null, bossId: boss.id, xpReward: 0, offset: 0, total: boss.size,
      hideTopic: true, errorMap: null, idx: 0, results: [], hintsUsed: 0,
      startTs: Date.now(), taskStartTs: Date.now(), answered: false, hintLevel: 0, attempts: 0, gainedXp: 0,
    };
    if (!Session.cur.taskIds.length) { Session.cur = null; return false; }
  } else if (route === "daily") {
    Session.cur = {
      title: "Ежедневная задача", taskIds: dailyTaskIds(), mode: "daily",
      missionId: null, bossId: null, xpReward: 0, offset: 0, total: null,
      hideTopic: false, errorMap: null, idx: 0, results: [], hintsUsed: 0,
      startTs: Date.now(), taskStartTs: Date.now(), answered: false, hintLevel: 0, attempts: 0, gainedXp: 0,
    };
    Session.cur.total = Session.cur.taskIds.length;
    if (!Session.cur.taskIds.length) { Session.cur = null; return false; }
  } else if (route === "review") {
    const q = buildErrorsReviewSession();
    if (!q) return false;
    Session.cur = {
      title: q.title, taskIds: q.taskIds, mode: "errors",
      missionId: null, bossId: null, xpReward: 0, offset: 0, total: q.taskIds.length,
      hideTopic: false, errorMap: q.errorMap, idx: 0, results: [], hintsUsed: 0,
      startTs: Date.now(), taskStartTs: Date.now(), answered: false, hintLevel: 0, attempts: 0, gainedXp: 0,
    };
  } else {
    return false;
  }
  persistSession();
  return true;
}

function screenSession(root) {
  const S = Session.cur;
  if (!S) { go("training"); return; }
  Session.stopTimer();
  S.answered = false;
  S.taskStartTs = Date.now();
  renderTask(root);
}

function renderTask(root) {
  const S = Session.cur;
  const t = Session.task();
  const progressDone = S.offset + S.idx;
  S.hintLevel = 0;
  S.attempts = 0;
  S.selfHintLevel = 0;

  root.innerHTML = `
    <div class="session-wrap">
      <div class="session-head">
        <div class="session-head__nav">
          ${sessionPrevButtonHtml()}
          <button class="btn btn--ghost btn--sm" onclick="askSessionQuit()">← Выйти</button>
        </div>
        <div class="session-head__title">${esc(S.title)}</div>
        <div class="session-head__progress mono">${progressDone + 1} / ${S.total}</div>
      </div>
      <div style="margin-bottom:18px">${progressBar((progressDone / S.total) * 100)}</div>

      <div class="card task-card">
        <div class="task-card__tags">
          <span class="chip chip--accent">${t.num}</span>
          ${S.hideTopic ? `<span class="chip">тема скрыта</span>` : `<span class="chip">${esc(t.sub)}</span>`}
          ${stars(t.diff)}
          <span class="chip timer-chip" style="margin-left:auto" id="timerChip">${icon("clock")} 00:00</span>
        </div>
        ${essaySourceHtml(t)}
        <div class="task-card__text">${mathText(t.text)}</div>
        ${taskVisualHtml(t)}
        <div id="sourceTextSlot"></div>

        <div id="hintSlot"></div>

        ${sessionAnswerAreaHtml(t, S)}
        <div id="feedbackSlot"></div>
      </div>
    </div>`;

  if (isLongTextTask(t)) {
    sessionEssayWire(t);
    essayRestoreReady(t);
    essaySourceTextLoad(t);
  } else if (t.selfCheck) {
    // Развёрнутые задания (№14–20) не проверяются автоматически: единый
    // текстовый ответ не отражает полноту доказательства и записи решения.
    // Ученик решает на бумаге, сверяется с официальным решением и честно
    // отмечает результат сам — так же, как реально проверяют часть 2 ЕГЭ.
  } else {
    const input = document.getElementById("answerInput");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sessionSubmit(); });
    renderSessionHintControl();
  }

  Session.timerInt = setInterval(() => {
    const chip = document.getElementById("timerChip");
    if (chip) chip.innerHTML = `${icon("clock")} ${fmtClock((Date.now() - S.taskStartTs) / 1000)}`;
  }, 1000);
}

/* ---------------- длинные текстовые ответы (итоговое сочинение) ----------------
   Редактор — часть Practice UI, а не отдельная страница: та же карточка,
   кнопки и обратная связь. Минимальный объём дублируется на сервере
   (POST /api/essays): клиентский счётчик — только для живой подсказки. */

function isLongTextTask(t) {
  return !!t && (t.type === "long_text" || t.answerType === "long_text");
}

/* ---------------- исходный текст к заданию 27 ----------------
   Задание 27 — работа С чужим текстом: ученик читает его и пишет по нему.
   Текст лежит на сервере (essay_source_texts) и подгружается на экран задания
   отдельным запросом, а не едет в каталоге: он большой и нужен только здесь.
   Разбор, позиция автора и примеры в нём отсутствуют намеренно — это ответ,
   который ученик формулирует сам. Проверку сервер ведёт по строгой рубрике
   (source), и выбирает её он же по заданию, а не клиент. */
const EssaySource = { cache: new Map() };

async function essaySourceTextFetch(id) {
  if (EssaySource.cache.has(id)) return EssaySource.cache.get(id);
  const res = await fetch(`/api/essay-text?subject=${encodeURIComponent(Store.subject)}&id=${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  const src = res.ok ? data.sourceText : null;
  if (src) EssaySource.cache.set(id, src);
  return src;
}

function essaySourceTextHtml(src) {
  const author = String(src.author || "").trim();
  const title = ["Исходный текст", author, `${src.wordCount} ${essayWordsLabel(src.wordCount)}`]
    .filter(Boolean).join(" · ");
  const paragraphs = String(src.text || "").split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim())}</p>`).join("");
  return `
    <div class="source-text source-text--collapsed" id="sourceTextBox">
      <button class="source-text__bar" type="button" onclick="essaySourceToggle()" aria-expanded="false">
        <span class="source-text__title">${esc(title)}</span>
        <span class="source-text__toggle" data-source-toggle-label>Читать</span>
      </button>
      <div class="source-text__content" data-source-body>
        <div class="source-text__body">${paragraphs}</div>
      </div>
    </div>`;
}

function essaySourceToggle() {
  const box = document.getElementById("sourceTextBox");
  const body = document.querySelector("[data-source-body]");
  const label = document.querySelector("[data-source-toggle-label]");
  const bar = box ? box.querySelector(".source-text__bar") : null;
  if (!box || !body) return;
  const collapsed = box.classList.toggle("source-text--collapsed");
  if (label) label.textContent = collapsed ? "Читать" : "Скрыть";
  if (bar) bar.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

async function essaySourceTextLoad(t) {
  const id = t && t.sourceTextId;
  const slot = document.getElementById("sourceTextSlot");
  if (!id || !slot) return;
  if (!Session.sourceTexts) Session.sourceTexts = {};
  const cached = Session.sourceTexts[id];
  if (cached) { slot.innerHTML = essaySourceTextHtml(cached); return; }
  slot.innerHTML = `<div class="source-text source-text--loading" role="status">Открываем текст для чтения…</div>`;
  try {
    const src = await essaySourceTextFetch(id);
    if (!src) {
      slot.innerHTML = `<div class="source-text source-text--loading">Текст к этому заданию временно недоступен. Написать сочинение по проблеме всё равно можно.</div>`;
      return;
    }
    Session.sourceTexts[id] = src;
    const live = document.getElementById("sourceTextSlot");
    if (live) live.innerHTML = essaySourceTextHtml(src);
  } catch (_) {
    const live = document.getElementById("sourceTextSlot");
    if (live) live.innerHTML = `<div class="source-text source-text--loading">Текст к этому заданию не загрузился. Обнови страницу или напиши сочинение по проблеме из задания.</div>`;
  }
}

function essayWordsLabel(n) {
  const mod100 = n % 100, mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "слов";
  if (mod10 === 1) return "слово";
  if (mod10 >= 2 && mod10 <= 4) return "слова";
  return "слов";
}

/* Исходный текст для сочинения: отдельный блок сверху темы.
   Поле source сегодня — короткая provenance-подпись («Демоверсия…»),
   поэтому как связный отрывок воспринимаем только длинный текст:
   явные sourceText/source_text/passage — всегда, а source — только если
   это реально отрывок (много слов), а не подпись. Короткая подпись блок
   не создаёт, и текущие 6 тем выглядят как раньше. */
function essaySourceText(t) {
  if (!isLongTextTask(t) || !t || typeof t !== "object") return "";
  const explicit = t.sourceText ?? t.source_text ?? t.passage ?? t.readingText ?? t.reading_text ?? "";
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const src = typeof t.source === "string" ? t.source.trim() : "";
  if (!src) return "";
  try {
    if (typeof countWords === "function" && countWords(src) < 20 && src.length < 300) return "";
  } catch (_) {
    if (src.length < 300) return "";
  }
  return src;
}

function essaySourcePreview(text, limit = 10) {
  const words = String(text == null ? "" : text).split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(" ");
  return words.slice(0, limit).join(" ");
}

function essaySourceHtml(t) {
  const src = essaySourceText(t);
  if (!src) return "";
  const words = String(src).split(/\s+/).filter(Boolean);
  const collapsible = words.length > 10;
  const preview = esc(essaySourcePreview(src, 10)) + (collapsible ? "…" : "");
  if (!collapsible) {
    return `
      <div class="essay-source" id="essaySource">
        <div class="essay-source__label">Исходный текст</div>
        <div class="essay-source__body">${esc(src)}</div>
      </div>`;
  }
  return `
    <div class="essay-source" id="essaySource">
      <div class="essay-source__label">Исходный текст</div>
      <div class="essay-source__preview" data-essay-source-preview>${preview}</div>
      <div class="essay-source__body" data-essay-source-full style="display:none">${esc(src)}</div>
      <button class="btn btn--ghost btn--sm essay-source__toggle" type="button" onclick="toggleEssaySource(this)">Показать полностью</button>
    </div>`;
}

function toggleEssaySource(btn) {
  try {
    const box = btn && btn.closest ? btn.closest(".essay-source") : null;
    if (!box) return;
    const full = box.querySelector("[data-essay-source-full]");
    const preview = box.querySelector("[data-essay-source-preview]");
    if (!full) return;
    const open = full.style.display !== "none";
    full.style.display = open ? "none" : "";
    if (preview) preview.style.display = open ? "" : "none";
    btn.textContent = open ? "Показать полностью" : "Скрыть";
  } catch (_) {}
}

/* Во время проверки редактор скрыт — виден только единый лоадер.
   После готового результата редактор заменяется readonly-блоком:
   исходный текст ученика виден, но менять его уже нельзя. */
function essaySetFormVisible(visible) {
  const display = visible ? "" : "none";
  const editor = document.getElementById("essayEditor");
  if (editor) editor.style.display = display;
  const errBox = document.getElementById("essayError");
  if (errBox && !visible) errBox.style.display = "none";
  const card = document.querySelector ? document.querySelector(".task-card") : null;
  if (card && card.querySelectorAll) {
    card.querySelectorAll(".session-tools, .essay-editor__submit").forEach((el) => {
      el.style.display = display;
    });
  } else {
    const submitWrap = document.querySelector ? document.querySelector(".essay-editor__submit") : null;
    if (submitWrap) submitWrap.style.display = display;
  }
}

function essayReadonlyHtml(text, wordCount) {
  const n = Number(wordCount);
  const countLine = Number.isFinite(n) && n > 0 ? `${n} ${essayWordsLabel(n)}` : "";
  return `
    <div class="essay-readonly" id="essayReadonly">
      <div class="essay-readonly__label">Твоё сочинение ${countLine ? `<span class="mono">· ${esc(countLine)}</span>` : ""}</div>
      <div class="essay-readonly__body">${esc(String(text == null ? "" : text))}</div>
      <div class="essay-readonly__note">Текст уже отправлен на проверку и больше не редактируется.</div>
    </div>`;
}

function essayMountReadonly(text, wordCount) {
  const slot = document.getElementById("essayReadonlySlot");
  if (!slot) return;
  slot.innerHTML = essayReadonlyHtml(text, wordCount);
}

function essayClearReadonly() {
  const slot = document.getElementById("essayReadonlySlot");
  if (slot) slot.innerHTML = "";
  const legacy = document.getElementById("essayReadonly");
  if (legacy && (!slot || !slot.contains(legacy))) legacy.remove();
}

function sessionAnswerAreaHtml(t, S) {
  if (isLongTextTask(t)) return `
    <div id="essayReadonlySlot"></div>
    <div class="essay-editor" id="essayEditor">
      <textarea class="essay-editor__area" id="essayInput" spellcheck="false"
        placeholder="${t.sourceTextId ? "Пиши сочинение здесь: сформулируй позицию автора исходного текста, прокомментируй её двумя примерами из него и обоснуй своё отношение…" : "Пиши сочинение здесь: сформулируй позицию по теме, подкрепи её аргументами и сделай вывод…"}"></textarea>
      <div class="essay-editor__foot">
        <span class="essay-editor__count mono" id="essayCount"></span>
        <span class="essay-editor__bar"><span class="essay-editor__bar-fill" id="essayBar"></span></span>
      </div>
    </div>
    <div class="essay-editor__error" id="essayError" style="display:none"></div>
    <div class="session-tools">
      <span id="hintControl"></span>
      <button class="btn btn--ghost btn--sm" onclick="sessionSkip()">Пропустить →</button>
      <span id="xpNote" style="margin-left:auto;font-size:12px;color:var(--muted)">за проверенное сочинение: 100–500 XP по баллам</span>
    </div>
    <div class="essay-editor__submit">
      <button class="btn btn--primary" id="essaySubmitBtn" disabled onclick="sessionEssaySubmit()">Отправить сочинение</button>
    </div>`;
  if (t.selfCheck) return sessionSelfCheckAreaHtml(t);
  return `
    <div class="answer-row">
      <input class="answer-input" id="answerInput" placeholder="Ответ" autocomplete="off" inputmode="${answerInputMode(t.answer)}">
      <button class="btn btn--primary" id="submitBtn" onclick="sessionSubmit()">Ответить</button>
    </div>
    ${answerFormatCaption(t.answer, t.valueType)}
    <div class="session-tools">
      <span id="hintControl"></span>
      <button class="btn btn--ghost btn--sm" onclick="sessionSkip()">Пропустить →</button>
      <span id="xpNote" style="margin-left:auto;font-size:12px;color:var(--muted)">верный ответ: +${attemptXp(t, true, 0, false).total} XP · попытка: +${attemptXp(t, false, 0, false).total} XP</span>
    </div>`;
}

/* Черновик живёт в состоянии сессии (и дублируется в localStorage через
   persistSession), поэтому перерисовка экрана — подсказка, выход из модалки —
   не стирает текст. Ключ — id задания: в сессии может быть несколько тем. */
function sessionEssayWire(t) {
  const S = Session.cur;
  const input = document.getElementById("essayInput");
  if (!input) return;
  if (!S.essayDraftByTask) S.essayDraftByTask = {};
  input.value = S.essayDraftByTask[t.id] || "";
  const countEl = document.getElementById("essayCount");
  const barEl = document.getElementById("essayBar");
  const btn = document.getElementById("essaySubmitBtn");
  const editor = document.getElementById("essayEditor");
  const update = () => {
    S.essayDraftByTask[t.id] = input.value;
    const n = countWords(input.value);
    if (n < ESSAY_MIN_WORDS) {
      countEl.textContent = `${n} / ${ESSAY_MIN_WORDS} ${essayWordsLabel(ESSAY_MIN_WORDS)} · ещё ${ESSAY_MIN_WORDS - n}`;
      countEl.classList.remove("essay-editor__count--ok");
      editor.classList.remove("essay-editor--ready");
      btn.disabled = true;
    } else {
      countEl.textContent = `${n} ${essayWordsLabel(n)} · минимум выполнен`;
      countEl.classList.add("essay-editor__count--ok");
      editor.classList.add("essay-editor--ready");
      btn.disabled = false;
    }
    barEl.style.width = `${Math.min(100, (n / ESSAY_MIN_WORDS) * 100)}%`;
  };
  input.addEventListener("input", update);
  update();
  renderSessionHintControl();
}

/* Pipeline проверки итогового сочинения:
   submission (POST /api/essays) → AI check (POST /api/ai/essay: модель К1–К6
   + детерминированная грамотность К7–К10, параллельно внутри ai.py) →
   report generation (POST /api/essays/evaluation → evaluation_status='ready')
   → result ready (кнопка «Посмотреть результат →») → и только тогда XP
   через существующий recordAnswer/attempts-flow. До 'ready' XP нет, иначе
   получился бы «AI ещё работает → XP уже выдан». */

const ESSAY_CHECK_MSGS = [
  "Подсчитываю баллы…",
  "Проверяю сочинение…",
  "Анализирую критерии…",
  "Собираю результат…",
  "Готовлю отчёт…",
];

function essayCheckMsgStart(scopeId) {
  essayCheckMsgStop();
  let k = 0;
  Session.essayCheckTimer = setInterval(() => {
    k = (k + 1) % ESSAY_CHECK_MSGS.length;
    const scope = scopeId ? document.getElementById(scopeId) : document;
    const el = scope ? scope.querySelector("[data-loader-sub]") : null;
    if (el) el.textContent = ESSAY_CHECK_MSGS[k];
    else essayCheckMsgStop();
  }, 1600);
}

function essayCheckMsgStop() {
  if (Session.essayCheckTimer) { clearInterval(Session.essayCheckTimer); Session.essayCheckTimer = null; }
}

function essayAiErrorText(status, data) {
  if (status === 429) return "Слишком много проверок. Подожди немного и попробуй снова.";
  if (status === 503) return "Проверка временно недоступна. Текст сохранён — попробуй снова чуть позже.";
  if (status === 502) return "Проверка не удалась. Текст сохранён — попробуй снова.";
  if (data && data.error) return data.error;
  return "Не удалось проверить сочинение. Текст сохранён — попробуй снова.";
}

/* Отчёт — это ege-result.html (единый шаблон результата): данные подставляет
   сервер (GET /api/essays → submission.view через essay_result_view), здесь
   только ссылка на точный submission. Никакого inline-рендера отчёта —
   параллельной системы нет. */
function essayResultUrl(submission) {
  if (!submission) return "";
  const subject = Store.subject || "russian";
  // Короткая ссылка — числовой sid (~50 символов). Перебор чужого не
  // работает: сервер отдаёт submission только его автору, остальным 404.
  // Старые clientId/taskId-ссылки продолжают работать (fallback ниже).
  if (submission.submissionId) {
    return `/essay/${submission.submissionId}`;
  }
  if (submission.clientId) {
    return `/ege-result.html?subject=${encodeURIComponent(subject)}&clientId=${encodeURIComponent(submission.clientId)}`;
  }
  return `/ege-result.html?subject=${encodeURIComponent(subject)}&taskId=${encodeURIComponent(submission.taskId || "")}`;
}

function openEssayResult(taskId) {
  const S = Session.cur;
  const submission = S && S.essayReadyByTask && S.essayReadyByTask[taskId];
  const url = essayResultUrl(submission);
  if (url) location.href = url;
}

/* Полный экран на время проверки заменяется единым лоадером (как на boot),
   поэтому на выходе из pipeline экран восстанавливается через renderTask.
   Асинхронный essayRestoreReady внутри renderTask не должен перетирать
   готовый feedback блоком «Проверка не завершена» — его пропускают на одну
   такую перерисовку (флаг читается синхронно, до первого await). */
let essayRestoreSuppress = false;

/* Повторное открытие: готовый результат переживает перезагрузку — лежит в
   essay_submissions (evaluation_status='ready'), а не во frontend-state.
   XP при просмотре НЕ начисляем: он уже зафиксирован attempts-flow.
   Готовый текст показываем readonly-блоком без лоадера: ученик видит
   свой исходный текст, но менять его уже нельзя. */
async function essayRestoreReady(t) {
  if (essayRestoreSuppress) return;
  try {
    const res = await fetch(`/api/essays?subject=${encodeURIComponent(Store.subject)}&taskId=${encodeURIComponent(t.id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.submission) return;
    const sub = data.submission;
    const slot = document.getElementById("feedbackSlot");
    if (!slot || !Session.cur || Session.cur.answered) return;
    if (!Session.cur || Session.task().id !== t.id) return;
    if (sub.status === "ready" && sub.result) {
      if (!Session.cur.essayReadyByTask) Session.cur.essayReadyByTask = {};
      Session.cur.essayReadyByTask[t.id] = sub;
      essaySetFormVisible(false);
      essayMountReadonly(sub.text || "", sub.wordCount);
      slot.innerHTML = `
        <div class="feedback feedback--ok">
          <div class="feedback__head">${icon("check")} Это сочинение уже проверено
            <span class="feedback__xp">${esc(sub.result.total_score)} / ${esc(sub.result.max_score)}</span></div>
          <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn--primary" onclick="openEssayResult('${esc(t.id)}')">Посмотреть результат →</button>
          </div>
          ${sessionNextHtml()}
        </div>`;
    } else if (sub.status === "submitted" || sub.status === "failed") {
      if (!Session.cur.essayReadyByTask) Session.cur.essayReadyByTask = {};
      Session.cur.essayReadyByTask[t.id] = sub;
      essayClearReadonly();
      essaySetFormVisible(true);
      try {
        const input = document.getElementById("essayInput");
        if (input && !String(input.value || "").trim() && sub.text) {
          input.value = sub.text;
          if (Session.cur) {
            if (!Session.cur.essayDraftByTask) Session.cur.essayDraftByTask = {};
            Session.cur.essayDraftByTask[t.id] = sub.text;
          }
          const n = countWords(sub.text);
          const countEl = document.getElementById("essayCount");
          const barEl = document.getElementById("essayBar");
          const btn = document.getElementById("essaySubmitBtn");
          const editor = document.getElementById("essayEditor");
          if (countEl) {
            if (n < ESSAY_MIN_WORDS) {
              countEl.textContent = `${n} / ${ESSAY_MIN_WORDS} ${essayWordsLabel(ESSAY_MIN_WORDS)} · ещё ${ESSAY_MIN_WORDS - n}`;
              countEl.classList.remove("essay-editor__count--ok");
              if (editor) editor.classList.remove("essay-editor--ready");
              if (btn) btn.disabled = true;
            } else {
              countEl.textContent = `${n} ${essayWordsLabel(n)} · минимум выполнен`;
              countEl.classList.add("essay-editor__count--ok");
              if (editor) editor.classList.add("essay-editor--ready");
              if (btn && !input.disabled) btn.disabled = false;
            }
          }
          if (barEl) barEl.style.width = `${Math.min(100, (n / ESSAY_MIN_WORDS) * 100)}%`;
        }
      } catch (_) {}
      slot.innerHTML = `
        <div class="feedback">
          <div class="feedback__head">${icon("clock")} Проверка не завершена</div>
          <div class="feedback__solution">Текст сохранён (${sub.wordCount} ${essayWordsLabel(sub.wordCount)}), но готового результата нет. Можно продолжить проверку без повторного ввода.</div>
          <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn--primary" onclick="sessionEssayResume('${esc(t.id)}')">Продолжить проверку</button>
          </div>
          ${sessionNextHtml()}
        </div>`;
    }
  } catch (_) { /* офлайн/ошибка — редактор остаётся рабочим */ }
}

/* Шаг назад по сессии — зеркало sessionNext. Готовый результат прошлого
   задания никуда не делся: при отрисовке снова покажется его отчёт.
   На первом задании возвращаться некуда, поэтому кнопки нет (тот же
   принцип, что у уроков и онбординга) — вместо неё пустое место, чтобы
   «Далее» оставалась на своём месте. */
function sessionPrev() {
  const S = Session.cur;
  if (!S || S.idx <= 0) return;
  S.idx--;
  S.answered = false;
  S.taskStartTs = Date.now();
  // Ответы и XP уже зафиксированы в recordAnswer — назад мы только
  // перерисовываем карточку, прогресс не пересчитывается.
  persistSession();
  renderTask(document.getElementById("screen"));
}

function sessionHasPrev() {
  const S = Session.cur;
  return !!S && S.idx > 0;
}

function sessionHasNext() {
  const S = Session.cur;
  return !!S && S.idx + 1 < S.taskIds.length;
}

/* Единая навигация сессии. «Назад» живёт в шапке карточки (renderTask), а не
   в блоке результата: так он виден в любом состоянии — ученик пишет, идёт
   проверка, отчёт готов — и не зависит от того, докручен ли экран вниз.
   Раньше essay-экраны собирали «Назад» вручную в трёх местах и по разным
   правилам: в «проверка завершена» ряд стоял отдельной строкой ПОД зелёным
   блоком и уезжал за нижнюю кромку экрана (кнопки «Назад» просто не было
   видно), в ветках «проверка не удалась» / «проверка не завершена» его не
   было вовсе, а на первом задании он то показывался, то нет. */
function sessionPrevButtonHtml() {
  if (!sessionHasPrev()) return "";
  return `<button class="btn btn--ghost btn--sm" onclick="sessionPrev()">← Назад</button>`;
}

/* Подпись основной кнопки сессии — ровно как у обычных заданий.
   Раньше у сочинений стояло «Написать ещё раз», но кнопка никогда ничего не
   переписывала: sessionNext() всегда ведёт на СЛЕДУЮЩЕЕ задание. Особенно
   сбивало после шага «Назад» — там «Написать ещё раз» возвращала к уже
   проверенному сочинению, а не к новому тексту. Теперь одна формулировка
   на все состояния ответа (проверено / проверка не завершена / проверка не
   удалась) и на все предметы. */
function sessionNextLabel() {
  return sessionHasNext() ? "Далее →" : "Завершить";
}

/* Ряд «вперёд» под результатом — тот же, что у обычных заданий. «Назад» здесь
   не дублируется: он в шапке (sessionPrevButtonHtml). */
function sessionNextHtml() {
  return `<div class="session-nav"><span></span><button class="btn btn--primary" onclick="sessionNext()">${esc(sessionNextLabel())}</button></div>`;
}

/* Продолжить проверку сохранённого текста после перезагрузки: новый
   submission не создаём, текст берём с сервера (он не потерялся). */
async function sessionEssayResume(taskId) {
  const S = Session.cur;
  if (!S || S.answered) return;
  const t = Session.task();
  if (!t || t.id !== taskId) return;
  const saved = S.essayReadyByTask && S.essayReadyByTask[taskId];
  if (!saved || !saved.text) return;
  await essayRunChecks(t, saved.text, saved.clientId, saved.wordCount);
}

/* Общая фаза «AI check → report generation → result ready → XP».
   Вызывается и после свежей отправки, и при «Продолжить проверку».
   На время проверки весь экран заменяется единым лоадером сайта (как на
   boot): видны только шапка, лоадер по центру и футер — карточка задания,
   исходный текст и само сочинение исчезают. */
async function essayRunChecks(t, text, clientId, wordCount) {
  const S = Session.cur;
  if (!S || S.answered) return;
  const screen = document.getElementById("screen");
  essayClearReadonly();
  essayCheckMsgStop();
  screen.innerHTML = loaderHTML(ESSAY_CHECK_MSGS[0]);
  essayCheckMsgStart();
  const seconds = Math.max(0, (Date.now() - S.taskStartTs) / 1000);

  let aiRes = null, aiData = {};
  try {
    aiRes = await fetch("/api/ai/essay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // taskId нужен серверу, чтобы выбрать рубрику: у заданий с исходным
      // текстом строгая (позиция автора + два примера ИЗ текста), у свободных
      // тем — «тезис + аргументы». Сам текст исходника уходит один раз, при
      // загрузке экрана, и в проверку не дублируется.
      body: JSON.stringify({ text, taskId: t.id }),
    });
    aiData = await aiRes.json().catch(() => ({}));
  } catch (_) { aiRes = null; }
  if (!aiRes || !aiRes.ok || !aiData.result) {
    try {
      await fetch("/api/essays/evaluation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: Store.subject, clientId, status: "failed" }),
      });
    } catch (_) { /* статус и так остался не-ready — XP не будет */ }
    essayCheckMsgStop();
    // Возвращаем экран задания (черновик цел в сессии) и показываем ошибку.
    essayRestoreSuppress = true;
    renderTask(screen);
    essayRestoreSuppress = false;
    const slot = document.getElementById("feedbackSlot");
    slot.innerHTML = `
      <div class="feedback feedback--bad">
        <div class="feedback__head">${icon("x")} Проверка не удалась</div>
        <div class="feedback__solution">${esc(essayAiErrorText(aiRes ? aiRes.status : 0, aiData))}</div>
        <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn--primary" onclick="sessionEssayResume('${esc(t.id)}')">Попробовать снова</button>
        </div>
        ${sessionNextHtml()}
      </div>`;
    return;
  }

  // Report generation: фиксируем готовый отчёт в том же submission.
  let savedRes = null, savedData = {};
  try {
    savedRes = await fetch("/api/essays/evaluation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: Store.subject, clientId, status: "ready", result: aiData.result }),
    });
    savedData = await savedRes.json().catch(() => ({}));
  } catch (_) { savedRes = null; }
  if (!savedRes || !savedRes.ok || !savedData.submission) {
    essayCheckMsgStop();
    essayRestoreSuppress = true;
    renderTask(screen);
    essayRestoreSuppress = false;
    document.getElementById("feedbackSlot").innerHTML = `
      <div class="feedback feedback--bad">
        <div class="feedback__head">${icon("x")} Отчёт не сформирован</div>
        <div class="feedback__solution">Проверка прошла, но результат не сохранился. Текст не потерян — попробуй снова, XP начислен не будет до готового отчёта.</div>
        <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn--primary" onclick="sessionEssayResume('${esc(t.id)}')">Попробовать снова</button>
        </div>
        ${sessionNextHtml()}
      </div>`;
    return;
  }
  const submission = savedData.submission;

  // Только теперь — существующий механизм фиксации результата/XP/прогресса.
  // Балл проверки известен лишь в этой точке («результат готов»): отдаём его
  // в recordAnswer, где он конвертируется в XP по шкале essayXp. Повтор того
  // же задания сверх защиты alreadyMastered ничего не доплачивает.
  const closesTaskId = S.errorMap ? S.errorMap[t.id] : undefined;
  const essayScore = submission && submission.result ? Number(submission.result.total_score) : NaN;
  const xp = recordAnswer(t, true, 0, seconds, closesTaskId, 0, essayScore);
  S.gainedXp += xp;
  S.attemptXpSum = (S.attemptXpSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.attempt : 0);
  S.correctBonusSum = (S.correctBonusSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.correctBonus : 0);
  S.errorResolvedSum = (S.errorResolvedSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.errorResolved : 0);
  S.results.push({ taskId: t.id, correct: true, skipped: false, seconds, hint: 0, essay: true, wordCount, submissionId: submission.submissionId });
  S.answered = true;
  if (S.essayDraftByTask) delete S.essayDraftByTask[t.id];
  if (!S.essayReadyByTask) S.essayReadyByTask = {};
  S.essayReadyByTask[t.id] = submission;
  // Возвращаем экран задания: редактор прячем и показываем исходный текст
  // readonly — менять его после отправки уже нельзя. Таймер останавливаем
  // ПОСЛЕ перерисовки: renderTask сам запускает свой интервал таймера.
  essayRestoreSuppress = true;
  renderTask(screen);
  essayRestoreSuppress = false;
  Session.stopTimer();
  essaySetFormVisible(false);
  essayMountReadonly(text, wordCount);
  const input = document.getElementById("essayInput");
  if (input) input.disabled = true;
  const submitBtn = document.getElementById("essaySubmitBtn");
  if (submitBtn) submitBtn.style.display = "none";

  essayCheckMsgStop();
  renderTopbar();
  // Кнопка отчёта и навигация — внутри одного зелёного блока, тем же рядом,
  // что «Далее» в остальных предметах. Раньше ряд с «Назад» стоял отдельной
  // строкой ПОД блоком и оказывался за нижней кромкой экрана: на длинном
  // сочинении (плюс readonly-текст) кнопки «Назад» просто не было видно.
  const slot = document.getElementById("feedbackSlot");
  slot.innerHTML = `
    <div class="feedback feedback--ok">
      <div class="feedback__head">${icon("check")} Проверка завершена
        <span class="feedback__xp">${esc(submission.result.total_score)} / ${esc(submission.result.max_score)} · +${xp} XP</span></div>
      <div class="feedback__solution">Отчёт готов: AI-проверка содержания и автоматическая проверка грамотности завершены, баллы подсчитаны.</div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn btn--primary" onclick="openEssayResult('${esc(t.id)}')">Посмотреть результат →</button>
      </div>
      ${sessionNextHtml()}
    </div>`;
  const doneBox = slot.querySelector(".feedback--ok");
  if (doneBox && doneBox.scrollIntoView) {
    try { doneBox.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
  }
}

async function sessionEssaySubmit() {
  const S = Session.cur;
  if (!S || S.answered) return;
  const t = Session.task();
  const input = document.getElementById("essayInput");
  const text = (input.value || "").trim();
  if (countWords(text) < ESSAY_MIN_WORDS) return;
  // Клик по «Отправить» сразу убирает всё с экрана: единый loading сайта
  // на весь экран (шапка, лоадер по центру, футер) — ровно как при загрузке
  // страницы. Черновик уже в сессии (essayDraftByTask), перерисовка его
  // не теряет. Шаг 1 — сохранить submission как обычно. Проверка НЕ
  // завершена, XP НЕ начисляем: дальше pipeline, а не feedback с баллами.
  essayCheckMsgStop();
  document.getElementById("screen").innerHTML = loaderHTML(ESSAY_CHECK_MSGS[0]);
  essayCheckMsgStart();
  let data = null, ok = false;
  try {
    const res = await fetch("/api/essays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: Store.subject, taskId: t.id, skill: t.skill, text, id: newEntityId() }),
    });
    data = await res.json().catch(() => ({}));
    ok = res.ok && !!data.ok;
  } catch (_) {
    data = {};
  }
  if (!ok) {
    essayCheckMsgStop();
    // Возвращаем редактор с сохранённым черновиком и показываем ошибку.
    essayRestoreSuppress = true;
    renderTask(document.getElementById("screen"));
    essayRestoreSuppress = false;
    const errBox = document.getElementById("essayError");
    errBox.style.display = "";
    errBox.textContent = data && data.minWords
      ? `Сервер посчитал ${data.wordCount} ${essayWordsLabel(data.wordCount)} — минимум ${data.minWords}. Допиши текст и отправь снова.`
      : (data && data.error) || "Не удалось отправить сочинение. Проверь соединение и попробуй ещё раз.";
    return;
  }
  if (!S.essayReadyByTask) S.essayReadyByTask = {};
  S.essayReadyByTask[t.id] = { taskId: t.id, clientId: data.clientId, text, wordCount: data.wordCount, status: "submitted" };
  // Шаги 2–5 — проверки, отчёт, кнопка, и только потом XP (внутри).
  await essayRunChecks(t, text, data.clientId, data.wordCount);
}

/* ---------------- задания части 2: самопроверка вместо авто-проверки ---------------- */

function sessionSelfCheckAreaHtml() {
  return `
    <div class="session-tools">
      <button class="btn btn--ghost btn--sm" id="selfHintBtn" onclick="sessionSelfHint()">${icon("bulb")} Подсказка 1</button>
      <button class="btn btn--ghost btn--sm" onclick="sessionSkip()">Пропустить →</button>
      <span style="margin-left:auto;font-size:12px;color:var(--muted)">развёрнутый ответ — реши на бумаге и сверься</span>
    </div>
    <div style="margin-top:10px">
      <button class="btn btn--primary" id="selfRevealBtn" onclick="sessionSelfReveal()">Сверить с решением</button>
    </div>`;
}

function sessionSelfHint() {
  const S = Session.cur;
  const t = Session.task();
  if (S.answered) return;
  if (S.selfHintLevel >= 3) return;
  S.selfHintLevel++;
  const slot = document.getElementById("hintSlot");
  const levels = hintLevelsFor(t);
  slot.innerHTML = levels.slice(0, S.selfHintLevel).map((h, i) => `
    <div class="hint-box ${i > 0 ? "hint-box--deep" : ""}">${icon("bulb")} <b>Подсказка ${i + 1}.</b> ${mathText(h)}</div>`).join("");
  const btn = document.getElementById("selfHintBtn");
  if (btn) {
    if (S.selfHintLevel >= 3) { btn.disabled = true; btn.textContent = "Все подсказки открыты"; }
    else btn.innerHTML = `${icon("bulb")} Подсказка ${S.selfHintLevel + 1}`;
  }
}

function sessionSelfReveal() {
  const S = Session.cur;
  const t = Session.task();
  if (S.answered) return;
  const btn = document.getElementById("selfRevealBtn");
  if (btn) btn.remove();
  document.getElementById("feedbackSlot").innerHTML = `
    <div class="feedback">
      <div class="feedback__solution"><b>Официальное решение.</b>\n${mathText(t.solution)}</div>
      <div class="feedback__solution" style="margin-top:10px"><b>Ответ.</b> ${mathText(t.answer)}</div>
      <div style="margin-top:14px;color:var(--text-2);font-size:13px">Сравни со своим решением на бумаге и честно отметь результат — это и есть проверка части 2.</div>
      <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn--danger-soft" onclick="sessionSelfResult(false)">Не получилось</button>
        <button class="btn btn--primary" onclick="sessionSelfResult(true)">Решил(а) верно</button>
      </div>
    </div>`;
}

function sessionSelfResult(correct) {
  const S = Session.cur;
  const t = Session.task();
  if (S.answered) return;
  const seconds = (Date.now() - S.taskStartTs) / 1000;
  const hintLevel = S.selfHintLevel || 0;
  const closesTaskId = S.errorMap ? S.errorMap[t.id] : undefined;
  const xp = recordAnswer(t, correct, hintLevel, seconds, closesTaskId, S.attempts || 0);
  S.gainedXp += xp;
  S.attemptXpSum = (S.attemptXpSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.attempt : 0);
  S.correctBonusSum = (S.correctBonusSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.correctBonus : 0);
  S.errorResolvedSum = (S.errorResolvedSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.errorResolved : 0);
  S.results.push({ taskId: t.id, correct, skipped: false, seconds, hint: hintLevel });
  S.answered = true;
  Session.stopTimer();

  document.getElementById("feedbackSlot").innerHTML = `
    <div class="feedback ${correct ? "feedback--ok" : "feedback--bad"}">
      <div class="feedback__head">
        ${icon(correct ? "check" : "x")} ${correct ? "Отмечено как решено" : "Отмечено для повторения"}
        ${correct ? `<span class="feedback__xp">+${xp} XP</span>` : ""}
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn btn--primary" onclick="sessionNext()">${sessionNextLabel()}</button>
      </div>
    </div>`;
  renderTopbar();
}

/* Уровни помощи считаются от ошибок, а не от уже открытых подсказок:
   0 ошибок — доступна подсказка 1; 1-я ошибка открывает подсказку 2;
   2-я — подсказку 3; 3-я — «Показать решение». */
function sessionAvailableHelp() {
  const S = Session.cur;
  if (!S) return null;
  const maxLevel = Math.min(3, S.attempts + 1);
  if (S.hintLevel < maxLevel) return { type: "hint", level: S.hintLevel + 1 };
  return S.attempts >= 3 ? { type: "solution" } : null;
}

function renderSessionHintControl() {
  const control = document.getElementById("hintControl");
  if (!control) return;
  const help = sessionAvailableHelp();
  control.innerHTML = !help ? "" : `<button class="btn btn--ghost btn--sm" id="hintBtn" onclick="sessionHint()">${icon("bulb")} ${help.type === "solution" ? "Показать решение" : `Подсказка ${help.level}`}</button>`;
}

function sessionHint() {
  const S = Session.cur;
  const t = Session.task();
  if (S.answered) return;
  const help = sessionAvailableHelp();
  if (!help) return;
  if (help.type === "solution") return sessionShowAnswer();

  S.hintLevel = help.level;
  S.hintsUsed++;
  const slot = document.getElementById("hintSlot");
  const levels = hintLevelsFor(t);
  const level = S.hintLevel;
  // На экране остаётся только актуальный уровень помощи, а не стопка из
  // всех трёх подсказок. Следующая появится лишь после следующей ошибки.
  slot.innerHTML = `<div class="hint-box ${level > 1 ? "hint-box--deep" : ""}">${icon("bulb")} <b>Подсказка ${level}.</b> ${mathText(levels[level - 1])}</div>`;
  renderSessionHintControl();
  renderHintXpNote(t, S.hintLevel);
}

function sessionShowAnswer() {
  const S = Session.cur;
  const t = Session.task();
  if (S.answered) return;
  S.hintLevel = 3;
  S.hintsUsed++;
  const seconds = (Date.now() - S.taskStartTs) / 1000;
  const xpShown = recordAnswer(t, false, 3, seconds);
  S.gainedXp += xpShown;
  S.attemptXpSum = (S.attemptXpSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.attempt : 0);
  S.results.push({ taskId: t.id, correct: false, skipped: false, answerShown: true, seconds, hint: 3 });
  S.answered = true;
  Session.stopTimer();

  const input = document.getElementById("answerInput");
  input.disabled = true;
  input.value = t.answer;
  input.classList.add("answer-input--wrong");
  document.getElementById("submitBtn").style.display = "none";
  document.getElementById("hintBtn").disabled = true;

  document.getElementById("feedbackSlot").innerHTML = `
    <div class="feedback feedback--bad">
      <div class="feedback__head">
        ${icon("bulb")} Ответ показан
        <span class="feedback__xp" style="color:var(--danger)">ответ: ${esc(t.answer)}</span>
      </div>
      <div class="feedback__solution"><b>Разбор.</b>\n${mathText(t.solution)}</div>
      <div style="font-size:13px;color:var(--muted);margin-top:10px">Задание ушло в повторение — решёшь его позже сам.</div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn btn--soft" onclick="sessionNext()">${sessionNextLabel()}</button>
      </div>
    </div>`;
  renderTopbar();
}

function renderHintXpNote(t, hintLevel) {
  const el = document.getElementById("xpNote");
  if (!el) return;
  const full = attemptXp(t, true, hintLevel, false);
  const attempt = attemptXp(t, false, hintLevel, false);
  el.textContent = hintLevel === 0
    ? `верный ответ: +${full.total} XP · попытка: +${attempt.total} XP`
    : `сейчас за верный: +${full.total} XP · попытка: +${attempt.total} XP`;
}

function sessionSubmit() {
  const S = Session.cur;
  if (S.answered) return;
  const input = document.getElementById("answerInput");
  const t = Session.task();
  const val = input.value.trim();
  if (!val) { input.classList.add("answer-input--wrong"); setTimeout(() => input.classList.remove("answer-input--wrong"), 400); return; }

  const correct = checkAnswer(t, val);
  if (!correct) {
    S.attempts = (S.attempts || 0) + 1;
    // Ошибка только открывает следующий уровень помощи. Саму подсказку
    // ученик запрашивает кнопкой; после нажатия она исчезает до новой ошибки.
    renderSessionHintControl();
    input.classList.add("answer-input--wrong");
    setTimeout(() => input.classList.remove("answer-input--wrong"), 420);
    const help = sessionAvailableHelp();
    const message = help && help.type === "solution"
      ? "Все подсказки уже открыты — при необходимости можно показать решение."
      : "Открылась следующая подсказка — можно попробовать ещё раз или посмотреть её.";
    document.getElementById("feedbackSlot").innerHTML = `<div class="feedback feedback--bad feedback--retry"><div class="feedback__head">${icon("x")} Пока не сходится</div><div class="feedback__solution">Ошибка не влияет на прогресс. ${message}</div></div>`;
    return;
  }

  const seconds = (Date.now() - S.taskStartTs) / 1000;
  const hintLevel = S.hintLevel || 0;
  const closesTaskId = S.errorMap ? S.errorMap[t.id] : undefined;
  const xp = recordAnswer(t, true, hintLevel, seconds, closesTaskId, S.attempts || 0);
  S.gainedXp += xp;
  S.attemptXpSum = (S.attemptXpSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.attempt : 0);
  S.correctBonusSum = (S.correctBonusSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.correctBonus : 0);
  S.errorResolvedSum = (S.errorResolvedSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.errorResolved : 0);
  S.results.push({ taskId: t.id, correct: true, skipped: false, seconds, hint: hintLevel });
  S.answered = true;
  Session.stopTimer();

  input.disabled = true;
  input.classList.add("answer-input--correct");
  document.getElementById("submitBtn").style.display = "none";

  document.getElementById("feedbackSlot").innerHTML = `
    <div class="feedback feedback--ok">
      <div class="feedback__head">
        ${icon("check")} Правильно
        <span class="feedback__xp">+${xp} XP</span>
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn btn--primary" onclick="sessionNext()">${sessionNextLabel()}</button>
      </div>
    </div>`;

  renderTopbar();
}

function sessionSkip() {
  const S = Session.cur;
  if (S.answered) return;
  const t = Session.task();
  const seconds = (Date.now() - S.taskStartTs) / 1000;
  const xpSkip = recordAnswer(t, false, S.hintLevel || 0, seconds);
  S.gainedXp += xpSkip;
  S.attemptXpSum = (S.attemptXpSum || 0) + (Store._lastXpBreakdown ? Store._lastXpBreakdown.attempt : 0);
  S.results.push({ taskId: t.id, correct: false, skipped: true, seconds, hint: S.hintLevel || 0 });
  sessionNext();
}

function sessionNext() {
  const S = Session.cur;
  S.idx++;
  if (S.missionId) {
    Store.state.missionProgress[S.missionId] = (S.offset || 0) + S.idx;
    Store.save();
  }
  persistSession();
  if (S.idx >= S.taskIds.length) return sessionFinish();
  S.answered = false;
  S.taskStartTs = Date.now();
  renderTask(document.getElementById("screen"));
}

function sessionQuit() {
  Session.stopTimer();
  if (Session.cur && Session.cur.results.length > 0) return sessionFinish(true);
  Session.cur = null;
  persistSession();
  go("training");
}

function sessionFinish(early = false) {
  const S = Session.cur;
  Session.stopTimer();
  const solved = S.results.length;
  const correct = S.results.filter((r) => r.correct).length;
  const totalTime = (Date.now() - S.startTs) / 1000;

  let missionDone = false, mission = null, boss = null;

  if (S.mode === "mission" && !early) {
    mission = DataAPI.mission(S.missionId);
    // Практика платит за прохождение: дошёл до конца полного списка заданий
    // миссии — награда выдана. Точность уже отражена в XP за ответы, а бар
    // точности здесь ломал возобновление: accuracy считалась только по
    // последнему срезу и обнуляла награду за полностью пройденную миссию.
    // Испытания (боссы) бары точности по-прежнему требуют.
    if (mission && (S.offset || 0) + S.results.length >= (S.total || mission.tasks.length)) {
      missionDone = true;
      completeMission(mission);
    }
  }
  if (S.mode === "boss" && !early) {
    boss = DataAPI.bosses().find((b) => b.id === S.bossId);
    if (boss && correct / solved >= 0.6) defeatBoss(boss);
  }
  if (S.mode === "daily" && !early && Store.state.daily.done) { /* xp уже начислен в recordAnswer */ }

  /* достижение «без подсказок» */
  if (solved >= 5 && S.hintsUsed === 0 && correct / solved >= 0.8) unlockAchievement("nohints");

  const errorsClosed = S.results.filter((r) => r.correct && S.mode === "errors").length;
  /* Сессия из длинных текстовых ответов не «правильна/неправильна»:
     сочинение либо отправлено (минимальный объём есть), либо нет.
     Оценки по критериям здесь нет — только честный факт отправки. */
  const essayOnly = S.results.length > 0 && S.results.every((r) => {
    const task = DataAPI.task(r.taskId);
    return task && isLongTextTask(task);
  });

  const isBossWin = boss && correct / solved >= 0.6 && bossDefeated(boss);
  const title = missionDone ? "ПРАКТИКА ЗАВЕРШЕНА" : boss ? (isBossWin ? "ИСПЫТАНИЕ ПРОЙДЕНО" : "БОСС УСТОЯЛ") : "ТРЕНИРОВКА ЗАВЕРШЕНА";

  const checkedSkills = boss ? [...new Set(S.results.map((r) => DataAPI.skill(DataAPI.task(r.taskId).skill).name))] : null;

  Session.cur = null;
  persistSession();
  // Экран результата — не сессия: подменяем адрес без перерисовки, чтобы
  // перезагрузка вела в список, а не перезапускала тренировку.
  const resultRoute = S.mode === "boss" ? "trials" : S.mode === "errors" ? "errors" : "training";
  try { history.replaceState(null, "", "#/" + resultRoute); } catch (_) {}

  const attemptSum = S.attemptXpSum || 0;
  const bonusSum = S.correctBonusSum || 0;
  const errSum = S.errorResolvedSum || 0;
  const missionXp = missionDone && mission ? mission.xp : 0;
  const repeatNote = S.results.length && bonusSum === 0 && correct > 0
    ? `<div style="color:var(--muted);font-size:13px;margin-top:4px">Все задания уже были решены раньше — начислен только минимум за попытки.</div>` : "";

  document.getElementById("screen").innerHTML = `
    <div class="result-wrap">
      <div class="result-title ${boss && !isBossWin ? "result-title--danger" : ""}">${title}</div>
      <div class="result-sub">${early ? "Сессия завершена досрочно — прогресс учтён." : esc(S.title)}</div>
      <div class="result-xp mono">+${S.gainedXp + missionXp} XP</div>
      <div class="result-breakdown">
        <div class="result-breakdown__row"><span>За выполнение заданий</span><b class="mono">+${attemptSum} XP</b></div>
        ${bonusSum ? `<div class="result-breakdown__row"><span>${essayOnly ? "За выполнение сочинений" : "За правильные ответы"}</span><b class="mono">+${bonusSum} XP</b></div>` : ""}
        ${errSum ? `<div class="result-breakdown__row"><span>За закрытие ошибок</span><b class="mono">+${errSum} XP</b></div>` : ""}
        ${missionXp ? `<div class="result-breakdown__row"><span>Бонус миссии</span><b class="mono">+${missionXp} XP</b></div>` : ""}
      </div>
      ${missionDone && mission ? `<div style="color:var(--text-2)">Навык «${DataAPI.skill(mission.skill).name}» усилен · награда миссии +${mission.xp} XP</div>` : ""}
      ${repeatNote}
      ${boss && isBossWin ? `<div style="color:var(--success)">Навыки ветки «${DataAPI.category(boss.cat).name}» повышены на +6%</div>` : ""}
      <div class="result-stats">
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${correct}/${solved}</div><div class="stat-label">${essayOnly ? "отправлено" : "правильно"}</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${fmtTime(totalTime)}</div><div class="stat-label">время</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${S.hintsUsed}</div><div class="stat-label">подсказок</div></div>
      </div>
      ${essayOnly ? `<div style="color:var(--text-2);font-size:14px;margin:-8px 0 20px">Сочинения сохранены и проверены: разбор каждого — на странице результата (кнопка «Посмотреть результат →» в карточке задания).</div>` : ""}
      ${boss ? `<div class="card" style="text-align:left;margin-bottom:20px">
        <div class="stat-label" style="margin-bottom:8px">Проверялись навыки</div>
        <div class="error-subtopics">${checkedSkills.map((n) => `<span class="chip">${n}</span>`).join("")}</div>
      </div>` : ""}
      ${S.mode === "errors" ? `<div style="color:var(--text-2);margin-bottom:18px">Закрыто ошибок: <b>${errorsClosed}</b></div>` : ""}
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn--primary btn--lg" onclick="go('dashboard')">На главную</button>
        <button class="btn btn--ghost btn--lg" onclick="go('${resultRoute}')">${S.mode === "boss" ? "К испытаниям" : S.mode === "errors" ? "К ошибкам" : "Ещё тренировка"}</button>
      </div>
    </div>`;
  restoreChromeAfterResult(resultRoute);
}

function orderedTasks(arr) {
  return arr.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/* A handful of answers are algebraic expressions ("2x", "6x-2", "90/v-90/(v+5)"),
   not numbers. inputmode="decimal" hides letters on a phone's on-screen
   keyboard, which makes those specific fields unanswerable on mobile — so the
   numeric keypad is only a hint when the expected answer actually looks numeric. */
function answerInputMode(answer) {
  return /[a-zA-Zа-яёА-ЯЁ]/.test(String(answer ?? "")) ? "text" : "decimal";
}

/* Подсказка ожидаемого формата ответа — чтобы ученик всегда понимал,
   что вводить: целое, дробь или выражение. valueType из каталога
   приоритетнее, иначе выводим формат по виду самого ответа. */
function answerFormatHint(answer, valueType) {
  const vt = String(valueType || "");
  if (/целое/.test(vt)) return /градус/.test(vt) ? "целое число (в градусах)" : "целое число";
  if (/дробь/.test(vt)) return "десятичная дробь (запятая или точка)";
  if (/единиц/.test(vt)) return "число с единицей измерения";
  const a = String(answer ?? "").trim().replace(/\s+/g, "");
  if (/^[+-]?\d+$/.test(a)) return "целое число";
  if (/^[+-]?[\d.,]+$/.test(a) || /^[+-]?[\d.,]+\/[+-]?[\d.,]+$/.test(a)) return "десятичная дробь (запятая или точка)";
  if (/[a-zA-Zа-яёА-ЯЁπ√∞]/.test(a)) return "выражение";
  return "";
}

function answerFormatCaption(answer, valueType) {
  const hint = answerFormatHint(answer, valueType);
  return hint ? `<div style="font-size:12px;color:var(--muted);margin-top:6px">Формат ответа: ${esc(hint)}</div>` : "";
}

/* ============================================================
   Interactive lesson engine — data-driven, persistent and reusable
   Supported semantic steps: EXPLANATION, FOCUS, ACTION, VALIDATION,
   FEEDBACK, HINT, TRANSITION, INDEPENDENT_TASK.
   ============================================================ */

const LESSON_INTERACTIVE_TYPES = new Set(["ACTION", "VALIDATION", "INDEPENDENT_TASK"]);

/* Время урока — это активное время, а не календарное время между первым
   открытием и завершением. Между возвратами накопленное activeMs сохраняется,
   а активный отрезок возобновляется только когда экран урока снова виден.
   Если браузер не успел прислать pagehide (например, вкладку убили), пауза
   длиннее 30 минут не засчитывается: это защита от огромных «часов» после
   случайного возвращения через несколько дней. */
const LESSON_CLOCK_MAX_GAP_MS = 30 * 60 * 1000;
const LESSON_CLOCK_TICK_MS = 15 * 1000;
function normalizeLessonActiveMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const LessonClock = {
  pageVisible() {
    try {
      return currentRoute() === "lesson"
        && !document.hidden
        && document.visibilityState !== "hidden";
    } catch (_) {
      return false;
    }
  },

  sync(lesson, now = Date.now()) {
    if (!lesson) return 0;
    const activeMs = normalizeLessonActiveMs(lesson.activeMs);
    if (lesson.activeSince == null) {
      lesson.activeMs = activeMs;
      return activeMs;
    }
    const previous = Number(lesson.activeSince);
    if (!Number.isFinite(previous) || previous <= 0) {
      lesson.activeSince = now;
      lesson.activeMs = activeMs;
      return activeMs;
    }
    const delta = Math.max(0, now - previous);
    lesson.activeMs = activeMs + (delta <= LESSON_CLOCK_MAX_GAP_MS ? delta : 0);
    lesson.activeSince = now;
    return lesson.activeMs;
  },

  start(lesson) {
    if (!lesson || lesson.activeSince != null || !this.pageVisible()) return;
    lesson.activeSince = Date.now();
    if (lesson.timerId == null && typeof setInterval === "function") {
      lesson.timerId = setInterval(() => this.sync(lesson), LESSON_CLOCK_TICK_MS);
    }
  },

  pause(lesson) {
    if (!lesson) return;
    this.sync(lesson);
    lesson.activeSince = null;
    if (lesson.timerId != null) {
      if (typeof clearInterval === "function") clearInterval(lesson.timerId);
      lesson.timerId = null;
    }
  },

  elapsedMs(lesson) {
    return this.sync(lesson);
  },
};

function resumeLessonClock() {
  if (typeof Lesson === "undefined" || !Lesson.cur) return;
  LessonClock.start(Lesson.cur);
}

function pauseLessonClock() {
  if (typeof Lesson === "undefined" || !Lesson.cur) return;
  const lesson = Lesson.cur;
  if (lesson.activeSince == null && lesson.timerId == null) return;
  LessonClock.pause(lesson);
  Lesson.persist();
}

/* После смены cookie/accountId нельзя сохранять старый урок: запрос уже
   будет принадлежать новой учётной записи. Таймер только останавливаем, а
   последний durable checkpoint уже был сделан до смены идентичности. */
function deactivateLessonClock() {
  if (typeof Lesson === "undefined" || !Lesson.cur) return;
  LessonClock.pause(Lesson.cur);
  Lesson.cur = null;
}

function lessonDurationSec() {
  return LessonClock.elapsedMs(typeof Lesson !== "undefined" ? Lesson.cur : null) / 1000;
}

function lessonStepType(step) {
  // Compatibility with the first declarative lesson format.
  return ({ explain: "EXPLANATION", focus: "FOCUS", input: "ACTION", summary: "FEEDBACK" }[step.type] || step.type || "EXPLANATION").toUpperCase();
}

/* Подписи типов шагов — только по-русски. Внутренние коды (FOCUS, ACTION, …)
   в интерфейсе не показываем. */
const LESSON_STEP_LABELS = {
  EXPLANATION: "Объяснение",
  FOCUS: "Главное",
  ACTION: "Задание",
  VALIDATION: "Проверка",
  FEEDBACK: "Итог шага",
  HINT: "Подсказка",
  TRANSITION: "Переход",
  INDEPENDENT_TASK: "Самостоятельная работа",
};

function lessonFields(step) {
  if (Array.isArray(step.fields) && step.fields.length) return step.fields;
  const task = step.taskId ? DataAPI.task(step.taskId) : null;
  return [{ id: "answer", label: "Ответ", answer: step.answer || (task && task.answer), errorType: step.errorType }];
}

function lessonTask(step) { return step.taskId ? DataAPI.task(step.taskId) : null; }

/* Текст шага и текст задания из банка — один и тот же: второй показ лишний.
   Такое бывает, когда текст шага слово в слово повторяет bank text. */
function lessonStepTextDup(step, task) {
  if (!task || !step.text || !task.text) return false;
  const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();
  return norm(step.text) === norm(task.text);
}

const Lesson = {
  cur: null,

  async start(lessonId) {
    // Шаги урока живут в ленивой половине каталога — дожидаемся их до чтения.
    try { await Store.ensureDetails(); } catch (_) { toast("Не удалось загрузить урок. Попробуй ещё раз.", "toast--error", "x"); return; }
    const lesson = DataAPI.lesson(lessonId);
    if (!lesson || !Array.isArray(lesson.steps)) return;
    if (this.cur && this.cur.lesson.id !== lessonId) {
      pauseLessonClock();
      this.cur = null;
    }
    const sourceRoute = ["path", "training"].includes(currentRoute()) ? currentRoute() : "path";
    const saved = Store.state.lessonSessions && Store.state.lessonSessions[lessonId];
    const now = Date.now();
    this.cur = saved
      ? { lesson, idx: Math.min(saved.idx || 0, lesson.steps.length - 1), stepState: saved.stepState || {}, xp: saved.xp || 0, wrongAttempts: saved.wrongAttempts || 0, startTs: saved.startTs || now, activeMs: normalizeLessonActiveMs(saved.activeMs), activeSince: null, timerId: null, returnRoute: saved.returnRoute || sourceRoute }
      : { lesson, idx: 0, stepState: {}, xp: 0, wrongAttempts: 0, startTs: now, activeMs: 0, activeSince: null, timerId: null, returnRoute: sourceRoute };
    LessonClock.start(this.cur);
    this.persist();
    go("lesson", lesson.id);
    if (currentRoute() === "lesson") render();
  },

  step() { return this.cur && this.cur.lesson.steps[this.cur.idx]; },

  stateFor(step = this.step()) {
    if (!this.cur.stepState[step.id]) this.cur.stepState[step.id] = { status: "active", hints: 0, attempts: 0, draft: {} };
    return this.cur.stepState[step.id];
  },

  persist() {
    if (!this.cur) return;
    LessonClock.sync(this.cur);
    Store.state.lessonSessions = Store.state.lessonSessions || {};
    Store.state.lessonSessions[this.cur.lesson.id] = {
      idx: this.cur.idx, stepState: this.cur.stepState, xp: this.cur.xp,
      wrongAttempts: this.cur.wrongAttempts, startTs: this.cur.startTs,
      activeMs: normalizeLessonActiveMs(this.cur.activeMs),
      returnRoute: this.cur.returnRoute || "path",
    };
    Store.save();
  },

  clearPersist(lessonId) {
    if (Store.state.lessonSessions) delete Store.state.lessonSessions[lessonId];
    if (!Store.deletedLessonSessions.includes(lessonId)) Store.deletedLessonSessions.push(lessonId);
    Store.save();
  },
};

/* Восстановление урока для глубокого маршрута #/lesson/<id>:
   незаконченный шаг лежит в lessonSessions (уже на сервере), иначе старт
   с начала. Используется и первым заходом, и перезагрузкой страницы. */
async function ensureLessonForRoute(param) {
  const id = param || (Lesson.cur && Lesson.cur.lesson.id) || "";
  if (id && Lesson.cur && Lesson.cur.lesson.id === id) return true;
  try { await Store.ensureDetails(); } catch (_) { return false; }
  const lesson = DataAPI.lesson(id);
  if (!lesson || !Array.isArray(lesson.steps)) return false;
  if (Lesson.cur && Lesson.cur.lesson.id !== id) {
    pauseLessonClock();
    Lesson.cur = null;
  }
  const saved = Store.state.lessonSessions && Store.state.lessonSessions[id];
  const now = Date.now();
  Lesson.cur = saved
    ? { lesson, idx: Math.min(saved.idx || 0, lesson.steps.length - 1), stepState: saved.stepState || {}, xp: saved.xp || 0, wrongAttempts: saved.wrongAttempts || 0, startTs: saved.startTs || now, activeMs: normalizeLessonActiveMs(saved.activeMs), activeSince: null, timerId: null, returnRoute: saved.returnRoute || "path" }
    : { lesson, idx: 0, stepState: {}, xp: 0, wrongAttempts: 0, startTs: now, activeMs: 0, activeSince: null, timerId: null, returnRoute: "path" };
  LessonClock.start(Lesson.cur);
  Lesson.persist();
  return true;
}

function lessonBoardHtml(step, type) {
  if (!step.board) return "";
  return `<div class="lesson-board ${type === "FOCUS" ? "lesson-board--focus" : ""}" aria-label="Математическая запись">
    ${step.board.map((tok) => {
      const on = step.highlight && tok.id && step.highlight.includes(tok.id);
      const dim = type === "FOCUS" && !on;
      return `<span class="lesson-token ${on ? "lesson-token--on" : ""} ${dim ? "lesson-token--dim" : ""}" ${tok.id ? `data-focus-id="${esc(tok.id)}"` : ""}>${mathText(tok.t)}</span>`;
    }).join("")}
  </div>`;
}

/* Та же лестница, что и в sessionAvailableHelp: 0 ошибок — подсказка 1
   доступна сразу, дальше каждая ошибка открывает следующий уровень. */
function lessonAvailableHelp(state) {
  const maxLevel = Math.min(3, state.attempts + 1);
  if (state.hints < maxLevel) return { type: "hint", level: state.hints + 1 };
  return state.attempts >= 3 ? { type: "solution" } : null;
}

function lessonHintsHtml(step, state) {
  const hints = hintLevelsFor(step);
  return hints.slice(0, state.hints).map((hint, i) => `
    <div class="hint-box ${i > 0 ? "hint-box--deep" : ""}">
      ${icon("bulb")} <b>Подсказка ${i + 1}.</b> ${mathText(hint)}
    </div>`).join("");
}

function lessonFeedbackHtml(step, state) {
  if (state.status === "solved") return `
    <div class="feedback feedback--ok">
      <div class="feedback__head">${icon("check")} Верно <span class="feedback__xp">+${state.xp || 0} XP</span></div>
      ${step.solution ? `<div class="feedback__solution"><b>Проверка.</b>\n${mathText(step.solution)}</div>` : ""}
    </div>`;
  if (state.status === "shown") return `
    <div class="feedback feedback--bad">
      <div class="feedback__head">${icon("bulb")} Решение показано</div>
      <div class="feedback__solution"><b>Разбор.</b>\n${mathText(step.solution || "Ответ показан на следующем шаге.")}</div>
      <div style="font-size:13px;color:var(--muted);margin-top:10px">Шаг сохранён в слабых местах для повторения.</div>
    </div>`;
  return state.feedback || "";
}

function lessonActionHtml(step, state) {
  const fields = lessonFields(step);
  const isDone = state.status === "solved" || state.status === "shown";
  const help = lessonAvailableHelp(state);
  return `
    ${lessonHintsHtml(step, state)}
    <div class="lesson-answer-grid ${fields.length > 1 ? "lesson-answer-grid--multiple" : ""}">
      ${fields.map((field) => `
        <label class="lesson-answer-field">
          <span>${esc(field.label || "Ответ")}</span>
          <input class="answer-input" id="lessonInput-${esc(field.id)}" data-lesson-field="${esc(field.id)}" placeholder="${esc(field.label || "Ответ")}" autocomplete="off" inputmode="${answerInputMode(field.answer)}" value="${esc(state.draft[field.id] || "")}" ${isDone ? "disabled" : ""}>
        </label>`).join("")}
      ${isDone ? "" : `<button class="btn btn--primary lesson-check-btn" id="lessonSubmitBtn" onclick="lessonSubmit()">Проверить</button>`}
    </div>
    ${isDone ? "" : (() => { const hints = [...new Set(fields.map((f) => answerFormatHint(f.answer)).filter(Boolean))]; return hints.length ? `<div style="font-size:12px;color:var(--muted);margin-top:6px">Формат ответа: ${esc(hints.join(" · "))}</div>` : ""; })()}
    ${isDone ? "" : `<div class="session-tools lesson-tools">
      ${help ? `<button class="btn btn--ghost btn--sm" id="lessonHintBtn" onclick="lessonHint()">${icon("bulb")} ${help.type === "solution" ? "Показать решение" : `Подсказка ${help.level}`}</button>` : ""}
      <span>${help ? "Подсказка останется на экране до конца задания" : "Следующая подсказка откроется после ошибки"}</span>
    </div>`}
    <div id="lessonFeedbackSlot">${lessonFeedbackHtml(step, state)}</div>`;
}

function screenLesson(root) {
  const L = Lesson.cur;
  if (!L) { go("path"); return; }
  LessonClock.start(L);
  const lesson = L.lesson;
  const step = Lesson.step();
  const type = lessonStepType(step);
  const state = Lesson.stateFor(step);
  const total = lesson.steps.length;
  const interactive = LESSON_INTERACTIVE_TYPES.has(type);
  const canAdvance = !interactive || state.status === "solved" || state.status === "shown";
  const task = lessonTask(step);
  const toneClass = step.tone === "success" ? "lesson-note--success" : "";

  root.innerHTML = `
    <div class="session-wrap lesson-wrap">
      <div class="session-head">
        <button class="btn btn--ghost btn--sm" onclick="askLessonQuit()">← Выйти</button>
        <div class="session-head__title">${icon("bulb")} Урок: ${esc(lesson.title)}</div>
        <div class="session-head__progress mono">${L.idx + 1} / ${total}</div>
      </div>
      <div class="lesson-progress-meta"><span>${type === "INDEPENDENT_TASK" ? "самостоятельный шаг" : "пошаговое обучение"}</span><span>${Math.round((L.idx / total) * 100)}%</span></div>
      ${progressBar((L.idx / total) * 100)}
      <div class="card task-card lesson-card ${type === "FOCUS" ? "lesson-card--focus" : ""}">
        <div class="lesson-step-label">${esc(LESSON_STEP_LABELS[type] || "Шаг")}</div>
        ${step.title ? `<div class="lesson-title">${esc(step.title)}</div>` : ""}
        <div class="lesson-body">
          ${lessonStepTextDup(step, task) ? "" : `<div class="task-card__text lesson-text">${mathText(step.text || "")}</div>`}
          ${task ? `<div class="lesson-independent-task"><div class="stat-label">Задание из банка · ${esc(task.num)}</div><div class="task-card__text">${mathText(task.text)}</div>${taskVisualHtml(task, "lesson")}</div>` : ""}
        </div>
        ${lessonBoardHtml(step, type)}
        ${interactive ? lessonActionHtml(step, state) : `<div class="lesson-static-note ${toneClass}">${type === "HINT" ? `${icon("bulb")} ` : ""}${type === "FEEDBACK" && step.tone === "success" ? `${icon("check")} ` : ""}${type === "TRANSITION" ? `${icon("arrow")} ` : ""}<span>${type === "HINT" ? "Опора для следующего шага" : type === "FEEDBACK" ? "Результат шага" : "Продолжение"}</span></div>`}
        <div class="lesson-nav">
          ${L.idx > 0 ? `<button class="btn btn--ghost" onclick="lessonPrev()">← Назад</button>` : "<span></span>"}
          ${canAdvance ? `<button class="btn btn--primary" onclick="lessonNext()">${L.idx + 1 >= total ? "Завершить урок" : "Далее →"}</button>` : "<span></span>"}
        </div>
      </div>
    </div>`;

  if (interactive && !canAdvance) {
    document.querySelectorAll("[data-lesson-field]").forEach((input) => {
      input.addEventListener("input", () => lessonCaptureDraft(input.dataset.lessonField, input.value));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") lessonSubmit(); });
    });
  }
}

function lessonCaptureDraft(fieldId, value) {
  const state = Lesson.stateFor();
  state.draft[fieldId] = value;
  Lesson.persist();
}

function lessonHint() {
  const step = Lesson.step();
  const state = Lesson.stateFor(step);
  if (state.status !== "active") return;
  const help = lessonAvailableHelp(state);
  if (!help) return;
  if (help.type === "solution") return lessonShowSolution();
  state.hints = help.level;
  Lesson.persist();
  screenLesson(document.getElementById("screen"));
}

function lessonErrorType(step, values) {
  const fields = lessonFields(step);
  const wrong = fields.find((field) => !checkAnswer({ answer: field.answer }, values[field.id]));
  return (wrong && wrong.errorType) || step.errorType || "Ошибка в учебном шаге";
}

function lessonSubmit() {
  const L = Lesson.cur;
  const step = Lesson.step();
  const state = Lesson.stateFor(step);
  if (!L || state.status !== "active") return;
  const fields = lessonFields(step);
  const values = {};
  let complete = true;
  fields.forEach((field) => {
    const input = document.getElementById(`lessonInput-${field.id}`);
    values[field.id] = input ? input.value.trim() : (state.draft[field.id] || "");
    state.draft[field.id] = values[field.id];
    if (!values[field.id]) complete = false;
  });
  if (!complete) {
    document.querySelectorAll("[data-lesson-field]").forEach((input) => {
      if (!input.value.trim()) { input.classList.add("answer-input--wrong"); setTimeout(() => input.classList.remove("answer-input--wrong"), 400); }
    });
    Lesson.persist();
    return;
  }
  const correct = fields.every((field) => checkAnswer({ answer: field.answer }, values[field.id]));
  if (!correct) {
    const errorType = lessonErrorType(step, values);
    state.attempts++;
    L.wrongAttempts++;
    recordLessonStepError(L.lesson.id, step.id, L.lesson.skill, errorType);
    // Ошибка лишь открывает следующий уровень. Подсказка появляется только
    // после явного нажатия и остаётся на экране до конца задания.
    const help = lessonAvailableHelp(state);
    const helpMessage = help && help.type === "solution"
      ? "Все три подсказки уже открыты. Если нужно, теперь можно нажать «Показать решение»."
      : `Это попытка ${state.attempts}. Открылась следующая подсказка.`;
    state.feedback = `<div class="feedback feedback--bad feedback--retry"><div class="feedback__head">${icon("x")} ${esc(errorType)}</div><div style="font-size:13px;color:var(--text-2);margin-top:8px">Ошибка не влияет на прогресс. ${helpMessage}</div></div>`;
    Lesson.persist();
    screenLesson(document.getElementById("screen"));
    return;
  }
  state.status = "solved";
  // Подсказки и неверные попытки — часть обучения, а не штраф.
  state.xp = step.xp || 10;
  L.xp += state.xp;
  clearLessonStepError(L.lesson.id, step.id);
  Lesson.persist();
  screenLesson(document.getElementById("screen"));
}

function lessonShowSolution() {
  const L = Lesson.cur;
  const step = Lesson.step();
  const state = Lesson.stateFor(step);
  if (!L || state.status !== "active" || lessonAvailableHelp(state)?.type !== "solution") return;
  // If the learner asks for a solution without attempting, keep one meaningful weak-skill marker.
  if (!state.attempts) {
    recordLessonStepError(L.lesson.id, step.id, L.lesson.skill, "Решение показано после уровней помощи");
    L.wrongAttempts++;
  }
  state.status = "shown";
  state.answerShown = true;
  Lesson.persist();
  screenLesson(document.getElementById("screen"));
}

function lessonNext() {
  const L = Lesson.cur;
  if (!L) return;
  const step = Lesson.step();
  const state = Lesson.stateFor(step);
  if (LESSON_INTERACTIVE_TYPES.has(lessonStepType(step)) && state.status !== "solved" && state.status !== "shown") return;
  L.idx++;
  Lesson.persist();
  if (L.idx >= L.lesson.steps.length) return lessonFinish();
  screenLesson(document.getElementById("screen"));
}

function lessonPrev() {
  const L = Lesson.cur;
  if (!L || L.idx <= 0) return;
  L.idx--;
  Lesson.persist();
  screenLesson(document.getElementById("screen"));
}

function lessonQuit() {
  if (!Lesson.cur) return go("path");
  const returnRoute = Lesson.cur.returnRoute || "path";
  pauseLessonClock();
  Lesson.cur = null;
  go(returnRoute);
}

function lessonFinish() {
  const L = Lesson.cur;
  const durationSec = lessonDurationSec();
  LessonClock.pause(L);
  const lesson = L.lesson;
  const independentStep = lesson.steps.find((step) => lessonStepType(step) === "INDEPENDENT_TASK");
  const independent = independentStep ? (L.stepState[independentStep.id] || {}) : null;
  Lesson.clearPersist(lesson.id);
  const { firstCompletion, totalXp, baseXp, stepsXp } = completeLesson(lesson, L.xp, {
    wrongAttempts: L.wrongAttempts,
    durationSec,
  });
  Lesson.cur = null;
  // Экран результата — не урок: подменяем адрес без перерисовки, чтобы
  // перезагрузка вела в раздел, а не переоткрывала урок.
  const resultRoute = L.returnRoute || "path";
  try { history.replaceState(null, "", "#/" + resultRoute); } catch (_) {}

  document.getElementById("screen").innerHTML = `
    <div class="result-wrap">
      <div class="result-title">${firstCompletion ? "УРОК ПРОЙДЕН" : "УРОК ПОВТОРЁН"}</div>
      <div class="result-sub">${esc(lesson.title)}</div>
      <div class="result-xp mono">+${totalXp} XP</div>
      ${firstCompletion ? `<div class="result-breakdown">
        <div class="result-breakdown__row"><span>За завершение урока</span><b class="mono">+${baseXp} XP</b></div>
        ${stepsXp ? `<div class="result-breakdown__row"><span>За шаги и ответы</span><b class="mono">+${stepsXp} XP</b></div>` : ""}
      </div>` : `<div style="color:var(--text-2)">Урок уже был пройден ранее — повтор не даёт базовой награды ещё раз.</div>`}
      ${firstCompletion ? (() => { const b = skillProgressBreakdown(lesson.skill); return `<div style="color:var(--text-2)">Урок «${esc(lesson.title)}» завершён. Навык «${DataAPI.skill(lesson.skill).name}»: ${b.total}% освоено (теория ${b.theory}%, практика ${b.practice}%). До полного освоения осталось ${Math.max(0, 100 - b.total)}%.</div>`; })() : `<div style="color:var(--text-2)">Урок повторён. Прогресс навыка не изменился: он растёт только за первое прохождение и реальные ответы в практике.</div>`}
      <div class="result-stats">
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${lesson.steps.length}</div><div class="stat-label">шагов</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${fmtTime(durationSec)}</div><div class="stat-label">активное время</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${L.wrongAttempts}</div><div class="stat-label">осмысленных ошибок</div></div>
      </div>
      <div class="lesson-result-note ${independent && independent.status === "solved" ? "lesson-result-note--ok" : ""}">${!independent ? `${icon("info")} В этом уроке нет самостоятельного задания.` : independent.status === "solved" ? `${icon("check")} Самостоятельное задание решено.` : `${icon("bulb")} Самостоятельное задание сохранено для повторения.`}</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn--primary btn--lg" onclick="startSkillPractice('${lesson.skill}')">${icon("target")} Закрепить на практике</button>
        <button class="btn btn--ghost btn--lg" onclick="go('path')">К карте навыков</button>
      </div>
    </div>`;
  restoreChromeAfterResult(resultRoute);
}

/* ============================================================
   Screen: Ошибки
   ============================================================ */

const RESOLVED_ERRORS_PREVIEW = 10;
let resolvedErrorsExpanded = false;

function toggleResolvedErrors() {
  resolvedErrorsExpanded = !resolvedErrorsExpanded;
  render();
}

function screenErrors(root) {
  // Defensive guard: render() перехватывает locked/empty раньше, но прямой
  // вызов функции (тест, будущий рефакторинг роутера) тоже обязан показать
  // раздел «Ошибки», а не ready-подобный экран с чужими данными.
  if (subjectLearningUnavailable()) return screenSubjectUnavailable(root, true, "errors");
  const open = Store.state.errors.filter((e) => !e.resolved);
  const resolvedTotal = Store.state.errors.filter((e) => e.resolved).length;
  const resolvedLimit = resolvedErrorsExpanded ? resolvedTotal : RESOLVED_ERRORS_PREVIEW;
  const resolved = resolvedErrorsForDisplay(Store.state.errors, Store.state.taskAttempts, resolvedLimit);
  // Полные ошибки (задание не решено) и мини-ошибки (решено неидеально:
  // подсказка, неверные попытки, медленно) — разные пункты одного списка.
  const majors = open.filter((e) => errorKindOf(e) === "major");
  const minors = open.filter((e) => errorKindOf(e) === "minor");

  const groupCards = (errs, chipClass) => {
    const bySkill = {};
    for (const e of errs) {
      (bySkill[e.skill] = bySkill[e.skill] || []).push(e);
    }
    return Object.entries(bySkill).map(([skillId, list]) => {
      const sk = DataAPI.skill(skillId);
      const subs = {};
      list.forEach((e) => { subs[e.sub] = (subs[e.sub] || 0) + 1; });
      return `
      <div class="card error-group">
        <div class="error-group__head">
          <div style="font-weight:650;font-size:15px">${sk.name}</div>
          <span class="chip">${sk.ege}</span>
          <div class="error-group__count"><span class="chip ${chipClass}">${list.length} ${plural(list.length, "ошибка", "ошибки", "ошибок")}</span></div>
        </div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px">Частые проблемы:</div>
        <div class="error-subtopics">
          ${Object.entries(subs).map(([sub, n]) => `<span class="chip ${chipClass}">${esc(sub)}${n > 1 ? ` ×${n}` : ""}</span>`).join("")}
        </div>
      </div>`;
    }).join("");
  };

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Ошибки ${helpDot("errors")}</div>
      <div class="page-sub">Каждая ошибка — это точка роста. Повторяй слабые места, пока они не закроются.</div>
    </div>

    <div class="card card--glow" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px">
      <div>
        <div class="stat-num mono">${open.length}</div>
        <div class="stat-label">открытых ошибок (полных: ${majors.length} · мини: ${minors.length}) · закрыто за всё время: ${Store.state.errorsResolved}</div>
      </div>
      <div style="margin-left:auto">
        <button class="btn btn--primary btn--lg" ${open.length ? "" : "disabled"} onclick="startErrorsReview()">
          ${icon("rotate")} Повторить слабые места
        </button>
      </div>
    </div>

    ${resolvedTotal ? `
    <div class="section-title">Закрытые · ${resolvedTotal}</div>
    <div class="card" style="padding:8px 16px">
      ${resolved.map((e) => {
        const t = DataAPI.task(e.taskId);
        const closedAt = errorResolutionTimestamp(e, Store.state.taskAttempts);
        return `<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:var(--success)">${icon("check")}</span>
          <span style="color:var(--text-2)">${esc(t ? t.sub : e.sub)}</span>
          <span style="margin-left:auto;color:var(--muted);font-size:12px">${relTime(closedAt)}</span>
        </div>`;
      }).join("")}
      ${resolvedTotal > RESOLVED_ERRORS_PREVIEW ? `<div style="padding:9px 0 3px;color:var(--muted);font-size:12px">
        ${resolvedErrorsExpanded
          ? `<button class="btn btn--soft btn--sm" type="button" onclick="toggleResolvedErrors()">Свернуть</button>`
          : `<button class="btn btn--soft btn--sm" type="button" onclick="toggleResolvedErrors()">Показать все (${resolvedTotal})</button>`}
      </div>` : ""}
    </div>` : ""}

    ${majors.length ? `<div class="section-title">Требуют повторения</div>${groupCards(majors, "chip--danger")}` : ""}
    ${minors.length ? `<div class="section-title">Почти получилось — закрепи без подсказок</div>
    <div style="font-size:13px;color:var(--muted);margin:-6px 0 12px">Решено, но неидеально: с подсказкой, после неверных попыток или слишком медленно. Чистое решение закроет пункт.</div>
    ${groupCards(minors, "")}` : ""}
    ${open.length === 0 ? `<div class="section-title">По навыкам</div><div class="card empty">Открытых ошибок нет. Решай задания — система соберёт здесь всё, что пошло не так.</div>` : ""}`;
}

function reviewQueueForErrors(errors) {
  const taskIds = [];
  const errorMap = {}; // presentedTaskId -> исходный taskId ошибки
  const groups = {};
  errors.forEach((e) => { (groups[e.sub] = groups[e.sub] || []).push(e); });

  for (const group of Object.values(groups)) {
    const pool = DataAPI.practiceTasks().filter((t) => t.sub === group[0].sub);
    // A subtopic can end up with fewer practiceable tasks than open errors in
    // it (the catalog changed since the error was recorded: the task lost its
    // required visual, or was removed entirely). That must not sink the whole
    // review session for every other subtopic — skip only this group's errors
    // when there is truly nothing left to present for it.
    if (!pool.length) continue;
    const assigned = [];
    const used = new Set();
    const assign = (index) => {
      if (index === group.length) return true;
      const error = group[index];
      const candidates = pool.filter((t) => !used.has(t.id))
        .sort((a, b) => Number(a.id === error.taskId) - Number(b.id === error.taskId));
      for (const task of candidates) {
        used.add(task.id);
        assigned[index] = task;
        if (assign(index + 1)) return true;
        used.delete(task.id);
      }
      return false;
    };
    if (assign(0)) {
      group.forEach((error, i) => {
        const task = assigned[i];
        taskIds.push(task.id);
        if (task.id !== error.taskId) errorMap[task.id] = error.taskId;
      });
    } else {
      // Fewer distinct tasks than errors for this subtopic: reuse pool tasks
      // (a repeat of the same problem) rather than dropping the group.
      group.forEach((error, i) => {
        const task = pool[i % pool.length];
        taskIds.push(task.id);
        if (task.id !== error.taskId) errorMap[task.id] = error.taskId;
      });
    }
  }
  return { taskIds, errorMap };
}

function buildErrorsReviewSession() {
  const open = Store.state.errors.filter((e) => !e.resolved);
  if (!open.length) return null;

  /* Частые подтемы идут раньше. Внутри подтемы каждый вопрос уникален:
     это исключает дубли и даёт второе, похожее задание, когда оно есть.
     Полные ошибки — раньше мини-ошибок: сначала закрываем реальные пробелы. */
  const subFreq = {};
  open.forEach((e) => { subFreq[e.sub] = (subFreq[e.sub] || 0) + 1; });
  const sorted = open.slice().sort((a, b) => {
    const ka = errorKindOf(a), kb = errorKindOf(b);
    if (ka !== kb) return ka === "major" ? -1 : 1;
    return subFreq[b.sub] - subFreq[a.sub];
  });
  const queue = reviewQueueForErrors(sorted);
  if (!queue || !queue.taskIds.length) return null;
  return {
    title: "Повторение слабых мест",
    taskIds: queue.taskIds,
    mode: "errors",
    errorMap: queue.errorMap,
  };
}

function startErrorsReview() {
  const open = Store.state.errors.filter((e) => !e.resolved);
  if (!open.length) return toast("Открытых ошибок нет", "", "check");
  const q = buildErrorsReviewSession();
  if (!q) return toast("Не удалось подобрать задания. Попробуй ещё раз.", "", "x");

  Session.start(q);
}

/* ============================================================
   Screen: Испытания (daily + боссы)
   ============================================================ */

function screenTrials(root) {
  if (subjectLearningUnavailable()) return screenSubjectUnavailable(root, true, "trials");
  const s = Store.state;
  const d = DataAPI.daily();
  ensureDailyChallenge();
  const dailyGoal = dailyTaskIds().length || d.target;
  const dailyTitle = `Реши ${dailyGoal} заданий, подобранных для тебя`;
  const dailyDone = s.daily.date === todayStr() && s.daily.done;
  const dailySolved = s.daily.date === todayStr() ? s.daily.solved : 0;

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Испытания ${helpDot("trials")}</div>
      <div class="page-sub">Проверки на прочность: ежедневная подборка, смешанное испытание и боссы по веткам навыков.</div>
    </div>

    <div class="grid grid--2" style="margin-top:18px">
      <div class="card ${dailyDone ? "mission-card--done" : ""}">
        <div class="stat-label" style="letter-spacing:0.18em;font-weight:800">ЕЖЕДНЕВНАЯ ЗАДАЧА</div>
        <div style="font-size:18px;font-weight:650;margin-top:8px">${dailyGoal ? dailyTitle : "Подборка пока не создана"}</div>
        ${dailyGoal ? `<div style="margin:14px 0 6px">${progressBar(Math.min(dailySolved / dailyGoal, 1) * 100, dailyDone ? "progress--success" : "")}</div>` : ""}
        <div style="display:flex;align-items:center;gap:12px">
          ${dailyGoal ? `
            <span class="mono" style="font-size:13px;color:var(--text-2)">${Math.min(dailySolved, dailyGoal)} / ${dailyGoal}</span>
            <span class="chip chip--accent mono">+${d.xp} XP</span>
            <button class="btn ${dailyDone ? "btn--soft" : "btn--primary"} btn--sm" style="margin-left:auto" onclick="startDaily()">
              ${dailyDone ? "Повторить" : "Решать"}
            </button>` : `<span class="stat-label">Задания появятся вместе с материалами предмета</span>`}
        </div>
      </div>

      <div class="card">
        <div class="stat-label" style="letter-spacing:0.18em;font-weight:800">СМЕШАННОЕ ИСПЫТАНИЕ</div>
        <div style="font-size:18px;font-weight:650;margin-top:8px">10 заданий из разных тем</div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px">По одному заданию от каждой темы по кругу — проверка общей формы, а не отдельного навыка.</div>
        <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
          <span class="chip">${stars(3)}</span>
          <button class="btn btn--primary btn--sm" style="margin-left:auto" onclick="startMixedTrial()">Начать</button>
        </div>
      </div>
    </div>

    <div class="section-title">Босс-испытания</div>
    <div class="grid grid--2">
      ${DataAPI.bosses().map((b) => {
        const unlocked = bossUnlocked(b);
        const defeated = bossDefeated(b);
        const cp = catProgress(b.cat);
        return `
        <div class="card boss-card ${defeated ? "boss-card--defeated" : ""}">
          <div class="boss-label">${defeated ? "ИСПЫТАНИЕ ПРОЙДЕНО ✓" : unlocked ? "ИСПЫТАНИЕ" : "ИСПЫТАНИЕ · ЗАКРЫТО"}</div>
          <div class="boss-title">${b.title.replace("БОСС: ", "")}</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:8px">${b.desc}</div>
          <div style="margin:14px 0 6px">${progressBar(Math.min(cp / b.unlockAt, 1) * 100, unlocked ? "progress--success" : "progress--warn")}</div>
          <div style="font-size:12px;color:var(--muted)" class="mono">прогресс ветки: ${cp}% / ${b.unlockAt}% для доступа</div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
            <span class="chip chip--accent mono">+${b.xp} XP</span>
            <span class="chip">${b.size} заданий</span>
            ${unlocked
              ? `<button class="btn ${defeated ? "btn--soft" : "btn--danger-soft"} btn--sm" style="margin-left:auto" onclick="startBoss('${b.id}')">${defeated ? "Пройти снова" : "В бой"}</button>`
              : `<span style="margin-left:auto;color:var(--muted)">${icon("lock")}</span>`}
          </div>
        </div>`;
      }).join("")}
    </div>`;
}

/* Сбор по-настоящему «смешанного» набора: по кругу берём по заданию от
   каждой темы, чтобы набор покрывал разные навыки. Простой slice(0, N) по
   сортировке id давал бы только самые «младшие» номера ЕГЭ (№1–№4). */
function mixedSampleTaskIds(pool, count) {
  const bySkill = {};
  for (const t of orderedTasks(pool)) (bySkill[t.skill] = bySkill[t.skill] || []).push(t);
  const order = DataAPI.skills().map((sk) => sk.id).filter((id) => bySkill[id]);
  const picked = [];
  for (let round = 0; picked.length < count && round < 10; round++) {
    for (const sid of order) {
      if (picked.length >= count) break;
      if (bySkill[sid][round]) picked.push(bySkill[sid][round]);
    }
  }
  return picked.map((t) => t.id);
}

function startDaily() {
  const d = DataAPI.daily();
  Session.start({
    title: "Ежедневная задача",
    taskIds: dailyTaskIds(),
    mode: "daily",
  });
}

function startMixedTrial() {
  Session.start({
    title: "Смешанное испытание",
    taskIds: mixedSampleTaskIds(DataAPI.practiceTasks(), 10),
    mode: "quick",
  });
}

function startBoss(bossId) {
  const boss = DataAPI.bosses().find((b) => b.id === bossId);
  if (!boss) { go("trials"); return; }
  if (!bossUnlocked(boss)) return;
  const pool = DataAPI.practiceTasks().filter((t) => DataAPI.skill(t.skill).cat === boss.cat);
  Session.start({
    title: boss.title,
    taskIds: mixedSampleTaskIds(pool, boss.size),
    mode: "boss",
    bossId: boss.id,
    hideTopic: true,
  });
}

/* ============================================================
   Screen: Статистика
   ============================================================ */

function screenStats(root) {
  if (subjectLearningUnavailable()) return screenSubjectUnavailable(root, true, "stats");
  const s = Store.state;
  const acc = s.totalSolved ? Math.round((s.totalCorrect / s.totalSolved) * 100) : 0;
  const avgTime = s.totalSolved ? Math.round(s.totalTimeSec / s.totalSolved) : 0;
  const skills = (DataAPI.availableSkills ? DataAPI.availableSkills() : DataAPI.skills()).filter((skill) => !topicIsLocked(skill));
  const byProg = skills.slice().sort((a, b) => skillProgress(b.id) - skillProgress(a.id));
  // With every skill still at 0% (a brand-new account), sort() ties resolve
  // to catalog order — that would label skills №1-3 "strong" and №18-20
  // "needs attention" with zero real signal behind it. Show an honest empty
  // state instead of a ranking that looks meaningful but isn't.
  const hasSignal = byProg.some((sk) => skillProgress(sk.id) > 0);
  const strongest = hasSignal ? byProg.slice(0, 3) : [];
  // «Требуют внимания» — только реальные проблемы (ошибки / плохая точность),
  // а не темы с нулевым прогрессом: иначе свежий аккаунт после диагностики
  // получал бы здесь случайные нетронутые темы под видом слабых мест.
  const weakest = skills.filter((sk) => skillNeedsAttention(sk.id))
    .sort((a, b) => skillProgress(a.id) - skillProgress(b.id))
    .slice(0, 3);

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Статистика</div>
      <div class="page-sub">Аналитика подготовки: активность, точность и динамика прогноза.</div>
    </div>

    <div class="grid grid--4" style="margin-top:18px">
      <div class="card"><div class="stat-num mono">${s.totalSolved}</div><div class="stat-label">заданий решено</div></div>
      <div class="card"><div class="stat-num mono">${acc}%</div><div class="stat-label">точность</div></div>
      <div class="card"><div class="stat-num mono">${avgTime ? fmtTime(avgTime) : "—"}</div><div class="stat-label">среднее время</div></div>
      <div class="card"><div class="stat-num mono">${s.xp}</div><div class="stat-label">всего XP</div></div>
    </div>

    <div class="card" style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="font-weight:650">Использование помощи</div>
      <span class="chip">подсказка: ${s.hintLevels[1] || 0}</span>
      <span class="chip">разбор: ${s.hintLevels[2] || 0}</span>
      <span class="chip">ответ показан: ${s.hintLevels[3] || 0}</span>
      <span style="font-size:12px;color:var(--muted)">Уровни считаются по заданиям, дошедшим до соответствующей помощи.</span>
    </div>

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card chart-box">
        <div style="font-weight:650;margin-bottom:14px">Активность · 14 дней</div>
        ${activityChart()}
        <div class="chart-legend"><span><i style="background:var(--accent)"></i>решено заданий</span></div>
      </div>
      <div class="card chart-box">
        <div style="font-weight:650;margin-bottom:14px">Динамика прогноза балла</div>
        ${forecastChart()}
        <div class="chart-legend"><span><i style="background:var(--violet)"></i>сохранённые дневные оценки</span></div>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card">
        <div style="font-weight:650;margin-bottom:6px">Прогресс навыков</div>
        ${skills.map((sk) => `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
              <span>${sk.name}</span><span class="mono" style="color:var(--muted)">${skillProgress(sk.id)}%</span>
            </div>
            ${progressBar(skillProgress(sk.id), "progress--thin")}
          </div>`).join("")}
      </div>
      <div>
        <div class="card" style="margin-bottom:16px">
          <div style="font-weight:650;margin-bottom:10px">Сильные темы</div>
          ${hasSignal ? strongest.map((sk) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px"><span>${sk.name}</span><span class="chip chip--success mono">${skillProgress(sk.id)}%</span></div>`).join("")
            : `<div class="stat-label">Пока рано — пройди несколько заданий, чтобы увидеть сильные темы.</div>`}
        </div>
        <div class="card">
          <div style="font-weight:650;margin-bottom:10px">Требуют внимания</div>
          ${weakest.length ? weakest.map((sk) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px"><span>${sk.name}</span><span class="chip chip--danger mono">${skillProgress(sk.id)}%</span></div>`).join("")
            : hasSignal ? `<div class="stat-label">Слабых мест нет — все темы в хорошем состоянии.</div>`
            : `<div class="stat-label">Пока рано — пройди несколько заданий, чтобы увидеть слабые темы.</div>`}
        </div>
      </div>
    </div>`;
}

function last14Days() {
  // Activity is recorded under Moscow-date keys (todayActivity()/todayStr()),
  // regardless of the viewer's own timezone. Keying this chart off the local
  // browser date would silently miss or misplace a day's data for anyone not
  // in that timezone, so the same Moscow-date conversion is used here.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const key = dateKeyForTimestamp(Date.now() - i * 86400000);
    days.push({ key, label: key.slice(8), solved: (Store.state.activity[key] || {}).solved || 0 });
  }
  return days;
}

function activityChart() {
  const days = last14Days();
  const W = 520, H = 160, pad = 8;
  const max = Math.max(4, ...days.map((d) => d.solved));
  const bw = (W - pad * 2) / days.length;
  const bars = days.map((d, i) => {
    const h = (d.solved / max) * (H - 40);
    const x = pad + i * bw;
    const y = H - 24 - h;
    const isToday = i === days.length - 1;
    return `<rect x="${(x + bw * 0.18).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${isToday ? "var(--accent)" : "rgba(109,124,255,0.35)"}">
      <title>${d.label}: ${d.solved} заданий</title></rect>`;
  }).join("");
  const labels = days.filter((_, i) => i % 3 === 0 || i === days.length - 1).map((d) => {
    const i = days.indexOf(d);
    return `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--muted)" text-anchor="middle">${d.label}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${bars}${labels}</svg>`;
}

function forecastChart() {
  const points = forecastHistory();
  if (points.length < 2) {
    return `<div class="empty" style="min-height:130px;display:grid;place-items:center;text-align:center">История появится после второго дня подготовки. Здесь показываются только сохранённые дневные оценки.</div>`;
  }

  const W = 520, H = 160, pad = 12;
  const maxY = Math.max(...points.map((p) => p.mid)) + 2;
  const minY = Math.min(...points.map((p) => p.mid)) - 2;
  const span = Math.max(1, maxY - minY);
  const X = (i) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const Y = (v) => H - 20 - ((v - minY) / span) * (H - 44);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(p.mid).toFixed(1)}`).join(" ");
  const area = `${line} L${X(points.length - 1).toFixed(1)},${H - 20} L${X(0).toFixed(1)},${H - 20} Z`;
  const labels = points.map((p, i) => {
    if (i !== 0 && i !== points.length - 1 && i % 3 !== 0) return "";
    return `<text x="${X(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--muted)" text-anchor="middle">${p.date.slice(8)}</text>`;
  }).join("");
  const last = points[points.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="История прогноза балла">
    <defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(154,123,255,0.3)"/><stop offset="1" stop-color="rgba(154,123,255,0)"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#fg)"/>
    <path d="${line}" fill="none" stroke="var(--violet)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${X(points.length - 1)}" cy="${Y(last.mid)}" r="4" fill="var(--violet)"/>
    <text x="${X(points.length - 1)}" y="${Y(last.mid) - 10}" font-size="11" fill="var(--text-2)" text-anchor="end" class="mono">${last.low}–${last.high}</text>
    ${labels}
  </svg>`;
}

/* ============================================================
   Screen: Профиль + достижения
   ============================================================ */

function profileStatsTeaser(s, acc, avgTime) {
  const state = s || {};
  const f = safeForecast();
  let days = [];
  try { days = asSafeArray(last14Days()); } catch (_) { days = []; }
  const max = Math.max(1, ...days.map((d) => nonNegativeNumber(d && d.solved)));
  const hasActivity = days.some((d) => nonNegativeNumber(d && d.solved) > 0);
  const bars = hasActivity ? days.map((d, i) => {
    const value = nonNegativeNumber(d && d.solved);
    const pct = Math.max(6, Math.round(value / max * 100));
    const today = i === days.length - 1;
    return `<div class="stats-teaser__bar${today ? " stats-teaser__bar--today" : ""}" style="height:${pct}%" title="${esc(d.label || "День")}: ${value}"></div>`;
  }).join("") : `<div class="stats-teaser__no-activity">Активность появится после первого задания</div>`;
  const solved = nonNegativeNumber(state.totalSolved);
  const accuracy = solved ? Math.round(nonNegativeNumber(state.totalCorrect) / solved * 100) : null;
  // Один блок вместо пары «стат-грид + тизер»: те же данные без повторов
  // (решено/точность раньше дублировались в обоих).
  return `
    <div class="card card--glow stats-teaser">
      <div class="stats-teaser__head">
        <div class="stats-teaser__icon">${icon("stats")}</div>
        <div>
          <div class="stats-teaser__title">Статистика</div>
          <div class="stats-teaser__sub">Активность, точность и прогноз — полная аналитика в один тап</div>
        </div>
      </div>
      <div class="stats-teaser__metrics stats-teaser__metrics--6">
        <div class="stats-teaser__metric"><b class="mono">${solved}</b><span>решено</span></div>
        <div class="stats-teaser__metric"><b class="mono">${accuracy == null ? "—" : `${accuracy}%`}</b><span>${accuracy == null ? "пока нет ответов" : "точность"}</span></div>
        <div class="stats-teaser__metric"><b class="mono">${nonNegativeNumber(state.xp)}</b><span>всего XP</span></div>
        <div class="stats-teaser__metric"><b class="mono">${f.empty ? "—" : `${esc(f.low)}–${esc(f.high)}`}</b><span>прогноз</span></div>
        <div class="stats-teaser__metric"><b class="mono">${nonNegativeNumber(state.bestSeries)}</b><span>лучшая серия</span></div>
        <div class="stats-teaser__metric"><b class="mono">${avgTime ? fmtTime(avgTime) : "—"}</b><span>среднее время</span></div>
      </div>
      <div class="stats-teaser__bars" aria-hidden="true">${bars}</div>
      <div class="stats-teaser__bars-label"><span>Активность · 14 дней</span><span>Сегодня справа · темнее</span></div>
      <div class="stats-teaser__foot">
        <button class="btn btn--primary" type="button" onclick="go('stats')" aria-label="Открыть полную статистику">Открыть статистику ${icon("arrow")}</button>
      </div>
    </div>`;
}

function screenProfile(root) {
  const s = Store.state || {};
  const subjectState = subjectContentState();
  const contentUnavailable = subjectState.empty || subjectState.locked;
  const li = levelInfo();
  const solved = nonNegativeNumber(s.totalSolved);
  const acc = solved ? Math.round(nonNegativeNumber(s.totalCorrect) / solved * 100) : 0;
  const avgTime = solved ? Math.round(nonNegativeNumber(s.totalTimeSec) / solved) : 0;
  const accountId = Store.accountId || "";
  const name = s.name ? String(s.name).trim() : "";
  const initial = name ? esc(name.slice(0, 1).toUpperCase()) : "";
  const streak = nonNegativeNumber(s.streak);
  const timeline = asSafeArray(s.timeline);
  const achievements = asSafeArray(DataAPI.achievements());
  const profileLearningHTML = contentUnavailable
    ? subjectStateCardHTML(subjectState)
    : `${profileStatsTeaser(s, acc, avgTime)}
      <div class="section-title">Достижения</div>
      ${achievements.length ? `<div class="badge-grid">
        ${achievements.map((a) => {
          const un = achievementUnlocked(a.id);
          return `
          <div class="card badge-card ${un ? "" : "badge-card--locked"}">
            <div class="badge-icon">${icon(a.icon)}</div>
            <div class="badge-name">${esc(a.name || "Достижение")}</div>
            <div class="badge-desc">${esc(a.desc || "")}</div>
            ${un ? `<div style="margin-top:8px"><span class="chip chip--success">получено</span></div>` : `<div style="margin-top:8px"><span class="chip chip--locked">закрыто</span></div>`}
          </div>`;
        }).join("")}
      </div>` : `<div class="card empty">Достижения появятся вместе с материалами предмета.</div>`}`;

  const profileStreakHTML = contentUnavailable ? "" : `<div class="streak-chip profile-card__streak ${streakTier(streak)}">${icon("flame")} ${streak} дн</div>`;
  const profileProgressHTML = `
      <div class="profile-card__progress">
        <div class="profile-card__level">
          <span class="level-chip__badge">Уровень ${esc(li.level)}</span>
          <span class="profile-card__xp mono">${esc(nonNegativeNumber(li.current))} / ${esc(nonNegativeNumber(li.need))} XP</span>
          <span class="profile-card__next">до уровня ${esc(nonNegativeNumber(li.level) + 1)}</span>
        </div>
        ${progressBar(li.pct)}
        ${contentUnavailable ? `<div class="profile-card__locked-progress"><span class="chip chip--locked">${icon("lock")} Прогресс начнётся с первого задания</span></div>` : ""}
      </div>`;

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Профиль</div>
      <div class="page-sub">${contentUnavailable ? (subjectState.locked ? "Профиль предмета · материалы пока закрыты" : "Профиль предмета · материалы скоро") : "Твой путь в цифрах."}</div>
    </div>

    <div class="card card--glow profile-card">
      <div class="profile-card__identity">
        <div class="avatar" aria-hidden="true">${initial || icon("profile")}</div>
        <div class="profile-card__who">
          <div class="profile-card__name">${name ? esc(name) : "Без имени"}</div>
          <div class="account-id-wrap">
            <button class="account-id" type="button" data-account-id="${accountId}" onclick="copyAccountId(this)" aria-label="Скопировать ID аккаунта" ${accountId ? "" : "disabled"}>
              <span class="account-id__text">
                <span class="account-id__label">ID аккаунта</span>
                <span class="account-id__value mono">${accountId ? esc(accountId) : "—"}</span>
              </span>
              <span class="account-id__icon" aria-hidden="true">${icon("copy")}</span>
            </button>
            <span class="account-id__feedback" role="status">${icon("check")} ID скопирован</span>
          </div>
        </div>
        ${profileStreakHTML}
      </div>

      ${profileProgressHTML}
    </div>

    ${profileLearningHTML}

    <div class="grid grid--2" style="margin-top:34px">
      <div>
        <div class="section-title" style="margin-top:0">История прогресса</div>
        <div class="card">
          ${timeline.length ? `<div class="timeline">
            ${timeline.slice(0, 10).map((t) => `
              <div class="timeline__item">
                <div class="timeline__date">${relTime(t.ts)}</div>
                <div class="timeline__text">${esc(t && t.text || "Событие профиля")}</div>
              </div>`).join("")}
          </div>` : `<div class="empty">${contentUnavailable ? "События появятся после подключения материалов." : "Пока пусто — реши первое задание."}</div>`}
        </div>
      </div>
      <div>
        <div class="section-title" style="margin-top:0">Устройства</div>
        <div class="card settings-card" id="devices-card">
          <div class="settings-row__sub" id="devices-list">Загрузка устройств…</div>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:34px">Данные</div>
    <div class="card settings-card">
      <div class="settings-row">
        <div class="settings-row__icon" aria-hidden="true">${icon("shield")}</div>
        <div class="settings-row__body">
          <div class="settings-row__title">Аккаунт</div>
          ${accountAuthHTML()}
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row__icon" aria-hidden="true">${icon("layers")}</div>
        <div class="settings-row__body">
          <div class="settings-row__title">Предмет</div>
          <div class="settings-row__sub">Прогресс, ошибки и статистика хранятся отдельно по каждому предмету.</div>
          <div class="settings-row__control">
            ${subjectCurrentButtonHTML()}
          </div>
          ${subjectState.empty ? `<div class="settings-row__sub">Материалы этого предмета пока готовятся — как только выйдут, обучение начнётся с чистого профиля.</div>` : subjectState.locked ? `<div class="settings-row__sub">В реестре есть тема, но урок и практика пока не подключены. Пустые переходы скрыты.</div>` : ""}
        </div>
      </div>
      ${Store.auth && Store.auth.registered ? `
      <button class="settings-row settings-row--danger" type="button" onclick="askLogoutAccount()">
        <span class="settings-row__icon" aria-hidden="true">${icon("logout")}</span>
        <span class="settings-row__body">
          <span class="settings-row__title">Выйти из аккаунта</span>
          <span class="settings-row__sub">Прогресс не удалится и вернётся при следующем входе по email и паролю.</span>
        </span>
      </button>` : ""}
    </div>`;
  // Список сессий подгружаем отдельно: screenProfile синхронный, а устройства
  // требуют запроса к серверу. Кука HttpOnly уходит сама (same-origin).
  // Заодно сверяем auth-срез с сервером: вход/выход/отзыв сессии в другой
  // вкладке меняет куку мимо этого таба, и без сверки кнопка «Выйти из
  // аккаунта» иногда отсутствует при живой сессии (или наоборот).
  try { loadDevicesSection(); } catch (_) {}
  try { revalidateProfileAuth(); } catch (_) {}
}

/* Лёгкая сверка auth-среза профиля с сервером (GET /api/auth/session, без
   минта аккаунта). Прогресс/состояние не трогаем — только чиним stale
   Store.auth и перерисовываем профиль, чтобы кнопка выхода соответствовала
   серверной правде. Полный refreshAfterAuth здесь не нужен и опасен посреди
   тренировки (подмена снапшота), поэтому при активной сессии/уроке только
   обновляем срез — следующий переход и так перерисует. */
let profileAuthCheckInFlight = null;
let profileAuthCheckAt = 0;

function revalidateProfileAuth() {
  if (typeof currentRoute === "function" && currentRoute() !== "profile") return Promise.resolve();
  if (profileAuthCheckInFlight) return profileAuthCheckInFlight;
  if (Date.now() - profileAuthCheckAt < 15000) return Promise.resolve();
  profileAuthCheckAt = Date.now();
  profileAuthCheckInFlight = (async () => {
    let session = null;
    try { session = await AuthAPI.session(); } catch (_) { return; }
    if (typeof currentRoute === "function" && currentRoute() !== "profile") return;
    const u = (session && session.user) || null;
    const reg = !!(u && u.registered);
    const email = (u && u.email) || null;
    const cur = Store.auth || { registered: false, email: null };
    if (!!cur.registered === reg && (cur.email || null) === email) {
      // Auth-срез совпал, но серверный isAdmin мог измениться в другой вкладке
      // (вход в /admin): синхронизируем молча, без перерисовки посреди профиля.
      if (session && typeof session.isAdmin === "boolean" && Store.isAdmin !== session.isAdmin) {
        Store.isAdmin = session.isAdmin;
        if (!session.isAdmin) { try { AdminInbox.reset(); } catch (_) {} }
      }
      return;
    }
    Store.auth = { registered: reg, email };
    if (session && typeof session.isAdmin === "boolean" && Store.isAdmin !== session.isAdmin) {
      Store.isAdmin = session.isAdmin;
      if (!session.isAdmin) { try { AdminInbox.reset(); } catch (_) {} }
    }
    const busy = (typeof Session !== "undefined" && Session && Session.cur)
      || (typeof Lesson !== "undefined" && Lesson && Lesson.cur);
    if (!busy && typeof currentRoute === "function" && currentRoute() === "profile") {
      try { render(); } catch (_) {}
    }
  })().catch(() => {}).finally(() => { profileAuthCheckInFlight = null; });
  return profileAuthCheckInFlight;
}

/* Сверка админ-признака, пока блок «Обращения» на экране. Сессия могла
   истечь/быть отозвана в другой вкладке или на другом устройстве, пока вкладка
   лежала в фоне: тогда сервер вернёт isAdmin=false, и мы обязаны снять блок и
   вычистить кэш, иначе в UI остались бы чужие (уже недопустимые) данные.
   Работает только когда блок был виден, с троттлингом, без полного re-render
   посреди тренировки. */
let adminSessionCheckInFlight = null;
let adminSessionCheckAt = 0;

function clearAdminInboxNow() {
  try { Store.isAdmin = false; } catch (_) {}
  try { AdminInbox.reset(); } catch (_) {}
  try {
    const node = document.getElementById("adminInbox");
    if (node) node.remove();
  } catch (_) {}
}

function revalidateAdminSession() {
  let visible = false;
  try { visible = Store.isAdmin === true; } catch (_) { return Promise.resolve(); }
  if (!visible) return Promise.resolve();
  if (adminSessionCheckInFlight) return adminSessionCheckInFlight;
  if (Date.now() - adminSessionCheckAt < 10000) return Promise.resolve();
  adminSessionCheckAt = Date.now();
  adminSessionCheckInFlight = (async () => {
    let payload = null;
    try { payload = await AuthAPI.session(); } catch (_) { return; }
    if (!payload || payload.isAdmin === true) return;
    clearAdminInboxNow();
  })().catch(() => {}).finally(() => { adminSessionCheckInFlight = null; });
  return adminSessionCheckInFlight;
}

function scheduleAdminSessionWatch() {
  try {
    if (typeof setInterval === "function") {
      setInterval(() => { revalidateAdminSession(); }, 60000);
    }
  } catch (_) {}
}

/* ============================================================
   Устройства: активные серверные сессии текущего аккаунта.
   Показываем только готовые название/тип с сервера — сырой User-Agent
   никогда не хранится и не отображается. Отзыв чужой сессии инвалидирует
   её токен серверно, текущая сессия при этом не ломается; отзыв текущей
   сессии эквивалентен выходу из аккаунта.
   ============================================================ */

function deviceIconFor(type) {
  if (type === "phone") return "phone";
  if (type === "tablet") return "tablet";
  if (type === "laptop") return "laptop";
  return "desktop";
}

function formatDeviceTime(ts) {
  const ms = Number(ts);
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return String(ms);
  }
}

async function loadDevicesSection() {
  const box = document.getElementById("devices-list");
  if (!box) return;
  let payload;
  try {
    payload = await AuthAPI.devices();
  } catch (_) {
    box.textContent = "Не удалось загрузить устройства. Проверь соединение и обнови страницу.";
    return;
  }
  const devices = (payload && payload.devices) || [];
  // Кэш для confirm-модалки: имя/тип подставляем из него, а не из onclick —
  // не нужно экранировать строки в атрибутах.
  try { devicesCache = devices; } catch (_) {}
  if (!devices.length) {
    box.textContent = "Активных устройств нет.";
    return;
  }
  box.innerHTML = devices.map((d) => `
    <div class="settings-row settings-row--action" data-device-id="${esc(String(d.id))}"
      role="button" tabindex="0" title="Подробнее об устройстве"
      onclick="openDeviceInfo(${Number(d.id)})"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openDeviceInfo(${Number(d.id)})}">
      <div class="settings-row__icon" aria-hidden="true">${icon(deviceIconFor(d.type))}</div>
      <div class="settings-row__body">
        <div class="settings-row__title">${esc(d.name || "Браузер")}
          ${d.current ? `<span class="chip chip--success" style="margin-left:8px">это устройство</span>` : ""}
        </div>
        <div class="settings-row__sub">Последняя активность: ${esc(formatDeviceTime(d.lastSeenAt))}</div>
      </div>
      <div class="settings-row__control">
        <button class="btn btn--soft btn--sm" type="button"
          onclick="event.stopPropagation();openDeviceInfo(${Number(d.id)})"
          aria-label="${d.current ? "Подробнее и выйти на этом устройстве" : "Подробнее об устройстве " + esc(d.name || "Браузер")}">
          ${d.current ? "Выйти" : "Завершить"}
        </button>
      </div>
    </div>`).join("");
}

/* Кэш списка устройств для инфо-диалога (имя/тип/флаг current). */
let devicesCache = [];
let deviceModalPrevFocus = null;

function deviceTypeLabel(type) {
  if (type === "phone") return "Телефон";
  if (type === "tablet") return "Планшет";
  if (type === "laptop") return "Ноутбук";
  return "Компьютер";
}

function deviceModalRoot() {
  // Штатный контейнер живёт в index.html рядом с modal-root; если страница
  // приехала из старого кэша без него — создаём на лету, чтобы диалог всё
  // равно открылся.
  let root = null;
  try { root = document.getElementById("device-modal-root"); } catch (_) { root = null; }
  if (!root) {
    try {
      root = document.createElement("div");
      root.id = "device-modal-root";
      document.body.appendChild(root);
    } catch (_) { return null; }
  }
  return root;
}

/* Инфо-диалог устройства: отдельное центрированное окно с блюром (не
   bottom-sheet openModal). Тап по строке открывает информацию, завершение
   сессии — только через второй шаг-подтверждение внутри этого же окна. */
function openDeviceInfo(id) {
  const root = deviceModalRoot();
  if (!root) return;
  const d = (devicesCache || []).find((x) => Number(x.id) === Number(id)) || null;
  if (!d) return;
  const name = d.name || "Браузер";
  const isCurrent = !!d.current;
  deviceModalPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.innerHTML = `
    <div class="dlg-backdrop" onclick="if(event.target===this)closeDeviceModal()">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="Устройство ${esc(name)}">
        <button class="dlg__close" type="button" onclick="closeDeviceModal()" aria-label="Закрыть окно">${icon("x")}</button>
        <div class="dlg__eyebrow">Устройство${isCurrent ? ` · <span class="chip chip--success">это устройство</span>` : ""}</div>
        <div class="dlg-device">
          <div class="dlg-device__icon" aria-hidden="true">${icon(deviceIconFor(d.type))}</div>
          <div class="dlg-device__name">${esc(name)}</div>
        </div>
        <div class="dlg-kv">
          <div class="dlg-kv__row"><span>Тип</span><span>${esc(deviceTypeLabel(d.type))}</span></div>
          <div class="dlg-kv__row"><span>Последняя активность</span><span>${esc(formatDeviceTime(d.lastSeenAt))}</span></div>
          <div class="dlg-kv__row"><span>Подключено</span><span>${esc(formatDeviceTime(d.createdAt))}</span></div>
        </div>
        <div class="dlg__actions">
          <button class="btn btn--soft" type="button" onclick="closeDeviceModal()">Закрыть</button>
          <button class="btn btn--danger-soft" type="button" onclick="deviceModalAskConfirm(${Number(d.id)})">${isCurrent ? "Выйти" : "Завершить"}</button>
        </div>
      </div>
    </div>`;
  document.addEventListener("keydown", deviceModalEscHandler);
  const dlg = root.querySelector(".dlg");
  if (dlg) { dlg.setAttribute("tabindex", "-1"); dlg.focus({ preventScroll: true }); }
}

function deviceModalAskConfirm(id) {
  const root = deviceModalRoot();
  if (!root) return;
  const d = (devicesCache || []).find((x) => Number(x.id) === Number(id)) || null;
  if (!d) { closeDeviceModal(); return; }
  const name = d.name || "Браузер";
  const isCurrent = !!d.current;
  root.innerHTML = `
    <div class="dlg-backdrop" onclick="if(event.target===this)closeDeviceModal()">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="Подтверждение">
        <button class="dlg__close" type="button" onclick="closeDeviceModal()" aria-label="Закрыть окно">${icon("x")}</button>
        <div class="dlg__eyebrow">Подтверждение</div>
        <div class="dlg-device">
          <div class="dlg-device__icon" aria-hidden="true">${icon(deviceIconFor(d.type))}</div>
          <div class="dlg-device__name">${isCurrent ? "Выйти на этом устройстве?" : "Завершить сессию?"}</div>
        </div>
        <div class="dlg__text">
          ${isCurrent
            ? `Сессия «${esc(name)}» завершится — ты выйдешь из аккаунта здесь. Прогресс уже сохранён и останется доступен на других устройствах.`
            : `Устройство <b>${esc(name)}</b> выйдет из аккаунта, для продолжения ему придётся войти заново. Твоя текущая сессия не прервётся.`}
        </div>
        <div class="dlg__actions">
          <button class="btn btn--soft" type="button" onclick="openDeviceInfo(${Number(d.id)})">Отмена</button>
          <button class="btn btn--danger-soft" type="button" onclick="deviceModalRevoke(${Number(d.id)})">${isCurrent ? "Выйти" : "Завершить"}</button>
        </div>
      </div>
    </div>`;
  const dlg = root.querySelector(".dlg");
  if (dlg) { dlg.setAttribute("tabindex", "-1"); dlg.focus({ preventScroll: true }); }
}

async function deviceModalRevoke(id) {
  try { closeDeviceModal(); } catch (_) {}
  await revokeDeviceSession(Number(id));
}

function deviceModalEscHandler(e) {
  if (e.key === "Escape") closeDeviceModal();
}

function closeDeviceModal() {
  const root = document.getElementById("device-modal-root");
  try { dlgConfirmPending = null; } catch (_) {}
  if (!root || !root.innerHTML) return;
  root.innerHTML = "";
  document.removeEventListener("keydown", deviceModalEscHandler);
  if (deviceModalPrevFocus && deviceModalPrevFocus.isConnected) {
    deviceModalPrevFocus.focus({ preventScroll: true });
  }
  deviceModalPrevFocus = null;
}

/* Единый диалог подтверждения на той же системе, что и инфо-диалог
   устройства (device-modal-root + .dlg-backdrop/.dlg): выход из аккаунта
   в профиле и кнопки «Выйти» в тренировке/уроке/практике/миссии/боссе.
   Никаких браузерных вызовов подтверждения — один визуальный стиль везде. */
let dlgConfirmPending = null;

function openConfirmDialog(opts) {
  const o = opts || {};
  const onConfirm = typeof o.onConfirm === "function" ? o.onConfirm : null;
  const root = deviceModalRoot();
  if (!root) { if (onConfirm) onConfirm(); return; }
  dlgConfirmPending = onConfirm;
  try {
    if (!(deviceModalPrevFocus && deviceModalPrevFocus.isConnected)) {
      deviceModalPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  } catch (_) {}
  const iconName = o.iconName || "logout";
  const eyebrow = o.eyebrow || "Подтверждение";
  const title = o.title || "Подтвердить действие?";
  const text = o.text || "";
  const cancelText = o.cancelText || "Отмена";
  const confirmText = o.confirmText || "Подтвердить";
  const danger = o.danger === false ? "" : " btn--danger-soft";
  root.innerHTML = `
    <div class="dlg-backdrop" onclick="if(event.target===this)closeDeviceModal()">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <button class="dlg__close" type="button" onclick="closeDeviceModal()" aria-label="Закрыть окно">${icon("x")}</button>
        <div class="dlg__eyebrow">${esc(eyebrow)}</div>
        <div class="dlg-device">
          <div class="dlg-device__icon" aria-hidden="true">${icon(iconName)}</div>
          <div class="dlg-device__name">${esc(title)}</div>
        </div>
        ${text ? `<div class="dlg__text">${text}</div>` : ""}
        <div class="dlg__actions">
          <button class="btn btn--soft" type="button" onclick="closeDeviceModal()">${esc(cancelText)}</button>
          <button class="btn${danger}" type="button" onclick="dlgConfirmOk()">${esc(confirmText)}</button>
        </div>
      </div>
    </div>`;
  document.removeEventListener("keydown", deviceModalEscHandler);
  document.addEventListener("keydown", deviceModalEscHandler);
  const dlg = root.querySelector(".dlg");
  if (dlg) { dlg.setAttribute("tabindex", "-1"); dlg.focus({ preventScroll: true }); }
}

function dlgConfirmOk() {
  const fn = dlgConfirmPending;
  dlgConfirmPending = null;
  try { closeDeviceModal(); } catch (_) {}
  if (fn) { try { fn(); } catch (_) {} }
}

/* Выход из аккаунта через общий диалог (кнопка в профиле зовёт сюда,
   сам logoutAccount остаётся прямым выходом — его дёргает подтверждение). */
function askLogoutAccount() {
  openConfirmDialog({
    eyebrow: "Выход из аккаунта",
    title: "Выйти из аккаунта?",
    text: "Прогресс не удалится и вернётся при следующем входе по email и паролю.",
    iconName: "logout",
    cancelText: "Отмена",
    confirmText: "Выйти",
    onConfirm: () => logoutAccount(),
  });
}

/* Выход из тренировки/практики/миссии/босса через общий диалог.
   Сам sessionQuit остаётся прямым выходом (его дёргает подтверждение). */
function askSessionQuit() {
  let mode = null, hasProgress = false;
  try { mode = Session.cur ? Session.cur.mode : null; } catch (_) {}
  try { hasProgress = !!(Session.cur && Session.cur.results && Session.cur.results.length); } catch (_) {}
  const title = mode === "boss" ? "Покинуть испытание?"
    : mode === "mission" ? "Покинуть миссию?"
    : "Выйти из тренировки?";
  openConfirmDialog({
    eyebrow: "Завершение",
    title,
    text: hasProgress
      ? "Текущий результат и прогресс будут сохранены."
      : "Прогресс будет сохранён, ничего не потеряется.",
    iconName: "logout",
    cancelText: "Остаться",
    confirmText: "Выйти",
    onConfirm: () => sessionQuit(),
  });
}

/* Выход из урока (изучение темы) через общий диалог.
   Сам lessonQuit остаётся прямым выходом (его дёргает подтверждение). */
function askLessonQuit() {
  openConfirmDialog({
    eyebrow: "Урок",
    title: "Выйти из урока?",
    text: "Текущий ответ и прогресс будут сохранены.",
    iconName: "logout",
    cancelText: "Остаться",
    confirmText: "Выйти",
    onConfirm: () => lessonQuit(),
  });
}

async function revokeDeviceSession(id) {
  const cached = (devicesCache || []).find((x) => Number(x.id) === Number(id)) || null;
  const wasCurrent = !!(cached && cached.current);
  try {
    const result = await AuthAPI.revokeDevice(id);
    if ((result && result.current) || wasCurrent) {
      // Текущая сессия завершена серверно (кука уже сброшена) — уходим в
      // гостевой профиль тем же путём, что и обычный выход из аккаунта.
      // Сессии/уроки прежнего аккаунта недействительны — сбрасываем их и
      // localStorage-слепок, иначе новый гость увидит чужие задания.
      try { Session.cur = null; } catch (_) {}
      try { deactivateLessonClock(); } catch (_) {}
      try { localStorage.removeItem("ege_core_session"); } catch (_) {}
      if (typeof pendingSubjectChoice !== "undefined") { try { pendingSubjectChoice = false; } catch (_) {} }
      try { sessionStorage.removeItem("ege_login_subject_pending"); } catch (_) {}
      try { sessionStorage.removeItem("ege_onboard_preset_subject"); } catch (_) {}
      try { if (typeof Onboarding !== "undefined" && Onboarding) Onboarding.presetSubject = null; } catch (_) {}
      await Store.refreshAfterAuth();
      toast("Вы вышли из аккаунта на этом устройстве.", "", "check");
      go("login");
      return;
    }
    toast("Выход на выбранном устройстве завершён.", "", "check");
    await loadDevicesSection();
  } catch (error) {
    toast("Не удалось завершить выход. Попробуй ещё раз.", "toast--error", "x");
  }
}

/* ============================================================
   Аккаунт: статус в профиле, вход/регистрация/выход
   Гость пользуется сайтом без регистрации; auth — добровольная
   привязка текущего профиля, чтобы не зависеть от куки на одном
   устройстве. Идентичность всегда решает сервер по сессии.
   ============================================================ */

function accountAuthHTML() {
  const auth = Store.auth || { registered: false, email: null };
  if (auth.registered) {
    return `
      <div class="auth-status" style="margin-top:8px">
        <span class="chip chip--success">${icon("check")} привязан</span>
        <span class="auth-status__email mono">${esc(auth.email || "")}</span>
      </div>
      <div class="settings-row__sub" style="margin-top:6px">На одном аккаунте можно учить сразу несколько предметов — прогресс по каждому сохраняется отдельно.</div>`;
  }
  return `
    <div class="settings-row__sub">Гостевой профиль — прогресс привязан к этому устройству.</div>
    <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn--primary btn--sm" onclick="go('register')">Войти или зарегистрироваться</button>
    </div>`;
}

/* Выбор предмета при входе. Флаг живёт в памяти вкладки (+ дублируется в
   sessionStorage на случай перезагрузки посреди пикера): ставится только
   действием login, обычный refresh и авто-логин его не видят. Регистрация
   флаг не трогает — её flow сам спрашивает предмет в онбординге. */
let pendingSubjectChoice = false;

// Смена предмета уже летит — повторные клики игнорируем, иначе два
// параллельных POST устроят гонку каталогов и двойной save.
let subjectSwitching = false;

function authScreenShell(title, sub, body) {
  return `
    <div class="auth-screen">
      <div class="card card--glow auth-card">
        <div class="auth-card__title">${title}</div>
        <div class="auth-card__sub">${sub}</div>
        ${body}
      </div>
    </div>`;
}

function screenLogin(root) {
  if (Store.auth && Store.auth.registered) {
    root.innerHTML = authScreenShell("Вы уже вошли",
      `Текущая сессия привязана к ${esc(Store.auth.email || "аккаунту")}.`,
      `<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
         <button class="btn btn--primary" onclick="go('profile')">В профиль</button>
       </div>`);
    return;
  }
  root.innerHTML = authScreenShell("Вход",
    "Войди в существующий аккаунт — весь прогресс и настройки вернутся.",
    `
    <form class="auth-form" onsubmit="submitLogin(event)">
      <label class="auth-field"><span>Email</span>
        <input class="answer-input" type="email" name="email" autocomplete="email" required>
      </label>
      <label class="auth-field"><span>Пароль</span>
        <input class="answer-input" type="password" name="password" autocomplete="current-password" required>
      </label>
      <div class="auth-form__error" id="auth-error" role="alert"></div>
      <button class="btn btn--primary btn--lg" type="submit" id="auth-submit">Войти</button>
    </form>
    <div class="auth-note">Гостевой прогресс на этом устройстве не переносится в существующий аккаунт.
      Чтобы сохранить его, <a href="#/register" onclick="go('register');return false">зарегистрируйтесь</a>.</div>
    <div class="auth-switch">Нет аккаунта? <a href="#/register" onclick="go('register');return false">Зарегистрироваться</a></div>`);
  const first = root.querySelector("input[name=email]");
  if (first) first.focus();
}

function screenRegister(root) {
  if (Store.auth && Store.auth.registered) {
    root.innerHTML = authScreenShell("Аккаунт уже создан",
      `Текущая сессия привязана к ${esc(Store.auth.email || "аккаунту")}.`,
      `<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
         <button class="btn btn--primary" onclick="go('profile')">В профиль</button>
       </div>`);
    return;
  }
  root.innerHTML = authScreenShell("Регистрация",
    "Текущий гостевой профиль целиком переедет в аккаунт: XP, уровень, прогресс, ошибки и достижения.",
    `
    <form class="auth-form" onsubmit="submitRegister(event)">
      <label class="auth-field"><span>Имя</span>
        <input class="answer-input" type="text" name="name" autocomplete="name" maxlength="${NAME_MAX_LENGTH}" required value="${esc((Store.state && Store.state.name) || "")}">
      </label>
      <label class="auth-field"><span>Email</span>
        <input class="answer-input" type="email" name="email" autocomplete="email" required>
      </label>
      <label class="auth-field"><span>Пароль (минимум 8 символов)</span>
        <input class="answer-input" type="password" name="password" autocomplete="new-password" minlength="8" required>
      </label>
      <div class="auth-form__error" id="auth-error" role="alert"></div>
      <button class="btn btn--primary btn--lg" type="submit" id="auth-submit">Создать аккаунт</button>
    </form>
    <div class="auth-switch">Уже есть аккаунт? <a href="#/login" onclick="go('login');return false">Войти</a></div>`);
  const first = root.querySelector((Store.state && Store.state.name) ? "input[name=email]" : "input[name=name]");
  if (first) first.focus();
}

function screenLoginSubject(root) {
  if (!Store.auth || !Store.auth.registered) {
    root.innerHTML = authScreenShell("Сначала войди",
      "Выбор предмета доступен после входа в аккаунт.",
      `<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
         <button class="btn btn--primary" onclick="go('login')">К входу</button>
       </div>`);
    return;
  }
  const subjects = asSafeArray(DataAPI.subjects());
  const cur = DataAPI.currentSubject();
  root.innerHTML = authScreenShell("Какой предмет открываем?",
    "Один аккаунт может использоваться на разных устройствах — выбери, с каким предметом продолжить. Прогресс каждого предмета хранится отдельно и никуда не денется.",
    `<div class="choice-list">
       ${subjects.map((s) => {
         const status = subjectAvailabilityLabel(s);
         return `<button class="choice-item${status ? " choice-item--soon" : ""}" onclick="chooseLoginSubject('${esc(s.id)}')"><b>${esc(subjectDisplayName(s))}${s.id === cur ? " · сейчас открыт" : ""}</b><span>${esc(subjectCourseLabel(s))}${status ? ` · ${esc(status)}` : ""}</span></button>`;
       }).join("")}
     </div>`);
}

async function chooseLoginSubject(id) {
  if (!id || subjectSwitching) return;
  subjectSwitching = true;
  try {
    // Мгновенный отклик: лоадер сразу, а не после ответа сети.
    try { document.getElementById("screen").innerHTML = loaderHTML("Открываем предмет…"); } catch (_) {}
    // Сессии и уроки другого предмета недействительны — сбрасываем до смены.
    try { Session.cur = null; } catch (_) {}
    try { pauseLessonClock(); } catch (_) {}
    try { Lesson.cur = null; } catch (_) {}
    try { localStorage.removeItem("ege_core_session"); } catch (_) {}
    // Явный выбор может оставить адрес без смены хэша (не-onboarded предмет) —
    // тогда render модалки не закроет, чистим явно.
    try { closeModal(); } catch (_) {}
    try { closeDeviceModal(); } catch (_) {}
    // Явный выбор применяется к сессии через POST /api/subject: каталог и
    // состояние заменяются целиком, прогресс других предметов не тронут.
    // Клик по уже открытому предмету — no-op внутри switchSubject, выбор
    // всё равно засчитан явно.
    await Store.switchSubject(id);
    subjectSwitching = false;
    pendingSubjectChoice = false;
    try { sessionStorage.removeItem("ege_login_subject_pending"); } catch (_) {}
    // Предмет выбран явно в пикере входа: онбординг не переспрашивает его.
    try {
      if (typeof Onboarding !== "undefined" && Onboarding) {
        Onboarding.presetSubject = id;
        try { sessionStorage.setItem("ege_onboard_preset_subject", id); } catch (_) {}
      }
    } catch (_) {}
    // Новый для аккаунта предмет может быть не onboarded — render сам
    // покажет онбординг этого предмета; иначе открываем сайт с выбором.
    if (!Store.state.onboarded) { render(); return; }
    if (location.hash && location.hash !== "#/dashboard") location.hash = "#/dashboard";
    render();
  } catch (error) {
    subjectSwitching = false;
    try { toast("Не удалось открыть предмет", "toast--error", "x"); } catch (_) {}
  }
}

function authFormFail(message) {
  const box = document.getElementById("auth-error");
  if (box) { box.textContent = message; box.classList.add("is-visible"); }
  const btn = document.getElementById("auth-submit");
  if (btn) btn.disabled = false;
}

function authFormBusy() {
  const box = document.getElementById("auth-error");
  if (box) { box.textContent = ""; box.classList.remove("is-visible"); }
  const btn = document.getElementById("auth-submit");
  if (btn) btn.disabled = true;
}

function authFormError(error, fallback) {
  const status = Number(error && error.status) || 0;
  const payloadCode = error && error.payload && error.payload.code ? String(error.payload.code) : "";
  const code = error && error.code ? String(error.code) : payloadCode;
  const expected = [400, 401, 409, 422, 429].includes(status) || code === "ACCOUNT_BLOCKED";
  const message = error && error.message ? String(error.message).trim() : "";
  const technical = /\b(?:api|endpoint|stack|traceback|exception)\b|request failed|fetch/i.test(message);
  const humanRussian = /[А-Яа-яЁё]/.test(message);
  return expected && humanRussian && message.length <= 300 && !technical ? message : fallback;
}

async function submitLogin(event) {
  event.preventDefault();
  authFormBusy();
  const form = event.target;
  try {
    await AuthAPI.login(form.email.value.trim(), form.password.value);
    // Сессии и уроки гостя недействительны под новым аккаунтом — сбрасываем
    // до смены, иначе чужые задания/позиция (и localStorage) пережили бы вход.
    try { Session.cur = null; } catch (_) {}
    try { deactivateLessonClock(); } catch (_) {}
    try { Lesson.cur = null; } catch (_) {}
    try { localStorage.removeItem("ege_core_session"); } catch (_) {}
    await Store.refreshAfterAuth();
    // Вход всегда ведёт через явный выбор предмета: один аккаунт может
    // открываться с разных устройств, поэтому сайт открывается с выбранным
    // предметом, а не с угаданным current_subject. Флаг дублируется в
    // sessionStorage, чтобы перезагрузка посреди пикера не теряла его;
    // обычный refresh после выбора флага уже не видит.
    pendingSubjectChoice = true;
    try { sessionStorage.setItem("ege_login_subject_pending", "1"); } catch (_) {}
    toast("Вы вошли в аккаунт", "", "check");
    go("subject");
  } catch (error) {
    authFormFail(authFormError(error, "Не удалось войти. Попробуй ещё раз."));
  }
}

async function submitRegister(event) {
  event.preventDefault();
  authFormBusy();
  const form = event.target;
  const password = form.password.value;
  if (password.length < 8) { authFormFail("Пароль — минимум 8 символов"); return; }
  try {
    await AuthAPI.register(form.name.value.trim(), form.email.value.trim(), password);
    await Store.refreshAfterAuth();
    toast("Аккаунт создан — весь прогресс сохранён", "", "check");
    go("profile");
  } catch (error) {
    authFormFail(authFormError(error, "Не удалось создать аккаунт. Попробуй ещё раз."));
  }
}

async function logoutAccount() {
  // Сначала закрываем таймер и сохраняем накопленное время ещё под старой
  // сессией; после смены cookie persist-вызовы уже недопустимы.
  pauseLessonClock();
  try {
    await AuthAPI.logout();
  } catch (firstError) {
    try { await AuthAPI.logout(); } catch (secondError) {
      toast("Не удалось выйти. Попробуй ещё раз.", "toast--error", "x");
      return;
    }
  }
  pendingSubjectChoice = false;
  try { sessionStorage.removeItem("ege_login_subject_pending"); } catch (_) {}
  try { sessionStorage.removeItem("ege_onboard_preset_subject"); } catch (_) {}
  try { if (typeof Onboarding !== "undefined" && Onboarding) Onboarding.presetSubject = null; } catch (_) {}
  // Сессии и уроки прежнего аккаунта недействительны — сбрасываем до смены,
  // иначе свежий гость унаследовал бы чужие задания/позицию (и localStorage).
  try { Session.cur = null; } catch (_) {}
  try { deactivateLessonClock(); } catch (_) {}
  try { localStorage.removeItem("ege_core_session"); } catch (_) {}
  // Admin-кэш прошлого аккаунта недействителен: трём до смены, чтобы чужой
  // inbox ни кадром не мелькнул в новой сессии. Флаг isAdmin приедет из
  // свежего bootstrap через refreshAfterAuth — fail-closed.
  try { AdminInbox.reset(); } catch (_) {}
  await Store.refreshAfterAuth();
  toast("Вы вышли из аккаунта. Прогресс сохранён.", "", "check");
  go("login");
}

/* ============================================================
   Onboarding — первый запуск
   ============================================================ */

const NAME_MAX_LENGTH = 60;

const Onboarding = {
  step: 0,
  subject: null,
  selfLevel: null,
  goal: null,
  name: null,
  diagIdx: 0,
  diagResults: [],
  diagAnswered: false,
  _picking: false,
  // Предмет, явно выбранный пользователем через профиль/пикер входа перед
  // показом онбординга нового предмета. После предложения теста show()
  // начинает с уровня, не переспрашивая предмет. Дублируется в sessionStorage
  // на случай перезагрузки посреди онбординга.
  presetSubject: null,
  // Предмет-шаг пропущен (старт с вопросов после явного выбора): кнопка
  // «Назад» на уровне скрыта — возвращаться некуда.
  subjectSkipped: false,
  // mode="subject" — сначала выбираем предмет, mode="offer" — предлагаем
  // тест, mode="diagnostic" — пользователь согласился, mode="skip" — отказался
  // и сейчас вводит имя.
  mode: "subject",
  // Откуда показан онбординг. login/subject/login-register — промежуточные
  // экраны, после них возвращаемся на дашборд, а не зацикливаем пикер.
  returnRoute: "dashboard",
  returnParam: "",

  // Нумерованные шаги после выбора предмета: уровень → цель → диагностика →
  // итог → имя. Предложение пройти или пропустить тест идёт между предметом
  // и уровнем. Пустой предмет идёт коротким путём: предмет → имя.
  STEPS() {
    return ["stepSubject", "stepLevel", "stepGoal", "stepDiagnostic", "stepResult", "stepName"];
  },

  captureReturnRoute() {
    let route = "dashboard";
    let param = "";
    try {
      const current = currentRoute();
      // Экран выбора предмета после входа — не конечная страница: возврат туда
      // снова заставил бы выбирать предмет повторно.
      if (current && !["login", "register", "subject"].includes(current)) {
        route = current;
        param = routeParam();
      }
    } catch (_) {}
    this.returnRoute = route || "dashboard";
    this.returnParam = param || "";
  },

  returnToPrevious() {
    go(this.returnRoute, this.returnParam || undefined);
  },

  show() {
    if (document.getElementById("onboard-overlay")) return;
    // Явный выбор предмета перед онбордингом (переключение через профиль
    // или пикер входа): предмет уже выбран. Сначала показываем предложение
    // теста, а при согласии сразу переходим к уровню, не переспрашивая предмет.
    // Флаг живёт в памяти + дублируется в sessionStorage на случай
    // перезагрузки посреди онбординга.
    let preset = this.presetSubject;
    this.presetSubject = null;
    if (!preset) {
      try { preset = sessionStorage.getItem("ege_onboard_preset_subject") || null; } catch (_) { preset = null; }
    }
    try { sessionStorage.removeItem("ege_onboard_preset_subject"); } catch (_) {}
    // Имя едино для аккаунта (users.name, не user_subjects): если оно уже
    // указано — в конце не спрашиваем, переиспользуем для finish().
    // Новый запуск чистит остальное: иначе после logout/смены аккаунта свежий
    // гость унаследовал бы subject/диагностику прежнего прохождения
    // (finish читает их как fallback). Повторный show при открытом оверлее —
    // тот же запуск, не трогаем (проверено выше).
    let existingName = "";
    try {
      existingName = (Store.state && Store.state.name)
        ? String(Store.state.name).trim().replace(/\s+/g, " ").slice(0, NAME_MAX_LENGTH)
        : "";
    } catch (_) { existingName = ""; }
    this.selfLevel = null;
    this.goal = null;
    this.name = existingName || null;
    this.diagIdx = 0;
    this.diagResults = [];
    this.diagAnswered = false;
    this._picking = false;
    this.step = 0;
    this.subject = null;
    this.subjectSkipped = false;
    // Без явно выбранного предмета сначала спрашиваем его. При явном
    // выборе из профиля/пикера входа сразу показываем предложение теста.
    this.mode = preset ? "offer" : "subject";
    this.captureReturnRoute();
    let current = null;
    try { current = (typeof DataAPI !== "undefined" && DataAPI.currentSubject) ? DataAPI.currentSubject() : null; } catch (_) {}
    if (preset && current && preset === current) {
      let info = null;
      try { info = DataAPI.subjectInfo(preset); } catch (_) {}
      if (info) {
        this.subject = preset;
        this.subjectSkipped = true;
        let ready = false;
        try { ready = !!(info && info.status === "ready" && DataAPI.diagnosticTasks().length); } catch (_) {}
        if (ready) {
          this.step = 1;
        } else if (existingName) {
          // Пустой предмет + имя уже есть: спрашивать нечего —
          // сразу заводим профиль без показа оверлея.
          this.step = 5;
          this.finish();
          return;
        } else {
          // У выбранного предмета ещё нет вопросов: предлагать пустой тест
          // бессмысленно, сразу спрашиваем обязательное имя.
          this.step = 5;
          this.mode = "diagnostic";
        }
      }
    }
    const div = document.createElement("div");
    div.className = "onboard-overlay";
    div.id = "onboard-overlay";
    document.body.appendChild(div);
    this.render();
  },

  hide() {
    const el = document.getElementById("onboard-overlay");
    if (el) el.remove();
  },

  // Переключение темы прямо с экрана регистрации: текущий шаг не
  // перерисовываем, чтобы не потерять введённый ответ/имя — обновляем
  // только иконку самой кнопки.
  toggleTheme() {
    Theme.toggle();
    const btn = document.querySelector("#onboard-overlay .onboard-theme");
    if (!btn) return;
    const dark = Theme.current() === "dark";
    const label = dark ? "Включить светлую тему" : "Включить тёмную тему";
    btn.innerHTML = icon(dark ? "sun" : "moon");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    btn.title = label;
  },

  render() {
    const el = document.getElementById("onboard-overlay");
    if (!el) return;
    const names = this.STEPS();
    const offering = this.mode === "offer";
    const method = offering ? "stepOffer" : names[this.step];
    const dark = Theme.current() === "dark";
    const themeLabel = dark ? "Включить светлую тему" : "Включить тёмную тему";
    // У locked/empty-предмета нет уровня, цели и диагностики: не рисуем шесть
    // «пройденных» шагов, которых пользователь не проходил. После явного
    // выбора такого предмета остаётся короткий честный поток «предмет → имя».
    let shortSubjectFlow = false;
    try { shortSubjectFlow = !offering && !!this.subject && subjectLearningUnavailable(); } catch (_) {}
    const nameStep = Math.max(0, names.indexOf("stepName"));
    const stepCount = shortSubjectFlow ? 2 : names.length;
    const stepIndex = shortSubjectFlow ? (this.step >= nameStep ? 1 : 0) : this.step;
    const stepDots = Array.from({ length: stepCount }, (_, i) => `<i class="${i <= stepIndex ? "on" : ""}"></i>`).join("");
    // Вышедший из аккаунта, но попавший в онбординг: вход/регистрация
    // доступны без прохождения. На предложении теста и первых двух шагах
    // показываем ссылку, дальше она отвлекает от вопросов.
    // У привязанного аккаунта её нет.
    let showAuth = offering || this.step <= 1;
    try { showAuth = showAuth && !(Store.auth && Store.auth.registered); } catch (_) {}
    el.innerHTML = `
      <button class="btn btn--ghost theme-toggle onboard-theme" type="button" onclick="Onboarding.toggleTheme()" aria-label="${themeLabel}" aria-pressed="${dark}" title="${themeLabel}">${icon(dark ? "sun" : "moon")}</button>
      <div class="onboard-card">
        ${offering ? "" : `<div class="onboard-steps${shortSubjectFlow ? " onboard-steps--short" : ""}" aria-hidden="true">${stepDots}</div>`}
        <div id="onboard-body"></div>
        ${showAuth ? `<div class="onboard-auth"><span>Уже есть аккаунт?</span><button class="btn btn--primary btn--sm" type="button" onclick="go('login')">Войти или зарегистрироваться</button></div>` : ""}
      </div>`;
    const body = el.querySelector("#onboard-body");
    // Смена предмета привозит лёгкий каталог: тексты заданий диагностики
    // догружаются лениво через ensureDetails. Вопросы без них не показываем —
    // лоадер вместо пустой карточки; итог тоже ждёт детали.
    if (!offering && (method === "stepDiagnostic" || method === "stepResult")
        && typeof DataAPI !== "undefined" && !DataAPI.detailsReady()
        && typeof Store !== "undefined" && Store.ensureDetails) {
      body.innerHTML = loaderHTML("Готовим задания…");
      Store.ensureDetails().then(() => {
        try { if (document.getElementById("onboard-overlay")) this.render(); } catch (_) {}
      }).catch(() => {
        try {
          body.innerHTML = `<div class="card" style="max-width:420px;margin:24px auto;text-align:center">Не удалось загрузить задания.<br><button class="btn btn--primary btn--sm" style="margin-top:12px" onclick="Onboarding.render()">Попробовать снова</button></div>`;
        } catch (_) {}
      });
      return;
    }
    this[method].call(this, body);
    // Диагностика рисует задания через taskVisualHtml → data-mathvisual,
    // но общий render() возвращается раньше NEEDS_DETAILS-гейта и никогда не
    // зовёт Vendor.ensureMath() для онбординга. Без этого window.MathVisual
    // не появляется, MathVisualMount.mount() пропускает хосты и плейсхолдер
    // навсегда остаётся на «Рисунок загружается…». Подтягиваем вендор здесь;
    // ensureMath сам домонтирует уже нарисованное, наблюдатель подхватит
    // следующие шаги, при офлайне показываем читаемую ошибку вместо вечного
    // спиннера.
    if (method === "stepDiagnostic") {
      try {
        Vendor.ensureMath().then(() => {
          try { MathVisualMount.mountWithin(el); } catch (_) {}
        }).catch(() => {
          try { MathVisualMount.failUnmounted(el); } catch (_) {}
        });
      } catch (_) {}
    }
  },

  // После выбора предмета показываем отдельный выбор: тест полезен для
  // стартовой карты, но не является обязательным.
  stepOffer(body) {
    const count = DataAPI.diagnosticTasks().length;
    body.innerHTML = `
      <div class="onboard-title">Хочешь пройти небольшой тест?</div>
      <div class="onboard-sub">Всего ${count} ${plural(count, "вопрос", "вопроса", "вопросов")} по разным темам. Он поможет определить начальный уровень и точнее настроить рекомендации. Но ответы не обязательны: уроки, тренировки и статистика доступны в любом случае.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:26px">
        <button class="btn btn--primary btn--lg" type="button" onclick="Onboarding.acceptTest()">Пройти тест ${icon("arrow")}</button>
        <button class="btn btn--ghost btn--lg" type="button" onclick="Onboarding.skipTest()">Пропустить</button>
      </div>`;
  },

  acceptTest() {
    this.mode = "diagnostic";
    this.render();
  },

  skipTest() {
    this.mode = "skip";
    if (this.name) { this.finishSkipped(); return; }
    this.step = 5;
    this.render();
  },

  finishSkipped() {
    const finalName = this.name || (Store.state && Store.state.name) || null;
    this.hide();
    try { sessionStorage.removeItem("ege_onboard_preset_subject"); } catch (_) {}
    completeOnboardingWithoutTest(DataAPI.currentSubject() || Store.subject || "profile_math", finalName);
    this.returnToPrevious();
  },

  // Первый вопрос — предмет, а не уровень: уровень — характеристика внутри
  // предмета и не должен его определять.
  stepSubject(body) {
    const subjects = asSafeArray(DataAPI.subjects());
    body.innerHTML = `
      <div class="onboard-title">Какой предмет готовим?</div>
      <div class="onboard-sub">Прогресс и настройки ведутся отдельно по каждому предмету.</div>
      <div class="choice-list">
        ${subjects.map((s) => {
          const status = subjectAvailabilityLabel(s);
          return `<button class="choice-item${status ? " choice-item--soon" : ""}" onclick="Onboarding.pickSubject('${esc(s.id)}')"><b>${esc(subjectDisplayName(s))}</b><span>${esc(subjectCourseLabel(s))}${status ? ` · ${esc(status)}` : ""}</span></button>`;
        }).join("")}
      </div>`;
  },

  pickSubject(v) {
    this.subject = v;
    // Предмет выбран явно на его же шаге — пропуск снят: с уровня можно
    // вернуться к выбору предмета.
    this.subjectSkipped = false;
    // Цель из шкалы другого предмета недействительна (сервер отклоняет чужую
    // цель 400-й вместе со всей настройкой) — выбор цели делаем заново.
    this.goal = null;
    if (this._picking) return;
    this._picking = true;
    // Шаги ниже (цели, диагностика) — предметные данные из каталога. Переключаем
    // каталог сразу, а не в finish(): иначе цель и диагностика показываются от
    // старого предмета, а выбранная чужая цель не сохраняется сервером.
    // finish() после этого видит свой предмет текущим и просто применяет профиль.
    Store.switchSubject(v).catch(() => {}).then(() => {
      this._picking = false;
      const info = DataAPI.subjectInfo(v);
      const ready = info && info.status === "ready" && DataAPI.diagnosticTasks().length;
      // Пустой предмет: уровень/цель/диагностика бессмысленны без контента —
      // сразу к имени, профиль предмета заведётся пустым. Имя едино для
      // аккаунта: если уже указано — не показываем шаг имени, а завершаем.
      if (!ready) {
        this.step = 5;
        if (this.name) { this.finish(); return; }
        this.mode = "diagnostic";
        this.render();
        return;
      }
      // Сначала пользователь выбирает предмет, и только потом решает, нужен
      // ли ему короткий тест. После согласия начинается прежний flow с уровня.
      this.step = 1;
      this.mode = "offer";
      this.render();
    });
  },

  stepLevel(body) {
    // Формулировки без привязки к «частям» экзамена: подходят и профилю
    // (первая/вторая часть), и базе (21 задание с кратким ответом).
    body.innerHTML = `
      <div class="onboard-title">Какой у тебя текущий уровень?</div>
      <div class="onboard-sub">Честный ответ поможет точнее выставить стартовые навыки.</div>
      <div class="choice-list">
        <button class="choice-item" onclick="Onboarding.pickLevel('zero')"><b>Начинаю с нуля</b><span>База школьной программы неустойчива</span></button>
        <button class="choice-item" onclick="Onboarding.pickLevel('base')"><b>Базовый уровень</b><span>Простые задания получаются, сложные — с трудом</span></button>
        <button class="choice-item" onclick="Onboarding.pickLevel('confident')"><b>Уверенный</b><span>Решаю стабильно, хочу скорости и сложных тем</span></button>
      </div>
      ${this.backHtml()}`;
  },

  stepGoal(body) {
    body.innerHTML = `
      <div class="onboard-title">Какая цель по баллам?</div>
      <div class="onboard-sub">Сохраним её в профиле как ориентир подготовки.</div>
      <div class="choice-list">
        ${DataAPI.goals().map((g) => `<button class="choice-item" onclick="Onboarding.pickGoal('${g.id}')"><b>${g.label}</b><span>${g.desc}</span></button>`).join("")}
      </div>
      ${this.backHtml()}`;
  },

  stepDiagnostic(body) {
    const diagnosticTasks = DataAPI.diagnosticTasks();
    const t = DataAPI.task(diagnosticTasks[this.diagIdx]);
    this.diagAnswered = false;
    body.innerHTML = `
      <div class="onboard-title" style="font-size:20px">Диагностика · ${this.diagIdx + 1} / ${diagnosticTasks.length}</div>
      <div class="onboard-sub">Короткий тест из ${diagnosticTasks.length} ${plural(diagnosticTasks.length, "задание", "задания", "заданий")} по разным темам — по нему построим карту навыков.</div>
      <div class="card task-card" style="margin-top:18px;padding:20px">
        <div class="task-card__tags"><span class="chip chip--accent">${t.num}</span><span class="chip">${esc(t.sub)}</span></div>
        <div class="task-card__text" style="font-size:15px">${mathText(t.text)}</div>
        ${taskVisualHtml(t, "diagnostic")}
        <div class="answer-row">
          <input class="answer-input" id="diagInput" placeholder="Ответ" autocomplete="off" inputmode="${answerInputMode(t.answer)}">
          <button class="btn btn--primary" onclick="Onboarding.answerDiag()">Ответить</button>
        </div>
        ${answerFormatCaption(t.answer, t.valueType)}
        <div id="diagFeedback"></div>
      </div>
      ${this.backHtml()}`;
    const input = body.querySelector("#diagInput");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") Onboarding.answerDiag(); });
  },

  stepResult(body) {
    const total = this.diagResults.length;
    const correct = this.diagResults.filter((r) => r.correct).length;
    const startLevel = Math.round((correct / Math.max(total, 1)) * 100);

    const strong = [], weak = [];
    for (const r of this.diagResults) {
      const name = DataAPI.skill(DataAPI.task(r.taskId).skill).name;
      (r.correct ? strong : weak).push(name);
    }
    if (this.selfLevel === "confident" && strong.length === 0) strong.push("Базовые навыки");

    body.innerHTML = `
      <div class="onboard-title" style="font-size:22px">Твой стартовый профиль</div>
      <div class="card" style="margin-top:18px">
        <div class="stat-label">Текущий уровень подготовки</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">
          <span class="stat-num mono">${startLevel}</span><span style="color:var(--muted)">/ 100</span>
        </div>
        <div style="margin-top:12px">${progressBar(startLevel)}</div>
        <div class="grid grid--2" style="margin-top:18px;gap:12px">
          <div>
            <div class="stat-label" style="margin-bottom:8px">Сильные стороны</div>
            <div class="error-subtopics">${strong.map((n) => `<span class="chip chip--success">${n}</span>`).join("")}</div>
          </div>
          <div>
            <div class="stat-label" style="margin-bottom:8px">Требуют внимания</div>
            ${weak.length
              ? `<div class="error-subtopics">${weak.map((n) => `<span class="chip chip--danger">${n}</span>`).join("")}</div>`
              : `<div class="onboard-sub" style="margin:0">Не выявлены — все ответы верные.</div>`}
          </div>
        </div>
      </div>
      <div class="onboard-sub" style="margin-top:16px">
        На главной странице блок <b style="color:var(--text)">«Что делать сейчас»</b> будет подсказывать лучший следующий шаг — урок, тренировку или повторение ошибок — и пересчитывать его после каждого результата.
      </div>
      <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center">
        ${this.canGoBack() ? `<button class="btn btn--ghost btn--lg" onclick="Onboarding.back()">← Назад</button>` : `<span></span>`}
        <button class="btn btn--primary btn--lg" onclick="Onboarding.next()">Начать подготовку ${icon("arrow")}</button>
      </div>`;
  },

  stepName(body) {
    body.innerHTML = `
      <div class="onboard-title">Как тебя зовут?</div>
      <div class="onboard-sub">Так к тебе будут обращаться в профиле.</div>
      <div style="margin-top:22px">
        <input class="answer-input" id="nameInput" style="width:100%;box-sizing:border-box" placeholder="Имя" autocomplete="given-name" maxlength="${NAME_MAX_LENGTH}" value="${esc(this.name || "")}">
      </div>
      <div id="nameError" class="onboard-sub" style="color:var(--danger);display:none;margin-top:8px"></div>
      <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center">
        ${this.canGoBack() ? `<button class="btn btn--ghost btn--lg" onclick="Onboarding.back()">← Назад</button>` : `<span></span>`}
        <button class="btn btn--primary btn--lg" onclick="Onboarding.submitName()">Завершить ${icon("arrow")}</button>
      </div>`;
    const input = body.querySelector("#nameInput");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") Onboarding.submitName(); });
    input.focus();
  },

  pickLevel(v) { this.selfLevel = v; this.next(); },
  pickGoal(v) { this.goal = v; this.next(); },
  /* Цель по умолчанию — первая из шкалы ТЕКУЩЕГО предмета (после switchSubject
     DataAPI.goals() уже предметные). Хардкод g60 здесь ломал регистрацию базы:
     сервер отклоняет чужую цель 400-й, когда у предмета есть своя шкала.
     Выбранную ранее цель перепроверяем по текущей шкале: в finish() этот метод
     вызывается уже после переключения, а выбор могли сделать до него — чужой
     id заменяем первым валидным, иначе вся настройка (включая onboarded и имя)
     не сохраняется и онбординг возвращается после перезагрузки. */
  defaultGoal() {
    try {
      const list = DataAPI.goals() || [];
      if (list.some((g) => g && g.id === this.goal)) return this.goal;
      if (list.length && list[0].id) return list[0].id;
    } catch (_) {}
    return "g60";
  },

  answerDiag() {
    if (this.diagAnswered) return;
    const input = document.getElementById("diagInput");
    const val = input.value.trim();
    if (!val) { input.classList.add("answer-input--wrong"); setTimeout(() => input.classList.remove("answer-input--wrong"), 400); return; }
    const t = DataAPI.task(DataAPI.diagnosticTasks()[this.diagIdx]);
    const correct = checkAnswer(t, val);
    this.diagResults.push({ taskId: t.id, correct });
    this.diagAnswered = true;
    input.disabled = true;
    input.classList.add(correct ? "answer-input--correct" : "answer-input--wrong");
    document.getElementById("diagFeedback").innerHTML = `
      <div class="feedback ${correct ? "feedback--ok" : "feedback--bad"}" style="margin-top:14px">
        <div class="feedback__head">${icon(correct ? "check" : "x")} ${correct ? "Верно" : `Неверно · ответ: ${esc(t.answer)}`}</div>
        <div style="margin-top:12px;text-align:right"><button class="btn btn--soft btn--sm" onclick="Onboarding.nextDiag()">${this.diagIdx + 1 < DataAPI.diagnosticTasks().length ? "Дальше →" : "К результату"}</button></div>
      </div>`;
  },

  nextDiag() {
    this.diagIdx++;
    if (this.diagIdx >= DataAPI.diagnosticTasks().length) { this.step = 4; this.render(); }
    else this.render();
  },

  // Назад к прошлому шагу — тот же принцип, что в уроках (lessonPrev):
  // строго на один шаг назад. Из серии диагностики — в цель, из итога —
  // в последний вопрос (его результат снимается, вопрос можно перепройти),
  // из имени — в итог (или в предмет, если диагностика пропущена).
  back() {
    if (this._picking) return;
    if (this.step === 3) {
      if (this.diagAnswered) {
        // Только что отвечен: снимаем ответ и показываем тот же вопрос заново.
        this.diagResults.pop();
        this.diagAnswered = false;
      } else if (this.diagIdx > 0) {
        this.diagIdx--;
        this.diagResults.pop();
      } else {
        this.step = 2;
      }
      this.render();
      return;
    }
    if (this.step === 4) {
      let total = 0;
      try { total = DataAPI.diagnosticTasks().length; } catch (_) {}
      if (this.diagResults.length && total) {
        this.diagIdx = total - 1;
        this.diagResults.pop();
        this.diagAnswered = false;
        this.step = 3;
      } else {
        this.step = 2;
      }
      this.render();
      return;
    }
    if (this.step === 5) {
      if (this.mode === "skip") {
        this.mode = "offer";
        this.step = 0;
      } else {
        this.step = this.diagResults.length ? 4 : 0;
      }
      this.render();
      return;
    }
    if (this.step <= 0) return;
    this.step--;
    this.render();
  },

  // Кнопка «Назад» видна везде, кроме первого видимого шага: предмета —
  // или уровня, если предмет-шаг пропущен после явного выбора.
  canGoBack() {
    if (this.step <= 0) return false;
    if (this.step === 1 && this.subjectSkipped) return false;
    return true;
  },

  backHtml() {
    if (!this.canGoBack()) return "";
    return `<div class="lesson-nav"><button class="btn btn--ghost" onclick="Onboarding.back()">← Назад</button><span></span></div>`;
  },

  next() {
    if (this.step === 3) return;
    // Имя едино для аккаунта: итог (шаг 4) с уже известным именем сразу
    // завершает онбординг, шаг имени не показываем.
    if (this.step === 4 && this.name) { this.finish(); return; }
    this.step++;
    this.render();
  },

  submitName() {
    const input = document.getElementById("nameInput");
    const errorEl = document.getElementById("nameError");
    const value = input.value.trim().replace(/\s+/g, " ");
    if (!value || value.length > NAME_MAX_LENGTH) {
      errorEl.textContent = value ? `Имя должно быть короче ${NAME_MAX_LENGTH} символов.` : "Введи имя, чтобы завершить регистрацию.";
      errorEl.style.display = "block";
      input.classList.add("answer-input--wrong");
      setTimeout(() => input.classList.remove("answer-input--wrong"), 400);
      return;
    }
    this.name = value;
    if (this.mode === "skip") this.finishSkipped();
    else this.finish();
  },

  finish() {
    const subj = this.subject || DataAPI.currentSubject() || "profile_math";
    // Имя едино для аккаунта: при пропуске шага имени (повторный онбординг
    // нового предмета) переиспользуем уже сохранённое, чтобы не затереть его
    // пустым значением.
    const finalName = this.name || (Store.state && Store.state.name) || null;
    this.hide();
    try { sessionStorage.removeItem("ege_onboard_preset_subject"); } catch (_) {}
    const after = () => {
      toast(`Добро пожаловать, ${esc(Store.state.name)}! Профиль создан.`, "toast--xp", "flag");
      this.returnToPrevious();
    };
    // Порядок обязателен: сначала переключаем предмет (сервер отдаёт каталог и
    // состояние нового предмета вместе с ЕГО версией), и только потом
    // применяем регистрацию и сохраняем. Обратный порядок штамповал снапшот
    // базовой математики версией профиля (144 против 1) — сервер отвечал 409,
    // восстановление после конфликта теряло профиль, и экран регистрации
    // возвращался.
    if (subj !== DataAPI.currentSubject()) {
      Store.switchSubject(subj)
        .then(() => { applyOnboarding(subj, this.selfLevel || "base", this.defaultGoal(), this.diagResults, finalName); })
        .catch(() => Store.load(subj).then(() => {
          applyOnboarding(subj, this.selfLevel || "base", this.defaultGoal(), this.diagResults, finalName);
        }))
        .then(after)
        .catch(after);
      return;
    }
    applyOnboarding(subj, this.selfLevel || "base", this.defaultGoal(), this.diagResults, finalName);
    after();
  },
};

/* ============================================================
   Универсальный лоадер (boot + ожидание деталей каталога).
   Лендинг (main.html) — отдельный файл, его не касается.
   ============================================================ */

const LOADER_LOGO = '<svg viewBox="0 0 44 44" width="32" height="32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="23" r="12" style="stroke:var(--accent)" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="64 14" transform="rotate(-45 20 23)"/><circle cx="20" cy="23" r="6.8" style="stroke:var(--success)" stroke-width="2.6"/><circle cx="20" cy="23" r="2.3" style="fill:var(--violet)"/><path d="M34 8v6M31 11h6" style="stroke:var(--success)" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="33" r="1.6" style="fill:var(--accent)" opacity=".8"/><circle cx="33.5" cy="30.5" r="1.3" style="fill:var(--violet)" opacity=".7"/></svg>';

function loaderHTML(sub) {
  return `<div class="card ege-loader">
    <div class="ege-loader__orbit"><div class="ege-loader__core">${LOADER_LOGO}</div></div>
    <div class="ege-loader__brand">ege <span>easy</span></div>
    <div class="ege-loader__title">Загружаем</div>
    <div class="ege-loader__sub" data-loader-sub>${esc(sub || "Открываем страницу…")}</div>
    <div class="ege-loader__bar"><i></i></div>
  </div>`;
}

/* Смена подписей, пока висит boot-экран. Останавливается при отрисовке
   первого экрана или при показе ошибки. */
const BOOT_MSGS = ["Открываем страницу…", "Тянем каталог заданий…", "Считаем XP и уровень…", "Почти готово…"];
let bootMsgTimer = null;
function startBootMsgs() {
  stopBootMsgs();
  let k = 0;
  bootMsgTimer = setInterval(() => {
    k = (k + 1) % BOOT_MSGS.length;
    const el = document.querySelector("[data-loader-sub]");
    if (el) el.textContent = BOOT_MSGS[k];
    else stopBootMsgs();
  }, 1600);
}
function stopBootMsgs() {
  if (bootMsgTimer) { clearInterval(bootMsgTimer); bootMsgTimer = null; }
}

/* ============================================================
   Boot
   ============================================================ */

function showBootError(error) {
  if (isBlockedError(error)) { try { showAccountBlocked(blockedDetail(error) || {}); } catch (_) {} return; }
  const screen = document.getElementById("screen");
  document.getElementById("topbar").innerHTML = "";
  screen.innerHTML = `<div class="card" style="max-width:640px;margin:64px auto;text-align:center">
    <div class="page-title">Не удалось загрузить сайт</div>
    <div style="margin-top:12px;color:var(--text-2);line-height:1.6">Проверь интернет-соединение и обнови страницу.</div>
    <button class="btn btn--primary" style="margin-top:20px" onclick="location.reload()">Повторить</button>
  </div>`;
}

/* MathVisual mount: js/mathvisual.js renders live into a DOM node, so a
   placeholder <div data-mathvisual="..."> from taskVisualHtml() needs a pass
   after it actually lands in the DOM (innerHTML assignment doesn't run
   scripts). One observer on <body> covers every screen/modal without each
   render*() call site needing its own "mount visuals now" step. */
const MathVisualMount = {
  init() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) this.mountWithin(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  },
  mountWithin(node) {
    if (node.matches && node.matches("[data-mathvisual]")) this.mount(node);
    if (node.querySelectorAll) node.querySelectorAll("[data-mathvisual]").forEach((el) => this.mount(el));
  },
  mount(el) {
    if (el.dataset.mathvisualMounted || !window.MathVisual) return;
    el.dataset.mathvisualMounted = "1";
    let spec = null;
    try { spec = JSON.parse(el.dataset.mathvisual); } catch (e) { /* handled as an invalid spec below */ }
    MathVisual.render(el, spec);
  },
  /* Вендор не загрузился (офлайн/медленная сеть): наблюдатель пропускает
     хосты навсегда, т.к. window.MathVisual так и не появляется. Превращаем
     несмонтированное в читаемый текст вместо вечного пустого блока.
     Следующая навигация перерисует плейсхолдеры и повторит загрузку
     (ensureMath сбрасывает промис после ошибки). */
  failUnmounted(root) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    scope.querySelectorAll("[data-mathvisual]:not([data-mathvisual-mounted])").forEach((el) => {
      el.dataset.mathvisualMounted = "1";
      el.classList.add("task-visual--missing");
      el.innerHTML = '<div class="task-visual__fallback" style="display:block" role="status">Рисунок временно недоступен.</div>';
    });
  },
};
MathVisualMount.init();

let bootPromise = null;

function bootstrapApp() {
  if (bootPromise) return bootPromise;
  const screen = document.getElementById("screen");
  screen.innerHTML = loaderHTML("Открываем страницу…");
  startBootMsgs();
  bootPromise = (async () => {
    try {
      await Store.load();
      await Store.initTabLeader();
      stopBootMsgs();
      // Перезагрузка посреди пикера входа: выбор ещё не применён, сессия
      // авторизована — возвращаем экран выбора, а не угаданный предмет.
      try {
        if (sessionStorage.getItem("ege_login_subject_pending") === "1"
            && Store.auth && Store.auth.registered) pendingSubjectChoice = true;
      } catch (_) {}
      // Кросс-таб синк: соседняя вкладка после каждого save оставляет маяк.
      // Увидели более свежий маяк (событие storage, возврат во вкладку) —
      // перечитываем состояние с сервера, иначе stale-вкладка показывает
      // вчерашний снапшот и первым же действием перетирает сервер.
      try {
        window.addEventListener("beforeunload", () => {
          pauseLessonClock();
          Store.releaseTabLeadership();
        });
        window.addEventListener("pagehide", () => {
          pauseLessonClock();
          Store.releaseTabLeadership();
        });
        window.addEventListener("storage", (e) => {
          if (e && typeof e.key === "string" && e.key.indexOf("ege_core_state_ping:") === 0) {
            Store.checkExternalUpdate().catch(() => {});
          }
        });
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) pauseLessonClock();
          else resumeLessonClock();
          if (!document.hidden) {
            Store.checkExternalUpdate(true).catch(() => {});
            try { revalidateProfileAuth(); } catch (_) {}
            try { revalidateAdminSession(); } catch (_) {}
          }
        });
        window.addEventListener("focus", () => {
          resumeLessonClock();
          Store.checkExternalUpdate(true).catch(() => {});
          try { revalidateProfileAuth(); } catch (_) {}
          try { revalidateAdminSession(); } catch (_) {}
        });
        window.addEventListener("pageshow", () => {
          resumeLessonClock();
          Store.checkExternalUpdate(true).catch(() => {});
        });
        window.addEventListener("blur", () => pauseLessonClock());
        document.addEventListener("freeze", () => pauseLessonClock());
        scheduleAdminSessionWatch();
      } catch (_) {}
      render();
    } catch (error) {
      stopBootMsgs();
      if (isBlockedError(error)) {
        try { showAccountBlocked(blockedDetail(error) || window.__egeBlocked || {}); } catch (_) {}
      } else {
        showBootError(error);
      }
    }
  })();
  return bootPromise;
}

document.addEventListener("DOMContentLoaded", bootstrapApp);
if (document.readyState !== "loading") bootstrapApp();
