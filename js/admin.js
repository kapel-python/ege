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
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l4 4 5-7 5 7 4-4v11H3z"/></svg>',
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

function navigate(path) {
  const next = `#${String(path || "").replace(/^#?\/?/, "")}`;
  // Тот же адрес не даёт события hashchange: без этого «добавить провайдера»
  // дважды подряд или возврат на себя же молча ничего не делали.
  if (location.hash === next) { render(); return; }
  location.hash = next;
}

/* ---------------- рендер-каркас ---------------- */

const SECTIONS = [
  { id: "dashboard", title: "Обзор", short: "Обзор", icon: "dashboard" },
  { id: "providers", title: "Провайдеры", short: "ИИ", icon: "cpu" },
  { id: "inbox", title: "Обращения", short: "Обращения", icon: "inbox" },
  { id: "users", title: "Пользователи", short: "Люди", icon: "users" },
  { id: "subscription", title: "Подписка", short: "Plus", icon: "crown" },
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
  toast("Сессия админки завершена");
}

/* ---------------- экран входа ---------------- */

function renderLogin(error = "") {
  A.root.innerHTML = `
    <div class="admin-login">
      <div class="admin-login__card">
        <span class="admin-login__mark">ege <em>easy</em></span>
        <div class="admin-login__title">Админ-панель</div>
        <div class="admin-login__sub">Закрытый раздел управления платформой. Введите админ-пароль — он проверяется только на сервере, сессия живёт 30 дней и привязана к твоему аккаунту.</div>
        <form class="admin-login__form" id="loginForm">
          <input class="a-input" type="password" id="pwInput" placeholder="Админ-пароль" autocomplete="current-password" autofocus required>
          ${error ? `<div class="admin-login__error" id="loginError">${esc(error)}</div>` : ""}
          <button class="btn btn--primary btn--lg" type="submit" id="loginBtn" style="justify-content:center">Войти</button>
          <div class="admin-login__hint">Текущий аккаунт: <span class="mono" id="whoami">проверяем…</span>.<br>Если нужно войти под другим аккаунтом — сначала выйди в основном приложении.</div>
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
      // Второй фактор: верный пароль создал заявку — сессия откроется,
      // только когда владелец нажмёт «Подтвердить» в Telegram.
      if (result && result.pending && result.pendingId) {
        renderPendingLogin(result.pendingId, result.code, result.expiresAt);
        return;
      }
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

/* ---------------- ожидание второго фактора ---------------- */

/* Заявка создана верным паролем: ждём решения владельца в Telegram.
   Опрос — раз в 2.5 с; кука ege_admin ставится ответом опроса (fetch с
   credentials), js её не видит и не хранит — как при обычном входе. */
function renderPendingLogin(pendingId, code, expiresAt) {
  stopPendingPoll();
  A.pendingLogin = { id: pendingId, code: code || "", expiresAt: Number(expiresAt) || 0 };
  A.root.innerHTML = `
    <div class="admin-login">
      <div class="admin-login__card">
        <span class="admin-login__mark">ege <em>easy</em></span>
        <div class="admin-login__title">Подтверди вход в Telegram</div>
        <div class="admin-login__sub">Пароль верный. Запрос с кодом <span class="mono" id="pendingCode">${esc(A.pendingLogin.code)}</span> уже у владельца — нажми «Подтвердить» в личном чате с ботом.</div>
        <div class="admin-login__error" id="pendingMsg" style="display:none"></div>
        <div style="font-size:13px;color:var(--muted)" id="pendingTimer"></div>
        <button class="btn btn--soft btn--lg" type="button" id="pendingCancel" style="justify-content:center">Отмена</button>
      </div>
    </div>`;
  document.getElementById("pendingCancel").onclick = cancelPendingLogin;
  // Таймер обратного отсчёта живёт отдельно от опроса: long-poll висит
  // до 20 с, а цифры должны тикать каждую секунду.
  paintPendingTimer();
  A.pendingTick = setInterval(() => {
    if (!A.pendingLogin) {
      if (A.pendingTick) { clearInterval(A.pendingTick); A.pendingTick = null; }
      return;
    }
    if (pendingLeftMs() <= 0) {
      pendingFailed("Время подтверждения вышло. Войди заново.");
      return;
    }
    paintPendingTimer();
  }, 1000);
  pollPendingLogin();
}

function stopPendingPoll() {
  if (A.pendingTimer) { clearTimeout(A.pendingTimer); A.pendingTimer = null; }
  if (A.pendingTick) { clearInterval(A.pendingTick); A.pendingTick = null; }
  if (A.pendingLogin && A.pendingLogin.ctrl) {
    try { A.pendingLogin.ctrl.abort(); } catch (e) {}
  }
  A.pendingLogin = null;
}

function pendingLeftMs() {
  if (!A.pendingLogin || !A.pendingLogin.expiresAt) return 0;
  return Math.max(0, A.pendingLogin.expiresAt - Date.now());
}

function paintPendingTimer() {
  const el = document.getElementById("pendingTimer");
  if (!el) return;
  const s = Math.ceil(pendingLeftMs() / 1000);
  el.textContent = s > 0
    ? `Осталось ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : "Время вышло";
}

async function pollPendingLogin() {
  // Long-poll цепочка: сервер держит запрос до события в Telegram (20 с),
  // ответ «pending» — сразу следующий запрос. Решение применяется в момент
  // нажатия кнопки, ждать тика не нужно.
  if (!A.pendingLogin) return;
  if (pendingLeftMs() <= 0) {
    pendingFailed("Время подтверждения вышло. Войди заново.");
    return;
  }
  const ctrl = new AbortController();
  A.pendingLogin.ctrl = ctrl;
  // Запас поверх серверных 20 с: висящий запрос не должен жить вечно.
  const guard = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 45000);
  try {
    const response = await fetch(`/api/admin/login/status?pending=${encodeURIComponent(A.pendingLogin.id)}`, {
      credentials: "same-origin",
      signal: ctrl.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload && payload.user) {
      // Владелец подтвердил: ответ уже поставил куку ege_admin.
      stopPendingPoll();
      A.session = { user: payload.user, expiresAt: payload.expiresAt };
      toast("Вход подтверждён");
      if (!location.hash) location.hash = "#/dashboard";
      render();
      return;
    }
    if (response.ok && payload && payload.pending) {
      if (payload.expiresAt) A.pendingLogin.expiresAt = Number(payload.expiresAt);
      pollPendingLogin();
      return;
    }
    if (response.status === 403) {
      pendingFailed("Вход отклонён владельцем.");
      return;
    }
    if (response.status === 410) {
      pendingFailed("Время подтверждения вышло. Войди заново.");
      return;
    }
    if (response.status === 404) {
      pendingFailed("Запрос не найден или уже использован. Войди заново.");
      return;
    }
    pendingNote(payload.error || "Ждём решения…");
  } catch (e) {
    pendingNote("Нет связи с сервером — пробуем снова…");
  } finally {
    clearTimeout(guard);
  }
  if (A.pendingLogin) A.pendingTimer = setTimeout(pollPendingLogin, 2500);
}

function pendingNote(text) {
  const el = document.getElementById("pendingMsg");
  if (el && text) { el.style.display = ""; el.textContent = text; }
}

function pendingFailed(text) {
  stopPendingPoll();
  A.root.innerHTML = `
    <div class="admin-login">
      <div class="admin-login__card">
        <span class="admin-login__mark">ege <em>easy</em></span>
        <div class="admin-login__title">Вход не подтверждён</div>
        <div class="admin-login__sub">${esc(text)}</div>
        <button class="btn btn--primary btn--lg" type="button" id="pendingBack" style="justify-content:center">Назад ко входу</button>
      </div>
    </div>`;
  document.getElementById("pendingBack").onclick = () => renderLogin();
}

async function cancelPendingLogin() {
  const id = A.pendingLogin ? A.pendingLogin.id : null;
  stopPendingPoll();
  if (id) {
    try {
      await AdminApi.post("/api/admin/login/cancel", { pending: id });
    } catch (e) { /* заявка и так протухнет сама */ }
  }
  renderLogin();
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

/* Подписка Plus в карточке: платная видна таблеткой в шапке, управление —
   карточкой внизу (там же, где «Доступ»). Бесплатному показывается только
   нижняя карточка с кнопкой выдачи. */
const SUB_CROWN = '<svg viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-0.15em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l4 4 5-7 5 7 4-4v11H3z"/></svg>';

function subIsActive(sub) { return !!(sub && sub.active); }

function subPill(sub) {
  if (!subIsActive(sub)) return "";
  const renewal = sub.cancelAtPeriodEnd ? " · без продления" : "";
  return `<span class="a-chip a-chip--accent" title="Подписка Plus активна до ${esc(fmtDateTime(sub.expiresAt))}">${SUB_CROWN} <span class="plus">Plus</span> · до ${esc(fmtDate(sub.expiresAt))}${renewal}</span>`;
}

function subStatusText(sub) {
  if (!sub || !sub.plan) return "нет";
  if (sub.active) return sub.status === "cancelled" ? "активна · без продления" : "активна";
  if (sub.status === "expired") return "истекла";
  if (sub.status === "cancelled") return "отменена";
  return sub.status || "нет";
}

function subPayChip(status) {
  const known = {
    succeeded: ["a-chip--success", "оплачено"],
    refunded: ["a-chip--warn", "возврат"],
    pending: ["a-chip--ghost", "ожидает"],
    failed: ["a-chip--danger", "не прошёл"],
    cancelled: ["a-chip--ghost", "отменён"],
  };
  const found = known[status] || ["a-chip--ghost", status || "—"];
  return `<span class="a-chip ${found[0]}">${esc(found[1])}</span>`;
}

/* Человеческая подпись провайдера платежа: manual — ручной грант,
   promo — активация промокодом (0 ₽), остальное — технический id шлюза. */
function payProviderLabel(provider) {
  if (provider === "manual") return "вручную";
  if (provider === "promo") return "промокод";
  return esc(provider || "");
}

function fmtMoney(kop) {
  return `${fmtNum((Number(kop) || 0) / 100)} ₽`;
}

function subCard(sub, payments) {
  const active = subIsActive(sub);
  const headSub = !sub || !sub.plan ? "бесплатный тариф"
    : active ? `<span class="plus">Plus</span> · до ${esc(fmtDate(sub.expiresAt))}` : `<span class="plus">Plus</span> · ${esc(subStatusText(sub))}`;
  // Срок — одной полосой, а не двумя колонками: даты «02.10.2026, 22:19»
  // в узкой колонке рвались посередине числа.
  const range = active ? (() => {
    const days = Math.round(((Number(sub.expiresAt) || 0) - (Number(sub.startedAt) || 0)) / 86400000);
    return `<div class="a-sub-range"><span class="a-sub-range__k">Срок</span><span class="a-sub-range__v">${fmtDateTime(sub.startedAt)} → ${fmtDateTime(sub.expiresAt)}</span>${Number.isFinite(days) && days > 0 ? `<span class="a-sub-range__days">· ${days} ${plural(days, "день", "дня", "дней")}</span>` : ""}</div>`;
  })() : "";
  const rows = active ? `
      <div class="a-kv">
        <div class="a-kv__item"><div class="a-kv__k">Статус</div><div class="a-kv__v" style="color:var(--success-ink);font-weight:600">${esc(subStatusText(sub))}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Период</div><div class="a-kv__v">${sub.period === "year" ? "год · 1590 ₽" : "месяц · 199 ₽"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Лимиты</div><div class="a-kv__v">${sub.limits && sub.limits.essay != null ? `${sub.limits.essay} проверок · ${sub.limits.agent} ходов в день` : "—"}</div></div>
      </div>${range}` : `
      <div style="font-size:13.5px;color:var(--text-2)">${sub && sub.plan
        ? `Была <span class="plus">Plus</span>, сейчас — ${esc(subStatusText(sub))}${sub.expiresAt ? ` (срок вышел ${esc(fmtDate(sub.expiresAt))})` : ""}. Бесплатный тариф: 5 проверок сочинений и 10 ходов ИИ в день.`
        : "Бесплатный тариф: 5 проверок сочинений и 10 ходов ИИ в день. Выдача открывает 10 проверок и 50 ходов ИИ в день сразу."}</div>`;
  // Платежи — стопкой строк, а не таблицей: таблица на телефоне уезжала
  // за край карточки (горизонтальный скролл внутри — не чтение).
  const history = (payments && payments.length) ? `
      <div class="a-card__head" style="margin-top:18px"><span class="a-card__title">Платежи</span><span class="a-card__sub">последние ${payments.length}</span></div>
      <div class="a-paylist">${payments.map((pm) => `
        <div class="a-payrow">
          <div class="a-payrow__main">
            <div class="a-payrow__t"><span class="plus">Plus</span> · ${pm.period === "year" ? "год" : "месяц"}</div>
            <div class="a-payrow__d">${fmtDateTime(pm.paidAt || pm.createdAt)} · ${payProviderLabel(pm.provider)}</div>
          </div>
          <div class="a-payrow__r"><span>${fmtMoney(pm.amountKopecks)}</span>${subPayChip(pm.status)}</div>
        </div>`).join("")}</div>` : "";
  const actions = active ? `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px">
        <button class="btn btn--soft btn--sm" id="subGrantBtn">Продлить…</button>
        <button class="btn btn--soft btn--sm" id="subRevokeBtn">Отменить доступ</button>
        <button class="btn btn--soft btn--sm" id="subRefundBtn">Возврат…</button>
      </div>` : `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px">
        <button class="btn btn--soft btn--sm" id="subGrantBtn">Выдать <span class="plus">Plus</span>…</button>
      </div>`;
  return `
    <div class="a-card" style="margin-top:16px;${active ? "border-color:var(--accent-ring)" : ""}">
      <div class="a-card__head"><span class="a-card__title">Подписка</span><span class="a-card__sub">${headSub}</span></div>
      ${rows}${history}${actions}
    </div>`;
}

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
            ${subPill(p.subscription)}
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

    ${subCard(p.subscription, p.subscriptionPayments)}

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
      <div class="a-modal__warn"><b>Подтверждение:</b> введи Account ID <span class="mono">${esc(p.accountId || "")}</span></div>
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
            : (p.goalOptions && p.goalOptions.length
              ? `<select class="a-select" id="fGoal">
            <option value="" ${!p.goal ? "selected" : ""}>Не выбрана</option>
            ${p.goalOptions.map((g) => `<option value="${esc(g.id)}" ${p.goal === g.id ? "selected" : ""}>${esc(g.label || g.id)}</option>`).join("")}
          </select>`
              : `<div class="a-empty" style="padding:12px 0;text-align:left">У этого предмета шкалы целей нет.</div>`)}
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
      <div class="a-modal__desc">Сейчас ученику доступно <b>${remaining} из ${limit}</b>${resetNote}. Каждые 8 часов возвращается примерно треть запаса, полный — за сутки.${customNote}</div>
      <div class="a-modal__form">
        <div class="a-field"><label>Доступно сейчас (0–1000)</label><input class="a-input mono" id="fAiRemaining" type="number" min="0" max="1000" step="1" value="${remaining}"></div>
        <div class="a-field"><label>Всего выдавать (пусто — не менять)</label><input class="a-input mono" id="fAiLimit" type="number" min="0" max="1000" step="1" placeholder="${limit}"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn btn--soft btn--sm" id="mRefill">Выдать все</button>
          <button type="button" class="btn btn--soft btn--sm" id="mZero">Забрать все</button>
          <button type="button" class="btn btn--soft btn--sm" id="mStd">Вернуть обычные 5</button>
        </div>
      </div>
      <div class="a-modal__desc" style="margin-top:18px">Ходы ИИ: доступно <b>${agRemaining} из ${agLimit}</b>${agReset}. Каждые 8 часов возвращается примерно треть запаса, полный — за сутки.${agCustomNote}</div>
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
                (agSt ? ` · ходов ИИ: ${agSt.remaining} из ${agSt.limit}` : ""));
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

  /* Подписка Plus: выдача/продление (один и тот же грант — срок
     складывается), отмена доступа и возврат. Кнопки рисуются карточкой
     подписки внизу экрана: платному — три, бесплатному — одна выдача. */
  const subPost = async (body, btn, okText) => {
    if (btn) btn.disabled = true;
    try {
      const res = await AdminApi.post(`/api/admin/users/${encodeURIComponent(ref)}/subscription`, body);
      closeModal();
      const sub = res.subscription || {};
      toast(`${okText}${sub.expiresAt ? ` до ${fmtDate(sub.expiresAt)}` : ""}`);
      reload();
    } catch (e) {
      if (btn) btn.disabled = false;
      if (e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
      const errBox = document.querySelector(".a-modal #mErr") || document.getElementById("mErr");
      if (errBox) errBox.innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      else toast(e.message, "err");
    }
  };

  const subGrantEl = document.getElementById("subGrantBtn");
  if (subGrantEl) subGrantEl.onclick = () => {
    const cur = p.subscription || {};
    const isExtend = subIsActive(cur);
    openModal(`
      <div class="a-modal__title">${isExtend ? 'Продлить <span class="plus">Plus</span>' : 'Выдать <span class="plus">Plus</span>'} — ${esc(p.accountId || "")}</div>
      <div class="a-modal__desc">${isExtend
        ? `Срок растянется от конца текущего (до ${esc(fmtDate(cur.expiresAt))}), а не перезапишется. Карманы лимитов дольются до полного.`
        : "Доступ откроется сразу на выбранный срок. Карманы лимитов дольются до полного: 10 проверок сочинений и 50 ходов ИИ в день."}</div>
      <div class="a-modal__form" style="gap:10px">
        <button class="choice-item" data-period="month"><b>Месяц — 199 ₽</b><span>1 календарный месяц доступа</span></button>
        <button class="choice-item" data-period="year"><b>Год — 1590 ₽</b><span>12 календарных месяцев доступа, −33% к помесячной оплате</span></button>
        <div class="a-field"><label>Заметка (необязательно)</label><input class="a-input" id="fSubNote" placeholder="например: победитель олимпиады" autocomplete="off"></div>
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions"><button class="btn btn--soft" id="mCancel">Отмена</button></div>`, (modal) => {
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelectorAll("[data-period]").forEach((periodBtn) => {
        /* Клик по сроку НИЧЕГО не выдаёт: второй шаг — ввод Account ID.
           Plus — самый дорогой товар проекта, и один промах здесь стоит
           подписки живому человеку (как удаление аккаунта и полный сброс,
           где защита та же). */
        periodBtn.onclick = () => openSubGrantConfirm({
          isExtend,
          cur,
          period: periodBtn.dataset.period,
          note: modal.querySelector("#fSubNote").value.trim(),
        });
      });
    });
  };

  function openSubGrantConfirm(opts) {
    const perName = opts.period === "year" ? "год" : "месяц";
    const perText = opts.period === "year" ? "12 календарных месяцев" : "1 календарный месяц";
    openModal(`
      <div class="a-modal__title">${opts.isExtend ? 'Продлить <span class="plus">Plus</span>' : 'Выдать <span class="plus">Plus</span>'} на ${perName}?</div>
      <div class="a-modal__desc">${opts.isExtend
        ? `Срок растянется от конца текущего (до ${esc(fmtDate(opts.cur.expiresAt))}), а не перезапишется.`
        : "Доступ откроется сразу на выбранный срок."} ${perText}, карманы лимитов дольются до полного.${opts.note ? ` Повод: ${esc(opts.note)}.` : ""} Запись попадёт в журнал и в историю платежей получателя (грант 0 ₽).</div>
      <div class="a-modal__form">
        <div class="a-modal__warn"><b>Подтверждение:</b> введи Account ID <span class="mono">${esc(ref)}</span></div>
        <input class="a-input mono" id="fSubConfirm" placeholder="${esc(ref)}" autocomplete="off" spellcheck="false">
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions">
        <button class="btn btn--soft" id="mCancel">Отмена</button>
        <button class="btn btn--primary" id="mDo" disabled>${opts.isExtend ? "Продлить" : "Выдать"} на ${perName}</button>
      </div>`, (modal) => {
      const input = modal.querySelector("#fSubConfirm");
      const doBtn = modal.querySelector("#mDo");
      modal.querySelector("#mCancel").onclick = closeModal;
      input.oninput = () => { doBtn.disabled = input.value.trim() !== ref; };
      input.focus();
      doBtn.onclick = (ev) => {
        if (input.value.trim() !== ref) return;
        subPost({ action: "grant", period: opts.period, note: opts.note }, ev.target,
                opts.isExtend ? "Plus продлён" : "Plus выдан");
      };
    });
  }

  const subRevokeEl = document.getElementById("subRevokeBtn");
  if (subRevokeEl) subRevokeEl.onclick = () => {
    openModal(`
      <div class="a-modal__title" style="color:var(--danger)">Отменить доступ <span class="plus">Plus</span> — ${esc(p.accountId || "")}?</div>
      <div class="a-modal__desc">Доступ закроется <b>сразу</b>, лимиты вернутся к бесплатным (5 проверок, 10 ходов ИИ в день). История платежей сохранится — деньги в аудите останутся как доход. Для возврата денег есть отдельное действие «Возврат».</div>
      <div class="a-modal__actions">
        <button class="btn btn--soft" id="mCancel">Отмена</button>
        <button class="btn btn--danger-soft" id="mDo">Отменить доступ</button>
      </div>`, (modal) => {
      modal.classList.add("a-modal--danger");
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelector("#mDo").onclick = (ev) => subPost({ action: "revoke" }, ev.target, "Доступ Plus отменён");
    });
  };

  const subRefundEl = document.getElementById("subRefundBtn");
  if (subRefundEl) subRefundEl.onclick = () => {
    const succeeded = (p.subscriptionPayments || []).filter((pm) => pm.status === "succeeded");
    if (!succeeded.length) { toast("Возвращать нечего: успешных платежей нет", "err"); return; }
    const options = succeeded.map((pm) => `
      <button class="choice-item" data-payment="${pm.id}"><b>${fmtMoney(pm.amountKopecks)} · ${pm.period === "year" ? "год" : "месяц"}</b><span>${fmtDateTime(pm.paidAt || pm.createdAt)} · ${payProviderLabel(pm.provider)}</span></button>`).join("");
    openModal(`
      <div class="a-modal__title" style="color:var(--danger)">Возврат — ${esc(p.accountId || "")}</div>
      <div class="a-modal__desc">Платёж пометится как возвращённый навсегда, доступ <span class="plus">Plus</span> закроется сразу. Повторно вернуть тот же платёж нельзя.</div>
      <div class="a-modal__form" style="gap:10px">
        ${options}
        <div id="mErr"></div>
      </div>
      <div class="a-modal__actions"><button class="btn btn--soft" id="mCancel">Отмена</button></div>`, (modal) => {
      modal.classList.add("a-modal--danger");
      modal.querySelector("#mCancel").onclick = closeModal;
      modal.querySelectorAll("[data-payment]").forEach((btn) => {
        btn.onclick = () => subPost({ action: "refund", paymentId: Number(btn.dataset.payment) }, btn, "Возврат оформлен");
      });
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

/* ---------------- Журнал действий ----------------
   Лента вместо сырой таблицы: группировка по дням, фильтр по смыслу
   (Входы / Пользователи / Подписка / Провайдеры / Обращения), поиск по
   тексту и человеческие расшифровки деталей вместо сырого detail.
   Карточка — кнопка целиком: клик открывает полную расшифровку в общей
   модалке админки (openModal — та же система, что остальные окна раздела).
   Неизвестное действие рисуется сырым кодом, а не пустотой — иначе новая
   запись бэкенда молча исчезла бы из ленты. Покрытие меток проверяет
   test/audit-log.py: каждое действие из server.py обязано иметь запись
   в AUDIT_ACTIONS, расшифровку в AUDIT_DETAIL и строки в AUDIT_ROWS. */

const AUDIT_CATS = [
  { id: "all", label: "Все" },
  { id: "login", label: "Входы" },
  { id: "users", label: "Пользователи" },
  { id: "plus", label: "Подписка" },
  { id: "providers", label: "Провайдеры" },
  { id: "inbox", label: "Обращения" },
];

// Действие -> [категория, подпись, класс чипа].
const AUDIT_ACTIONS = {
  "admin-login": ["login", "Вход в админку", "a-chip--accent"],
  "admin-login-pending": ["login", "Запрос входа", "a-chip--warn"],
  "admin-login-approved": ["login", "Вход подтверждён", "a-chip--success"],
  "admin-login-denied": ["login", "Вход отклонён", "a-chip--danger"],
  "admin-login-expired": ["login", "Заявка истекла", ""],
  "admin-login-cancelled": ["login", "Заявка отозвана", ""],
  "admin-logout": ["login", "Выход", ""],
  "grant-xp": ["users", "Корректировка XP", "a-chip--warn"],
  reset: ["users", "Сброс", "a-chip--warn"],
  "update-profile": ["users", "Правка профиля", ""],
  "delete-user": ["users", "Удаление аккаунта", "a-chip--danger"],
  "block-user": ["users", "Блокировка", "a-chip--danger"],
  "unblock-user": ["users", "Разблокировка", "a-chip--success"],
  "ai-limit": ["users", "Лимиты ИИ", ""],
  "subscription-grant": ["plus", "Plus выдан", "a-chip--success"],
  "subscription-revoke": ["plus", "Доступ отозван", "a-chip--danger"],
  "subscription-refund": ["plus", "Возврат", "a-chip--warn"],
  "subscription-waitlist-grant": ["plus", "Plus очереди", "a-chip--success"],
  "subscription-bonus": ["plus", "Plus списку", "a-chip--success"],
  "promo-create": ["plus", "Промокод создан", "a-chip--success"],
  "promo-toggle": ["plus", "Промокод вкл/выкл", ""],
  "promo-delete": ["plus", "Промокод удалён", "a-chip--danger"],
  "providers.judge": ["providers", "Судья назначен", "a-chip--accent"],
  "ai-provider-create": ["providers", "Провайдер добавлен", "a-chip--success"],
  "ai-provider-slots": ["providers", "Приоритеты", ""],
  "ai-provider-reset": ["providers", "Сброс провайдера", "a-chip--warn"],
  "ai-provider-models": ["providers", "Цепочка моделей", ""],
  "ai-provider-apply": ["providers", "Настройки провайдера", ""],
  "ai-provider-update": ["providers", "Правка провайдера", ""],
  "ai-provider-delete": ["providers", "Провайдер удалён", "a-chip--danger"],
  "ai-provider-restore": ["providers", "Провайдер восстановлен", "a-chip--success"],
  "support-read": ["inbox", "Обращение прочитано", ""],
};

function auditActionOf(e) {
  // Запасной путь для будущих действий бэкенда: сырой код виден только
  // во вкладке «Все», а не пустотой (покрытие — в test/audit-log.py).
  return AUDIT_ACTIONS[e.action] || ["all", String(e.action || "—"), ""];
}

const AUDIT_RESET_LABELS = {
  "all-progress": "весь прогресс",
  streak: "серия",
  errors: "ошибки",
  daily: "подборка",
  forecast: "прогноз",
};

function auditRub(kop) {
  const n = Number(kop);
  if (!Number.isFinite(n)) return "";
  return `${(n / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function auditCode(short) {
  const t = String(short || "").toUpperCase();
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4)}` : t;
}

function auditPendingDetail(detail) {
  // "SHORT ip" -> "код XXXX-XXXX · 1.2.3.4".
  const parts = String(detail || "").split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return `код ${auditCode(parts[0])}${parts[1] ? ` · ${parts[1]}` : ""}`;
}

function auditCompactPairs(detail) {
  // {"high":"x","medium":"y"} -> "high: x · medium: y", не длиннее ~140 знаков.
  try {
    const obj = JSON.parse(detail);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    const text = Object.entries(obj).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(" · ");
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  } catch (e) { return ""; }
}

// Расшифровка сырого detail в человеческую строку. Пусто — строки деталей
// нет вовсе; нераспознанное показывает карточка сырым текстом, а не пустотой.
const AUDIT_DETAIL = {
  "admin-login": () => "",
  "admin-logout": () => "",
  "admin-login-pending": (e) => auditPendingDetail(e.detail),
  "admin-login-approved": (e) => auditPendingDetail(e.detail),
  "admin-login-denied": (e) => auditPendingDetail(e.detail),
  "admin-login-expired": (e) => auditPendingDetail(e.detail),
  "admin-login-cancelled": () => "",
  "grant-xp": (e) => {
    const m = String(e.detail || "").match(/^\s*([+-]?\d+)\s*(.*)$/);
    if (!m) return "";
    return `${m[1]} XP${m[2] ? ` · ${m[2]}` : ""}`;
  },
  reset: (e) => AUDIT_RESET_LABELS[String(e.detail || "").trim()] || "",
  "update-profile": (e) => {
    try {
      const obj = JSON.parse(e.detail || "");
      if (!obj || typeof obj !== "object") return "";
      const parts = [];
      if (obj.name) parts.push(`имя «${obj.name}»`);
      if (obj.selfLevel) parts.push(LEVEL_LABELS[obj.selfLevel] || obj.selfLevel);
      if (obj.goal) parts.push(GOAL_LABELS[obj.goal] || obj.goal);
      return parts.join(" · ");
    } catch (err) { return ""; }
  },
  "delete-user": (e) => (e.detail ? `аккаунт ${e.detail}` : ""),
  "block-user": (e) => {
    // "1d причина" / "permanent причина".
    const parts = String(e.detail || "").split(/\s+/).filter(Boolean);
    const dur = BLOCK_DURATIONS.find((d) => d.id === parts[0]);
    if (!dur) return "";
    const date = dur.secs == null ? "навсегда" : `до ${fmtDateTime(Number(e.ts) + dur.secs * 1000)}`;
    const reason = parts.slice(1).join(" ");
    return `${dur.title} · ${date}${reason ? ` · ${reason}` : ""}`;
  },
  "unblock-user": () => "",
  "ai-limit": (e) => {
    // "limit=5 remaining=3 agent: limit=10 remaining=7".
    const m = String(e.detail || "").match(/limit=(\d+)\s+remaining=(\d+)/);
    if (!m) return "";
    const agent = String(e.detail || "").split("agent:")[1] || "";
    const am = agent.match(/limit=(\d+)\s+remaining=(\d+)/);
    return `Сочинения — лимит ${m[1]}, остаток ${m[2]}`
      + (am ? `; ИИ — лимит ${am[1]}, остаток ${am[2]}` : "");
  },
  "subscription-grant": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+until\s+(\d+)/);
    if (!m) return "";
    return `Plus на ${m[1] === "year" ? "год" : "месяц"} · до ${fmtDateTime(Number(m[2]))}`;
  },
  "subscription-revoke": () => "доступ закрыт сразу",
  "subscription-refund": (e) => {
    const m = String(e.detail || "").match(/payment=(\S+)\s+(\d+)/);
    if (!m) return "";
    return `возврат ${auditRub(m[2])} · платёж ${m[1]}`;
  },
  "subscription-waitlist-grant": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+x(\d+)/);
    if (!m) return "";
    const n = Number(m[2]);
    return `Plus на ${m[1] === "year" ? "год" : "месяц"} × ${n} ${plural(n, "человек", "человека", "человек")}`;
  },
  "subscription-bonus": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+x(\d+)\s*(.*)$/);
    if (!m) return "";
    const n = Number(m[2]);
    return `Plus на ${m[1] === "year" ? "год" : "месяц"} × ${n}${m[3] ? ` · ${m[3]}` : ""}`;
  },
  "promo-create": (e) => {
    const m = String(e.detail || "").match(/^(\S+)\s+(percent|fixed)\s+(\S+)/);
    if (!m) return "";
    const size = m[2] === "percent" ? `−${m[3]}%` : `−${auditRub(Number(m[3]) || 0)}`;
    return `код ${m[1]} · ${size}`;
  },
  "promo-toggle": (e) => {
    const m = String(e.detail || "").match(/^(\S+)\s+(on|off)/);
    if (!m) return "";
    return `код ${m[1]} ${m[2] === "on" ? "включён" : "выключен"}`;
  },
  "promo-delete": (e) => {
    const code = String(e.detail || "").trim();
    return code ? `код ${code}` : "";
  },
  "providers.judge": (e) => {
    const text = String(e.detail || "").replace(/\s*\[Plus\]$/, "");
    return text ? `судья: ${text}` : "";
  },
  "ai-provider-create": (e) => auditProviderDetail(e.detail),
  "ai-provider-reset": (e) => auditProviderDetail(e.detail),
  "ai-provider-apply": (e) => auditProviderDetail(e.detail),
  "ai-provider-update": (e) => auditProviderDetail(e.detail),
  "ai-provider-delete": (e) => auditProviderDetail(e.detail),
  "ai-provider-restore": (e) => auditProviderDetail(e.detail),
  "ai-provider-slots": (e) => auditCompactPairs(String(e.detail || "").replace(/\s*\[Plus\]$/, "")),
  "ai-provider-models": (e) => auditCompactPairs(String(e.detail || "").replace(/\s*\[Plus\]$/, "")),
  "support-read": (e) => {
    const m = String(e.detail || "").match(/message\s+(\d+)/);
    return m ? `обращение № ${m[1]}` : "";
  },
};

function auditProviderDetail(detail) {
  // "pid [Plus]" -> "«pid»" (таблетка Plus рисуется отдельно).
  return String(detail || "").replace(/\s*\[Plus\]$/, "").trim();
}

function auditDayLabel(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return fmtShortDate(iso);
}

function auditCardHTML(e) {
  const entry = auditActionOf(e);
  const label = entry[1];
  const cls = entry[2];
  const human = (AUDIT_DETAIL[e.action] || (() => ""))(e);
  const raw = String(e.detail || "");
  const plus = / \[Plus\]$/.test(raw);
  const me = A.session?.user?.id;
  const actor = e.actorAccount
    ? `<span class="mono">${esc(e.actorAccount)}</span>${e.actorId === me ? " (ты)" : ""}`
    : "—";
  const target = e.targetAccount
    ? `<span class="mono">${esc(e.targetAccount)}</span>${e.targetId === me ? " (ты)" : ""}`
    : (e.targetId ? `id ${e.targetId} (удалён)` : "—");
  const id = Number(e.id) || 0;
  return `<button type="button" class="a-audit a-audit--btn" onclick="openAuditDetail(${id})"
      aria-label="${esc(`${label}: ${human || label}`)}">
    <div class="a-audit__head">
      <span class="a-chip ${cls}">${esc(label)}</span>
      ${plus ? `<span class="a-chip a-chip--accent">Plus</span>` : ""}
      <span class="a-audit__time">${esc(fmtDateTime(e.ts))}</span>
    </div>
    <div class="a-audit__text">${esc(human || label)}</div>
    <div class="a-audit__meta">${actor}<span class="a-audit__arrow">→</span>${target}</div>
    ${human || !raw ? "" : `<div class="a-audit__raw mono">${esc(raw)}</div>`}
  </button>`;
}

/* Подробные строки для модалки: действие -> [[подпись, значение]].
   Та же человеческая расшифровка, что в AUDIT_DETAIL, но разложенная по
   строкам; общих «Кто / Кому / Когда» здесь нет — их добавляет модалка. */
function auditPendingRows(detail) {
  const parts = String(detail || "").split(/\s+/).filter(Boolean);
  const rows = [];
  if (parts[0]) rows.push(["Код", auditCode(parts[0])]);
  if (parts[1]) rows.push(["IP", parts[1]]);
  return rows;
}

function auditPairsRows(detail) {
  // Цепочки моделей и приоритеты: {"high":"x",...} -> строки по слотам.
  try {
    const obj = JSON.parse(detail);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    return Object.entries(obj).slice(0, 4).map(([k, v]) => [PROV_SLOT_LABELS[k] || k, String(v)]);
  } catch (e) { return []; }
}

const AUDIT_ROWS = {
  "admin-login": () => [],
  "admin-logout": () => [],
  "admin-login-pending": (e) => auditPendingRows(e.detail),
  "admin-login-approved": (e) => auditPendingRows(e.detail),
  "admin-login-denied": (e) => auditPendingRows(e.detail),
  "admin-login-expired": (e) => auditPendingRows(e.detail),
  "admin-login-cancelled": () => [],
  "grant-xp": (e) => {
    const m = String(e.detail || "").match(/^\s*([+-]?\d+)\s*(.*)$/);
    if (!m) return [];
    const rows = [["Изменение", `${m[1]} XP`]];
    if (m[2]) rows.push(["Причина", m[2]]);
    return rows;
  },
  reset: (e) => [["Сброшено", AUDIT_RESET_LABELS[String(e.detail || "").trim()] || String(e.detail || "")]],
  "update-profile": (e) => {
    try {
      const obj = JSON.parse(e.detail || "");
      if (!obj || typeof obj !== "object") return [];
      const rows = [];
      if (obj.name) rows.push(["Имя", obj.name]);
      if (obj.selfLevel) rows.push(["Самооценка", LEVEL_LABELS[obj.selfLevel] || obj.selfLevel]);
      if (obj.goal) rows.push(["Цель", GOAL_LABELS[obj.goal] || obj.goal]);
      return rows;
    } catch (err) { return []; }
  },
  "delete-user": (e) => (e.detail ? [["Аккаунт", String(e.detail)]] : []),
  "block-user": (e) => {
    const parts = String(e.detail || "").split(/\s+/).filter(Boolean);
    const dur = BLOCK_DURATIONS.find((d) => d.id === parts[0]);
    if (!dur) return [];
    const rows = [["Срок", dur.title]];
    rows.push(["До", dur.secs == null ? "навсегда" : fmtDateTime(Number(e.ts) + dur.secs * 1000)]);
    const reason = parts.slice(1).join(" ");
    if (reason) rows.push(["Причина", reason]);
    return rows;
  },
  "unblock-user": () => [],
  "ai-limit": (e) => {
    const m = String(e.detail || "").match(/limit=(\d+)\s+remaining=(\d+)/);
    if (!m) return [];
    const rows = [["Сочинения", `лимит ${m[1]} · остаток ${m[2]}`]];
    const agent = String(e.detail || "").split("agent:")[1] || "";
    const am = agent.match(/limit=(\d+)\s+remaining=(\d+)/);
    if (am) rows.push(["ИИ", `лимит ${am[1]} · остаток ${am[2]}`]);
    return rows;
  },
  "subscription-grant": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+until\s+(\d+)/);
    if (!m) return [];
    return [["Срок", m[1] === "year" ? "год" : "месяц"], ["До", fmtDateTime(Number(m[2]))]];
  },
  "subscription-revoke": () => [["Режим", "доступ закрыт сразу"]],
  "subscription-refund": (e) => {
    const m = String(e.detail || "").match(/payment=(\S+)\s+(\d+)/);
    if (!m) return [];
    return [["Сумма", auditRub(m[2])], ["Платёж", m[1]]];
  },
  "subscription-waitlist-grant": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+x(\d+)/);
    if (!m) return [];
    const n = Number(m[2]);
    return [["Срок", m[1] === "year" ? "год" : "месяц"],
      ["Получили", `${n} ${plural(n, "человек", "человека", "человек")}`]];
  },
  "subscription-bonus": (e) => {
    const m = String(e.detail || "").match(/^(month|year)\s+x(\d+)\s*(.*)$/);
    if (!m) return [];
    const n = Number(m[2]);
    const rows = [["Срок", m[1] === "year" ? "год" : "месяц"],
      ["Получили", `${n} ${plural(n, "человек", "человека", "человек")}`]];
    if (m[3]) rows.push(["Повод", m[3]]);
    return rows;
  },
  "promo-create": (e) => {
    const m = String(e.detail || "").match(/^(\S+)\s+(percent|fixed)\s+(\S+)/);
    if (!m) return [];
    const size = m[2] === "percent" ? `−${m[3]}%` : `−${auditRub(Number(m[3]) || 0)}`;
    return [["Код", m[1]], ["Скидка", size]];
  },
  "promo-toggle": (e) => {
    const m = String(e.detail || "").match(/^(\S+)\s+(on|off)/);
    if (!m) return [];
    return [["Код", m[1]], ["Состояние", m[2] === "on" ? "включён" : "выключен"]];
  },
  "promo-delete": (e) => {
    const code = String(e.detail || "").trim();
    return code ? [["Код", code]] : [];
  },
  "providers.judge": (e) => {
    const text = String(e.detail || "").replace(/\s*\[Plus\]$/, "");
    if (!text) return [];
    const parts = text.split("→").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) return [["Было", parts[0]], ["Стало", parts[1]]];
    return [["Судья", text]];
  },
  "ai-provider-create": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-reset": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-apply": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-update": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-delete": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-restore": (e) => (auditProviderDetail(e.detail) ? [["Провайдер", auditProviderDetail(e.detail)]] : []),
  "ai-provider-slots": (e) => auditPairsRows(String(e.detail || "").replace(/\s*\[Plus\]$/, "")),
  "ai-provider-models": (e) => auditPairsRows(String(e.detail || "").replace(/\s*\[Plus\]$/, "")),
  "support-read": (e) => {
    const m = String(e.detail || "").match(/message\s+(\d+)/);
    return m ? [["Обращение", `№ ${m[1]}`]] : [];
  },
};

function auditModalRows(e) {
  const fn = AUDIT_ROWS[e.action];
  if (fn) return fn(e) || [];
  // Будущее действие без разбора: данные видны, но подписаны.
  const rows = [["Действие", String(e.action || "—")]];
  if (e.detail) rows.push(["Данные", String(e.detail)]);
  return rows;
}

/* Детали записи в общей модалке админки: вся информация человеческим
   языком, сырых кодов нет (кроме будущих действий — там разбирать нечего).
   Переход к пользователю — кнопкой внутри: ссылка в карточке-кнопке
   ломала бы разметку вложенным интерактивом. */
function openAuditDetail(id) {
  const e = (A.auditById || {})[Number(id)];
  if (!e) return;
  const info = auditActionOf(e);
  const cat = (AUDIT_CATS.find((c) => c.id === info[0]) || {}).label || info[1];
  const rows = auditModalRows(e).slice();
  const me = A.session?.user?.id;
  const actor = e.actorAccount
    ? `${e.actorAccount}${e.actorId === me ? " (ты)" : ""}` : "—";
  const target = e.targetAccount
    ? `${e.targetAccount}${e.targetId === me ? " (ты)" : ""}`
    : (e.targetId ? `id ${e.targetId} (удалён)` : "—");
  if (/ \[Plus\]$/.test(String(e.detail || ""))) rows.push(["Направление", "Plus"]);
  rows.push(["Кто", actor], ["Кому", target], ["Когда", fmtDateTime(e.ts)]);
  const hasTarget = !!e.targetAccount;
  openModal(`
    <div class="a-modal__title">${esc(info[1])}</div>
    <div class="a-modal__desc">${esc(cat)} · ${esc(fmtDateTime(e.ts))}</div>
    <div class="a-modal__form"><div class="a-kv">
      ${rows.map(([k, v]) => `<div class="a-kv__item"><div class="a-kv__k">${esc(k)}</div><div class="a-kv__v">${esc(v)}</div></div>`).join("")}
    </div></div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mClose">Закрыть</button>
      ${hasTarget ? `<button class="btn btn--primary" id="mUser">Открыть пользователя</button>` : ""}
    </div>`, (modal) => {
    modal.querySelector("#mClose").onclick = closeModal;
    if (hasTarget) {
      modal.querySelector("#mUser").onclick = () => {
        closeModal();
        location.hash = `#/users/${encodeURIComponent(e.targetAccount)}`;
      };
    }
  });
}

function auditTab() {
  try {
    const v = localStorage.getItem("ege_admin_audit_tab");
    if (v && AUDIT_CATS.some((c) => c.id === v)) return v;
  } catch (e) {}
  return "all";
}

function auditFiltered(entries, tab, q) {
  const needle = String(q || "").trim().toLowerCase();
  return entries.filter((e) => {
    const entry = auditActionOf(e);
    if (tab !== "all" && entry[0] !== tab) return false;
    if (!needle) return true;
    const hay = [entry[1], e.action, e.detail, e.actorAccount, e.targetAccount]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

async function screenAudit() {
  renderShell("audit", `<div class="a-skeleton" style="height:300px"></div>`);
  let entries;
  try {
    entries = (await AdminApi.get("/api/admin/audit")).entries || [];
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    renderShell("audit", `<div class="a-error-banner">Не удалось загрузить журнал: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  renderShell("audit", `
    <div class="a-toolbar">
      <input class="a-input" id="auditSearch" placeholder="Поиск: действие, детали, аккаунт…" value="${esc(A.lastAuditQuery || "")}">
      <span class="a-seg a-seg--wrap" role="group" aria-label="Категория действий">
        ${AUDIT_CATS.map((c) => `<button class="a-seg__btn${c.id === auditTab() ? " a-seg__btn--active" : ""}" data-audit-tab="${c.id}">${esc(c.label)}</button>`).join("")}
      </span>
      <span class="spacer"></span>
      <span class="a-card__sub" id="auditCount"></span>
    </div>
    <div id="auditList"></div>`);
  const input = document.getElementById("auditSearch");
  input.addEventListener("input", () => {
    A.lastAuditQuery = input.value;
    drawAuditList(entries);
  });
  document.querySelectorAll("#adminScreen [data-audit-tab]").forEach((btn) => {
    btn.onclick = () => {
      try { localStorage.setItem("ege_admin_audit_tab", btn.dataset.auditTab); } catch (err) {}
      document.querySelectorAll("#adminScreen [data-audit-tab]").forEach((b) => {
        b.classList.toggle("a-seg__btn--active", b.dataset.auditTab === btn.dataset.auditTab);
      });
      drawAuditList(entries);
    };
  });
  drawAuditList(entries);
}

/* Лента группируется по дням (записи уже идут от новых к старым).
   Поиск и вкладка фильтруют загруженные 200 записей локально — сервер
   отдаёт тот же срез, что раньше показывала таблица. */
function drawAuditList(entries) {
  const list = document.getElementById("auditList");
  if (!list) return;
  const tab = auditTab();
  const found = auditFiltered(entries, tab, A.lastAuditQuery || "");
  // Карточки открывают модалку по id: держим карту показанных записей.
  A.auditById = {};
  found.forEach((e) => { A.auditById[Number(e.id) || 0] = e; });
  const count = document.getElementById("auditCount");
  if (count) count.textContent = `${found.length} из ${entries.length}`;
  if (!found.length) {
    const hint = tab === "all" && !(A.lastAuditQuery || "").trim()
      ? ["Журнал пуст", "Здесь появятся все админ-действия: входы, пользователи, подписка, провайдеры"]
      : ["Ничего не нашлось", "Попробуй другую вкладку или поисковый запрос"];
    list.innerHTML = `<div class="a-card"><div class="a-empty">
      <div class="a-empty__icon">${aicon("audit")}</div>
      <div class="a-empty__title">${hint[0]}</div>
      <div class="a-empty__sub">${hint[1]}</div>
    </div></div>`;
    return;
  }
  const groups = [];
  found.forEach((e) => {
    const key = new Date(Number(e.ts));
    const day = Number.isNaN(key.getTime()) ? "—" : key.toDateString();
    if (!groups.length || groups[groups.length - 1].day !== day) {
      groups.push({ day, label: auditDayLabel(e.ts), items: [] });
    }
    groups[groups.length - 1].items.push(e);
  });
  list.innerHTML = groups.map((g) => `
    <div class="a-msg-group">
      <div class="a-msg-group__head">
        <span class="a-chip">${esc(g.label)}</span>
        <span class="a-msg-group__count">${fmtNum(g.items.length)}</span>
      </div>
      ${g.items.map(auditCardHTML).join("")}
    </div>`).join("");
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
  // Направление раздела: free — обычные пользователи, plus — подписка Plus.
  // У каждого свой полный конфиг (провайдеры, очередь, судья), вкладки
  // одинаковы по функционалу. Переживает перезагрузку, чтобы глубокая ссылка
  // на страницу провайдера открывалась в том же направлении.
  tier: (function () {
    try { return localStorage.getItem("ege_admin_prov_tier") === "plus" ? "plus" : "free"; }
    catch (_) { return "free"; }
  })(),
};

/* Тир текущего направления во все запросы раздела: GET — query, POST/PUT —
   поле тела. DELETE тела обычно не несёт — ему query собирается на месте. */
function provTier() { return Prov.tier === "plus" ? "plus" : "free"; }
function provTierQS() { return "?tier=" + provTier(); }
function provTierBody(obj) {
  const out = Object.assign({}, obj || {});
  out.tier = provTier();
  return out;
}
function setProvTier(tier) {
  Prov.tier = tier === "plus" ? "plus" : "free";
  try { localStorage.setItem("ege_admin_prov_tier", Prov.tier); } catch (_) {}
  // Вкладка — это другое направление целиком: список перечитываем, раздел
  // перерисовываем (иначе подсветка таба врёт), а открытую страницу
  // провайдера пересобираем из новых данных — или честно показываем
  // «не найден», если в этом направлении его нет. Черновик несохранённых
  // правок при смене направления теряется, как при уходе со страницы.
  screenProviders(true).then(() => {
    try { drawProviders(); } catch (_) {}
    try {
      const h = String(location.hash || "");
      if (h.startsWith("#/providers/")) render();
    } catch (_) {}
  });
}

/* Состояние СТРАНИЦЫ одного провайдера (#/providers/<id>). Держим отдельно от
   Prov: список провайдеров и настройка одного — разные экраны, и раньше их
   состояние жило в одном объекте модалки, из-за чего перерисовка списка
   сбрасывала открытую панель. */
const ProvDetail = {
  id: null,
  data: null,        // карточка провайдера (свежая из overview)
  models: null,      // {models, total, current, latencyMs, truncated}
  loading: false,    // грузится список моделей
  probing: false,    // идёт проверка одной модели
  pinging: false,    // идёт живой пинг моделей
  model: null,       // выбранная в поле модель
  error: null,
  verdict: "",       // вердикт проверки/применения (в DOM его терять нельзя)
  ping: null,        // состояние живого пинга: results/order/okCount/done
  current: { model: "", modelTitle: "" },  // что уже сохранено на сервере
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

/* Шаблон протокола API: два стандартных формата, а не причуда одного шлюза.
   OpenAI — классический chat/completions; Responses API — собственный новый
   протокол самого OpenAI (инструкции + input, ответ массивом output[]), его же
   отдают Azure и ряд шлюзов. Выбор шаблона меняет, какие поля видит форма:
   effort — всегда (уровень мышления универсален), заголовки — только у
   Responses, подклейка system — только у OpenAI (в responses system едет
   полем instructions и подклеивать нечего). */
const PROV_PROTOCOLS = [
  { id: "chat", label: "OpenAI", hint: "chat/completions — обычный формат" },
  { id: "responses", label: "Responses API", hint: "responses — новый формат OpenAI" },
  { id: "anthropic", label: "Anthropic", hint: "messages — формат Claude, ключ в x-api-key" },
];
function provProtoOf(id) {
  return PROV_PROTOCOLS.some((p) => p.id === id) ? id : "chat";
}
function provProtoLabel(id) {
  const f = PROV_PROTOCOLS.find((p) => p.id === provProtoOf(id));
  return f ? f.label : "OpenAI";
}
/* Уровень мышления reasoning-модели — выбором, а не текстом: свободная строка
   здесь давала бы опечатки, которые сервер резал бы 400-й уже после нажатия.
   Пусто («Стандарт») = default шлюза, поле в запрос не едет вовсе. */
const PROV_EFFORTS = [
  { id: "", label: "Стандарт", hint: "как решит шлюз" },
  { id: "minimal", label: "Минимальный", hint: "дешевле всего" },
  { id: "low", label: "Низкий", hint: "чуть глубже" },
  { id: "medium", label: "Средний", hint: "середина" },
  { id: "high", label: "Высокий", hint: "полное мышление" },
];
function provEffortLabel(id) {
  const f = PROV_EFFORTS.find((x) => (x.id || "") === (id || ""));
  return f ? f.label : (id || "Стандарт");
}
/* Сегмент шаблона протокола: тем же .a-seg2, что приоритет, — кнопки с
   подписью и пояснением, видно сразу оба формата. */
function provProtoSegHTML(current, onclick) {
  const cur = provProtoOf(current);
  return `<div class="a-seg2 a-seg2--3" role="group" aria-label="Протокол API провайдера">
    ${PROV_PROTOCOLS.map((s) => `<button type="button" class="a-seg2__btn${s.id === cur ? " a-seg2__btn--on" : ""}"
        data-proto="${s.id}" onclick="${onclick}('${s.id}')" title="${esc(s.hint)}">
      ${esc(s.label)}<span class="a-seg2__hint">${esc(s.hint)}</span>
    </button>`).join("")}
  </div>`;
}
/* Сегмент мышления: пять состояний, тот же .a-seg2 (на телефоне сложится
   2+2+1 сам — у компонента уже есть такой брейкпоинт). Пояснение — одной
   строкой под сегментом, а не в каждой кнопке: пять хинтов в кнопках не
   читались бы и на десктопе. */
function provEffortSegHTML(current, onclick) {
  const cur = (current || "").toLowerCase();
  return `<div class="a-seg2" role="group" aria-label="Уровень мышления модели">
    ${PROV_EFFORTS.map((s) => `<button type="button" class="a-seg2__btn${(s.id || "") === cur ? " a-seg2__btn--on" : ""}"
        data-effort="${esc(s.id)}" onclick="${onclick}('${esc(s.id)}')" title="${esc(s.hint)}">
      ${esc(s.label)}
    </button>`).join("")}
  </div>`;
}
function provEffortNote(effort) {
  const f = PROV_EFFORTS.find((x) => (x.id || "") === ((effort || "").toLowerCase()));
  if (!f || !f.id) return "Стандарт: уровень мышления выбирает сам шлюз (поле в запрос не едет).";
  return `${f.label}: ${f.hint}. ИИ ходит на «Минимальном» всегда, судья сочинений — на «Высоком», это задано кодом, а не этим полем.`;
}
/* Редактор доп. заголовков HTTP: строки «имя — значение» тем же
   .a-chain-row, что слоты цепочки (flex-ряд, а не новая вёрстка). Пустое имя —
   строка игнорируется, значения только видимые: секретам здесь не место. */
function provHeaderRowHTML(name, value) {
  return `<div class="a-chain-row" data-hrow>
    <input class="a-input mono a-chain-input" data-hname placeholder="x-custom-header" value="${esc(name || "")}" autocomplete="off" spellcheck="false" oninput="provHeadersTouched()">
    <input class="a-input mono a-chain-input" data-hvalue placeholder="значение" value="${esc(value || "")}" autocomplete="off" spellcheck="false" oninput="provHeadersTouched()">
    <button type="button" class="a-icon-btn a-icon-btn--danger" onclick="provHeaderDel(this)" title="Убрать заголовок">✕</button>
  </div>`;
}
function provHeadersHTML(headers) {
  const rows = Object.entries(headers || {})
    .filter(([n]) => n && String(n).trim())
    .map(([n, v]) => provHeaderRowHTML(n, v)).join("");
  return rows || `<div class="a-card__sub" data-hempty>Заголовков нет — обычный провайдер без них работает.</div>`;
}
function provHeadersTouched() {
  // Правка заголовков — тоже несохранённое изменение, но только на странице
  // провайдера: в форме добавления нечего сравнивать, там всё новое.
  if (ProvDetail.id) provDetailMarkDirty();
}
function provHeaderDel(btn) {
  const row = btn && btn.closest ? btn.closest("[data-hrow]") : null;
  if (row && row.parentNode) row.parentNode.removeChild(row);
  const box = document.getElementById("provHeaders") || document.getElementById("provNewHeaders");
  if (box && !box.querySelector("[data-hrow]") && !box.querySelector("[data-hempty]")) {
    box.insertAdjacentHTML("beforeend", `<div class="a-card__sub" data-hempty>Заголовков нет — обычный провайдер без них работает.</div>`);
  }
  provHeadersTouched();
}
function provHeaderAdd(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const empty = box.querySelector("[data-hempty]");
  if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
  box.insertAdjacentHTML("beforeend", provHeaderRowHTML("", ""));
  provHeadersTouched();
}
function provHeadersRead(boxId) {
  const box = document.getElementById(boxId);
  const out = {};
  if (!box) return out;
  box.querySelectorAll("[data-hrow]").forEach((row) => {
    const n = ((row.querySelector("[data-hname]") || {}).value || "").trim();
    const v = ((row.querySelector("[data-hvalue]") || {}).value || "").trim();
    if (n) out[n] = v;
  });
  return out;
}
/* Переключение шаблона: красит сегмент и показывает/прячет блоки. Классы, а
   не style.display: .a-check — flex, и атрибут hidden его не спрячет (авторский
   display бьёт UA-правило), поэтому прячем блочные обёртки. Значения скрытых
   блоков НЕ стираются — при возврате на шаблон они на месте. */
function paintProtoSeg(boxId, proto) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const cur = provProtoOf(proto);
  box.querySelectorAll(".a-seg2__btn").forEach((b) => {
    b.classList.toggle("a-seg2__btn--on", (b.dataset.proto || "") === cur);
  });
}
function paintProtoBlocks(proto) {
  // Блоки «заголовки» и «подклейка» различают не значения, а семейство: у
  // Responses и Anthropic свои заголовки и поле system, подклейка там не нужна.
  const native = provProtoOf(proto) !== "chat";
  document.querySelectorAll(".resp-only").forEach((n) => { n.hidden = !native; });
  document.querySelectorAll(".chat-only").forEach((n) => { n.hidden = native; });
}
function setNewProto(proto) {
  paintProtoSeg("provNewProtoSeg", proto);
  paintProtoBlocks(proto);
}
function setDetailProto(proto) {
  paintProtoSeg("provProtoSeg", proto);
  paintProtoBlocks(proto);
  provDetailMarkDirty();
}
function paintEffortSeg(boxId, effort) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const cur = (effort || "").toLowerCase();
  box.querySelectorAll(".a-seg2__btn").forEach((b) => {
    b.classList.toggle("a-seg2__btn--on", (b.dataset.effort || "") === cur);
  });
}
function setNewEffort(effort) {
  paintEffortSeg("provNewEffortSeg", effort);
  const note = document.getElementById("provNewEffortNote");
  if (note) note.textContent = provEffortNote(effort);
}
function setDetailEffort(effort) {
  paintEffortSeg("provEffortSeg", effort);
  const note = document.getElementById("provEffortNote");
  if (note) note.textContent = provEffortNote(effort);
  provDetailMarkDirty();
}
function currentProto(boxId) {
  const on = document.querySelector(`#${boxId} .a-seg2__btn--on`);
  const v = on ? (on.dataset.proto || "") : "";
  return provProtoOf(v);
}
function currentEffort(boxId) {
  const on = document.querySelector(`#${boxId} .a-seg2__btn--on`);
  return on ? (on.dataset.effort || "") : "";
}

/* Сегмент-контрол на странице провайдера: короткие подписи + пояснение, зачем
   слот нужен. PROV_SLOT_OPTIONS длиннее — они для выпадающего списка на
   карточке, где места мало, а пояснение не помещается. */
const PROV_SLOT_SEGMENTS = [
  { id: "high", label: "Высокий", hint: "пробуем первым" },
  { id: "medium", label: "Средний", hint: "если первый отказал" },
  { id: "low", label: "Низкий", hint: "в самом конце" },
  { id: "", label: "Без приоритета", hint: "вне очереди" },
];

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
    <button type="button" class="a-prov-card__open" onclick="navigate('/providers/${esc(p.id)}')" title="Настройки провайдера и список моделей">
      <div class="a-prov-top">
        <span class="a-dot a-dot--${dot}" title="${esc(dotLabel)}"></span>
        <span class="a-prov-title">${esc(p.title || p.id)}</span>
        ${p.builtin ? `<span class="a-chip" title="Стандартные значения — из окружения сервера">встроенный</span>` : `<span class="a-chip a-chip--accent">свой</span>`}
        ${p.active ? `<span class="a-chip a-chip--success" title="Запросы учеников идут сюда первым">активный</span>` : ""}
        ${p.modelOverridden ? `<span class="a-chip a-chip--warn" title="Модель изменена из админки">модель изменена</span>` : ""}
        ${p.modelTitleMissing ? `<span class="a-chip a-chip--warn" title="Без названия ученик не увидит, какой моделью проверено сочинение — задайте его в панели">нет названия</span>` : ""}
        ${(p.modelTitlesMissing && p.modelTitlesMissing.length) ? `<span class="a-chip a-chip--warn" title="Проверки этих моделей пройдут, но строка «проверено моделью» не появится: ${esc(p.modelTitlesMissing.join(", "))}">нет названия: ${esc(p.modelTitlesMissing[0])}${p.modelTitlesMissing.length > 1 ? ` +${p.modelTitlesMissing.length - 1}` : ""}</span>` : ""}
        <span class="spacer"></span>
        <span class="a-prov-card__more" aria-hidden="true">${aicon("chevron")}</span>
      </div>
      <div class="a-prov-id mono">${esc(p.id)}${p.slot ? ` · <b>${esc(p.slotLabel || p.slot)}</b>` : ""}</div>
      <div class="a-prov-meta">
        <div class="a-prov-kv"><span>Модель</span><b class="mono">${esc(p.model || "—")}</b></div>
      ${p.modelTitle ? `<div class="a-prov-kv"><span>Для ученика</span><b>${esc(p.modelTitle)}</b></div>` : ""}
      ${(p.modelOrder && p.modelOrder.length > 1) ? `<div class="a-prov-kv"><span>Цепочка</span><b class="mono" title="Порядок попыток внутри провайдера: высокий → средний → низкий">${esc(p.modelOrder.join(" → "))}</b></div>` : ""}
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
        ${p.protocol === "responses" ? `<span class="a-chip" title="Новый формат OpenAI: instructions + input, ответ массивом output">Responses API</span>` : ""}
        ${p.protocol === "anthropic" ? `<span class="a-chip" title="Формат Anthropic Messages: ключ в x-api-key, system отдельным полем">Anthropic</span>` : ""}
      </div>
    </button>
    <div class="a-prov-actions">
      <button class="btn btn--soft btn--sm" onclick="probeProvider('${esc(p.id)}')"${busy || !p.configured ? " disabled" : ""}>${busy ? "Проверяем…" : "Проверить"}</button>
      <select class="a-select a-prov-slot" onchange="setProviderSlot('${esc(p.id)}', this.value)" title="Приоритет: один слот — один провайдер">
        ${PROV_SLOT_OPTIONS.map((o) => `<option value="${o.id}"${(o.id || "") === (p.slot || "") ? " selected" : ""}>${esc(o.title)}</option>`).join("")}
      </select>
      <button class="btn btn--soft btn--sm" onclick="toggleProvider('${esc(p.id)}', ${p.enabled ? "false" : "true"})" title="${p.enabled ? "Убрать из ротации" : "Вернуть в ротацию"}">${p.enabled ? "Выключить" : "Включить"}</button>
      <button class="a-icon-btn a-icon-btn--danger" onclick="deleteProvider('${esc(p.id)}')" title="Удалить провайдера">${aicon("trash")}</button>
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
  const judge = (d.essayJudge && typeof d.essayJudge === "object") ? d.essayJudge : {};
  const tier = provTier();
  body.innerHTML = `
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head a-card__head--wrap">
        <span class="a-card__title">Направление</span>
      </div>
      <div class="a-seg" role="tablist" aria-label="Направление маршрутизации">
        <button class="a-seg__btn${tier === "free" ? " a-seg__btn--active" : ""}" role="tab" aria-selected="${tier === "free"}" onclick="setProvTier('free')">Обычные</button>
        <button class="a-seg__btn${tier === "plus" ? " a-seg__btn--active" : ""}" role="tab" aria-selected="${tier === "plus"}" onclick="setProvTier('plus')">Plus</button>
      </div>
      <div class="a-card__sub" style="margin-top:8px">Два независимых направления с одинаковым функционалом: провайдеры, очередь и судья у каждого свои. Обычные пользователи ходят через «Обычные», подписка Plus — через «Plus».</div>
    </div>
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head a-card__head--wrap">
        <span class="a-card__title">Очерёдность запросов</span>
        <span class="spacer"></span>
        <button class="btn btn--soft btn--sm" onclick="screenProviders(true)" title="Перечитать список без запросов к провайдерам">Обновить</button>
        <button class="btn btn--soft btn--sm" id="provProbeAllBtn" onclick="probeAllProviders()"${Prov.checkingAll ? " disabled" : ""}>${Prov.checkingAll ? "Проверяем…" : `${aicon("pulse")} Проверить всех`}</button>
        <button class="btn btn--primary btn--sm" onclick="navigate('/providers-new')">+ Добавить</button>
      </div>
      <div class="a-prov-order">${order.length ? order.map((id, i) => `${i ? '<span class="a-prov-arrow">→</span>' : ""}<span class="a-chip${i === 0 ? " a-chip--success" : ""}" title="${esc(names[id] || id)}">${i + 1}. ${esc(names[id] || id)}</span>`).join("") : `<span class="a-card__sub">Нет настроенных провайдеров — проверки сочинений и ИИ отвечают 503.</span>`}</div>
      <div class="a-card__sub" style="margin-top:8px">Активный${d.active ? `: <b>${esc(names[d.active] || d.active)}</b> — новые запросы идут сюда первым` : ": нет"}. Статус «Используется» — успех живого трафика за последние ${Number(d.recentWindowSec) || 60} с, холостых запросов ради него нет. «Пинг всех» — живой запрос «привет» каждому провайдеру с задержкой.</div>
      <div id="provPingAllResult" style="margin-top:12px">${Prov.ping && Prov.ping.results ? provPingRowsHTML(Prov.ping.results) : ""}</div>
    </div>
    ${provDeletedCardHTML(d)}
    ${provJudgeCardHTML(judge, list, names, order)}
    ${Prov.error ? `<div class="a-error-banner" style="margin-bottom:14px">Не удалось обновить: ${esc(Prov.error)}</div>` : ""}
    <div class="a-prov-grid">
      ${list.map(provCardHTML).join("")}
    </div>`;
}

/* Удалённые встроенные: их определения живут в коде, поэтому удаление их
   только прячет — здесь же их можно вернуть одной кнопкой. Свои удалённые
   не возвращаются никак (запись стёрта), и эта плашка о них молчит честно. */
function provDeletedCardHTML(d) {
  const gone = d && Array.isArray(d.deletedBuiltin) ? d.deletedBuiltin.filter(Boolean) : [];
  if (!gone.length) return "";
  return `
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head a-card__head--wrap">
        <span class="a-card__title">Удалённые встроенные</span>
      </div>
      <div class="a-card__sub" style="margin-bottom:10px">Скрыты из ротации. Свои удалённые провайдеры не восстанавливаются — их записи стёрты.</div>
      ${gone.map((id) => `<div class="a-actions-row" style="margin-top:8px"><span class="a-chip mono">${esc(id)}</span><button class="btn btn--soft btn--sm" onclick="restoreProvider('${esc(id)}')">Восстановить</button></div>`).join("")}
    </div>`;
}

/* Судья проверки сочинений: какая модель ставит баллы за содержание.
   Отдельная карточка, а не чип в «Очерёдности», потому что это другое
   измерение: очередь отвечает «кто обслуживает запрос», судья — «чьим
   прибором измеряют». Смена прибора меняет сами баллы (замеренная разница
   между моделями — до 18 из 22 на одном тексте), поэтому она должна быть
   видна и управляема явно, а не выясняться по расхождению оценок.
   Выбор — радио-ряды (как модели в списке, а не сырой <select>): вариант
   «По очереди» буквально показывает цепочку, ручной выбор и подмена после
   отказа подписаны словами, а не угадываются по селекту. */
function provJudgeCardHTML(judge, list, names, order) {
  const cur = judge.provider || "";
  const pref = judge.preferred || "";
  const fallback = judge.fallback || "";
  const chain = Array.isArray(order) ? order.filter(Boolean) : [];
  const byId = Object.fromEntries((Array.isArray(list) ? list : []).filter((p) => p.id).map((p) => [p.id, p]));
  const willFallback = !cur && !pref;
  const isDefault = !judge.explicit;
  const state = willFallback
    ? `<span class="a-chip a-chip--danger">не назначен</span>`
    : `<span class="a-chip a-chip--success">${esc(names[cur] || cur)}</span>`;
  const manual = judge.explicit ? `<span class="a-chip">выбран вручную</span>` : "";
  const switched = judge.switched
    ? `<span class="a-chip a-chip--warn" title="Судья отказал целиком, оценивает запасной — баллы несравнимы">подмена после отказа</span>` : "";
  const switchNote = judge.switched
    ? `<div class="a-prov-warn">«${esc(names[judge.switchedFrom] || judge.switchedFrom || "—") || "—"}» отказал — сейчас судит «${esc(names[cur] || cur)}».
       <button type="button" class="a-linkbtn" onclick="resetJudge()">Вернуть к очереди</button></div>`
    : "";
  const chainChips = chain.length
    ? chain.map((id, i) => `${i ? '<span class="a-prov-arrow">→</span>' : ""}<span class="a-chip${i === 0 ? " a-chip--success" : ""}">${i + 1}. ${esc(names[id] || id)}</span>`).join("")
    : `<span class="a-card__sub">нет настроенных провайдеров</span>`;
  const rows = chain.map((id) => {
    const p = byId[id] || { id, title: id };
    const off = p.enabled === false ? "выключен" : (!p.configured && !p.keySet ? "нет ключа" : "");
    return `<label class="a-judge-opt${p.id === cur && !isDefault ? " a-judge-opt--on" : ""}${off ? " a-judge-opt--off" : ""}">
      <input type="radio" name="provJudge" value="${esc(p.id)}"${p.id === cur && !isDefault ? " checked" : ""} onchange="judgePick(this)">
      <span class="a-judge-opt__body">
        <span class="a-judge-opt__title">${esc(p.title || p.id)}</span>
        ${p.slot ? `<span class="a-chip">${esc(p.slotLabel || p.slot)}</span>` : ""}
        ${p.id === fallback ? `<span class="a-chip a-chip--accent" title="Подключится при полном отказе судьи">запасной</span>` : ""}
        ${off ? `<span class="a-chip">${esc(off)}</span>` : ""}
        <span class="a-judge-opt__model mono">${esc(p.model || "—")}</span>
      </span>
    </label>`;
  }).join("");
  return `
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head a-card__head--wrap">
        <span class="a-card__title">Судья проверки сочинений</span>
        <span class="spacer"></span>
        <button class="btn btn--primary btn--sm" id="provJudgeApply" onclick="saveJudge()" disabled>Применить</button>
      </div>
      <div class="a-judge-chips" style="margin-bottom:10px">${state}${manual}${switched}</div>
      ${switchNote}
      <div class="a-card__sub" style="margin-bottom:10px">
        Баллы за содержание (К1–К6) ставит один закреплённый судья: разные модели
        ставят за одну работу разные баллы (до 18 из 22). По умолчанию это первый
        в очереди — перестановка очереди двигает и судью.
      </div>
      <div class="a-judge-opts" role="radiogroup" aria-label="Кто оценивает сочинения">
        <label class="a-judge-opt${isDefault && !willFallback ? " a-judge-opt--on" : ""}">
          <input type="radio" name="provJudge" value=""${isDefault ? " checked" : ""} onchange="judgePick(this)">
          <span class="a-judge-opt__body">
            <span class="a-judge-opt__title">По очереди</span>
            <span class="a-judge-opt__chain">${chainChips}</span>
          </span>
        </label>
        ${rows}
      </div>
      <div id="provJudgeResult" style="margin-top:10px"></div>
    </div>`;
}

function judgePick(input) {
  document.querySelectorAll(".a-judge-opt").forEach((el) => {
    el.classList.toggle("a-judge-opt--on", !!el.querySelector('input[name="provJudge"]:checked'));
  });
  const btn = document.getElementById("provJudgeApply");
  if (btn) btn.disabled = false;
}

async function resetJudge() {
  const box = document.getElementById("provJudgeResult");
  if (box) box.innerHTML = `<span class="a-card__sub">Возвращаем к очереди…</span>`;
  try {
    await AdminApi.post("/api/admin/providers/judge", provTierBody({ provider: "" }));
    toast("Судья — снова первый в очереди");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    if (box) box.innerHTML = `<div class="a-error-banner">${esc(e.message || "не удалось вернуть судью")}</div>`;
    return;
  }
  await screenProviders(true);
}

async function saveJudge() {
  const checked = document.querySelector('input[name="provJudge"]:checked');
  const box = document.getElementById("provJudgeResult");
  if (!checked || !box) return;
  box.innerHTML = `<span class="a-card__sub">Сохраняем…</span>`;
  try {
    const r = await AdminApi.post("/api/admin/providers/judge", provTierBody({ provider: checked.value || "" }));
    box.innerHTML = `<span class="a-chip a-chip--success">Судья: ${esc(r.judge || "—")}</span>`;
    await screenProviders(true);
  } catch (e) {
    box.innerHTML = `<div class="a-error-banner">${esc(e.message || "не удалось назначить судью")}</div>`;
  }
}

async function screenProviders(quiet) {
  // `quiet` — «обновить данные, не пересобирая экран». Это важно со СТРАНИЦЫ
  // провайдера: там нет узла provBody, и общий путь перерисовки выбрасывал
  // человека обратно в список, стирая вердикт проверки и напечатанные поля.
  if (!quiet) renderShell("providers", `<div id="provBody"></div>`);
  if (!document.getElementById("provBody") && !document.getElementById("provModelsBtn")) {
    renderShell("providers", `<div id="provBody"></div>`);
  }
  if (!quiet) { Prov.loading = true; Prov.error = null; drawProviders(); }
  try {
    Prov.data = await AdminApi.get("/api/admin/providers" + provTierQS());
    Prov.error = null;
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    Prov.error = e.message || "неизвестная ошибка";
  }
  Prov.loading = false;
  // Если открыта страница провайдера — рисуем только список (он в другой
  // вкладке/разделе) , а карточку на странице обновляет её собственный код.
  if (document.getElementById("provBody")) drawProviders();
  else if (ProvDetail.id) provDetailSyncFromCard(provById(ProvDetail.id) || {});
}

async function probeProvider(id) {
  if (Prov.probing[id]) return;
  Prov.probing[id] = true;
  drawProviders();
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/probe`, provTierBody({}));
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

/* Тосты про обмен приоритетами: занятый слот не вытесняет молча.
   Сервер возвращает slotSwap/modelSwap {type, ...}, клиент называет событие
   словами — иначе «поменялись местами» выглядело бы как «приоритет обновлён»
   и было бы непонятно, куда делся прежний держатель слота. */
function slotLabelOf(slot) {
  return (PROV_SLOT_LABELS && PROV_SLOT_LABELS[slot]) || slot || "без приоритета";
}

function toastSlotSwap(swap) {
  if (!swap || swap.type === "noop") return false;
  const nameOf = (id) => provName(id);
  if (swap.type === "swapped") {
    toast(`«${nameOf(swap.provider)}» и «${nameOf(swap.other)}» поменялись местами: «${nameOf(swap.provider)}» теперь «${slotLabelOf(swap.slot)}», «${nameOf(swap.other)}» теперь «${slotLabelOf(swap.otherSlot)}»`);
  } else if (swap.type === "evicted") {
    toast(`«${nameOf(swap.provider)}» занял «${slotLabelOf(swap.slot)}» — «${nameOf(swap.other)}» больше не используется (без приоритета)`);
  } else if (swap.type === "moved") {
    if (swap.from && swap.to) toast(`«${nameOf(swap.provider)}»: было «${slotLabelOf(swap.from)}», стало «${slotLabelOf(swap.to)}»`);
    else if (swap.to) toast(`«${nameOf(swap.provider)}» теперь «${slotLabelOf(swap.to)}»`);
    else toast("Приоритет обновлён");
  } else if (swap.type === "removed") {
    toast(`«${nameOf(swap.provider)}» снят с «${slotLabelOf(swap.from)}» — теперь без приоритета`);
  } else {
    toast("Приоритет обновлён");
  }
  return true;
}

function toastModelSwap(swap) {
  if (!swap || swap.type === "noop") return false;
  if (swap.type === "swapped") {
    toast(`Модели поменялись местами: «${swap.model}» теперь «${slotLabelOf(swap.slot)}», «${swap.other}» теперь «${slotLabelOf(swap.otherSlot)}»`);
  } else if (swap.type === "evicted") {
    toast(`«${swap.model}» занял «${slotLabelOf(swap.slot)}» — «${swap.other}» больше не используется в цепочке`);
  } else if (swap.type === "moved") {
    if (swap.from && swap.to) toast(`Модель «${swap.model}»: было «${slotLabelOf(swap.from)}», стало «${slotLabelOf(swap.to)}»`);
    else if (swap.to) toast(`Модель «${swap.model}» теперь «${slotLabelOf(swap.to)}»`);
    else toast("Цепочка моделей обновлена");
  } else if (swap.type === "removed") {
    toast(`Модель «${swap.model}» убрана из «${slotLabelOf(swap.from)}»`);
  } else {
    toast("Цепочка моделей обновлена");
  }
  return true;
}

async function setProviderSlot(id, slot) {
  let res = null;
  try {
    // Обмен считаем сами (сервер его подтвердит): занятый слот не вытесняет
    // молча — у кого был свой приоритет, меняемся местами, у кого не было —
    // прежний держатель уходит в «без приоритета» (см. toastSlotSwap).
    const cur = Object.assign({ high: null, medium: null, low: null }, (Prov.data && Prov.data.slots) || {});
    const old = Object.keys(cur).find((s) => cur[s] === id) || null;
    const want = slot || null;
    if (old !== want) {
      const holder = want ? cur[want] : null;
      if (!want) {
        if (old) cur[old] = null;
      } else if (holder && holder !== id) {
        if (old) { cur[want] = id; cur[old] = holder; }
        else { cur[want] = id; }
      } else {
        if (old) cur[old] = null;
        cur[want] = id;
      }
    }
    res = await AdminApi.post("/api/admin/providers/slots", provTierBody({ slots: cur }));
    if (!toastSlotSwap(res && res.slotSwap)) toast("Приоритет обновлён");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось: ${e.message || "ошибка"}`, "err");
  }
  await screenProviders(true);
}

async function toggleProvider(id, enabled) {
  try {
    await AdminApi.put(`/api/admin/providers/${encodeURIComponent(id)}`, provTierBody({ enabled: !!enabled }));
    toast(enabled ? "Провайдер включён" : "Провайдер выключен");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось: ${e.message || "ошибка"}`, "err");
  }
  await screenProviders(true);
}

/* Удаление провайдера — встроенного и своего одинаково, всегда в два шага:
   шаг 1 объясняет последствие (уйдёт из ротации сразу; встроенный можно
   вернуть кнопкой «Восстановить»), шаг 2 требует ввести ID — как удаление
   аккаунта требует Account ID. Нативный confirm() здесь был бы слабее:
   его легко промахнуться, а удаление последнего рабочего провайдера
   останавливает проверки сочинений и ИИ целиком. */
async function deleteProvider(id) {
  const p = provById(id);
  const title = (p && (p.title || p.id)) || id;
  const list = (Prov.data && Prov.data.providers) || [];
  const others = list.filter((q) => q.id !== id && q.enabled !== false && q.configured !== false);
  const lastWarn = others.length === 0
    ? `<div class="a-modal__warn">Это последний рабочий провайдер направления: после удаления проверки сочинений и ИИ начнут отвечать 503.</div>`
    : "";
  const builtinNote = (p && p.builtin)
    ? `<div class="a-modal__desc">Встроенный провайдер исчезнет из списка и ротации. Вернуть можно кнопкой «Восстановить» в списке.</div>`
    : "";
  openModal(`
    <div class="a-modal__title" style="color:var(--danger)">Удалить провайдера «${esc(id)}»?</div>
    <div class="a-modal__desc">«${esc(title)}» уйдёт из ротации сразу.</div>
    ${builtinNote}
    ${lastWarn}
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--danger-soft" id="mNext">Продолжить</button>
    </div>`, (modal) => {
    modal.classList.add("a-modal--danger");
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelector("#mNext").onclick = () => {
      modal.innerHTML = `
        <div class="a-modal__title" style="color:var(--danger)">Точно удалить «${esc(id)}»?</div>
        <div class="a-modal__desc">Действие необратимо для своих провайдеров (запись стирается). Встроенный можно вернуть кнопкой «Восстановить».</div>
        <div class="a-modal__form">
          <div class="a-modal__warn"><b>Подтверждение:</b> введи ID провайдера <span class="mono">${esc(id)}</span></div>
          <input class="a-input mono" id="fDelProv" placeholder="${esc(id)}" autocomplete="off">
          <div id="mErr"></div>
        </div>
        <div class="a-modal__actions">
          <button class="btn btn--soft" id="mCancel2">Отмена</button>
          <button class="btn btn--danger-soft" id="mDo">Удалить навсегда</button>
        </div>`;
      modal.querySelector("#mCancel2").onclick = closeModal;
      modal.querySelector("#mDo").onclick = async () => {
        if (modal.querySelector("#fDelProv").value.trim() !== id) {
          modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">ID не совпадает</div>`;
          return;
        }
        try {
          await AdminApi.request(`/api/admin/providers/${encodeURIComponent(id)}` + provTierQS(), { method: "DELETE" });
          closeModal();
          toast("Провайдер удалён");
          // Со страницы провайдера уходим в список: настраивать удалённого больше
          // нечего, а «обновить» оставило бы человека на карточке-призраке.
          if (ProvDetail.id === id) { navigate("/providers"); return; }
          await screenProviders(true);
        } catch (e) {
          if (e && e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
          modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message || "ошибка")}</div>`;
        }
      };
    };
  });
}

async function restoreProvider(id) {
  try {
    await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/restore` + provTierQS(), {});
    toast("Провайдер восстановлен");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не удалось восстановить: ${e.message || "ошибка"}`, "err");
    return;
  }
  await screenProviders(true);
}

function provField(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

/* ---------------- Добавление провайдера: СТРАНИЦА, а не модалка ----------------

   Была модалка `.a-modal` — узкий блок с полями в один столбик поверх списка.
   Настроек у провайдера много, и они не помещались: на телефоне низ срезался,
   а «проверить» и «добавить» жили в одном ряду с полями. Теперь это страница
   `#/providers-new` на той же сетке, что и страница существующего провайдера:
   левая колонка — подключение и модель, правая — приоритет, quirks и что
   будет после сохранения. */

function provNewSlotSegHTML() {
  return `<div class="a-seg2" role="group" aria-label="Приоритет провайдера в очереди">
    ${PROV_SLOT_SEGMENTS.map((s) => `<button type="button" class="a-seg2__btn${s.id === "high" ? " a-seg2__btn--on" : ""}"
        data-slot="${s.id}" onclick="setNewSlot('${s.id}')" title="${esc(s.hint)}">
      ${esc(s.label)}<span class="a-seg2__hint">${esc(s.hint)}</span>
    </button>`).join("")}
  </div>`;
}

function setNewSlot(slot) {
  const box = document.getElementById("provNewSlotSeg");
  if (!box) return;
  box.querySelectorAll(".a-seg2__btn").forEach((b) => {
    b.classList.toggle("a-seg2__btn--on", (b.dataset.slot || "") === (slot || ""));
  });
  const note = document.getElementById("provNewSlotNote");
  if (note) {
    const d = Prov.data || {};
    const held = Object.entries(d.slots || {}).filter(([, v]) => v);
    const want = slot ? (PROV_SLOT_LABELS[slot] || slot) : "без приоритета";
    note.textContent = slot
      ? `Провайдер встанет в слот «${want}»` +
        (held.some(([k]) => k === slot) ? ` — его сейчас держит ${provName(held.find(([k]) => k === slot)[1])}.` : " (слот свободен).")
      : "Провайдер войдёт вне очереди по приоритету — работать будет, если остальные недоступны.";
  }
}

function screenProviderNew() {
  ProvDetail.id = null;
  ProvDetail.models = null;
  const d = Prov.data || {};
  const held = Object.entries(d.slots || {}).filter(([, v]) => v)
    .map(([k, v]) => `<span class="a-chip">${esc(k)}: ${esc(provName(v))}</span>`).join(" ");
  renderShell("providers", `
    <div class="a-page-head">
      <a class="a-back" href="#/providers" title="К списку провайдеров">${aicon("chevron")} <span>Провайдеры</span></a>
      <div class="a-page-head__main">
        <span class="a-dot a-dot--idle"></span>
        <div class="a-page-title-wrap">
          <h1 class="a-page-title">Новый провайдер</h1>
          <div class="a-page-sub">Шаблон API, адрес, ключ, модель — форма подстроится под шаблон</div>
        </div>
      </div>
      <div class="a-page-status">
        <span class="a-page-status__item">${held ? `Занятые слоты: ${held}` : "Слоты приоритета свободны"}</span>
      </div>
    </div>

    <div class="a-page-grid">
      <div class="a-page-col">
        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Подключение</span></div>
          <div class="a-field">
            <label>Шаблон API</label>
            <div id="provNewProtoSeg">${provProtoSegHTML("chat", "setNewProto")}</div>
            <span class="a-field__hint">Шаблон меняет поля формы: у Responses API и Anthropic свой формат запросов, им нужны заголовки и не нужна подклейка system.</span>
          </div>
          <div class="a-form-grid">
            <div class="a-field">
              <label for="provId">ID латиницей</label>
              <input class="a-input mono" id="provId" placeholder="openrouter" autocomplete="off" spellcheck="false">
              <span class="a-field__hint">Короткий код провайдера в админке и в ротации. Латиница, цифры, дефис.</span>
            </div>
            <div class="a-field">
              <label for="provTitle">Название</label>
              <input class="a-input" id="provTitle" placeholder="OpenRouter" autocomplete="off">
              <span class="a-field__hint">Как провайдер называется в списке.</span>
            </div>
          </div>
          <div class="a-field">
            <label for="provBaseUrl">Base URL</label>
            <input class="a-input mono" id="provBaseUrl" placeholder="https://openrouter.ai/api/v1" autocomplete="off" spellcheck="false">
            <span class="a-field__hint">Адрес API без завершающего слэша. Модели и проверка ходят туда.</span>
          </div>
          <div class="a-field">
            <label for="provKey">API-ключ</label>
            <input class="a-input mono" id="provKey" type="password" placeholder="sk-…" autocomplete="off">
            <span class="a-field__hint">Хранится в базе (файл 0600) и никогда не отдаётся в браузер целиком.</span>
          </div>
          <div class="a-field">
            <label for="provAuth">Авторизация</label>
            <select class="a-select" id="provAuth">
              <option value="bearer">Bearer (обычно)</option>
              <option value="raw">Сырой ключ (как gptunnel)</option>
            </select>
          </div>
          <div class="a-field">
            <label>Уровень мышления</label>
            <div id="provNewEffortSeg">${provEffortSegHTML("", "setNewEffort")}</div>
            <span class="a-field__hint" id="provNewEffortNote">${provEffortNote("")}</span>
          </div>
        </section>

        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Доп. заголовки HTTP</span></div>
          <div id="provNewHeaders">${provHeadersHTML({})}</div>
          <div class="a-actions-row" style="margin-top:8px">
            <button class="btn btn--soft btn--sm" type="button" onclick="provHeaderAdd('provNewHeaders')">+ Заголовок</button>
          </div>
          <span class="a-field__hint">Например x-opencode-session для маршрутизации. Секретам здесь не место — значения видны в админке.</span>
        </section>

        <section class="a-card">
          <div class="a-card__head">
            <span class="a-card__title">Модель</span>
            <span class="spacer"></span>
            <button class="btn btn--soft btn--sm" id="provDraftBtn" type="button">${aicon("pulse")} Проверить без сохранения</button>
          </div>
          <div class="a-field">
            <label for="provModel">ID модели у провайдера</label>
            <input class="a-input mono" id="provModel" placeholder="openai/gpt-4o-mini" autocomplete="off" spellcheck="false">
          </div>
          <div class="a-field">
            <label for="provModelTitle">Название для ученика</label>
            <input class="a-input" id="provModelTitle" placeholder="например: топ модель" autocomplete="off">
            <span class="a-field__hint">Это увидит ученик на странице результата вместо технического ID. Пусто — строка не появится.</span>
          </div>
          <div id="provDraftResult"></div>
        </section>
      </div>

      <div class="a-page-col a-page-col--side">
        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Место в очереди</span></div>
          <div id="provNewSlotSeg">${provNewSlotSegHTML()}</div>
          <div class="a-field__hint" id="provNewSlotNote">Провайдер встанет в слот «Высокий» (слот свободен).</div>
        </section>

        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Особенности шлюза</span></div>
          <label class="a-check"><input type="checkbox" id="provWallet"> <span>Списывать предоплату кошелька (useWalletBalance)</span></label>
          <div class="chat-only"><label class="a-check"><input type="checkbox" id="provMerge"> <span>Подклеивать system-промпт к user (маршруты вроде anthropic)</span></label></div>
          <div class="a-pnl__note resp-only" hidden>Для Responses API и Anthropic подклейка не применяется — system едет отдельным полем (instructions или system).</div>
          <div class="a-pnl__note">Оставьте пустым, если шлюз ведёт себя как обычный OpenAI API. Ошибка в этой настройке ломает все запросы, поэтому «проверить без сохранения» — правильный способ убедиться до добавления.</div>
        </section>

        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Что будет после сохранения</span></div>
          <div class="a-card__sub">Сохранение мгновенное: сервер ничего не спрашивает у шлюза. Проверить живым запросом можно на странице провайдера — «Проверить» или «Пинг всех моделей». Недоступная модель добавлению не мешает: она войдёт в ротацию, когда заработает.</div>
        </section>
      </div>
    </div>

    <div class="a-sticky-actions">
      <span class="a-modal__error" id="provFormError" hidden></span>
      <span class="spacer"></span>
      <a class="btn btn--soft btn--sm" href="#/providers">Отмена</a>
      <button class="btn btn--primary btn--sm" id="provSave" type="button">Добавить провайдера</button>
    </div>`);
  document.getElementById("provDraftBtn").onclick = draftProbeFromPage;
  document.getElementById("provSave").onclick = saveProviderFromPage;
}

async function draftProbeFromPage() {
  const box = document.getElementById("provDraftResult");
  const btn = document.getElementById("provDraftBtn");
  if (btn) btn.disabled = true;
  if (box) box.innerHTML = `<span class="a-card__sub">Проверяем живым запросом «привет»…</span>`;
  try {
    const r = await AdminApi.post("/api/admin/providers/probe", {
      base_url: provField("provBaseUrl"), model: provField("provModel"),
      api_key: provField("provKey"), auth: provField("provAuth"),
      useWalletBalance: document.getElementById("provWallet")?.checked,
      protocol: currentProto("provNewProtoSeg"),
      extra_headers: provHeadersRead("provNewHeaders"),
    });
    const p = r && r.probe;
    if (box) box.innerHTML = p && p.ok
      ? `<div class="a-prov-checkok">Модель отвечает (${fmtNum(p.latencyMs)} мс) — можно добавлять.</div>`
      : `<div class="a-prov-checkbad">Модель недоступна: ${esc((p && p.error) || "ошибка")}. Добавить можно — в ротацию войдёт, когда заработает.</div>`;
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    if (box) box.innerHTML = `<div class="a-prov-checkbad">${esc(e.message || "ошибка проверки")}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveProviderFromPage() {
  const err = document.getElementById("provFormError");
  const btn = document.getElementById("provSave");
  const say = (msg) => { if (err) { err.textContent = msg; err.hidden = false; } };
  if (err) { err.hidden = true; err.textContent = ""; }
  const onSlot = document.querySelector("#provNewSlotSeg .a-seg2__btn--on");
  const slot = onSlot ? (onSlot.dataset.slot || "") : "";
  // Проверяем только то, без чего сервер всё равно откажет: так админ видит
  // ошибку у себя в поле, а не в ответе API после нажатия.
  if (!provField("provId").trim()) { say("Впиши ID провайдера латиницей"); return; }
  if (!provField("provBaseUrl").trim()) { say("Впиши Base URL — без него запросы некуда слать"); return; }
  if (!provField("provModel").trim()) { say("Впиши ID модели"); return; }
  if (!provField("provKey").trim()) { say("Впиши API-ключ"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Добавляем…"; }
  let created = null;
  try {
    const r = await AdminApi.post("/api/admin/providers", provTierBody({
      id: provField("provId"), title: provField("provTitle"),
      base_url: provField("provBaseUrl"), model: provField("provModel"),
      api_key: provField("provKey"), auth: provField("provAuth"),
      model_title: provField("provModelTitle"),
      useWalletBalance: document.getElementById("provWallet")?.checked,
      mergeSystem: document.getElementById("provMerge")?.checked,
      protocol: currentProto("provNewProtoSeg"),
      reasoning_effort: currentEffort("provNewEffortSeg"),
      extra_headers: provHeadersRead("provNewHeaders"),
      slot: slot || null,
    }));
    created = (r && r.provider && r.provider.id) || provField("provId").trim();
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    say(e.message || "ошибка");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Добавить провайдера"; }
  }
  if (!created) return;
  toast("Провайдер добавлен");
  // Сразу на его страницу: там можно задать название для ученика, проверить
  // модель и посмотреть пинг всех моделей — всё, ради чего форма и писалась.
  ProvDetail.id = created;
  ProvDetail.data = null;
  await screenProviders(true);
  navigate(`/providers/${encodeURIComponent(created)}`);
  if (location.hash === `#/providers/${encodeURIComponent(created)}`) render();
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
  paint(`<div class="a-prov-hint">Отправляем «привет» каждому провайдеру по очереди (до 20 с на провайдера)…</div>`);
  try {
    const r = await AdminApi.post("/api/admin/providers/probe-all", provTierBody({}));
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
    // Флаг снимаем только здесь, а runPingAll внутри уже вызвал
    // screenProviders(true) и перерисовал раздел ПОДНЯТЫМ флагом — без
    // повторной отрисовки кнопка навсегда оставалась «Проверяем…».
    // drawProviders без provBody (страница провайдера) молча ничего не делает.
    .finally(() => { Prov.checkingAll = false; drawProviders(); });
}

/* ---------------- Страница провайдера: модели и живой пинг ----------------

   Была модалка — широкий блок поверх списка, в котором на телефоне не
   помещалось ничего, а «пинг всех моделей» отдавал один ответ через
   30-90 секунд пустого экрана. Теперь это ОТДЕЛЬНАЯ СТРАНИЦА со своим адресом
   (#/providers/<id>) и живым потоком результатов: строка появляется, как
   только модель ответила.

   Поток — NDJSON (не SSE): EventSource не умеет ни POST, ни заголовки, ни
   нормальную куку, а нам нужен ровно один админский запрос. Читаем через
   fetch + response.body.getReader(), строки разбираем по мере прихода. */

const PROV_STREAM_BUDGET_MS = 20500;   // чуть больше серверных 20 с
const PROV_MODEL_RENDER_MAX = 60;      // сколько строк списка рисуем за раз

/* Рейтинг моделей: рисуется И из пакетного ответа, И из живого потока.
   Одна разметка на оба пути — иначе «живой» список и итоговый разъезжались
   бы видом (а именно это и было в модалке: живой список + финальная
   перерисовка). */
function provRankRowHTML(model, res, index, opts) {
  const p = res || {};
  const o = opts || {};
  const cur = o.current === model;
  const maxLatency = o.maxLatency || 1;
  const width = p.ok ? Math.max(6, Math.round(((p.latencyMs || 0) / maxLatency) * 100)) : 0;
  const wait = p.pending === true;
  return `<button type="button" class="a-rank${p.ok ? " a-rank--ok" : (wait ? " a-rank--wait" : " a-rank--bad")}"
      data-model="${esc(model)}" onclick="pickProviderModel(this.dataset.model)"
      title="${p.ok ? `Задержка ${p.latencyMs} мс — нажми, чтобы выбрать`
        : (wait ? "Ещё проверяется…" : esc(p.error || "недоступна"))}">
    <span class="a-rank__no">${wait ? '<span class="a-spin a-spin--xs"></span>' : index}</span>
    <span class="a-dot a-dot--${p.ok ? "ok" : (wait ? "idle" : "bad")}"></span>
    <span class="a-rank__name mono">${esc(model)}</span>
    ${cur ? '<span class="a-chip a-chip--accent">сейчас</span>' : ""}
    ${p.ok ? `<span class="a-rank__bar"><i style="width:${width}%"></i></span>` : '<span class="a-rank__bar a-rank__bar--empty"></span>'}
    <span class="a-rank__ms">${esc(p.ok ? `${fmtNum(p.latencyMs)} мс` : (wait ? "проверяем…" : (p.error || "недоступна")))}</span>
  </button>`;
}

function provRankListHTML(state, opts) {
  const res = state.results || {};
  const order = state.order && state.order.length ? state.order : Object.keys(res);
  if (!order.length) return "";
  const o = Object.assign({}, opts, { current: state.current || "" });
  o.maxLatency = order.reduce((acc, m) => {
    const r = res[m] || {};
    return r.ok && (r.latencyMs || 0) > acc ? r.latencyMs : acc;
  }, 1);
  return `<div class="a-ranks">${order.map((m, i) => provRankRowHTML(m, res[m], i + 1, o)).join("")}</div>`;
}

/* Шапка отчёта: сколько проверено, сколько живых, где мы по времени. */
function provPingSummaryHTML(state) {
  if (!state || !state.total) return "";
  const live = Number(state.okCount || 0);
  const parts = [state.done || live
    ? `<b class="a-ping__live">${fmtNum(live)}</b> из ${fmtNum(state.checked || 0)} ответили`
    : `идёт проверка ${fmtNum(state.checked || 0)} моделей`];
  if (state.total > (state.checked || 0)) {
    parts.push(`не проверено ${fmtNum(state.total - (state.checked || 0))} (потолок ${fmtNum(state.limit || 0)} за нажатие)`);
  }
  if (state.done) {
    if (state.timedOut) parts.push(`${fmtNum(state.timedOut)} не ответили за ${fmtNum(Math.round((state.budgetMs || 0) / 1000))} с`);
    else parts.push(`за ${(state.budgetMs / 1000).toFixed(1)} с`);
  } else {
    parts.push(`<span class="a-ping__timer" id="provPingTimer">0.0 с</span> из ${fmtNum(Math.round(PROV_STREAM_BUDGET_MS / 1000))} с`);
  }
  return parts.join(" · ");
}

/* Живой пинг моделей: читает NDJSON и дорисовывает строки по мере прихода.
   Порядок строк ВО ВРЕМЯ проверки — порядок ответов (человек видит, как
   приходят результаты), а по завершении список пересобирается по скорости:
   это и есть обещанный «от быстрых к остальным». */
async function pingProviderModels() {
  const id = ProvDetail.id;
  if (!id || ProvDetail.pinging) return;
  ProvDetail.pinging = true;
  const btn = document.getElementById("provPingModelsBtn");
  const box = document.getElementById("provModelPingResult");
  if (btn) { btn.disabled = true; btn.innerHTML = `${aicon("pulse")} Пингуем…`; }
  ProvDetail.ping = { results: {}, order: [], total: 0, checked: 0, okCount: 0,
                      limit: 0, done: false, timedOut: 0, budgetMs: 0,
                      current: (ProvDetail.models && ProvDetail.models.current) || ProvDetail.model || "" };
  if (box) box.innerHTML = provPingBoxHTML(false);
  const started = Date.now();
  let ticker = null;
  const paintElapsed = () => {
    const el = document.getElementById("provPingTimer");
    if (el) el.textContent = `${((Date.now() - started) / 1000).toFixed(1)} с`;
  };
  ticker = setInterval(paintElapsed, 100);
  let finished = false;
  try {
    const resp = await fetch(`/api/admin/providers/${encodeURIComponent(id)}/probe-models-stream`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: provTier() }),
    });
    if (resp.status === 401) { A.session = null; renderLogin(); return; }
    if (!resp.ok || !resp.body) {
      const payload = await resp.json().catch(() => ({}));
      throw Object.assign(new Error(payload.error || `Поток недоступен (${resp.status})`),
                          { retryAfter: Number(payload.retryAfter) || 0 });
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) {
          let evt = null;
          try { evt = JSON.parse(line); } catch (e) { evt = null; }
          if (evt) applyProvPingEvent(evt);
        }
        nl = buffered.indexOf("\n");
      }
    }
    if (buffered.trim()) {
      try { applyProvPingEvent(JSON.parse(buffered.trim())); } catch (e) { /* хвост обрезан */ }
    }
    finished = true;
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    const state = ProvDetail.ping;
    if (state && state.checked) {
      // Часть результатов уже пришла — не выбрасываем их из-за обрыва.
      toast("Поток прервался, показываю то, что успело прийти", "err");
    } else if (box) {
      box.innerHTML = e.retryAfter
        ? `<div class="a-prov-hint">Модели только что проверяли — повтори через ${e.retryAfter} с.</div>`
        : `<div class="a-prov-checkbad">${esc(e.message || "ошибка проверки")}</div>`;
    }
  } finally {
    clearInterval(ticker);
    paintElapsed();
    ProvDetail.pinging = false;
    if (btn) { btn.disabled = false; btn.innerHTML = `${aicon("pulse")} Пинг всех моделей`; }
    if (ProvDetail.id === id && ProvDetail.ping) {
      ProvDetail.ping.done = true;
      drawProvPing(true);
      if (finished) {
        const st = ProvDetail.ping;
        toast(st.okCount
          ? `Модели проверены: живых ${st.okCount} из ${st.checked}`
          : "Ни одна модель не ответила");
      }
    }
  }
}

/* Обработка одного события потока. События приходят по мере готовности —
   экран перерисовывается ТОЛЬКО внутри списка, чтобы не терять фокус и не
   мигать всей страницей. */
function applyProvPingEvent(evt) {
  const st = ProvDetail.ping;
  if (!st || !evt || !evt.kind) return;
  if (evt.kind === "start") {
    st.total = evt.total || 0;
    st.checked = evt.checked || 0;
    st.limit = evt.limit || 0;
    st.pending = Array.isArray(evt.models) ? evt.models.slice() : [];
    st.order = st.pending.slice();
    st.results = {};
    // Пока ответа нет — строка есть и она «проверяется»: пустой экран не
    // отвечает на главный вопрос «идёт ли вообще проверка».
    st.pending.forEach((m) => { st.results[m] = { ok: false, latencyMs: 0, error: "", pending: true }; });
  } else if (evt.kind === "result") {
    st.results[evt.model] = { ok: !!evt.ok, latencyMs: evt.latencyMs || 0, error: evt.error || "", protocol: evt.protocol || "" };
    if (st.order.indexOf(evt.model) < 0) st.order.push(evt.model);
    st.okCount = Object.values(st.results).filter((r) => r.ok).length;
    const still = Object.values(st.results).filter((r) => r.pending).length;
    // Порядок живого списка: сперва то, что уже ответило (быстрые сверху), а
    // неответившие — внизу. Иначе строка прыгала бы вверх через весь список.
    const rows = st.order.filter((m) => !st.results[m].pending);
    rows.sort((a, b) => {
      const ra = st.results[a], rb = st.results[b];
      if (ra.ok !== rb.ok) return ra.ok ? -1 : 1;
      return (ra.latencyMs || 0) - (rb.latencyMs || 0);
    });
    st.order = rows.concat(st.order.filter((m) => st.results[m].pending));
    if (!still) st.waiting = false;
  } else if (evt.kind === "done") {
    st.order = evt.order && evt.order.length ? evt.order.slice() : st.order;
    st.okCount = evt.okCount || 0;
    st.timedOut = evt.timedOut || 0;
    st.budgetMs = evt.budgetMs || 0;
    st.done = true;
    st.at = evt.checkedAt || Date.now();
    Object.keys(st.results).forEach((m) => { delete st.results[m].pending; });
    // Список моделей у провайдера мог ещё не загружаться: пинг сам по себе
    // знает имена всех проверенных моделей, и вердикт должен быть виден в
    // списке, а не только в рейтинге (иначе после пинга «Список моделей»
    // приходилось бы жать второй раз, чтобы увидеть точки).
    if (!ProvDetail.models) {
      ProvDetail.models = { models: st.order.slice(), current: st.current || "", latencyMs: null };
      provDetailRenderList();
    }
  } else if (evt.kind === "error") {
    const box = document.getElementById("provModelPingResult");
    if (box) {
      box.innerHTML = evt.retryAfter
        ? `<div class="a-prov-hint">${esc(evt.error || "подожди")}</div>`
        : `<div class="a-prov-checkbad">${esc(evt.error || "ошибка проверки")}</div>`;
    }
    ProvDetail.ping = null;
    return;
  }
  drawProvPing(false);
}

/* Оболочка блока пинга: шапка-сводка + список + прогресс. Перерисовывается
   целиком только когда меняется состав строк, иначе — точечно по строкам. */
function provPingBoxHTML(done) {
  const st = ProvDetail.ping;
  if (!st) return "";
  const head = done
    ? `Проверено ${fmtNum(st.checked)} моделей: ${provPingSummaryHTML(st)} · ${esc(provRel(st.at || Date.now()))}. Отсортировано по скорости — нажми на модель, чтобы выбрать её.`
    : `Идёт живая проверка: ${provPingSummaryHTML(st)}. Строки появляются по мере ответа.`;
  return `<div class="a-ping${done ? " a-ping--done" : ""}">
    <div class="a-ping__head">
      <span class="a-ping__live-dot"></span>
      <span class="a-ping__text">${head}</span>
    </div>
    <div class="a-ping__body" id="provPingRows">${provRankListHTML(st)}</div>
  </div>`;
}

/* Точечная перерисовка: строки обновляются на месте, а не блоком, поэтому
   прокрутка и фокус не слетают, пока список растёт. */
function drawProvPing(done) {
  const box = document.getElementById("provModelPingResult");
  if (!box || !ProvDetail.ping) return;
  const st = ProvDetail.ping;
  const rowsBox = document.getElementById("provPingRows");
  const headText = box.querySelector(".a-ping__text");
  if (headText) {
    headText.innerHTML = done
      ? `Проверено ${fmtNum(st.checked)} моделей: ${provPingSummaryHTML(st)} · ${esc(provRel(st.at || Date.now()))}. Отсортировано по скорости — нажми на модель, чтобы выбрать её.`
      : `Идёт живая проверка: ${provPingSummaryHTML(st)}. Строки появляются по мере ответа.`;
  }
  if (!rowsBox) { box.innerHTML = provPingBoxHTML(done); return; }
  // Класс «готово» — на сам блок .a-ping (он ВНУТРИ обёртки): раньше он вешался
  // на обёртку, и завершение проверки визуально не наступало никогда.
  const panel = box.querySelector(".a-ping");
  if (panel) panel.classList.toggle("a-ping--done", !!done);
  rowsBox.innerHTML = provRankListHTML(st);
}

/* ---------------- Страница провайдера: вёрстка ----------------

   Это ОТДЕЛЬНАЯ СТРАНИЦА (#/providers/<id>), а не модалка. Причина простая:
   настроек у провайдера много (модель, название, адрес, ключ, quirks,
   приоритет, список моделей, живой пинг), и в широком блоке поверх списка они
   не помещались — на телефоне модалка превращалась в одну длинную колонку с
   обрезанным низом. Страница даёт нормальную сетку, свой адрес (можно
   отправить ссылку, работает «назад»), и живой пинг на всю ширину. */

/* Кусок «подпись → значение» для карточек со сводкой. */
/* Сегмент приоритета: четыре состояния видны сразу, включая «без приоритета».
   Выпадающий список врал — человек не видел, что слот РОВНО ОДИН и что выбор
   освобождает прежнего держателя слота. */
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
    if (!slot) {
      note.textContent = "Провайдер останется вне очереди по приоритету (работать будет, если остальные недоступны).";
    } else {
      // Честная подсказка ДО сохранения: занятый слот — это обмен или
      // вытеснение, а не тихая замена (см. toastSlotSwap после сохранения).
      const slots = (Prov.data && Prov.data.slots) || {};
      const holder = slots[slot] || null;
      const card = ProvDetail.data || provById(ProvDetail.id) || {};
      const old = card.slot || null;
      if (holder && holder !== ProvDetail.id) {
        if (old) note.textContent = `«${provName(ProvDetail.id)}» и «${provName(holder)}» поменяются местами: «${provName(holder)}» уедет на «${slotLabelOf(old)}».`;
        else note.textContent = `Слот «${slotLabelOf(slot)}» сейчас держит «${provName(holder)}» — он больше не будет использоваться.`;
      } else {
        note.textContent = `Провайдер встанет в слот «${slotLabelOf(slot)}».`;
      }
    }
  }
  provDetailMarkDirty();
}

function provKvHTML(label, value, mono) {
  return `<div class="a-kvline"><span>${esc(label)}</span><b${mono ? ' class="mono"' : ""}>${value}</b></div>`;
}

function screenProviderPage(id) {
  const p = provById(id);
  if (!p) {
    // Прямая ссылка на удалённого провайдера — честная карточка, а не пустая
    // страница: адрес мог остаться в закладках.
    renderShell("providers", `
      <div class="a-card">
        <div class="a-card__title">Провайдер не найден</div>
        <div class="a-card__sub" style="margin:8px 0 14px">«${esc(id)}» нет в списке: его удалили или ссылка устарела.</div>
        <a class="btn btn--primary btn--sm" href="#/providers">К провайдерам</a>
      </div>`);
    return;
  }
  ProvDetail.id = id;
  ProvDetail.models = null;
  ProvDetail.loading = false;
  ProvDetail.probing = false;
  ProvDetail.pinging = false;
  ProvDetail.model = p.model || "";
  ProvDetail.error = null;
  ProvDetail.verdict = "";
  ProvDetail.ping = null;
  ProvDetail.current = { model: p.model || "", modelTitle: p.modelTitle || "" };
  ProvDetail.chain = Object.assign({ high: null, medium: null, low: null }, p.modelSlots || {});
  // Нет записи цепочки (база до фичи) — показываем одиночную как high, чтобы
  // вид совпадал с тем, что реально поедет в запросы.
  if (!ProvDetail.chain.high && !ProvDetail.chain.medium && !ProvDetail.chain.low && p.model) {
    ProvDetail.chain.high = p.model;
  }
  ProvDetail.chainSaved = Object.assign({}, ProvDetail.chain);
  ProvDetail.chainSavedTitles = Object.assign({}, p.modelTitles || {});
  ProvDetail.data = p;

  const [dot, dotLabel] = provHealth(p);
  const check = p.lastCheck;
  const checkLine = check
    ? (check.ok ? `живой ответ за ${fmtNum(check.latencyMs)} мс · ${provRel(check.at)}`
                : `недоступен: ${check.error || "—"} · ${provRel(check.at)}`)
    : "ручной проверки ещё не было";
  const title = p.modelTitle || "";

  renderShell("providers", `
    <div class="a-page-head">
      <a class="a-back" href="#/providers" title="К списку провайдеров">${aicon("chevron")} <span>Провайдеры</span></a>
      <div class="a-page-head__main">
        <span class="a-dot a-dot--${dot}"></span>
        <div class="a-page-title-wrap">
          <h1 class="a-page-title">${esc(p.title || p.id)}</h1>
          <div class="a-page-sub mono">${esc(p.id)}</div>
        </div>
        <div class="a-page-badges">
          ${p.builtin ? '<span class="a-chip">встроенный</span>' : '<span class="a-chip a-chip--accent">свой</span>'}
          ${p.protocol === "responses" ? '<span class="a-chip a-chip--accent" title="Новый формат OpenAI: instructions + input, ответ массивом output">Responses API</span>' : ""}
          ${p.protocol === "anthropic" ? '<span class="a-chip a-chip--accent" title="Формат Anthropic Messages: ключ в x-api-key, system отдельным полем">Anthropic</span>' : ""}
          ${p.active ? '<span class="a-chip a-chip--success">активный</span>' : ""}
          ${p.enabled ? "" : '<span class="a-chip a-chip--warn">выключен</span>'}
          ${p.modelOverridden ? '<span class="a-chip a-chip--warn">модель изменена</span>' : ""}
          ${p.modelTitleMissing ? '<span class="a-chip a-chip--warn" title="Без названия ученик не увидит, какой моделью проверено сочинение">нет названия</span>' : ""}
        </div>
      </div>
      <div class="a-page-status">
        <span class="a-page-status__item"><i class="a-dot a-dot--${dot}"></i> ${esc(dotLabel)}</span>
        <span class="a-page-status__item">${esc(checkLine)}</span>
        <span class="a-page-status__item">${p.recent ? "сейчас отвечает ученикам" : "сейчас не используется"}</span>
      </div>
    </div>

    <div class="a-page-grid">
      <div class="a-page-col">
        <section class="a-card">
          <div class="a-card__head">
            <span class="a-card__title">Модель для проверок</span>
            <span class="spacer"></span>
            <button class="btn btn--soft btn--sm" id="provModelsBtn" type="button">${aicon("list")} Список моделей</button>
            <button class="btn btn--soft btn--sm" id="provModelProbeBtn" type="button">${aicon("pulse")} Проверить</button>
          </div>
          <div class="a-form-grid">
            <div class="a-field">
              <label for="provDetailModel">ID модели у провайдера</label>
              <input class="a-input mono" id="provDetailModel" value="${esc(p.model || "")}" autocomplete="off" spellcheck="false">
              <span class="a-field__hint" id="provModelHint"></span>
            </div>
            <div class="a-field">
              <label for="provDetailModelTitle">Название для ученика</label>
              <input class="a-input" id="provDetailModelTitle" value="${esc(title)}" placeholder="например: топ модель" autocomplete="off">
              <span class="a-field__hint" id="provTitleHint"></span>
            </div>
          </div>
          <div id="provModelProbeResult">${ProvDetail.verdict}</div>
        </section>

        <section class="a-card">
          <div class="a-card__head">
            <span class="a-card__title">Цепочка моделей</span>
            <span class="spacer"></span>
            <span class="a-card__sub" id="provChainNote"></span>
          </div>
          <div class="a-card__sub" style="margin-bottom:10px">Порядок попыток внутри провайдера: сначала «Высокий», затем «Средний», затем «Низкий». Пустой слот пропускается. Занятый приоритет не вытесняет молча — модели поменяются местами, а вытесненная без своего слота из цепочки уйдёт.</div>
          <div class="a-chain-order" id="provChainOrder"></div>
          <div id="provChainBox"></div>
          <datalist id="provChainData"></datalist>
        </section>

        <section class="a-card">
          <div class="a-card__head">
            <span class="a-card__title">Модели провайдера</span>
            <span class="spacer"></span>
            <input class="a-input a-input--search" id="provModelFilter" placeholder="Поиск по названию…" autocomplete="off" spellcheck="false">
            <button class="btn btn--primary btn--sm" id="provPingModelsBtn" type="button">${aicon("pulse")} Пинг всех моделей <span class="a-btn__note">20 с</span></button>
          </div>
          <div id="provModelPingResult">${provPingBoxHTML(false)}</div>
          <div id="provModelList" class="a-models"></div>
        </section>

        <section class="a-card">
          <div class="a-card__head">
            <span class="a-card__title">Место в очереди</span>
            <span class="spacer"></span>
            <span class="a-card__sub" id="provSlotNote"></span>
          </div>
          <div id="provSlotSeg">${provSlotSegHTML(p.slot || "")}</div>
        </section>
      </div>

      <div class="a-page-col a-page-col--side">
        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">Подключение</span></div>
          ${provKvHTML("Адрес", esc(p.baseHost || p.baseUrl || "—"), true)}
          ${provKvHTML("Ключ", p.keySet ? `задан <span class="mono">${esc(p.keyHint || "")}</span>` : "не задан")}
          ${provKvHTML("Авторизация", p.auth === "raw" ? "сырой ключ" : "Bearer")}
          ${provKvHTML("Протокол", esc(provProtoLabel(p.protocol)))}
          ${p.reasoningEffort ? provKvHTML("Мышление", esc(provEffortLabel(p.reasoningEffort))) : ""}
          <details class="a-fold"${p.builtin ? "" : " open"}>
            <summary>Изменить адрес, ключ и quirks</summary>
            ${p.builtin ? "" : `<div class="a-field">
              <label>Шаблон API</label>
              <div id="provProtoSeg">${provProtoSegHTML(p.protocol || "chat", "setDetailProto")}</div>
              <span class="a-field__hint">Шаблон меняет поля формы: у Responses API и Anthropic свой формат запросов, им нужны заголовки и не нужна подклейка system.</span>
            </div>`}
            <div class="a-field">
              <label for="provDetailBaseUrl">Base URL</label>
              <input class="a-input mono" id="provDetailBaseUrl" value="${esc(p.baseUrl || "")}" autocomplete="off" spellcheck="false">
            </div>
            <div class="a-field">
              <label for="provDetailKey">API-ключ</label>
              <input class="a-input mono" id="provDetailKey" type="password" placeholder="${p.keySet ? esc(`задан ${p.keyHint || ""} — пусто = не менять`) : "не задан"}" autocomplete="off">
              <span class="a-field__hint">Ключ никогда не отдаётся в браузер целиком.</span>
            </div>
            ${p.builtin ? "" : `<div class="a-field">
              <label>Уровень мышления</label>
              <div id="provEffortSeg">${provEffortSegHTML(p.reasoningEffort || "", "setDetailEffort")}</div>
              <span class="a-field__hint" id="provEffortNote">${provEffortNote(p.reasoningEffort || "")}</span>
            </div>`}
            <label class="a-check"><input type="checkbox" id="provWallet"${p.useWalletBalance ? " checked" : ""}> <span>Списывать предоплату кошелька (useWalletBalance)</span></label>
            <div class="chat-only"${(!p.builtin && provProtoOf(p.protocol) !== "chat") ? " hidden" : ""}><label class="a-check"><input type="checkbox" id="provMerge"${p.mergeSystem ? " checked" : ""}> <span>Подклеивать system-промпт к user (маршруты вроде anthropic)</span></label></div>
            ${p.builtin ? "" : `<div class="resp-only"${provProtoOf(p.protocol) !== "chat" ? "" : " hidden"}>
              <div class="a-pnl__note">Для Responses API и Anthropic подклейка не применяется — system едет отдельным полем (instructions или system).</div>
            </div>
            <div class="a-field" style="margin-top:10px">
              <label>Доп. заголовки HTTP</label>
              <div id="provHeaders">${provHeadersHTML(p.extraHeaders || {})}</div>
              <div class="a-actions-row" style="margin-top:8px">
                <button class="btn btn--soft btn--sm" type="button" onclick="provHeaderAdd('provHeaders')">+ Заголовок</button>
              </div>
              <span class="a-field__hint">Шлются при любом шаблоне — без них шлюз может не пустить. Секретам здесь не место — значения видны в админке.</span>
            </div>`}
          </details>
          <div class="a-pnl__note">${p.builtin
            ? "Стандартные значения встроенного провайдера берутся из окружения сервера. Здесь можно наложить свои — они переживут рестарт, а «Сбросить» вернёт окружение."
            : "Стандартные значения — те, с которыми провайдер был добавлен. «Сбросить» вернёт их вместе с моделью и названием."}</div>
        </section>

        <section class="a-card">
          <div class="a-card__head"><span class="a-card__title">В ротации</span></div>
          ${provKvHTML("Приоритет", p.slot ? esc(p.slotLabel || p.slot) : "без приоритета")}
          ${provKvHTML("Активный", p.active ? "да — новые запросы идут сюда" : (Prov.data && Prov.data.active ? esc(provName(Prov.data.active)) : "нет"))}
          ${provKvHTML("Успех", p.lastOkAt ? esc(provRel(p.lastOkAt)) : "—")}
          ${p.lastError ? provKvHTML("Последняя ошибка", `<span class="a-prov-err">${esc(p.lastError)}</span>`) : ""}
          ${(p.warnings || []).map((w) => `<div class="a-prov-warn">${esc(w)}</div>`).join("")}
        </section>

        <section class="a-card a-card--danger">
          <div class="a-card__head"><span class="a-card__title">Опасная зона</span></div>
          <div class="a-card__sub">Сброс возвращает стандартные значения, удаление убирает провайдера из ротации.</div>
          <div class="a-actions-row">
            <button class="btn btn--soft btn--sm" id="provResetBtn" type="button">${aicon("reset")} Сбросить к стандартным</button>
            <button class="btn btn--soft btn--sm" id="provDetailDelete" type="button">${aicon("trash")} Удалить провайдера</button>
          </div>
        </section>
      </div>
    </div>

    <div class="a-sticky-actions">
      <span class="a-modal__error" id="provDetailError" hidden></span>
      <span class="a-sticky-actions__state" id="provApplyState"></span>
      <span class="spacer"></span>
      <a class="btn btn--soft btn--sm" href="#/providers">Отмена</a>
      <button class="btn btn--primary btn--sm" id="provDetailApply" type="button">Сохранить</button>
    </div>`);

  // --- обработчики ---
  const bind = (elId, handler) => {
    const el = document.getElementById(elId);
    if (el) el.onclick = handler;
  };
  bind("provModelsBtn", loadProviderModels);
  bind("provModelProbeBtn", probeProviderModel);
  bind("provPingModelsBtn", pingProviderModels);
  bind("provDetailApply", applyProviderDetail);
  // Именно обёртка: напрямую `onclick = resetProvider` передало бы СОБЫТИЕ в
  // аргумент id, и сброс ушёл бы на провайдера «[object PointerEvent]».
  bind("provResetBtn", () => resetProvider());
  bind("provDetailDelete", () => deleteProvider(id));
  const filter = document.getElementById("provModelFilter");
  if (filter) filter.oninput = () => provDetailRenderList();
  const modelInput = document.getElementById("provDetailModel");
  if (modelInput) modelInput.oninput = () => {
    ProvDetail.model = modelInput.value.trim();
    const high = document.getElementById("provChain_high");
    if (high && high.value !== modelInput.value) high.value = modelInput.value;
    provDetailRenderList(); provDetailMarkDirty();
  };
  const titleInput = document.getElementById("provDetailModelTitle");
  if (titleInput) titleInput.oninput = () => {
    const high = document.getElementById("provChainTitle_high");
    if (high && high.value !== titleInput.value) high.value = titleInput.value;
    provDetailMarkDirty();
  };
  provChainRender();
  provDetailRenderList();
  provDetailMarkDirty();
}

/* ---------------- Цепочка моделей: high → medium → low ----------------
   Тот же принцип, что очередь провайдеров, но внутри одного шлюза: первой
   пробуем модель из «Высокого», затем «Среднего», затем «Низкого». Слоты
   рисуются тремя строками с полями ввода (datalist из списка моделей
   провайдера), стрелками ↑/↓ для обмена соседних и крестиком для очистки.
   Выбор из списка/рейтинга кладёт модель в первый пустой слот (а не затирает
   верх): иначе один клик сносил бы настроенную цепочку. Сохранение — той же
   кнопкой «Сохранить», дубли на сохранении превращаются в обмен, а не в
   ошибку, если moved-модель пришла из другого слота. */

const PROV_CHAIN_SLOTS = [
  { id: "high", label: "Высокий", hint: "пробуем первой" },
  { id: "medium", label: "Средний", hint: "если первая отказала" },
  { id: "low", label: "Низкий", hint: "в самом конце" },
];

function provChainDraft() {
  const out = { high: null, medium: null, low: null };
  PROV_CHAIN_SLOTS.forEach((s) => {
    const el = document.getElementById(`provChain_${s.id}`);
    const v = el ? el.value.trim() : "";
    out[s.id] = v || null;
  });
  return out;
}

function provChainResolveDuplicates(draft, saved) {
  // Дубли на сохранении — это почти всегда «перенёс модель в другой слот,
  // а старый не почистил»: если дублирующаяся модель пришла из другого слота
  // сохранённой цепочки — меняем их местами, а не ругаемся. Новая модель в
  // двух слотах сразу — честная ошибка (намерение не прочитать).
  const out = Object.assign({}, draft);
  const seen = {};
  let dup = null;
  PROV_CHAIN_SLOTS.forEach((s) => {
    const v = out[s.id];
    if (!v) return;
    if (seen[v]) { dup = v; return; }
    seen[v] = s.id;
  });
  if (!dup) return { slots: out, swapped: false };
  const from = PROV_CHAIN_SLOTS.map((s) => s.id).find((k) => (saved || {})[k] === dup) || null;
  const to = PROV_CHAIN_SLOTS.map((s) => s.id).find((k) => out[k] === dup) || null;
  const holders = PROV_CHAIN_SLOTS.map((s) => s.id).filter((k) => out[k] === dup);
  if (holders.length === 2 && from && holders.indexOf(from) >= 0) {
    const other = holders.find((k) => k !== to);
    const oldTop = (saved || {})[to] || null;
    out[other] = oldTop;
    return { slots: out, swapped: true };
  }
  return { slots: out, swapped: false, duplicate: dup };
}

function provChainRender() {
  const box = document.getElementById("provChainBox");
  if (!box) return;
  const chain = (ProvDetail.chainSaved && ProvDetail.id) ? provChainDraft() : provChainDraft();
  const saved = ProvDetail.chainSaved || {};
  // Первый рендер: значения из сохранённой цепочки.
  if (!box.dataset.built) {
    box.dataset.built = "1";
    const savedTitles = ProvDetail.chainSavedTitles || {};
    box.innerHTML = PROV_CHAIN_SLOTS.map((s, i) => `
      <div class="a-chain-row" data-chain-slot="${s.id}">
        <span class="a-chain-no" title="Порядок попыток">${i + 1}</span>
        <span class="a-chain-badge" title="${esc(s.hint)}">${esc(s.label)}</span>
        <input class="a-input mono a-chain-input" id="provChain_${s.id}"
          list="provChainData" autocomplete="off" spellcheck="false"
          placeholder="модель для «${esc(s.label.toLowerCase())}» приоритета"
          value="${esc((ProvDetail.chain && ProvDetail.chain[s.id]) || "")}">
        <input class="a-input a-chain-title" id="provChainTitle_${s.id}"
          autocomplete="off" placeholder="Название для ученика"
          title="Что увидит ученик в строке «проверено моделью» — без названия строка не появится"
          value="${esc(savedTitles[(ProvDetail.chain && ProvDetail.chain[s.id]) || ""] || "")}">
        <span class="a-chain-btns">
          <button type="button" class="a-icon-btn" onclick="moveChainSlot('${s.id}', -1)" title="Выше (поменяться с соседом)">↑</button>
          <button type="button" class="a-icon-btn" onclick="moveChainSlot('${s.id}', 1)" title="Ниже (поменяться с соседом)">↓</button>
          <button type="button" class="a-icon-btn a-icon-btn--danger" onclick="clearChainSlot('${s.id}')" title="Очистить слот">✕</button>
        </span>
      </div>
      <div class="a-chain-sub" id="provChainSub_${s.id}"></div>`).join("");
    PROV_CHAIN_SLOTS.forEach((s) => {
      const el = document.getElementById(`provChain_${s.id}`);
      if (el) {
        el.addEventListener("input", () => {
          // Верх цепочки и поле модели — одно и то же: правим в обе стороны,
          // чтобы сервер не отклонил сохранение как рассинхрон.
          if (s.id === "high") {
            const main = document.getElementById("provDetailModel");
            if (main && main.value !== el.value) { main.value = el.value; ProvDetail.model = el.value.trim(); }
          }
          provChainPaintOrder(); provDetailMarkDirty(); provChainPaintData();
        });
        el.addEventListener("change", () => {
          // Подтягиваем известное название модели, пустое не затираем:
          // человек мог уже вписать своё.
          const t = document.getElementById(`provChainTitle_${s.id}`);
          if (t && !t.value.trim()) {
            const known = (ProvDetail.data && ProvDetail.data.modelTitles) || {};
            if (known[el.value.trim()]) t.value = known[el.value.trim()];
          }
          if (s.id === "high") syncHighTitle();
          provChainPaintOrder(); provDetailMarkDirty();
        });
      }
      const tel = document.getElementById(`provChainTitle_${s.id}`);
      if (tel) {
        tel.addEventListener("input", () => {
          if (s.id === "high") {
            const main = document.getElementById("provDetailModelTitle");
            if (main && main.value !== tel.value) main.value = tel.value;
          }
          provDetailMarkDirty();
        });
      }
    });
  }
  provChainPaintOrder();
  provChainPaintData();
}

/* Верх цепочки и поле «Название для ученика» — одно и то же: правим в обе
   стороны, иначе сохранение повезёт рассинхрон. */
function syncHighTitle() {
  const high = document.getElementById("provChainTitle_high");
  const main = document.getElementById("provDetailModelTitle");
  if (high && main && main.value !== high.value) main.value = high.value;
}

function provChainDraftTitles() {
  const out = {};
  PROV_CHAIN_SLOTS.forEach((s) => {
    const m = document.getElementById(`provChain_${s.id}`);
    const t = document.getElementById(`provChainTitle_${s.id}`);
    const model = m ? m.value.trim() : "";
    if (model) out[model] = t ? t.value.trim() : "";
  });
  return out;
}

function provChainPaintOrder() {
  const orderBox = document.getElementById("provChainOrder");
  const note = document.getElementById("provChainNote");
  const draft = provChainDraft();
  const order = PROV_CHAIN_SLOTS.map((s) => s.id).map((k) => draft[k]).filter(Boolean);
  if (orderBox) {
    orderBox.innerHTML = order.length
      ? order.map((m, i) => `${i ? '<span class="a-prov-arrow">→</span>' : ""}<span class="a-chip${i === 0 ? " a-chip--success" : ""}" title="Попытка ${i + 1}">${i + 1}. ${esc(m)}</span>`).join("")
      : `<span class="a-card__sub">Цепочка пуста — проверки через провайдер не пойдут.</span>`;
  }
  if (note) {
    const saved = ProvDetail.chainSaved || {};
    const dirty = PROV_CHAIN_SLOTS.some((s) => (draft[s.id] || null) !== (saved[s.id] || null));
    note.textContent = dirty ? "есть несохранённые изменения" : "";
  }
  // Под каждым слотом — честная подсказка про название: без него проверка этой
  // моделью пройдёт, но строка «проверено моделью» ученику не покажется.
  const savedTitles = ProvDetail.chainSavedTitles || {};
  const draftTitles = provChainDraftTitles();
  PROV_CHAIN_SLOTS.forEach((s) => {
    const sub = document.getElementById(`provChainSub_${s.id}`);
    if (!sub) return;
    const model = draft[s.id];
    if (!model) { sub.textContent = ""; return; }
    const title = (draftTitles[model] || "").trim();
    const was = (savedTitles[model] || "").trim();
    if (!title) {
      sub.innerHTML = `Без названия строка на экране результата не появится. <button type="button" class="a-linkbtn" onclick="provChainUseSavedTitle('${s.id}')">Взять «${esc(was || "—")}»</button>`;
      if (!was) sub.textContent = "Без названия строка на экране результата не появится.";
    } else if (title !== was) {
      sub.textContent = `Ученик увидит: «${title}» (было: «${was || "—"}»)`;
    } else {
      sub.textContent = `Ученик увидит: «${title}»`;
    }
  });
}

function provChainUseSavedTitle(slot) {
  const t = document.getElementById(`provChainTitle_${slot}`);
  const m = document.getElementById(`provChain_${slot}`);
  if (!t || !m) return;
  t.value = ((ProvDetail.chainSavedTitles || {})[m.value.trim()] || "");
  if (slot === "high") syncHighTitle();
  provDetailMarkDirty();
}

function provChainPaintData() {
  const data = document.getElementById("provChainData");
  if (!data) return;
  const seen = {};
  const opts = [];
  const push = (m) => {
    const v = String(m || "").trim();
    if (v && !seen[v]) { seen[v] = true; opts.push(v); }
  };
  Object.values(provChainDraft()).forEach(push);
  Object.values(ProvDetail.chainSaved || {}).forEach(push);
  ((ProvDetail.models && ProvDetail.models.models) || []).forEach(push);
  Object.keys((ProvDetail.ping && ProvDetail.ping.results) || {}).forEach(push);
  if (ProvDetail.model) push(ProvDetail.model);
  data.innerHTML = opts.map((m) => `<option value="${esc(m)}">`).join("");
}

function moveChainSlot(slot, dir) {
  const ids = PROV_CHAIN_SLOTS.map((s) => s.id);
  const i = ids.indexOf(slot);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  const a = document.getElementById(`provChain_${ids[i]}`);
  const b = document.getElementById(`provChain_${ids[j]}`);
  if (!a || !b) return;
  const tmp = a.value;
  a.value = b.value;
  b.value = tmp;
  // Названия едут вместе с моделями — иначе подпись прилипла бы к чужому слоту.
  const ta = document.getElementById(`provChainTitle_${ids[i]}`);
  const tb = document.getElementById(`provChainTitle_${ids[j]}`);
  if (ta && tb) { const t = ta.value; ta.value = tb.value; tb.value = t; }
  if (ids[i] === "high" || ids[j] === "high") {
    const main = document.getElementById("provDetailModel");
    const high = document.getElementById("provChain_high");
    if (main && high) { main.value = high.value; ProvDetail.model = high.value.trim(); }
    syncHighTitle();
  }
  provChainPaintOrder();
  provDetailMarkDirty();
}

function clearChainSlot(slot) {
  const el = document.getElementById(`provChain_${slot}`);
  if (!el) return;
  el.value = "";
  const t = document.getElementById(`provChainTitle_${slot}`);
  if (t) t.value = "";
  if (slot === "high") {
    const main = document.getElementById("provDetailModel");
    if (main) { main.value = ""; ProvDetail.model = ""; }
    syncHighTitle();
  }
  provChainPaintOrder();
  provDetailMarkDirty();
}

function provChainFill(model) {
  // Выбор из списка/рейтинга: в первый пустой слот, иначе — вместо «Низкого»
  // (верх не трогаем: он уже настроен и проверен). Уже в цепочке — просто
  // подсвечиваем порядок, дубли не создаём.
  const mid = String(model || "").trim();
  if (!mid) return;
  const draft = provChainDraft();
  const already = PROV_CHAIN_SLOTS.map((s) => s.id).find((k) => draft[k] === mid);
  if (already) { provChainPaintOrder(); return; }
  const empty = PROV_CHAIN_SLOTS.map((s) => s.id).find((k) => !draft[k]);
  const target = empty || "low";
  const el = document.getElementById(`provChain_${target}`);
  if (el) el.value = mid;
  provChainPaintOrder();
  provDetailMarkDirty();
  provChainPaintData();
}

function provName(id) {
  const p = provById(id);
  return (p && (p.title || p.id)) || id;
}

/* Подсказки под полями модели и названия: «сейчас/в окружении» + честная
   отметка «не применено». Без неё выбор модели из списка или из рейтинга
   выглядел бы уже применённым, и человек уходил бы со страницы, не сохранив
   правку. */
function provDetailMarkDirty() {
  const cur = ProvDetail.current || { model: "", modelTitle: "" };
  const card = ProvDetail.data || provById(ProvDetail.id) || {};
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
      ? `Не применено. Ученик увидит: <b>${esc(title.trim() || "ничего — строка не появится")}</b>`
      : "Это увидит ученик на странице результата вместо технического ID. Пусто — строка не появится.";
    thint.classList.toggle("a-field__hint--dirty", titleDirty);
  }
  // Цепочка — часть той же кнопки «Сохранить»: её правка тоже зажигает
  // «есть несохранённые изменения», иначе человек уходил бы, думая, что
  // порядок уже действует. Названия — туда же: без них строка «проверено
  // моделью» не появится, и это тоже несохранённое изменение.
  const saved = ProvDetail.chainSaved || {};
  const savedTitles = ProvDetail.chainSavedTitles || {};
  let chainDirty = false;
  let titlesDirty = false;
  try {
    const draft = provChainDraft();
    chainDirty = PROV_CHAIN_SLOTS.some((s) => (draft[s.id] || null) !== (saved[s.id] || null));
    const draftTitles = provChainDraftTitles();
    titlesDirty = Object.keys(draftTitles).some((m) => (draftTitles[m] || "") !== (savedTitles[m] || ""));
  } catch (e) { chainDirty = false; titlesDirty = false; }
  provChainPaintOrder();
  const state = document.getElementById("provApplyState");
  if (state) {
    const key = (document.getElementById("provDetailKey") || {}).value || "";
    const address = (document.getElementById("provDetailBaseUrl") || {}).value || "";
    const slotBtn = document.querySelector("#provSlotSeg .a-seg2__btn--on");
    const slotChanged = (card.slot || "") !== ((slotBtn && slotBtn.dataset.slot) || "");
    // Шаблон, мышление и заголовки — тоже несохранённые изменения: без этого
    // человек уходил бы, думая, что новый формат уже действует.
    const protoBtn = document.querySelector("#provProtoSeg .a-seg2__btn--on");
    const protoChanged = !!document.getElementById("provProtoSeg")
      && (card.protocol || "chat") !== ((protoBtn && protoBtn.dataset.proto) || "chat");
    const effortBtn = document.querySelector("#provEffortSeg .a-seg2__btn--on");
    const effortChanged = !!document.getElementById("provEffortSeg")
      && (card.reasoningEffort || "") !== ((effortBtn && effortBtn.dataset.effort) || "");
    let headersChanged = false;
    try {
      const saved = card.extraHeaders || {};
      const draft = document.getElementById("provHeaders") ? provHeadersRead("provHeaders") : saved;
      const keys = (o) => Object.keys(o || {}).sort();
      headersChanged = !!document.getElementById("provHeaders")
        && (keys(saved).join("\n") !== keys(draft).join("\n")
          || keys(saved).some((k) => String(saved[k] || "") !== String(draft[k] || "")));
    } catch (e) { headersChanged = false; }
    state.textContent = (modelDirty || titleDirty || key.trim() || address.trim() !== (card.baseUrl || "") || slotChanged || chainDirty || titlesDirty || protoChanged || effortChanged || headersChanged)
      ? "Есть несохранённые изменения" : "";
    state.classList.toggle("a-sticky-actions__state--on", !!state.textContent);
  }
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
    ? ["provModelsBtn", "Список моделей"]
    : ["provModelProbeBtn", "Проверить"];
  const btn = document.getElementById(map[0]);
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy ? `${aicon("pulse")} ${esc(label)}` : `${aicon(which === "models" ? "list" : "pulse")} ${esc(map[1])}`;
}

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

/* Список моделей: карточками-строками с точкой вердикта и задержкой, а не
   нативным <select size=8> — тот выглядел в админке как чужой старый дизайн и
   не давал ни фильтра, ни отметки выбранного. */
function provDetailRenderList() {
  const box = document.getElementById("provModelList");
  if (!box) return;
  const d = ProvDetail;
  if (d.loading) {
    box.innerHTML = `<div class="a-skeleton" style="height:38px"></div><div class="a-skeleton" style="height:38px;margin-top:8px"></div><div class="a-skeleton" style="height:38px;margin-top:8px"></div>`;
    return;
  }
  if (!d.models) {
    box.innerHTML = `<div class="a-models__empty">Список берётся у провайдера живым запросом: нажми «Список моделей» или впиши модель вручную.</div>`;
    return;
  }
  const filter = ((document.getElementById("provModelFilter") || {}).value || "").trim().toLowerCase();
  const ping = (d.ping && d.ping.results) || {};
  const all = d.models.models || [];
  const list = filter ? all.filter((m) => String(m).toLowerCase().includes(filter)) : all;
  if (!all.length) {
    box.innerHTML = `<div class="a-prov-checkbad">Провайдер вернул пустой список моделей.</div>`;
    return;
  }
  const head = `<div class="a-models__bar">
      <span class="a-card__sub">${list.length === all.length
        ? `${fmtNum(all.length)} моделей от провайдера${d.models.latencyMs ? ` · список пришёл за ${fmtNum(d.models.latencyMs)} мс` : ""}`
        : `найдено ${fmtNum(list.length)} из ${fmtNum(all.length)}`}${d.models.truncated ? " · список обрезан" : ""}</span>
    </div>`;
  if (!list.length) {
    box.innerHTML = head + `<div class="a-models__empty">Ничего не нашлось по «${esc(filter)}».</div>`;
    return;
  }
  const skip = new Set();   // отсекаем хвост ради скорости отрисовки, честно сообщая об этом
  const shown = list.slice(0, PROV_MODEL_RENDER_MAX);
  box.innerHTML = head + shown.map((m) => {
    const mid = String(m);
    const isCur = (d.models.current === mid) || (d.model === mid);
    const v = ping[mid];
    const dot = v ? (v.ok ? "ok" : (v.pending ? "idle" : "bad")) : "idle";
    const note = v ? (v.ok ? `${fmtNum(v.latencyMs)} мс` : (v.pending ? "проверяем…" : (v.error || "недоступна"))) : "";
    return `<button type="button" class="a-model${isCur ? " a-model--picked" : ""}"
        data-model="${esc(mid)}" onclick="pickProviderModel(this.dataset.model)" title="${esc(mid)}">
      <span class="a-dot a-dot--${dot}"></span>
      <span class="a-model__name mono">${esc(mid)}</span>
      ${v && !v.pending ? `<span class="a-chip a-chip--accent">${esc(note)}</span>` : ""}
      ${v && v.ok && v.protocol && v.protocol !== "chat" ? `<span class="a-chip" title="Модель ответила по этому протоколу">${esc(provProtoLabel(v.protocol))}</span>` : ""}
      ${isCur ? '<span class="a-chip a-chip--success">сейчас</span>' : '<span class="a-model__pick">выбрать</span>'}
    </button>`;
  }).join("") + (list.length > shown.length
    ? `<div class="a-models__empty">Показаны первые ${fmtNum(shown.length)} — уточни поиск, чтобы увидеть остальные.</div>`
    : "");
}

function pickProviderModel(model) {
  ProvDetail.model = model;
  // Модель, которая ответила по другому протоколу (Claude — по Anthropic), сразу
  // ставит свой шаблон: иначе выбор модели оставлял бы несовместимый формат.
  const seen = ((ProvDetail.ping && ProvDetail.ping.results) || {})[model];
  if (seen && seen.ok && seen.protocol) setDetailProto(seen.protocol);
  const el = document.getElementById("provDetailModel");
  if (el) el.value = model;
  // Верх цепочки — та же модель: выбор из списка/рейтинга ставит приоритет
  // «Высокий», а не просто правит поле (иначе цепочка и поле разъехались бы и
  // сервер отклонил бы сохранение как «модель не совпадает с верхом»).
  const high = document.getElementById("provChain_high");
  if (high) high.value = model;
  // Название вводится заново под каждую модель: известное подставляем, иначе
  // поле пустеет — иначе новая модель унаследовала бы чужую подпись.
  const known = ((ProvDetail.data && ProvDetail.data.modelTitles) || {})[model] || "";
  const titleEl = document.getElementById("provDetailModelTitle");
  if (titleEl) titleEl.value = known;
  const highTitle = document.getElementById("provChainTitle_high");
  if (highTitle) highTitle.value = known;
  provChainPaintOrder();
  provDetailRenderList();
  provDetailSetVerdict("");
  provDetailMarkDirty();
}

async function loadProviderModels() {
  const id = ProvDetail.id;
  if (!id || ProvDetail.loading) return;
  provDetailError("");
  ProvDetail.loading = true;
  provDetailSetLoading("models", true, "Загружаем…");
  provDetailRenderList();
  try {
    const r = await AdminApi.get(`/api/admin/providers/${encodeURIComponent(id)}/models` + provTierQS());
    ProvDetail.models = { models: (r && r.models) || [], total: r && r.total, truncated: !!(r && r.truncated), current: (r && r.current) || "", latencyMs: r && r.latencyMs };
    if (!ProvDetail.models.models.length && ProvDetail.model) {
      // Шлюз не отдаёт текущую модель в списке — показываем её вручную, иначе
      // список выглядел бы пустым у рабочего провайдера.
      ProvDetail.models.models = [ProvDetail.model];
      ProvDetail.models.manualOnly = true;
    }
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    ProvDetail.error = e.message || "ошибка";
    provDetailError(e.retryAfter
      ? `Список у провайдера недавно запрашивали — повтори через ${e.retryAfter} с.`
      : `Список моделей не получен: ${ProvDetail.error}. Модель можно вписать вручную.`);
  } finally {
    ProvDetail.loading = false;
    provDetailSetLoading("models", false, "");
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
  provDetailSetVerdict(`<div class="a-card__sub">Проверяем модель живым запросом «привет»…</div>`);
  try {
    const r = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/probe-model`, provTierBody({ model }));
    const p = r && r.probe;
    // Перебор протоколов на сервере: если модель ответила не сохранённым шаблоном,
    // он выставляется сам — сохранение провайдера закрепит его.
    const before = currentProto("provProtoSeg");
    if (p && p.ok && p.protocol) setDetailProto(p.protocol);
    const via = p && p.ok && p.protocol && p.protocol !== before
      ? ` Шаблон переключён на ${esc(provProtoLabel(p.protocol))} — сохрани провайдера.` : "";
    if (p && p.ok) provVerdictOk(`Модель <span class="mono">${esc(model)}</span> отвечает (${fmtNum(p.latencyMs)} мс). Её можно применять.${via}`);
    else provVerdictBad(`Модель <span class="mono">${esc(model)}</span> не отвечает: ${esc((p && p.error) || "ошибка")}. Применить её можно, но проверки работать не будут.`);
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    if (e.retryAfter) provDetailSetVerdict(`<div class="a-prov-hint">Модель только что проверяли — повтори через ${e.retryAfter} с.</div>`);
    else provVerdictBad(esc(e.message || "ошибка проверки"));
  } finally {
    ProvDetail.probing = false;
    provDetailSetLoading("probe", false, "");
  }
}

async function applyProviderDetail() {
  const id = ProvDetail.id;
  if (!id) return;
  const btn = document.getElementById("provDetailApply");
  provDetailError("");
  const payload = provTierBody({
    model: provDetailModelInput(),
    base_url: (document.getElementById("provDetailBaseUrl") || {}).value || "",
    model_title: ((document.getElementById("provDetailModelTitle") || {}).value || "").trim(),
  });
  // Приоритет, quirks и адрес едут ТОЙ ЖЕ кнопкой: иначе модель применилась бы
  // мгновенно, а слот — только после второго запроса, и между ними ученик
  // получил бы провайдера по старому порядку.
  const onSlot = document.querySelector("#provSlotSeg .a-seg2__btn--on");
  payload.slot = onSlot ? (onSlot.dataset.slot || "") : "";
  const key = (document.getElementById("provDetailKey") || {}).value;
  if (key && key.trim()) payload.api_key = key.trim();
  payload.use_wallet_balance = !!(document.getElementById("provWallet") || {}).checked;
  payload.merge_system = !!(document.getElementById("provMerge") || {}).checked;
  // Шаблон, мышление и заголовки — той же кнопкой (свой провайдер; у
  // встроенного этих полей нет и сервер их не примет). Заголовки едут при
  // любом шаблоне: шлюз может требовать их и для chat (opencode без
  // x-opencode-session не пускает ни один протокол).
  if (!((ProvDetail.data || {}).builtin)) {
    payload.protocol = currentProto("provProtoSeg");
    payload.reasoning_effort = currentEffort("provEffortSeg");
    payload.extra_headers = provHeadersRead("provHeaders");
  }
  if (!payload.model) { provDetailError("Впиши ID модели — без нее провайдер не сможет отвечать"); return; }
  // Цепочка — той же кнопкой: верх обязан совпадать с полем модели (иначе
  // сервер отклонит как рассинхрон), дубли от одного переноса — обмен.
  // Названия едут картой {модель: название} — у каждого слота своя подпись
  // для ученика, без неё строка «проверено моделью» не появится.
  let draft = null;
  try { draft = provChainDraft(); } catch (e) { draft = null; }
  if (draft) {
    const resolved = provChainResolveDuplicates(draft, ProvDetail.chainSaved || {});
    if (resolved.duplicate) { provDetailError(`Модель «${resolved.duplicate}» уже есть в цепочке — один приоритет на модель`); return; }
    draft = resolved.slots;
    // Поле модели — верх цепочки: правим молча до отправки, чтобы не
    // требовать от человека править одно и то же в двух местах.
    if (draft.high && draft.high !== payload.model) payload.model = draft.high;
    if (!draft.high) draft.high = payload.model;
    payload.model_slots = draft;
    try { payload.model_titles = provChainDraftTitles(); } catch (e) { /* без названий — сервер оставит как было */ }
  }
  if (btn) { btn.disabled = true; btn.textContent = "Сохраняем…"; }
  let res = null;
  try {
    // Сервер НЕ дёргает модель после сохранения: сохранение мгновенное.
    // Проверка — отдельная кнопка выше («Проверить» или «Пинг всех моделей»).
    res = await AdminApi.post(`/api/admin/providers/${encodeURIComponent(id)}/apply`, payload);
    if (!toastSlotSwap(res && res.slotSwap)) {
      if (!toastModelSwap(res && res.modelSwap)) toast("Сохранено");
    } else if (res && res.modelSwap && res.modelSwap.type !== "noop") {
      toastModelSwap(res.modelSwap);
    }
    provDetailSetVerdict("");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    provDetailError(e.message || "ошибка");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Сохранить"; }
  }
  if (!res) return;
  // Список провайдеров перечитываем, страницу НЕ перерисовываем: перерисовка
  // стёрла бы вердикт проверки и напечатанные поля. Обновляем точечно.
  await screenProviders(true);
  const fresh = provById(id);
  if (fresh && ProvDetail.id === id) provDetailSyncFromCard(fresh);
}

/* Точечное обновление полей страницы из свежей карточки: значения, подписи
   «сейчас/в окружении» и название для ученика. Без него после сохранения
   страница показывала бы старые данные. */
function provDetailSyncFromCard(fresh) {
  if (!fresh || !fresh.id) {
    // Провайдера больше нет (удалили в другой вкладке) — честно говорим об
    // этом, а не оставляем страницу с полями удалённой конфигурации.
    toast("Провайдер исчез — возможно, его удалили в другой вкладке", "err");
    navigate("/providers");
    return;
  }
  ProvDetail.data = fresh;
  const model = document.getElementById("provDetailModel");
  if (model) model.value = fresh.model || "";
  const title = document.getElementById("provDetailModelTitle");
  if (title) title.value = fresh.modelTitle || "";
  const base = document.getElementById("provDetailBaseUrl");
  if (base) base.value = fresh.baseUrl || "";
  const key = document.getElementById("provDetailKey");
  if (key) key.value = "";
  const wallet = document.getElementById("provWallet");
  if (wallet) wallet.checked = !!fresh.useWalletBalance;
  const merge = document.getElementById("provMerge");
  if (merge) merge.checked = !!fresh.mergeSystem;
  // Шаблон, мышление и заголовки — из свежей карточки, иначе после сохранения
  // страница показывала бы старые: сегменты перекрашиваем, редактор строк
  // пересобираем целиком (значений в нём больше нет смысла держать).
  const protoBox = document.getElementById("provProtoSeg");
  if (protoBox) protoBox.innerHTML = provProtoSegHTML(fresh.protocol || "chat", "setDetailProto");
  const effortBox = document.getElementById("provEffortSeg");
  if (effortBox) effortBox.innerHTML = provEffortSegHTML(fresh.reasoningEffort || "", "setDetailEffort");
  const effortNote = document.getElementById("provEffortNote");
  if (effortNote) effortNote.textContent = provEffortNote(fresh.reasoningEffort || "");
  const headersBox = document.getElementById("provHeaders");
  if (headersBox) headersBox.innerHTML = provHeadersHTML(fresh.extraHeaders || {});
  paintProtoBlocks(fresh.protocol || "chat");
  const slotBox = document.getElementById("provSlotSeg");
  if (slotBox) slotBox.innerHTML = provSlotSegHTML(fresh.slot || "");
  ProvDetail.model = fresh.model || "";
  // Сохранённое обновляем ДО отметки «не применено»: расходиться с сервером
  // после успешного сохранения нечему, и подсказка должна погаснуть сама.
  ProvDetail.current = { model: fresh.model || "", modelTitle: fresh.modelTitle || "" };
  ProvDetail.chainSaved = Object.assign({ high: null, medium: null, low: null }, fresh.modelSlots || {});
  if (!ProvDetail.chainSaved.high && !ProvDetail.chainSaved.medium && !ProvDetail.chainSaved.low && fresh.model) {
    ProvDetail.chainSaved.high = fresh.model;
  }
  ProvDetail.chain = Object.assign({}, ProvDetail.chainSaved);
  ProvDetail.chainSavedTitles = Object.assign({}, fresh.modelTitles || {});
  ProvDetail.data = Object.assign({}, ProvDetail.data, { modelTitles: fresh.modelTitles || {} });
  const box = document.getElementById("provChainBox");
  if (box) {
    // Значения уже в DOM — обновляем точечно, чтобы не терять фокус.
    PROV_CHAIN_SLOTS.forEach((s) => {
      const el = document.getElementById(`provChain_${s.id}`);
      if (el) el.value = ProvDetail.chainSaved[s.id] || "";
      const tel = document.getElementById(`provChainTitle_${s.id}`);
      if (tel) tel.value = ProvDetail.chainSavedTitles[ProvDetail.chainSaved[s.id] || ""] || "";
    });
  }
  provChainPaintOrder();
  provChainPaintData();
  provDetailMarkDirty();
}

async function resetProvider(id) {
  const target = id || ProvDetail.id;
  if (!target) return;
  if (!confirm(`Сбросить провайдера «${target}» к стандартным значениям?`)) return;
  provDetailError("");
  try {
    await AdminApi.post(`/api/admin/providers/${encodeURIComponent(target)}/reset`, provTierBody({}));
    toast("Возвращены стандартные значения");
      } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    provDetailError(e.message || "ошибка");
  }
  await screenProviders(true);
  const fresh = provById(target);
  if (fresh && ProvDetail.id === target) provDetailSyncFromCard(fresh);
  provDetailSetVerdict("");
}

/* ---------------- корневой рендер ---------------- */

/* ---------------- Подписка: деньги, очередь, выдача ---------------- */

/* Раздел «Подписка» (#/subscription): сводка одним запросом
   GET /api/admin/subscription/overview + выдача листа ожидания.
   Кнопка выдачи — с подтверждением ВВОДОМ ЧИСЛА: мисклик исключён
   (кнопка мертва, пока не введено точное число), повтор разрешён
   (невыданных уже нет — сервер вернёт пусто, а не дубли). */
async function screenSubscription() {
  renderShell("subscription", `<div class="a-skeleton" style="height:90px"></div><div class="a-skeleton" style="height:280px;margin-top:16px"></div>`);
  let data;
  try {
    data = await AdminApi.get("/api/admin/subscription/overview");
  } catch (e) {
    if (e.unauthorized) { A.session = null; renderLogin(); return; }
    renderShell("subscription", `<div class="a-error-banner">Не удалось загрузить подписки: ${esc(e.message)}<button class="btn btn--soft btn--sm" onclick="render()">Повторить</button></div>`);
    return;
  }
  const u = data.users, s = data.subs, m = data.money, w = data.waitlist, cfg = data.config;
  const pr = data.promos || { list: [], total: 0, active: 0, usedTotal: 0 };
  A.lastSub = data;
  const screen = `
    <div class="a-stats">
      ${statTile("Аккаунтов", fmtNum(u.total), `онбординг: ${fmtNum(u.onboarded)}`)}
      ${statTile("Plus активно", fmtNum(u.plusActive), `${u.plusSharePct}% аккаунтов`)}
      ${statTile("Оборот", fmtMoney(m.revenueKopecks), `${fmtNum(m.paidCount)} ${plural(m.paidCount, "оплата", "оплаты", "оплат")}`)}
      ${statTile("Средний чек", fmtMoney(m.avgCheckKopecks), m.paidCount ? "по настоящим платежам" : "оплат пока нет")}
    </div>
    <div class="a-stats" style="margin-top:14px">
      ${statTile("Без продления", fmtNum(s.noRenew), "доступ до конца срока")}
      ${statTile("Истекло", fmtNum(s.expired), "бывших подписок")}
      ${statTile("Возвраты", `${fmtNum(m.refundedCount)} · ${fmtMoney(m.refundedKopecks)}`, "деньги возвращены")}
      ${statTile("Ожидают оплаты", fmtNum(m.pendingCount), "pending-платежи")}
    </div>

    <div class="a-section-title">Поощрения</div>
    <div class="a-card" style="margin-bottom:14px">
      <div class="a-card__head"><span class="a-card__title">Выдать Plus</span><span class="a-card__sub">розыгрыш · условие · компенсация</span></div>
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <div class="a-field"><label for="bonusPeriod">Срок</label>
          <select class="a-select" id="bonusPeriod"><option value="month">Месяц</option><option value="year">Год</option></select>
        </div>
        <div class="a-field"><label for="bonusNote">Повод (попадёт в историю платежей)</label>
          <input class="a-input" id="bonusNote" maxlength="200" placeholder="розыгрыш, условие, компенсация…" autocomplete="off">
        </div>
      </div>
      <div class="a-field" style="margin-top:10px"><label for="bonusRefs">Получатели — account ID, по одному в строке</label>
        <textarea class="a-textarea" id="bonusRefs" rows="3" placeholder="a7k29x&#10;b3m81q" autocomplete="off" spellcheck="false"></textarea>
        <span class="a-field__hint" id="bonusCount">получателей: 0</span>
      </div>
      ${w.pending ? `<label class="a-check"><input type="checkbox" id="bonusWaitlist" checked> <span>Плюс ждущие из старого листа ожидания — ${fmtNum(w.pending)} ${plural(w.pending, "человек", "человека", "человек")} (пометка «выдано» сохранится)</span></label>` : ""}
      <div style="font-size:13.5px;color:var(--text-2);margin-top:12px">Каждому — месяц или год как ручной грант (0 ₽ в истории). У кого Plus уже есть — срок продлится. Неизвестные ID пропускаются с причиной.</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px">
        <button class="btn btn--primary btn--sm" id="bonusBtn">Выдать Plus</button>
        <button class="btn btn--soft btn--sm" onclick="screenSubscription()">Обновить</button>
      </div>
    </div>

    <div class="a-card">
      <div class="a-card__head"><span class="a-card__title">Промокоды</span><span class="a-card__sub">${fmtNum(pr.active)} активны · использований: ${fmtNum(pr.usedTotal)}</span></div>
      <div class="a-card__sub" style="margin-bottom:10px">Скидка применяется к счёту в окне оплаты; код на 100% включает Plus сразу без шлюза. Выключенный код новые счета не даёт, оплаченные чтут.</div>
      ${(pr.list && pr.list.length) ? `<div class="a-paylist">${pr.list.map(promoRowHTML).join("")}</div>`
        : `<div class="a-empty"><div class="a-empty__title">Кодов пока нет</div><div class="a-empty__sub">Создай первый — например, на розыгрыш</div></div>`}
      <div style="margin-top:12px"><button class="btn btn--soft btn--sm" id="promoNewBtn">+ Создать код</button></div>
    </div>

    <div class="a-section-title">Тариф</div>
    <div class="a-card">
      <div class="a-kv">
        <div class="a-kv__item"><div class="a-kv__k">Месяц</div><div class="a-kv__v">${fmtMoney(cfg.priceMonthKopecks)} · календарный месяц</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Год</div><div class="a-kv__v">${fmtMoney(cfg.priceYearKopecks)} · 12 календарных месяцев</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Лимиты <span class="plus">Plus</span></div><div class="a-kv__v">${cfg.plusEssay} проверок · ${cfg.plusAgent} ходов в день</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Бесплатно</div><div class="a-kv__v">${cfg.freeEssay} проверок · ${cfg.freeAgent} ходов в день</div></div>
        <div class="a-kv__item"><div class="a-kv__k">ИИ</div><div class="a-kv__v">${cfg.agentRequiresPlus ? "только <span class=\"plus\">Plus</span>" : "открыт всем"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Ручных грантов</div><div class="a-kv__v">${fmtNum(m.manualGrants)}</div></div>
      </div>
    </div>

    <div class="a-section-title">Последние платежи</div>
    <div class="a-card">
      ${(data.recent && data.recent.length) ? `<div class="a-paylist">${data.recent.map((pm) => `
        <div class="a-payrow">
          <div class="a-payrow__main">
            <div class="a-payrow__t">${pm.accountId ? `<a href="#/users/${esc(pm.accountId)}" class="mono">${esc(pm.accountId)}</a>` : "<span style=\"color:var(--muted)\">—</span>"} · ${pm.period === "year" ? "год" : "месяц"}</div>
            <div class="a-payrow__d">${fmtDateTime(pm.paidAt || pm.createdAt)} · ${payProviderLabel(pm.provider)}</div>
          </div>
          <div class="a-payrow__r"><span>${fmtMoney(pm.amountKopecks)}</span>${subPayChip(pm.status)}</div>
        </div>`).join("")}</div>`
      : `<div class="a-empty"><div class="a-empty__title">Платежей пока нет</div><div class="a-empty__sub">Здесь появятся чеки после первой оплаты или выдачи</div></div>`}
    </div>`;
  renderShell("subscription", screen);
  const refsEl = document.getElementById("bonusRefs");
  const countEl = document.getElementById("bonusCount");
  const recountBonus = () => {
    if (countEl) countEl.textContent = "получателей: " + parseBonusRefs(refsEl ? refsEl.value : "").length;
  };
  if (refsEl) refsEl.addEventListener("input", recountBonus);
  recountBonus();
  const bonusBtn = document.getElementById("bonusBtn");
  if (bonusBtn) bonusBtn.onclick = openBonusModal;
  const promoNewBtn = document.getElementById("promoNewBtn");
  if (promoNewBtn) promoNewBtn.onclick = openPromoModal;
}

/* Получатели выдачи: account ID через пробелы/запятые/строки, без дублей. */
function parseBonusRefs(text) {
  const out = [];
  String(text || "").split(/[\s,;]+/).forEach((t) => {
    const s = t.trim();
    if (s && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

function promoSizeText(p) {
  const v = Number(p.value) || 0;
  const size = p.kind === "percent" ? `−${v}%` : `−${fmtMoney(v)}`;
  const per = p.period === "month" ? "месяц" : p.period === "year" ? "год" : "любой тариф";
  return `${size} · ${per}`;
}

function promoUseText(p) {
  const used = fmtNum(p.used || 0);
  return p.maxUses == null ? `${used} / ∞` : `${used} / ${fmtNum(p.maxUses)}`;
}

function promoExpText(p) {
  if (!p.expiresAt) return "бессрочно";
  const t = Number(p.expiresAt);
  if (!Number.isFinite(t)) return "—";
  const past = t <= Date.now();
  return new Date(t).toLocaleDateString("ru-RU") + (past ? " (истёк)" : "");
}

function promoRowHTML(p) {
  /* Удалять можно только НЕиспользованные коды: у кода с историей кнопки нет,
     его честная судьба — «Выключить» (платежи ссылаются на код). */
  const canDelete = !Number(p.used || 0);
  return `<div class="a-payrow">
    <div class="a-payrow__main">
      <div class="a-payrow__t mono">${esc(p.code)}${p.active ? "" : ' · <span style="color:var(--muted)">выкл</span>'}</div>
      <div class="a-payrow__d">${esc(promoSizeText(p))} · ${esc(promoUseText(p))} · ${esc(promoExpText(p))}${p.note ? ` · ${esc(p.note)}` : ""}</div>
    </div>
    <div class="a-payrow__r" style="gap:8px;display:flex;align-items:center">
      <button class="btn btn--soft btn--sm" data-promo-toggle onclick="togglePromo('${esc(p.code)}', ${p.active ? "false" : "true"})">${p.active ? "Выключить" : "Включить"}</button>
      ${canDelete ? `<button class="a-icon-btn a-icon-btn--danger" data-promo-del onclick="deletePromo('${esc(p.code)}')" title="Удалить неиспользованный код">${aicon("trash")}</button>` : ""}
    </div>
  </div>`;
}

/* Удаление кода — чистка опечаток: сервер разрешает только used=0.
   Использованный код кнопки не показывает вовсе; текст окна честно
   объясняет, почему. */
function deletePromo(code) {
  openModal(`
    <div class="a-modal__title" style="color:var(--danger)">Удалить промокод «${esc(code)}»?</div>
    <div class="a-modal__desc">Код ещё не использовался — удаление безопасно. Коды с историей не удаляются: их можно выключить.</div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--danger-soft" id="mDo">Удалить</button>
    </div>`, (modal) => {
    modal.classList.add("a-modal--danger");
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelector("#mDo").onclick = async () => {
      try {
        await AdminApi.post("/api/admin/subscription/promos", { action: "delete", code });
        closeModal();
        toast("Промокод удалён");
      } catch (e) {
        if (e && e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        modal.querySelector("#mDo").disabled = true;
        toast(`Не получилось удалить: ${e.message || "ошибка"}`, "err");
        return;
      }
      await screenSubscription();
    };
  });
}

async function togglePromo(code, on) {
  try {
    await AdminApi.post("/api/admin/subscription/promos", { action: "set_active", code, active: !!on });
    toast(on ? "Промокод включён" : "Промокод выключен");
  } catch (e) {
    if (e && e.unauthorized) { A.session = null; renderLogin(); return; }
    toast(`Не получилось: ${e.message || "ошибка"}`, "err");
    return;
  }
  await screenSubscription();
}

/* Подтверждение выдачи: кнопка оживает только при точном вводе числа.
   Число видно прямо в окне — сверять не с чем, кроме внимательности,
   и это весь смысл: случайный клик «Выдать» ничего не выдаёт. */
function openBonusModal() {
  const period = (document.getElementById("bonusPeriod") || {}).value === "year" ? "year" : "month";
  const note = ((document.getElementById("bonusNote") || {}).value || "").trim();
  const refs = parseBonusRefs((document.getElementById("bonusRefs") || {}).value);
  const wlBox = document.getElementById("bonusWaitlist");
  const wlPending = (A.lastSub && A.lastSub.waitlist && Number(A.lastSub.waitlist.pending)) || 0;
  const includeWl = !!(wlBox && wlBox.checked && wlPending > 0);
  const total = refs.length + (includeWl ? wlPending : 0);
  if (total <= 0) { toast("Добавь получателей или отметь лист ожидания", "err"); return; }
  const perName = period === "year" ? "год" : "месяц";
  openModal(`
    <div class="a-modal__title">Выдать <span class="plus">Plus</span> на ${perName} — ${fmtNum(total)} ${plural(total, "человек", "человека", "человек")}?</div>
    <div class="a-modal__desc">Из списка: ${fmtNum(refs.length)}${includeWl ? `, из листа ожидания: ${fmtNum(wlPending)}` : ""}.${note ? ` Повод: ${esc(note)}.` : ""} У кого Plus уже есть — срок продлится. Запись попадёт в журнал действий.</div>
    <div class="a-modal__form">
      <div class="a-modal__warn"><b>Подтверждение:</b> введи число <span class="mono">${fmtNum(total)}</span></div>
      <input class="a-input mono" id="fBonus" placeholder="${fmtNum(total)}" autocomplete="off" inputmode="numeric">
      <div id="mErr"></div>
    </div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--primary" id="mDo" disabled>Выдать ${fmtNum(total)} ${plural(total, "подписку", "подписки", "подписок")}</button>
    </div>`, (modal) => {
    const input = modal.querySelector("#fBonus");
    const doBtn = modal.querySelector("#mDo");
    modal.querySelector("#mCancel").onclick = closeModal;
    input.oninput = () => { doBtn.disabled = input.value.trim() !== String(total); };
    input.focus();
    doBtn.onclick = async () => {
      if (input.value.trim() !== String(total)) return;
      doBtn.disabled = true;
      doBtn.textContent = "Выдаём…";
      try {
        const result = await AdminApi.post("/api/admin/subscription/bonus", {
          recipients: refs, includeWaitlist: includeWl, period, note,
        });
        closeModal();
        openBonusResultModal(result);
        await screenSubscription();
      } catch (e) {
        if (e && e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        doBtn.disabled = false;
        doBtn.textContent = `Выдать ${fmtNum(total)} ${plural(total, "подписку", "подписки", "подписок")}`;
        modal.querySelector("#mErr").innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      }
    };
  });
}

/* Итог выдачи: сколько дошло, кого пропустили и почему. */
function openBonusResultModal(result) {
  const granted = Number(result.grantedCount) || 0;
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  openModal(`
    <div class="a-modal__title">Выдано: ${fmtNum(granted)}</div>
    <div class="a-modal__desc">${granted ? "Plus уже у получателей." : "Никому не выдано — проверь список."}${skipped.length ? ` Пропущено: ${fmtNum(skipped.length)}.` : ""}</div>
    ${skipped.length ? `<div class="a-modal__form">${skipped.map((s) => `<div class="a-prov-kv"><span class="mono">${esc(s.ref || "")}</span><b>${esc(s.reason || "")}</b></div>`).join("")}</div>` : ""}
    <div class="a-modal__actions"><button class="btn btn--soft" id="mOk">Понятно</button></div>`, (modal) => {
    modal.querySelector("#mOk").onclick = closeModal;
  });
}

function randomPromoCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/* Новый промокод: размер (процент или рубли), тариф, лимит использований,
   срок и пометка-повод. Пустые лимит и срок — «без ограничений». */
function openPromoModal() {
  openModal(`
    <div class="a-modal__title">Новый промокод</div>
    <div class="a-modal__form">
      <div class="a-field"><label for="fPromoCode">Код</label>
        <div style="display:flex;gap:8px">
          <input class="a-input mono" id="fPromoCode" maxlength="16" placeholder="LETO20" autocomplete="off" spellcheck="false" style="text-transform:uppercase">
          <button class="btn btn--soft" id="fPromoDice" type="button" title="Сгенерировать код">🎲</button>
        </div>
        <span class="a-field__hint">4–16 символов A–Z/0–9</span>
      </div>
      <div class="a-form-grid">
        <div class="a-field"><label for="fPromoKind">Тип скидки</label>
          <select class="a-select" id="fPromoKind"><option value="percent">Процент</option><option value="fixed">Рубли</option></select>
        </div>
        <div class="a-field"><label for="fPromoValue">Размер</label>
          <input class="a-input mono" id="fPromoValue" inputmode="numeric" placeholder="20">
          <span class="a-field__hint" id="fPromoValueHint">% от тарифа</span>
        </div>
      </div>
      <div class="a-form-grid">
        <div class="a-field"><label for="fPromoPeriod">Тариф</label>
          <select class="a-select" id="fPromoPeriod"><option value="any">Любой</option><option value="month">Месяц</option><option value="year">Год</option></select>
        </div>
        <div class="a-field"><label for="fPromoMax">Использований (пусто — ∞)</label>
          <input class="a-input mono" id="fPromoMax" inputmode="numeric" placeholder="∞">
        </div>
      </div>
      <div class="a-form-grid">
        <div class="a-field"><label for="fPromoExp">Срок до (пусто — бессрочно)</label>
          <input class="a-input" id="fPromoExp" type="date">
        </div>
        <div class="a-field"><label for="fPromoNote">Пометка</label>
          <input class="a-input" id="fPromoNote" maxlength="200" placeholder="розыгрыш…" autocomplete="off">
        </div>
      </div>
      <div id="mErr"></div>
    </div>
    <div class="a-modal__actions">
      <button class="btn btn--soft" id="mCancel">Отмена</button>
      <button class="btn btn--primary" id="mDo">Создать</button>
    </div>`, (modal) => {
    const kind = modal.querySelector("#fPromoKind");
    const hint = modal.querySelector("#fPromoValueHint");
    const valueInput = modal.querySelector("#fPromoValue");
    const syncHint = () => {
      const fixed = kind.value === "fixed";
      /* «Рубли» — именно рубли: строку переводим в копейки при отправке
         (сервер хранит копейки), иначе 198 ₽ превращались в 1,98 ₽. */
      hint.textContent = fixed ? "рублей; можно с копейками (198 или 198,5)" : "% от тарифа (100 = бесплатно)";
      if (valueInput) {
        valueInput.placeholder = fixed ? "198" : "20";
        valueInput.setAttribute("inputmode", fixed ? "decimal" : "numeric");
      }
    };
    kind.onchange = syncHint;
    syncHint();
    modal.querySelector("#fPromoDice").onclick = () => { modal.querySelector("#fPromoCode").value = randomPromoCode(); };
    modal.querySelector("#mCancel").onclick = closeModal;
    modal.querySelector("#mDo").onclick = async () => {
      const errBox = modal.querySelector("#mErr");
      const val = (id) => (modal.querySelector(id) || {}).value;
      let expiresAt = null;
      const expRaw = (val("#fPromoExp") || "").trim();
      if (expRaw) {
        const m = expRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) { errBox.innerHTML = `<div class="a-modal__error">Дата — в формате ГГГГ-ММ-ДД</div>`; return; }
        expiresAt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 0).getTime();
        if (!Number.isFinite(expiresAt)) { errBox.innerHTML = `<div class="a-modal__error">Некорректная дата</div>`; return; }
      }
      const maxRaw = (val("#fPromoMax") || "").trim();
      /* Размер: процент — целое 1..100; рубли — переводим в копейки (сервер
         хранит копейки), принимаем и копейки после запятой/точки. */
      const kindVal = val("#fPromoKind") === "fixed" ? "fixed" : "percent";
      const rawValue = String(val("#fPromoValue") || "").replace(",", ".").trim();
      let promoValue;
      if (kindVal === "fixed") {
        const rub = Number(rawValue);
        if (!rawValue || !Number.isFinite(rub) || rub <= 0) {
          errBox.innerHTML = `<div class="a-modal__error">Размер — рубли, например 198 или 198,5</div>`; return;
        }
        promoValue = Math.round(rub * 100);
        if (promoValue < 100) {
          errBox.innerHTML = `<div class="a-modal__error">Минимум 1 ₽</div>`; return;
        }
      } else {
        const pct = Number(rawValue);
        if (!rawValue || !Number.isFinite(pct) || pct < 1 || pct > 100) {
          errBox.innerHTML = `<div class="a-modal__error">Процент — от 1 до 100</div>`; return;
        }
        promoValue = Math.round(pct);
      }
      const body = {
        action: "create",
        code: (val("#fPromoCode") || "").trim(),
        kind: kindVal,
        value: promoValue,
        period: val("#fPromoPeriod"),
        maxUses: maxRaw === "" ? null : maxRaw,
        expiresAt,
        note: (val("#fPromoNote") || "").trim(),
      };
      const doBtn = modal.querySelector("#mDo");
      doBtn.disabled = true;
      try {
        const res = await AdminApi.post("/api/admin/subscription/promos", body);
        closeModal();
        toast(`Промокод ${res.promo.code} создан`);
        await screenSubscription();
      } catch (e) {
        if (e && e.unauthorized) { closeModal(); A.session = null; renderLogin(); return; }
        doBtn.disabled = false;
        errBox.innerHTML = `<div class="a-modal__error">${esc(e.message)}</div>`;
      }
    };
  });
}

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
  // Пока ждём решения владельца в Telegram, экран ожидания не трогаем:
  // смена хэша в этот момент не должна сносить опрос.
  if (A.pendingLogin) return;
  if (!A.session) { renderLogin(); return; }
  const route = parseHash();
  if (route.name === "users") {
    if (route.param) await screenUser(safeDecode(route.param));
    else await screenUsers();
  } else if (route.name === "audit") {
    await screenAudit();
  } else if (route.name === "inbox") {
    await screenInbox();
  } else if (route.name === "providers-new") {
    // Для честной подсказки про занятые слоты нужен актуальный список.
    if (!Prov.data) await screenProviders(true);
    screenProviderNew();
  } else if (route.name === "providers") {
    if (route.param) {
      // Прямой заход/перезагрузка на странице провайдера: список ещё не
      // загружен, а screenProviderPage ищет в нём — без молчаливой догрузки
      // всегда получали «Провайдер не найден». Тот же приём, что у providers-new.
      if (!Prov.data) await screenProviders(true);
      if (!A.session) return;
      await screenProviderPage(safeDecode(route.param));
    }
    else await screenProviders();
  } else if (route.name === "blocked") {
    await screenBlocked();
  } else if (route.name === "subscription") {
    await screenSubscription();
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
