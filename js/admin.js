/* ============================================================
   EGE CORE — Admin panel
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
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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

const GOAL_LABELS = { g60: "60+ баллов", g80: "80+ баллов", g95: "95+ баллов" };
const LEVEL_LABELS = { zero: "С нуля", base: "Базовый", confident: "Уверенный" };

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
    if (!response.ok) throw new Error(payload.error || `API ${response.status}`);
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
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22c4.4 0 7-2.8 7-6.5 0-3-2-5.5-3.5-7C14 7 13 5.5 13 3c-3 2-5 5-5 8-1-.5-1.8-1.5-2-3-1.5 1.6-3 4-3 6.5C3 19.2 7.6 22 12 22z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
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
  { id: "dashboard", title: "Обзор", icon: "dashboard" },
  { id: "users", title: "Пользователи", icon: "users" },
  { id: "blocked", title: "Заблокированные", icon: "blocked" },
  { id: "audit", title: "Журнал действий", icon: "audit" },
];

function renderShell(activeSection, screenHTML) {
  const u = A.session?.user || {};
  const expires = A.session?.expiresAt ? fmtDate(A.session.expiresAt) : "";
  A.root.innerHTML = `
    <div class="admin-app">
      <aside class="admin-sidebar">
        <div class="admin-logo">
          <span class="logo-mark">EGE</span><span class="logo-text">CORE</span>
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
            <a class="btn btn--soft btn--sm" href="/dashboard" style="text-decoration:none">К приложению</a>
          </div>
        </div>
      </aside>
      <div class="admin-main">
        <header class="admin-topbar">
          <span class="admin-topbar__title">${esc(SECTIONS.find((s) => s.id === activeSection)?.title || "Пользователь")}</span>
          <span class="admin-topbar__spacer"></span>
          <span class="chip chip--accent hide-mobile">ADMIN</span>
        </header>
        <main class="admin-screen" id="adminScreen">${screenHTML}</main>
      </div>
      <nav class="admin-bottomnav">
        ${SECTIONS.map((s) => `<a href="#/${s.id}" class="${s.id === activeSection ? "active" : ""}">${aicon(s.icon)}<span>${s.title.split(" ")[0]}</span></a>`).join("")}
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
        <span class="admin-login__mark">EGE CORE</span>
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

function activityChart(activity) {
  /* Столбцы решённых заданий по дням (14 дней). Одна метрика — один цвет
     (accent), значения на крайних столбцах + tooltip; сетка hairline. */
  const W = 640, H = 190, PAD_L = 34, PAD_R = 8, PAD_T = 16, PAD_B = 26;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxV = Math.max(1, ...activity.map((d) => d.solved));
  const step = plotW / activity.length;
  const barW = Math.min(24, step - 8);
  const ticks = [0, Math.round(maxV / 2), maxV];
  let bars = "";
  activity.forEach((d, i) => {
    const h = Math.round((d.solved / maxV) * plotH);
    const x = PAD_L + i * step + (step - barW) / 2;
    const y = PAD_T + plotH - h;
    const label = d.solved > 0 && (i === activity.length - 1 || d.solved === maxV)
      ? `<text class="bar-label" x="${x + barW / 2}" y="${y - 5}" text-anchor="middle">${d.solved}</text>` : "";
    bars += `<g>
      <rect class="bar-hit" x="${PAD_L + i * step}" y="${PAD_T}" width="${step}" height="${plotH}"
        data-tip="${fmtShortDate(d.date)}: ${d.solved} решено, ${d.correct} верно, ${d.users} ${plural(d.users, "активный", "активных", "активных")}, +${d.xp} XP"></rect>
      <rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4"></rect>
      ${label}
    </g>`;
  });
  const grid = ticks.map((t) => {
    const y = PAD_T + plotH - Math.round((t / maxV) * plotH);
    return `<line class="grid-line" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"></line>
      <text class="axis-label" x="${PAD_L - 6}" y="${y + 3}" text-anchor="end">${t}</text>`;
  }).join("");
  const xLabels = activity
    .map((d, i) => (i % 2 === 1 ? `<text class="axis-label" x="${PAD_L + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${fmtShortDate(d.date)}</text>` : ""))
    .join("");
  return `<div class="a-chart-box">
    <svg class="a-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Решённые задания по дням за 14 дней">
      ${grid}${bars}${xLabels}
    </svg>
    <div class="a-chart-tooltip" id="chartTip"></div>
  </div>`;
}

function bindChartTooltip(container) {
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
}

async function screenDashboard() {
  renderShell("dashboard", `<div class="a-skeleton" style="height:90px"></div><div class="a-skeleton" style="height:280px;margin-top:16px"></div>`);
  let data;
  try {
    data = await AdminApi.get("/api/admin/overview");
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
      ${statTile("Онбординг прошли", fmtNum(u.onboarded), `${Math.round((u.onboarded / Math.max(1, u.total)) * 100)}% аккаунтов`)}
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
      <div class="a-card">
        <div class="a-card__head">
          <span class="a-card__title">Активность за 14 дней</span>
          <span class="a-card__sub">решённые задания по дням (МСК)</span>
        </div>
        ${activityChart(data.activity)}
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
  bindChartTooltip(screenEl);
  screenEl.querySelectorAll("[data-goto]").forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.goto; };
  });
}

/* ---------------- Пользователи ---------------- */

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
      <input class="a-input" id="userSearch" placeholder="Поиск: Account ID, имя, внутренний id…" value="${esc(A.lastQuery || "")}">
      <span class="spacer"></span>
      <span class="a-card__sub" id="userCount"></span>
    </div>
    <div id="usersTable"></div>`);
  const input = document.getElementById("userSearch");
  const drawList = () => {
    const q = input.value.trim().toLowerCase();
    A.lastQuery = input.value;
    const filtered = q
      ? users.filter((p) => [p.accountId, p.name, String(p.id), p.selfLevel, p.goal].filter(Boolean).join(" ").toLowerCase().includes(q))
      : users;
    document.getElementById("userCount").textContent = `${filtered.length} из ${users.length}`;
    const wrap = document.getElementById("usersTable");
    wrap.innerHTML = filtered.length ? `
      <div class="a-user-grid">
        ${filtered.map((p) => {
          const initial = (p.name || p.accountId || "?").trim().charAt(0).toUpperCase();
          const acc = Math.round((p.correct / p.solved) * 100);
          return `
          <div class="a-user-card clickable" data-id="${p.id}">
            <div class="a-user-card__top">
              <div class="a-avatar a-avatar--sm">${esc(initial)}</div>
              <div class="a-user-card__id">
                <div class="a-user-card__name">${p.name ? esc(p.name) : `<span style="color:var(--muted)">Без имени</span>`}${p.onboarded ? "" : ` <span class="a-chip">new</span>`}</div>
                <div class="a-user-card__acct mono">${esc(p.accountId || "—")}</div>
              </div>
              <div class="a-user-card__lvl"><b>${p.level}</b><span>уровень</span></div>
            </div>
            <div class="a-user-card__stats">
              <div class="a-user-card__stat"><b>${fmtNum(p.xp)}</b><span>XP</span></div>
              <div class="a-user-card__stat"><b>${fmtNum(p.solved)}</b><span>решено</span></div>
              <div class="a-user-card__stat"><b>${p.solved ? acc + "%" : "—"}</b><span>точность</span></div>
              <div class="a-user-card__stat"><b>${p.streak || "—"}</b><span>серия</span></div>
            </div>
            <div class="a-user-card__foot">
              <span>${fmtDate(p.createdAt)}</span>
              <span class="a-user-card__active">${p.lastActiveDate ? "активен " + fmtShortDate(p.lastActiveDate) : "не активен"}</span>
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
            <span>id: ${p.id}</span>
            <span>уровень ${st.level.level} · ${fmtNum(st.xp)} XP</span>
            ${p.onboarded ? `<span class="a-chip a-chip--success">онбординг пройден</span>` : `<span class="a-chip a-chip--warn">не завершил онбординг</span>`}
            ${p.adminSessions > 0 ? `<span class="a-chip a-chip--accent">admin-сессия активна</span>` : ""}
          </div>
        </div>
        <div class="a-user-head__actions">
          <button class="btn btn--soft btn--sm" id="editProfileBtn">Профиль</button>
          <button class="btn btn--soft btn--sm" id="grantXpBtn">± XP</button>
          <button class="btn btn--danger-soft btn--sm" id="resetBtn">Сброс…</button>
          <button class="btn btn--danger-soft btn--sm" id="deleteBtn" ${p.id === A.session.user.id ? "disabled title=\"Нельзя удалить собственный аккаунт\"" : ""}>Удалить</button>
        </div>
      </div>
      <div class="a-kv" style="margin-top:20px">
        <div class="a-kv__item"><div class="a-kv__k">Регистрация</div><div class="a-kv__v">${fmtDateTime(p.createdAt)}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Последняя активность</div><div class="a-kv__v">${p.stats.lastActiveDate ? fmtShortDate(p.stats.lastActiveDate) : "нет"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Серия</div><div class="a-kv__v">${st.streak} ${plural(st.streak, "день", "дня", "дней")}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Самооценка</div><div class="a-kv__v">${p.selfLevel ? esc(LEVEL_LABELS[p.selfLevel] || p.selfLevel) : "—"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">Цель</div><div class="a-kv__v">${p.goal ? esc(GOAL_LABELS[p.goal] || p.goal) : "—"}</div></div>
        <div class="a-kv__item"><div class="a-kv__k">До след. уровня</div><div class="a-kv__v">${fmtNum(st.level.need - st.level.intoLevel)} XP</div></div>
      </div>
    </div>

    <div class="a-section-title">Прогресс</div>
    <div class="a-stats">
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
    </div>

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
  openModal(`
    <div class="a-modal__title" style="color:var(--danger)">Удалить аккаунт ${esc(p.accountId || "")}?</div>
    <div class="a-modal__desc">Будут удалены сам аккаунт и ВСЕ его данные: ${fmtNum(solved)} решений, ${fmtNum(xp)} XP, уроки, ошибки, достижения, admin-сессии. Действие необратимо.</div>
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
          <select class="a-select" id="fGoal">
            <option value="" ${!p.goal ? "selected" : ""}>Не выбрана</option>
            <option value="g60" ${p.goal === "g60" ? "selected" : ""}>60+ баллов</option>
            <option value="g80" ${p.goal === "g80" ? "selected" : ""}>80+ баллов</option>
            <option value="g95" ${p.goal === "g95" ? "selected" : ""}>95+ баллов</option>
          </select>
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
            goal: modal.querySelector("#fGoal").value || null,
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
}

/* ---------------- Журнал действий ---------------- */

const AUDIT_LABELS = {
  "admin-login": ["Вход в админ-панель", "a-chip--accent"],
  "admin-logout": ["Выход из админ-панели", ""],
  "grant-xp": ["Корректировка XP", "a-chip--warn"],
  reset: ["Сброс состояния", "a-chip--warn"],
  "update-profile": ["Изменение профиля", ""],
  "delete-user": ["Удаление аккаунта", "a-chip--danger"],
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
    if (route.param) await screenUser(decodeURIComponent(route.param));
    else await screenUsers();
  } else if (route.name === "audit") {
    await screenAudit();
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
