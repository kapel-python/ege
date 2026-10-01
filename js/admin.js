/* ============================================================
   ege easy — Admin panel
   Отдельный интерфейс управления. Все данные — только из
   /api/admin/*; авторизация — подписанная серверная admin-сессия
   в HttpOnly cookie (js не видит и не хранит её). Любой ответ 401
   возвращает на форму пароля: фронтенд никогда не решает, есть ли
   доступ, это проверяет backend на каждом запросе.
   ============================================================ */

/* ---------------- утилиты ---------------- */

const A = {
  root: document.getElementById("admin-root"),
  modalRoot: document.getElementById("admin-modal-root"),
  toastRoot: document.getElementById("admin-toast-root"),
  session: null, // {user: {id, accountId, name}, expiresAt} — из GET /api/admin/session
  usersCache: null,
  activitySelected: null, // ISO-дата выбранного столбца графика активности
  activityDays: (() => {
    try {
      const v = Number(localStorage.getItem("ege_admin_activity_days"));
      if ([1, 7, 14, 30].includes(v)) return v;
    } catch (e) {}
    return 14;
  })(),
};

/* Периоды графика активности. Значение — число московских суток. */
const ACTIVITY_PERIODS = [
  { days: 1, label: "24 ч" },
  { days: 7, label: "7 дней" },
  { days: 14, label: "14 дней" },
  { days: 30, label: "30 дней" },
];

function activityDays() {
  return [1, 7, 14, 30].includes(Number(A.activityDays)) ? Number(A.activityDays) : 14;
}

function activityPeriodTitle(days) {
  return days === 1 ? "Активность за 24 часа" : `Активность за ${days} ${plural(days, "день", "дня", "дней")}`;
}

/* День считается «с данными», только если есть хоть какая-то активность. */
function activityHasData(d) {
  return !!d && (Number(d.solved) > 0 || Number(d.correct) > 0 || Number(d.users) > 0 || Number(d.xp) > 0);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Хэш — недоверенный ввод: % без пары hex разрядов роняет decodeURIComponent
// с URIError, а render() не имеет вокруг него try/catch. Раньше такая ссылка
// навсегда оставляла панель в unhandled rejection.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts) || ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts) || ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtShortDate(isoDate) {
  if (!isoDate) return "—";
  const [y, m, d] = String(isoDate).split("-");
  return `${d} ${MON[Number(m) - 1] || m}`;
}

function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("ru-RU");
}

function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} дн`;
}

function fmtUptime(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`;
  return `${Math.floor(sec / 86400)} дн ${Math.floor((sec % 86400) / 3600)} ч`;
}

function fmtBytes(n) {
  if (!n) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const GOAL_LABELS = { g60: "60+ баллов", g80: "80+ баллов", g95: "95+ баллов", g3: "Оценка 3 (база)", g4: "Оценка 4 (база)", g5: "Оценка 5 (база)" };
const LEVEL_LABELS = { zero: "С нуля", base: "Базовый", confident: "Уверенный" };

/* ---------- блокировки ---------- */

const BLOCK_DURATIONS = [
  { id: "1h", title: "1 час", secs: 3600 },
  { id: "1d", title: "1 день", secs: 86400 },
  { id: "1w", title: "1 неделя", secs: 604800 },
  { id: "1m", title: "1 месяц", secs: 2592000 },
  { id: "permanent", title: "Навсегда", secs: null },
];

function blockUntilPreview(durationId) {
  const d = BLOCK_DURATIONS.find((x) => x.id === durationId);
  if (!d) return "";
  if (d.secs == null) return "Без срока окончания";
  try {
    return "До " + new Date(Date.now() + d.secs * 1000).toLocaleString("ru-RU", {
      day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    });
  } catch (e) { return ""; }
}

function fmtBlockShort(block) {
  if (!block) return "";
  if (block.permanent || block.blockedUntil == null) return "Заблокирован · навсегда";
  try {
    const s = new Date(Number(block.blockedUntil)).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    return `Заблокирован · до ${s}`;
  } catch (e) { return "Заблокирован"; }
}

function fmtBlockUntil(block) {
  if (!block) return "—";
  if (block.permanent || block.blockedUntil == null) return "Бессрочно";
  return fmtDateTime(block.blockedUntil);
}

function adminSubjectName(value, fallback = "Предмет") {
  if (value && typeof value === "object") {
    value = value.title || value.name || value.short || value.id;
  }
  const text = String(value || "").trim();
  return text || fallback;
}

/* Онбординг — свойство АККАУНТА, а не открытого предмета: человек, прошедший
   его в русском, остаётся «онбординг пройден», когда админ смотрит его профиль
   по профильной математике. Поэтому бейдж строится по onboardedAny, а рядом
   перечисляются предметы, где онбординг реально пройден (список приходит с
   сервера и новым предметом пополняется сам). */
function adminOnboardedSubjects(user) {
  const list = user && Array.isArray(user.onboardedSubjects) ? user.onboardedSubjects : [];
  return list.map((item) => adminSubjectName(item && typeof item === "object" ? item : { id: item }, "Предмет"));
}

function onboardedBadge(user) {
  const any = !!(user && (user.onboardedAny ?? user.onboarded));
  if (!any) return `<span class="a-chip a-chip--warn">онбординг не пройден</span>`;
  const done = adminOnboardedSubjects(user);
  // Предметы в чип не пишем: длинный nowrap-чип («онбординг пройден ·
  // Базовая математика, ...») вылезал за край экрана на телефонах. Полный
  // список уже виден строкой ниже («Онбординг пройден»), а здесь он остаётся
  // в подсказке при наведении.
  const title = done.length ? ` title="Пройден в: ${esc(done.join(", "))}"` : "";
  return `<span class="a-chip a-chip--success"${title}>онбординг пройден</span>`;
}

function adminSubjectLocked(user) {
  if (!user || typeof user !== "object") return false;
  if (user.subjectLocked === true || user.locked === true) return true;
  const status = String(user.subjectStatus || user.status || "").trim().toLowerCase().replace(/_/g, "-");
  return ["locked", "coming-soon", "soon", "disabled", "unavailable"].includes(status);
}

/* ---------------- API ---------------- */

const AdminApi = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (response.status === 401) {
      const payload = await response.json().catch(() => ({}));
      // Сессия отсутствует/истекла/невалидна — backend решил, не фронтенд.
      throw Object.assign(new Error(payload.error || "Нет admin-сессии"), { unauthorized: true });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // retryAfter прокидываем наверх: троттлинг проб (пауза в несколько секунд
      // между соседними нажатиями) не должен выглядеть как «ошибка» — клиент
      // обязан сказать «подожди N с» вместо «не удалось проверить».
      const retry = Number(payload.retryAfter) || 0;
      const err = new Error(payload.error || `API ${response.status}`);
      if (retry > 0) err.retryAfter = retry;
      throw err;
    }
    return payload;
  },
  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: "POST", body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }); },
};

/* ---------------- тема / тосты ---------------- */

const AdminTheme = {
  key: "ege_core_theme",
  current() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; },
  toggle() {
    const dark = this.current() !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "";
    try { localStorage.setItem(this.key, dark ? "dark" : "light"); } catch (e) {}
    render();
  },
};

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `a-toast a-toast--${kind}`;
  el.textContent = message;
  A.toastRoot.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, 3200);
}

/* ---------------- иконки ---------------- */

const AICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.4 3-5.6 6.5-5.6s6.5 2.2 6.5 5.6"/><circle cx="17.5" cy="9" r="2.6"/><path d="M16.8 14.6c2.9.3 4.7 2.2 4.7 4.9"/></svg>',
  blocked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M8 8l8 8M16 8L8 16"/><path d="M12 8v8M8 12h8" stroke-width="1.5"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2.5-8h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/><path d="M3 13h6l1.5 2.5h3L15 13h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 7.5l8.2 5.5a1 1 0 0 0 1.2 0L21 7.5"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10.5a7 7 0 0 1 14 0v10a.6.6 0 0 1-1 .55l-2.1-1.5a.6.6 0 0 0-.66 0l-2.24 1.5a.6.6 0 0 1-.66 0l-2.24-1.5a.6.6 0 0 0-.66 0L6 21.05a.6.6 0 0 1-1-.55z"/><circle cx="9.4" cy="11" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.6" cy="11" r="1.15" fill="currentColor" stroke="none"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22c4.4 0 7-2.8 7-6.5 0-3-2-5.5-3.5-7C14 7 13 5.5 13 3c-3 2-5 5-5 8-1-.5-1.8-1.5-2-3-1.5 1.6-3 4-3 6.5C3 19.2 7.6 22 12 22z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-7 4 14 3-7h6"/></svg>',
};

function aicon(name) {
  return (AICONS[name] || AICONS.dashboard).replace("<svg ", '<svg width="1em" height="1em" style="vertical-align:-0.15em" ');
}

/* ---------------- роутер ---------------- */

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  return { name: parts[0] || "dashboard", param: parts[1] || null };
}

function navigate(path) { location.hash = path; }

/* ---------------- рендер-каркас ---------------- */

const SECTIONS = [
  { id: "dashboard", title: "Обзор", short: "Обзор", icon: "dashboard" },
  { id: "providers", title: "Провайдеры", short: "ИИ", icon: "cpu" },
  { id: "inbox", title: "Обращения", short: "Обращения", icon: "inbox" },
  { id: "users", title: "Пользователи", short: "Люди", icon: "users" },
  { id: "blocked", title: "Заблокированные", short: "Блокировки", icon: "blocked" },
  { id: "audit", title: "Журнал действий", short: "Журнал", icon: "audit" },
];

function renderShell(activeSection, screenHTML) {
  const u = A.session?.user || {};
  const expires = A.session?.expiresAt ? fmtDate(A.session.expiresAt) : "";
  A.root.innerHTML = `
    <div class="admin-app">
      <aside class="admin-sidebar">
        <div class="admin-logo admin-logo--easy">
          <span class="easy-badge"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 13.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span class="easy-name">ege <em>easy</em></span>
          <span class="logo-sub">admin panel</span>
        </div>
        <nav class="admin-nav">
          ${SECTIONS.map((s) => `
            <a class="nav-item ${s.id === activeSection ? "active" : ""}" href="#/${s.id}">
              ${aicon(s.icon)}<span>${s.title}</span>
            </a>`).join("")}
        </nav>
        <div class="admin-sidebar__footer">
          <div class="admin-user-line">
            <span class="acct">${esc(u.accountId || "")}</span>
            ${u.name ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.name)}</span>` : ""}
          </div>
          <div style="font-size:11px">сессия до ${esc(expires)}</div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <button class="btn btn--soft btn--sm" id="themeBtn" title="Переключить тему">${aicon(AdminTheme.current() === "dark" ? "sun" : "moon")}</button>
            <button class="btn btn--soft btn--sm" id="logoutBtn">Выйти ${aicon("logout")}</button>
          </div>
        </div>
      </aside>
      <div class="admin-main">
        <header class="admin-topbar">
          <span class="admin-topbar__title">${esc(SECTIONS.find((s) => s.id === activeSection)?.title || "Пользователь")}</span>
          <span class="admin-topbar__spacer"></span>
          <a class="btn btn--primary btn--sm admin-topbar__return" href="/dashboard" aria-label="Вернуться в приложение">${aicon("back")}<span>Вернуться в приложение</span></a>
          <span class="chip chip--accent hide-mobile">ADMIN</span>
        </header>
        <main class="admin-screen" id="adminScreen">${screenHTML}</main>
      </div>
      <nav class="admin-bottomnav">
        ${SECTIONS.map((s) => `<a href="#/${s.id}" class="${s.id === activeSection ? "active" : ""}" title="${esc(s.title)}">${aicon(s.icon)}<span>${esc(s.short || s.title)}</span></a>`).join("")}
      </nav>
    </div>`;
  document.getElementById("themeBtn").onclick = () => AdminTheme.toggle();
  document.getElementById("logoutBtn").onclick = logout;
}

async function logout() {
  try { await AdminApi.post("/api/admin/logout", {}); } catch (e) { /* сервер очистит cookie в любом случае */ }
  A.session = null;
  A.usersCache = null;
  location.hash = "";
  renderLogin();
  toast("Вы вышли из админ-панели");
}

/* ---------------- экран входа ---------------- */

function renderLogin(error = "") {
  A.root.innerHTML = `
    <div class="admin-login">
      <div class="admin-login__card">
        <span class="admin-login__mark">ege <em>easy</em></span>
        <div class="admin-login__title">Админ-панель</div>
        <div class="admin-login__sub">Закрытый раздел управления платформой. Введите админ-пароль — он проверяется только на сервере, сессия живёт 30 дней и привязана к вашему аккаунту.</div>
        <form class="admin-login__form" id="loginForm">
          <input class="a-input" type="password" id="pwInput" placeholder="Админ-пароль" autocomplete="current-password" autofocus required>
          ${error ? `<div class="admin-login__error" id="loginError">${esc(error)}</div>` : ""}
          <button class="btn btn--primary btn--lg" type="submit" id="loginBtn" style="justify-content:center">Войти</button>
          <div class="admin-login__hint">Текущий аккаунт: <span class="mono" id="whoami">проверяем…</span>.<br>Если нужно войти под другим аккаунтом — сначала выйдите в основном приложении.</div>
        </form>
      </div>
    </div>`;
  const form = document.getElementById("loginForm");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("loginBtn");
    btn.disabled = true;
    btn.textContent = "Проверяем…";
    const errEl = document.getElementById("loginError");
    if (errEl) errEl.remove();
    try {
      const password = document.getElementById("pwInput").value;
      const result = await AdminApi.post("/api/admin/login", { password });
      A.session = { user: result.user, expiresAt: result.expiresAt };
      toast("Вход выполнен");
      if (!location.hash) location.hash = "#/dashboard";
      render();
    } catch (e) {
      const div = document.createElement("div");
      div.className = "admin-login__error";
      div.id = "loginError";
      div.textContent = e.message || "Ошибка входа";
      form.insertBefore(div, btn);
      btn.disabled = false;
      btn.textContent = "Войти";
      document.getElementById("pwInput").select();
    }
  };
  // Подпись «кто я» — обычный bootstrap, чтобы было видно, к какому аккаунту
  // будет привязана admin-сессия.
  fetch("/api/bootstrap", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((p) => {
      const el = document.getElementById("whoami");
      if (el) el.textContent = p.accountId ? `${p.accountId}${p.state?.name ? " · " + p.state.name : ""}` : "новый аккаунт";
    })
    .catch(() => {
      const el = document.getElementById("whoami");
      if (el) el.textContent = "недоступен";
    });
}

/* ---------------- Dashboard ---------------- */

function statTile(label, value, sub = "") {
  return `<div class="a-stat"><div class="a-stat__label">${esc(label)}</div><div class="a-stat__value">${value}</div>${sub ? `<div class="a-stat__sub">${sub}</div>` : ""}</div>`;
}

function activityChart(activity, selectedDate = null) {
  /* Столбцы решённых заданий по дням. Одна метрика — один цвет (accent),
     значения на крайних столбцах + tooltip; сетка hairline.
     Кликабельны только дни с данными (activityHasData): пустые столбцы
     рисуются приглушёнными и никак не реагируют на нажатие. */
  const W = 640, H = 190, PAD_L = 34, PAD_R = 8, PAD_T = 16, PAD_B = 26;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxV = Math.max(1, ...activity.map((d) => d.solved));
  const step = plotW / Math.max(1, activity.length);
  const barW = Math.min(activity.length === 1 ? 120 : 24, Math.max(4, step - 8));
  const ticks = [0, Math.round(maxV / 2), maxV];
  // Подписи оси X: чем длиннее период, тем реже (иначе сливаются).
  const stride = activity.length <= 7 ? 1 : activity.length <= 14 ? 2 : 5;
  let bars = "";
  activity.forEach((d, i) => {
    const has = activityHasData(d);
    const selected = selectedDate != null && d.date === selectedDate;
    const h = Math.round((d.solved / maxV) * plotH);
    const x = PAD_L + i * step + (step - barW) / 2;
    const y = PAD_T + plotH - h;
    const label = d.solved > 0 && (i === activity.length - 1 || d.solved === maxV)
      ? `<text class="bar-label" x="${x + barW / 2}" y="${y - 5}" text-anchor="middle">${d.solved}</text>` : "";
    const tip = `${fmtShortDate(d.date)}: ${d.solved} решено, ${d.correct} верно, ${d.users} ${plural(d.users, "активный", "активных", "активных")}, +${d.xp} XP`;
    bars += `<g>
      <rect class="bar-hit${has ? " bar-hit--active" : " bar-hit--empty"}" x="${PAD_L + i * step}" y="${PAD_T}" width="${step}" height="${plotH}"
        data-date="${esc(d.date)}" data-tip="${esc(tip)}"${has ? "" : ` aria-hidden="true"`}></rect>
      <rect class="bar${has ? "" : " bar--empty"}${selected ? " bar--selected" : ""}" x="${x}" y="${Math.min(y, PAD_T + plotH)}" width="${barW}" height="${Math.max(h, has ? 2 : 0)}" rx="4"></rect>
      ${label}
    </g>`;
  });
  const grid = ticks.map((t) => {
    const y = PAD_T + plotH - Math.round((t / maxV) * plotH);
    return `<line class="grid-line" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"></line>
      <text class="axis-label" x="${PAD_L - 6}" y="${y + 3}" text-anchor="end">${t}</text>`;
  }).join("");
  const xLabels = activity
    .map((d, i) => (i % stride === 1 || activity.length === 1 ? `<text class="axis-label" x="${PAD_L + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtShortDate(d.date))}</text>` : ""))
    .join("");
  const periodWord = activity.length === 1 ? "24 часа" : `${activity.length} ${plural(activity.length, "день", "дня", "дней")}`;
  return `<div class="a-chart-box">
    <svg class="a-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Решённые задания по дням за ${periodWord}">
      ${grid}${bars}${xLabels}
    </svg>
    <div class="a-chart-tooltip" id="chartTip"></div>
  </div>`;
}

/* Мини-блок с подробностями выбранного дня: 4 плитки
   (решено / точность / активных / XP). Пустым дням соответствует
   подсказка-приглашение, а не нулевые плитки. */
function chartDetailHTML(d) {
  if (!activityHasData(d)) {
    return `<div class="a-detail-hint">Нажмите на столбец с данными, чтобы увидеть подробности дня</div>`;
  }
  const acc = d.solved > 0 ? Math.round((d.correct / d.solved) * 100) : null;
  const tile = (label, value, sub) => `<div class="a-detail-tile"><div class="a-detail-tile__label">${label}</div><div class="a-detail-tile__value">${value}</div><div class="a-detail-tile__sub">${sub}</div></div>`;
  return `<div class="a-detail__head"><span>Подробности · ${fmtShortDate(d.date)}</span><button class="a-detail__close" id="chartDetailClose" aria-label="Закрыть подробности">✕</button></div>
  <div class="a-detail-grid">
    ${tile("Решено", fmtNum(d.solved), `верно: ${fmtNum(d.correct)}`)}
    ${tile("Точность", acc == null ? "—" : `${acc}%`, d.solved ? `${fmtNum(d.correct)} из ${fmtNum(d.solved)}` : "попыток нет")}
    ${tile("Активных", fmtNum(d.users), plural(d.users, "ученик", "ученика", "учеников"))}
    ${tile("XP", `+${fmtNum(d.xp)}`, "начислено за день")}
  </div>`;
}

function paintChartDetail(container, date, activity) {
  const slot = container.querySelector("#chartDetail");
  if (!slot) return;
  const d = (activity || []).find((x) => x.date === date);
  slot.innerHTML = chartDetailHTML(activityHasData(d) ? d : null);
  const close = slot.querySelector("#chartDetailClose");
  if (close) {
    close.onclick = () => {
      A.activitySelected = null;
      container.querySelectorAll(".a-chart .bar--selected").forEach((b) => b.classList.remove("bar--selected"));
      slot.innerHTML = chartDetailHTML(null);
    };
  }
}

function bindChartTooltip(container, activity) {
  const tip = container.querySelector("#chartTip");
  const box = container.querySelector(".a-chart-box");
  if (!tip || !box) return;
  box.querySelectorAll(".bar-hit").forEach((rect) => {
    rect.addEventListener("mousemove", (ev) => {
      tip.textContent = rect.dataset.tip;
      tip.style.display = "block";
      const bounds = box.getBoundingClientRect();
      let x = ev.clientX - bounds.left + 12;
      const tipW = tip.offsetWidth;
      if (x + tipW > bounds.width) x = ev.clientX - bounds.left - tipW - 12;
      tip.style.left = `${x}px`;
      tip.style.top = `${ev.clientY - bounds.top - 34}px`;
    });
    rect.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });
  /* Выбор дня: реагируют ТОЛЬКО столбцы с данными. Пустые дни
     (bar-hit--empty) клик игнорируют полностью. Без tabindex: клик по
     столбцу не ставит фокус, никакой обводки не появляется. */
  const select = (rect) => {
    if (!rect || !rect.classList.contains("bar-hit--active")) return;
    const date = rect.dataset.date;
    tip.style.display = "none";
    if (A.activitySelected === date) {
      A.activitySelected = null;
      box.querySelectorAll(".bar--selected").forEach((b) => b.classList.remove("bar--selected"));
      paintChartDetail(container, null, activity);
      return;
    }
    A.activitySelected = date;
    box.querySelectorAll(".bar--selected").forEach((b) => b.classList.remove("bar--selected"));
    const idx = Array.from(box.querySelectorAll(".bar-hit")).indexOf(rect);
    const bar = box.querySelectorAll(".bar")[idx];
    if (bar) bar.classList.add("bar--selected");
    paintChartDetail(container, date, activity);
  };
  box.querySelectorAll(".bar-hit--active").forEach((rect) => {
    rect.addEventListener("click", () => select(rect));
  });
}

async function screenDashboard() {
  renderShell("dashboard", `<div class="a-skeleton" style="height:90px"></div><div class="a-skeleton" style="height:280px;margin-top:16px"></div>`);
  const days = activityDays();
  A.activitySelected = null;
  let data;
  try {
    data = await AdminApi.get(`/api/admin/overview?days=${days}`);
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    renderShell("dashboard", `<div class="a-error-banner">Не удалось загрузить обзор: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  const u = data.users, l = data.learning, s = data.system;
  const accuracy = l.accuracy == null ? "—" : `${l.accuracy}%`;
  const screen = `
    <div class="a-stats">
      ${statTile("Аккаунтов", fmtNum(u.total), `+${u.newToday} за 24 ч · +${u.newWeek} за неделю`)}
      ${statTile("Онбординг прошли", fmtNum(u.onboarded), `${Math.round((u.onboarded / Math.max(1, u.total)) * 100)}% аккаунтов · не прошли: ${fmtNum(u.withoutOnboarding ?? Math.max(0, u.total - u.onboarded))}`)}
      ${statTile("Активны сегодня", fmtNum(u.activeToday), `за 7 дней: <span class="up">${fmtNum(u.activeWeek)}</span>`)}
      ${statTile("Решали задания", fmtNum(u.activeEver), `средний XP: ${fmtNum(Math.round(u.avgXp))}`)}
    </div>
    <div class="a-section-title">Обучение</div>
    <div class="a-stats">
      ${statTile("Решено всего", fmtNum(l.solvedTotal), `${fmtNum(l.attemptsToday)} попыток за 24 ч`)}
      ${statTile("Точность", accuracy, `${fmtNum(l.correctTotal)} верных ответов`)}
      ${statTile("XP начислено", fmtNum(l.xpTotal), `рекорд серии: ${u.bestStreak} дн.`)}
      ${statTile("Открытые ошибки", fmtNum(l.openErrors), `подсказок использовано: ${fmtNum(l.hintsUsed)}`)}
    </div>
    <div class="a-grid-main" style="margin-top:16px">
      <div class="a-card" id="activityCard">
        <div class="a-card__head a-card__head--wrap">
          <span class="a-card__title" id="activityTitle">${esc(activityPeriodTitle(days))}</span>
          <span class="a-seg" role="group" aria-label="Период активности">
            ${ACTIVITY_PERIODS.map((p) => `<button class="a-seg__btn${p.days === days ? " a-seg__btn--active" : ""}" data-days="${p.days}" aria-pressed="${p.days === days ? "true" : "false"}">${p.label}</button>`).join("")}
          </span>
        </div>
        <div class="a-card__sub" id="activitySummary"></div>
        <div id="activityChartWrap"></div>
        <div class="a-detail" id="chartDetail"></div>
      </div>
      <div class="a-card">
        <div class="a-card__head"><span class="a-card__title">Лидеры по XP</span></div>
        ${data.leaders.length ? `<table class="a-table" style="border:none">
          <tbody>
            ${data.leaders.map((p) => `
              <tr class="clickable" data-goto="#/users/${esc(p.accountId || p.id)}">
                <td style="padding-left:0"><b>${esc(p.name || "Без имени")}</b><div style="font-size:11.5px;color:var(--muted)" class="mono">${esc(p.accountId || "")} · Lv ${p.level}</div></td>
                <td class="num" style="text-align:right">${fmtNum(p.xp)} XP</td>
              </tr>`).join("")}
          </tbody></table>` : `<div class="a-empty"><div class="a-empty__title">Пока нет активных учеников</div><div class="a-empty__sub">Лидеры появятся, когда кто-то решит первое задание</div></div>`}
      </div>
    </div>
    <div class="a-section-title">Контент и навыки</div>
    <div class="a-grid-main">
      <div class="a-card">
        <div class="a-card__head"><span class="a-card__title">Освоение навыков</span><span class="a-card__sub">средний прогресс среди тех, кто касался навыка</span></div>
        ${data.skills.filter((sk) => sk.users > 0).length ? data.skills.filter((sk) => sk.users > 0).slice(0, 12).map((sk) => `
          <div class="a-skill-row">
            <div><div class="a-skill-row__name">${esc(sk.name)}</div><div class="a-skill-row__topic">${esc(sk.topic || "")} · ${sk.users} ${plural(sk.users, "ученик", "ученика", "учеников")} · ${fmtNum(sk.solved)} решений</div></div>
            <div class="a-bar"><div class="a-bar__fill ${sk.avgProgress >= 70 ? "a-bar__fill--success" : sk.avgProgress < 35 ? "a-bar__fill--warn" : ""}" style="width:${Math.min(100, sk.avgProgress)}%"></div></div>
            <div class="a-skill-row__pct">${Math.round(sk.avgProgress)}%</div>
          </div>`).join("") : `<div class="a-empty"><div class="a-empty__title">Данных о прохождении навыков ещё нет</div></div>`}
      </div>
      <div>
        <div class="a-card">
          <div class="a-card__head"><span class="a-card__title">Каталог</span></div>
          <div class="a-kv">
            <div class="a-kv__item"><div class="a-kv__k">Заданий</div><div class="a-kv__v">${fmtNum(data.catalog.tasks)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Уроков</div><div class="a-kv__v">${fmtNum(data.catalog.lessons)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Миссий</div><div class="a-kv__v">${fmtNum(data.catalog.missions)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Боссов</div><div class="a-kv__v">${fmtNum(data.catalog.bosses)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Навыков</div><div class="a-kv__v">${fmtNum(data.catalog.skills)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Достижений</div><div class="a-kv__v">${fmtNum(data.catalog.achievements)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Уроков пройдено</div><div class="a-kv__v">${fmtNum(l.completedLessons)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Миссий закрыто</div><div class="a-kv__v">${fmtNum(l.missionsDone)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Боссов повержено</div><div class="a-kv__v">${fmtNum(l.bossesDefeated)}</div></div>
          </div>
        </div>
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">Система</span></div>
          <div class="a-kv">
            <div class="a-kv__item"><div class="a-kv__k">Аптайм</div><div class="a-kv__v">${fmtUptime(s.uptimeSec)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Запуск</div><div class="a-kv__v">${fmtDateTime(s.startedAt)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Python</div><div class="a-kv__v">${esc(s.python)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">База</div><div class="a-kv__v">${fmtBytes(s.dbSizeBytes)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">Admin-сессий активно</div><div class="a-kv__v">${fmtNum(s.adminSessions)}</div></div>
            <div class="a-kv__item"><div class="a-kv__k">XP-корректировок</div><div class="a-kv__v">${fmtNum(s.xpAdjustments)}</div></div>
          </div>
          <div class="a-card__sub" style="margin-top:10px;word-break:break-all">${esc(s.dbPath)}</div>
        </div>
      </div>
    </div>`;
  renderShell("dashboard", screen);
  const screenEl = document.getElementById("adminScreen");
  const card = screenEl.querySelector("#activityCard");
  paintActivityCard(card, data.activity);
  card.querySelectorAll(".a-seg__btn").forEach((btn) => {
    btn.onclick = async () => {
      const next = Number(btn.dataset.days);
      if (![1, 7, 14, 30].includes(next) || next === activityDays()) return;
      A.activityDays = next;
      try { localStorage.setItem("ege_admin_activity_days", String(next)); } catch (e) {}
      A.activitySelected = null;
      card.querySelectorAll(".a-seg__btn").forEach((b) => {
        const on = Number(b.dataset.days) === next;
        b.classList.toggle("a-seg__btn--active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      card.querySelector("#activityTitle").textContent = activityPeriodTitle(next);
      await refreshActivityCard(card);
    };
  });
  screenEl.querySelectorAll("[data-goto]").forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.goto; };
  });
}

/* Перерисовка графика + сводки + мини-блока без перезагрузки всего дашборда. */
function paintActivityCard(card, activity) {
  if (!card) return;
  const days = activityDays();
  const wrap = card.querySelector("#activityChartWrap");
  const summary = card.querySelector("#activitySummary");
  const totSolved = activity.reduce((n, d) => n + Number(d.solved || 0), 0);
  const totXp = activity.reduce((n, d) => n + Number(d.xp || 0), 0);
  const activeDays = activity.filter(activityHasData).length;
  summary.textContent = days === 1
    ? (activeDays ? `Итого за 24 часа: ${fmtNum(totSolved)} решено · +${fmtNum(totXp)} XP (МСК)` : "За последние 24 часа активности не было (МСК)")
    : `Итого: ${fmtNum(totSolved)} решено · +${fmtNum(totXp)} XP · ${activeDays} ${plural(activeDays, "день", "дня", "дней")} с активностью (МСК)`;
  wrap.innerHTML = activityChart(activity, A.activitySelected);
  paintChartDetail(card, A.activitySelected, activity);
  bindChartTooltip(card, activity);
}

async function refreshActivityCard(card) {
  const wrap = card.querySelector("#activityChartWrap");
  wrap.innerHTML = `<div class="a-skeleton" style="height:190px"></div>`;
  card.querySelector("#activitySummary").textContent = "Загрузка…";
  paintChartDetail(card, null, []);
  try {
    const data = await AdminApi.get(`/api/admin/overview?days=${activityDays()}`);
    paintActivityCard(card, data.activity);
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    wrap.innerHTML = `<div class="a-error-banner">Не удалось загрузить активность: ${esc(e.message)}<button class="btn btn--soft btn--sm" id="activityRetry">Повторить</button></div>`;
    card.querySelector("#activitySummary").textContent = "";
    const retry = wrap.querySelector("#activityRetry");
    if (retry) retry.onclick = () => refreshActivityCard(card);
  }
}

/* ---------------- Пользователи ---------------- */

/* Порядок списка. «important» — уже пришедший с сервера порядок по важности
   (активность + объём + качество профиля, админы внизу), его мы не трогаем.
   Остальные — простые перестановки того же массива по сырым полям карточки. */
const USER_SORTS = {
  important: { label: "Важные сверху", hint: "Сверху — активные и объёмные: свежесть активности, объём и качество профиля. Админы и пустые аккаунты внизу." },
  recent: { label: "По свежести активности", hint: "Недавно активные сверху, кто давно не заходил — внизу." },
  xp: { label: "По опыту", hint: "Больше XP — выше." },
  level: { label: "По уровню", hint: "Выше уровень — выше." },
  new: { label: "Сначала новые", hint: "Свежая регистрация сверху." },
};

function userSort() {
  try {
    const v = localStorage.getItem("ege_admin_user_sort");
    if (v && Object.prototype.hasOwnProperty.call(USER_SORTS, v)) return v;
  } catch (e) {}
  return "important";
}

/* Метка группы пользователя. Сервер отдаёт tierLabel (он же считает счёт),
   здесь только цвет и подпись. */
const USER_TIERS = {
  active: { cls: "a-chip--success" },
  cooling: { cls: "a-chip--warn" },
  cold: { cls: "" },
  stuck: { cls: "a-chip--warn" },
  new: { cls: "a-chip--accent" },
  blocked: { cls: "a-chip--danger" },
  admin: { cls: "" },
};

/* Одна понятная перестановка на пресет: сравнение двух строк. null/пустое
   всегда вниз, чтобы «нет данных» не оказывалось наверху. */
function sortUsersFor(mode, list) {
  if (mode === "important") return list;
  const out = list.slice();
  const num = (p, f) => (Number(p[f]) || 0);
  const cmp = {
    recent: (a, b) => (a.activityDays ?? 1e9) - (b.activityDays ?? 1e9) || num(b, "solved") - num(a, "solved"),
    xp: (a, b) => num(b, "xp") - num(a, "xp") || num(b, "solved") - num(a, "solved"),
    level: (a, b) => num(b, "level") - num(a, "level") || num(b, "xp") - num(a, "xp"),
    new: (a, b) => num(b, "id") - num(a, "id"),
  }[mode];
  return cmp ? out.sort(cmp) : out;
}

/* Кто перед нами: зарегистрированный аккаунт (тогда показываем почту) или
   гость. `registered` приходит с сервера и означает ровно то же, что в
   auth_state_payload — «есть способ войти»: хеш пароля ИЛИ внешний вход
   (Google). Поэтому подпись не расходится с тем, что человек сам видит в
   приложении. Одна функция на карточку списка и на страницу пользователя —
   иначе «гость» в двух местах выглядел бы по-разному. Метка «Google» рядом с
   почтой отвечает на вопрос поддержки «как он вообще входит» — у аккаунта
   только с Google пароля нет. */
function userIdentity(p) {
  const providers = Array.isArray(p.providers) ? p.providers : [];
  const google = providers.indexOf("google") >= 0
    ? `<span class="a-chip" title="Вход через Google привязан">Google</span>` : "";
  if (p.email) return `<span class="a-user-id" title="Почта аккаунта">${aicon("mail")}<span class="a-user-id__mail">${esc(p.email)}</span></span> ${google}`;
  if (p.registered) return `<span class="a-chip" title="Аккаунт зарегистрирован, но почта не указана">регистрация</span> ${google}`;
  return `<span class="a-chip a-chip--ghost" title="Гостевой аккаунт: без почты и пароля">${aicon("ghost")} гость</span>`;
}

async function screenUsers() {
  renderShell("users", `<div class="a-skeleton" style="height:300px"></div>`);
  let users;
  try {
    users = (await AdminApi.get("/api/admin/users")).users;
    A.usersCache = users;
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    renderShell("users", `<div class="a-error-banner">Не удалось загрузить список: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  renderShell("users", `
    <div class="a-toolbar">
      <input class="a-input" id="userSearch" placeholder="Поиск: Account ID, почта, имя, внутренний id…" value="${esc(A.lastQuery || "")}">
      <select class="a-select" id="userSort" title="Порядок списка">
        ${Object.entries(USER_SORTS).map(([id, s]) => `<option value="${id}"${id === userSort() ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
      </select>
      <span class="spacer"></span>
      <span class="a-card__sub" id="userCount"></span>
    </div>
    <div class="a-user-hint" id="userSortHint"></div>
    <div id="usersTable"></div>`);
  const input = document.getElementById("userSearch");
  const sortSelect = document.getElementById("userSort");
  const drawList = () => {
    const q = input.value.trim().toLowerCase();
    A.lastQuery = input.value;
    const found = q
      ? users.filter((p) => [p.accountId, p.name, p.email, String(p.id), p.selfLevel, p.goal].filter(Boolean).join(" ").toLowerCase().includes(q))
      : users;
    const filtered = sortUsersFor(sortSelect.value, found);
    document.getElementById("userCount").textContent = `${filtered.length} из ${users.length}`;
    document.getElementById("userSortHint").textContent = (USER_SORTS[sortSelect.value] || USER_SORTS.important).hint;
    const wrap = document.getElementById("usersTable");
    wrap.innerHTML = filtered.length ? `
      <div class="a-user-grid">
        ${filtered.map((p, idx) => {
          const initial = (p.name || p.accountId || "?").trim().charAt(0).toUpperCase();
          const locked = adminSubjectLocked(p);
          const subjectName = adminSubjectName(p.subjectTitle || p.subject);
          const acc = Math.round((p.correct / p.solved) * 100);
          const tier = USER_TIERS[p.tier] || null;
          /* Номер места + состояние в одном чипе: сразу видно, где человек и
             почему он здесь. Причина словами — строкой ниже. */
          const tierChip = `<span class="a-chip a-chip--tier ${tier ? tier.cls : ""}" title="Почему здесь: ${esc(p.priorityWhy || "")}">№${idx + 1} · ${esc(p.tierLabel || "—")}</span>`;
          return `
          <div class="a-user-card clickable" data-id="${p.id}">
            <div class="a-user-card__top">
              <div class="a-avatar a-avatar--sm">${esc(initial)}</div>
              <div class="a-user-card__id">
                <div class="a-user-card__name">${p.name ? esc(p.name) : `<span style="color:var(--muted)">Без имени</span>`}${p.onboardedAny ? "" : ` <span class="a-chip">new</span>`}${p.block ? ` <span class="a-chip a-chip--danger">бан</span>` : ""}</div>
                <div class="a-user-card__acct"><span class="mono">${esc(p.accountId || "—")}</span>${userIdentity(p)}</div>
                <div class="a-user-card__why">${tierChip}${p.priorityWhy ? `<span class="a-user-card__whytxt">${esc(p.priorityWhy)}</span>` : ""}</div>
              </div>
              ${locked
                ? `<div class="a-user-card__lvl"><b>—</b><span>${esc(subjectName)} · скоро</span></div>`
                : `<div class="a-user-card__lvl"><b>${p.level}</b><span>уровень</span></div>`}
            </div>
            ${locked
              ? `<div class="a-user-card__stats"><div class="a-user-card__stat"><b>—</b><span>учебные материалы закрыты</span></div></div>`
              : `<div class="a-user-card__stats">
              <div class="a-user-card__stat"><b>${fmtNum(p.xp)}</b><span>XP</span></div>
              <div class="a-user-card__stat"><b>${fmtNum(p.solved)}</b><span>решено</span></div>
              <div class="a-user-card__stat"><b>${p.solved ? acc + "%" : "—"}</b><span>точность</span></div>
              <div class="a-user-card__stat"><b>${p.streak || "—"}</b><span>серия</span></div>
            </div>`}
            <div class="a-user-card__foot">
              <span>${fmtDate(p.createdAt)}</span>
              ${p.block
                ? `<span class="a-user-card__active" style="color:var(--danger);font-weight:600">${esc(fmtBlockShort(p.block))}</span>`
                : `<span class="a-user-card__active">${p.lastActiveDate ? "активен " + fmtShortDate(p.lastActiveDate) : "не активен"}</span>`}
              ${p.id === A.session.user.id ? "" : `
              <button class="a-icon-btn a-icon-btn--danger" data-del="${p.id}" title="Удалить аккаунт">${aicon("trash")}</button>`}
            </div>
          </div>`;
        }).join("")}
      </div>` : `
      <div class="a-card"><div class="a-empty">
        <div class="a-empty__icon">${aicon("search")}</div>
        <div class="a-empty__title">Ничего не найдено</div>
        <div class="a-empty__sub">Попробуйте Account ID (например, «a7k29x»), имя или числовой id</div>
      </div></div>`;
    wrap.querySelectorAll(".a-user-card[data-id]").forEach((card) => {
      card.onclick = () => navigate(`/users/${encodeURIComponent(filtered.find((p) => String(p.id) === card.dataset.id)?.accountId || card.dataset.id)}`);
    });
    wrap.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        openDeleteUserModal(filtered.find((p) => String(p.id) === btn.dataset.del));
      };
    });
  };
  input.oninput = drawList;
  sortSelect.onchange = () => {
    try { localStorage.setItem("ege_admin_user_sort", sortSelect.value); } catch (e) {}
    drawList();
  };
  drawList();
}

/* ---------------- Карточка пользователя ---------------- */

async function screenUser(ref) {
  renderShell("users", `<div class="a-skeleton" style="height:120px"></div><div class="a-skeleton" style="height:300px;margin-top:16px"></div>`);
  let detail;
  try {
    detail = (await AdminApi.get(`/api/admin/users/${encodeURIComponent(ref)}`)).user;
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    const notFound = /не найден/i.test(e.message);
    renderShell("users", notFound
      ? `<div class="a-card"><div class="a-empty">
          <div class="a-empty__icon">${aicon("users")}</div>
          <div class="a-empty__title">Аккаунт «${esc(ref)}» не найден</div>
          <div class="a-empty__sub">Возможно, он был удалён</div>
          <div style="margin-top:14px"><a class="btn btn--soft btn--sm" href="#/users">К списку пользователей</a></div>
        </div></div>`
      : `<div class="a-error-banner">Ошибка: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  const p = detail, st = p.stats, c = p.counts;
  const locked = adminSubjectLocked(p);
  const subjectName = adminSubjectName(p.subjectTitle || p.subject);
  const initial = (p.name || p.accountId || "?").trim().charAt(0).toUpperCase();
  const screen = `
    <div style="margin-bottom:16px"><a class="btn btn--soft btn--sm" href="#/users" style="text-decoration:none">${aicon("back")} Все пользователи</a></div>
    <div class="a-card">
      <div class="a-user-head">
        <div class="a-avatar">${esc(initial)}</div>
        <div>
          <div class="a-user-head__name">${p.name ? esc(p.name) : `<span style="color:var(--muted)">Без имени</span>`}</div>
          <div class="a-user-head__meta">
            <span class="mono" style="color:var(--accent);font-weight:600">${esc(p.accountId || "—")}</span>
            ${userIdentity(p)}
            <span>id: ${p.id}</span>
            ${locked
              ? `<span class="a-chip a-chip--warn">${esc(subjectName)} · материалы скоро</span>`
              : `<span>уровень ${st.level.level} · ${fmtNum(st.xp)} XP</span>`}
            ${onboardedBadge(p)}
            ${p.block ? `<span class="a-chip a-chip--danger">${esc(fmtBlockShort(p.block))}</span>` : `<span class="a-chip a-chip--success">активен</span>`}
            ${p.adminSessions > 0 ? `<span class="a-chip a-chip--accent">admin-сессия активна</span>` : ""}
          </div>
        </div>
        <div class="a-user-head__actions">
          <button class="btn btn--soft btn--sm" id="editProfileBtn">Профиль</button>
          <button class="btn btn--soft btn--sm" id="grantXpBtn"${locked ? " disabled title=\"XP появятся вместе с материалами предмета\"" : ""}>± XP</button>
          <button class="btn btn--soft btn--sm" id="aiLimitBtn">ИИ-лимиты</button>
          <button class="btn btn--soft btn--sm" id="blockBtn" ${p.id === A.session.user.id ? "disabled title=\"Нельзя заблокировать собственный аккаунт\"" : ""}>${p.block ? "Разблокировать" : "Заблокировать"}</button>
          <button class="btn btn--danger-soft btn--sm" id="resetBtn">Сброс…</button>
          <button class="btn btn--danger-soft btn--sm" id="deleteBtn" ${p.id === A.session.user.id ? "disabled title=\"Нельзя удалить собственный аккаунт\"" : ""}>Удалить</button>
        </div>
      </div>
      <div class="a-kv" style="margin-top:20px">
        <div class="a-kv__item"><div class="a-kv__k">Регистрация</div><div class="a-kv__v">${fmtDateTime(p.createdAt)}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Последняя активность</div><div class="a-kv__v">${p.stats.lastActiveDate ? fmtShortDate(p.stats.lastActiveDate) : "нет"}</div></div>
        ${locked
          ? `<div class="a-kv__item"><div class="a-kv__k">Предмет</div><div class="a-kv__v">${esc(subjectName)} · пока закрыт</div></div>`
          : `<div class="a-kv__item"><div class="a-kv__k">Серия</div><div class="a-kv__v">${st.streak} ${plural(st.streak, "день", "дня", "дней")}</div></div>`}
        <div class="a-kv__item"><div class="a-kv__k">Самооценка</div><div class="a-kv__v">${p.selfLevel ? esc(LEVEL_LABELS[p.selfLevel] || p.selfLevel) : "—"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Цель</div><div class="a-kv__v">${p.goal ? esc(GOAL_LABELS[p.goal] || p.goal) : "—"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Онбординг пройден</div><div class="a-kv__v">${
          adminOnboardedSubjects(p).length
            ? esc(adminOnboardedSubjects(p).join(", "))
            : `<span style="color:var(--muted)">нигде</span>`}</div></div>
        ${locked ? "" : `<div class="a-kv__item"><div class="a-kv__k">До след. уровня</div><div class="a-kv__v">${fmtNum(st.level.need - st.level.intoLevel)} XP</div></div>`}
      </div>
    </div>

    <div class="a-card" style="margin-top:16px;${p.block ? "border-color:rgba(255,107,107,.4)" : ""}">
      <div class="a-card__head"><span class="a-card__title">Доступ</span><span class="a-card__sub">${p.block ? "заблокирован" : "активен"}</span></div>
      ${p.block ? `
        <div class="a-kv">
          <div class="a-kv__item"><div class="a-kv__k">Статус</div><div class="a-kv__v" style="color:var(--danger);font-weight:600">${esc(fmtBlockShort(p.block))}</div></div>
          <div class="a-kv__item"><div class="a-kv__k">Срок</div><div class="a-kv__v">${esc(fmtBlockUntil(p.block))}</div></div>
          <div class="a-kv__item"><div class="a-kv__k">Дата блокировки</div><div class="a-kv__v">${fmtDateTime(p.block.createdAt)}</div></div>
          <div class="a-kv__item"><div class="a-kv__k">Причина</div><div class="a-kv__v">${p.block.reason ? esc(p.block.reason) : `<span style="color:var(--muted)">Причина не указана</span>`}</div></div>
        </div>` : `
        <div style="font-size:13.5px;color:var(--text-2)">Аккаунт активен. Блокировка отклонит все запросы пользователя на backend и покажет ему окно ограничения.</div>`}
    </div>

    <div class="a-section-title">${locked ? "Статус предмета" : "Прогресс"}</div>
    ${locked
      ? `<div class="a-card"><div class="a-empty"><div class="a-empty__icon">${aicon("dashboard")}</div><div class="a-empty__title">Материалы пока закрыты</div><div class="a-empty__sub">${esc(subjectName)} уже подключён, но учебные показатели появятся вместе с заданиями.</div></div></div>`
      : `<div class="a-stats">
      ${statTile("Решено", fmtNum(st.totalSolved), `верно: ${fmtNum(st.totalCorrect)}${st.accuracy != null ? ` · ${st.accuracy}%` : ""}`)}
      ${statTile("Время", fmtDuration(st.totalTimeSec), `подсказок: ${fmtNum(st.hintsUsed)}`)}
      ${statTile("Лучшая серия", fmtNum(st.bestSeries), `текущая: ${fmtNum(st.correctSeries)}`)}
      ${statTile("Ошибки", `${c.openErrors} откр.`, `закрыто: ${fmtNum(st.errorsResolved)}`)}
    </div>
    <div class="a-stats" style="margin-top:14px">
      ${statTile("Уроки", `${c.lessonsCompleted}/${c.lessonsTotal}`, "пройдено")}
      ${statTile("Миссии", fmtNum(c.missionsDone), "завершено")}
      ${statTile("Боссы", fmtNum(c.bossesDefeated), "повержено")}
      ${statTile("Достижения", `${c.achievements}`, `навыков затронуто: ${c.skillsTouched}/${c.skillsTotal}`)}
    </div>`}

    <div class="a-grid-main" style="margin-top:16px">
      <div>
        <div class="a-card">
          <div class="a-card__head"><span class="a-card__title">Навыки</span><span class="a-card__sub">${p.skills.length} с прогрессом</span></div>
          ${p.skills.length ? p.skills.map((sk) => `
            <div class="a-skill-row">
              <div><div class="a-skill-row__name">${esc(sk.name)}</div><div class="a-skill-row__topic">${esc(sk.topic || "")} · решено ${sk.solved}, верно ${sk.correct}</div></div>
              <div class="a-bar"><div class="a-bar__fill ${sk.progress >= 70 ? "a-bar__fill--success" : sk.progress < 35 ? "a-bar__fill--warn" : ""}" style="width:${Math.min(100, sk.progress)}%"></div></div>
              <div class="a-skill-row__pct">${sk.progress}%</div>
            </div>`).join("") : `<div class="a-empty"><div class="a-empty__title">Прогресса по навыкам нет</div><div class="a-empty__sub">Ученик ещё не решал задания</div></div>`}
        </div>
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">Последние попытки</span><span class="a-card__sub">${fmtNum(c.attempts)} всего</span></div>
          ${p.recentAttempts.length ? `<div class="a-table-wrap" style="border:none"><table class="a-table">
            <thead><tr><th>Задание</th><th>Навык</th><th>Результат</th><th class="num">Время</th><th>Когда</th></tr></thead>
            <tbody>${p.recentAttempts.map((a) => `
              <tr>
                <td class="mono">${esc(a.taskId)}${a.examNumber ? ` <span class="a-chip">№${esc(a.examNumber)}</span>` : ""}</td>
                <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.skill)}</td>
                <td>${a.correct ? `<span class="a-chip a-chip--success">верно${a.hintLevel ? " · подсказка " + a.hintLevel : ""}</span>` : `<span class="a-chip a-chip--danger">${a.hintLevel >= 3 ? "показан ответ" : "неверно"}</span>`}</td>
                <td class="num">${a.seconds} с</td>
                <td>${fmtDateTime(a.ts)}</td>
              </tr>`).join("")}</tbody></table></div>`
          : `<div class="a-empty"><div class="a-empty__title">Попыток нет</div></div>`}
        </div>
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">Ошибки</span><span class="a-card__sub">последние ${p.errors.length}</span></div>
          ${p.errors.length ? `<div class="a-table-wrap" style="border:none"><table class="a-table">
            <thead><tr><th>Задание</th><th>Тема</th><th>Статус</th><th>Когда</th></tr></thead>
            <tbody>${p.errors.map((e) => `
              <tr>
                <td class="mono">${esc(e.taskId)}${e.examNumber ? ` <span class="a-chip">№${esc(e.examNumber)}</span>` : ""}</td>
                <td>${esc(e.topic || e.skill)}</td>
                <td>${e.resolved ? `<span class="a-chip a-chip--success">закрыта</span>` : `<span class="a-chip a-chip--danger">открыта</span>`}</td>
                <td>${fmtDateTime(e.ts)}</td>
              </tr>`).join("")}</tbody></table></div>`
          : `<div class="a-empty"><div class="a-empty__title">Ошибок нет</div></div>`}
        </div>
      </div>
      <div>
        <div class="a-card">
          <div class="a-card__head"><span class="a-card__title">История событий</span></div>
          ${p.timeline.length ? p.timeline.map((t) => `
            <div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
              <span style="flex:0 0 8px;height:8px;border-radius:50%;background:var(--accent);margin-top:6px"></span>
              <div><div style="font-size:13px">${esc(t.text)}</div><div style="font-size:11.5px;color:var(--muted)">${fmtDateTime(t.ts)}</div></div>
            </div>`).join("") : `<div class="a-empty"><div class="a-empty__title">Событий нет</div></div>`}
        </div>
        ${p.xpAdjustments.length ? `
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">XP-корректировки</span></div>
          ${p.xpAdjustments.map((adj) => `
            <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
              <span>${esc(adj.reason)}</span>
              <span class="mono" style="color:${adj.amount >= 0 ? "var(--success)" : "var(--danger)"};font-weight:600">${adj.amount > 0 ? "+" : ""}${adj.amount}</span>
            </div>`).join("")}
        </div>` : ""}
        ${p.achievements.length ? `
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">Достижения</span></div>
          ${p.achievements.map((ach) => `
            <div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:20px">${esc(ach.icon || "🏆")}</span>
              <div><div style="font-size:13px;font-weight:600">${esc(ach.name || ach.id)}</div>
              <div style="font-size:11.5px;color:var(--muted)">${fmtDateTime(ach.ts)}</div></div>
            </div>`).join("")}
        </div>` : ""}
        ${p.activity.length ? `
        <div class="a-card" style="margin-top:16px">
          <div class="a-card__head"><span class="a-card__title">Активность по дням</span></div>
          <div class="a-table-wrap" style="border:none"><table class="a-table">
            <thead><tr><th>Дата</th><th class="num">Решено</th><th class="num">Верно</th><th class="num">XP</th></tr></thead>
            <tbody>${p.activity.slice(0, 14).map((d) => `
              <tr><td>${fmtShortDate(d.date)}</td><td class="num">${d.solved}</td><td class="num">${d.correct}</td><td class="num">+${d.xp}</td></tr>`).join("")}
            </tbody></table></div>
        </div>` : ""}
      </div>
    </div>`;
  renderShell("users", screen);
  bindUserActions(detail);
}

/* ---------------- действия над пользователем ---------------- */

/* Модальное окно удаления аккаунта. Работает и с детальной карточкой
   (p.stats.*), и с элементом списка (p.solved/p.xp) — формат подсказки
   берём из того, что есть. */
function openDeleteUserModal(p) {
  const ref = p.accountId || String(p.id);
  const solved = p.stats ? p.stats.totalSolved : p.solved;
  const xp = p.stats ? p.stats.xp : p.xp;
  const progressSummary = adminSubjectLocked(p)
    ? "учебные данные выбранного предмета"
    : `${fmtNum(solved)} решений, ${fmtNum(xp)} XP, уроки, ошибки и достижения`;
  openModal(`
    <div class="a-modal__title" style="color:var(--danger)">Удалить аккаунт ${esc(p.accountId || "")}?</div>
    <div class="a-modal__desc">Будут удалены сам аккаунт и ВСЕ его данные: ${progressSummary}, а также admin-сессии. Действие необратимо.</div>
    <div class="a-modal__form">
      <div class="a-modal__warn"><b>Подтверждение:</b> введите Account ID <span class="mono">${esc(p.accountId || "")}</span></div>
      <input class="a-input mono" id="fDel" placeholder="${esc(p.accountId || "")}" autocomplete="off">
      <div id="mErr"></div>
    </div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--danger-soft" id="mDo">Удалить навсегда</button>
    </div>`, (modal) => {
    modal.classList.add("a-modal--danger");
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelector("#mDo").onclick = async () => {
      if (modal.querySelector("#fDel").value.trim() !== (p.accountId || "")) {
        modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">Account ID не совпадает</div>`;
        return;
      }
      try {
        await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/delete`, {});
        closeModal();
        toast("Аккаунт удалён");
        A.usersCache = null;
        if (parseHash().name === "users" && !parseHash().param) render(); else navigate("/users");
      } catch (e) {
        if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      }
    };
  });
}

function openModal(html, onMount) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "a-modal-backdrop";
  backdrop.innerHTML = `<div class="a-modal" role="dialog" aria-modal="true">${html}</div>`;
  backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) closeModal(); });
  A.modalRoot.appendChild(backdrop);
  document.addEventListener("keydown", modalEsc);
  if (onMount) onMount(backdrop.querySelector(".a-modal"));
  return backdrop;
}

function modalEsc(ev) { if (ev.key === "Escape") closeModal(); }

function closeModal() {
  A.modalRoot.innerHTML = "";
  document.removeEventListener("keydown", modalEsc);
}

function bindUserActions(p) {
  const ref = p.accountId || String(p.id);
  const locked = adminSubjectLocked(p);
  const reload = async () => { await screenUser(ref); };

  document.getElementById("editProfileBtn").onclick = () => {
    openModal(`
      <div class="a-modal__title">Профиль ${esc(p.accountId || "")}</div>
      <div class="a-modal__desc">Изменения сохраняются на сервере сразу. Пустое имя убирает отображаемое имя.</div>
      <div class="a-modal__form">
        <div class="a-field"><label>Имя</label><input class="a-input" id="fName" maxlength="60" value="${esc(p.name || "")}" placeholder="Без имени"></div>
        <div class="a-field"><label>Самооценка</label>
          <select class="a-select" id="fLevel">
            <option value="" ${!p.selfLevel ? "selected" : ""}>Не указана</option>
            <option value="zero" ${p.selfLevel === "zero" ? "selected" : ""}>С нуля</option>
            <option value="base" ${p.selfLevel === "base" ? "selected" : ""}>Базовый</option>
            <option value="confident" ${p.selfLevel === "confident" ? "selected" : ""}>Уверенный</option>
          </select>
        </div>
        <div class="a-field"><label>Цель</label>
          ${locked
            ? `<div class="a-empty" style="padding:12px 0;text-align:left">Для закрытого предмета цель появится вместе с материалами.</div>`
            : `<select class="a-select" id="fGoal">
            <option value="" ${!p.goal ? "selected" : ""}>Не выбрана</option>
            <option value="g60" ${p.goal === "g60" ? "selected" : ""}>60+ баллов</option>
            <option value="g80" ${p.goal === "g80" ? "selected" : ""}>80+ баллов</option>
            <option value="g95" ${p.goal === "g95" ? "selected" : ""}>95+ баллов</option>
          </select>`}
        </div>
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions">
        <button class="btn btn--soft" id="mCancel">Отмена</button>
        <button class="btn btn--primary" id="mSave">Сохранить</button>
      </div>`, (modal) => {
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelector("#mSave").onclick = async () => {
        const btn = modal.querySelector("#mSave");
        btn.disabled = true;
        try {
          const body = {
            name: modal.querySelector("#fName").value.trim() || null,
            selfLevel: modal.querySelector("#fLevel").value || null,
            goal: locked ? null : (modal.querySelector("#fGoal")?.value || null),
            subject: p.subject || undefined,
          };
          await AdminApi.put(`/api/admin/users/${encodeURIComponent(ref)}/profile`, body);
          closeModal();
          toast("Профиль обновлён");
          reload();
        } catch (e) {
          btn.disabled = false;
          if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
          modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
        }
      };
    });
  };

  document.getElementById("grantXpBtn").onclick = () => {
    openModal(`
      <div class="a-modal__title">Корректировка XP</div>
      <div class="a-modal__desc">Текущий баланс: <b>${fmtNum(p.stats.xp)} XP</b> (уровень ${p.stats.level.level}). Положительное число начисляет, отрицательное — списывает. Запись попадает в журнал корректировок и видна ученику в истории.</div>
      <div class="a-modal__form">
        <div class="a-field"><label>Количество XP</label><input class="a-input mono" id="fAmount" type="number" step="1" placeholder="например 100 или -50"></div>
        <div class="a-field"><label>Причина</label><input class="a-input" id="fReason" maxlength="180" placeholder="компенсация за сбой, конкурс и т.п."></div>
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions">
        <button class="btn btn--soft" id="mCancel">Отмена</button>
        <button class="btn btn--primary" id="mSave">Применить</button>
      </div>`, (modal) => {
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelector("#mSave").onclick = async () => {
        const btn = modal.querySelector("#mSave");
        const amount = parseInt(modal.querySelector("#fAmount").value, 10);
        if (!Number.isFinite(amount) || amount === 0) {
          modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">Введите ненулевое целое число</div>`;
          return;
        }
        btn.disabled = true;
        try {
          const res = await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/xp`, {
            amount, reason: modal.querySelector("#fReason").value.trim(),
          });
          closeModal();
          toast(`XP обновлён: ${res.amount > 0 ? "+" : ""}${res.amount}, баланс ${fmtNum(res.xp)} (ур. ${res.level.level})`);
          reload();
        } catch (e) {
          btn.disabled = false;
          if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
          modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
        }
      };
    });
  };

  document.getElementById("aiLimitBtn").onclick = () => {
    const cur = p.aiLimit || {};
    const remaining = Number.isFinite(Number(cur.remaining)) ? Number(cur.remaining) : 0;
    const limit = Number.isFinite(Number(cur.limit)) ? Number(cur.limit) : 5;
    const custom = cur.customLimit;
    const resetNote = cur.resetInSec != null
      ? `, следующая вернётся через ${fmtDuration(cur.resetInSec)}`
      : " — все на месте";
    const customNote = custom != null
      ? ` Выдано вручную: всего ${custom} вместо обычных 5.`
      : "";
    const ag = cur.agent || {};
    const agRemaining = Number.isFinite(Number(ag.remaining)) ? Number(ag.remaining) : 0;
    const agLimit = Number.isFinite(Number(ag.limit)) ? Number(ag.limit) : 10;
    const agCustom = ag.customLimit;
    const agReset = ag.resetInSec != null ? `, следующий вернётся через ${fmtDuration(ag.resetInSec)}` : "";
    const agCustomNote = agCustom != null
      ? ` Выдано вручную: всего ${agCustom} вместо обычных ${ag.globalLimit || 10}.`
      : "";
    openModal(`
      <div class="a-modal__title">ИИ-лимиты — ${esc(p.accountId || "")}</div>
      <div class="a-modal__desc">Сейчас ученику доступно <b>${remaining} из ${limit}</b>${resetNote}. Каждая потраченная проверка возвращается через 8 часов.${customNote}</div>
      <div class="a-modal__form">
        <div class="a-field"><label>Доступно сейчас (0–1000)</label><input class="a-input mono" id="fAiRemaining" type="number" min="0" max="1000" step="1" value="${remaining}"></div>
        <div class="a-field"><label>Всего выдавать (пусто — не менять)</label><input class="a-input mono" id="fAiLimit" type="number" min="0" max="1000" step="1" placeholder="${limit}"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn btn--soft btn--sm" id="mRefill">Выдать все</button>
          <button type="button" class="btn btn--soft btn--sm" id="mZero">Забрать все</button>
          <button type="button" class="btn btn--soft btn--sm" id="mStd">Вернуть обычные 5</button>
        </div>
      </div>
      <div class="a-modal__desc" style="margin-top:18px">Ходы наставника: доступно <b>${agRemaining} из ${agLimit}</b>${agReset}. Каждый потраченный ход возвращается через 8 часов.${agCustomNote}</div>
      <div class="a-modal__form">
        <div class="a-field"><label>Ходов доступно сейчас (0–1000)</label><input class="a-input mono" id="fAgRemaining" type="number" min="0" max="1000" step="1" value="${agRemaining}"></div>
        <div class="a-field"><label>Ходов всего выдавать (пусто — не менять)</label><input class="a-input mono" id="fAgLimit" type="number" min="0" max="1000" step="1" placeholder="${agLimit}"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn btn--soft btn--sm" id="mAgRefill">Выдать все ходы</button>
          <button type="button" class="btn btn--soft btn--sm" id="mAgZero">Забрать все ходы</button>
          <button type="button" class="btn btn--soft btn--sm" id="mAgStd">Вернуть обычные ${ag.globalLimit || 10}</button>
        </div>
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions">
        <button class="btn btn--soft" id="mCancel">Отмена</button>
        <button class="btn btn--primary" id="mSave">Применить</button>
      </div>`, (modal) => {
      modal.querySelector("#mCancel").onclick = closeModal;
      const err = (msg) => { modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(msg)}</div>`; };
      const send = async (body, btn) => {
        if (btn) btn.disabled = true;
        try {
          const res = await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/ailimit`, body);
          closeModal();
          const st = res.aiLimit || {};
          const agSt = st.agent || {};
          toast(`Проверок сочинений: ${st.remaining} из ${st.limit}` +
                (agSt ? ` · ходов наставника: ${agSt.remaining} из ${agSt.limit}` : ""));
          reload();
        } catch (e) {
          if (btn) btn.disabled = false;
          if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
          err(e.message);
        }
      };
      const numField = (sel, label) => {
        const raw = modal.querySelector(sel).value.trim();
        if (raw === "") return null;
        const v = parseInt(raw, 10);
        if (!Number.isFinite(v) || v < 0 || v > 1000) { err(`«${label}»: число 0–1000`); return undefined; }
        return v;
      };
      modal.querySelector("#mRefill").onclick = (ev) => send({ refill: true }, ev.target);
      modal.querySelector("#mZero").onclick = (ev) => send({ remaining: 0 }, ev.target);
      modal.querySelector("#mStd").onclick = (ev) => send({ limit: null, refill: true }, ev.target);
      modal.querySelector("#mAgRefill").onclick = (ev) => send({ agent: { refill: true } }, ev.target);
      modal.querySelector("#mAgZero").onclick = (ev) => send({ agent: { remaining: 0 } }, ev.target);
      modal.querySelector("#mAgStd").onclick = (ev) => send({ agent: { limit: null, refill: true } }, ev.target);
      modal.querySelector("#mSave").onclick = async (ev) => {
        const body = {};
        const lim = numField("#fAiLimit", "Всего выдавать");
        const rem = numField("#fAiRemaining", "Доступно сейчас");
        if (lim === undefined || rem === undefined) return;
        if (lim !== null) body.limit = lim;
        if (rem !== null) body.remaining = rem;
        const agLim = numField("#fAgLimit", "Ходов всего выдавать");
        const agRem = numField("#fAgRemaining", "Ходов доступно сейчас");
        if (agLim === undefined || agRem === undefined) return;
        if (agLim !== null || agRem !== null) {
          const agent = {};
          if (agLim !== null) agent.limit = agLim;
          if (agRem !== null) agent.remaining = agRem;
          body.agent = agent;
        }
        if (!("limit" in body) && !("remaining" in body) && !body.agent) { err("Укажите, сколько выдать"); return; }
        await send(body, ev.target);
      };
    });
  };

  const RESETS = [
    { id: "streak", title: "Сбросить серию дней", desc: "Обнуляет streak и текущую серию верных ответов. XP, задания и уроки не затрагиваются.", danger: false },
    { id: "errors", title: "Очистить ошибки", desc: "Удаляет список ошибок и историю ошибок в уроках, обнуляет счётчик закрытых ошибок. Прогресс навыков и XP не меняются.", danger: false },
    { id: "daily", title: "Сбросить ежедневную подборку", desc: "Удаляет историю ежедневных подборок; ученик получит новую подборку сегодня.", danger: false },
    { id: "forecast", title: "Очистить историю прогноза", desc: "Удаляет снимки прогноза балла; новый снимок появится после следующего ответа.", danger: false },
    { id: "all-progress", title: "Полный сброс прогресса", desc: "Удаляет ВСЁ: попытки, XP и корректировки XP, уроки, миссии, боссов, достижения, ошибки, серию, активность. Аккаунт возвращается в состояние «до онбординга». Отменить нельзя.", danger: true },
  ];

  document.getElementById("resetBtn").onclick = () => {
    openModal(`
      <div class="a-modal__title">Сброс состояния — ${esc(p.accountId || "")}</div>
      <div class="a-modal__desc">Выберите, что именно сбросить. Каждое действие выполняется на сервере и записывается в журнал.</div>
      <div class="a-modal__form" style="gap:10px">
        ${RESETS.map((r) => `
          <button class="choice-item" data-reset="${r.id}" style="${r.danger ? "border-color:rgba(255,107,107,.35)" : ""}">
            <b style="${r.danger ? "color:var(--danger)" : ""}">${r.title}</b><span>${r.desc}</span>
          </button>`).join("")}
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions"><button class="btn btn--soft" id="mCancel">Закрыть</button></div>`, (modal) => {
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelectorAll("[data-reset]").forEach((btn) => {
        btn.onclick = () => confirmReset(modal, btn.dataset.reset, RESETS.find((r) => r.id === btn.dataset.reset));
      });
    });
    async function confirmReset(modal, target, info) {
      if (info.danger) {
        openModal(`
          <div class="a-modal__title" style="color:var(--danger)">Подтвердите полный сброс</div>
          <div class="a-modal__desc">${info.desc}</div>
          <div class="a-modal__form">
            <div class="a-modal__warn"><b>Это необратимо.</b> Все данные ученика «${esc(p.name || p.accountId || "")}» будут удалены. Введите Account ID <span class="mono">${esc(p.accountId || "")}</span> для подтверждения.</div>
            <input class="a-input mono" id="fConfirm" placeholder="${esc(p.accountId || "")}" autocomplete="off">
            <div id="mErr2"></div>
          </div>
          <div class="a-modal__actions">
            <button class="btn btn--soft" id="mCancel2">Отмена</button>
            <button class="btn btn--danger-soft" id="mDo">Сбросить всё</button>
          </div>`, (m2) => {
          m2.querySelector("#mCancel2").onclick = closeModal;
          m2.querySelector("#mDo").onclick = async () => {
            if (m2.querySelector("#fConfirm").value.trim() !== (p.accountId || "")) {
              m2.querySelector("#mErr2").innerHTML = `<div class="a-modal__error">Account ID не совпадает</div>`;
              return;
            }
            await doReset("all-progress", m2);
          };
        });
      } else {
        await doReset(target, modal);
      }
    }
    async function doReset(target, modal) {
      try {
        const res = await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/reset`, { target });
        closeModal();
        toast(res.message || "Сброс выполнен");
        reload();
      } catch (e) {
        if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        const errBox = modal.querySelector("#mErr2") || modal.querySelector("#mErr");
        if (errBox) errBox.innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      }
    }
  };

  const deleteBtn = document.getElementById("deleteBtn");
  if (deleteBtn && !deleteBtn.disabled) {
    deleteBtn.onclick = () => openDeleteUserModal(p);
  }

  const blockBtn = document.getElementById("blockBtn");
  if (blockBtn && !blockBtn.disabled) {
    blockBtn.onclick = () => {
      if (p.block) openUnblockUserModal(p, reload);
      else openBlockUserModal(p, reload);
    };
  }
}

/* ---------------- блокировка пользователя ---------------- */

function openBlockUserModal(p, reload) {
  const ref = p.accountId || String(p.id);
  let duration = "1d";
  openModal(`
    <div class="a-modal__title" style="color:var(--danger)">Заблокировать ${esc(p.accountId || "")}?</div>
    <div class="a-modal__desc">Пользователь сразу потеряет доступ ко всем разделам, кроме главной страницы. Все его устройства получат окно ограничения при следующем запросе.</div>
    <div class="a-modal__form">
      <div class="a-field"><label>Причина (необязательно, но лучше указать)</label>
        <textarea class="a-textarea" id="fBlockReason" maxlength="500" rows="3" placeholder="Например: спам в обращениях"></textarea>
      </div>
      <div class="a-field"><label>Срок блокировки</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px" id="fBlockDurations">
          ${BLOCK_DURATIONS.map((d) => `
            <button type="button" class="choice-item" data-dur="${d.id}" style="flex:1 1 90px;${d.id === duration ? "border-color:var(--danger);background:var(--danger-soft)" : ""}">
              <b>${d.title}</b>
            </button>`).join("")}
        </div>
        <div class="a-field__hint" id="fBlockPreview">${esc(blockUntilPreview(duration))}</div>
      </div>
      <div id="mErr"></div>
    </div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--danger-soft" id="mDo">Заблокировать</button>
    </div>`, (modal) => {
    modal.classList.add("a-modal--danger");
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelectorAll("[data-dur]").forEach((btn) => {
      btn.onclick = () => {
        duration = btn.dataset.dur;
        modal.querySelectorAll("[data-dur]").forEach((b) => {
          const on = b.dataset.dur === duration;
          b.style.borderColor = on ? "var(--danger)" : "";
          b.style.background = on ? "var(--danger-soft)" : "";
        });
        modal.querySelector("#fBlockPreview").textContent = blockUntilPreview(duration);
      };
    });
    modal.querySelector("#mDo").onclick = async () => {
      const btn = modal.querySelector("#mDo");
      btn.disabled = true;
      try {
        const reason = modal.querySelector("#fBlockReason").value.trim();
        await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/block`, { reason, duration });
        closeModal();
        toast(duration === "permanent" ? "Пользователь заблокирован навсегда" : "Пользователь заблокирован");
        A.usersCache = null;
        if (reload) await reload();
      } catch (e) {
        btn.disabled = false;
        if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      }
    };
  });
}

function openUnblockUserModal(p, reload) {
  const ref = p.accountId || String(p.id);
  openModal(`
    <div class="a-modal__title">Разблокировать ${esc(p.accountId || "")}?</div>
    <div class="a-modal__desc">Доступ восстановится сразу: при следующем запросе пользователь снова сможет пользоваться всеми разделами.</div>
    ${p.block ? `<div class="a-modal__form">
      <div class="a-kv">
        <div class="a-kv__item"><div class="a-kv__k">Срок</div><div class="a-kv__v">${esc(fmtBlockUntil(p.block))}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Причина</div><div class="a-kv__v">${p.block.reason ? esc(p.block.reason) : "—"}</div></div>
      </div>
    </div>` : ""}
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--primary" id="mDo">Разблокировать</button>
    </div>`, (modal) => {
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelector("#mDo").onclick = async () => {
      const btn = modal.querySelector("#mDo");
      btn.disabled = true;
      try {
        await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/unblock`, {});
        closeModal();
        toast("Пользователь разблокирован");
        A.usersCache = null;
        if (reload) await reload();
      } catch (e) {
        btn.disabled = false;
        if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        closeModal();
        toast(e.message, "err");
      }
    };
  });
}

/* ---------------- Журнал действий ---------------- */

const AUDIT_LABELS = {
  "admin-login": ["Вход в админ-панель", "a-chip--accent"],
  "admin-logout": ["Выход из админ-панели", ""],
  "grant-xp": ["Корректировка XP", "a-chip--warn"],
  reset: ["Сброс состояния", "a-chip--warn"],
  "update-profile": ["Изменение профиля", ""],
  "delete-user": ["Удаление аккаунта", "a-chip--danger"],
  "block-user": ["Блокировка аккаунта", "a-chip--danger"],
  "unblock-user": ["Разблокировка аккаунта", "a-chip--success"],
  "support-read": ["Обращение прочитано", ""],
};

async function screenAudit() {
  renderShell("audit", `<div class="a-skeleton" style="height:300px"></div>`);
  let entries;
  try {
    entries = (await AdminApi.get("/api/admin/audit")).entries;
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    renderShell("audit", `<div class="a-error-banner">Ошибка: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  const screen = entries.length ? `
    <div class="a-table-wrap"><table class="a-table">
      <thead><tr><th>Когда</th><th>Действие</th><th>Кто</th><th>Кому</th><th>Детали</th></tr></thead>
      <tbody>
        ${entries.map((e) => {
          const [label, cls] = AUDIT_LABELS[e.action] || [e.action, ""];
          const target = e.targetAccount ? `<a href="#/users/${esc(e.targetAccount)}" class="mono" style="color:var(--accent)">${esc(e.targetAccount)}</a>${e.targetId === A.session?.user?.id ? " (вы)" : ""}` : (e.targetId ? `id ${e.targetId} (удалён)` : "—");
          return `<tr>
            <td style="white-space:nowrap">${fmtDateTime(e.ts)}</td>
            <td><span class="a-chip ${cls}">${esc(label)}</span></td>
            <td class="mono">${esc(e.actorAccount || "—")}${e.actorId === A.session?.user?.id ? " (вы)" : ""}</td>
            <td>${target}</td>
            <td style="max-width:320px;overflow:hidden;text-overflow:ellipsis" class="mono">${esc(e.detail || "")}</td>
          </tr>`;
        }).join("")}
      </tbody></table></div>` : `
    <div class="a-card"><div class="a-empty">
      <div class="a-empty__icon">${aicon("audit")}</div>
      <div class="a-empty__title">Журнал пуст</div>
      <div class="a-empty__sub">Здесь появятся все админ-действия: входы, корректировки, сбросы, удаления</div>
    </div></div>`;
  renderShell("audit", screen);
}

/* ---------------- Обращения (Contact Inbox) ----------------
   Полная версия ленты из дашборда: та же серверная логика
   (GET ?status=&limit=&offset= за require_admin, POST .../<id>/read),
   но с разделами «Новые / Прочитанные / Все», счётчиками и пагинацией.
   Раскрытие и «показать ещё» — локальное состояние; отметка «Прочитано»
   идемпотентна на сервере, даблклики закрыты флагом reading. */

const Inbox = {
  tab: "all", // all | new | reviewed
  limit: 20,
  messages: [],
  total: 0,
  newCount: 0,
  reviewedCount: 0,
  allCount: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  expanded: {},
  reading: {},
};

// «Все» — первая вкладка и режим по умолчанию; дальше «Новые» и «Прочитанные».
const INBOX_TABS = [
  { id: "all", title: "Все" },
  { id: "new", title: "Новые" },
  { id: "reviewed", title: "Прочитанные" },
];

// Группы общей ленты «Все»: сервер уже сортирует в этом порядке, клиент
// только рисует заголовки блоков (новые сверху, прочитанные ниже и т.д.).
const INBOX_GROUPS = [
  { id: "new", title: "Новые", chip: "a-chip--accent" },
  { id: "reviewed", title: "Просмотрено", chip: "" },
  { id: "resolved", title: "Решено", chip: "a-chip--success" },
  { id: "archived", title: "В архиве", chip: "" },
];

const INBOX_STATUS = {
  new: ["Новый", "a-chip--accent"],
  reviewed: ["Просмотрено", ""],
  resolved: ["Решено", "a-chip--success"],
  archived: ["В архиве", ""],
};

function inboxCountFor(tab) {
  if (tab === "new") return Inbox.newCount;
  if (tab === "reviewed") return Inbox.reviewedCount;
  return Inbox.allCount;
}

async function inboxFetch(status, limit, offset) {
  return AdminApi.get(`/api/admin/support-messages?limit=${limit}&offset=${offset}&status=${status}`);
}

async function loadInboxCounts() {
  const [n, r, a] = await Promise.all([
    inboxFetch("new", 1, 0),
    inboxFetch("reviewed", 1, 0),
    inboxFetch("all", 1, 0),
  ]);
  Inbox.newCount = Number(n.newCount) || 0;
  Inbox.reviewedCount = Number(r.total) || 0;
  Inbox.allCount = Number(a.total) || 0;
}

async function loadInboxPage(append) {
  const offset = append ? Inbox.messages.length : 0;
  const payload = await inboxFetch(Inbox.tab, Inbox.limit, offset);
  const list = Array.isArray(payload.messages) ? payload.messages : [];
  Inbox.messages = append ? Inbox.messages.concat(list) : list;
  Inbox.total = Number(payload.total) || 0;
  Inbox.newCount = Number(payload.newCount) || 0;
  Inbox.hasMore = Inbox.messages.length < Inbox.total;
}

function inboxMessageHTML(m) {
  const id = Number(m.id) || 0;
  const open = !!Inbox.expanded[id];
  const [label, cls] = INBOX_STATUS[m.status] || [String(m.status || "—"), ""];
  const isNew = m.status === "new";
  // source='system' — сообщение о самом сервере (например, смена ИИ-провайдера).
  // Свойства у него ровно те же, отличается только таблетка.
  const isSystem = m.source === "system";
  return `
  <article class="a-msg${open ? " open" : ""}${isSystem ? " a-msg--system" : ""}">
    <button type="button" class="a-msg__head" onclick="toggleInboxMessage(${id})"
        aria-expanded="${open ? "true" : "false"}" aria-label="Обращение № ${id}${isNew ? ", новое" : ""}${isSystem ? ", системное" : ""}">
      <span class="a-msg__head-main">
        <span class="a-msg__meta">${esc(fmtDateTime(m.createdAt))} · № ${id}</span>
        <span class="a-msg__text">${esc(m.message || "")}</span>
      </span>
      <span class="a-msg__chips">${isSystem ? `<span class="a-chip a-chip--ghost">Система</span>` : ""}<span class="a-chip ${cls}">${esc(label)}</span></span>
    </button>
    ${open ? `<div class="a-msg__full">
      <div class="a-msg__full-row"><span>Статус</span><b>${esc(label)}</b></div>
      ${isSystem ? `<div class="a-msg__full-row"><span>Источник</span><b>Система</b></div>` : ""}
      <div class="a-msg__full-row"><span>Получено</span><b>${esc(fmtDateTime(m.createdAt))}</b></div>
      <div class="a-msg__full-row"><span>Номер</span><b class="mono">№ ${id}</b></div>
      ${isNew ? `<div class="a-msg__actions">
        <button class="btn btn--soft btn--sm" type="button" data-inbox-read="${id}"
            onclick="event.stopPropagation();markInboxRead(${id})"${Inbox.reading[id] ? " disabled" : ""}>${aicon("check")} Прочитано</button>
      </div>` : ""}
    </div>` : ""}
  </article>`;
}

function inboxEmptyHTML() {
  if (Inbox.tab === "new") return ["Новых обращений нет", "Всё разобрано — так держать."];
  if (Inbox.tab === "reviewed") return ["Прочитанных пока нет", "Отмеченные «Прочитано» появятся здесь."];
  return ["Обращений пока нет", "Сообщения со страницы «Контакты» появятся здесь."];
}

/* Лента: во вкладке «Все» рисуем отдельные блоки по статусу (сервер уже
   присылает их в этом порядке), в остальных вкладках — плоский список. */
function inboxListHTML() {
  if (Inbox.tab !== "all") return Inbox.messages.map(inboxMessageHTML).join("");
  return INBOX_GROUPS.map((g) => {
    const items = Inbox.messages.filter((m) => m.status === g.id);
    if (!items.length) return "";
    return `
    <div class="a-msg-group" data-group="${g.id}">
      <div class="a-msg-group__head">
        <span class="a-chip ${g.chip}">${esc(g.title)}</span>
        <span class="a-msg-group__count">${fmtNum(items.length)}</span>
      </div>
      ${items.map(inboxMessageHTML).join("")}
    </div>`;
  }).join("");
}

function drawInbox() {
  const body = document.getElementById("inboxBody");
  if (!body) return;
  if (Inbox.loading && !Inbox.messages.length && !Inbox.error) {
    body.innerHTML = `<div class="a-skeleton" style="height:96px"></div><div class="a-skeleton" style="height:200px;margin-top:14px"></div>`;
    return;
  }
  if (Inbox.error && !Inbox.messages.length) {
    body.innerHTML = `<div class="a-error-banner">Не удалось загрузить обращения: ${esc(Inbox.error)}<button class="btn btn--soft btn--sm" onclick="screenInbox()">Повторить</button></div>`;
    return;
  }
  const [emptyTitle, emptySub] = inboxEmptyHTML();
  body.innerHTML = `
    <div class="a-stats" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="a-stat"><div class="a-stat__label">Новых</div><div class="a-stat__value">${fmtNum(Inbox.newCount)}</div><div class="a-stat__sub">требуют внимания</div></div>
      <div class="a-stat"><div class="a-stat__label">Прочитано</div><div class="a-stat__value">${fmtNum(Inbox.reviewedCount)}</div><div class="a-stat__sub">уже разобраны</div></div>
      <div class="a-stat"><div class="a-stat__label">Всего</div><div class="a-stat__value">${fmtNum(Inbox.allCount)}</div><div class="a-stat__sub">за всё время</div></div>
    </div>
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head--wrap">
        <div class="a-seg" role="tablist" aria-label="Фильтр обращений">
          ${INBOX_TABS.map((t) => `<button class="a-seg__btn${Inbox.tab === t.id ? " a-seg__btn--active" : ""}" role="tab" aria-selected="${Inbox.tab === t.id ? "true" : "false"}" onclick="setInboxTab('${t.id}')">${esc(t.title)} · ${fmtNum(inboxCountFor(t.id))}</button>`).join("")}
        </div>
        <span class="a-card__sub">${Inbox.tab === "all"
          ? "сгруппировано: новые сверху, прочитанные ниже"
          : "новые сверху · отметка «Прочитано» убирает из «Новых»"}</span>
      </div>
    </div>
    <div id="inboxList">
      ${Inbox.messages.length ? inboxListHTML() : `
      <div class="a-card"><div class="a-empty">
        <div class="a-empty__icon">${aicon("inbox")}</div>
        <div class="a-empty__title">${esc(emptyTitle)}</div>
        <div class="a-empty__sub">${esc(emptySub)}</div>
      </div></div>`}
    </div>
    <div id="inboxMore" style="margin-top:12px;text-align:center">
      ${Inbox.error && Inbox.messages.length ? `<div class="a-error-banner">Не удалось догрузить: ${esc(Inbox.error)}<button class="btn btn--soft btn--sm" onclick="moreInbox()">Ещё раз</button></div>` : ""}
      ${!Inbox.error && Inbox.loadingMore ? `<span class="a-card__sub">загружаем…</span>` : ""}
      ${!Inbox.error && !Inbox.loadingMore && Inbox.hasMore ? `
        <div class="a-card__sub" style="margin-bottom:8px">Показано ${Inbox.messages.length} из ${Inbox.total}</div>
        <button class="btn btn--soft btn--sm" onclick="moreInbox()">Показать ещё</button>` : ""}
    </div>`;
}

function inboxAuthFail(e) {
  if (e && e.unauthorized) { A.session = null; renderLogin(); return true; }
  return false;
}

async function screenInbox() {
  renderShell("inbox", `<div class="a-skeleton" style="height:96px"></div><div class="a-skeleton" style="height:200px;margin-top:14px"></div>`);
  Inbox.loading = true;
  Inbox.error = null;
  try {
    await loadInboxCounts();
    await loadInboxPage(false);
  } catch (e) {
    if (inboxAuthFail(e)) return;
    Inbox.error = e.message || "неизвестная ошибка";
  }
  Inbox.loading = false;
  renderShell("inbox", `<div id="inboxBody"></div>`);
  drawInbox();
}

async function setInboxTab(tab) {
  if (!INBOX_TABS.some((t) => t.id === tab) || Inbox.loading) return;
  Inbox.tab = tab;
  Inbox.messages = [];
  Inbox.total = 0;
  Inbox.hasMore = false;
  Inbox.expanded = {};
  Inbox.loading = true;
  Inbox.error = null;
  drawInbox();
  try {
    await loadInboxPage(false);
  } catch (e) {
    if (inboxAuthFail(e)) return;
    Inbox.error = e.message || "неизвестная ошибка";
  }
  Inbox.loading = false;
  drawInbox();
}

async function moreInbox() {
  if (Inbox.loadingMore || !Inbox.hasMore) return;
  Inbox.loadingMore = true;
  Inbox.error = null;
  drawInbox();
  try {
    await loadInboxPage(true);
  } catch (e) {
    if (inboxAuthFail(e)) return;
    Inbox.error = e.message || "неизвестная ошибка";
  }
  Inbox.loadingMore = false;
  drawInbox();
}

function toggleInboxMessage(id) {
  id = Number(id) || 0;
  if (!id) return;
  if (Inbox.expanded[id]) delete Inbox.expanded[id];
  else Inbox.expanded[id] = true;
  const list = document.getElementById("inboxList");
  if (list && Inbox.messages.length) {
    list.innerHTML = inboxListHTML();
  } else {
    drawInbox();
  }
}

async function markInboxRead(id) {
  id = Number(id) || 0;
  if (!id || Inbox.reading[id]) return;
  Inbox.reading[id] = true;
  try {
    const btn = document.querySelector(`[data-inbox-read="${id}"]`);
    if (btn) btn.disabled = true;
  } catch (_) {}
  try {
    await AdminApi.post(`/api/admin/support-messages/${id}/read`, {});
    delete Inbox.expanded[id];
    // Лента текущего таба уже не содержит карточку: перечитываем счётчики
    // и первую страницу — порядок и цифры всегда честные.
    await loadInboxCounts();
    await loadInboxPage(false);
    drawInbox();
    toast("Обращение отмечено прочитанным");
  } catch (e) {
    if (inboxAuthFail(e)) return;
    toast(`Не удалось отметить: ${e.message || "ошибка"}`, "err");
    drawInbox();
  } finally {
    delete Inbox.reading[id];
  }
}

/* ---------------- Провайдеры ИИ ----------------
   Раздел «Провайдеры»: карточки всех ИИ-провайдеров (встроенные closerouter /
   gptunnel + свои из админки), приоритет high → medium → low (один слот —
   один провайдер) и ручные проверки живым запросом «привет» (1 токен).
   Статусы без холостых запросов: «используется» = успех живого трафика
   учеников за последние 60 с, остальное — итог последней ручной пробы. */

const Prov = {
  loading: false,
  error: null,
  data: null, // providers_overview(): {providers, order, active, slots, ...}
  probing: {}, // id -> true, пока идёт ручная проверка
  checkingAll: false,
  draftChecking: false,
  ping: null, // последний «пинг всех»: {results, at} — рисуется в разделе
};

const PROV_SLOT_OPTIONS = [
  { id: "", title: "Без приоритета" },
  { id: "high", title: "Высокий — первый" },
  { id: "medium", title: "Средний — второй" },
  { id: "low", title: "Низкий — последний" },
];
/* Короткие подписи слотов — для сегмент-контрола в панели управления и для
   подсказок. PROV_SLOT_OPTIONS длинные (для выпадающего списка на карточке),
   в панели они не помещались и читались как «Высокий — первый» в кнопке. */
const PROV_SLOT_LABELS = { high: "Высокий", medium: "Средний", low: "Низкий" };

function provRel(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - Number(ts));
  if (diff < 10 * 1000) return "только что";
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} с назад`;
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} мин назад`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} ч назад`;
  return fmtDateTime(ts);
}

function provHealth(p) {
  // Порядок важен: выключенный/без ключа — всегда серый, живой трафик —
  // зелёный пульс, свежая ручная проба — её цвет, иначе «не проверялся».
  if (!p.enabled) return ["idle", "Отключён"];
  if (!p.configured) return ["idle", p.keySet ? "Отключён" : "Нет ключа"];
  if (p.recent) return ["live", "Используется"];
  if (p.lastCheck && p.lastCheck.ok) return ["ok", `Доступен · ${provRel(p.lastCheck.at)}`];
  if (p.lastCheck && !p.lastCheck.ok) return ["bad", "Недоступен"];
  if (p.lastOkAt) return ["ok", `Был доступен · ${provRel(p.lastOkAt)}`];
  if (p.lastError) return ["bad", "Была ошибка"];
  return ["idle", "Не проверялся"];
}

function provCardHTML(p) {
  const [dot, dotLabel] = provHealth(p);
  const check = p.lastCheck || null;
  const busy = !!Prov.probing[p.id];
  return `
  <div class="a-prov-card${p.active ? " a-prov-card--active" : ""}">
    <button type="button" class="a-prov-card__open" onclick="openProviderDetail('${esc(p.id)}')" title="Настройки провайдера и список моделей">
      <div class="a-prov-top">
        <span class="a-dot a-dot--${dot}" title="${esc(dotLabel)}"></span>
        <span class="a-prov-title">${esc(p.title || p.id)}</span>
        ${p.builtin ? `<span class="a-chip" title="Стандартные значения — из окружения сервера">встроенный</span>` : `<span class="a-chip a-chip--accent">свой</span>`}
        ${p.active ? `<span class="a-chip a-chip--success" title="Запросы учеников идут сюда первым">активный</span>` : ""}
        ${p.modelOverridden ? `<span class="a-chip a-chip--warn" title="Модель изменена из админки">модель изменена</span>` : ""}
        <span class="spacer"></span>
        <span class="a-prov-card__more" aria-hidden="true">${aicon("chevron")}</span>
      </div>
      <div class="a-prov-id mono">${esc(p.id)}${p.slot ? ` · <b>${esc(p.slotLabel || p.slot)}</b>` : ""}</div>
      <div class="a-prov-meta">
        <div class="a-prov-kv"><span>Модель</span><b class="mono">${esc(p.model || "—")}</b></div>
      ${p.modelTitle ? `<div class="a-prov-kv"><span>Для ученика</span><b>${esc(p.modelTitle)}</b></div>` : ""}
        <div class="a-prov-kv"><span>Адрес</span><b class="mono">${esc(p.baseHost || p.baseUrl || "—")}</b></div>
        <div class="a-prov-kv"><span>Ключ</span><b>${p.keySet ? `задан <span class="mono">${esc(p.keyHint || "")}</span>` : "не задан"}</b></div>
        <div class="a-prov-kv"><span>Статус</span><b>${esc(dotLabel)}</b></div>
        ${check ? `<div class="a-prov-kv"><span>Проверка</span><b>${check.ok ? `ок за ${fmtNum(check.latencyMs)} мс` : esc(check.error || "ошибка")} · ${esc(provRel(check.at))}</b></div>` : ""}
        ${!check && p.lastOkAt ? `<div class="a-prov-kv"><span>Успех</span><b>${esc(provRel(p.lastOkAt))}</b></div>` : ""}
        ${p.lastError && (!check || !check.ok) ? `<div class="a-prov-kv"><span>Ошибка</span><b class="a-prov-err">${esc(p.lastError)}</b></div>` : ""}
      </div>
      ${(p.warnings || []).map((w) => `<div class="a-prov-warn">${esc(w)}</div>`).join("")}
      <div class="a-prov-flags">
        ${p.auth === "raw" ? `<span class="a-chip" title="Ключ уходит как есть (quirk gptunnel)">raw-ключ</span>` : ""}
        ${p.useWalletBalance ? `<span class="a-chip" title="Списывать предоплату кошелька">кошелёк</span>` : ""}
        ${p.mergeSystem ? `<span class="a-chip" title="System-промпт подклеивается к user (маршруты вроде anthropic)">merge system</span>` : ""}
      </div>
    </button>
    <div class="a-prov-actions">
      <button class="btn btn--soft btn--sm" onclick="probeProvider('${esc(p.id)}')"${busy || !p.configured ? " disabled" : ""}>${busy ? "Проверяем…" : "Проверить"}</button>
      <select class="a-select a-prov-slot" onchange="setProviderSlot('${esc(p.id)}', this.value)" title="Приоритет: один слот — один провайдер">
        ${PROV_SLOT_OPTIONS.map((o) => `<option value="${o.id}"${(o.id || "") === (p.slot || "") ? " selected" : ""}>${esc(o.title)}</option>`).join("")}
      </select>
      <button class="btn btn--soft btn--sm" onclick="toggleProvider('${esc(p.id)}', ${p.enabled ? "false" : "true"})" title="${p.enabled ? "Убрать из ротации" : "Вернуть в ротацию"}">${p.enabled ? "Выключить" : "Включить"}</button>
      ${p.builtin ? "" : `<button class="a-icon-btn a-icon-btn--danger" onclick="deleteProvider('${esc(p.id)}')" title="Удалить провайдера">${aicon("trash")}</button>`}
    </div>
  </div>`;
}

/* Текущая карточка по id — источник правды для модалки: после любой мутации
   мы перечитываем список с сервера, а модалка должна показать именно то, что
   вернулось, иначе она бы показывала устаревшую модель. */
function provById(id) {
  const list = (Prov.data && Prov.data.providers) || [];
  return list.find((p) => p.id === id) || null;
}

function drawProviders() {
  const body = document.getElementById("provBody");
  if (!body) return;
  if (Prov.loading && !Prov.data) {
    body.innerHTML = `<div class="a-skeleton" style="height:90px"></div><div class="a-skeleton" style="height:280px;margin-top:16px"></div>`;
    return;
  }
  if (Prov.error && !Prov.data) {
    body.innerHTML = `<div class="a-error-banner">Не удалось загрузить провайдеров: ${esc(Prov.error)}<button class="btn btn--soft btn--sm" onclick="screenProviders()">Повторить</button></div>`;
    return;
  }
  const d = Prov.data || { providers: [], order: [], slots: {} };
  const list = Array.isArray(d.providers) ? d.providers : [];
  const order = Array.isArray(d.order) ? d.order : [];
  const names = Object.fromEntries(list.map((p) => [p.id, p.title || p.id]));
  body.innerHTML = `
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head a-card__head--wrap">
        <span class="a-card__title">Очерёдность запросов</span>
        <span class="spacer"></span>
        <button class="btn btn--soft btn--sm" onclick="screenProviders(true)" title="Перечитать список без запросов к провайдерам">Обновить</button>
        <button class="btn btn--soft btn--sm" id="provProbeAllBtn" onclick="probeAllProviders()"${Prov.checkingAll ? " disabled" : ""}>${Prov.checkingAll ? "Проверяем…" : `${aicon("pulse")} Проверить всех`}</button>
        <button class="btn btn--primary btn--sm" onclick="openProviderModal()">+ Добавить</button>
      </div>
      <div class="a-prov-order">${order.length ? order.map((id, i) => `${i ? '<span class="a-prov-arrow">→</span>' : ""}<span class="a-chip${i === 0 ? " a-chip--success" : ""}" title="${esc(names[id] || id)}">${i + 1}. ${esc(names[id] || id)}</span>`).join("") : `<span class="a-card__sub">Нет настроенных провайдеров — проверки сочинений и наставник отвечают 503.</span>`}</div>
      <div class="a-card__sub" style="margin-top:8px">Активный${d.active ? `: <b>${esc(names[d.active] || d.active)}</b> — новые запросы идут сюда первым` : ": нет"}. Статус «Используется» — успех живого трафика за последние ${Number(d.recentWindowSec) || 60} с, холостых запросов ради него нет. «Пинг всех» — живой запрос «привет» каждому провайдеру с задержкой.</div>
      <div id="provPingAllResult" style="margin-top:12px">${Prov.ping && Prov.ping.results ? provPingRowsHTML(Prov.ping.results) : ""}</div>
    </div>
    ${Prov.error ? `<div class="a-error-banner" style="margin-bottom:14px">Не удалось обновить: ${esc(Prov.error)}</div>` : ""}
    <div class="a-prov-grid">
      ${list.map(provCardHTML).join("")}
    </div>`;
}

async function screenProviders(quiet) {
  if (!quiet) renderShell("providers", `<div id="provBody"></div>`);
  if (!document.getElementById("provBody")) renderShell("providers", `<div id="provBody"></div>`);
  if (!quiet) { Prov.loading = true; Prov.error = null; drawProviders(); }
  try {
    Prov.data = await AdminApi.get("/api/admin/providers");
    Prov.error = null;
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    Prov.error = e.message || "неизвестная ошибка";
  }
  Prov.loading = false;
  drawProviders();
}

async function probeProvider(id) {
  if (Prov.probing[id]) return;
  Prov.probing[id] = true;
  drawProviders();
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/probe`, {});
    const p = r && r.probe;
    toast(p && p.ok ? `«${id}» доступен (${p.latencyMs} мс)` : `«${id}» недоступен: ${(p && p.error) || "ошибка"}`, p && p.ok ? "ok" : "err");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось проверить: ${e.message || "ошибка"}`, "err");
  } finally {
    delete Prov.probing[id];
  }
  await screenProviders(true);
}

async function probeAllProviders() {
  if (Prov.checkingAll) return;
  Prov.checkingAll = true;
  drawProviders();
  try {
    await runPingAll((html) => {
      const box = document.getElementById("provPingAllResult");
      if (box) box.innerHTML = html;
    }, document.getElementById("provProbeAllBtn"), "Проверяем…");
  } finally {
    Prov.checkingAll = false;
  }
}

async function setProviderSlot(id, slot) {
  try {
    const cur = Object.assign({ high: null, medium: null, low: null }, (Prov.data && Prov.data.slots) || {});
    Object.keys(cur).forEach((s) => { if (cur[s] === id) cur[s] = null; });
    if (slot) cur[slot] = id;
    await AdminApi.post("/api/admin/providers/slots", { slots: cur });
    toast("Приоритет обновлён");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось: ${e.message || "ошибка"}`, "err");
  }
  await screenProviders(true);
}

async function toggleProvider(id, enabled) {
  try {
    await AdminApi.put(`/api/admin/providers/${encodeURIComponent(id)}`, { enabled: !!enabled });
    toast(enabled ? "Провайдер включён" : "Провайдер выключен");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось: ${e.message || "ошибка"}`, "err");
  }
  await screenProviders(true);
}

async function deleteProvider(id) {
  if (!confirm(`Удалить провайдера «${id}»? Из ротации он уйдёт сразу.`)) return;
  try {
    await AdminApi.request(`/api/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Провайдер удалён");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось удалить: ${e.message || "ошибка"}`, "err");
  }
  await screenProviders(true);
}

function provField(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

async function draftProbeFromModal() {
  const box = document.getElementById("provDraftResult");
  const btn = document.getElementById("provDraftBtn");
  if (btn) btn.disabled = true;
  if (box) box.innerHTML = `<span class="a-card__sub">Проверяем живым запросом «привет»…</span>`;
  Prov.draftChecking = true;
  try {
    const r = await AdminApi.post("/api/admin/providers/probe", {
      base_url: provField("provBaseUrl"), model: provField("provModel"),
      api_key: provField("provKey"), auth: provField("provAuth"),
      model_title: provField("provModelTitle"),
      useWalletBalance: document.getElementById("provWallet")?.checked,
    });
    const p = r && r.probe;
    if (box) box.innerHTML = p && p.ok
      ? `<div class="a-prov-checkok">Модель отвечает (${fmtNum(p.latencyMs)} мс). Можно добавлять.</div>`
      : `<div class="a-prov-checkbad">Модель недоступна: ${esc((p && p.error) || "ошибка")}. Добавить можно — в ротацию войдёт, когда заработает.</div>`;
  } catch (e) {
    if (box) box.innerHTML = `<div class="a-prov-checkbad">${esc(e.message || "ошибка проверки")}</div>`;
  } finally {
    Prov.draftChecking = false;
    if (btn) btn.disabled = false;
  }
}

function openProviderModal() {
  const root = A.modalRoot;
  root.innerHTML = `
  <div class="a-modal-backdrop" id="provBackdrop">
    <div class="a-modal" role="dialog" aria-label="Новый провайдер">
      <div class="a-modal__title">Новый провайдер</div>
      <div class="a-modal__desc">Обычный OpenAI-совместимый API (как CloseRouter): base URL + модель + ключ. Перед сохранением можно проверить живым запросом «привет» — недоступная модель добавлению не мешает, в ротацию войдёт, когда заработает.</div>
      <div class="a-modal__form">
        <div class="a-form-grid">
          <div class="a-field"><label for="provId">ID латиницей</label><input class="a-input" id="provId" placeholder="openrouter" autocomplete="off"></div>
          <div class="a-field"><label for="provTitle">Название</label><input class="a-input" id="provTitle" placeholder="OpenRouter" autocomplete="off"></div>
        </div>
        <div class="a-field"><label for="provBaseUrl">Base URL</label><input class="a-input mono" id="provBaseUrl" placeholder="https://openrouter.ai/api/v1" autocomplete="off"></div>
        <div class="a-field"><label for="provModel">Модель (ID у провайдера)</label><input class="a-input mono" id="provModel" placeholder="openai/gpt-4o-mini" autocomplete="off" spellcheck="false"></div>
        <div class="a-field"><label for="provModelTitle">Название для ученика</label><input class="a-input" id="provModelTitle" placeholder="например: топ модель" autocomplete="off"><span class="a-field__hint">Это увидит ученик на странице результата вместо технического ID. Пусто — покажем ID.</span></div>
        <div class="a-field"><label for="provKey">API-ключ</label><input class="a-input mono" id="provKey" type="password" placeholder="sk-…" autocomplete="off"></div>
        <div class="a-form-grid">
          <div class="a-field"><label for="provAuth">Авторизация</label><select class="a-select" id="provAuth"><option value="bearer">Bearer (обычно)</option><option value="raw">Сырой ключ (как gptunnel)</option></select></div>
          <div class="a-field"><label for="provSlot">Приоритет</label><select class="a-select" id="provSlot"><option value="">Без приоритета</option><option value="high">Высокий — первый</option><option value="medium">Средний — второй</option><option value="low">Низкий — последний</option></select></div>
        </div>
        <label class="a-check"><input type="checkbox" id="provWallet"> <span>useWalletBalance (только для gptunnel-подобных)</span></label>
        <label class="a-check"><input type="checkbox" id="provMerge"> <span>Подклеивать system к user (маршруты вроде anthropic)</span></label>
        <div id="provDraftResult"></div>
        <div class="a-modal__error" id="provFormError" hidden></div>
      </div>
      <div class="a-modal__actions">
        <button class="btn btn--soft btn--sm" id="provDraftBtn" type="button">Проверить без сохранения</button>
        <span style="flex:1"></span>
        <button class="btn btn--soft btn--sm" id="provCancel" type="button">Отмена</button>
        <button class="btn btn--primary btn--sm" id="provSave" type="button">Добавить</button>
      </div>
    </div>
  </div>`;
  document.getElementById("provCancel").onclick = closeProviderModal;
  document.getElementById("provBackdrop").onclick = (e) => { if (e.target.id === "provBackdrop") closeProviderModal(); };
  document.getElementById("provDraftBtn").onclick = draftProbeFromModal;
  document.getElementById("provSave").onclick = saveProviderFromModal;
}

function closeProviderModal() { A.modalRoot.innerHTML = ""; }

async function saveProviderFromModal() {
  const err = document.getElementById("provFormError");
  const btn = document.getElementById("provSave");
  if (err) { err.hidden = true; err.textContent = ""; }
  if (btn) { btn.disabled = true; btn.textContent = "Добавляем…"; }
  try {
    const r = await AdminApi.post("/api/admin/providers", {
      id: provField("provId"), title: provField("provTitle"),
      base_url: provField("provBaseUrl"), model: provField("provModel"),
      api_key: provField("provKey"), auth: provField("provAuth"),
      model_title: provField("provModelTitle"),
      useWalletBalance: document.getElementById("provWallet")?.checked,
      mergeSystem: document.getElementById("provMerge")?.checked,
      slot: provField("provSlot") || null,
    });
    closeProviderModal();
    if (r && r.warning) toast(r.warning, "err");
    else if (r && r.probe && r.probe.ok) toast(`«${r.provider.id}» добавлен и отвечает (${r.probe.latencyMs} мс)`);
    else toast("Провайдер добавлен");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    if (err) { err.textContent = e.message || "ошибка"; err.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Добавить"; }
  }
  await screenProviders(true);
}

/* ---------------- Детальная настройка провайдера ----------------
   Открывается кликом по карточке. Внутри: текущие значения, список моделей
   провайдера (GET <base>/models — единственный честный источник имён),
   выбор модели, её проверка до применения и сброс к стандартным значениям.
   Список моделей и проба — это ЖИВЫЕ запросы к провайдеру, поэтому идут
   через POST /api/admin/providers/<id>/models и /probe-model с троттлингом
   на сервере; на клиенте они помечены, чтобы не казались мгновенными. */

const ProvDetail = {
  id: null, models: null, loading: false, probing: false, pinging: false,
  model: null, error: null, meta: null, verdict: "", modelPing: null,
  // Что сервер уже знает (модель и её название): по этому полям панели
  // показывается «не применено».
  current: { model: "", modelTitle: "" },
};

/* Вердикт (проверки/применения) держим в состоянии, а не только в DOM: после
   сохранения карточки перерисовываются, а перерисовка модалки раньше стирала
   сообщение — человек видел «сохранено» без внятного ответа. */
function provDetailSetVerdict(html) {
  ProvDetail.verdict = html || "";
  const box = document.getElementById("provModelProbeResult");
  if (box) box.innerHTML = ProvDetail.verdict;
}

function provVerdictOk(html) { provDetailSetVerdict(`<div class="a-prov-checkok">${html}</div>`); }
function provVerdictBad(html) { provDetailSetVerdict(`<div class="a-prov-checkbad">${html}</div>`); }

function provDetailModelInput() {
  const el = document.getElementById("provDetailModel");
  return el ? el.value.trim() : "";
}

function provDetailRenderList() {
  const box = document.getElementById("provModelList");
  if (!box) return;
  const d = ProvDetail;
  if (d.loading) {
    box.innerHTML = `<div class="a-prov-models__empty">Список загружается у провайдера…</div>`;
    return;
  }
  if (!d.models) {
    box.innerHTML = `<div class="a-prov-models__empty">Список ещё не получен — он берётся у провайдера живым запросом.<br>Нажми «Список моделей» или впиши модель вручную.</div>`;
    return;
  }
  const list = d.models.models || [];
  const total = d.models.total || list.length;
  if (!list.length) {
    box.innerHTML = `<div class="a-prov-checkbad">Провайдер вернул пустой список моделей.</div>`;
    return;
  }
  // Фильтр по подстроке — список у шлюзов бывает на сотни позиций, а
  // прокручивать его вручную бессмысленно. Сравнение регистронезависимое,
  // пустая строка показывает всё.
  const query = (document.getElementById("provModelFilter")?.value || "").trim().toLowerCase();
  const shown = query ? list.filter((m) => m.toLowerCase().includes(query)) : list;
  const cur = provDetailModelInput() || d.models.current || "";
  const rows = shown.map((m) => {
    const isCur = m === d.models.current;
    const isPicked = m === cur;
    // Вердикт пинга всех моделей виден прямо в списке: после проверки не надо
    // гадать, где модель работает — точка слева уже отвечает на это.
    const pinged = d.modelPing && d.modelPing.results ? d.modelPing.results[m] : null;
    const dot = pinged ? `<span class="a-dot a-dot--${pinged.ok ? "ok" : "bad"}" title="${esc(pinged.ok ? `Задержка ${pinged.latencyMs} мс` : (pinged.error || "недоступна"))}"></span>` : "";
    // Модель идёт в data-атрибут, а не в onclick: id модели в кавычках
    // (владелец → "модель") ломал бы атрибут и всю страницу до ошибки JS.
    return `<li><button type="button" class="a-prov-model${isPicked ? " a-prov-model--picked" : ""}"
        data-model="${esc(m)}" onclick="pickProviderModel(this.dataset.model)"
        title="${esc(m)}">
      ${dot}
      <span class="a-prov-model__name">${esc(m)}</span>
      ${isCur ? `<span class="a-chip a-chip--accent">сейчас</span>` : ""}
      ${isPicked ? `<span class="a-prov-model__tick">${aicon("check")}</span>` : ""}
    </button></li>`;
  }).join("");
  box.innerHTML = `
    <div class="a-prov-models__list">
      ${rows || `<div class="a-prov-models__empty">Ничего не найдено по запросу «${esc(query)}».</div>`}
    </div>
    <div class="a-prov-models__foot">
      <span>${query ? `Найдено ${fmtNum(shown.length)} из ${fmtNum(list.length)}` : `Моделей у провайдера: ${fmtNum(list.length)}${total > list.length ? ` (показаны первые ${fmtNum(list.length)} из ${fmtNum(total)})` : ""}`}</span>
      ${d.models.latencyMs != null ? `<span>список получен за ${fmtNum(d.models.latencyMs)} мс</span>` : ""}
    </div>`;
}

function pickProviderModel(model) {
  ProvDetail.model = model;
  const el = document.getElementById("provDetailModel");
  if (el) el.value = model;
  // Список перерисовывается, чтобы галочка «выбрано» уехала на новую строку,
  // а вердикт прошлой проверки не остался висеть у другой модели.
  provDetailRenderList();
  provDetailSetVerdict("");
  provDetailMarkDirty();
}

/* Проверка ВСЕХ провайдеров разом (кнопка в разделе): живой запрос «привет»
   каждому и задержка по каждому. Рисуется ОДНИМ кодом, чтобы раздел и
   модалка не разошлись видом. Это НЕ то же, что «пинг всех моделей» в
   модалке: там проверяются модели одного провайдера, здесь — сами
   провайдеры. */
function provPingRowsHTML(res) {
  const ids = Object.keys(res || {});
  if (!ids.length) return `<div class="a-prov-checkbad">Нет настроенных провайдеров для проверки.</div>`;
  return `<div class="a-prov-pings">${ids.map((id) => {
    const p = res[id] || {};
    const card = provById(id);
    const name = (card && (card.title || card.id)) || id;
    const label = p.ok ? `${fmtNum(p.latencyMs)} мс` : (p.error || "недоступен");
    return `<div class="a-prov-ping ${p.ok ? "a-prov-ping--ok" : "a-prov-ping--bad"}">
      <span class="a-dot a-dot--${p.ok ? "ok" : "bad"}"></span>
      <span class="a-prov-ping__name">${esc(name)}</span>
      ${card && card.slot ? `<span class="a-chip">${esc(card.slotLabel || card.slot)}</span>` : ""}
      <span class="a-prov-ping__ms">${esc(label)}</span>
    </div>`;
  }).join("")}</div>`;
}

/* Общий шаг обеих точек входа (раздел и модалка): троттлинг, разбор ошибки,
   запись результата. `paint` получает HTML — куда его показать. */
async function runPingAll(paint, btn, busyLabel) {
  const idleLabel = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.textContent = busyLabel || "Пингуем…"; }
  paint(`<div class="a-prov-hint">Отправляем «привет» каждому провайдеру по очереди…</div>`);
  try {
    const r = await AdminApi.post("/api/admin/providers/probe-all", {});
    const res = (r && r.results) || {};
    Prov.ping = { results: res, at: Date.now() };
    paint(provPingRowsHTML(res));
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    paint(e.retryAfter
      ? `<div class="a-prov-hint">Проверка всех недавно запускалась — повтори через ${e.retryAfter} с.</div>`
      : `<div class="a-prov-checkbad">${esc(e.message || "ошибка проверки")}</div>`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = idleLabel; }
  }
  // Карточки получили свежие метки проверки — перечитываем список.
  await screenProviders(true);
}

function probeAllProviders() {
  if (Prov.checkingAll) return;
  Prov.checkingAll = true;
  drawProviders();
  const paint = (html) => {
    const box = document.getElementById("provPingAllResult");
    if (box) box.innerHTML = html;
  };
  runPingAll(paint, document.getElementById("provProbeAllBtn"), "Проверяем…")
    .finally(() => { Prov.checkingAll = false; });
}

/* ---------------- Пинг ВСЕХ МОДЕЛЕЙ одного провайдера ----------------
   У шлюза список моделей бывает на сотни позиций, доступны из них единицы:
   модель снята, нет доступа к региону, политика шлюза. Ручной перебор по одной
   — минуты работы, поэтому сервер проверяет их пачкой (POST
   .../probe-models, кап ai.PROBE_MODELS_MAX) и отдаёт вердикт по каждой.
   Список моделей для проверки сервер берёт САМ у провайдера: клиент мог бы
   прислать что угодно, а проверять надо реальные модели. */
function provModelPingHTML(ping) {
  if (!ping) return "";
  const res = ping.results || {};
  const order = (ping.order && ping.order.length) ? ping.order : Object.keys(res);
  if (!order.length) return "";
  // Порядок приходит с сервера и он по скорости: сперва самые быстрые живые
  // модели, потом остальные живые, и только потом недоступные. Рейтинг на
  // экране повторяет его же, иначе «сначала самые быстрые» было бы обещанием
  // без правды.
  const maxLatency = order.reduce((acc, m) => {
    const r = res[m] || {};
    return r.ok && r.latencyMs > acc ? r.latencyMs : acc;
  }, 1);
  const rows = order.map((m, i) => {
    const p = res[m] || {};
    const cur = (ProvDetail.models && ProvDetail.models.current) === m;
    const width = p.ok ? Math.max(6, Math.round((p.latencyMs / maxLatency) * 100)) : 0;
    return `<button type="button" class="a-rank${p.ok ? " a-rank--ok" : " a-rank--bad"}"
        data-model="${esc(m)}" onclick="pickProviderModel(this.dataset.model)"
        title="${p.ok ? `Задержка ${p.latencyMs} мс — нажми, чтобы выбрать` : esc(p.error || "недоступна")}">
      <span class="a-rank__no">${i + 1}</span>
      <span class="a-dot a-dot--${p.ok ? "ok" : "bad"}"></span>
      <span class="a-rank__name mono">${esc(m)}</span>
      ${cur ? `<span class="a-chip a-chip--accent">сейчас</span>` : ""}
      ${p.ok ? `<span class="a-rank__bar"><i style="width:${width}%"></i></span>` : ""}
      <span class="a-rank__ms">${esc(p.ok ? `${fmtNum(p.latencyMs)} мс` : (p.error || "недоступна"))}</span>
    </button>`;
  }).join("");
  const head = `Проверено ${fmtNum(ping.checked)} из ${fmtNum(ping.total)}: работающих ${fmtNum(ping.okCount)}`
    + (ping.skipped ? `, не проверено ${fmtNum(ping.skipped)} (потолок ${fmtNum(ping.limit)} за нажатие)` : "");
  return `<div class="a-prov-hint" style="margin:10px 0 6px">${esc(head)} · ${esc(provRel(ping.at))}. Отсортировано по скорости, нажми на модель, чтобы выбрать её.</div>
    <div class="a-ranks">${rows}</div>`;
}

async function pingProviderModels() {
  const id = ProvDetail.id;
  if (!id || ProvDetail.pinging) return;
  ProvDetail.pinging = true;
  const btn = document.getElementById("provPingModelsBtn");
  const box = document.getElementById("provModelPingResult");
  const idle = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.textContent = "Пингуем модели…"; }
  if (box) box.innerHTML = `<div class="a-prov-hint">Проверяем модели провайдера по очереди, каждая — живой запрос «привет»…</div>`;
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/probe-models`, {});
    ProvDetail.modelPing = { results: (r && r.results) || {}, total: (r && r.total) || 0,
                             checked: (r && r.checked) || 0, skipped: (r && r.skipped) || 0,
                             okCount: (r && r.okCount) || 0, limit: (r && r.limit) || 0,
                             order: (r && r.order) || [],
                             at: (r && r.checkedAt) || Date.now() };
    if (r && r.results && !ProvDetail.models) {
      // Список на сервере мог уйти дальше первых MODELS_LIST_MAX — тогда в
      // клиентском списке часть моделей не будет, а вердикты по ним есть.
      ProvDetail.models = { models: Object.keys(r.results), current: r.current || "", latencyMs: null };
      provDetailRenderList();
    }
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    ProvDetail.modelPing = null;
    if (box) {
      box.innerHTML = e.retryAfter
        ? `<div class="a-prov-hint">Модели только что проверяли — повтори через ${e.retryAfter} с.</div>`
        : `<div class="a-prov-checkbad">${esc(e.message || "ошибка проверки")}</div>`;
    }
  } finally {
    ProvDetail.pinging = false;
    if (btn) { btn.disabled = false; btn.innerHTML = idle; }
    if (ProvDetail.id === id) {
      const res = document.getElementById("provModelPingResult");
      if (res && ProvDetail.modelPing) res.innerHTML = provModelPingHTML(ProvDetail.modelPing);
    }
  }
}

/* Сегмент-контрол приоритета. Выпадающий список здесь врал: человек не видел,
   что слот РОВНО ОДИН и что он освобождает прежнего держателя. Четыре кнопки
   показывают всю шкалу сразу, а занятость видно из подписи. */
const PROV_SLOT_SEGMENTS = [
  { id: "high", label: "Высокий", hint: "пробуем первым" },
  { id: "medium", label: "Средний", hint: "если первый отказал" },
  { id: "low", label: "Низкий", hint: "в самом конце" },
  { id: "", label: "Без приоритета", hint: "вне очереди" },
];

function provSlotSegHTML(current) {
  return `<div class="a-seg2" role="group" aria-label="Приоритет провайдера в очереди">
    ${PROV_SLOT_SEGMENTS.map((s) => `<button type="button" class="a-seg2__btn${(s.id || "") === (current || "") ? " a-seg2__btn--on" : ""}"
        data-slot="${s.id}" onclick="setDetailSlot('${s.id}')" title="${esc(s.hint)}">
      ${esc(s.label)}<span class="a-seg2__hint">${esc(s.hint)}</span>
    </button>`).join("")}
  </div>`;
}

function setDetailSlot(slot) {
  const box = document.getElementById("provSlotSeg");
  if (!box) return;
  box.querySelectorAll(".a-seg2__btn").forEach((b) => {
    b.classList.toggle("a-seg2__btn--on", (b.dataset.slot || "") === (slot || ""));
  });
  const note = document.getElementById("provSlotNote");
  if (note) {
    note.textContent = slot
      ? `Провайдер встанет в слот «${PROV_SLOT_LABELS[slot] || slot}» — прежний держатель слота освободится.`
      : "Провайдер останется вне очереди по приоритету (работать будет, если остальные недоступны).";
  }
}

function openProviderDetail(id) {
  const p = provById(id);
  if (!p) { toast("Провайдер не найден в списке", "err"); return; }
  ProvDetail.id = id;
  ProvDetail.models = null;
  ProvDetail.loading = false;
  ProvDetail.probing = false;
  ProvDetail.pinging = false;
  ProvDetail.model = p.model || "";
  ProvDetail.error = null;
  ProvDetail.verdict = "";
  ProvDetail.modelPing = null;
  // Сохранённые значения — по ним панель понимает, что поле изменено и ждёт
  // кнопки «Сохранить». Без этого правка модели (в том числе выбором из
  // списка или из рейтинга) выглядела бы уже применённой.
  ProvDetail.current = { model: p.model || "", modelTitle: p.modelTitle || "" };
  const [dot, dotLabel] = provHealth(p);
  const [checkDot, checkLabel] = p.lastCheck
    ? (p.lastCheck.ok ? ["ok", `Живой ответ за ${fmtNum(p.lastCheck.latencyMs)} мс`] : ["bad", `Недоступен: ${p.lastCheck.error || "—"}`])
    : ["idle", "Ручной проверки ещё не было"];
  const title = p.modelTitle || "";
  const root = A.modalRoot;
  root.innerHTML = `
  <div class="a-modal-backdrop" id="provDetailBackdrop">
    <div class="a-modal a-modal--panel" role="dialog" aria-label="Управление провайдером ${esc(p.title || p.id)}">
      <div class="a-pnl">
        <div class="a-pnl__head">
          <span class="a-dot a-dot--${dot}"></span>
          <div class="a-pnl__title-wrap">
            <div class="a-pnl__title">${esc(p.title || p.id)}</div>
            <div class="a-pnl__sub mono">${esc(p.id)}</div>
          </div>
          <div class="a-pnl__badges">
            ${p.builtin ? `<span class="a-chip">встроенный</span>` : `<span class="a-chip a-chip--accent">свой</span>`}
            ${p.active ? `<span class="a-chip a-chip--success">активный</span>` : ""}
            ${p.enabled ? "" : `<span class="a-chip a-chip--warn">выключен</span>`}
            ${p.modelOverridden ? `<span class="a-chip a-chip--warn">модель изменена</span>` : ""}
          </div>
          <button type="button" class="a-icon-btn" id="provDetailX" title="Закрыть" aria-label="Закрыть">${aicon("x")}</button>
        </div>
        <div class="a-pnl__status">
          <span class="a-pnl__status-item"><i class="a-dot a-dot--${dot}"></i> ${esc(dotLabel)}</span>
          <span class="a-pnl__status-item"><i class="a-dot a-dot--${checkDot}"></i> ${esc(checkLabel)}</span>
          <span class="a-pnl__status-item">${p.recent ? "сейчас отвечает ученикам" : "сейчас не используется"}</span>
        </div>

        <div class="a-pnl__body">
          <section class="a-pnl__sec">
            <div class="a-pnl__sec-title">Модель</div>
            <div class="a-form-grid">
              <div class="a-field">
                <label for="provDetailModel">ID модели у провайдера</label>
                <input class="a-input mono" id="provDetailModel" value="${esc(p.model || "")}" autocomplete="off" spellcheck="false">
                <span class="a-field__hint" id="provModelHint">Сейчас: <span class="mono">${esc(p.model || "—")}</span>${p.defaultModel && p.model !== p.defaultModel ? ` · в окружении: <span class="mono">${esc(p.defaultModel)}</span>` : ""}</span>
              </div>
              <div class="a-field">
                <label for="provDetailModelTitle">Название для ученика</label>
                <input class="a-input" id="provDetailModelTitle" value="${esc(title)}" placeholder="например: топ модель" autocomplete="off">
                <span class="a-field__hint" id="provTitleHint">Это увидит ученик на странице результата вместо технического ID. Пусто — покажем ID модели.</span>
              </div>
            </div>
            <div class="a-pnl__row">
              <button class="btn btn--soft btn--sm" id="provModelsBtn" type="button">${aicon("list")} Список моделей</button>
              <button class="btn btn--soft btn--sm" id="provModelProbeBtn" type="button">${aicon("pulse")} Проверить выбранную</button>
              <button class="btn btn--soft btn--sm" id="provPingModelsBtn" type="button">${aicon("pulse")} Пинг всех моделей</button>
            </div>
            <div id="provModelProbeResult">${ProvDetail.verdict}</div>
          </section>

          <section class="a-pnl__sec">
            <div class="a-pnl__sec-title">Модели провайдера</div>
            <div class="a-prov-models">
              <div class="a-prov-models__bar">
                <input class="a-input a-prov-models__filter" id="provModelFilter" placeholder="Поиск по названию…" autocomplete="off" spellcheck="false">
              </div>
              <div id="provModelList"></div>
            </div>
            <div id="provModelPingResult">${provModelPingHTML(ProvDetail.modelPing)}</div>
          </section>

          <section class="a-pnl__sec">
            <div class="a-pnl__sec-title">Подключение</div>
            <div class="a-form-grid">
              <div class="a-field">
                <label for="provDetailBaseUrl">Base URL</label>
                <input class="a-input mono" id="provDetailBaseUrl" value="${esc(p.baseUrl || "")}" autocomplete="off" spellcheck="false">
                <span class="a-field__hint">${esc(p.baseHost || "")}</span>
              </div>
              <div class="a-field">
                <label for="provDetailKey">API-ключ</label>
                <input class="a-input mono" id="provDetailKey" type="password" placeholder="${p.keySet ? esc(`задан ${p.keyHint || ""} — пусто = не менять`) : "не задан"}" autocomplete="off">
                <span class="a-field__hint">${p.keySet ? "Ключ хранится в базе и никогда не отдаётся в браузер целиком." : "Без ключа провайдер не участвует в ротации."}</span>
              </div>
            </div>
          </section>

          <section class="a-pnl__sec">
            <div class="a-pnl__sec-title">Место в очереди</div>
            <div id="provSlotSeg">${provSlotSegHTML(p.slot || "")}</div>
            <div class="a-field__hint" id="provSlotNote">${p.slot ? `Провайдер в слоте «${esc(p.slotLabel || p.slot)}».` : "Провайдер вне очереди по приоритету."} Один приоритет — один провайдер: выбранный слот освободится от прежнего.</div>
          </section>

          <div class="a-pnl__note">${p.builtin
            ? "Стандартные значения встроенного провайдера берутся из окружения сервера. Здесь можно наложить свои — они переживут рестарт, а «Сбросить» вернёт окружение."
            : "Стандартные значения — те, с которыми провайдер был добавлен. «Сбросить» вернёт их вместе с моделью и названием."}</div>
          <div class="a-modal__error" id="provDetailError" hidden></div>
        </div>

        <footer class="a-pnl__foot">
          <button class="btn btn--soft btn--sm" id="provResetBtn" type="button">${aicon("reset")} Сбросить к стандартным</button>
          ${p.builtin ? "" : `<button class="btn btn--soft btn--sm" id="provDetailDelete" type="button">${aicon("trash")} Удалить</button>`}
          <span class="spacer"></span>
          <button class="btn btn--soft btn--sm" id="provDetailClose" type="button">Отмена</button>
          <button class="btn btn--primary btn--sm" id="provDetailApply" type="button">Сохранить и проверить</button>
        </footer>
      </div>
  </div>`;
  document.getElementById("provDetailBackdrop").onclick = (e) => { if (e.target.id === "provDetailBackdrop") closeProviderDetail(); };
  document.getElementById("provDetailX").onclick = closeProviderDetail;
  document.getElementById("provDetailClose").onclick = closeProviderDetail;
  document.getElementById("provModelsBtn").onclick = loadProviderModels;
  document.getElementById("provModelProbeBtn").onclick = probeProviderModel;
  document.getElementById("provPingModelsBtn").onclick = pingProviderModels;
  const filter = document.getElementById("provModelFilter");
  if (filter) filter.oninput = () => provDetailRenderList();
  // Именно обёртка: напрямую `onclick = resetProvider` передало бы СОБЫТИЕ
  // в аргумент id, и сброс ушёл бы на провайдера «[object PointerEvent]».
  document.getElementById("provResetBtn").onclick = () => resetProvider();
  document.getElementById("provDetailApply").onclick = applyProviderDetail;
  const del = document.getElementById("provDetailDelete");
  if (del) del.onclick = () => { closeProviderDetail(); deleteProvider(id); };
  const input = document.getElementById("provDetailModel");
  if (input) input.oninput = () => { ProvDetail.model = input.value.trim(); provDetailMarkDirty(); };
  const titleInput = document.getElementById("provDetailModelTitle");
  if (titleInput) titleInput.oninput = provDetailMarkDirty;
  provDetailRenderList();
  provDetailMarkDirty();
}

/* Подсказки под полями модели и названия. Кроме «сейчас/в окружении» они
   показывают, что поле изменено и ещё не сохранено: правка модели (в том числе
   выбором из списка или из рейтинга) иначе выглядела бы уже применённой —
   человек закрывал бы панель и получал бы не то, что собирался настроить. */
function provDetailMarkDirty() {
  const cur = ProvDetail.current || { model: "", modelTitle: "" };
  const card = provById(ProvDetail.id) || {};
  const model = (document.getElementById("provDetailModel") || {}).value || "";
  const title = (document.getElementById("provDetailModelTitle") || {}).value || "";
  const modelDirty = model.trim() !== cur.model;
  const titleDirty = title.trim() !== cur.modelTitle;
  const hint = document.getElementById("provModelHint");
  if (hint) {
    hint.innerHTML = `Сейчас: <span class="mono">${esc(cur.model || "—")}</span>`
      + (card.defaultModel && cur.model !== card.defaultModel
        ? ` · в окружении: <span class="mono">${esc(card.defaultModel)}</span>` : "")
      + (modelDirty ? ` · <b>не применено: ${esc(model.trim() || "—")}</b>` : "");
    hint.classList.toggle("a-field__hint--dirty", modelDirty);
  }
  const thint = document.getElementById("provTitleHint");
  if (thint) {
    thint.innerHTML = titleDirty
      ? `Не применено. Ученик увидит: <b>${esc(title.trim() || "ID модели")}</b>`
      : "Это увидит ученик на странице результата вместо технического ID. Пусто — покажем ID модели.";
    thint.classList.toggle("a-field__hint--dirty", titleDirty);
  }
}

function closeProviderDetail() {
  A.modalRoot.innerHTML = "";
  ProvDetail.id = null;
  ProvDetail.models = null;
}

function provDetailError(msg) {
  const el = document.getElementById("provDetailError");
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
}

function provDetailSetLoading(which, busy, label) {
  const map = which === "models"
    ? ["provModelsBtn", ProvDetail.loading, "Загрузить список"]
    : ["provModelProbeBtn", ProvDetail.probing, "Проверить выбранную модель"];
  const btn = document.getElementById(map[0]);
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? label : map[2];
}

async function loadProviderModels() {
  const id = ProvDetail.id;
  if (!id || ProvDetail.loading) return;
  provDetailError("");
  ProvDetail.loading = true;
  provDetailSetLoading("models", true, "Загружаем…");
  provDetailRenderList();
  try {
    const r = await AdminApi.get(`/api/admin/providers/${encodeURIComponent(id)}/models`);
    ProvDetail.models = { models: (r && r.models) || [], total: r && r.total, truncated: !!(r && r.truncated), current: (r && r.current) || "", latencyMs: r && r.latencyMs };
    // Текущая модель — первая в списке (так возвращает сервер), но если её
    // в списке нет (шлюз её не отдаёт) — всё равно показываем её вручную.
    if (!ProvDetail.models.models.length && ProvDetail.model) {
      ProvDetail.models.models = [ProvDetail.model];
      ProvDetail.models.manualOnly = true;
    }
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    ProvDetail.error = e.message || "ошибка";
    // Троттлинг — не поломка: список у провайдера уже запрашивали недавно,
    // поэтому это «подожди», а не «не удалось получить».
    provDetailError(e.retryAfter
      ? `Список у провайдера недавно запрашивали — повтори через ${e.retryAfter} с.`
      : `Список моделей не получен: ${ProvDetail.error}. Модель можно вписать вручную.`);
  } finally {
    ProvDetail.loading = false;
    provDetailSetLoading("models", false, "Загрузить список");
    provDetailRenderList();
  }
}

async function probeProviderModel() {
  const id = ProvDetail.id;
  const model = provDetailModelInput();
  if (!id || ProvDetail.probing) return;
  if (!model) { provDetailError("Впиши или выбери модель для проверки"); return; }
  provDetailError("");
  ProvDetail.probing = true;
  provDetailSetLoading("probe", true, "Проверяем…");
  const res = document.getElementById("provModelProbeResult");
  if (res) res.innerHTML = `<div class="a-card__sub">Проверяем модель живым запросом «привет»…</div>`;
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/probe-model`, { model });
    const p = r && r.probe;
    if (p && p.ok) {
      provVerdictOk(`Модель <span class="mono">${esc(model)}</span> отвечает (${fmtNum(p.latencyMs)} мс). Её можно применять.`);
    } else {
      provVerdictBad(`Модель <span class="mono">${esc(model)}</span> не отвечает: ${esc((p && p.error) || "ошибка")}. Применить её можно, но проверки работать не будут.`);
    }
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    if (e.retryAfter) provDetailSetVerdict(`<div class="a-prov-hint">Модель только что проверяли — повтори через ${e.retryAfter} с.</div>`);
    else provVerdictBad(esc(e.message || "ошибка проверки"));
  } finally {
    ProvDetail.probing = false;
    provDetailSetLoading("probe", false, "Проверить выбранную модель");
  }
}

async function applyProviderDetail() {
  const id = ProvDetail.id;
  if (!id) return;
  const btn = document.getElementById("provDetailApply");
  provDetailError("");
  const payload = {
    model: provDetailModelInput(),
    base_url: (document.getElementById("provDetailBaseUrl") || {}).value || "",
    model_title: ((document.getElementById("provDetailModelTitle") || {}).value || "").trim(),
  };
  // Приоритет едет той же кнопкой: иначе модель применилась бы мгновенно, а
  // слот — только после второго запроса, и между ними ученик получил бы
  // провайдера по старому порядку.
  const onSlot = document.querySelector("#provSlotSeg .a-seg2__btn--on");
  payload.slot = onSlot ? (onSlot.dataset.slot || "") : "";
  const key = (document.getElementById("provDetailKey") || {}).value;
  if (key && key.trim()) payload.api_key = key.trim();
  if (!payload.model && !payload.base_url && !payload.api_key && !payload.model_title) {
    provDetailError("Нет изменений — заполни модель, название или адрес");
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Сохраняем…"; }
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/apply`, payload);
    if (r && r.warning) { provDetailError(r.warning); }
    if (r && r.probe) {
      if (r.probe.ok) provVerdictOk(`Сохранено. Модель <span class="mono">${esc(payload.model)}</span> отвечает (${fmtNum(r.probe.latencyMs)} мс).`);
      else provVerdictBad(`Сохранено, но модель не отвечает: ${esc(r.probe.error || "ошибка")}`);
    }
    toast(r && r.warning ? "Сохранено, модель не отвечает" : "Сохранено и проверено");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    provDetailError(e.message || "ошибка");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Сохранить и проверить"; }
  }
  // Карточки перерисовываются, панель — НЕТ: перерисовка стирала бы вердикт и
  // напечатанные поля. Обновляем точечно из свежей карточки.
  await screenProviders(true);
  const fresh = provById(id);
  if (fresh && ProvDetail.id === id) provDetailSyncFromCard(fresh);
}

/* Точечное обновление полей панели из свежей карточки: значения, подписи
   «сейчас/в окружении» и название для ученика. Без этого после сохранения
   панель показывала бы старые данные (замер: после смены модели подпись
   «сейчас» оставалась прежней до переоткрытия). */
function provDetailSyncFromCard(fresh) {
  const model = document.getElementById("provDetailModel");
  if (model) model.value = fresh.model || "";
  const title = document.getElementById("provDetailModelTitle");
  if (title) title.value = fresh.modelTitle || "";
  ProvDetail.model = fresh.model || "";
  // Сохранённое обновляем ДО отметки «не применено»: после успешного сохранения
  // полей расходиться с сервером нечему, и подсказка должна погаснуть сама.
  ProvDetail.current = { model: fresh.model || "", modelTitle: fresh.modelTitle || "" };
  provDetailMarkDirty();
}

async function resetProvider(id) {
  const target = id || ProvDetail.id;
  if (!target) return;
  if (!confirm(`Сбросить провайдера «${target}» к стандартным значениям?`)) return;
  provDetailError("");
  try {
    await AdminApi.post(`/api/admin/providers/${encodeURIComponent(target)}/reset`, {});
    toast("Возвращены стандартные значения");
    closeProviderDetail();
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    provDetailError(e.message || "ошибка");
  }
  await screenProviders(true);
}

/* ---------------- корневой рендер ---------------- */

async function screenBlocked() {
  let data;
  try { data = await AdminApi.get("/api/admin/blocked-tasks"); } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(e.message); return; }
    renderShell("blocked", `<div class="a-card"><div class="a-empty"><div class="a-empty__title">Ошибка</div><div class="a-empty__sub">${esc(e.message)}</div></div></div>`);
    return;
  }
  const tasks = data.tasks || [];
  if (!tasks.length) {
    renderShell("blocked", `<div class="a-card"><div class="a-empty"><div class="a-empty__icon">${aicon("check")}</div><div class="a-empty__title">Заблокированных задач нет</div><div class="a-empty__sub">Все задачи имеют полный комплект данных для решения</div></div></div>`);
    return;
  }
  const rows = tasks.map((t) => `
    <div class="a-card" style="margin-bottom:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="a-pill">${esc(t.num)} · ${esc(t.id)}</span>
        <span class="a-pill a-pill--muted">${esc(t.skill)} · ${esc(t.skillName)}</span>
        <span class="a-pill a-pill--warn">${esc(t.reason || "требуется рисунок")}</span>
      </div>
      <div style="margin:8px 0;font-size:13px;color:var(--text-2)">${esc(t.sub)} — ${esc(t.topic)}</div>
      <div style="font-size:12px;color:var(--muted)">Источник: ${esc(t.source)} · ${esc(t.sourceId)} ${t.missions && t.missions.length ? `· миссии: ${esc(t.missions.join(", "))}` : ""}</div>
      <div style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:12px">
        <span>Условие: ${t.hasText ? "✓" : "✗"}</span>
        <span>Ответ: ${t.hasAnswer ? "✓ " + esc(t.answer) : "✗"}</span>
        <span>Решение: ${t.hasSolution ? "✓" : "✗"}</span>
        <span>Рисунок: ${t.hasVisual ? "✓" : "✗ требуется"}</span>
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--muted)">Отсутствует: ${esc((t.fieldsMissing||[]).join(", "))} · ${esc(t.restorable||"")}</div>
      <div style="margin-top:6px;font-size:12px;background:var(--bg-soft);padding:6px 8px;border-radius:6px">${esc(t.templateHint||"")}</div>
      <div style="margin-top:6px;font-size:12px"><b>Восстановимость:</b> ${t.canRestore ? "можно восстановить" : "нельзя без внешних данных"}${t.needsManual ? " · нужна ручная проверка" : ""}</div>
    </div>`).join("");
  renderShell("blocked", `
    <div class="a-card" style="margin-bottom:12px"><b>Заблокировано: ${tasks.length}</b> — задачи с обязательным отсутствующим рисунком, не выдаются обычным пользователям, видны только здесь.</div>
    ${rows}`);
}

async function render() {
  if (!A.session) { renderLogin(); return; }
  const route = parseHash();
  if (route.name === "users") {
    if (route.param) await screenUser(safeDecode(route.param));
    else await screenUsers();
  } else if (route.name === "audit") {
    await screenAudit();
  } else if (route.name === "inbox") {
    await screenInbox();
  } else if (route.name === "providers") {
    await screenProviders();
  } else if (route.name === "blocked") {
    await screenBlocked();
  } else {
    await screenDashboard();
  }
}

window.addEventListener("hashchange", render);

/* ---------------- старт ---------------- */

(async function init() {
  try {
    const probe = await fetch("/api/admin/session", { credentials: "same-origin" });
    if (probe.ok) {
      const data = await probe.json();
      A.session = { user: data.user, expiresAt: data.expiresAt };
    } else {
      A.session = null;
    }
  } catch (e) {
    A.session = null;
  }
  render();
})();
