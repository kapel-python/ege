/* ============================================================
   EGE CORE — UI / router / screens
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
};

function icon(name) {
  // дефолтный размер 1em: CSS-правила компонентов (px) переопределяют атрибуты
  return (ICONS[name] || ICONS.target).replace("<svg ", '<svg width="1em" height="1em" style="vertical-align:-0.15em" ');
}

/* Theme is deliberately independent from progress state: resetProgress must
   not erase a visual preference, and one shared HTML attribute styles every
   route, modal and future component through the existing CSS tokens. */
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
  .logo-mark{
    height:34px;
    padding:0 10px;
    border-radius:10px;
    background:var(--indigo-dim);
    color:var(--indigo);
    display:flex;align-items:center;justify-content:center;
    font-weight:700;
    font-size:12px;
    letter-spacing:0.02em;
    flex-shrink:0;
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="header">
    <div class="header-inner">
      <div class="logo">
        <span class="logo-mark">EGE</span>
        <span>Подготовка к ЕГЭ</span>
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
<title>EGE CORE — подготовка к профильной математике</title>
<meta name="description" content="Платформа подготовки к ЕГЭ по профильной математике с системой прогресса: уровни, XP, миссии, навыки, боссы.">
<script>
  /* Apply the saved choice before styles are painted, so navigation and reloads
     never briefly show the opposite theme. */
  try {
    if (localStorage.getItem("ege_core_theme") === "dark") {
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
    <div class="sidebar__logo">
      <span class="logo-mark">EGE</span><span class="logo-text">CORE</span>
      <span class="logo-sub">профильная математика</span>
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

/* Единственный рендерер математики проекта.
   Новый формат данных: inline `\\(...\\)`, крупная формула `\\[...\\]`.
   Нормализация ниже сохраняет совместимость со старыми строками каталога. */
function mathText(value) {
  const source = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  const supers = { "⁰":"0", "¹":"1", "²":"2", "³":"3", "⁴":"4", "⁵":"5", "⁶":"6", "⁷":"7", "⁸":"8", "⁹":"9", "⁻":"-" };
  const subs = { "₀":"0", "₁":"1", "₂":"2", "₃":"3", "₄":"4", "₅":"5", "₆":"6", "₇":"7", "₈":"8", "₉":"9", "₋":"-" };
  const normalizeLegacy = (text) => {
    // Legacy catalog strings contain bare expressions (x², √(...), log_a(x)).
    // Collect the whole Latin/numeric/operator run before adding delimiters;
    // wrapping individual superscripts was the source of mixed typography.
    const convert = (raw) => raw
      .replace(/([A-Za-zА-Яа-я0-9])⃗/g, "\\vec{$1}")
      .replace(/([A-Za-zА-Яа-я0-9)])([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/g, (_m, base, power) => `${base}^{${[...power].map((c) => supers[c] || c).join("")}}`)
      .replace(/([A-Za-zА-Яа-я0-9)])([₀₁₂₃₄₅₆₇₈₉₋]+)/g, (_m, base, sub) => `${base}_{${[...sub].map((c) => subs[c] || c).join("")}}`)
      .replace(/([A-Za-zА-Яа-я0-9)])\^\(([^()\n]+)\)/g, "$1^{$2}")
      .replace(/([A-Za-zА-Яа-я0-9)])\^([−-]?[A-Za-zА-Яа-я0-9]+)/g, "$1^{$2}")
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
      .replace(/\(([^()\n]+)\)\s*\/\s*(\d+[A-Za-z]+|\d+|[A-Za-zА-Яа-я][A-Za-zА-Яа-я0-9]*)/g, "\\frac{$1}{$2}")
      .replace(/(\d+)\s*\/\s*(\d+)/g, "\\frac{$1}{$2}")
      .replace(/\blog_([A-Za-z0-9.]+)\(([^()\n]+)\)/gi, "\\log_{$1}\\left($2\\right)")
      .replace(/\blog([₀₁₂₃₄₅₆₇₈₉₋]+)\(([^()\n]+)\)/gi, (_x, base, arg) => `\\log_{${[...base].map((c) => subs[c] || c).join("")}}\\left(${arg}\\right)`)
      .replace(/(sin|cos|tan)(?=[A-Za-z0-9(²³⁻])/gi, "\\$1")
      .replace(/±/g, "\\pm")
      .replace(/∠/g, "\\angle ")
      .replace(/∥/g, "\\parallel ")
      .replace(/Σ/g, "\\Sigma ")
      .replace(/α/g, "\\alpha ")
      .replace(/ε/g, "\\varepsilon ")
      .replace(/∞/g, "\\infty ")
      .replace(/∪/g, "\\cup ")
      .replace(/−/g, "-");
    const mathRun = /(?:√|[A-Za-z0-9(∠])(?:[A-Za-z0-9π∞′°'^²³⁻₀₁₂₃₄₅₆₇₈₉_()+{}\-−*/=·.,;:<>\[\]\\ ±⃗∠∥Σαε∞∪]|√)*/g;
    return text.replace(mathRun, (run) => {
      const trimmed = run.trim();
      if (!trimmed || !(/[0-9=√^²³⁻₀₁₂₃₄₅₆₇₈₉∠∥Σαε∞∪⃗]|\b(?:log|sin|cos|tan)\b/i.test(trimmed))) return run;
      const lead = run.slice(0, run.indexOf(trimmed));
      const trail = run.slice(run.indexOf(trimmed) + trimmed.length);
      return `${lead}\\(${convert(trimmed)}\\)${trail}`;
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
  sec = Math.round(sec);
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

function forecastTrendLabel(trend) {
  if (!trend) return "Динамика появится после второго дня подготовки";
  if (trend.delta === 0) return `Без изменений с ${trend.fromDate.split("-").reverse().slice(0, 2).join(".")}`;
  return `${trend.delta > 0 ? "▲" : "▼"} ${trend.delta > 0 ? "+" : ""}${trend.delta} с ${trend.fromDate.split("-").reverse().slice(0, 2).join(".")}`;
}

function stars(n) {
  let out = "";
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= n ? "" : "off"}">★</span>`;
  return `<span class="stars">${out}</span>`;
}

function progressBar(pct, cls = "") {
  return `<div class="progress ${cls}"><div class="progress__fill" style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;
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
    return '<div class="task-visual mathvisual-host" data-mathvisual="' + spec + '" data-visual-context="' + esc(context) + '"' + ratioStyle + '></div>';
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

function openModal(html) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-wrap"><div class="modal">
        <button class="modal__close" onclick="closeModal()">${icon("x")}</button>
        ${html}
      </div></div>
    </div>`;
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

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
      <p>Пропустил день — серия начнётся заново.</p>`,
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
      <p>Примерная оценка твоего балла на ЕГЭ. Чем лучше освоены темы, тем выше прогноз.</p>
      <p>Это просто ориентир, а не точное предсказание. Растёт он, когда проходишь уроки и правильно решаешь задания.</p>
      <p>Как оценка менялась по дням, видно в «Статистике».</p>`,
  },
  skills: {
    title: "Навыки",
    body: `
      <p>Процент показывает, насколько хорошо ты знаешь тему. Часть даёт пройденный урок, остальное — решённые задания и правильные ответы.</p>
      <p>Подписи простые: слабое место — тему надо подтянуть, пройден — хороший результат, освоен — тема выучена отлично.</p>
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

function openHelp(key) {
  const h = HELP[key];
  if (!h) return;
  openModal(`
    <div class="stat-label">Подсказка</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${h.title}</div>
    <div class="help-body">${h.body}</div>
    <div style="margin-top:22px;display:flex;justify-content:flex-end">
      <button class="btn btn--primary" onclick="closeModal()">Понятно</button>
    </div>`);
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
      <div style="color:var(--text-2);margin-top:8px">Новый уровень подготовки</div>
    </div>`;
  div.onclick = () => div.remove();
  root.appendChild(div);
  setTimeout(() => div.remove(), 2600);
}

Store.on("levelup", ({ to }) => { showLevelUp(to); renderTopbar(); });
Store.on("achievement", (a) => toast(`Достижение разблокировано: <b>«${a.name}»</b>`, "toast--ach", "crown"));
Store.on("dailydone", ({ xp }) => toast(`Ежедневная задача выполнена <b class="mono">+${xp} XP</b>`, "toast--xp", "zap"));
Store.on("xp", () => renderTopbar());
Store.on("persistenceerror", () => toast("Не удалось сохранить данные. Проверь соединение с сервером.", "toast--error", "x"));

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

function go(route) { location.hash = `#/${route}`; }

function currentRoute() {
  const h = location.hash.replace(/^#\//, "");
  return h.split("/")[0] || "dashboard";
}

function render() {
  if (!Store.state.onboarded) { Onboarding.show(); return; }
  Onboarding.hide();
  const route = currentRoute();
  renderSidebar(route);
  renderBottomNav(route);
  renderTopbar();
  const screen = document.getElementById("screen");
  const fn = {
    dashboard: screenDashboard,
    path: screenPath,
    training: screenTraining,
    session: screenSession,
    lesson: screenLesson,
    errors: screenErrors,
    trials: screenTrials,
    stats: screenStats,
    profile: screenProfile,
  }[route] || screenDashboard;
  screen.innerHTML = "";
  screen.style.animation = "none";
  void screen.offsetWidth;
  screen.style.animation = "";
  fn(screen);
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);

/* ============================================================
   Chrome: sidebar / bottomnav / topbar
   ============================================================ */

function renderSidebar(active) {
  const nav = document.getElementById("sidebarNav");
  const openErrors = Store.state.errors.filter((e) => !e.resolved).length;
  nav.innerHTML = NAV.map((n) => `
    <a class="nav-item ${n.route === active ? "active" : ""}" href="#/${n.route}">
      ${icon(n.ic)}<span>${n.label}</span>
      ${n.route === "errors" && openErrors ? `<span class="nav-badge">${openErrors}</span>` : ""}
    </a>`).join("");
  const f = forecast();
  document.getElementById("sidebarFooter").innerHTML = `
    Прогноз: <b class="mono" style="color:var(--text-2)">${f.low}–${f.high}</b> баллов<br>
    <span style="font-size:11px">данные сохраняются в SQLite</span>`;
}

function renderBottomNav(active) {
  const items = NAV.filter((n) => ["dashboard", "path", "training", "errors", "profile"].includes(n.route));
  document.getElementById("bottomnav").innerHTML = items.map((n) => `
    <a href="#/${n.route}" class="${n.route === active ? "active" : ""}">${icon(n.ic)}<span>${n.label}</span></a>`).join("");
}

function renderTopbar() {
  if (!Store.state.onboarded) { document.getElementById("topbar").innerHTML = ""; return; }
  const li = levelInfo();
  const f = forecast();
  const dark = Theme.current() === "dark";
  document.getElementById("topbar").innerHTML = `
    <div class="level-chip">
      <span class="level-chip__badge">УР. ${li.level}</span>
      <div>
        <div class="level-chip__bar">${progressBar(li.pct, "progress--thin")}</div>
        <div class="level-chip__xp">${li.current} / ${li.need} XP</div>
      </div>
    </div>
    <div class="topbar__spacer"></div>
    <div class="chip hide-mobile">Прогноз&nbsp;<b class="mono">${f.low}–${f.high}</b></div>
    <button class="btn btn--ghost theme-toggle" type="button" onclick="Theme.toggle()" aria-label="${dark ? "Включить светлую тему" : "Включить тёмную тему"}" aria-pressed="${dark}" title="${dark ? "Включить светлую тему" : "Включить тёмную тему"}">${icon(dark ? "sun" : "moon")}</button>
    <div class="streak-chip streak-chip--clickable" title="Серия дней подряд — нажми, чтобы узнать, как это работает" role="button" tabindex="0" onclick="openHelp('streak')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHelp('streak')}">${icon("flame")} ${Store.state.streak} дн</div>`;
}

/* ============================================================
   Screen: Главная
   ============================================================ */

function screenDashboard(root) {
  const s = Store.state;
  const li = levelInfo();
  const f = forecast();
  const trend = forecastTrend();
  const act = todayActivity();
  const openErrors = s.errors.filter((e) => !e.resolved).length;
  const d = DataAPI.daily();
  ensureDailyChallenge();
  const dailyGoal = dailyTaskIds().length || d.target;
  const dailyDone = s.daily.date === todayStr() && s.daily.done;
  const dailySolved = s.daily.date === todayStr() ? s.daily.solved : 0;
  const openLesson = mostRecentOpenLesson();
  const activeMission = !openLesson && (DataAPI.missions().find((m) => missionProgress(m) > 0 && !s.missionsDone[m.id])
    || DataAPI.missions().find((m) => !s.missionsDone[m.id]));

  /* Главный навигатор обучения: кандидаты пересчитываются при каждом
     рендере, поэтому после любого результата блок показывает актуальный
     лучший шаг. Альтернативы показываем открыто — пользователь свободен. */
  const steps = nextStepCandidates();
  const step = steps[0] || null;
  const alts = steps.slice(1, 3);

  const weakSpots = DataAPI.skills()
    .map((sk) => ({ sk, prog: skillProgress(sk.id), errs: openErrorCount(sk.id) }))
    .filter((x) => x.prog < 70 || x.errs > 0)
    .sort((a, b) => (a.prog - b.prog) || (b.errs - a.errs))
    .slice(0, 4);

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Главная</div>
      <div class="page-sub">${new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })} · цель: ${goalLabel()}</div>
    </div>

    <div class="hero">
      <div class="card card--glow">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <div class="stat-label">Уровень подготовки</div>
            <div class="stat-num">УРОВЕНЬ ${li.level}</div>
          </div>
          <div style="text-align:right">
            <div class="stat-label">Опыт ${helpDot("xp")}</div>
            <div class="mono" style="font-size:17px;font-weight:700">${li.current} <span style="color:var(--muted)">/ ${li.need} XP</span></div>
          </div>
        </div>
        <div style="margin-top:16px">${progressBar(li.pct)}</div>
        <div style="display:flex;gap:18px;margin-top:18px;flex-wrap:wrap">
          <div>
            <div class="streak-chip streak-chip--clickable" title="Серия дней подряд — нажми, чтобы узнать, как это работает" role="button" tabindex="0" onclick="openHelp('streak')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHelp('streak')}">${icon("flame")} ${s.streak} ${plural(s.streak, "день", "дня", "дней")} подряд</div>
          </div>
          <div style="align-self:center;font-size:13px;color:var(--text-2)">
            Сегодня: <b class="mono">${Math.min(act.solved, dailyGoal)} / ${dailyGoal}</b> заданий
          </div>
        </div>
        <div style="margin-top:12px;max-width:340px">${progressBar(Math.min(act.solved / dailyGoal, 1) * 100, "progress--thin progress--success")}</div>
      </div>

      <div class="card forecast-card">
        <div class="stat-label">Прогноз результата ЕГЭ ${helpDot("forecast")}</div>
        <div class="forecast-value">${f.low}–${f.high} <span style="font-size:18px;color:var(--muted);font-weight:600">баллов</span></div>
        <div class="delta-up" style="${trend && trend.delta < 0 ? "color:var(--danger)" : ""}">${forecastTrendLabel(trend)}</div>
        <div class="forecast-note">Оценка по текущему прогрессу навыков и точности; это не официальный и не ML-прогноз.</div>
      </div>
    </div>

    ${step ? `
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
      <div class="card card--hover action-card" onclick="continueTraining()">
        <div class="action-card__icon">${icon("training")}</div>
        <div><div class="action-card__title">Продолжить обучение</div>
        <div class="action-card__sub">${openLesson ? `Урок «${openLesson.lesson.title}» — шаг ${Math.min((openLesson.session.idx || 0) + 1, openLesson.lesson.steps.length)}/${openLesson.lesson.steps.length}` : activeMission ? `«${activeMission.title}» — ${missionProgress(activeMission)}/${activeMission.tasks.length}` : "Текущая тема по рекомендации"}</div></div>
      </div>
      <div class="card card--hover action-card action-card--warn" onclick="${openErrors ? "startErrorsReview()" : "go('errors')"}">
        <div class="action-card__icon">${icon("rotate")}</div>
        <div><div class="action-card__title">Повторить ошибки</div>
        <div class="action-card__sub">${openErrors ? `Открыто ошибок: ${openErrors}` : "Все ошибки закрыты"}</div></div>
      </div>
      <div class="card card--hover action-card action-card--success" onclick="startDaily()">
        <div class="action-card__icon">${icon("zap")}</div>
        <div><div class="action-card__title">Ежедневная задача</div>
        <div class="action-card__sub">${dailyDone ? "Выполнена · можно повторить без награды" : `${dailySolved} / ${dailyGoal} · +${d.xp} XP`}</div></div>
      </div>
      <div class="card card--hover action-card action-card--violet" onclick="go('trials')">
        <div class="action-card__icon">${icon("crown")}</div>
        <div><div class="action-card__title">Испытания</div>
        <div class="action-card__sub">Боссы и смешанная проверка формы</div></div>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:34px">
      <div>
        <div class="section-title" style="margin-top:0">Навыки ${helpDot("skills")}</div>
        <div class="card" style="padding:10px 8px">
          ${DataAPI.skills().map((sk) => {
            const st = s.skillStats[sk.id];
            const acc = st.solved ? Math.round((st.correct / st.solved) * 100) : 0;
            return `
            <div class="skill-row" onclick="openSkillModal('${sk.id}')">
              <div class="skill-row__name">${sk.name}</div>
              ${progressBar(skillProgress(sk.id))}
              <div class="skill-row__pct">${skillProgress(sk.id)}%</div>
              <div class="skill-row__tip">
                Решено: <b>${st.solved}</b> · точность: <b>${acc}%</b><br>
                Статус: ${statusLabel(skillStatus(sk))}<br>
                Нажми, чтобы открыть детали
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div>
        <div class="section-title" style="margin-top:0">Требуют внимания</div>
        <div class="card">
          ${weakSpots.length ? weakSpots.map(({ sk, prog, errs }) => `
            <div class="skill-row" onclick="openSkillModal('${sk.id}')">
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
}

/* Исполнитель шага из умного блока: кандидаты пересчитываются в момент
   нажатия, а не берутся с прошлого рендера — действие всегда соответствует
   актуальному состоянию знаний. */
function runNextStep(index = 0) {
  const c = nextStepCandidates()[index];
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

function goalLabel() {
  const g = DataAPI.goals().find((x) => x.id === Store.state.goal);
  return g ? g.label : "не выбрана";
}

function statusLabel(st) {
  return {
    "locked": "заблокирован",
    "weak": "слабое место",
    "in-progress": "в процессе",
    "completed": "пройден",
    "mastered": "освоен",
  }[st];
}

function continueTraining() {
  const s = Store.state;
  // Незавершённый урок — самое дешёвое следующее действие: доучить то, что
  // уже открыто, а не начинать новую сессию по свободной практике.
  const openLesson = mostRecentOpenLesson();
  if (openLesson) return Lesson.start(openLesson.lessonId);
  const active = DataAPI.missions().find((m) => missionProgress(m) > 0 && !s.missionsDone[m.id]);
  if (active) return startMission(active.id);
  // Единый поток тренировки — через миссию темы (награда и прогресс),
  // свободная практика отдельной сущностью больше не представлена.
  const worst = weakestSkill();
  const mission = worst && DataAPI.missions().find((m) => m.skill === worst.id && Array.isArray(m.tasks) && m.tasks.length);
  if (mission) return startMission(mission.id);
  const fallbackSkill = worst || DataAPI.skills()[0];
  const tasks = orderedTasks(DataAPI.practiceTasksBySkill(fallbackSkill ? fallbackSkill.id : "")).slice(0, 6).map((t) => t.id);
  Session.start({ title: worst ? `Тренировка: ${worst.name}` : "Тренировка", taskIds: tasks, mode: "quick" });
}

/* ============================================================
   Screen: Путь (skill tree)
   ============================================================ */

function screenPath(root) {
  const branches = DataAPI.categories().map((cat) => {
    const skills = DataAPI.skills().filter((s) => s.cat === cat.id).sort((a, b) => a.order - b.order);
    return `
      <div class="tree-branch">
        <div class="tree-branch__title">${cat.name.toUpperCase()} <span>${catProgress(cat.id)}% освоено</span></div>
        <div class="tree-nodes">
          ${skills.map((sk) => {
            const st = Store.state.skillStats[sk.id];
            const status = skillStatus(sk);
            const locked = status === "locked";
            return `
            <div class="tree-node tree-node--${status}" onclick="openSkillModal('${sk.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSkillModal('${sk.id}')}" aria-label="Открыть тему ${esc(sk.name)}">
              <div class="tree-node__dot"></div>
              <div class="tree-node__body">
                <div class="tree-node__name">${sk.name}
                  <span class="chip ${statusChipClass(status)}" style="font-size:10px">${statusLabel(status)}</span>
                </div>
                <div class="tree-node__meta">
                  <div class="tree-node__bar">${progressBar(skillProgress(sk.id), "progress--thin progress--gauge")}</div>
                  <span class="mono">${skillProgress(sk.id)}%</span>
                  <span>· ${sk.ege}</span>
                </div>
              </div>
              <div style="color:var(--muted)">${icon("arrow")}</div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Путь ${helpDot("path")}</div>
      <div class="page-sub">Карта всех тем ЕГЭ и твой прогресс по каждой. Нажми на тему — увидишь урок, тренировку и типичные ошибки.</div>
    </div>
    <div style="margin-top:28px">
      <div class="tree-root"><div class="tree-root__node">ЕГЭ<small>профильная математика · ${overallProgress()}% освоено</small></div></div>
      <div class="tree-connector-v"></div>
      <div class="tree-branches">${branches}</div>
    </div>`;
}

function overallProgress() {
  const skills = DataAPI.skills();
  return Math.round(skills.reduce((a, s) => a + skillProgress(s.id), 0) / skills.length);
}

function statusChipClass(st) {
  return { "locked": "", "weak": "chip--danger", "in-progress": "chip--accent", "completed": "chip--accent", "mastered": "chip--success" }[st];
}

function openSkillModal(skillId) {
  const sk = DataAPI.skill(skillId);
  const st = Store.state.skillStats[skillId];
  const acc = st.solved ? Math.round((st.correct / st.solved) * 100) : 0;
  const status = skillStatus(sk);
  const skillErrors = Store.state.errors.filter((e) => e.skill === skillId && !e.resolved);
  const subs = [...new Set(skillErrors.map((e) => e.sub))];
  const mission = DataAPI.missions().find((m) => m.skill === skillId && !Store.state.missionsDone[m.id])
    || DataAPI.missions().find((m) => m.skill === skillId);
  const lessons = DataAPI.lessonsBySkill(skillId);
  const lessonErrs = lessonStepErrorsBySkill(skillId);

  openModal(`
    <div class="stat-label">${DataAPI.category(sk.cat).name} · ${sk.ege}</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px">${sk.name}</div>
    <div style="margin-top:6px"><span class="chip ${statusChipClass(status)}">${statusLabel(status)}</span></div>

    <div style="margin:20px 0 8px">${progressBar(skillProgress(skillId))}</div>
    <div class="grid grid--3" style="gap:10px;margin-top:16px">
      <div><div class="mono" style="font-size:20px;font-weight:700">${skillProgress(skillId)}%</div><div class="stat-label">освоение навыка</div></div>
      <div><div class="mono" style="font-size:20px;font-weight:700">${st.solved}</div><div class="stat-label">решено задач</div></div>
      <div><div class="mono" style="font-size:20px;font-weight:700">${acc}%</div><div class="stat-label">правильных</div></div>
    </div>

    <div style="margin-top:20px">
      <div class="stat-label" style="margin-bottom:8px">Типичные ошибки</div>
      ${subs.length ? `<div class="error-subtopics">${subs.map((x) => `<span class="chip chip--danger">${esc(x)}</span>`).join("")}</div>` : `<div style="font-size:13px;color:var(--muted)">Пока не выявлены — так держать.</div>`}
    </div>

    ${lessonErrs.length ? `
    <div style="margin-top:16px">
      <div class="stat-label" style="margin-bottom:8px">Сложные шаги в уроках</div>
      <div class="error-subtopics">${lessonErrs.map((e) => {
        const [lessonId, stepId] = e.key.split(":");
        const lesson = DataAPI.lesson(lessonId);
        const types = Object.keys(e.types || {});
        const label = types.length ? types[0] : `шаг ${stepId}`;
        return `<span class="chip chip--warn" title="${esc(types.join("; "))}">урок «${lesson ? esc(lesson.title) : lessonId}» · ${esc(label)}${e.count > 1 ? ` ×${e.count}` : ""}</span>`;
      }).join("")}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">Перепройди урок — верный ответ на этом шаге снимет отметку.</div>
    </div>` : ""}

    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap">
      ${lessons.length ? `<button class="btn btn--primary" onclick="closeModal();Lesson.start('${lessons[0].id}')">${icon("bulb")} ${Store.state.completedLessons[lessons[0].id] ? "Повторить" : "Урок"}: «${lessons[0].title}»</button>` : `<span class="stat-label">Для этой темы урок пока не добавлен.</span>`}
      ${mission && mission.tasks.length ? `<button class="btn ${lessons.length ? "btn--soft" : "btn--primary"}" onclick="closeModal();startMission('${mission.id}')">${icon("target")} Тренировка: ${sk.name} · ${mission.tasks.length} заданий</button>` : ""}
      ${!mission && DataAPI.practiceTasksBySkill(skillId).length ? `<button class="btn btn--ghost" onclick="closeModal();startSkillPractice('${skillId}')">Тренировка по теме</button>` : ""}
      ${!mission && !DataAPI.practiceTasksBySkill(skillId).length ? `<span class="stat-label">Заданий в банке пока нет.</span>` : ""}
    </div>`);
}

/* Единая точка входа в практику по теме: набор заданий темы и есть миссия,
   поэтому идём через неё (прогресс, награда, продолжение с места остановки).
   Прямой запуск списком остаётся только как запасной вариант для тем без
   миссии. */
function startSkillPractice(skillId) {
  const mission = DataAPI.missions().find((m) => m.skill === skillId && Array.isArray(m.tasks) && m.tasks.length);
  if (mission) return startMission(mission.id);
  const tasks = orderedTasks(DataAPI.practiceTasksBySkill(skillId)).map((t) => t.id);
  if (!tasks.length) return;
  Session.start({ title: `Тренировка: ${DataAPI.skill(skillId).name}`, taskIds: tasks, mode: "quick" });
}

/* ============================================================
   Screen: Тренировка (уроки + тренировки по темам)
   ============================================================ */

function screenTraining(root) {
  const missions = DataAPI.missions();
  const lessons = DataAPI.lessons();
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
        const progress = inProgress ? Math.round(((session.idx || 0) / lesson.steps.length) * 100) : 0;
        return `
        <div class="card card--hover lesson-card ${done ? "lesson-card--done" : ""}">
          <div class="mission-card__top">
            <div>
              <div class="mission-card__title">${icon("bulb")} ${lesson.title} ${done ? '<span class="chip chip--success" style="margin-left:6px">✓</span>' : ""}</div>
              <div class="mission-card__path">${sk.name} · ${lesson.steps.length} шагов · ${done ? "завершён" : "не пройден"}</div>
            </div>
            <div class="mission-card__reward"><span class="chip chip--accent mono">+${lesson.xp} XP</span></div>
          </div>
          ${inProgress ? `<div class="mission-card__foot">
            <div class="mission-card__bar">${progressBar(progress)}</div>
            <span class="mono">${Math.min((session.idx || 0) + 1, lesson.steps.length)} / ${lesson.steps.length}</span>
          </div>` : ''}
          <button class="btn ${done ? "btn--soft" : "btn--primary"} btn--sm" style="align-self:flex-start" onclick="Lesson.start('${lesson.id}')">
            ${done ? "Пройти ещё раз" : inProgress ? "Продолжить" : "Начать урок"}
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
        const taskCount = Array.isArray(m.tasks) ? m.tasks.length : 0;
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
  if (!m) return toast("Миссия не найдена", "toast--error", "x");
  if (!Array.isArray(m.tasks) || !m.tasks.length) return toast("В этой теме пока нет заданий для практики", "", "bulb");
  // A mission can reach the end of its task list without being marked done
  // (the completion bar wasn't met — see sessionFinish). Resuming "from"
  // that point would slice an empty task list, so treat it the same as a
  // fresh restart instead of silently handing Session.start nothing to do.
  const from = (Store.state.missionsDone[missionId] || missionProgress(m) >= m.tasks.length) ? 0 : missionProgress(m);
  Session.start({
    title: `Миссия: ${m.title}`,
    taskIds: m.tasks.slice(from),
    mode: "mission",
    missionId,
    xpReward: m.xp,
    offset: from,
    total: m.tasks.length,
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
    go("session");
    if (currentRoute() === "session") render();
  },

  task() { return DataAPI.task(this.cur.taskIds[this.cur.idx]); },

  stopTimer() { if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; } },
};

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
        <button class="btn btn--ghost btn--sm" onclick="sessionQuit()">← Выйти</button>
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
        <div class="task-card__text">${mathText(t.text)}</div>
        ${taskVisualHtml(t)}

        <div id="hintSlot"></div>

        ${t.selfCheck ? sessionSelfCheckAreaHtml(t) : `
        <div class="answer-row">
          <input class="answer-input" id="answerInput" placeholder="Ответ" autocomplete="off" inputmode="${answerInputMode(t.answer)}">
          <button class="btn btn--primary" id="submitBtn" onclick="sessionSubmit()">Ответить</button>
        </div>
        <div class="session-tools">
          <span id="hintControl"></span>
          <button class="btn btn--ghost btn--sm" onclick="sessionSkip()">Пропустить →</button>
          <span id="xpNote" style="margin-left:auto;font-size:12px;color:var(--muted)">верный ответ: +${attemptXp(t, true, 0, false).total} XP · попытка: +${attemptXp(t, false, 0, false).total} XP</span>
        </div>`}
        <div id="feedbackSlot"></div>
      </div>
    </div>`;

  if (t.selfCheck) {
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
  const xp = recordAnswer(t, correct, hintLevel, seconds, closesTaskId);
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
        <button class="btn btn--primary" onclick="sessionNext()">${S.idx + 1 < S.taskIds.length ? "Далее →" : "Завершить"}</button>
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
        <button class="btn btn--soft" onclick="sessionNext()">${S.idx + 1 < S.taskIds.length ? "Далее →" : "Завершить"}</button>
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
  const xp = recordAnswer(t, true, hintLevel, seconds, closesTaskId);
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
        <button class="btn btn--primary" onclick="sessionNext()">${S.idx + 1 < S.taskIds.length ? "Далее →" : "Завершить"}</button>
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
  if (S.idx >= S.taskIds.length) return sessionFinish();
  S.answered = false;
  S.taskStartTs = Date.now();
  renderTask(document.getElementById("screen"));
}

function sessionQuit() {
  Session.stopTimer();
  if (Session.cur && Session.cur.results.length > 0) return sessionFinish(true);
  Session.cur = null;
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

  const isBossWin = boss && correct / solved >= 0.6 && bossDefeated(boss);
  const title = missionDone ? "ПРАКТИКА ЗАВЕРШЕНА" : boss ? (isBossWin ? "ИСПЫТАНИЕ ПРОЙДЕНО" : "БОСС УСТОЯЛ") : "ТРЕНИРОВКА ЗАВЕРШЕНА";

  const checkedSkills = boss ? [...new Set(S.results.map((r) => DataAPI.skill(DataAPI.task(r.taskId).skill).name))] : null;

  Session.cur = null;

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
        ${bonusSum ? `<div class="result-breakdown__row"><span>За правильные ответы</span><b class="mono">+${bonusSum} XP</b></div>` : ""}
        ${errSum ? `<div class="result-breakdown__row"><span>За закрытие ошибок</span><b class="mono">+${errSum} XP</b></div>` : ""}
        ${missionXp ? `<div class="result-breakdown__row"><span>Бонус миссии</span><b class="mono">+${missionXp} XP</b></div>` : ""}
      </div>
      ${missionDone && mission ? `<div style="color:var(--text-2)">Навык «${DataAPI.skill(mission.skill).name}» усилен · награда миссии +${mission.xp} XP</div>` : ""}
      ${repeatNote}
      ${boss && isBossWin ? `<div style="color:var(--success)">Навыки ветки «${DataAPI.category(boss.cat).name}» повышены на +6%</div>` : ""}
      <div class="result-stats">
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${correct}/${solved}</div><div class="stat-label">правильно</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${fmtTime(totalTime)}</div><div class="stat-label">время</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${S.hintsUsed}</div><div class="stat-label">подсказок</div></div>
      </div>
      ${boss ? `<div class="card" style="text-align:left;margin-bottom:20px">
        <div class="stat-label" style="margin-bottom:8px">Проверялись навыки</div>
        <div class="error-subtopics">${checkedSkills.map((n) => `<span class="chip">${n}</span>`).join("")}</div>
      </div>` : ""}
      ${S.mode === "errors" ? `<div style="color:var(--text-2);margin-bottom:18px">Закрыто ошибок: <b>${errorsClosed}</b></div>` : ""}
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn--primary btn--lg" onclick="go('dashboard')">На главную</button>
        <button class="btn btn--ghost btn--lg" onclick="go('${S.mode === "boss" ? "trials" : "training"}')">${S.mode === "boss" ? "К испытаниям" : "Ещё тренировка"}</button>
      </div>
    </div>`;
  renderTopbar();
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

/* ============================================================
   Interactive lesson engine — data-driven, persistent and reusable
   Supported semantic steps: EXPLANATION, FOCUS, ACTION, VALIDATION,
   FEEDBACK, HINT, TRANSITION, INDEPENDENT_TASK.
   ============================================================ */

const LESSON_INTERACTIVE_TYPES = new Set(["ACTION", "VALIDATION", "INDEPENDENT_TASK"]);

function lessonStepType(step) {
  // Compatibility with the first declarative lesson format.
  return ({ explain: "EXPLANATION", focus: "FOCUS", input: "ACTION", summary: "FEEDBACK" }[step.type] || step.type || "EXPLANATION").toUpperCase();
}

function lessonFields(step) {
  if (Array.isArray(step.fields) && step.fields.length) return step.fields;
  const task = step.taskId ? DataAPI.task(step.taskId) : null;
  return [{ id: "answer", label: "Ответ", answer: step.answer || (task && task.answer), errorType: step.errorType }];
}

function lessonTask(step) { return step.taskId ? DataAPI.task(step.taskId) : null; }

const Lesson = {
  cur: null,

  start(lessonId) {
    const lesson = DataAPI.lesson(lessonId);
    if (!lesson) return;
    const sourceRoute = ["path", "training"].includes(currentRoute()) ? currentRoute() : "path";
    const saved = Store.state.lessonSessions && Store.state.lessonSessions[lessonId];
    this.cur = saved
      ? { lesson, idx: Math.min(saved.idx || 0, lesson.steps.length - 1), stepState: saved.stepState || {}, xp: saved.xp || 0, wrongAttempts: saved.wrongAttempts || 0, startTs: saved.startTs || Date.now(), returnRoute: saved.returnRoute || sourceRoute }
      : { lesson, idx: 0, stepState: {}, xp: 0, wrongAttempts: 0, startTs: Date.now(), returnRoute: sourceRoute };
    this.persist();
    go("lesson");
    if (currentRoute() === "lesson") render();
  },

  step() { return this.cur && this.cur.lesson.steps[this.cur.idx]; },

  stateFor(step = this.step()) {
    if (!this.cur.stepState[step.id]) this.cur.stepState[step.id] = { status: "active", hints: 0, attempts: 0, draft: {} };
    return this.cur.stepState[step.id];
  },

  persist() {
    if (!this.cur) return;
    Store.state.lessonSessions = Store.state.lessonSessions || {};
    Store.state.lessonSessions[this.cur.lesson.id] = {
      idx: this.cur.idx, stepState: this.cur.stepState, xp: this.cur.xp,
      wrongAttempts: this.cur.wrongAttempts, startTs: this.cur.startTs,
      returnRoute: this.cur.returnRoute || "path",
    };
    Store.save();
  },

  clearPersist(lessonId) {
    if (Store.state.lessonSessions) delete Store.state.lessonSessions[lessonId];
    Store.save();
  },
};

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
    ${isDone ? "" : `<div class="session-tools lesson-tools">
      ${help ? `<button class="btn btn--ghost btn--sm" id="lessonHintBtn" onclick="lessonHint()">${icon("bulb")} ${help.type === "solution" ? "Показать решение" : `Подсказка ${help.level}`}</button>` : ""}
      <span>${help ? "Подсказка останется на экране до конца задания" : "Следующая подсказка откроется после ошибки"}</span>
    </div>`}
    <div id="lessonFeedbackSlot">${lessonFeedbackHtml(step, state)}</div>`;
}

function screenLesson(root) {
  const L = Lesson.cur;
  if (!L) { go("path"); return; }
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
        <button class="btn btn--ghost btn--sm" onclick="lessonQuit()">← Выйти</button>
        <div class="session-head__title">${icon("bulb")} Урок: ${esc(lesson.title)}</div>
        <div class="session-head__progress mono">${L.idx + 1} / ${total}</div>
      </div>
      <div class="lesson-progress-meta"><span>${type === "INDEPENDENT_TASK" ? "самостоятельный шаг" : "пошаговое обучение"}</span><span>${Math.round((L.idx / total) * 100)}%</span></div>
      ${progressBar((L.idx / total) * 100)}
      <div class="card task-card lesson-card ${type === "FOCUS" ? "lesson-card--focus" : ""}">
        <div class="lesson-step-label">${esc(type.replaceAll("_", " "))}</div>
        ${step.title ? `<div class="lesson-title">${esc(step.title)}</div>` : ""}
        <div class="lesson-body">
          <div class="task-card__text lesson-text">${mathText(step.text || "")}</div>
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
  if (!window.confirm("Выйти из урока? Текущий ответ и прогресс будут сохранены.")) return;
  const returnRoute = Lesson.cur.returnRoute || "path";
  Lesson.persist();
  Lesson.cur = null;
  go(returnRoute);
}

function lessonFinish() {
  const L = Lesson.cur;
  const lesson = L.lesson;
  const independentStep = lesson.steps.find((step) => lessonStepType(step) === "INDEPENDENT_TASK");
  const independent = independentStep ? (L.stepState[independentStep.id] || {}) : null;
  Lesson.clearPersist(lesson.id);
  const { firstCompletion, totalXp, baseXp, stepsXp } = completeLesson(lesson, L.xp, {
    wrongAttempts: L.wrongAttempts,
    durationSec: (Date.now() - L.startTs) / 1000,
  });
  Lesson.cur = null;

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
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${fmtTime((Date.now() - L.startTs) / 1000)}</div><div class="stat-label">время</div></div>
        <div class="card"><div class="mono" style="font-size:22px;font-weight:700">${L.wrongAttempts}</div><div class="stat-label">осмысленных ошибок</div></div>
      </div>
      <div class="lesson-result-note ${independent && independent.status === "solved" ? "lesson-result-note--ok" : ""}">${!independent ? `${icon("info")} В этом уроке нет самостоятельного задания.` : independent.status === "solved" ? `${icon("check")} Самостоятельное задание решено.` : `${icon("bulb")} Самостоятельное задание сохранено для повторения.`}</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn--primary btn--lg" onclick="startSkillPractice('${lesson.skill}')">${icon("target")} Закрепить на практике</button>
        <button class="btn btn--ghost btn--lg" onclick="go('path')">К карте навыков</button>
      </div>
    </div>`;
  renderTopbar();
}

/* ============================================================
   Screen: Ошибки
   ============================================================ */

function screenErrors(root) {
  const open = Store.state.errors.filter((e) => !e.resolved);
  const resolved = Store.state.errors.filter((e) => e.resolved);

  const bySkill = {};
  for (const e of open) {
    (bySkill[e.skill] = bySkill[e.skill] || []).push(e);
  }

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Ошибки ${helpDot("errors")}</div>
      <div class="page-sub">Каждая ошибка — это точка роста. Повторяй слабые места, пока они не закроются.</div>
    </div>

    <div class="card card--glow" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px">
      <div>
        <div class="stat-num mono">${open.length}</div>
        <div class="stat-label">открытых ошибок · закрыто за всё время: ${Store.state.errorsResolved}</div>
      </div>
      <div style="margin-left:auto">
        <button class="btn btn--primary btn--lg" ${open.length ? "" : "disabled"} onclick="startErrorsReview()">
          ${icon("rotate")} Повторить слабые места
        </button>
      </div>
    </div>

    <div class="section-title">По навыкам</div>
    ${Object.keys(bySkill).length === 0 ? `<div class="card empty">Открытых ошибок нет. Решай задания — система соберёт здесь всё, что пошло не так.</div>` : ""}
    ${Object.entries(bySkill).map(([skillId, errs]) => {
      const sk = DataAPI.skill(skillId);
      const subs = {};
      errs.forEach((e) => { subs[e.sub] = (subs[e.sub] || 0) + 1; });
      return `
      <div class="card error-group">
        <div class="error-group__head">
          <div style="font-weight:650;font-size:15px">${sk.name}</div>
          <span class="chip">${sk.ege}</span>
          <div class="error-group__count"><span class="chip chip--danger">${errs.length} ${plural(errs.length, "ошибка", "ошибки", "ошибок")}</span></div>
        </div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px">Частые проблемы:</div>
        <div class="error-subtopics">
          ${Object.entries(subs).map(([sub, n]) => `<span class="chip chip--danger">${esc(sub)}${n > 1 ? ` ×${n}` : ""}</span>`).join("")}
        </div>
      </div>`;
    }).join("")}

    ${resolved.length ? `
    <div class="section-title">Закрытые</div>
    <div class="card" style="padding:8px 16px">
      ${resolved.slice(0, 8).map((e) => {
        const t = DataAPI.task(e.taskId);
        return `<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:var(--success)">${icon("check")}</span>
          <span style="color:var(--text-2)">${esc(t ? t.sub : e.sub)}</span>
          <span style="margin-left:auto;color:var(--muted);font-size:12px">${relTime(e.ts)}</span>
        </div>`;
      }).join("")}
    </div>` : ""}`;
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

function startErrorsReview() {
  const open = Store.state.errors.filter((e) => !e.resolved);
  if (!open.length) return toast("Открытых ошибок нет", "", "check");

  /* Частые подтемы идут раньше. Внутри подтемы каждый вопрос уникален:
     это исключает дубли и даёт второе, похожее задание, когда оно есть. */
  const subFreq = {};
  open.forEach((e) => { subFreq[e.sub] = (subFreq[e.sub] || 0) + 1; });
  const sorted = open.slice().sort((a, b) => subFreq[b.sub] - subFreq[a.sub]);
  const queue = reviewQueueForErrors(sorted);
  if (!queue || !queue.taskIds.length) return toast("Не удалось собрать повторение", "", "x");

  Session.start({
    title: "Повторение слабых мест",
    taskIds: queue.taskIds,
    mode: "errors",
    errorMap: queue.errorMap,
  });
}

/* ============================================================
   Screen: Испытания (daily + боссы)
   ============================================================ */

function screenTrials(root) {
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
        <div style="font-size:18px;font-weight:650;margin-top:8px">${dailyTitle}</div>
        <div style="margin:14px 0 6px">${progressBar(Math.min(dailySolved / dailyGoal, 1) * 100, dailyDone ? "progress--success" : "")}</div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="mono" style="font-size:13px;color:var(--text-2)">${Math.min(dailySolved, dailyGoal)} / ${dailyGoal}</span>
          <span class="chip chip--accent mono">+${d.xp} XP</span>
          <button class="btn ${dailyDone ? "btn--soft" : "btn--primary"} btn--sm" style="margin-left:auto" onclick="startDaily()">
            ${dailyDone ? "Повторить" : "Решать"}
          </button>
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
  if (!boss) return toast("Испытание не найдено", "toast--error", "x");
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
  const s = Store.state;
  const acc = s.totalSolved ? Math.round((s.totalCorrect / s.totalSolved) * 100) : 0;
  const avgTime = s.totalSolved ? Math.round(s.totalTimeSec / s.totalSolved) : 0;
  const skills = DataAPI.skills();
  const byProg = skills.slice().sort((a, b) => skillProgress(b.id) - skillProgress(a.id));
  // With every skill still at 0% (a brand-new account), sort() ties resolve
  // to catalog order — that would label skills №1-3 "strong" and №18-20
  // "needs attention" with zero real signal behind it. Show an honest empty
  // state instead of a ranking that looks meaningful but isn't.
  const hasSignal = byProg.some((sk) => skillProgress(sk.id) > 0);
  const strongest = hasSignal ? byProg.slice(0, 3) : [];
  const weakest = hasSignal ? byProg.slice(-3).reverse() : [];

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
          ${hasSignal ? weakest.map((sk) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px"><span>${sk.name}</span><span class="chip chip--danger mono">${skillProgress(sk.id)}%</span></div>`).join("")
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

function screenProfile(root) {
  const s = Store.state;
  const li = levelInfo();
  const acc = s.totalSolved ? Math.round((s.totalCorrect / s.totalSolved) * 100) : 0;
  const avgTime = s.totalSolved ? Math.round(s.totalTimeSec / s.totalSolved) : 0;
  const accountId = Store.accountId || "";
  const initial = s.name ? esc(s.name.trim().slice(0, 1).toUpperCase()) : "";

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">Профиль</div>
      <div class="page-sub">Твой путь в цифрах.</div>
    </div>

    <div class="card card--glow profile-card">
      <div class="profile-card__identity">
        <div class="avatar" aria-hidden="true">${initial || icon("profile")}</div>
        <div class="profile-card__who">
          <div class="profile-card__name">${s.name ? esc(s.name) : "Без имени"}</div>
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
        <div class="streak-chip profile-card__streak">${icon("flame")} ${s.streak} дн</div>
      </div>

      <div class="profile-card__progress">
        <div class="profile-card__level">
          <span class="level-chip__badge">Уровень ${li.level}</span>
          <span class="profile-card__xp mono">${li.current} / ${li.need} XP</span>
          <span class="profile-card__next">до уровня ${li.level + 1}</span>
        </div>
        ${progressBar(li.pct)}
      </div>
    </div>

    <div class="grid grid--4 stat-grid">
      <div class="card stat-card"><div class="action-card__icon">${icon("check")}</div><div><div class="stat-num mono">${s.totalSolved}</div><div class="stat-label">решено задач</div></div></div>
      <div class="card stat-card"><div class="action-card__icon">${icon("target")}</div><div><div class="stat-num mono">${acc}%</div><div class="stat-label">точность</div></div></div>
      <div class="card stat-card"><div class="action-card__icon">${icon("clock")}</div><div><div class="stat-num mono">${avgTime ? fmtTime(avgTime) : "—"}</div><div class="stat-label">среднее время</div></div></div>
      <div class="card stat-card"><div class="action-card__icon">${icon("flame")}</div><div><div class="stat-num mono">${s.bestSeries}</div><div class="stat-label">лучшая серия без ошибок</div></div></div>
    </div>

    <div class="section-title">Достижения</div>
    <div class="badge-grid">
      ${DataAPI.achievements().map((a) => {
        const un = achievementUnlocked(a.id);
        return `
        <div class="card badge-card ${un ? "" : "badge-card--locked"}">
          <div class="badge-icon">${icon(a.icon)}</div>
          <div class="badge-name">${a.name}</div>
          <div class="badge-desc">${a.desc}</div>
          ${un ? `<div style="margin-top:8px"><span class="chip chip--success">получено</span></div>` : `<div style="margin-top:8px"><span class="chip">закрыто</span></div>`}
        </div>`;
      }).join("")}
    </div>

    <div class="grid grid--2" style="margin-top:34px">
      <div>
        <div class="section-title" style="margin-top:0">История прогресса</div>
        <div class="card">
          ${s.timeline.length ? `<div class="timeline">
            ${s.timeline.slice(0, 10).map((t) => `
              <div class="timeline__item">
                <div class="timeline__date">${relTime(t.ts)}</div>
                <div class="timeline__text">${esc(t.text)}</div>
              </div>`).join("")}
          </div>` : `<div class="empty">Пока пусто — реши первое задание.</div>`}
        </div>
      </div>
      <div>
        <div class="section-title" style="margin-top:0">Данные</div>
        <div class="card">
          <div style="font-size:13px;color:var(--muted);line-height:1.6">
            Прогресс и результаты сохраняются на сервере в SQLite для этого аккаунта.
          </div>
          <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
            <button class="btn btn--danger-soft btn--sm" onclick="resetProgress()">Сбросить прогресс</button>
          </div>
        </div>
      </div>
    </div>`;
}

function resetProgress() {
  openModal(`
    <div style="font-size:18px;font-weight:700">Сбросить весь прогресс?</div>
    <div style="color:var(--muted);font-size:14px;margin-top:10px">XP, уровни, ошибки, достижения и статистика будут удалены безвозвратно. Онбординг начнётся заново.</div>
    <div style="display:flex;gap:10px;margin-top:22px;justify-content:flex-end">
      <button class="btn btn--ghost" onclick="closeModal()">Отмена</button>
      <button class="btn btn--danger-soft" onclick="Store.reset();closeModal();location.hash='#/dashboard';render()">Сбросить</button>
    </div>`);
}

/* ============================================================
   Onboarding — первый запуск
   ============================================================ */

const NAME_MAX_LENGTH = 60;

const Onboarding = {
  step: 0,
  selfLevel: null,
  goal: null,
  name: null,
  diagIdx: 0,
  diagResults: [],
  diagAnswered: false,

  show() {
    if (document.getElementById("onboard-overlay")) return;
    const div = document.createElement("div");
    div.className = "onboard-overlay";
    div.id = "onboard-overlay";
    document.body.appendChild(div);
    this.step = 0;
    this.render();
  },

  hide() {
    const el = document.getElementById("onboard-overlay");
    if (el) el.remove();
  },

  render() {
    const el = document.getElementById("onboard-overlay");
    if (!el) return;
    const steps = 6;
    el.innerHTML = `
      <div class="onboard-card">
        <div class="onboard-steps">${Array.from({ length: steps }, (_, i) => `<i class="${i <= this.step ? "on" : ""}"></i>`).join("")}</div>
        <div id="onboard-body"></div>
      </div>`;
    const body = el.querySelector("#onboard-body");
    [this.stepWelcome, this.stepLevel, this.stepGoal, this.stepDiagnostic, this.stepResult, this.stepName][this.step].call(this, body);
  },

  stepWelcome(body) {
    body.innerHTML = `
      <div class="onboard-title">Добро пожаловать в EGE CORE</div>
      <div class="onboard-sub">
        Это система подготовки к профильной математике, построенная как игра прогресса:
        уровни, XP, миссии, навыки и босс-испытания. Без мишуры — только математика и измеримый рост.<br><br>
        Сейчас мы за 2 минуты построим твой стартовый профиль: определим уровень, цель и сильные стороны.
      </div>
      <div style="margin-top:28px"><button class="btn btn--primary btn--lg" onclick="Onboarding.next()">Начать ${icon("arrow")}</button></div>`;
  },

  stepLevel(body) {
    body.innerHTML = `
      <div class="onboard-title">Какой у тебя текущий уровень?</div>
      <div class="onboard-sub">Честный ответ поможет точнее выставить стартовые навыки.</div>
      <div class="choice-list">
        <button class="choice-item" onclick="Onboarding.pickLevel('zero')"><b>Начинаю с нуля</b><span>База школьной программы неустойчива</span></button>
        <button class="choice-item" onclick="Onboarding.pickLevel('base')"><b>Базовый уровень</b><span>Решаю первую часть, вторая — с трудом</span></button>
        <button class="choice-item" onclick="Onboarding.pickLevel('confident')"><b>Уверенный</b><span>Решаю и вторую часть, хочу стабильности и скорости</span></button>
      </div>`;
  },

  stepGoal(body) {
    body.innerHTML = `
      <div class="onboard-title">Какая цель по баллам?</div>
      <div class="onboard-sub">Сохраним её в профиле как ориентир подготовки.</div>
      <div class="choice-list">
        ${DataAPI.goals().map((g) => `<button class="choice-item" onclick="Onboarding.pickGoal('${g.id}')"><b>${g.label}</b><span>${g.desc}</span></button>`).join("")}
      </div>`;
  },

  stepDiagnostic(body) {
    const diagnosticTasks = DataAPI.diagnosticTasks();
    const t = DataAPI.task(diagnosticTasks[this.diagIdx]);
    this.diagAnswered = false;
    body.innerHTML = `
      <div class="onboard-title" style="font-size:20px">Диагностика · ${this.diagIdx + 1} / ${diagnosticTasks.length}</div>
      <div class="onboard-sub">Короткий тест из 5 заданий по разным темам — по нему построим карту навыков.</div>
      <div class="card task-card" style="margin-top:18px;padding:20px">
        <div class="task-card__tags"><span class="chip chip--accent">${t.num}</span><span class="chip">${esc(t.sub)}</span></div>
        <div class="task-card__text" style="font-size:15px">${mathText(t.text)}</div>
        ${taskVisualHtml(t, "diagnostic")}
        <div class="answer-row">
          <input class="answer-input" id="diagInput" placeholder="Ответ" autocomplete="off" inputmode="${answerInputMode(t.answer)}">
          <button class="btn btn--primary" onclick="Onboarding.answerDiag()">Ответить</button>
        </div>
        <div id="diagFeedback"></div>
      </div>`;
    const input = body.querySelector("#diagInput");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") Onboarding.answerDiag(); });
  },

  stepResult(body) {
    const total = this.diagResults.length;
    const correct = this.diagResults.filter((r) => r.correct).length;
    const startLevel = Math.round(20 + (correct / Math.max(total, 1)) * 60);

    const strong = [], weak = [];
    for (const r of this.diagResults) {
      const name = DataAPI.skill(DataAPI.task(r.taskId).skill).name;
      (r.correct ? strong : weak).push(name);
    }
    if (this.selfLevel === "confident" && strong.length === 0) strong.push("Базовые навыки");
    if (weak.length === 0) weak.push("Пока не выявлены");

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
            <div class="error-subtopics">${weak.map((n) => `<span class="chip chip--danger">${n}</span>`).join("")}</div>
          </div>
        </div>
      </div>
      <div class="onboard-sub" style="margin-top:16px">
        На главной странице блок <b style="color:var(--text)">«Что делать сейчас»</b> будет подсказывать лучший следующий шаг — урок, тренировку или повторение ошибок — и пересчитывать его после каждого результата.
      </div>
      <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">
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
      <div style="margin-top:24px"><button class="btn btn--primary btn--lg" onclick="Onboarding.submitName()">Завершить ${icon("arrow")}</button></div>`;
    const input = body.querySelector("#nameInput");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") Onboarding.submitName(); });
    input.focus();
  },

  pickLevel(v) { this.selfLevel = v; this.next(); },
  pickGoal(v) { this.goal = v; this.next(); },

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

  next() {
    if (this.step === 3) return;
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
    this.finish();
  },

  finish() {
    applyOnboarding(this.selfLevel || "base", this.goal || "g60", this.diagResults, this.name);
    this.hide();
    toast(`Добро пожаловать, ${esc(Store.state.name)}! Профиль создан.`, "toast--xp", "flag");
    render();
  },
};

/* ============================================================
   Boot
   ============================================================ */

function showBootError(error) {
  const screen = document.getElementById("screen");
  document.getElementById("topbar").innerHTML = "";
  screen.innerHTML = `<div class="card" style="max-width:640px;margin:64px auto;text-align:center">
    <div class="page-title">Сервер недоступен</div>
    <div style="margin-top:12px;color:var(--text-2);line-height:1.6">Данные аккаунта не загружены. Запусти backend и обнови страницу.</div>
    <div class="mono" style="margin-top:12px;color:var(--muted);font-size:12px">${esc(error.message || error)}</div>
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
};
MathVisualMount.init();

let bootPromise = null;

function bootstrapApp() {
  if (bootPromise) return bootPromise;
  const screen = document.getElementById("screen");
  screen.innerHTML = `<div class="card" style="max-width:420px;margin:64px auto;text-align:center;color:var(--text-2)">Загрузка данных аккаунта…</div>`;
  bootPromise = (async () => {
    try {
      await Store.load();
      render();
    } catch (error) {
      showBootError(error);
    }
  })();
  return bootPromise;
}

document.addEventListener("DOMContentLoaded", bootstrapApp);
if (document.readyState !== "loading") bootstrapApp();
