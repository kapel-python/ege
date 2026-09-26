/* Durable client-side subject contract guard.
   Runs the real data/state/app modules in a browser-shaped VM. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));
const SUBJECT_IDS = ["profile_math", "basic_math", "russian"];
const REQUIRED_FEATURES = [
  "lessons", "practice", "forecast", "diagnostics",
  "missions", "bosses", "daily", "path",
];
const CATALOG_FILES = {
  profile_math: "server/catalog.json",
  basic_math: "server/catalog_basic.json",
  russian: "server/catalog_russian.json",
};

let failures = 0;
let checks = 0;
const check = (name, condition, detail = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.value = "";
    this._innerHTML = "";
    this.children = [];
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child) { this.children.unshift(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  getClientRects() { return []; }
}

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id === "screen" ? "main" : "div"));
  return elements.get(id);
};
const document = {
  readyState: "loading",
  title: "",
  hidden: false,
  activeElement: null,
  documentElement: new FakeElement("html"),
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => element(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};
const noop = () => {};
const sandbox = {
  console: { log: noop, info: noop, warn: noop, error: noop },
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: () => 0,
  clearInterval: noop,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  document,
  location: { hash: "#/dashboard", href: "http://localhost/", origin: "http://localhost" },
  history: { replaceState: noop },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  navigator: { userAgent: "subject-ui-test", locks: {} },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  scrollTo: noop,
  fetch: async (url) => {
    // Ленивые срезы каталога отдаём с диска — тест рендерит реальные экраны
    // открытого предмета. Любой другой запрос — по-прежнему запрещён.
    const u = String(url);
    const path = u.split("?")[0];
    const subjectMatch = /[?&]subject=([^&]+)/.exec(u);
    const subject = subjectMatch ? decodeURIComponent(subjectMatch[1]) : "russian";
    const source = CATALOG_FILES[subject] ? readJson(CATALOG_FILES[subject]) : null;
    const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
    if (source && path === "/api/catalog-tasks") {
      return jsonResponse({ tasks: source.tasks || [], visualAssets: source.visualAssets || [], visualAudit: source.visualAudit || {} });
    }
    if (source && path === "/api/catalog-lessons") {
      return jsonResponse({ lessons: source.lessons || [] });
    }
    throw new Error("subject-ui test must not perform network I/O: " + u);
  },
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  Event: class Event { constructor(type) { this.type = type; } },
  MutationObserver: class MutationObserver { observe() {} disconnect() {} },
  IntersectionObserver: class IntersectionObserver { observe() {} disconnect() {} },
  ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
  crypto: require("crypto").webcrypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.dispatchEvent = () => true;
sandbox.HTMLElement = FakeElement;
sandbox.Footer = null;

vm.createContext(sandbox);
vm.runInContext(
  [read("js/data.js"), read("js/state.js"), read("js/app.js")].join("\n"),
  sandbox,
  { filename: "subject-ui-bundle.js" }
);

const contracts = Object.fromEntries(
  SUBJECT_IDS.map((id) => [id, readJson(`server/subjects/${id}.json`)])
);
const publicInfo = (contract) => ({
  id: contract.id,
  title: contract.title,
  short: contract.short,
  description: contract.description || "",
  status: contract.status,
  locked: !!contract.locked,
  comingSoon: !!contract.comingSoon,
  availability: contract.availability || contract.status,
  forecast: contract.forecast,
  features: contract.features,
  metadata: contract.metadata || {},
});
const subjects = SUBJECT_IDS.map((id) => publicInfo(contracts[id]));
const serverLikePayload = (id) => ({
  ...readJson(CATALOG_FILES[id]),
  subject: id,
  subjects,
  subjectInfo: publicInfo(contracts[id]),
  forecast: contracts[id].forecast,
});

sandbox.russianPayload = serverLikePayload("russian");
vm.runInContext(`
  DataAPI.load(russianPayload);
  Store.subject = "russian";
  Store.subjects = DataAPI.subjects();
  Store.ready = true;
  Store.state = Store.defaultState();
  Store.state.onboarded = true;
  Session.cur = null;
  Lesson.cur = null;
  Store.save = () => Promise.resolve();
  // Вендор грузится через onload <script>, которого в FakeElement нет:
  // для предмета с контентом render() доходит до Vendor.ensureMath, поэтому
  // здесь он заглушается (этот тест про экраны, а не про загрузчик).
  Vendor.ensureMath = () => Promise.resolve();
  Vendor.loadScript = () => Promise.resolve();
`, sandbox);

const sectionRoutes = ["training", "errors", "trials", "stats"];
const taskRoutes = ["session", "practice", "boss", "daily", "review", "lesson"];
const routes = [...sectionRoutes, ...taskRoutes];
const parents = {
  session: "training",
  practice: "training",
  boss: "trials",
  daily: "trials",
  review: "trials",
  lesson: "path",
};

vm.runInContext(`
  globalThis.renderLockedRoutes = async () => {
    const output = {};
    for (const route of ${JSON.stringify(routes)}) {
      location.hash = "#/" + route;
      document.getElementById("screen").innerHTML = "";
      // Глубокие ссылки без сессии честно уходят на родительский раздел
      // (go() меняет hash синхронно; hashchange в этом VM не эмитируется),
      // поэтому догоняем редирект повторным render до стабильного адреса.
      let renderedHash = null;
      for (let i = 0; i < 4; i++) {
        await render();
        if (location.hash === renderedHash) break;
        renderedHash = location.hash;
      }
      output[route] = {
        html: document.getElementById("screen").innerHTML,
        hash: location.hash,
        parent: typeof taskParentRoute === "function" ? taskParentRoute(route) : null,
      };
    }
    return output;
  };
`, sandbox);
async function runBehavioralChecks() {
const rendered = await vm.runInContext("renderLockedRoutes()", sandbox);

const titleOf = (html) => {
  const match = /<div class="page-title">([\s\S]*?)<\/div>/.exec(html);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
};
const visibleText = (html) => html
  .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const routeEvidence = routes.map((route) => ({
  route,
  nonEmpty: rendered[route].html.trim().length > 0,
  title: titleOf(rendered[route].html),
}));
const invalidSections = routeEvidence.filter((item) => !item.nonEmpty || !item.title);
check(
  `SECTION PARITY non-empty/title (${routes.length} routes)`,
  invalidSections.length === 0,
  invalidSections.map((item) => `${item.route}: title=${JSON.stringify(item.title)}`).join("; ") || "all rendered",
);

const byText = new Map();
for (const route of sectionRoutes) {
  const text = visibleText(rendered[route].html);
  byText.set(text, [...(byText.get(text) || []), route]);
}
const collisions = [...byText.entries()].filter(([, routeList]) => routeList.length > 1);
check(
  `SECTION PARITY distinct text (${sectionRoutes.length} sections)`,
  collisions.length === 0 && byText.size === sectionRoutes.length,
  collisions.map(([, routeList]) => routeList.join("=")).join("; ") || `${byText.size} unique renderings`,
);

const exitEvidence = taskRoutes.map((route) => ({
  route,
  html: rendered[route].html,
  hash: rendered[route].hash,
  // Глубокая ссылка без сессии уходит в тренировку; урок без id — на путь.
  redirect: route === "lesson" ? "path" : "training",
  expected: parents[route],
  helper: rendered[route].parent,
  nonEmpty: rendered[route].html.trim().length > 0,
}));
const badExits = exitEvidence.filter((item) =>
  item.hash !== "#/" + item.redirect || item.helper !== item.expected || !item.nonEmpty
);
check(
  `TASK-ROUTE EXIT parent controls (${taskRoutes.length} routes)`,
  badExits.length === 0,
  exitEvidence.map((item) => `${item.route}->${item.hash}`).join(", "),
);

vm.runInContext(`
  Store.state = Store.defaultState();
  const xpBefore = Store.state.xp;
  const awarded = addXp(100, "subject-ui-isolation-test");
  globalThis.fakeLearningResult = {
    next: nextStepCandidates(),
    content: DataAPI.hasLearningContent(),
    forecast: DataAPI.forecastConfig(),
    awarded,
    xpBefore,
    xpAfter: Store.state.xp,
    daily: dailyTaskIds(),
    dailyState: Store.state.daily,
  };
`, sandbox);
const fake = sandbox.fakeLearningResult;
/* Предмет открыт: поверхности честно предлагают реальную практику и
   начисляют XP; выключенные фичи (daily, forecast) по-прежнему молчат. */
check("LEARNING SURFACES recommendations", Array.isArray(fake.next) && fake.next.length > 0);
check("LEARNING SURFACES content selector", fake.content === true);
check("LEARNING SURFACES forecast config", fake.forecast === null);
check(
  "LEARNING SURFACES XP guard",
  fake.awarded === 100 && fake.xpBefore === 0 && fake.xpAfter === 100,
  `returned=${fake.awarded}, xp=${fake.xpAfter}`,
);
check(
  "LEARNING SURFACES daily selection",
  Array.isArray(fake.daily)
  && fake.daily.length === 0
  && (fake.dailyState.date === null || typeof fake.dailyState.date === "string")
  && fake.dailyState.solved === 0
  && fake.dailyState.done === false
  && Array.isArray(fake.dailyState.taskIds)
  && fake.dailyState.taskIds.length === 0,
);

for (const id of SUBJECT_IDS) {
  sandbox.contractPayload = serverLikePayload(id);
  vm.runInContext(`
    DataAPI.load(contractPayload);
    globalThis.contractInfoResult = (() => {
      const contractItem = DataAPI.subjectInfo(${JSON.stringify(id)});
      return contractItem ? { features: contractItem.features, id: contractItem.id } : null;
    })();
  `, sandbox);
  const info = sandbox.contractInfoResult;
  const features = info && info.features;
  check(
    `CONTRACT COMPLETENESS ${id}`,
    !!info && info.id === id
    && !!features && typeof features === "object" && !Array.isArray(features)
    && Object.keys(features).sort().join(",") === [...REQUIRED_FEATURES].sort().join(","),
    features ? Object.keys(features).sort().join(",") : "missing",
  );
}

// Регрессия UX: закрытые ошибки должны быть видны сразу над открытыми и
// оставаться в кадре, когда закрытие произошло недавно, а старых записей
// уже больше лимита отображения.
const targetIds = ["n01_p4", "n01_p5", "n01_p6", "n01_p7"];
const targetSubs = [
  "Трапеция, средняя линия и диагональ",
  "Вписанный четырёхугольник, углы",
  "Параллелограмм, площадь трапеции",
  "Высота и медиана прямоугольного треугольника",
];
const oldIds = ["n01_p1", "n01_p2", "n01_p3", "n02_p1", "n02_p2", "n02_p3", "n03_p1", "n03_p2"];
sandbox.profileErrorsPayload = serverLikePayload("profile_math");
sandbox.profileErrorsFixture = {
  errors: [
    ...targetIds.map((taskId, i) => ({ id: 200 + i, clientId: `fresh-${i}`, taskId, skill: "n01_planimetry", sub: targetSubs[i], ts: 1000 + i, resolved: true, kind: "major" })),
    ...oldIds.map((taskId, i) => ({ id: 100 + i, clientId: `old-${i}`, taskId, skill: taskId.startsWith("n02") ? "n02_vectors" : taskId.startsWith("n03") ? "n03_stereometry" : "n01_planimetry", sub: `Старая закрытая ${i}`, ts: 5000 + i, resolved: true, kind: "major" })),
    { id: 50, clientId: "open-1", taskId: "n03_p3", skill: "n03_stereometry", sub: "Открытая ошибка", ts: 20, resolved: false, kind: "major" },
  ],
  attempts: [
    ...targetIds.map((taskId, i) => ({ taskId, correct: true, hintLevel: 0, ts: 9000 + i })),
    ...oldIds.map((taskId, i) => ({ taskId, correct: true, hintLevel: 0, ts: 6000 + i })),
  ],
};
vm.runInContext(`
  DataAPI.load(profileErrorsPayload);
  Store.subject = "profile_math";
  Store.state = Store.defaultState();
  Store.state.onboarded = true;
  Store.state.errorsResolved = 12;
  Store.state.errors = profileErrorsFixture.errors;
  Store.state.taskAttempts = profileErrorsFixture.attempts;
  const root = document.getElementById("screen");
  screenErrors(root);
  globalThis.errorsScreenResult = {
    html: root.innerHTML,
    previewCount: resolvedErrorsForDisplay(Store.state.errors, Store.state.taskAttempts, RESOLVED_ERRORS_PREVIEW).length,
    recent: resolvedErrorsForDisplay(Store.state.errors, Store.state.taskAttempts, 4).map((error) => error.taskId),
  };
  resolvedErrorsExpanded = true;
  screenErrors(root);
  globalThis.errorsScreenResult.expandedHtml = root.innerHTML;
  globalThis.errorsScreenResult.expandedCount = resolvedErrorsForDisplay(Store.state.errors, Store.state.taskAttempts, 100).length;
`, sandbox);
const errorsScreen = sandbox.errorsScreenResult;
const errorsHtml = errorsScreen.html;
const closedPosition = errorsHtml.indexOf("Закрытые");
const openPosition = errorsHtml.indexOf("Требуют повторения");
check(
  "ERRORS closed block is visible before open errors",
  closedPosition >= 0 && openPosition > closedPosition && errorsHtml.includes("Закрытые · 12"),
  `closed=${closedPosition}, open=${openPosition}`,
);
check(
  "ERRORS newly closed rows are not hidden by the ten-row preview",
  errorsScreen.previewCount === 10
  && errorsHtml.includes("Показать все (12)")
  && !errorsHtml.includes("Свернуть")
  && errorsScreen.recent.join(",") === targetIds.slice().reverse().join(",")
  && targetSubs.every((sub) => errorsHtml.includes(sub)),
  `preview=${errorsScreen.previewCount}, recent=${errorsScreen.recent.join(",")}`,
);
check(
  "ERRORS expanded view contains the complete closed history",
  errorsScreen.expandedCount === 12 && errorsScreen.expandedHtml.includes("Свернуть"),
  `expanded=${errorsScreen.expandedCount}`,
);

// Служебная синхронизация вкладок не должна превращаться в пользовательские
// уведомления. Параллельно проверяем, что обычные достижения по-прежнему видны.
vm.runInContext(`
  const notificationRoot = document.getElementById("toast-root");
  notificationRoot.innerHTML = "";
  Store.emit("stateconflict", { merged: true });
  Store.emit("externalupdate-pending");
  globalThis.systemToastResult = { count: notificationRoot.children.length };
  Store.emit("achievement", { name: "Проверка уведомлений" });
  globalThis.systemToastResult.userCount = notificationRoot.children.length;
  globalThis.systemToastResult.userHtml = notificationRoot.children[0] ? notificationRoot.children[0].innerHTML : "";
`, sandbox);
const systemToast = sandbox.systemToastResult;
check(
  "NOTIFICATIONS internal tab-sync events are hidden",
  systemToast.count === 0,
  `systemToasts=${systemToast.count}`,
);
check(
  "NOTIFICATIONS user-facing achievements still use toast",
  systemToast.userCount === 1 && systemToast.userHtml.includes("Достижение разблокировано")
    && systemToast.userHtml.includes("Проверка уведомлений"),
  `userToasts=${systemToast.userCount}`,
);

vm.runInContext(`
  globalThis.backgroundRefreshToastResult = (async () => {
    const notificationRoot = document.getElementById("toast-root");
    notificationRoot.innerHTML = "";
    const originalLoad = Store.load;
    Store.pendingExternalUpdate = true;
    Store.load = async () => { throw new Error("offline"); };
    await render();
    const count = notificationRoot.children.length;
    Store.load = originalLoad;
    Store.pendingExternalUpdate = false;
    return { count };
  })();
`, sandbox);
const backgroundRefreshToast = await sandbox.backgroundRefreshToastResult;
check(
  "NOTIFICATIONS failed background tab refresh is silent",
  backgroundRefreshToast.count === 0,
  `backgroundToasts=${backgroundRefreshToast.count}`,
);

vm.runInContext(`
  showBootError(new Error("API 500: /internal/stack trace"));
  globalThis.bootErrorResult = {
    html: document.getElementById("screen").innerHTML,
  };
  globalThis.authErrorResult = {
    expected: authFormError(Object.assign(new Error("Неверный email или пароль"), { status: 401 }), "fallback"),
    internal: authFormError(new Error("API 500: Request failed /internal"), "fallback"),
  };
`, sandbox);
check(
  "NOTIFICATIONS boot error hides raw API details",
  sandbox.bootErrorResult.html.includes("Не удалось загрузить сайт")
    && !sandbox.bootErrorResult.html.includes("API 500")
    && !sandbox.bootErrorResult.html.includes("internal"),
  sandbox.bootErrorResult.html,
);
check(
  "NOTIFICATIONS auth keeps expected errors and sanitizes transport errors",
  sandbox.authErrorResult.expected === "Неверный email или пароль"
    && sandbox.authErrorResult.internal === "fallback",
  JSON.stringify(sandbox.authErrorResult),
);

vm.runInContext(`
  globalThis.deviceErrorToastResult = (async () => {
    const notificationRoot = document.getElementById("toast-root");
    notificationRoot.innerHTML = "";
    const originalRevoke = AuthAPI.revokeDevice;
    AuthAPI.revokeDevice = async () => { throw new Error("API 500 /api/auth/devices/42"); };
    await revokeDeviceSession(999);
    const html = notificationRoot.children[0] ? notificationRoot.children[0].innerHTML : "";
    AuthAPI.revokeDevice = originalRevoke;
    return { html };
  })();
`, sandbox);
const deviceErrorToast = await sandbox.deviceErrorToastResult;
check(
  "NOTIFICATIONS device logout error hides raw API details",
  deviceErrorToast.html.includes("Не удалось завершить выход")
    && !deviceErrorToast.html.includes("API 500")
    && !deviceErrorToast.html.includes("/api/auth/devices"),
  deviceErrorToast.html,
);

const appSource = read("js/app.js");
const forbiddenNotificationCopy = [
  "Математические библиотеки не загрузились",
  "toast(\"Переключаем предмет…\"",
  "toast(\"Открываем предмет…\"",
  "toast(\"Предмет выбран\"",
  "Тема не найдена",
  "Миссия не найдена",
  "Испытание не найдено",
  "Устройство отключено",
  "Сервер недоступен",
  "соединение с сервером",
  "сохранён на сервере",
  "toast((error && error.message)",
  "${esc(error.message || error)}",
];
check(
  "NOTIFICATIONS technical/stale copy is absent from app",
  forbiddenNotificationCopy.every((copy) => !appSource.includes(copy)),
  forbiddenNotificationCopy.filter((copy) => appSource.includes(copy)).join(" | "),
);

console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`);
}

runBehavioralChecks().then(
  () => process.exit(failures ? 1 : 0),
  (error) => {
    check("subject-ui harness", false, error && (error.stack || String(error)));
    console.log(`${failures ? `${failures} FAILURES` : "ALL OK"}: ${checks} checks`);
    process.exit(1);
  }
);
